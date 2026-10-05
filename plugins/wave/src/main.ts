// 波形插件入口：协议注册 + DOM 挂载契约视图（与内置版同源的引擎/渲染器）。
// 普通 JS 插件形态：不依赖 Vue，主题经挂载点的 .theme-dark 祖先类继承。
import type { PluginContext, SessionSnapshot, ThemeName } from './types';
import { createNnWaveParser } from './nnwave';
import { WaveEngine } from './engine';
import {
  defaultViewState,
  drawWave,
  fmtDuration,
  fmtValue,
  lastYRanges,
  MAX_WINDOW,
  MIN_WINDOW,
  type ViewState,
  type YRange,
} from './renderer';
import { FIRMWARE_FILES } from './firmware';

const STYLE_ID = 'nnwave-plugin-style';

const CSS = `
.wavep { display:flex; flex-direction:column; gap:8px; height:100%; min-height:0;
  padding:12px; box-sizing:border-box;
  background:var(--wavep-card,#ffffff); border:1px solid rgba(23,26,33,.1); border-radius:10px; }
.theme-dark .wavep { --wavep-card:#2b2d30; border-color:rgba(255,255,255,.1); }
.wavep-bar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.wavep-label { font-size:12px; color:#8a9099; white-space:nowrap; }
.theme-dark .wavep-label { color:#7c828c; }
.wavep-select { max-width:220px; font-size:12px; padding:5px 8px; }
.wavep-btn { padding:5px 12px; font-size:12px; border-radius:6px; cursor:pointer;
  background:rgba(23,26,33,.05); color:#4b5563; box-shadow:inset 0 0 0 1px rgba(23,26,33,.1);
  border:none; white-space:nowrap; }
.wavep-btn:hover { background:rgba(59,111,212,.08); color:#3563c2; }
.wavep-btn.active { background:rgba(59,111,212,.14); color:#3563c2; box-shadow:inset 0 0 0 1px rgba(59,111,212,.35); }
.wavep-btn.follow { background:rgba(46,184,92,.12); color:#2e8b45; box-shadow:inset 0 0 0 1px rgba(46,184,92,.35); }
.theme-dark .wavep-btn { background:rgba(255,255,255,.06); color:#b3b7be; box-shadow:inset 0 0 0 1px rgba(255,255,255,.1); }
.theme-dark .wavep-btn:hover { background:rgba(108,167,232,.14); color:#8fbdf7; }
.theme-dark .wavep-btn.active { background:rgba(108,167,232,.2); color:#8fbdf7; }
.theme-dark .wavep-btn.follow { background:rgba(107,201,126,.16); color:#6bc97e; }
.wavep-export { margin-left:auto; }
.wavep-wrap { flex:1; min-height:200px; position:relative;
  border:1px solid rgba(23,26,33,.1); border-radius:6px; overflow:hidden; }
.theme-dark .wavep-wrap { border-color:rgba(255,255,255,.09); }
.wavep-canvas { position:absolute; inset:0; width:100%; height:100%; display:block; cursor:crosshair; }
.wavep-legend { display:flex; flex-wrap:wrap; gap:6px; min-height:26px; }
.wavep-chip { display:inline-flex; align-items:center; gap:6px; padding:3px 10px; border-radius:999px;
  background:rgba(23,26,33,.04); box-shadow:inset 0 0 0 1px rgba(23,26,33,.08); cursor:pointer; user-select:none; }
.wavep-chip:hover { background:rgba(59,111,212,.08); }
.wavep-chip.off { opacity:.45; }
.wavep-chip i { width:9px; height:9px; border-radius:50%; flex-shrink:0; }
.wavep-chip-name { font-size:12px; font-weight:600; color:#3b414b; }
.wavep-chip-val { font-size:12px; color:#6b7280; font-family:Consolas,monospace; font-variant-numeric:tabular-nums; }
.wavep-chip-delta { font-size:11px; color:#3563c2; font-family:Consolas,monospace; }
.theme-dark .wavep-chip { background:rgba(255,255,255,.05); box-shadow:inset 0 0 0 1px rgba(255,255,255,.09); }
.theme-dark .wavep-chip:hover { background:rgba(108,167,232,.14); }
.theme-dark .wavep-chip-name { color:#d6d9de; }
.theme-dark .wavep-chip-val { color:#9da0a8; }
.theme-dark .wavep-chip-delta { color:#8fbdf7; }
.wavep-status { display:flex; justify-content:space-between; gap:12px;
  font-size:11px; color:#8a9099; font-variant-numeric:tabular-nums; }
.theme-dark .wavep-status { color:#7c828c; }
.wavep-empty { font-size:12px; color:#9ca3af; }
`;

const ensureStyle = () => {
  if (document.getElementById(STYLE_ID)) return;
  const tag = document.createElement('style');
  tag.id = STYLE_ID;
  tag.textContent = CSS;
  document.head.appendChild(tag);
};

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export default function activate(ctx: PluginContext) {
  ctx.registerProtocol({
    id: 'nnwave',
    name: 'NN-Wave',
    description: 'AA 55 | 类型 | 通道数 | 序号 | float32×N | CRC8（固件模板随插件导出）',
    createParser: () => createNnWaveParser(),
  });

  ctx.registerView({
    id: 'wave',
    name: '波形',
    tip: '串口/网络数据的实时波形显示',
    blocks: 2,
    component: {
      mount(el: HTMLElement) {
        return mountWave(el, ctx);
      },
      unmount(el: HTMLElement) {
        el.innerHTML = '';
      },
    },
  });
}

// ---------- 视图实现（DOM 契约） ----------
const mountWave = (el: HTMLElement, ctx: PluginContext): (() => void) => {
  ensureStyle();

  el.innerHTML = `
    <div class="wavep">
      <div class="wavep-bar">
        <span class="wavep-label">数据源</span>
        <select class="wavep-select wavep-source"></select>
        <button type="button" class="wavep-btn wavep-overlay">分栏</button>
        <button type="button" class="wavep-btn wavep-freeze">冻结</button>
        <button type="button" class="wavep-btn wavep-follow" style="display:none">回到最新</button>
        <button type="button" class="wavep-btn wavep-cursorbtn">游标</button>
        <button type="button" class="wavep-btn wavep-clear">清空</button>
        <button type="button" class="wavep-btn wavep-export">导出固件文件</button>
      </div>
      <div class="wavep-wrap"><canvas class="wavep-canvas"></canvas></div>
      <div class="wavep-legend"></div>
      <div class="wavep-status"><span class="wavep-stats"></span><span class="wavep-window"></span></div>
    </div>`;

  const root = el.querySelector('.wavep') as HTMLElement;
  const canvas = el.querySelector('.wavep-canvas') as HTMLCanvasElement;
  const wrap = el.querySelector('.wavep-wrap') as HTMLElement;
  const sourceSel = el.querySelector('.wavep-source') as HTMLSelectElement;
  const btnOverlay = el.querySelector('.wavep-overlay') as HTMLButtonElement;
  const btnFreeze = el.querySelector('.wavep-freeze') as HTMLButtonElement;
  const btnFollow = el.querySelector('.wavep-follow') as HTMLButtonElement;
  const btnCursor = el.querySelector('.wavep-cursorbtn') as HTMLButtonElement;
  const btnClear = el.querySelector('.wavep-clear') as HTMLButtonElement;
  const btnExport = el.querySelector('.wavep-export') as HTMLButtonElement;
  const legendEl = el.querySelector('.wavep-legend') as HTMLElement;
  const statsEl = el.querySelector('.wavep-stats') as HTMLElement;
  const windowEl = el.querySelector('.wavep-window') as HTMLElement;

  // ---------- 状态（非响应式：交互改状态 + 标脏，rAF 统一重绘） ----------
  const view: ViewState = defaultViewState();
  let viewDirty = true;
  let cursorMode = false;
  const markDirty = () => {
    viewDirty = true;
  };

  const engine = new WaveEngine();
  engine.setProtocol({ id: 'nnwave', name: 'NN-Wave', createParser: () => createNnWaveParser() });

  const unsubs: Array<() => void> = [];
  unsubs.push(ctx.onRawData((e) => engine.handleRaw(e)));
  if (ctx.onSessionsChange) unsubs.push(ctx.onSessionsChange(() => renderSessions()));

  // ---------- 数据源下拉 ----------
  const renderSessions = () => {
    const list = ctx.listSessions();
    const cur = sourceSel.value;
    sourceSel.innerHTML =
      '<option value="">选择数据源会话</option>' +
      list
        .map(
          (s: SessionSnapshot) =>
            `<option value="${esc(s.id)}">${esc(s.name)}${s.status === 'connected' ? '' : '（未连接）'}</option>`
        )
        .join('');
    // 保留原选择；原会话已消失则回落到"未选择"
    if (cur && list.some((s) => s.id === cur)) sourceSel.value = cur;
    else sourceSel.value = engine.attachedSessionId && list.some((s) => s.id === engine.attachedSessionId) ? engine.attachedSessionId : '';
  };
  renderSessions();
  sourceSel.addEventListener('change', () => {
    engine.attach(sourceSel.value);
    markDirty();
  });

  // ---------- 工具按钮 ----------
  const updateButtons = () => {
    btnOverlay.textContent = view.overlay ? '叠加' : '分栏';
    btnFreeze.textContent = view.frozen ? '已冻结' : '冻结';
    btnFreeze.classList.toggle('active', view.frozen);
    btnFollow.style.display = !view.follow && !view.frozen ? '' : 'none';
    btnCursor.classList.toggle('active', cursorMode);
  };

  btnOverlay.addEventListener('click', () => {
    view.overlay = !view.overlay;
    view.yRanges.clear();
    updateButtons();
    markDirty();
  });

  btnFreeze.addEventListener('click', () => {
    if (!view.frozen) {
      view.rightT = currentT1();
      view.frozen = true;
      ctx.notify('已冻结显示（后台继续采集）');
    } else {
      view.frozen = false;
      view.follow = true;
    }
    updateButtons();
    markDirty();
  });

  btnFollow.addEventListener('click', () => {
    view.follow = true;
    view.frozen = false;
    updateButtons();
    markDirty();
  });

  btnCursor.addEventListener('click', () => {
    cursorMode = !cursorMode;
    updateButtons();
  });

  btnClear.addEventListener('click', () => {
    engine.clear();
    markDirty();
  });

  btnExport.addEventListener('click', () => {
    void (async () => {
      if (!ctx.exportTextFiles) {
        ctx.notify('当前应用版本过旧，不支持固件文件导出');
        return;
      }
      const dir = await ctx.exportTextFiles('选择固件协议文件导出目录', FIRMWARE_FILES);
      if (dir) ctx.notify(`固件协议文件已导出到 ${dir}`);
    })();
  });

  // ---------- 交互换算 ----------
  const pointerPos = (e: PointerEvent | WheelEvent | MouseEvent): { x: number; y: number } => {
    // 根节点 zoom 下 rect 为视觉像素、clientWidth 为布局像素，比值换算与引擎无关
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width / (canvas.clientWidth || 1);
    return { x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale };
  };

  let geom = { t0: 0, t1: 0, plotLeft: 0, plotWidth: 1 };
  const inPlot = (x: number) => x >= geom.plotLeft && x <= geom.plotLeft + geom.plotWidth;
  const timeAtX = (x: number) => geom.t0 + ((x - geom.plotLeft) / geom.plotWidth) * view.windowMs;
  const currentT1 = () => (view.frozen ? view.rightT : view.follow ? engine.lastT : view.rightT);

  const findPaneChannel = (y: number): number | null => {
    if (view.overlay) return null;
    const plotTop = 8;
    const plotBottom = canvas.clientHeight - 22;
    if (y < plotTop || y > plotBottom) return null;
    const vis = engine.channels.map((_, i) => i).filter((i) => engine.visible[i] !== false);
    if (vis.length === 0) return null;
    const paneH = (plotBottom - plotTop) / vis.length;
    const idx = Math.min(vis.length - 1, Math.max(0, Math.floor((y - plotTop) / paneH)));
    return vis[idx];
  };

  const scaleY = (ch: number | null, factor: number) => {
    const targets =
      ch === null ? engine.channels.map((_, i) => i).filter((i) => engine.visible[i] !== false) : [ch];
    for (const c of targets) {
      const base: YRange | undefined = view.yRanges.get(c) ?? lastYRanges.get(c);
      if (!base) continue;
      const center = (base.min + base.max) / 2;
      const half = ((base.max - base.min) / 2) * factor;
      if (half < 1e-9) continue;
      view.yRanges.set(c, { min: center - half, max: center + half });
    }
    markDirty();
  };

  canvas.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      e.preventDefault();
      const { x, y } = pointerPos(e);
      if (!inPlot(x)) return;
      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      if (e.shiftKey) {
        scaleY(findPaneChannel(y), factor);
        return;
      }
      const tAt = timeAtX(x);
      const newWindow = Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, view.windowMs * factor));
      const rightEdge = geom.plotLeft + geom.plotWidth;
      const newRightT = tAt + ((rightEdge - x) / geom.plotWidth) * newWindow;
      view.windowMs = newWindow;
      if (view.follow && x > rightEdge - 40) {
        // 贴右缘滚轮：保持跟随
      } else {
        view.follow = newRightT >= engine.lastT - 1;
        view.rightT = view.follow ? engine.lastT : newRightT;
      }
      updateButtons();
      markDirty();
    },
    { passive: false }
  );

  type DragState =
    | { kind: 'pan'; startX: number; startRightT: number }
    | { kind: 'yscale'; ch: number | null; startY: number; base: YRange };
  let drag: DragState | null = null;

  canvas.addEventListener('pointerdown', (e: PointerEvent) => {
    const { x, y } = pointerPos(e);
    canvas.setPointerCapture(e.pointerId);
    if (x <= geom.plotLeft + 4) {
      const ch = findPaneChannel(y);
      const base = (ch !== null ? view.yRanges.get(ch) : undefined) ?? (ch !== null ? lastYRanges.get(ch) : undefined);
      if (base) {
        drag = { kind: 'yscale', ch, startY: y, base };
      } else if (ch === null) {
        const vis = engine.channels.map((_, i) => i).filter((i) => engine.visible[i] !== false);
        const ranges = vis
          .map((c) => view.yRanges.get(c) ?? lastYRanges.get(c))
          .filter((r): r is YRange => !!r);
        if (ranges.length) {
          const min = Math.min(...ranges.map((r) => r.min));
          const max = Math.max(...ranges.map((r) => r.max));
          drag = { kind: 'yscale', ch: null, startY: y, base: { min, max } };
        }
      }
    } else {
      drag = { kind: 'pan', startX: x, startRightT: currentT1() };
    }
  });

  canvas.addEventListener('pointermove', (e: PointerEvent) => {
    if (!drag) return;
    const { x, y } = pointerPos(e);
    if (drag.kind === 'pan') {
      const dt = ((x - drag.startX) / geom.plotWidth) * view.windowMs;
      view.rightT = drag.startRightT - dt;
      view.follow = !view.frozen && view.rightT >= engine.lastT - 1;
      if (view.follow) view.rightT = engine.lastT;
    } else {
      const factor = Math.exp((y - drag.startY) * 0.005);
      const center = (drag.base.min + drag.base.max) / 2;
      const half = ((drag.base.max - drag.base.min) / 2) * factor;
      const targets =
        drag.ch === null
          ? engine.channels.map((_, i) => i).filter((i) => engine.visible[i] !== false)
          : [drag.ch];
      for (const c of targets) view.yRanges.set(c, { min: center - half, max: center + half });
    }
    updateButtons();
    markDirty();
  });

  const endDrag = (e: PointerEvent) => {
    drag = null;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  canvas.addEventListener('dblclick', () => {
    view.follow = true;
    view.frozen = false;
    view.windowMs = 10_000;
    view.yRanges.clear();
    view.cursorA = null;
    view.cursorB = null;
    updateButtons();
    markDirty();
  });

  canvas.addEventListener('click', (e: MouseEvent) => {
    if (!cursorMode) return;
    const { x } = pointerPos(e);
    if (!inPlot(x)) return;
    const t = timeAtX(x);
    const px = (c: number) => geom.plotLeft + ((c - geom.t0) / view.windowMs) * geom.plotWidth;
    if (view.cursorA === null) view.cursorA = t;
    else if (view.cursorB === null) view.cursorB = t;
    else {
      const dA = Math.abs(x - px(view.cursorA));
      const dB = Math.abs(x - px(view.cursorB));
      if (dA <= dB) view.cursorA = t;
      else view.cursorB = t;
    }
    markDirty();
  });

  // ---------- 图例与状态（200ms 节流 DOM 更新） ----------
  const renderLegend = () => {
    const colors = ctx.themeColors();
    const palette = colors.palette;
    const va = view.cursorA !== null ? engine.nearestIndex(view.cursorA) : -1;
    const vb = view.cursorB !== null ? engine.nearestIndex(view.cursorB) : -1;
    if (engine.channels.length === 0) {
      legendEl.innerHTML = '<span class="wavep-empty">选择数据源并收到数据后，通道将出现在这里</span>';
      return;
    }
    legendEl.innerHTML = engine.channels
      .map((ring, i) => {
        const value = ring.count > 0 ? ring.at(ring.count - 1) : NaN;
        const vaV = va >= 0 ? ring.at(va) : NaN;
        const vbV = vb >= 0 ? ring.at(vb) : NaN;
        const delta = view.cursorA !== null && view.cursorB !== null ? fmtValue(vbV - vaV) : null;
        const color = palette[i % palette.length];
        return `<span class="wavep-chip${engine.visible[i] !== false ? '' : ' off'}" data-index="${i}" title="点击${engine.visible[i] !== false ? '隐藏' : '显示'}">
          <i style="background:${color}"></i>
          <span class="wavep-chip-name">${esc(engine.names[i] ?? `CH${i + 1}`)}</span>
          <span class="wavep-chip-val">${fmtValue(value)}</span>
          ${delta ? `<span class="wavep-chip-delta">Δ ${delta}</span>` : ''}
        </span>`;
      })
      .join('');
  };

  legendEl.addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest('.wavep-chip') as HTMLElement | null;
    if (!chip) return;
    const index = Number(chip.dataset.index);
    engine.visible[index] = !(engine.visible[index] !== false);
    markDirty();
  });

  const renderStatus = () => {
    const s = engine.stats;
    statsEl.textContent = `帧率 ${fps}/s · 帧 ${s.frames} · 丢帧 ${s.drops} · 解析错误 ${s.errors} · 字节 ${s.bytes}`;
    windowEl.textContent = `时间窗 ${fmtDuration(view.windowMs)}`;
  };

  // ---------- 绘制循环 ----------
  let rafId = 0;
  let lastDrawnVersion = -1;
  let lastTheme: ThemeName | null = null;
  let lastCanvasW = 0;
  let fps = 0;
  let fpsMark = 0;
  let fpsFrames = 0;
  let uiMark = 0;
  let resizeObserver: ResizeObserver | null = null;

  unsubs.push(
    ctx.onThemeChange((t) => {
      lastTheme = null; // 强制下帧重绘（颜色变化）
      void t;
      markDirty();
    })
  );

  const draw = () => {
    const theme = ctx.theme();
    if (theme !== lastTheme) {
      lastTheme = theme;
      viewDirty = true;
    }
    if (canvas.clientWidth !== lastCanvasW) {
      lastCanvasW = canvas.clientWidth;
      viewDirty = true;
    }
    if (engine.version !== lastDrawnVersion || viewDirty) {
      lastDrawnVersion = engine.version;
      viewDirty = false;
      geom = drawWave(canvas, engine, view, ctx.themeColors());
    }
  };

  const loop = (now: number) => {
    draw();
    if (now - fpsMark >= 1000) {
      fps = engine.stats.frames - fpsFrames;
      fpsFrames = engine.stats.frames;
      fpsMark = now;
    }
    if (now - uiMark >= 200) {
      uiMark = now;
      renderLegend();
      renderStatus();
    }
    rafId = requestAnimationFrame(loop);
  };

  // ---------- 设置持久化 ----------
  const restore = () => {
    try {
      const saved = ctx.storage.get<{ overlay?: boolean; windowMs?: number } | null>('wave-view', null);
      if (!saved) return;
      if (typeof saved.overlay === 'boolean') view.overlay = saved.overlay;
      if (typeof saved.windowMs === 'number')
        view.windowMs = Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, saved.windowMs));
      updateButtons();
    } catch {
      /* 宿主未提供 storage 时静默 */
    }
  };
  restore();

  // ---------- 生命周期 ----------
  resizeObserver = new ResizeObserver(() => markDirty());
  resizeObserver.observe(wrap);
  rafId = requestAnimationFrame(loop);
  markDirty();

  return () => {
    cancelAnimationFrame(rafId);
    resizeObserver?.disconnect();
    unsubs.forEach((fn) => fn());
    try {
      ctx.storage.set('wave-view', { overlay: view.overlay, windowMs: view.windowMs });
    } catch {
      /* 同上 */
    }
  };
};
