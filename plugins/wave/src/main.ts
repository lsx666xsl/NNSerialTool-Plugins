// 波形插件入口：协议注册 + DOM 挂载契约视图（与内置版同源的引擎/渲染器）。
// 普通 JS 插件形态：不依赖 Vue，主题经挂载点的 .theme-dark 祖先类继承。
import type { PluginContext, SessionSnapshot, ThemeName } from './types';
import { createNnWaveParser } from './nnwave';
import { WaveEngine } from './engine';
import {
  clamp,
  defaultViewState,
  drawWave,
  fmtDuration,
  fmtValue,
  lastYRanges,
  MAX_WINDOW,
  MIN_WINDOW,
  type Rect,
  type ScrollGeom,
  type ViewState,
  type WaveGeom,
  type YRange,
} from './renderer';
import { FIRMWARE_FILES } from './firmware';
import { NNPRINTF_FILES } from './nnprintf-export';
import { buildWaveSvg } from './svg-export';
import { fixedPxUnit, hexToRgb, hsvToRgb, placePalette, rgbToHex, rgbToHsv } from './palette';

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
.wavep-legend { display:flex; flex-wrap:wrap; gap:6px; min-height:26px; align-content:flex-start;
  max-height:136px; overflow-y:auto; scrollbar-width:thin;
  scrollbar-color:rgba(128,132,140,.45) transparent; }
.wavep-legend::-webkit-scrollbar { width:8px; }
.wavep-legend::-webkit-scrollbar-thumb { background:rgba(128,132,140,.45); border-radius:4px; }
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
.wavep-dot { cursor:pointer; }
/* 通道调色弹层：Teleport 到 body（position:fixed），自带 theme-dark 类，不依赖挂载点祖先 */
.wavep-pop { position:fixed; z-index:9999; width:272px; box-sizing:border-box; padding:12px;
  display:flex; flex-direction:column; gap:10px;
  background:var(--wavep-pop-bg,#ffffff); color:var(--wavep-pop-fg,#3b414b);
  border:1px solid rgba(23,26,33,.14); border-radius:10px;
  box-shadow:0 8px 28px rgba(0,0,0,.18); font-size:12px; }
.wavep-pop.theme-dark { --wavep-pop-bg:#2b2d30; --wavep-pop-fg:#d6d9de; border-color:rgba(255,255,255,.14); }
.wavep-pop-head { display:flex; align-items:center; gap:8px; }
.wavep-pop-title { font-weight:600; flex:1; }
.wavep-pop-close { border:none; background:transparent; cursor:pointer; color:inherit; opacity:.55;
  font-size:14px; line-height:1; padding:2px 4px; border-radius:4px; }
.wavep-pop-close:hover { opacity:1; background:rgba(23,26,33,.06); }
.wavep-pop.theme-dark .wavep-pop-close:hover { background:rgba(255,255,255,.08); }
.wavep-pop-body { display:flex; gap:12px; }
.wavep-pop-left { display:flex; flex-direction:column; gap:8px; width:112px; }
.wavep-pop-right { display:flex; flex-direction:column; gap:10px; width:124px; }
.wavep-pop-label { font-size:11px; color:#8a9099; }
.wavep-pop.theme-dark .wavep-pop-label { color:#7c828c; }
.wavep-swatches { display:grid; grid-template-columns:repeat(4, 1fr); gap:6px; }
.wavep-swatch { width:100%; height:20px; border-radius:5px; cursor:pointer;
  box-shadow:inset 0 0 0 1px rgba(0,0,0,.18); transition:transform .08s; }
.wavep-swatch:hover { transform:scale(1.08); }
.wavep-pop.theme-dark .wavep-swatch { box-shadow:inset 0 0 0 1px rgba(255,255,255,.25); }
.wavep-hex { width:100%; box-sizing:border-box; font-family:Consolas,monospace; font-size:12px; padding:5px 8px;
  border:1px solid rgba(23,26,33,.14); border-radius:6px; background:transparent; color:inherit; outline:none; }
.wavep-hex:focus { border-color:rgba(59,111,212,.55); }
.wavep-sv { position:relative; width:124px; height:124px; border-radius:6px; cursor:crosshair;
  box-shadow:inset 0 0 0 1px rgba(0,0,0,.12); }
.wavep-sv-cursor { position:absolute; width:12px; height:12px; border:2px solid #fff; border-radius:50%;
  box-shadow:0 0 0 1px rgba(0,0,0,.55); transform:translate(-50%,-50%); pointer-events:none; }
.wavep-hue { position:relative; height:12px; border-radius:6px; cursor:pointer;
  background:linear-gradient(to right,#f00,#ff0 17%,#0f0 33%,#0ff 50%,#00f 67%,#f0f 83%,#f00); }
.wavep-hue-cursor { position:absolute; top:-2px; width:6px; height:16px; border:2px solid #fff; border-radius:3px;
  box-shadow:0 0 0 1px rgba(0,0,0,.5); transform:translateX(-50%); pointer-events:none; }
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
        <button type="button" class="wavep-btn wavep-overviewbtn">总览</button>
        <button type="button" class="wavep-btn wavep-style">曲线</button>
        <button type="button" class="wavep-btn wavep-freeze">冻结</button>
        <button type="button" class="wavep-btn wavep-follow" style="display:none">回到最新</button>
        <button type="button" class="wavep-btn wavep-cursorbtn">游标</button>
        <button type="button" class="wavep-btn wavep-clear">清空</button>
        <button type="button" class="wavep-btn wavep-export">导出SVG</button>
        <button type="button" class="wavep-btn wavep-export-protocol">导出协议文件</button>
        <button type="button" class="wavep-btn wavep-export-loglib">导出日志库</button>
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
  const btnOverview = el.querySelector('.wavep-overviewbtn') as HTMLButtonElement;
  const btnFreeze = el.querySelector('.wavep-freeze') as HTMLButtonElement;
  const btnFollow = el.querySelector('.wavep-follow') as HTMLButtonElement;
  const btnCursor = el.querySelector('.wavep-cursorbtn') as HTMLButtonElement;
  const btnClear = el.querySelector('.wavep-clear') as HTMLButtonElement;
  const btnSvgExport = el.querySelector('.wavep-export') as HTMLButtonElement;
  const btnExport = el.querySelector('.wavep-export-protocol') as HTMLButtonElement;
  const btnLogLibExport = el.querySelector('.wavep-export-loglib') as HTMLButtonElement;
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

  // 通道颜色覆盖（通道索引 → 十六进制色）：点击图例色块打开调色弹层、双击恢复默认
  const colorOverrides: Record<number, string> = {};
  const buildColors = () => {
    const base = ctx.themeColors();
    const entries = Object.entries(colorOverrides);
    if (entries.length === 0) return base;
    // 调色板扩到通道数，避免长索引取模时改到别的通道
    const n = Math.max(base.palette.length, engine.channels.length);
    const palette = Array.from({ length: n }, (_, i) => base.palette[i % base.palette.length]);
    for (const [k, v] of entries) {
      const idx = Number(k);
      if (Number.isInteger(idx) && idx >= 0 && idx < n) palette[idx] = v;
    }
    return { ...base, palette };
  };

  // ---------- 通道调色弹层（自绘矩形弹层：原生取色器不跟随根节点 zoom 且样式不可控） ----------
  const PRESET_COLORS = ['#E5484D', '#F76B15', '#FFC53D', '#46A758', '#12A594', '#3E63DD', '#8E4EC6', '#E93D82'];
  const POP_W = 272; // 与 .wavep-pop 的 width 保持一致（border-box），定位几何按它钳制
  let paletteOpenIndex = -1;
  let paletteCleanup: (() => void) | null = null;
  const closePalette = () => {
    paletteCleanup?.();
    paletteCleanup = null;
    paletteOpenIndex = -1;
  };

  const openPalette = (index: number, anchorEl: HTMLElement) => {
    if (paletteOpenIndex === index && paletteCleanup) {
      closePalette(); // 再点同一通道色块 = 收起
      return;
    }
    closePalette();
    paletteOpenIndex = index;

    const unit = fixedPxUnit();
    const pop = document.createElement('div');
    pop.className = 'wavep-pop' + (ctx.theme() === 'dark' ? ' theme-dark' : '');
    const chName = esc(engine.names[index] ?? `CH${index + 1}`);
    pop.innerHTML = `
      <div class="wavep-pop-head">
        <span class="wavep-pop-title">${chName} 颜色</span>
        <button type="button" class="wavep-pop-close" title="关闭">✕</button>
      </div>
      <div class="wavep-pop-body">
        <div class="wavep-pop-left">
          <span class="wavep-pop-label">常用色</span>
          <div class="wavep-swatches">${PRESET_COLORS.map((c) => `<span class="wavep-swatch" data-color="${c}" style="background:${c}" title="${c}"></span>`).join('')}</div>
          <span class="wavep-pop-label">自定义</span>
          <input type="text" class="wavep-hex" maxlength="7" spellcheck="false" />
        </div>
        <div class="wavep-pop-right">
          <div class="wavep-sv" title="饱和度 / 明度"><div class="wavep-sv-cursor"></div></div>
          <div class="wavep-hue" title="色相"><div class="wavep-hue-cursor"></div></div>
        </div>
      </div>`;
    document.body.appendChild(pop);

    const sv = pop.querySelector('.wavep-sv') as HTMLElement;
    const svCursor = pop.querySelector('.wavep-sv-cursor') as HTMLElement;
    const hue = pop.querySelector('.wavep-hue') as HTMLElement;
    const hueCursor = pop.querySelector('.wavep-hue-cursor') as HTMLElement;
    const hexInput = pop.querySelector('.wavep-hex') as HTMLInputElement;
    const btnClose = pop.querySelector('.wavep-pop-close') as HTMLButtonElement;

    const initial = buildColors().palette[index % buildColors().palette.length];
    const initRgb = hexToRgb(initial) ?? { r: 255, g: 255, b: 255 };
    let hsv = rgbToHsv(initRgb.r, initRgb.g, initRgb.b);

    // 颜色改动立即上屏（画布与图例实时跟随）；落盘统一在手势结束/关闭时做，
    // 避免 pointermove 高频写 storage
    const applyLive = (hex: string) => {
      colorOverrides[index] = hex;
      markDirty();
      updateLegend();
    };
    const syncUi = () => {
      const { h, s, v } = hsv;
      sv.style.background = `linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, hsl(${Math.round(h)}, 100%, 50%))`;
      svCursor.style.left = `${s * 100}%`;
      svCursor.style.top = `${(1 - v) * 100}%`;
      hueCursor.style.left = `${(h / 360) * 100}%`;
      hexInput.value = rgbToHex(hsvToRgb(h, s, v));
    };

    const dragTo = (e: PointerEvent, kind: 'sv' | 'hue') => {
      const target = kind === 'sv' ? sv : hue;
      const r = target.getBoundingClientRect(); // 视觉像素，与 clientX/Y 同基准
      const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / (r.width || 1)));
      const fy = Math.min(1, Math.max(0, (e.clientY - r.top) / (r.height || 1)));
      hsv = kind === 'sv' ? { ...hsv, s: fx, v: 1 - fy } : { ...hsv, h: fx * 360 };
      syncUi();
      applyLive(rgbToHex(hsvToRgb(hsv.h, hsv.s, hsv.v)));
    };
    const bindDrag = (target: HTMLElement, kind: 'sv' | 'hue') => {
      target.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        target.setPointerCapture(e.pointerId);
        dragTo(e, kind);
      });
      target.addEventListener('pointermove', (e) => {
        if (target.hasPointerCapture(e.pointerId)) dragTo(e, kind);
      });
      const end = (e: PointerEvent) => {
        if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId);
        persist(); // 手势结束落盘一次
      };
      target.addEventListener('pointerup', end);
      target.addEventListener('pointercancel', end);
    };
    bindDrag(sv, 'sv');
    bindDrag(hue, 'hue');

    pop.querySelectorAll('.wavep-swatch').forEach((sw) =>
      sw.addEventListener('click', () => {
        const c = (sw as HTMLElement).dataset.color ?? '';
        const rgb = hexToRgb(c);
        if (!rgb) return;
        hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
        syncUi();
        applyLive(c);
        persist();
      })
    );

    const commitHex = () => {
      const rgb = hexToRgb(hexInput.value);
      if (!rgb) {
        syncUi(); // 非法输入：回显当前色
        return;
      }
      hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
      syncUi();
      applyLive(rgbToHex(rgb));
      persist();
    };
    hexInput.addEventListener('change', commitHex);
    hexInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitHex();
        hexInput.blur();
      }
    });

    // 定位：锚定色块、视口钳制；窗口尺寸变化时重算（色块随图例重建会断连 → 收起）
    const place = () => {
      const rect = anchorEl.getBoundingClientRect();
      const { left, top } = placePalette(
        { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
        POP_W,
        pop.offsetHeight,
        window.innerWidth,
        window.innerHeight,
        8,
        8,
        unit
      );
      pop.style.left = `${left / unit}px`;
      pop.style.top = `${top / unit}px`;
    };
    place();
    const onResize = () => {
      if (!anchorEl.isConnected) {
        closePalette();
        return;
      }
      place();
    };
    window.addEventListener('resize', onResize);

    const onDocPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (pop.contains(t) || anchorEl.contains(t)) return;
      closePalette();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePalette();
    };
    document.addEventListener('pointerdown', onDocPointerDown, true);
    window.addEventListener('keydown', onKey);
    btnClose.addEventListener('click', closePalette);

    paletteCleanup = () => {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      window.removeEventListener('keydown', onKey);
      pop.remove();
    };
  };

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
    btnOverview.classList.toggle('active', view.overview);
    btnFreeze.textContent = view.frozen ? '已冻结' : '冻结';
    btnFreeze.classList.toggle('active', view.frozen);
    btnFollow.style.display = !view.follow && !view.frozen ? '' : 'none';
    btnCursor.classList.toggle('active', cursorMode);
  };

  const STYLE_LABEL: Record<string, string> = { line: '曲线', dots: '点', bars: '峰谷' };
  const STYLE_ORDER = ['line', 'dots', 'bars'] as const;

  btnOverlay.addEventListener('click', () => {
    view.overlay = !view.overlay;
    view.yRanges.clear();
    view.paneScroll = 0; // 叠加无纵向滚动，切回分栏时从头开始
    updateButtons();
    markDirty();
  });

  btnOverview.addEventListener('click', () => {
    view.overview = !view.overview;
    view.paneScroll = 0;
    persist();
    updateButtons();
    markDirty();
  });

  const btnStyle = el.querySelector('.wavep-style') as HTMLButtonElement;
  btnStyle.addEventListener('click', () => {
    const order = STYLE_ORDER;
    view.style = order[(order.indexOf(view.style) + 1) % order.length];
    btnStyle.textContent = view.style === 'line' ? '曲线' : view.style === 'dots' ? '点' : '峰谷';
    persist();
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

  const exportProtocol = () => {
    void (async () => {
      if (!ctx.exportTextFiles) {
        ctx.notify('当前应用版本过旧，不支持文件导出');
        return;
      }
      const dir = await ctx.exportTextFiles('选择协议文件导出目录', FIRMWARE_FILES, 'NN-Wave协议文件');
      if (dir) ctx.notify(`协议文件已导出到 ${dir} 的 NN-Wave协议文件 子目录`);
    })();
  };

  const exportSvg = () => {
    void (async () => {
      if (!ctx.exportTextFiles) {
        ctx.notify('当前应用版本过旧，不支持文件导出');
        return;
      }
      const svg = buildWaveSvg(engine, { overlay: view.overlay, yRanges: view.yRanges, style: view.style }, ctx.themeColors());
      if (!svg) {
        ctx.notify('暂无波形数据可导出');
        return;
      }
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      const dir = await ctx.exportTextFiles('选择SVG导出目录', [{ name: `wave-${stamp}.svg`, text: svg }], 'NN-Wave波形快照');
      if (dir) ctx.notify(`波形 SVG 已导出到 ${dir} 的 NN-Wave波形快照 子目录`);
    })();
  };

  // 导出 NNPrintf 日志库：分级日志头文件（[LEVEL]-- 前缀与上位机消息区着色配套）
  const exportLogLib = () => {
    void (async () => {
      if (!ctx.exportTextFiles) {
        ctx.notify('当前应用版本过旧，不支持文件导出');
        return;
      }
      const dir = await ctx.exportTextFiles('选择日志库导出目录', NNPRINTF_FILES, 'NNPrintf日志库');
      if (dir) ctx.notify(`NNPrintf.h 已导出到 ${dir} 的 NNPrintf日志库 子目录`);
    })();
  };

  btnSvgExport.addEventListener('click', exportSvg);
  btnExport.addEventListener('click', exportProtocol);
  btnLogLibExport.addEventListener('click', exportLogLib);

  // ---------- 交互换算 ----------
  const pointerPos = (e: PointerEvent | WheelEvent | MouseEvent): { x: number; y: number } => {
    // 根节点 zoom 下 rect 为视觉像素、clientWidth 为布局像素，比值换算与引擎无关
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width / (canvas.clientWidth || 1);
    return { x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale };
  };

  let geom: WaveGeom = {
    t0: 0,
    t1: 0,
    plotLeft: 0,
    plotWidth: 1,
    panes: [],
    viewport: { top: 0, height: 0 },
    overview: null,
    paneOverviews: null,
    scroll: null,
  };
  const inPlot = (x: number) => x >= geom.plotLeft && x <= geom.plotLeft + geom.plotWidth;
  const timeAtX = (x: number) => geom.t0 + ((x - geom.plotLeft) / geom.plotWidth) * view.windowMs;
  const currentT1 = () => (view.frozen ? view.rightT : view.follow ? engine.lastT : view.rightT);

  // ---------- 总览条 / 纵向滚动条命中与换算 ----------
  const hitScrollbar = (x: number, y: number): ScrollGeom | null =>
    geom.scroll && x >= geom.scroll.x - 3 && x <= geom.scroll.x + geom.scroll.w + 3 && y >= geom.scroll.y && y <= geom.scroll.y + geom.scroll.h
      ? geom.scroll
      : null;
  const hitOverview = (x: number, y: number): Rect | null => {
    const inRect = (r: Rect) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
    if (geom.overview && inRect(geom.overview)) return geom.overview;
    const paneBar = geom.paneOverviews?.find((r) => inRect(r));
    return paneBar ?? null;
  };
  // 总览条内 x → 全时间范围时间
  const overviewTAt = (bar: Rect, x: number): number => {
    const fullT0 = engine.t.count > 0 ? engine.t.at(0) : 0;
    const fullT1 = engine.lastT;
    const frac = clamp((x - bar.x) / (bar.w || 1), 0, 1);
    return fullT0 + frac * (fullT1 - fullT0);
  };
  // 视窗钳制：右缘不超出最新数据、左缘不早于数据起点（拖不出空白区）
  const clampWindow = (rightT: number, windowMs: number): { rightT: number; follow: boolean } => {
    const firstT = engine.t.count > 0 ? engine.t.at(0) : 0;
    const minRightT = firstT + windowMs;
    const clampedRight = Math.min(Math.max(rightT, Math.min(minRightT, engine.lastT)), engine.lastT);
    return { rightT: clampedRight, follow: !view.frozen && clampedRight >= engine.lastT - 1 };
  };

  const findPaneChannel = (y: number): number | null => {
    if (view.overlay) return null;
    for (const p of geom.panes) {
      if (y >= p.top && y <= p.top + p.height && p.top + p.height > geom.viewport.top && p.top < geom.viewport.top + geom.viewport.height)
        return p.ch;
    }
    return null;
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
      // 分栏纵向滚动条：滚轮直接滚动通道列表（不缩放时间窗）
      const sb = hitScrollbar(x, y);
      if (sb) {
        view.paneScroll = clamp(view.paneScroll + e.deltaY, 0, sb.scrollMax);
        markDirty();
        return;
      }
      const ov = hitOverview(x, y);
      if (!inPlot(x) && !ov) return;
      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      if (e.shiftKey) {
        scaleY(findPaneChannel(y), factor);
        return;
      }
      const newWindow = Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, view.windowMs * factor));
      view.windowMs = newWindow;
      // 缩放一律以光标为锚点（用户要求的标准示波器交互）：
      // 右缘钳制在数据范围内（拖不出空白未来）；光标区域放大后视图停在原地，
      // 拖回最右或点「回到最新」即恢复实时跟随
      const tAt = ov ? overviewTAt(ov, x) : timeAtX(x);
      const rightEdge = geom.plotLeft + geom.plotWidth;
      const newRightT = tAt + ((rightEdge - x) / geom.plotWidth) * newWindow;
      const firstT = engine.t.count > 0 ? engine.t.at(0) : 0;
      const minRightT = firstT + newWindow;
      view.rightT = newRightT >= engine.lastT - 1
        ? engine.lastT
        : Math.max(newRightT, Math.min(minRightT, engine.lastT));
      view.follow = !view.frozen && view.rightT >= engine.lastT - 1;
      updateButtons();
      markDirty();
    },
    { passive: false }
  );

  type DragState =
    | { kind: 'pan'; startX: number; startRightT: number }
    | { kind: 'yscale'; ch: number | null; startY: number; base: YRange }
    // 总览条：拖窗平移 / 拖左右缘缩放
    | { kind: 'ov-pan'; bar: Rect; startX: number; startRightT: number }
    | { kind: 'ov-left'; bar: Rect; anchorT: number }
    | { kind: 'ov-right'; bar: Rect; anchorT: number }
    // 纵向滚动条 thumb 拖动（ratio = scrollMax / thumb 可行程）
    | { kind: 'scroll'; startY: number; startScroll: number; ratio: number };
  let drag: DragState | null = null;

  canvas.addEventListener('pointerdown', (e: PointerEvent) => {
    const { x, y } = pointerPos(e);
    canvas.setPointerCapture(e.pointerId);

    // 1) 纵向滚动条：thumb 上按下=拖动；轨道空白=按页滚动
    const sb = hitScrollbar(x, y);
    if (sb) {
      const inThumb = y >= sb.thumbY && y <= sb.thumbY + sb.thumbH;
      if (inThumb) {
        const ratio = sb.h - sb.thumbH > 0 ? sb.scrollMax / (sb.h - sb.thumbH) : 0;
        drag = { kind: 'scroll', startY: y, startScroll: view.paneScroll, ratio };
      } else {
        const page = geom.viewport.height * (y < sb.thumbY ? -0.9 : 0.9);
        view.paneScroll = clamp(view.paneScroll + page, 0, sb.scrollMax);
        markDirty();
      }
      return;
    }

    // 2) 总览条：拖窗平移 / 边缘缩放 / 空白点击跳转
    const ov = hitOverview(x, y);
    if (ov) {
      const fullT0 = engine.t.count > 0 ? engine.t.at(0) : 0;
      const fullRange = engine.lastT - fullT0 || 1;
      const winL = ov.x + ((geom.t0 - fullT0) / fullRange) * ov.w;
      const winR = ov.x + ((geom.t1 - fullT0) / fullRange) * ov.w;
      const tAt = overviewTAt(ov, x);
      if (Math.abs(x - winL) <= 5 && winR - winL > 12) {
        view.frozen = false;
        view.follow = false;
        drag = { kind: 'ov-left', bar: ov, anchorT: currentT1() };
      } else if (Math.abs(x - winR) <= 5 && winR - winL > 12) {
        view.frozen = false;
        view.follow = false;
        drag = { kind: 'ov-right', bar: ov, anchorT: geom.t0 };
      } else if (x > winL && x < winR) {
        view.frozen = false;
        view.follow = false;
        drag = { kind: 'ov-pan', bar: ov, startX: x, startRightT: currentT1() };
      } else {
        // 空白点击：窗口中心跳到该时间点
        const { rightT, follow } = clampWindow(tAt + view.windowMs / 2, view.windowMs);
        view.rightT = rightT;
        view.follow = follow;
        view.frozen = false;
        updateButtons();
      }
      markDirty();
      return;
    }

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
      const firstT = engine.t.count > 0 ? engine.t.at(0) : 0;
      const minRightT = firstT + view.windowMs;
      // 右缘钳制在最新数据（拖不出空白未来）；左缘钳制在数据起点
      view.rightT = Math.min(Math.max(drag.startRightT - dt, Math.min(minRightT, engine.lastT)), engine.lastT);
      view.follow = !view.frozen && view.rightT >= engine.lastT - 1;
      if (view.follow) view.rightT = engine.lastT;
    } else if (drag.kind === 'scroll') {
      view.paneScroll = clamp(drag.startScroll + (y - drag.startY) * drag.ratio, 0, geom.scroll?.scrollMax ?? 0);
    } else if (drag.kind === 'ov-pan') {
      const firstT = engine.t.count > 0 ? engine.t.at(0) : 0;
      const dt = ((x - drag.startX) / (drag.bar.w || 1)) * (engine.lastT - firstT);
      const { rightT, follow } = clampWindow(drag.startRightT - dt, view.windowMs);
      view.rightT = rightT;
      view.follow = follow;
      if (view.follow) view.rightT = engine.lastT;
    } else if (drag.kind === 'ov-left') {
      // 拖左缘：右缘固定在 anchorT，窗口宽 = anchorT - 光标时间
      const tAt = overviewTAt(drag.bar, x);
      const w = clamp(drag.anchorT - tAt, MIN_WINDOW, MAX_WINDOW);
      view.windowMs = w;
      view.rightT = drag.anchorT;
      view.follow = false;
      view.frozen = false;
    } else if (drag.kind === 'ov-right') {
      // 拖右缘：左缘固定在 anchorT，窗口宽 = 光标时间 - anchorT
      const tAt = overviewTAt(drag.bar, x);
      const w = clamp(tAt - drag.anchorT, MIN_WINDOW, MAX_WINDOW);
      view.windowMs = w;
      view.rightT = clampWindow(tAt, w).rightT;
      view.follow = false;
      view.frozen = false;
    } else {
      // yscale：绘图区左缘拖动 = 纵向幅值缩放
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
    view.paneScroll = 0;
    view.cursorA = null;
    view.cursorB = null;
    updateButtons();
    markDirty();
  });

  canvas.addEventListener('click', (e: MouseEvent) => {
    if (!cursorMode) return;
    const { x, y } = pointerPos(e);
    if (!inPlot(x) || hitScrollbar(x, y) || hitOverview(x, y)) return;
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

  // ---------- 图例与状态 ----------
  // 结构（chip DOM）只在通道数变化时重建；数值/显隐/颜色按事件与 200ms 节拍定点更新。
  // 此前每 200ms 整体重建 innerHTML——点击经常落在重建瞬间被吞，显隐要点好几次才生效。
  let legendChipCount = -1;
  const rebuildLegendStructure = () => {
    closePalette(); // 图例 DOM 即将重建，旧色块锚点失效
    if (engine.channels.length === 0) {
      legendEl.innerHTML = '<span class="wavep-empty">选择数据源并收到数据后，通道将出现在这里</span>';
      legendChipCount = 0;
      return;
    }
    legendEl.innerHTML = engine.channels
      .map(
        (_, i) =>
          `<span class="wavep-chip" data-index="${i}" title="点击色块换色 / 双击恢复默认；点击其余区域隐藏或显示">` +
          `<i class="wavep-dot"></i><span class="wavep-chip-name"></span>` +
          `<span class="wavep-chip-val"></span><span class="wavep-chip-delta"></span></span>`
      )
      .join('');
    legendChipCount = engine.channels.length;
  };

  const updateLegend = () => {
    if (engine.channels.length !== legendChipCount) rebuildLegendStructure();
    if (legendChipCount === 0) return;
    const palette = buildColors().palette;
    const va = view.cursorA !== null ? engine.nearestIndex(view.cursorA) : -1;
    const vb = view.cursorB !== null ? engine.nearestIndex(view.cursorB) : -1;
    for (let i = 0; i < engine.channels.length; i++) {
      const chip = legendEl.querySelector(`.wavep-chip[data-index="${i}"]`) as HTMLElement | null;
      if (!chip) continue;
      const ring = engine.channels[i];
      const value = ring.count > 0 ? ring.at(ring.count - 1) : NaN;
      const vaV = va >= 0 ? ring.at(va) : NaN;
      const vbV = vb >= 0 ? ring.at(vb) : NaN;
      const delta = view.cursorA !== null && view.cursorB !== null ? fmtValue(vbV - vaV) : '';
      const visible = engine.visible[i] !== false;
      const color = palette[i % palette.length];
      chip.classList.toggle('off', !visible);
      (chip.querySelector('.wavep-dot') as HTMLElement).style.background = color;
      (chip.querySelector('.wavep-chip-name') as HTMLElement).textContent = engine.names[i] ?? `CH${i + 1}`;
      (chip.querySelector('.wavep-chip-val') as HTMLElement).textContent = fmtValue(value);
      (chip.querySelector('.wavep-chip-delta') as HTMLElement).textContent = delta ? 'Δ ' + delta : '';
    }
  };

  legendEl.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const chip = target.closest('.wavep-chip') as HTMLElement | null;
    if (!chip) return;
    const index = Number(chip.dataset.index);
    // 色块点击 = 打开调色弹层；其余区域 = 显隐切换
    if (target.closest('.wavep-dot')) {
      openPalette(index, target.closest('.wavep-dot') as HTMLElement);
      return;
    }
    engine.visible[index] = !(engine.visible[index] !== false);
    // 立即更新色块视觉状态——等 200ms 节拍会造成"点了好几次才生效"的错觉
    chip.classList.toggle('off', engine.visible[index] === false);
    markDirty();
  });
  legendEl.addEventListener('dblclick', (e) => {
    const target = e.target as HTMLElement;
    const chip = target.closest('.wavep-chip') as HTMLElement | null;
    if (!chip || !target.closest('.wavep-dot')) return;
    const index = Number(chip.dataset.index);
    if (colorOverrides[index]) {
      delete colorOverrides[index];
      persist();
      markDirty();
      updateLegend();
    }
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
      geom = drawWave(canvas, engine, view, buildColors());
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
      updateLegend();
      renderStatus();
    }
    rafId = requestAnimationFrame(loop);
  };

  // ---------- 设置持久化 ----------
  const restore = () => {
    try {
      const saved = ctx.storage.get<{ overlay?: boolean; windowMs?: number; style?: string; overview?: boolean; colors?: Record<string, string> } | null>(
        'wave-view',
        null
      );
      if (!saved) return;
      if (typeof saved.overlay === 'boolean') view.overlay = saved.overlay;
      if (typeof saved.overview === 'boolean') view.overview = saved.overview;
      if (typeof saved.windowMs === 'number')
        view.windowMs = Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, saved.windowMs));
      if (saved.style === 'line' || saved.style === 'dots' || saved.style === 'bars') view.style = saved.style;
      if (saved.colors && typeof saved.colors === 'object') {
        for (const [k, v] of Object.entries(saved.colors)) {
          const idx = Number(k);
          if (Number.isInteger(idx) && idx >= 0 && /^#[0-9a-fA-F]{6}$/.test(String(v))) colorOverrides[idx] = String(v);
        }
      }
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

  const persist = () => {
    try {
      ctx.storage.set('wave-view', { overlay: view.overlay, windowMs: view.windowMs, style: view.style, overview: view.overview, colors: { ...colorOverrides } });
    } catch {
      /* 宿主未提供 storage 时静默 */
    }
  };
  return () => {
    cancelAnimationFrame(rafId);
    closePalette(); // 视图卸载时收起弹层并解绑全局监听
    resizeObserver?.disconnect();
    unsubs.forEach((fn) => fn());
    persist();
  };
};
