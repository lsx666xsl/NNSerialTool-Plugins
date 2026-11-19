// 波形插件入口：协议注册 + DOM 挂载契约视图（与内置版同源的引擎/渲染器）。
// 普通 JS 插件形态：不依赖 Vue，主题经挂载点的 .theme-dark 祖先类继承。
import type { PluginContext, SessionSnapshot, ThemeName } from './types';
import { createNnWaveParser } from './nnwave';
import { WaveEngine } from './engine';
import {
  clamp,
  defaultViewState,
  drawOverviewStrip,
  drawOverviewWindow,
  drawWave,
  fmtDuration,
  fmtValue,
  lastYRanges,
  MAX_WINDOW,
  MIN_WINDOW,
  type ViewState,
  type WaveGeom,
  type YRange,
} from './renderer';
import { FIRMWARE_FILES } from './firmware';
import { NNPRINTF_FILES } from './nnprintf-export';
import { buildWaveSvg } from './svg-export';
import { fixedPxUnit, hexToRgb, hsvToRgb, placePalette, rgbToHex, rgbToHsv } from './palette';
import { buildCsv, channelStats, fftSpectrum, movingAverage, sliceChannel, type Spectrum } from './analysis';

const STYLE_ID = 'nnwave-plugin-style';

const CSS = `
.wavep { display:flex; flex-direction:column; gap:8px; height:100%; min-height:0;
  padding:12px; box-sizing:border-box;
  background:var(--wavep-card,#ffffff); border:1px solid rgba(23,26,33,.1); border-radius:10px; }
.theme-dark .wavep { --wavep-card:#2b2d30; border-color:rgba(255,255,255,.1); }
.wavep-bar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.wavep-label { font-size:12px; color:#8a9099; white-space:nowrap; }
.theme-dark .wavep-label { color:#7c828c; }
/* 数据源下拉是原生 <select>：必须显式配色，否则深色主题下会露出浏览器的白底白框；
   color-scheme 决定下拉展开列表（popup）的配色，只在 WebView2/Chromium 生效，其它内核忽略也无害。 */
.wavep-select { max-width:220px; font-size:12px; padding:5px 8px; border-radius:6px; cursor:pointer;
  background:rgba(23,26,33,.05); color:#3b414b; border:none; color-scheme:light;
  box-shadow:inset 0 0 0 1px rgba(23,26,33,.12); }
.wavep-select:hover { background:rgba(59,111,212,.1); color:#3563c2; }
.theme-dark .wavep-select { background:rgba(255,255,255,.06); color:#d6d9de; color-scheme:dark;
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.1); }
.theme-dark .wavep-select:hover { background:rgba(108,167,232,.16); color:#8fbdf7; }
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
.wavep-menuwrap { position:relative; margin-left:auto; }
.wavep-menu { position:absolute; right:0; top:calc(100% + 4px); z-index:6; min-width:150px; padding:4px; border-radius:8px;
  display:flex; flex-direction:column; gap:2px; background:rgba(255,255,255,.98);
  box-shadow:0 6px 18px rgba(0,0,0,.2), inset 0 0 0 1px rgba(23,26,33,.12); }
.theme-dark .wavep-menu { background:rgba(42,44,48,.98); box-shadow:0 6px 18px rgba(0,0,0,.5), inset 0 0 0 1px rgba(255,255,255,.12); }
.wavep-menu-item { text-align:left; border:none; background:transparent; color:inherit; cursor:pointer;
  font-size:12px; padding:6px 8px; border-radius:5px; white-space:nowrap; }
.wavep-menu-item:hover { background:rgba(59,111,212,.12); color:#3563c2; }
.theme-dark .wavep-menu-item:hover { background:rgba(108,167,232,.18); color:#8fbdf7; }
/* 波形主体：画布 + 画布内浮层纵向通道滚动条（DOM，可拖/点跳/滚轮） */
.wavep-main { display:flex; flex:1; min-height:200px; }
.wavep-wrap { flex:1; min-width:0; position:relative;
  border:1px solid rgba(23,26,33,.1); border-radius:6px; overflow:hidden; }
.theme-dark .wavep-wrap { border-color:rgba(255,255,255,.09); }
/* 滚动条改为画布内浮层：不再占横向空间，下面的总览条/通道区/状态栏就能与画布左右边缘严格对齐 */
.wavep-vscroll { position:absolute; right:3px; top:3px; bottom:3px; width:8px; z-index:3;
  border-radius:4px; cursor:pointer; background:rgba(23,26,33,.06); }
.wavep-vthumb { position:absolute; left:0; width:8px; min-height:24px; border-radius:4px;
  background:rgba(128,132,140,.55); }
.wavep-vthumb:hover, .wavep-vthumb.dragging { background:rgba(59,111,212,.65); }
.theme-dark .wavep-vscroll { background:rgba(255,255,255,.06); }
.theme-dark .wavep-vthumb { background:rgba(160,166,175,.6); }
.theme-dark .wavep-vthumb:hover, .theme-dark .wavep-vthumb.dragging { background:rgba(108,167,232,.75); }
/* 总览条：画布外独立 mini canvas（整段时间缩影 + 视窗框） */
.wavep-ovcanvas { display:block; width:100%; height:30px; flex-shrink:0; cursor:grab; }
.wavep-ovcanvas:active { cursor:grabbing; }
.wavep-canvas { position:absolute; inset:0; width:100%; height:100%; display:block; cursor:crosshair; }
/* 鼠标读数 HUD：贴着光标显示时间与各通道数值（示波器“光标读数”的等价物） */
.wavep-hud { position:absolute; z-index:4; min-width:120px; max-width:240px; padding:6px 8px; border-radius:6px;
  font:11px/1.45 Consolas, monospace; pointer-events:none; color:#3b414b;
  background:rgba(255,255,255,.92); box-shadow:0 2px 10px rgba(0,0,0,.18), inset 0 0 0 1px rgba(23,26,33,.12); }
.theme-dark .wavep-hud { color:#d6d9de; background:rgba(38,40,44,.94); box-shadow:0 2px 10px rgba(0,0,0,.45), inset 0 0 0 1px rgba(255,255,255,.12); }
.wavep-hud-time { font-weight:700; margin-bottom:2px; }
.wavep-hud-el { font-weight:400; color:#8a9099; margin-left:6px; }
.theme-dark .wavep-hud-el { color:#7c828c; }
.wavep-hud-dt { color:#3563c2; margin-bottom:3px; }
.theme-dark .wavep-hud-dt { color:#8fbdf7; }
.wavep-hud-row { display:flex; gap:8px; justify-content:space-between; }
.wavep-hud-row b { font-weight:600; }
.wavep-hud-row span:last-child { font-variant-numeric:tabular-nums; }
/* 测量 / 数学面板：画布内浮层 */
.wavep-measure, .wavep-math { position:absolute; z-index:5; right:6px; top:6px; width:260px; border-radius:8px;
  background:rgba(255,255,255,.95); box-shadow:0 4px 16px rgba(0,0,0,.2), inset 0 0 0 1px rgba(23,26,33,.12);
  font-size:11px; color:#3b414b; display:flex; flex-direction:column; }
.wavep-math { top:auto; bottom:6px; }
.theme-dark .wavep-measure, .theme-dark .wavep-math { background:rgba(38,40,44,.96); color:#d6d9de; box-shadow:0 4px 16px rgba(0,0,0,.5), inset 0 0 0 1px rgba(255,255,255,.12); }
.wavep-panel-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:5px 8px;
  font-weight:600; border-bottom:1px solid rgba(23,26,33,.08); }
.theme-dark .wavep-panel-head { border-color:rgba(255,255,255,.1); }
.wavep-panel-close { border:none; background:transparent; color:inherit; cursor:pointer; font-size:12px; opacity:.7; }
.wavep-panel-close:hover { opacity:1; }
.wavep-measure-body { padding:4px 8px 6px; overflow-y:auto; max-height:132px;
  scrollbar-width:thin; scrollbar-color:rgba(128,132,140,.45) transparent; }
.wavep-measure-body::-webkit-scrollbar { width:8px; }
.wavep-measure-body::-webkit-scrollbar-thumb { background:rgba(128,132,140,.45); border-radius:4px; }
.wavep-measure-body::-webkit-scrollbar-track { background:transparent; }
.wavep-measure-row { display:grid; grid-template-columns:44px repeat(4, 1fr); gap:2px 6px; padding:2px 0;
  font-variant-numeric:tabular-nums; }
.wavep-measure-row.head { color:#8a9099; font-weight:600; }
.wavep-math-bar { display:flex; flex-wrap:wrap; gap:4px; padding:5px 8px; align-items:center; }
.wavep-math-bar .wavep-select { max-width:100%; font-size:11px; padding:3px 6px; }
.wavep-math-n { display:flex; align-items:center; gap:4px; }
.wavep-math-num { width:52px; font-size:11px; padding:3px 4px; border-radius:4px; border:none;
  background:rgba(23,26,33,.06); color:inherit; }
.theme-dark .wavep-math-num { background:rgba(255,255,255,.08); }
.wavep-math-canvas { display:block; width:100%; height:96px; }
.wavep-math-foot { padding:3px 8px 6px; color:#8a9099; font-variant-numeric:tabular-nums; }
.wavep-legend { --wavep-chip-w:156px; display:grid; grid-template-columns:repeat(auto-fill, minmax(var(--wavep-chip-w), 1fr));
  grid-auto-rows:40px; gap:6px; justify-content:stretch; align-content:flex-start; min-height:26px;
  max-height:136px; overflow-y:auto; scrollbar-width:thin; scrollbar-gutter:stable;
  scrollbar-color:rgba(128,132,140,.45) transparent; }
.wavep-legend::-webkit-scrollbar { width:8px; }
.wavep-legend::-webkit-scrollbar-thumb { background:rgba(128,132,140,.45); border-radius:4px; }
/* 通道卡片：默认两行（上行名、下行值），通道多时由 .dense 压回单行紧凑布局 */
.wavep-chip { display:flex; flex-direction:column; align-items:stretch; justify-content:center; gap:2px;
  width:100%; height:40px; box-sizing:border-box;
  padding:3px 10px; border-radius:9px; overflow:hidden;
  background:rgba(23,26,33,.04); box-shadow:inset 0 0 0 1px rgba(23,26,33,.08); cursor:pointer; user-select:none; }
.wavep-chip-top { display:flex; align-items:center; gap:6px; min-width:0; }
.wavep-chip-bottom { display:flex; align-items:baseline; justify-content:flex-end; gap:6px; }
/* 通道多（>12）时压回单行：一屏能看到更多通道 */
.wavep-legend.dense { grid-auto-rows:26px; }
.wavep-legend.dense .wavep-chip { flex-direction:row; align-items:center; height:26px; gap:5px; border-radius:999px; padding:3px 8px; }
.wavep-legend.dense .wavep-chip-top { flex:1; }
.wavep-legend.dense .wavep-chip-bottom { flex:none; gap:5px; }
.wavep-chip:hover { background:rgba(59,111,212,.08); }
/* 悬停高亮：被指的通道描边强调，其余通道淡出，和画布里的曲线高亮对应 */
.wavep-chip.hot { background:rgba(59,111,212,.12); box-shadow:inset 0 0 0 1.5px rgba(59,111,212,.55); }
.wavep-legend.hovering .wavep-chip:not(.hot) { opacity:.5; }
.theme-dark .wavep-chip.hot { background:rgba(108,167,232,.18); box-shadow:inset 0 0 0 1.5px rgba(108,167,232,.6); }
.wavep-chip.off { opacity:.45; }
.wavep-chip i { width:9px; height:9px; border-radius:50%; flex-shrink:0; }
.wavep-chip-name { font-size:12px; font-weight:600; color:#3b414b; flex:1; min-width:0;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
/* 数值/增量都用**固定宽度**的右对齐列：
   数值列右边缘 = 增量列左边缘，增量列宽度恒定 ⇒ 所有 chip 的数值右边缘完全对齐，
   数字长度变化、Δ 有无（NaN 通道）都不会让数值列左右跳动。 */
.wavep-chip-val { font-size:12px; color:#6b7280; font-family:Consolas,monospace; font-variant-numeric:tabular-nums;
  flex:0 0 auto; min-width:6ch; text-align:right; }
.wavep-chip-delta { font-size:10px; color:#3563c2; font-family:Consolas,monospace; font-variant-numeric:tabular-nums;
  flex:0 0 42px; width:42px; text-align:right; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
/* 没有游标差值时不占位，把空间让给通道名；
   一旦某个通道出现差值，整排都预留差值列（.has-delta），数值列才不会左右跳动 */
.wavep-chip-delta:empty { display:none; }
.wavep-legend.has-delta .wavep-chip-delta:empty { display:inline-block; visibility:hidden; }
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
        <button type="button" class="wavep-btn wavep-style">曲线</button>
        <button type="button" class="wavep-btn wavep-freeze">冻结</button>
        <button type="button" class="wavep-btn wavep-follow" style="display:none">回到最新</button>
        <button type="button" class="wavep-btn wavep-cursorbtn">游标</button>
        <button type="button" class="wavep-btn wavep-measurebtn">测量</button>
        <button type="button" class="wavep-btn wavep-mathbtn">数学</button>
        <button type="button" class="wavep-btn wavep-clear">清空</button>
        <div class="wavep-menuwrap">
          <button type="button" class="wavep-btn wavep-export-menu" title="导出 SVG / CSV / 协议文件 / 日志库">导出 ▾</button>
          <div class="wavep-menu" style="display:none">
            <button type="button" class="wavep-menu-item" data-export="svg">SVG 矢量图</button>
            <button type="button" class="wavep-menu-item" data-export="csv">CSV 数据（当前时间窗）</button>
            <button type="button" class="wavep-menu-item" data-export="protocol">协议文件</button>
            <button type="button" class="wavep-menu-item" data-export="loglib">日志库</button>
          </div>
        </div>
      </div>
      <div class="wavep-main">
        <div class="wavep-wrap">
          <canvas class="wavep-canvas"></canvas>
          <div class="wavep-vscroll" style="display:none" title="拖动浏览通道 / 点击跳转 / 滚轮滚动"><div class="wavep-vthumb"></div></div>
          <div class="wavep-hud" style="display:none"></div>
          <div class="wavep-measure" style="display:none"><div class="wavep-panel-head"><span>测量（当前时间窗）</span><button type="button" class="wavep-panel-close" data-close="measure" title="关闭">✕</button></div><div class="wavep-measure-body"></div></div>
          <div class="wavep-math" style="display:none">
            <div class="wavep-panel-head"><span>数学通道</span><button type="button" class="wavep-panel-close" data-close="math" title="关闭">✕</button></div>
            <div class="wavep-math-bar">
              <select class="wavep-select wavep-math-op">
                <option value="diff">A − B（差分）</option>
                <option value="avg">平滑平均（A）</option>
                <option value="fft">FFT 频谱（A）</option>
              </select>
              <select class="wavep-select wavep-math-a"></select>
              <select class="wavep-select wavep-math-b"></select>
              <label class="wavep-math-n">阶数<input type="number" class="wavep-math-num" min="2" max="999" step="1" value="9" /></label>
            </div>
            <canvas class="wavep-math-canvas"></canvas>
            <div class="wavep-math-foot"></div>
          </div>
        </div>
      </div>
      <canvas class="wavep-ovcanvas" title="拖动蓝框平移 / 拖边缩放 / 点击空白跳转"></canvas>
      <div class="wavep-legend"></div>
      <div class="wavep-status"><span class="wavep-stats"></span><span class="wavep-window"></span></div>
    </div>`;

  const root = el.querySelector('.wavep') as HTMLElement;
  const canvas = el.querySelector('.wavep-canvas') as HTMLCanvasElement;
  const wrap = el.querySelector('.wavep-wrap') as HTMLElement;
  const vscroll = el.querySelector('.wavep-vscroll') as HTMLElement;
  const vthumb = el.querySelector('.wavep-vthumb') as HTMLElement;
  const ovCanvas = el.querySelector('.wavep-ovcanvas') as HTMLCanvasElement;
  const sourceSel = el.querySelector('.wavep-source') as HTMLSelectElement;
  const btnOverlay = el.querySelector('.wavep-overlay') as HTMLButtonElement;
  const btnFreeze = el.querySelector('.wavep-freeze') as HTMLButtonElement;
  const btnFollow = el.querySelector('.wavep-follow') as HTMLButtonElement;
  const btnCursor = el.querySelector('.wavep-cursorbtn') as HTMLButtonElement;
  const btnClear = el.querySelector('.wavep-clear') as HTMLButtonElement;
  const btnExportMenu = el.querySelector('.wavep-export-menu') as HTMLButtonElement;
  const exportMenu = el.querySelector('.wavep-menu') as HTMLElement;
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
    persist(); // 弹层期间的取色改动一并落盘（拖色后直接点 × 的路径不含 persist）
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
    // 切换视图会改变“栏→通道”的对应关系：清掉悬停高亮，否则叠加模式下其余曲线会被一直压暗
    setHover(null);
    updateButtons();
    markDirty();
  });

  const btnStyle = el.querySelector('.wavep-style') as HTMLButtonElement;
  btnStyle.addEventListener('click', () => {
    const order = STYLE_ORDER;
    // 持久化的样式值异常时 indexOf 为 -1：此时应从第一档开始，而不是“点了没反应”
    const at = order.indexOf(view.style);
    view.style = order[(at < 0 ? 0 : at + 1) % order.length];
    btnStyle.textContent = STYLE_LABEL[view.style] ?? '曲线';
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
    // 清空把帧计数归零：同步重置帧率采样基线，否则下一次统计会算出负帧率
    fpsFrames = 0;
    fps = 0;
    fpsMark = performance.now();
    markDirty();
  });

  // ---------- 鼠标读数 HUD / 测量面板 / 数学通道 / CSV 导出 ----------
  const hudEl = el.querySelector('.wavep-hud') as HTMLElement;
  const measurePanel = el.querySelector('.wavep-measure') as HTMLElement;
  const measureBody = el.querySelector('.wavep-measure-body') as HTMLElement;
  const mathPanel = el.querySelector('.wavep-math') as HTMLElement;
  const mathCanvas = el.querySelector('.wavep-math-canvas') as HTMLCanvasElement;
  const mathOp = el.querySelector('.wavep-math-op') as HTMLSelectElement;
  const mathA = el.querySelector('.wavep-math-a') as HTMLSelectElement;
  const mathB = el.querySelector('.wavep-math-b') as HTMLSelectElement;
  const mathN = el.querySelector('.wavep-math-num') as HTMLInputElement;
  const mathFoot = el.querySelector('.wavep-math-foot') as HTMLElement;
  const btnMeasure = el.querySelector('.wavep-measurebtn') as HTMLButtonElement;
  const btnMath = el.querySelector('.wavep-mathbtn') as HTMLButtonElement;

  const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
  const visibleChannels = () => engine.channels.map((_, i) => i).filter((i) => engine.visible[i] !== false);
  let measureOpen = false;
  let mathOpen = false;
  let lastPointer: { x: number; y: number } | null = null;

  // 当前时间窗对应的样本索引区间 [i0, i1)
  const windowRange = (): { i0: number; i1: number } | null => {
    if (engine.t.count < 2 || !(geom.t1 > geom.t0)) return null;
    const i0 = Math.max(0, engine.lowerBound(geom.t0));
    const i1 = Math.min(engine.t.count, Math.max(i0 + 1, engine.lowerBound(geom.t1) + 1));
    return i1 - i0 >= 2 ? { i0, i1 } : null;
  };

  // 插件拿到的数据时间戳是 performance.now()（页面启动至今毫秒），显示时换算成本地时钟；
  // 同时给出相对第一个样本的秒数（示波器习惯的相对时间）。
  const timeText = (t: number) => {
    const epoch = t + (Date.now() - performance.now());
    const d = new Date(epoch);
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  };
  const relativeText = (t: number) => {
    const first = engine.t.count > 0 ? engine.t.at(0) : t;
    return `+${((t - first) / 1000).toFixed(3)} s`;
  };

  // 读数 HUD：光标所在时间的各通道数值（分栏悬停某栏时只显示该通道）
  const updateHud = () => {
    if (view.hoverT === null || !lastPointer || engine.t.count === 0) {
      hudEl.style.display = 'none';
      return;
    }
    const idx = engine.nearestIndex(view.hoverT);
    if (idx < 0) {
      hudEl.style.display = 'none';
      return;
    }
    const palette = buildColors().palette;
    const focus = view.hoverCh;
    const chs = focus !== null && !view.overlay ? [focus] : visibleChannels().slice(0, 8);
    let dtLine = '';
    if (view.cursorA !== null && view.cursorB !== null) {
      const dt = Math.abs(view.cursorB - view.cursorA);
      if (dt > 0) {
        const hz = 1000 / dt;
        const hzText = hz >= 100 ? hz.toFixed(0) : hz >= 1 ? hz.toFixed(1) : hz.toFixed(2);
        dtLine = `<div class="wavep-hud-dt">Δt ${fmtDuration(dt)} · ${hzText} Hz</div>`;
      }
    }
    const rows = chs
      .map((ch) => {
        const color = palette[ch % palette.length];
        const name = engine.names[ch] ?? `CH${ch + 1}`;
        return `<div class="wavep-hud-row"><span><i style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${color};margin-right:5px"></i><b>${escapeHtml(name)}</b></span><span>${fmtValue(engine.channels[ch].at(idx))}</span></div>`;
      })
      .join('');
    hudEl.innerHTML = `<div class="wavep-hud-time">${timeText(engine.t.at(idx))}<span class="wavep-hud-el">${relativeText(engine.t.at(idx))}</span></div>${dtLine}${rows}`;
    hudEl.style.display = '';
    // 定位全部用“布局像素”：根节点 zoom<1 时 getBoundingClientRect 是视觉像素，
    // 和 offsetWidth/left/top 混用会让浮层漂移（默认窗口 zoom=0.85 就会偏 ~20px 并压住光标）。
    const wr = wrap.getBoundingClientRect();
    const scale = wr.width / (wrap.offsetWidth || 1) || 1;
    const px = (lastPointer.x - wr.left) / scale;
    const py = (lastPointer.y - wr.top) / scale;
    const w = hudEl.offsetWidth;
    const h = hudEl.offsetHeight;
    const WW = wrap.offsetWidth;
    const WH = wrap.offsetHeight;
    // 间距按“视觉像素”给（14px），换算成布局像素，这样 zoom<1 时视觉上仍是贴光标 14px
    const gap = 14 / scale;
    const cands = [
      { x: px + gap, y: py + gap }, // 右下（默认）
      { x: px - gap - w, y: py + gap }, // 左下
      { x: px + gap, y: py - gap - h }, // 右上
      { x: px - gap - w, y: py - gap - h }, // 左上
    ];
    const fits = (c: { x: number; y: number }) => c.x >= 6 && c.y >= 6 && c.x + w <= WW - 6 && c.y + h <= WH - 6;
    let pos = cands.find(fits);
    if (!pos) {
      // 四个方向都放不下：贴到离光标最远的角（留 6px 内边距），再确保不压住光标
      pos = { x: px < WW / 2 ? WW - w - 6 : 6, y: py < WH / 2 ? WH - h - 6 : 6 };
      const covers = px >= pos.x - 4 && px <= pos.x + w + 4 && py >= pos.y - 4 && py <= pos.y + h + 4;
      if (covers) {
        pos.x = px < WW / 2 ? Math.max(6, Math.min(WW - w - 6, px + 24)) : Math.min(WW - w - 6, Math.max(6, px - w - 24));
      }
    }
    hudEl.style.left = `${Math.round(pos.x)}px`;
    hudEl.style.top = `${Math.round(pos.y)}px`;
  };

  // 测量面板：当前时间窗内每个可见通道的 当前值 / Vpp / RMS / 频率
  const renderMeasure = () => {
    if (!measureOpen) return;
    const r = windowRange();
    const chs = visibleChannels();
    if (!r || chs.length === 0) {
      measureBody.innerHTML = '<div class="wavep-measure-row head"><span>通道</span><span colspan="3">当前时间窗内无数据</span></div>';
      return;
    }
    const palette = buildColors().palette;
    const head = `<div class="wavep-measure-row head"><span>通道</span><span>当前</span><span>Vpp</span><span>RMS</span><span>频率</span></div>`;
    const rows = chs
      .slice(0, 24)
      .map((ch) => {
        const s = channelStats(engine, ch, r.i0, r.i1);
        const cur = engine.channels[ch].at(r.i1 - 1);
        const color = palette[ch % palette.length];
        const name = engine.names[ch] ?? `CH${ch + 1}`;
        return (
          `<div class="wavep-measure-row" title="${escapeHtml(name)}：Vpp ${fmtValue(s.vpp)} / RMS ${fmtValue(s.rms)} / 均值 ${fmtValue(s.mean)}">` +
          `<span style="color:${color};overflow:hidden;text-overflow:ellipsis">${escapeHtml(name)}</span>` +
          `<span>${fmtValue(cur)}</span><span>${fmtValue(s.vpp)}</span><span>${fmtValue(s.rms)}</span>` +
          `<span>${s.freq !== null ? s.freq.toFixed(1) + ' Hz' : '—'}</span></div>`
        );
      })
      .join('');
    measureBody.innerHTML = head + rows;
  };

  // 数学通道：差分 / 平滑平均 / FFT 频谱，画在面板内的小画布上
  type MathOp = 'diff' | 'avg' | 'fft';
  let mathCfg = ctx.storage.get<{ op: MathOp; a: number; b: number; n: number }>('wave.math', { op: 'diff', a: 0, b: 1, n: 9 });
  if (!mathCfg || typeof mathCfg !== 'object') mathCfg = { op: 'diff', a: 0, b: 1, n: 9 };
  const saveMathCfg = () => {
    mathCfg = {
      op: (['diff', 'avg', 'fft'].includes(mathOp.value) ? mathOp.value : 'diff') as MathOp,
      a: Number(mathA.value) || 0,
      b: Number(mathB.value) || 0,
      n: Math.min(999, Math.max(2, Number(mathN.value) || 9)),
    };
    ctx.storage.set('wave.math', mathCfg);
    renderMath();
  };

  const syncMathSelectors = () => {
    const opts = engine.channels
      .map((_, i) => `<option value="${i}">${escapeHtml(engine.names[i] ?? `CH${i + 1}`)}</option>`)
      .join('');
    if (mathA.dataset.count !== String(engine.channels.length)) {
      mathA.innerHTML = opts;
      mathB.innerHTML = opts;
      mathA.dataset.count = String(engine.channels.length);
    }
    mathA.value = String(Math.min(mathCfg.a, Math.max(0, engine.channels.length - 1)));
    mathB.value = String(Math.min(mathCfg.b, Math.max(0, engine.channels.length - 1)));
    mathOp.value = mathCfg.op;
    mathN.value = String(mathCfg.n);
    const isFft = mathCfg.op === 'fft';
    const isAvg = mathCfg.op === 'avg';
    mathB.style.display = mathCfg.op === 'diff' ? '' : 'none';
    mathN.parentElement!.style.display = isAvg ? '' : 'none';
    void isFft;
  };

  // 小画布绘制：折线（差分/平滑）或幅值谱（FFT）
  const drawMathCanvas = (values: Float32Array | null, spectrum: Spectrum | null, unit: string) => {
    const dpr = (window.devicePixelRatio || 1) * (Number(document.documentElement.style.zoom) || 1);
    const cssW = mathCanvas.clientWidth || 240;
    const cssH = mathCanvas.clientHeight || 110;
    const W = Math.round(cssW * dpr);
    const H = Math.round(cssH * dpr);
    if (mathCanvas.width !== W || mathCanvas.height !== H) {
      mathCanvas.width = W;
      mathCanvas.height = H;
    }
    const g = mathCanvas.getContext('2d');
    if (!g) return;
    const colors = buildColors();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);
    g.fillStyle = colors.bg;
    g.fillRect(0, 0, cssW, cssH);
    const L = 34;
    const R = 6;
    const T = 6;
    const B = 14;
    const pw = Math.max(1, cssW - L - R);
    const ph = Math.max(1, cssH - T - B);
    g.strokeStyle = colors.grid;
    g.lineWidth = 1;
    g.strokeRect(L, T, pw, ph);

    if (spectrum) {
      let maxMag = 0;
      for (let k = 1; k < spectrum.mags.length; k++) maxMag = Math.max(maxMag, spectrum.mags[k]);
      if (!(maxMag > 0)) return;
      g.fillStyle = colors.accent;
      const bins = spectrum.mags.length - 1; // 跳过 DC 柱（k=0），但横坐标仍按 k 定位，避免整条谱左移一个 bin
      for (let k = 1; k < spectrum.mags.length; k++) {
        const x = L + (k / bins) * pw;
        const h = (spectrum.mags[k] / maxMag) * ph;
        g.fillRect(x, T + ph - h, Math.max(1, pw / bins - 0.5), h);
      }
      g.fillStyle = colors.textDim;
      g.font = '9px Consolas, monospace';
      g.textAlign = 'left';
      g.textBaseline = 'top';
      g.fillText('0 Hz', L, T + ph + 3);
      g.textAlign = 'right';
      g.fillText(`${(spectrum.fsEff / 2).toFixed(0)} Hz`, L + pw, T + ph + 3);
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.fillText(maxMag.toPrecision(2), 2, T + 6);
      return;
    }
    if (!values || values.length < 2) return;
    let min = Infinity;
    let max = -Infinity;
    for (const v of values) {
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return;
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const yOf = (v: number) => T + ph - ((v - min) / (max - min)) * ph;
    g.strokeStyle = colors.accent;
    g.lineWidth = 1.6;
    g.beginPath();
    const stride = Math.max(1, Math.ceil(values.length / (pw * 2)));
    for (let i = 0; i < values.length; i += stride) {
      const x = L + (i / (values.length - 1)) * pw;
      const y = yOf(values[i]);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
    g.fillStyle = colors.textDim;
    g.font = '9px Consolas, monospace';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText(fmtValue(max), 2, T + 5);
    g.fillText(fmtValue(min), 2, T + ph - 5);
    g.textBaseline = 'top';
    g.fillText(unit, L, T + ph + 3);
  };

  const renderMath = () => {
    if (!mathOpen) return;
    syncMathSelectors();
    const r = windowRange();
    if (!r || engine.channels.length === 0) {
      drawMathCanvas(null, null, '');
      mathFoot.textContent = '当前时间窗内无数据';
      return;
    }
    const aName = engine.names[mathCfg.a] ?? `CH${mathCfg.a + 1}`;
    if (mathCfg.op === 'fft') {
      const spec = fftSpectrum(engine, mathCfg.a, r.i0, r.i1);
      drawMathCanvas(null, spec, '');
      if (spec) {
        // 同时给出“谱峰”与“同窗过零基频”：两个口径对不上时能一眼看出是数据问题还是算法问题
        let pk = 1;
        for (let k = 2; k < spec.mags.length; k++) if (spec.mags[k] > spec.mags[pk]) pk = k;
        const pkHz = spec.freqs[pk];
        const zero = channelStats(engine, mathCfg.a, r.i0, r.i1).freq;
        mathFoot.textContent =
          `${aName} 采样≈${spec.sampleHz.toFixed(1)} Hz · ${spec.nfft} 点 FFT · 分辨率 ${(spec.fsEff / spec.nfft).toFixed(2)} Hz` +
          ` · 谱峰 ${pkHz.toFixed(2)} Hz` +
          (zero ? ` · 过零 ${zero.toFixed(2)} Hz` : '');
      } else {
        mathFoot.textContent = `${aName} 样本不足，无法做 FFT`;
      }
      return;
    }
    const av = sliceChannel(engine, mathCfg.a, r.i0, r.i1);
    if (mathCfg.op === 'diff') {
      const bv = sliceChannel(engine, mathCfg.b, r.i0, r.i1);
      const out = new Float32Array(Math.min(av.length, bv.length));
      for (let i = 0; i < out.length; i++) out[i] = av[i] - bv[i];
      drawMathCanvas(out, null, `${aName} − ${engine.names[mathCfg.b] ?? `CH${mathCfg.b + 1}`}`);
      mathFoot.textContent = `差分 ${out.length} 点（当前时间窗）`;
    } else {
      const out = movingAverage(av, mathCfg.n);
      drawMathCanvas(out, null, `${aName} 平滑 N=${mathCfg.n}`);
      mathFoot.textContent = `滑动平均 N=${mathCfg.n} · ${out.length} 点`;
    }
  };

  // 测量与数学面板互斥：画布区本来就窄，同时开会互相遮挡
  const setMeasureOpen = (on: boolean) => {
    if (on && mathOpen) setMathOpen(false);
    measureOpen = on;
    measurePanel.style.display = on ? '' : 'none';
    btnMeasure.classList.toggle('active', on);
    if (on) renderMeasure();
  };
  const setMathOpen = (on: boolean) => {
    if (on && measureOpen) {
      measureOpen = false;
      measurePanel.style.display = 'none';
      btnMeasure.classList.remove('active');
    }
    mathOpen = on;
    mathPanel.style.display = on ? '' : 'none';
    btnMath.classList.toggle('active', on);
    if (on) renderMath();
  };

  btnMeasure.addEventListener('click', () => setMeasureOpen(!measureOpen));
  btnMath.addEventListener('click', () => setMathOpen(!mathOpen));
  for (const btn of el.querySelectorAll('.wavep-panel-close')) {
    btn.addEventListener('click', () => {
      const which = (btn as HTMLElement).dataset.close;
      if (which === 'measure') setMeasureOpen(false);
      if (which === 'math') setMathOpen(false);
    });
  }
  mathOp.addEventListener('change', saveMathCfg);
  mathA.addEventListener('change', saveMathCfg);
  mathB.addEventListener('change', saveMathCfg);
  mathN.addEventListener('change', saveMathCfg);

  // CSV 导出：当前时间窗内所有可见通道（最多 20 万行），便于丢进 Excel / Python
  const exportCsv = () => {
    const r = windowRange();
    const cols = visibleChannels();
    if (!r || cols.length === 0) {
      ctx.notify('当前没有可导出的波形数据');
      return;
    }
    if (!ctx.exportTextFiles) {
      ctx.notify('当前应用版本过旧，不支持文件导出');
      return;
    }
    const csv = buildCsv(engine, engine.names, cols, r.i0, r.i1, 200_000);
    if (!csv) {
      ctx.notify('当前没有可导出的波形数据');
      return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    void ctx
      .exportTextFiles('选择 CSV 导出目录', [{ name: `wave-${stamp}.csv`, text: csv }], 'wave-csv')
      .then((dir) => ctx.notify(dir ? `CSV 已导出到 ${dir}（${r.i1 - r.i0} 点 × ${cols.length} 通道）` : 'CSV 导出已取消'))
      .catch(() => ctx.notify('CSV 导出失败'));
  };

  // 导出子目录名必须用 ASCII：后端 safe_rel 只允许 [a-zA-Z0-9._-]，
  // 传中文会被拒（且是弹框前校验），表现为“点了一点反应都没有”。
  const exportProtocol = () => {
    void (async () => {
      if (!ctx.exportTextFiles) {
        ctx.notify('当前应用版本过旧，不支持文件导出');
        return;
      }
      try {
        const dir = await ctx.exportTextFiles('选择协议文件导出目录', FIRMWARE_FILES, 'nnwave-protocol');
        ctx.notify(dir ? `协议文件已导出到 ${dir} 下的 nnwave-protocol 子目录` : '已取消导出');
      } catch (e) {
        ctx.notify('协议文件导出失败：' + (e instanceof Error ? e.message : String(e)));
      }
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
      try {
        const dir = await ctx.exportTextFiles('选择SVG导出目录', [{ name: `wave-${stamp}.svg`, text: svg }], 'wave-svg');
        ctx.notify(dir ? `波形 SVG 已导出到 ${dir} 下的 wave-svg 子目录` : '已取消导出');
      } catch (e) {
        ctx.notify('SVG 导出失败：' + (e instanceof Error ? e.message : String(e)));
      }
    })();
  };

  // 导出 NNPrintf 日志库：分级日志头文件（[LEVEL]-- 前缀与上位机消息区着色配套）
  const exportLogLib = () => {
    void (async () => {
      if (!ctx.exportTextFiles) {
        ctx.notify('当前应用版本过旧，不支持文件导出');
        return;
      }
      try {
        const dir = await ctx.exportTextFiles('选择日志库导出目录', NNPRINTF_FILES, 'nnprintf-log');
        ctx.notify(dir ? `NNPrintf.h 已导出到 ${dir} 下的 nnprintf-log 子目录` : '已取消导出');
      } catch (e) {
        ctx.notify('日志库导出失败：' + (e instanceof Error ? e.message : String(e)));
      }
    })();
  };

  // 导出统一收进下拉菜单：4 个导出按钮会把 800px 宽的工具栏挤成三行
  const closeExportMenu = () => {
    exportMenu.style.display = 'none';
  };
  btnExportMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    exportMenu.style.display = exportMenu.style.display === 'none' ? '' : 'none';
  });
  exportMenu.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest('.wavep-menu-item') as HTMLElement | null;
    if (!item) return;
    closeExportMenu();
    const kind = item.dataset.export;
    if (kind === 'svg') exportSvg();
    else if (kind === 'csv') exportCsv();
    else if (kind === 'protocol') exportProtocol();
    else if (kind === 'loglib') exportLogLib();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!exportMenu.contains(e.target as Node) && e.target !== btnExportMenu) closeExportMenu();
  });

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
    layout: null,
  };
  const inPlot = (x: number) => x >= geom.plotLeft && x <= geom.plotLeft + geom.plotWidth;
  const timeAtX = (x: number) => geom.t0 + ((x - geom.plotLeft) / geom.plotWidth) * view.windowMs;
  const currentT1 = () => (view.frozen ? view.rightT : view.follow ? engine.lastT : view.rightT);

  // ---------- 画布外控件：总览条（共享时间窗）与纵向通道滚动条 ----------
  let ovRange: { fullT0: number; fullT1: number } | null = null; // draw 循环内同步
  const ovPointer = (e: PointerEvent | WheelEvent): { x: number; t: number } | null => {
    const rect = ovCanvas.getBoundingClientRect();
    const scale = rect.width / (ovCanvas.clientWidth || 1);
    const x = (e.clientX - rect.left) / scale;
    if (!ovRange) return null;
    const frac = Math.min(1, Math.max(0, x / (ovCanvas.clientWidth || 1)));
    return { x, t: ovRange.fullT0 + frac * (ovRange.fullT1 - ovRange.fullT0) };
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
      // Y 轴刻度区（绘图区右侧）：滚轮=滚动通道列表（分栏溢出时），与外置滚动条/总览条同语义
      if (x > geom.plotLeft + geom.plotWidth) {
        if (geom.layout) {
          view.paneScroll = clamp(view.paneScroll + e.deltaY, 0, geom.layout.scrollMax);
          markDirty();
        }
        return;
      }
      if (!inPlot(x)) return;
      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      if (e.shiftKey) {
        scaleY(findPaneChannel(y), factor);
        return;
      }
      const newWindow = Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, view.windowMs * factor));
      // 锚点必须用**旧**窗口算：timeAtX 依赖 view.windowMs，先赋值再算会把锚点算偏，
      // 表现为“缩放时光标下的波形会漂移”（漂移量 = 光标位置比例 × 时间窗变化量）。
      const tAt = timeAtX(x);
      view.windowMs = newWindow;
      // 缩放一律以光标为锚点（用户要求的标准示波器交互）：
      // 右缘钳制在数据范围内（拖不出空白未来）；光标区域放大后视图停在原地，
      // 拖回最右或点「回到最新」即恢复实时跟随
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
    | { kind: 'ov-pan'; grabT: number; startRightT: number }
    | { kind: 'ov-left'; anchorT: number }
    | { kind: 'ov-right'; anchorT: number }
    // 纵向滚动条 thumb 拖动（ratio = scrollMax / thumb 可行程）
    | { kind: 'scroll'; startY: number; startScroll: number; ratio: number; scrollMax: number };
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
    // 十字线 + 读数 HUD（单独块作用域取坐标，不影响下面的拖动逻辑）
    {
      const p = pointerPos(e);
      const inside = inPlot(p.x) && p.y >= geom.viewport.top && p.y <= geom.viewport.top + geom.viewport.height;
      if (inside) {
        view.hoverT = Math.min(geom.t1, Math.max(geom.t0, timeAtX(p.x)));
        lastPointer = { x: e.clientX, y: e.clientY };
        if (!drag) updateHud();
        markDirty();
      } else if (view.hoverT !== null) {
        view.hoverT = null;
        hudEl.style.display = 'none';
        markDirty();
      }
      // 分栏模式下悬停某一栏 → 高亮该通道（曲线与对应 chip 一起亮）
      if (!drag && !view.overlay) {
        const pane = geom.panes.find((q) => p.y >= q.top && p.y < q.top + q.height);
        setHover(pane ? pane.ch : null);
      }
    }
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
      view.paneScroll = clamp(drag.startScroll + (y - drag.startY) * drag.ratio, 0, drag.scrollMax);
    } else if (drag.kind === 'ov-pan' || drag.kind === 'ov-left' || drag.kind === 'ov-right') {
      return; // 总览条拖动由 ovCanvas 自己的监听处理（capture 在它身上）
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

  // ---------- 纵向通道滚动条（画布外 DOM）：拖 thumb / 点轨道跳转 / 滚轮 ----------
  const syncVScroll = () => {
    const layout = geom.layout;
    vscroll.style.display = layout ? '' : 'none';
    if (!layout) return;
    const trackH = vscroll.clientHeight || 1;
    const thumbH = Math.max(24, Math.min(trackH, layout.thumbH));
    const y = (view.paneScroll / layout.scrollMax) * (trackH - thumbH);
    vthumb.style.height = `${thumbH}px`;
    vthumb.style.top = `${y}px`;
  };
  vscroll.addEventListener('pointerdown', (e: PointerEvent) => {
    const layout = geom.layout;
    if (!layout) return;
    e.preventDefault();
    vscroll.setPointerCapture(e.pointerId);
    const rect = vscroll.getBoundingClientRect();
    const scale = rect.height / (vscroll.clientHeight || 1);
    const yLayout = (e.clientY - rect.top) / scale;
    const trackH = vscroll.clientHeight;
    const thumbH = Math.max(24, Math.min(trackH, layout.thumbH));
    const thumbY = (view.paneScroll / layout.scrollMax) * (trackH - thumbH);
    const inThumb = yLayout >= thumbY && yLayout <= thumbY + thumbH;
    let ratio = layout.scrollMax / (trackH - thumbH || 1);
    let startY = yLayout;
    let startScroll = view.paneScroll;
    if (!inThumb) {
      // 点轨道空白：thumb 中心跳到点击处，随即可继续拖动
      startScroll = clamp((yLayout - thumbH / 2) / (trackH - thumbH || 1) * layout.scrollMax, 0, layout.scrollMax);
      view.paneScroll = startScroll;
      startY = yLayout;
    }
    drag = { kind: 'scroll', startY, startScroll, ratio, scrollMax: layout.scrollMax };
    vthumb.classList.add('dragging');
    markDirty();
  });
  vscroll.addEventListener('pointermove', (e: PointerEvent) => {
    if (!drag || drag.kind !== 'scroll') return;
    const rect = vscroll.getBoundingClientRect();
    const scale = rect.height / (vscroll.clientHeight || 1);
    const yLayout = (e.clientY - rect.top) / scale;
    view.paneScroll = clamp(drag.startScroll + (yLayout - drag.startY) * drag.ratio, 0, drag.scrollMax);
    markDirty();
  });
  const endVScroll = (e: PointerEvent) => {
    if (vscroll.hasPointerCapture(e.pointerId)) vscroll.releasePointerCapture(e.pointerId);
    if (drag?.kind === 'scroll') {
      drag = null;
      vthumb.classList.remove('dragging');
      markDirty();
    }
  };
  vscroll.addEventListener('pointerup', endVScroll);
  vscroll.addEventListener('pointercancel', endVScroll);
  vscroll.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      e.preventDefault();
      if (!geom.layout) return;
      view.paneScroll = clamp(view.paneScroll + e.deltaY, 0, geom.layout.scrollMax);
      markDirty();
    },
    { passive: false }
  );

  // ---------- 总览条（画布外 mini canvas）：拖窗平移 / 拖边缩放 / 点空白跳转 ----------
  const OV_EDGE = 6; // 左右缘可拖缩放的命中宽度
  const ovSetWindow = (rightT: number, windowMs: number) => {
    const { rightT: r, follow } = clampWindow(rightT, windowMs);
    view.rightT = r;
    view.follow = follow;
    view.frozen = false;
  };
  ovCanvas.addEventListener('pointerdown', (e: PointerEvent) => {
    const pos = ovPointer(e);
    if (!pos || !ovRange) return;
    e.preventDefault();
    ovCanvas.setPointerCapture(e.pointerId);
    const cssW = ovCanvas.clientWidth || 1;
    const range = ovRange.fullT1 - ovRange.fullT0 || 1;
    const winL = ((geom.t1 - view.windowMs - ovRange.fullT0) / range) * cssW;
    const winR = ((geom.t1 - ovRange.fullT0) / range) * cssW;
    if (Math.abs(pos.x - winL) <= OV_EDGE && winR - winL > 12) {
      // 拖左缘：右缘固定，窗口宽 = 右缘 - 光标时间
      view.follow = false;
      view.frozen = false;
      drag = { kind: 'ov-left', anchorT: currentT1() };
    } else if (Math.abs(pos.x - winR) <= OV_EDGE && winR - winL > 12) {
      // 拖右缘：左缘固定在当前窗口左缘
      view.follow = false;
      view.frozen = false;
      drag = { kind: 'ov-right', anchorT: geom.t0 };
    } else if (pos.x > winL && pos.x < winR) {
      // 拖窗：记录按住处的时刻，平移时保持跟随手感
      view.follow = false;
      view.frozen = false;
      drag = { kind: 'ov-pan', grabT: pos.t, startRightT: currentT1() };
    } else {
      // 点空白：窗口中心跳到该时间点
      ovSetWindow(pos.t + view.windowMs / 2, view.windowMs);
      updateButtons();
    }
    markDirty();
  });
  ovCanvas.addEventListener('pointermove', (e: PointerEvent) => {
    if (!drag) return;
    const pos = ovPointer(e);
    if (!pos || !ovRange) return;
    if (drag.kind === 'ov-pan') {
      // 取景框跟手：光标右移（pos.t 增大）→ 窗口右移（rightT 增大）
      ovSetWindow(drag.startRightT + (pos.t - drag.grabT), view.windowMs);
      if (view.follow) view.rightT = engine.lastT;
    } else if (drag.kind === 'ov-left') {
      const w = clamp(drag.anchorT - pos.t, MIN_WINDOW, MAX_WINDOW);
      view.windowMs = w;
      ovSetWindow(drag.anchorT, w);
      view.follow = false;
    } else if (drag.kind === 'ov-right') {
      const w = clamp(pos.t - drag.anchorT, MIN_WINDOW, MAX_WINDOW);
      view.windowMs = w;
      ovSetWindow(pos.t, w);
      view.follow = false;
    } else return;
    updateButtons();
    markDirty();
  });
  const endOvDrag = (e: PointerEvent) => {
    if (ovCanvas.hasPointerCapture(e.pointerId)) ovCanvas.releasePointerCapture(e.pointerId);
    if (drag?.kind === 'ov-pan' || drag?.kind === 'ov-left' || drag?.kind === 'ov-right') {
      drag = null;
      updateButtons();
      markDirty();
    }
  };
  ovCanvas.addEventListener('pointerup', endOvDrag);
  ovCanvas.addEventListener('pointercancel', endOvDrag);
  ovCanvas.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      e.preventDefault();
      // 分栏模式：滚轮直接滚动通道列表（用户要求——不在波形区时滚轮用于浏览通道）
      if (geom.layout) {
        view.paneScroll = clamp(view.paneScroll + e.deltaY, 0, geom.layout.scrollMax);
        markDirty();
        return;
      }
      // 叠加模式无通道可滚：保留光标锚定缩放
      const pos = ovPointer(e);
      if (!pos) return;
      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      const oldWindow = view.windowMs;
      const newWindow = Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, oldWindow * factor));
      // 以光标处时刻为锚缩放
      const anchoredRight = pos.t + (currentT1() - pos.t) * (newWindow / oldWindow);
      view.windowMs = newWindow;
      ovSetWindow(anchoredRight, newWindow);
      updateButtons();
      markDirty();
    },
    { passive: false }
  );

  // 光标离开绘图区：收起十字线、读数与悬停高亮
  canvas.addEventListener('pointerleave', () => {
    lastPointer = null;
    view.hoverT = null;
    setHover(null);
    hudEl.style.display = 'none';
    markDirty();
  });

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
          `<span class="wavep-chip-top"><i class="wavep-dot"></i><span class="wavep-chip-name"></span></span>` +
          `<span class="wavep-chip-bottom"><span class="wavep-chip-val"></span><span class="wavep-chip-delta"></span></span></span>`
      )
      .join('');
    legendChipCount = engine.channels.length;
    // 通道多时切回单行紧凑布局（两行卡片可读性更好，但会占双倍高度）
    legendEl.classList.toggle('dense', engine.channels.length > 12);
  };

  const updateLegend = () => {
    if (engine.channels.length !== legendChipCount) rebuildLegendStructure();
    if (legendChipCount === 0) return;
    const palette = buildColors().palette;
    const va = view.cursorA !== null ? engine.nearestIndex(view.cursorA) : -1;
    const vb = view.cursorB !== null ? engine.nearestIndex(view.cursorB) : -1;
    // 有差值时整排预留差值列：数值列不会因某些通道有 Δ、另一些没有而左右跳动
    const hasDelta = view.cursorA !== null && view.cursorB !== null;
    legendEl.classList.toggle('has-delta', hasDelta);
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
      // Δ 只放数值（宽度固定，保证数值列对齐）；通道名提示里给完整说明
      const deltaEl = chip.querySelector('.wavep-chip-delta') as HTMLElement;
      deltaEl.textContent = delta;
      deltaEl.title = delta ? `游标差值 Δ ${delta}` : '';
    }
  };

  // 悬停通道：高亮该通道曲线、压暗其余（用事件委托，chip 结构重建后依然生效）
  const setHover = (index: number | null) => {
    if (view.hoverCh === index) return;
    view.hoverCh = index;
    legendEl.classList.toggle('hovering', index !== null);
    for (const chip of legendEl.querySelectorAll('.wavep-chip')) {
      chip.classList.toggle('hot', index !== null && Number((chip as HTMLElement).dataset.index) === index);
    }
    markDirty();
  };
  legendEl.addEventListener('pointerover', (e) => {
    const chip = (e.target as HTMLElement).closest('.wavep-chip') as HTMLElement | null;
    if (chip) setHover(Number(chip.dataset.index));
  });
  legendEl.addEventListener('pointerout', (e) => {
    const chip = (e.target as HTMLElement).closest('.wavep-chip') as HTMLElement | null;
    if (!chip) return;
    const to = (e as PointerEvent).relatedTarget as HTMLElement | null;
    if (to && chip.contains(to)) return;
    setHover(null);
  });
  legendEl.addEventListener('pointerleave', () => setHover(null));

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
    const total = engine.channels.length;
    const shown = engine.visible.reduce((n, v) => n + (v === false ? 0 : 1), 0);
    // 两个游标都在时，通道右侧的蓝色小数是“A→B 的差值”，在状态栏点明，避免看不出含义
    const deltaHint = view.cursorA !== null && view.cursorB !== null ? ' · 蓝色数字 = 游标 A→B 差值' : '';
    statsEl.textContent = `帧率 ${fps}/s · 帧 ${s.frames} · 丢帧 ${s.drops} · 解析错误 ${s.errors} · 字节 ${s.bytes} · 通道 ${total}${shown !== total ? `（显示 ${shown}）` : ''}${deltaHint}`;
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
      ovStripAt = 0; // 总览条缩影按新主题色立即重算
      void t;
      // 调色弹层按打开时的主题着色，主题切换瞬间重挂新主题样式
      if (paletteOpenIndex >= 0 && paletteCleanup) {
        const idx = paletteOpenIndex;
        const anchor = document.querySelector(`.wavep-chip[data-index="${idx}"] .wavep-dot`) as HTMLElement | null;
        closePalette();
        if (anchor) openPalette(idx, anchor);
      }
      markDirty();
    })
  );

  // ---------- 总览条（画布外常显）：缩影离屏缓存 + 每帧视窗矩形 ----------
  // 缩影抽稀按节流重算（数据流时全量重算会把帧预算吃光），视窗矩形每帧画保证拖动跟手
  const ovCache = document.createElement('canvas');
  let ovStripAt = 0; // 上次缩影重算时刻（ms）
  const renderOverview = () => {
    const now = performance.now();
    const g = ovCanvas.getContext('2d');
    if (!g) return;
    if (!ovRange || now - ovStripAt >= 200) {
      ovStripAt = now;
      ovRange = drawOverviewStrip(ovCache, ovCanvas.clientWidth, ovCanvas.clientHeight, engine, buildColors());
    }
    const cssW = ovCanvas.clientWidth;
    const cssH = ovCanvas.clientHeight;
    const zoom = Number(document.documentElement.style.zoom) || 1;
    const dpr = (window.devicePixelRatio || 1) * zoom;
    const W = Math.round(cssW * dpr);
    const H = Math.round(cssH * dpr);
    if (ovCanvas.width !== W || ovCanvas.height !== H) {
      ovCanvas.width = W;
      ovCanvas.height = H;
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);
    if (ovRange && ovCache.width > 0) g.drawImage(ovCache, 0, 0, cssW, cssH);
    if (ovRange) drawOverviewWindow(g, cssW, cssH, ovRange.fullT0, ovRange.fullT1, engine, view, buildColors());
  };

  const draw = () => {
    const theme = ctx.theme();
    if (theme !== lastTheme) {
      lastTheme = theme;
      viewDirty = true;
      ovStripAt = 0; // 主题色变化：缩影立即重算
    }
    if (canvas.clientWidth !== lastCanvasW) {
      lastCanvasW = canvas.clientWidth;
      viewDirty = true;
    }
    if (engine.version !== lastDrawnVersion || viewDirty) {
      lastDrawnVersion = engine.version;
      viewDirty = false;
      geom = drawWave(canvas, engine, view, buildColors());
      renderOverview(); // 总览条常显
      syncVScroll();
    }
  };

  const loop = (now: number) => {
    draw();
    if (now - fpsMark >= 1000) {
      // 清空会重置 engine.stats.frames：此时差值可能为负，帧率不能显示成负数
      fps = Math.max(0, engine.stats.frames - fpsFrames);
      fpsFrames = engine.stats.frames;
      fpsMark = now;
    }
    if (now - uiMark >= 200) {
      uiMark = now;
      updateLegend();
      renderStatus();
      // 面板是低频刷新：跟随 200ms 节拍重算，避免每帧全量统计
      if (measureOpen) renderMeasure();
      if (mathOpen) renderMath();
      if (view.hoverT !== null) updateHud();
    }
    rafId = requestAnimationFrame(loop);
  };

  // ---------- 设置持久化 ----------
  const restore = () => {
    try {
      const saved = ctx.storage.get<{ overlay?: boolean; windowMs?: number; style?: string; colors?: Record<string, string> } | null>(
        'wave-view',
        null
      );
      if (!saved) return;
      if (typeof saved.overlay === 'boolean') view.overlay = saved.overlay;
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
      // 持久化恢复后同步样式按钮文案（否则首屏显示「曲线」而实际是点/峰谷）
      btnStyle.textContent = STYLE_LABEL[view.style] ?? '曲线';
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
      ctx.storage.set('wave-view', { overlay: view.overlay, windowMs: view.windowMs, style: view.style, colors: { ...colorOverrides } });
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
