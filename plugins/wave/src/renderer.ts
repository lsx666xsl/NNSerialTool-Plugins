// Canvas 2D 渲染器（自包含移植）：分栏/叠加布局、每像素列 min/max 抽稀、
// 网格坐标、游标测量。纯函数式：输入引擎快照 + 视图状态，输出一帧画面。
import type { ThemeColors } from './types';
import type { WaveEngine } from './engine';

export interface YRange {
  min: number;
  max: number;
}

export interface ViewState {
  follow: boolean; // 跟随最新（rightT 恒等于最新样本时间）
  rightT: number; // 右边界时间（非跟随/冻结时生效）
  windowMs: number; // 时间窗宽度（ms）
  frozen: boolean; // 冻结：画面停住，后台继续采集
  overlay: boolean; // true=叠加（共用一个坐标系），false=分栏（每通道独立）
  yRanges: Map<number, YRange | null>; // 每通道 Y 范围，null=自动
  cursorA: number | null;
  cursorB: number | null;
}

export const defaultViewState = (): ViewState => ({
  follow: true,
  rightT: 0,
  windowMs: 10_000,
  frozen: false,
  overlay: false,
  yRanges: new Map(),
  cursorA: null,
  cursorB: null,
});

export const MIN_WINDOW = 100;
export const MAX_WINDOW = 30 * 60_000;
export const AXIS_WIDTH = 64;
export const TIME_AXIS_H = 22;

// 最近一次绘制的各通道实际量程（交互种子：纵向缩放从此范围出发）
export const lastYRanges = new Map<number, YRange>();

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

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

// 主绘制入口。返回本次绘制的时间窗（供交互换算）
export const drawWave = (
  canvas: HTMLCanvasElement,
  engine: WaveEngine,
  view: ViewState,
  colors: ThemeColors
): { t0: number; t1: number; plotLeft: number; plotWidth: number } => {
  const zoom = Number(document.documentElement.style.zoom) || 1;
  const dpr = (window.devicePixelRatio || 1) * zoom;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  const g = canvas.getContext('2d');
  if (!g || cssW < 40 || cssH < 40) return { t0: 0, t1: 0, plotLeft: 0, plotWidth: 0 };

  const W = Math.round(cssW * dpr);
  const H = Math.round(cssH * dpr);
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = colors.bg;
  g.fillRect(0, 0, cssW, cssH);

  const t1 = view.frozen ? view.rightT : view.follow ? engine.lastT : view.rightT;
  const t0 = t1 - view.windowMs;
  const plotLeft = 8;
  const plotTop = 8;
  const plotRight = cssW - AXIS_WIDTH;
  const plotBottom = cssH - TIME_AXIS_H;
  const plotW = plotRight - plotLeft;
  const geom = { t0, t1, plotLeft, plotWidth: plotW };

  const visIdx: number[] = [];
  engine.channels.forEach((_, i) => {
    if (engine.visible[i]) visIdx.push(i);
  });

  const i0 = engine.lowerBound(t0);
  const i1 = engine.t.count;
  if (i1 - i0 < 2 || visIdx.length === 0) {
    drawEmpty(g, plotLeft, plotTop, plotW, plotBottom - plotTop, colors);
    drawTimeAxis(g, t0, t1, plotLeft, plotW, plotBottom, colors);
    return geom;
  }

  // 分栏：每可见通道一栏；叠加：单栏全通道
  const panes = view.overlay
    ? [{ channels: visIdx, top: plotTop, height: plotBottom - plotTop }]
    : visIdx.map((ch, i) => ({
        channels: [ch],
        top: plotTop + ((plotBottom - plotTop) / visIdx.length) * i,
        height: (plotBottom - plotTop) / visIdx.length,
      }));

  const px = (t: number) => plotLeft + ((t - t0) / view.windowMs) * plotW;

  for (const pane of panes) {
    // 第一遍：该栏各通道自动量程（手动量程跳过聚合）
    const auto: Map<number, Column> = new Map();
    for (const ch of pane.channels) {
      if (view.yRanges.get(ch)) continue;
      auto.set(ch, { min: Infinity, max: -Infinity });
    }
    for (let i = i0; i < i1; i++) {
      const t = engine.t.at(i);
      if (t < t0 || t > t1) continue;
      for (const ch of pane.channels) {
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
      for (const ch of pane.channels) {
        const r = yRangeOf(ch);
        lo = Math.min(lo, r.min);
        hi = Math.max(hi, r.max);
      }
      const pad = (hi - lo) * 0.1;
      paneRange = { min: lo - pad, max: hi + pad };
    }

    // 第二遍：每像素列 min/max 抽稀后画折线（峰谷不丢）
    const cols = Math.max(1, Math.floor(plotW));
    for (const ch of pane.channels) {
      const range = view.overlay && paneRange ? paneRange : yRangeOf(ch);
      const yOf = (v: number) => pane.top + pane.height - ((v - range.min) / (range.max - range.min)) * pane.height;
      const mins = new Float32Array(cols).fill(Infinity);
      const maxs = new Float32Array(cols).fill(-Infinity);
      for (let i = i0; i < i1; i++) {
        const t = engine.t.at(i);
        if (t < t0 || t > t1) continue;
        const x = ((t - t0) / view.windowMs) * cols;
        const col = clamp(Math.floor(x), 0, cols - 1);
        const v = engine.channels[ch].at(i);
        if (v < mins[col]) mins[col] = v;
        if (v > maxs[col]) maxs[col] = v;
      }
      g.beginPath();
      g.strokeStyle = colors.palette[ch % colors.palette.length];
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
    }

    // 栏背景与 Y 轴刻度
    g.strokeStyle = colors.border;
    g.lineWidth = 1;
    g.strokeRect(plotLeft + 0.5, pane.top + 0.5, plotW - 1, pane.height - 1);
    {
      const range = view.overlay && paneRange ? paneRange : yRangeOf(pane.channels[0]);
      const step = niceStep(range.max - range.min, 4);
      g.fillStyle = colors.textDim;
      g.font = '10px Consolas, monospace';
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      for (let v = Math.ceil(range.min / step) * step; v <= range.max; v += step) {
        const y = pane.top + pane.height - ((v - range.min) / (range.max - range.min)) * pane.height;
        if (y < pane.top + 8 || y > pane.top + pane.height - 4) continue;
        g.fillText(fmtValue(v), plotRight + 6, y);
        g.strokeStyle = colors.grid;
        g.beginPath();
        g.moveTo(plotLeft, Math.round(y) + 0.5);
        g.lineTo(plotRight, Math.round(y) + 0.5);
        g.stroke();
      }
    }
  }

  // 时间轴（相对窗口左端）
  drawTimeAxis(g, t0, t1, plotLeft, plotW, plotBottom, colors);

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

const drawTimeAxis = (
  g: CanvasRenderingContext2D,
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
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
    const x = plotLeft + ((t - t0) / (t1 - t0)) * plotW;
    if (x < plotLeft || x > plotLeft + plotW) continue;
    g.fillText(fmtDuration(t - t0), x, plotBottom + 6);
    g.beginPath();
    g.moveTo(Math.round(x) + 0.5, plotBottom);
    g.lineTo(Math.round(x) + 0.5, plotBottom + 4);
    g.stroke();
  }
};
