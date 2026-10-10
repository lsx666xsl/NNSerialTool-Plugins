// Canvas 2D 渲染器（自包含移植）：分栏/叠加布局、每像素列 min/max 抽稀、
// 网格坐标、游标测量、时间轴总览条、分栏标题头与纵向滚动。
// 纯函数式：输入引擎快照 + 视图状态，输出一帧画面 + 交互几何（WaveGeom）。
import type { ThemeColors } from './types';
import type { WaveEngine } from './engine';

export interface YRange {
  min: number;
  max: number;
}

export type RenderStyle = 'line' | 'dots' | 'bars';

export interface ViewState {
  follow: boolean; // 跟随最新（rightT 恒等于最新样本时间）
  rightT: number; // 右边界时间（非跟随/冻结时生效）
  windowMs: number; // 时间窗宽度（ms）
  frozen: boolean; // 冻结：画面停住，后台继续采集
  overlay: boolean; // true=叠加（共用一个坐标系），false=分栏（每通道独立）
  style: RenderStyle; // 显示样式：曲线 / 点 / 峰谷
  yRanges: Map<number, YRange | null>; // 每通道 Y 范围，null=自动
  cursorA: number | null; // 游标时间（ms）
  cursorB: number | null;
  paneScroll: number; // 分栏纵向滚动偏移（px），溢出时 >0
}

export const defaultViewState = (): ViewState => ({
  follow: true,
  rightT: 0,
  windowMs: 10_000,
  frozen: false,
  overlay: false,
  style: 'line',
  yRanges: new Map(),
  cursorA: null,
  cursorB: null,
  paneScroll: 0,
});

export const MIN_WINDOW = 100;
export const MAX_WINDOW = 30 * 60_000;
export const AXIS_WIDTH = 64;
export const TIME_AXIS_H = 22;
export const MIN_PANE_H = 56; // 分栏最小栏高：栏数×此值超过视口即出纵向滚动条（画布外 DOM）

// 最近一次绘制的各通道实际量程（交互种子：纵向缩放从此范围出发）
export const lastYRanges = new Map<number, YRange>();

export interface PaneRect {
  ch: number; // 通道索引
  top: number; // 屏幕坐标（含滚动偏移，可能超出视口）
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ScrollGeom {
  trackH: number; // 滚动条轨道高（=绘图视口高，布局 px）
  thumbH: number;
  scrollMax: number;
}

export interface WaveGeom {
  t0: number;
  t1: number;
  plotLeft: number;
  plotWidth: number;
  panes: PaneRect[]; // 分栏实际栏位（叠加为空数组）
  viewport: { top: number; height: number };
  layout: ScrollGeom | null; // 分栏纵向滚动布局（供画布外 DOM 滚动条驱动）
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// nice 刻度步长：1/2/5 × 10^k
export const niceStep = (range: number, targetLines: number): number => {
  if (range <= 0 || !isFinite(range)) return 1;
  const raw = range / Math.max(1, targetLines);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) {
    if (raw <= m * mag) return m * mag;
  }
  return 10 * mag;
};

export const fmtValue = (v: number): string => {
  if (!isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e6 || (a > 0 && a < 1e-3)) return v.toExponential(2);
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(3);
  return v.toFixed(4);
};

export const fmtDuration = (ms: number): string => {
  const a = Math.abs(ms);
  if (a >= 60_000) return `${(ms / 60_000).toFixed(2)} min`;
  if (a >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${ms.toFixed(0)} ms`;
};

// 圆角矩形（WebKitGTK 旧版无 roundRect 时退化为直角矩形）
const rr = (g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
  g.beginPath();
  if (typeof g.roundRect === 'function') g.roundRect(x, y, w, h, r);
  else g.rect(x, y, w, h);
};

// 总览条抽稀的复用缓冲（避免 60fps 下每帧分配数百 KB 触发 GC 抖动）
let ovMins: Float32Array | null = null;
let ovMaxs: Float32Array | null = null;
let ovCap = 0;
const ensureOverviewBuf = (cols: number) => {
  if (ovCap < cols) {
    ovCap = Math.ceil(cols * 1.5);
    ovMins = new Float32Array(ovCap);
    ovMaxs = new Float32Array(ovCap);
  }
};

// 主绘制入口。返回本次绘制的时间窗与交互几何（总览条/滚动条/栏位，供事件换算）
export const drawWave = (
  canvas: HTMLCanvasElement,
  engine: WaveEngine,
  view: ViewState,
  colors: ThemeColors
): WaveGeom => {
  const emptyGeom: WaveGeom = {
    t0: 0,
    t1: 0,
    plotLeft: 0,
    plotWidth: 0,
    panes: [],
    viewport: { top: 0, height: 0 },
    layout: null,
  };
  const zoom = Number(document.documentElement.style.zoom) || 1;
  const dpr = (window.devicePixelRatio || 1) * zoom;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  const g = canvas.getContext('2d');
  if (!g || cssW < 40 || cssH < 40) return emptyGeom;

  const W = Math.round(cssW * dpr);
  const H = Math.round(cssH * dpr);
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = colors.bg;
  g.fillRect(0, 0, cssW, cssH);

  const plotLeft = 8;
  const plotTop = 8;
  const plotRight = cssW - AXIS_WIDTH;
  const plotBottom = cssH - TIME_AXIS_H; // 总览条在画布外（DOM），绘图区全高可用
  const plotW = plotRight - plotLeft;
  const viewportH = plotBottom - plotTop;

  const t1 = view.frozen ? view.rightT : view.follow ? engine.lastT : view.rightT;
  const t0 = t1 - view.windowMs;

  const visIdx: number[] = [];
  engine.channels.forEach((_, i) => {
    if (engine.visible[i]) visIdx.push(i);
  });

  const geom: WaveGeom = {
    t0,
    t1,
    plotLeft,
    plotWidth: plotW,
    panes: [],
    viewport: { top: plotTop, height: viewportH },
    layout: null,
  };

  const i0 = engine.lowerBound(t0);
  const i1 = engine.t.count;
  const fullT0 = engine.t.at(0); // 时间轴锚点（数据起点）——刻度网格固定在绝对数据时间上

  if (i1 - i0 < 2 || visIdx.length === 0) {
    drawEmpty(g, plotLeft, plotTop, plotW, viewportH, colors);
    drawTimeAxis(g, fullT0, t0, t1, plotLeft, plotW, plotBottom, colors);
    return geom;
  }

  // ---------- 分栏纵向滚动布局 ----------
  // 关闭的通道不占位（visIdx 即布局列表，重开按索引序插回）；栏数×最小栏高超出
  // 视口高度才出现滚动条，paneScroll 钳制在可滚范围。
  let paneH: number;
  let scrollOffset = 0;
  let scrollMax = 0;
  let contentHeight = 0;
  if (view.overlay) {
    paneH = viewportH;
  } else {
    paneH = Math.max(MIN_PANE_H, viewportH / visIdx.length);
    contentHeight = paneH * visIdx.length;
    scrollMax = Math.max(0, contentHeight - viewportH);
    scrollOffset = clamp(view.paneScroll, 0, scrollMax);
    view.paneScroll = scrollOffset;
  }

  // 分栏：每可见通道一栏；叠加：单栏全通道
  const panes: PaneRect[] = view.overlay
    ? [{ ch: visIdx[0], top: plotTop, height: paneH }]
    : visIdx.map((ch, i) => ({ ch, top: plotTop - scrollOffset + paneH * i, height: paneH }));
  geom.panes = view.overlay ? [] : panes;

  // 纵向滚动布局几何（画布外 DOM 滚动条按它驱动）
  if (scrollMax > 0) {
    const thumbH = Math.max(24, (viewportH / contentHeight) * viewportH);
    geom.layout = { trackH: viewportH, thumbH, scrollMax };
  }

  const px = (t: number) => plotLeft + ((t - t0) / view.windowMs) * plotW;

  // ---------- 逐栏绘制 ----------
  for (const pane of panes) {
    // 完全滚出视口的栏跳过（省 CPU）
    if (pane.top + pane.height <= plotTop || pane.top >= plotBottom) continue;

    // 第一遍：该栏各通道自动量程（手动量程跳过聚合）
    const auto: Map<number, Column> = new Map();
    const channels = view.overlay ? visIdx : [pane.ch];
    for (const ch of channels) {
      if (view.yRanges.get(ch)) continue;
      auto.set(ch, { min: Infinity, max: -Infinity });
    }
    for (let i = i0; i < i1; i++) {
      const t = engine.t.at(i);
      if (t < t0 || t > t1) continue;
      for (const ch of channels) {
        const col = auto.get(ch);
        if (!col) continue;
        const v = engine.channels[ch].at(i);
        if (v < col.min) col.min = v;
        if (v > col.max) col.max = v;
      }
    }
    const yRangeOf = (ch: number): YRange => {
      const manual = view.yRanges.get(ch);
      if (manual) {
        lastYRanges.set(ch, manual);
        return manual;
      }
      const col = auto.get(ch);
      let range: YRange;
      if (!col || !isFinite(col.min) || !isFinite(col.max)) range = { min: -1, max: 1 };
      else if (col.min === col.max) range = { min: col.min - 1, max: col.max + 1 };
      else {
        const pad = (col.max - col.min) * 0.1;
        range = { min: col.min - pad, max: col.max + pad };
      }
      lastYRanges.set(ch, range);
      return range;
    };

    // 叠加模式共用同一量程（各通道自动/手动范围的并集）——否则各通道各自归一化，无法对比相位
    let paneRange: YRange | null = null;
    if (view.overlay) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const ch of channels) {
        const r = yRangeOf(ch);
        lo = Math.min(lo, r.min);
        hi = Math.max(hi, r.max);
      }
      const pad = (hi - lo) * 0.1;
      paneRange = { min: lo - pad, max: hi + pad };
    }

    // 第二遍：按显示样式绘制——
    //   line: 逐点连成平滑曲线；dots: 每采样一个实心点；bars: 像素列 min/max 竖条（峰谷不丢）
    // 分栏滚动时数据必须裁剪在视口内（clip），否则画到相邻栏/时间轴上
    g.save();
    g.beginPath();
    g.rect(plotLeft, plotTop, plotW, viewportH);
    g.clip();

    const cols = Math.max(1, Math.floor(plotW));
    for (const ch of channels) {
      const range = view.overlay && paneRange ? paneRange : yRangeOf(ch);
      const yOf = (v: number) => pane.top + pane.height - ((v - range.min) / (range.max - range.min)) * pane.height;
      const color = colors.palette[ch % colors.palette.length];
      g.lineJoin = 'round';
      g.lineCap = 'round';

      if (view.style === 'bars') {
        // 像素列 min/max 抽稀竖条；超大缓冲时限入（每帧每通道 ≤60 万次采样访问，
        // 以步长抽采近似峰谷——该密度下极值差异在 1px 内，视觉无损）
        const visible = i1 - i0;
        const stride = visible > 600_000 ? Math.ceil(visible / 600_000) : 1;
        const mins = new Float32Array(cols).fill(Infinity);
        const maxs = new Float32Array(cols).fill(-Infinity);
        for (let i = i0; i < i1; i += stride) {
          const t = engine.t.at(i);
          if (t < t0 || t > t1) continue;
          const x = ((t - t0) / view.windowMs) * cols;
          const col = clamp(Math.floor(x), 0, cols - 1);
          const v = engine.channels[ch].at(i);
          if (v < mins[col]) mins[col] = v;
          if (v > maxs[col]) maxs[col] = v;
        }
        g.beginPath();
        g.strokeStyle = color;
        g.lineWidth = 1.25;
        let started = false;
        let lastX = -1;
        for (let col = 0; col < cols; col++) {
          if (mins[col] > maxs[col]) continue; // 空列
          const x = plotLeft + col + 0.5;
          const yMin = yOf(maxs[col]); // 屏幕 y 向下，max 在上
          const yMax = yOf(mins[col]);
          if (!started || col - lastX > 1) {
            g.moveTo(x, yMax);
            g.lineTo(x, yMin);
          } else {
            g.lineTo(x, yMax);
            g.lineTo(x, yMin);
          }
          started = true;
          lastX = col;
        }
        g.stroke();
      } else if (view.style === 'dots') {
        // 点显示：每采样一个 3px 实心方块（超量时按步长抽点，防止单帧卡顿）
        // X=时间轴（引擎已把时间戳错开为严格递增，平移/缩放语义正确）
        g.fillStyle = color;
        const total = i1 - i0;
        const stride = total > 8000 ? Math.ceil(total / 8000) : 1;
        for (let i = i0; i < i1; i += stride) {
          const t = engine.t.at(i);
          if (t < t0 || t > t1) continue;
          const x = plotLeft + ((t - t0) / view.windowMs) * plotW;
          const y = yOf(engine.channels[ch].at(i));
          g.fillRect(x - 1.5, y - 1.5, 3, 3);
        }
      } else {
        // 曲线：X=时间轴（与平移/缩放/时间窗语义一致），中点二次插值平滑，
        // 超 2 万可见点按步长抽点保流畅。引擎层已把批量时间戳错开为严格递增，
        // 到达抖动在秒级窗口内不可见。
        g.strokeStyle = color;
        g.lineWidth = 1.6;
        const total = i1 - i0;
        const stride = total > 20_000 ? Math.ceil(total / 20_000) : 1;
        const pts: Array<[number, number]> = [];
        for (let i = i0; i < i1; i += stride) {
          const t = engine.t.at(i);
          if (t < t0 || t > t1) continue;
          const x = plotLeft + ((t - t0) / view.windowMs) * plotW;
          pts.push([x, yOf(engine.channels[ch].at(i))]);
        }
        g.beginPath();
        if (pts.length === 1) {
          g.fillStyle = color;
          g.fillRect(pts[0][0] - 1.5, pts[0][1] - 1.5, 3, 3);
        } else if (pts.length > 0) {
          g.moveTo(pts[0][0], pts[0][1]);
          for (let k = 1; k < pts.length - 1; k++) {
            const mx = (pts[k][0] + pts[k + 1][0]) / 2;
            const my = (pts[k][1] + pts[k + 1][1]) / 2;
            g.quadraticCurveTo(pts[k][0], pts[k][1], mx, my);
          }
          g.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
        }
        g.stroke();
      }
    }

    // 分栏标题头：左上角显示通道名（随栏滚动，滚出视口即被裁剪）
    if (!view.overlay) {
      g.fillStyle = colors.text;
      g.font = '600 11px sans-serif';
      g.textAlign = 'left';
      g.textBaseline = 'top';
      g.fillText(engine.names[pane.ch] ?? `CH${pane.ch + 1}`, plotLeft + 8, pane.top + 5);
    }
    g.restore();

    // 栏背景与 Y 轴刻度（clip 外：刻度文字画在绘图区右侧）；边框钳制在视口内（滚动时栏可部分越界）
    {
      const bTop = Math.max(pane.top, plotTop);
      const bBottom = Math.min(pane.top + pane.height, plotBottom);
      g.strokeStyle = colors.border;
      g.lineWidth = 1;
      g.strokeRect(plotLeft + 0.5, bTop + 0.5, plotW - 1, bBottom - bTop - 1);
    }
    {
      const range = view.overlay && paneRange ? paneRange : yRangeOf(pane.ch);
      const step = niceStep(range.max - range.min, 4);
      g.fillStyle = colors.textDim;
      g.font = '10px Consolas, monospace';
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      for (let v = Math.ceil(range.min / step) * step; v <= range.max; v += step) {
        const y = pane.top + pane.height - ((v - range.min) / (range.max - range.min)) * pane.height;
        if (y < pane.top + 8 || y > pane.top + pane.height - 4) continue;
        if (y < plotTop || y > plotBottom) continue; // 滚出视口的刻度不画
        g.fillText(fmtValue(v), plotRight + 6, y);
        g.strokeStyle = colors.grid;
        g.beginPath();
        g.moveTo(plotLeft, Math.round(y) + 0.5);
        g.lineTo(plotRight, Math.round(y) + 0.5);
        g.stroke();
      }
    }
  }

  // 时间轴（锚定数据起点的固定网格）
  drawTimeAxis(g, fullT0, t0, t1, plotLeft, plotW, plotBottom, colors);

  // 游标
  for (const c of [view.cursorA, view.cursorB]) {
    if (c === null || c < t0 || c > t1) continue;
    const x = px(c);
    g.strokeStyle = colors.accent;
    g.setLineDash([4, 3]);
    g.beginPath();
    g.moveTo(x + 0.5, plotTop);
    g.lineTo(x + 0.5, plotBottom);
    g.stroke();
    g.setLineDash([]);
  }

  return geom;
};

// 总览条缩影绘制（画布外 mini canvas 的**离屏缓存**用）：整段数据 min/max 抽稀。
// 采样按列预算（每列 ~3 个采样点），与通道数解耦——此前每帧全量遍历，64 通道数据流时
// 每帧 120 万+ 次采样访问把帧预算吃光（拖动滚动条一卡一卡的元凶）。
// 由调用方节流（约 200ms 一次）重算；视窗矩形每帧单独画（drawOverviewWindow）。
export const drawOverviewStrip = (
  canvas: HTMLCanvasElement,
  cssW: number,
  cssH: number,
  engine: WaveEngine,
  colors: ThemeColors
): { fullT0: number; fullT1: number } | null => {
  const zoom = Number(document.documentElement.style.zoom) || 1;
  const dpr = (window.devicePixelRatio || 1) * zoom;
  const g = canvas.getContext('2d');
  if (!g || cssW < 10 || cssH < 8) return null;

  const W = Math.round(cssW * dpr);
  const H = Math.round(cssH * dpr);
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cssW, cssH);
  g.fillStyle = colors.panel;
  rr(g, 0.5, 0.5, cssW - 1, cssH - 1, 4);
  g.fill();
  g.strokeStyle = colors.border;
  g.lineWidth = 1;
  g.stroke();

  if (engine.t.count < 2 || engine.lastT <= engine.t.at(0)) return null;
  const fullT0 = engine.t.at(0);
  const fullT1 = engine.lastT;
  const visIdx: number[] = [];
  engine.channels.forEach((_, i) => {
    if (engine.visible[i]) visIdx.push(i);
  });
  const i0 = engine.lowerBound(fullT0);
  const i1 = engine.t.count;

  const cols = Math.max(1, Math.floor(cssW));
  ensureOverviewBuf(cols);
  const mins = ovMins as Float32Array;
  const maxs = ovMaxs as Float32Array;
  const visible = i1 - i0;
  // 按列预算采样：每列约 3 个采样点（缩影视觉无损），64 通道时每帧 ~10 万次访问
  const stride = Math.max(1, Math.ceil(visible / (cols * 3)));
  const innerY = 2;
  const innerH = cssH - 4;
  for (const ch of visIdx) {
    mins.fill(Infinity, 0, cols);
    maxs.fill(-Infinity, 0, cols);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = i0; i < i1; i += stride) {
      const t = engine.t.at(i);
      if (t < fullT0 || t > fullT1) continue;
      const col = clamp(Math.floor(((t - fullT0) / (fullT1 - fullT0)) * cols), 0, cols - 1);
      const v = engine.channels[ch].at(i);
      if (v < mins[col]) mins[col] = v;
      if (v > maxs[col]) maxs[col] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!isFinite(lo) || !isFinite(hi) || hi <= lo) continue;
    const yOf = (v: number) => innerY + innerH - ((v - lo) / (hi - lo)) * innerH;
    g.fillStyle = colors.palette[ch % colors.palette.length];
    g.globalAlpha = 0.6;
    for (let col = 0; col < cols; col++) {
      if (mins[col] > maxs[col]) continue;
      const yTop = yOf(maxs[col]);
      g.fillRect(col, yTop, 1, Math.max(1, yOf(mins[col]) - yTop));
    }
    g.globalAlpha = 1;
  }

  return { fullT0, fullT1 };
};

// 总览条视窗矩形（每帧画在展示 canvas 上，拖动跟手；缩影由离屏缓存 drawImage 提供）
export const drawOverviewWindow = (
  g: CanvasRenderingContext2D,
  cssW: number,
  cssH: number,
  fullT0: number,
  fullT1: number,
  engine: WaveEngine,
  view: ViewState,
  colors: ThemeColors
): void => {
  if (fullT1 <= fullT0) return;
  const rightT = view.frozen || !view.follow ? view.rightT : engine.lastT;
  const wx0 = ((rightT - view.windowMs - fullT0) / (fullT1 - fullT0)) * cssW;
  const wx1 = ((rightT - fullT0) / (fullT1 - fullT0)) * cssW;
  const clampedX0 = clamp(Math.min(wx0, wx1), 0, cssW);
  const clampedX1 = clamp(Math.max(wx0, wx1), 0, cssW);
  g.fillStyle = colors.accent;
  g.globalAlpha = 0.14;
  g.fillRect(clampedX0, 1, clampedX1 - clampedX0, cssH - 2);
  g.globalAlpha = 1;
  g.strokeStyle = colors.accent;
  g.strokeRect(clampedX0 + 0.5, 1.5, Math.max(1, clampedX1 - clampedX0 - 1), cssH - 3);
};

interface Column {
  min: number;
  max: number;
}

const drawEmpty = (g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, colors: ThemeColors) => {
  g.fillStyle = colors.textDim;
  g.font = '12px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('暂无数据 — 在上方选择已连接的会话开始采集', x + w / 2, y + h / 2);
};

// 时间轴：刻度网格锚定数据起点（anchorT），标签 = 距起点的经过时间。
// 平移/缩放时刻度线固定在"绝对数据时间"上——同一波形点始终对准同一条刻度线，
// 标签值不随窗口滚动重排（用户要求的固定时间轴）。
const drawTimeAxis = (
  g: CanvasRenderingContext2D,
  anchorT: number,
  t0: number,
  t1: number,
  plotLeft: number,
  plotW: number,
  plotBottom: number,
  colors: ThemeColors
) => {
  const step = niceStep(t1 - t0, 8);
  g.fillStyle = colors.textDim;
  g.font = '10px Consolas, monospace';
  g.textAlign = 'center';
  g.textBaseline = 'top';
  g.strokeStyle = colors.grid;
  // 对齐 anchorT 整步长的网格（而非窗口左缘）：t = anchorT + k×step
  const firstGrid = anchorT + Math.ceil((t0 - anchorT) / step) * step;
  for (let t = firstGrid; t <= t1; t += step) {
    const x = plotLeft + ((t - t0) / (t1 - t0)) * plotW;
    if (x < plotLeft || x > plotLeft + plotW) continue;
    g.fillText(fmtDuration(t - anchorT), x, plotBottom + 6);
    g.beginPath();
    g.moveTo(Math.round(x) + 0.5, plotBottom);
    g.lineTo(Math.round(x) + 0.5, plotBottom + 4);
    g.stroke();
  }
};
