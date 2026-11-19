var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// plugins/wave/src/nnwave.ts
var STX0 = 170;
var STX1 = 85;
var MAX_CHANNELS = 64;
var MAX_BUFFER = 1 << 20;
var crc8 = (data, start, end) => {
  let crc = 0;
  for (let i = start; i < end; i++) {
    crc ^= data[i];
    for (let b = 0; b < 8; b++) crc = crc & 128 ? (crc << 1 ^ 7) & 255 : crc << 1 & 255;
  }
  return crc;
};
var createNnWaveParser = () => {
  let buf = new Uint8Array(0);
  const parser = {
    onMeta: void 0,
    feed(bytes, t) {
      const merged = new Uint8Array(buf.length + bytes.length);
      merged.set(buf);
      merged.set(bytes, buf.length);
      buf = merged;
      const frames = [];
      const dv = new DataView(buf.buffer, buf.byteOffset);
      const decoder = new TextDecoder();
      let i = 0;
      while (i + 6 <= buf.length) {
        if (buf[i] !== STX0 || buf[i + 1] !== STX1) {
          i++;
          continue;
        }
        const type = buf[i + 2];
        const n = buf[i + 3];
        if (n < 1 || n > MAX_CHANNELS) {
          i++;
          continue;
        }
        const frameLen = 6 + 4 * n;
        if (i + frameLen > buf.length) break;
        if (crc8(buf, i + 2, i + 5 + 4 * n) !== buf[i + 5 + 4 * n]) {
          i++;
          continue;
        }
        if (type === 1) {
          const channels = new Array(n);
          for (let c = 0; c < n; c++) channels[c] = dv.getFloat32(i + 5 + c * 4, true);
          frames.push({ t, channels, seq: buf[i + 4] });
        } else if (type === 2) {
          const names = [];
          let p = i + 5;
          const end = i + 5 + 4 * n;
          while (p < end) {
            const len = buf[p++];
            if (len === 0 || p + len > end) break;
            names.push(decoder.decode(buf.subarray(p, p + len)));
            p += len;
          }
          parser.onMeta?.(names);
        }
        i += frameLen;
      }
      buf = i > 0 ? buf.slice(i) : buf;
      if (buf.length > MAX_BUFFER) buf = buf.slice(buf.length >> 1);
      return frames;
    },
    reset() {
      buf = new Uint8Array(0);
    }
  };
  return parser;
};

// plugins/wave/src/engine.ts
var RING_CAPACITY = 2e6;
var Ring = class {
  constructor(capacity, ctor) {
    this.capacity = capacity;
    __publicField(this, "data");
    __publicField(this, "head", 0);
    __publicField(this, "count", 0);
    this.data = new ctor(capacity);
  }
  push(v) {
    this.data[(this.head + this.count) % this.capacity] = v;
    if (this.count < this.capacity) this.count++;
    else this.head = (this.head + 1) % this.capacity;
  }
  at(i) {
    return this.data[(this.head + i) % this.capacity];
  }
  clear() {
    this.head = 0;
    this.count = 0;
  }
};
var WaveEngine = class {
  constructor() {
    __publicField(this, "capacity", RING_CAPACITY);
    __publicField(this, "t", new Ring(RING_CAPACITY, Float64Array));
    __publicField(this, "channels", []);
    __publicField(this, "names", []);
    __publicField(this, "visible", []);
    __publicField(this, "attachedSessionId", "");
    __publicField(this, "stats", { frames: 0, bytes: 0, drops: 0, errors: 0 });
    __publicField(this, "version", 0);
    __publicField(this, "parser", null);
    __publicField(this, "protocolId", "");
    __publicField(this, "lastSeq", -1);
  }
  // 选择协议并重置解析状态（切换协议时调用）
  setProtocol(def) {
    if (this.protocolId === def.id) return;
    this.protocolId = def.id;
    const parser = def.createParser();
    if ("onMeta" in parser) {
      parser.onMeta = (names) => {
        if (names.length === 0) return;
        this.names = names.slice();
        this.version++;
      };
    }
    this.parser = parser;
  }
  // 绑定数据源会话；切换会话清空缓冲重新开始
  attach(sessionId) {
    if (this.attachedSessionId === sessionId) return;
    this.attachedSessionId = sessionId;
    this.clear();
  }
  clear() {
    this.t.clear();
    this.channels.forEach((c) => c.clear());
    this.stats = { frames: 0, bytes: 0, drops: 0, errors: 0 };
    this.lastSeq = -1;
    this.version++;
  }
  // 通道数增长：新通道继承元数据名或默认 CHn
  ensureChannels(n) {
    while (this.channels.length < n) {
      this.channels.push(new Ring(this.capacity, Float32Array));
      this.visible.push(true);
      if (!this.names[this.channels.length - 1]) this.names[this.channels.length - 1] = `CH${this.channels.length}`;
    }
  }
  handleRaw(e) {
    if (!this.attachedSessionId || e.sessionId !== this.attachedSessionId || !this.parser) return;
    this.stats.bytes += e.bytes.length;
    let frames;
    try {
      frames = this.parser.feed(e.bytes, e.t);
    } catch {
      this.stats.errors++;
      return;
    }
    for (const f of frames) this.ingest(f);
  }
  ingest(f) {
    this.ensureChannels(f.channels.length);
    for (let c = 0; c < f.channels.length; c++) this.channels[c].push(f.channels[c]);
    let t = f.t;
    if (this.t.count > 0 && t <= this.t.at(this.t.count - 1)) t = this.t.at(this.t.count - 1) + 1;
    this.t.push(t);
    if (f.seq !== void 0) {
      if (this.lastSeq >= 0) this.stats.drops += f.seq - this.lastSeq - 1 & 255;
      this.lastSeq = f.seq;
    }
    this.stats.frames++;
    this.version++;
  }
  get lastT() {
    return this.t.count > 0 ? this.t.at(this.t.count - 1) : 0;
  }
  // 在逻辑序上二分查找第一个 t >= time 的下标（缓冲按 push 序即时间升序）
  lowerBound(time) {
    let lo = 0;
    let hi = this.t.count;
    while (lo < hi) {
      const mid = lo + hi >> 1;
      if (this.t.at(mid) < time) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  // 离指定时间最近的样本下标（游标取值用）
  nearestIndex(time) {
    const count = this.t.count;
    if (count === 0) return -1;
    const i = this.lowerBound(time);
    if (i === 0) return 0;
    if (i === count) return count - 1;
    return Math.abs(this.t.at(i) - time) < Math.abs(time - this.t.at(i - 1)) ? i : i - 1;
  }
};

// plugins/wave/src/renderer.ts
var defaultViewState = () => ({
  follow: true,
  rightT: 0,
  windowMs: 1e4,
  frozen: false,
  overlay: false,
  style: "line",
  yRanges: /* @__PURE__ */ new Map(),
  cursorA: null,
  cursorB: null,
  paneScroll: 0,
  hoverCh: null,
  hoverT: null
});
var MIN_WINDOW = 100;
var MAX_WINDOW = 30 * 6e4;
var AXIS_WIDTH = 64;
var TIME_AXIS_H = 22;
var MIN_PANE_H = 56;
var lastYRanges = /* @__PURE__ */ new Map();
var clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
var niceStep = (range, targetLines) => {
  if (range <= 0 || !isFinite(range)) return 1;
  const raw = range / Math.max(1, targetLines);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) {
    if (raw <= m * mag) return m * mag;
  }
  return 10 * mag;
};
var fmtValue = (v) => {
  if (!isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e6 || a > 0 && a < 1e-3) return v.toExponential(2);
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(3);
  return v.toFixed(4);
};
var fmtDuration = (ms) => {
  const a = Math.abs(ms);
  if (a >= 6e4) return `${(ms / 6e4).toFixed(2)} min`;
  if (a >= 1e3) return `${(ms / 1e3).toFixed(2)} s`;
  return `${ms.toFixed(0)} ms`;
};
var rr = (g, x, y, w, h, r) => {
  g.beginPath();
  if (typeof g.roundRect === "function") g.roundRect(x, y, w, h, r);
  else g.rect(x, y, w, h);
};
var ovMins = null;
var ovMaxs = null;
var ovCap = 0;
var ensureOverviewBuf = (cols) => {
  if (ovCap < cols) {
    ovCap = Math.ceil(cols * 1.5);
    ovMins = new Float32Array(ovCap);
    ovMaxs = new Float32Array(ovCap);
  }
};
var drawWave = (canvas, engine, view, colors) => {
  const emptyGeom = {
    t0: 0,
    t1: 0,
    plotLeft: 0,
    plotWidth: 0,
    panes: [],
    viewport: { top: 0, height: 0 },
    layout: null
  };
  const zoom = Number(document.documentElement.style.zoom) || 1;
  const dpr = (window.devicePixelRatio || 1) * zoom;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  const g = canvas.getContext("2d");
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
  const plotBottom = cssH - TIME_AXIS_H;
  const plotW = plotRight - plotLeft;
  const viewportH = plotBottom - plotTop;
  const t1 = view.frozen ? view.rightT : view.follow ? engine.lastT : view.rightT;
  const t0 = t1 - view.windowMs;
  const visIdx = [];
  engine.channels.forEach((_, i) => {
    if (engine.visible[i]) visIdx.push(i);
  });
  const geom = {
    t0,
    t1,
    plotLeft,
    plotWidth: plotW,
    panes: [],
    viewport: { top: plotTop, height: viewportH },
    layout: null
  };
  const i0 = engine.lowerBound(t0);
  const i1 = engine.t.count;
  const fullT0 = engine.t.at(0);
  const axisStep = niceStep(t1 - t0, 8);
  if (i1 - i0 < 2 || visIdx.length === 0) {
    drawTimeGrid(g, fullT0, t0, t1, axisStep, plotLeft, plotW, plotTop, plotBottom, colors);
    drawEmpty(g, plotLeft, plotTop, plotW, viewportH, colors);
    drawTimeAxis(g, fullT0, t0, t1, axisStep, plotLeft, plotW, plotBottom, colors);
    return geom;
  }
  let paneH;
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
  const panes = view.overlay ? [{ ch: visIdx[0], top: plotTop, height: paneH }] : visIdx.map((ch, i) => ({ ch, top: plotTop - scrollOffset + paneH * i, height: paneH }));
  geom.panes = view.overlay ? [] : panes;
  if (scrollMax > 0) {
    const thumbH = Math.max(24, viewportH / contentHeight * viewportH);
    geom.layout = { trackH: viewportH, thumbH, scrollMax };
  }
  const px = (t) => plotLeft + (t - t0) / view.windowMs * plotW;
  drawTimeGrid(g, fullT0, t0, t1, axisStep, plotLeft, plotW, plotTop, plotBottom, colors);
  for (const pane of panes) {
    if (pane.top + pane.height <= plotTop || pane.top >= plotBottom) continue;
    const auto = /* @__PURE__ */ new Map();
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
    const yRangeOf = (ch) => {
      const manual = view.yRanges.get(ch);
      if (manual) {
        lastYRanges.set(ch, manual);
        return manual;
      }
      const col = auto.get(ch);
      let range;
      if (!col || !isFinite(col.min) || !isFinite(col.max)) range = { min: -1, max: 1 };
      else if (col.min === col.max) range = { min: col.min - 1, max: col.max + 1 };
      else {
        const pad = (col.max - col.min) * 0.1;
        range = { min: col.min - pad, max: col.max + pad };
      }
      lastYRanges.set(ch, range);
      return range;
    };
    let paneRange = null;
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
    g.save();
    g.beginPath();
    g.rect(plotLeft, plotTop, plotW, viewportH);
    g.clip();
    const cols = Math.max(1, Math.floor(plotW));
    if (view.hoverCh !== null && !view.overlay && pane.ch === view.hoverCh) {
      const hc = colors.palette[pane.ch % colors.palette.length];
      const top = Math.max(plotTop, pane.top);
      const h = Math.max(0, Math.min(pane.height, plotBottom - pane.top) - (top - pane.top));
      g.save();
      g.globalAlpha = 0.08;
      g.fillStyle = hc;
      g.fillRect(plotLeft, top, plotW, h);
      g.globalAlpha = 0.9;
      g.fillRect(plotLeft, top + 2, 3, Math.max(0, h - 4));
      g.restore();
    }
    const hover = view.hoverCh;
    const drawOrder = hover !== null && channels.includes(hover) ? [...channels.filter((c) => c !== hover), hover] : channels;
    for (const ch of drawOrder) {
      const dimmed = hover !== null && ch !== hover;
      const emphasized = hover !== null && ch === hover;
      g.globalAlpha = dimmed ? 0.22 : 1;
      const range = view.overlay && paneRange ? paneRange : yRangeOf(ch);
      const yOf = (v) => pane.top + pane.height - (v - range.min) / (range.max - range.min) * pane.height;
      const color = colors.palette[ch % colors.palette.length];
      g.lineJoin = "round";
      g.lineCap = "round";
      if (view.style === "bars") {
        const visible = i1 - i0;
        const stride = visible > 6e5 ? Math.ceil(visible / 6e5) : 1;
        const mins = new Float32Array(cols).fill(Infinity);
        const maxs = new Float32Array(cols).fill(-Infinity);
        for (let i = i0; i < i1; i += stride) {
          const t = engine.t.at(i);
          if (t < t0 || t > t1) continue;
          const x = (t - t0) / view.windowMs * cols;
          const col = clamp(Math.floor(x), 0, cols - 1);
          const v = engine.channels[ch].at(i);
          if (v < mins[col]) mins[col] = v;
          if (v > maxs[col]) maxs[col] = v;
        }
        g.beginPath();
        g.strokeStyle = color;
        g.lineWidth = emphasized ? 2 : 1.25;
        let started = false;
        let lastX = -1;
        for (let col = 0; col < cols; col++) {
          if (mins[col] > maxs[col]) continue;
          const x = plotLeft + col + 0.5;
          const yMin = yOf(maxs[col]);
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
      } else if (view.style === "dots") {
        g.fillStyle = color;
        const total = i1 - i0;
        const dotBudget = Math.max(300, Math.floor(8e3 / Math.max(1, channels.length)));
        const stride = total > dotBudget ? Math.ceil(total / dotBudget) : 1;
        for (let i = i0; i < i1; i += stride) {
          const t = engine.t.at(i);
          if (t < t0 || t > t1) continue;
          const x = plotLeft + (t - t0) / view.windowMs * plotW;
          const y = yOf(engine.channels[ch].at(i));
          const half = emphasized ? 2 : 1.5;
          g.fillRect(x - half, y - half, half * 2, half * 2);
        }
      } else {
        g.strokeStyle = color;
        g.lineWidth = emphasized ? 2.6 : 1.6;
        const total = i1 - i0;
        const lineBudget = Math.max(300, Math.floor(2e4 / Math.max(1, channels.length)));
        const stride = total > lineBudget ? Math.ceil(total / lineBudget) : 1;
        const pts = [];
        for (let i = i0; i < i1; i += stride) {
          const t = engine.t.at(i);
          if (t < t0 || t > t1) continue;
          const x = plotLeft + (t - t0) / view.windowMs * plotW;
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
    g.globalAlpha = 1;
    if (!view.overlay) {
      g.fillStyle = colors.text;
      g.font = "600 11px sans-serif";
      g.textAlign = "left";
      g.textBaseline = "top";
      g.fillText(engine.names[pane.ch] ?? `CH${pane.ch + 1}`, plotLeft + 8, pane.top + 5);
    }
    g.restore();
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
      g.font = "10px Consolas, monospace";
      g.textAlign = "left";
      g.textBaseline = "middle";
      for (let v = Math.ceil(range.min / step) * step; v <= range.max; v += step) {
        const y = pane.top + pane.height - (v - range.min) / (range.max - range.min) * pane.height;
        if (y < pane.top + 8 || y > pane.top + pane.height - 4) continue;
        if (y < plotTop || y > plotBottom) continue;
        g.fillText(fmtValue(v), plotRight + 6, y);
        g.strokeStyle = colors.grid;
        g.beginPath();
        g.moveTo(plotLeft, Math.round(y) + 0.5);
        g.lineTo(plotRight, Math.round(y) + 0.5);
        g.stroke();
      }
    }
  }
  drawTimeAxis(g, fullT0, t0, t1, axisStep, plotLeft, plotW, plotBottom, colors);
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
  if (view.hoverT !== null && view.hoverT >= t0 && view.hoverT <= t1) {
    const x = px(view.hoverT);
    g.save();
    g.globalAlpha = 0.5;
    g.strokeStyle = colors.textDim;
    g.setLineDash([2, 3]);
    g.beginPath();
    g.moveTo(x + 0.5, plotTop);
    g.lineTo(x + 0.5, plotBottom);
    g.stroke();
    g.restore();
  }
  if (view.cursorA !== null && view.cursorB !== null) {
    const dt = Math.abs(view.cursorB - view.cursorA);
    if (dt > 0) {
      const hz = 1e3 / dt;
      const hzText = hz >= 100 ? hz.toFixed(0) : hz >= 1 ? hz.toFixed(1) : hz.toFixed(2);
      const label = `Δt ${fmtDuration(dt)} · ${hzText} Hz`;
      g.save();
      g.font = "600 11px Consolas, monospace";
      g.textAlign = "left";
      g.textBaseline = "middle";
      const w = g.measureText(label).width + 14;
      g.globalAlpha = 0.92;
      g.fillStyle = colors.panel;
      g.fillRect(plotLeft + 4, plotTop + 4, w, 18);
      g.globalAlpha = 1;
      g.strokeStyle = colors.accent;
      g.strokeRect(plotLeft + 4.5, plotTop + 4.5, w - 1, 17);
      g.fillStyle = colors.accent;
      g.fillText(label, plotLeft + 11, plotTop + 13);
      g.restore();
    }
  }
  return geom;
};
var drawOverviewStrip = (canvas, cssW, cssH, engine, colors) => {
  const zoom = Number(document.documentElement.style.zoom) || 1;
  const dpr = (window.devicePixelRatio || 1) * zoom;
  const g = canvas.getContext("2d");
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
  const visIdx = [];
  engine.channels.forEach((_, i) => {
    if (engine.visible[i]) visIdx.push(i);
  });
  const i0 = engine.lowerBound(fullT0);
  const i1 = engine.t.count;
  const cols = Math.max(1, Math.floor(cssW));
  ensureOverviewBuf(cols);
  const mins = ovMins;
  const maxs = ovMaxs;
  const visible = i1 - i0;
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
      const col = clamp(Math.floor((t - fullT0) / (fullT1 - fullT0) * cols), 0, cols - 1);
      const v = engine.channels[ch].at(i);
      if (v < mins[col]) mins[col] = v;
      if (v > maxs[col]) maxs[col] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!isFinite(lo) || !isFinite(hi) || hi <= lo) continue;
    const yOf = (v) => innerY + innerH - (v - lo) / (hi - lo) * innerH;
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
var drawOverviewWindow = (g, cssW, cssH, fullT0, fullT1, engine, view, colors) => {
  if (fullT1 <= fullT0) return;
  const rightT = view.frozen || !view.follow ? view.rightT : engine.lastT;
  const wx0 = (rightT - view.windowMs - fullT0) / (fullT1 - fullT0) * cssW;
  const wx1 = (rightT - fullT0) / (fullT1 - fullT0) * cssW;
  const clampedX0 = clamp(Math.min(wx0, wx1), 0, cssW);
  const clampedX1 = clamp(Math.max(wx0, wx1), 0, cssW);
  g.fillStyle = colors.accent;
  g.globalAlpha = 0.14;
  g.fillRect(clampedX0, 1, clampedX1 - clampedX0, cssH - 2);
  g.globalAlpha = 1;
  g.strokeStyle = colors.accent;
  g.strokeRect(clampedX0 + 0.5, 1.5, Math.max(1, clampedX1 - clampedX0 - 1), cssH - 3);
};
var drawEmpty = (g, x, y, w, h, colors) => {
  g.fillStyle = colors.textDim;
  g.font = "12px sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("暂无数据 — 在上方选择已连接的会话开始采集", x + w / 2, y + h / 2);
};
var fmtAxisLabel = (ms, step) => {
  if (step >= 6e4) return fmtDuration(ms);
  if (step >= 1e3) return `${(ms / 1e3).toFixed(2)} s`;
  const total = ms / 1e3;
  const m = Math.floor(total / 60);
  const rest = total - m * 60;
  return m > 0 ? `${m}:${rest.toFixed(3).padStart(6, "0")}` : `${rest.toFixed(3)} s`;
};
var drawTimeGrid = (g, anchorT, t0, t1, step, plotLeft, plotW, plotTop, plotBottom, colors) => {
  const mStep = step / 5;
  const n0 = Math.ceil((t0 - anchorT) / mStep);
  const n1 = Math.floor((t1 - anchorT) / mStep);
  g.lineWidth = 1;
  for (let n = n0; n <= n1; n++) {
    const t = anchorT + n * mStep;
    const x = plotLeft + (t - t0) / (t1 - t0) * plotW;
    if (x < plotLeft - 0.5 || x > plotLeft + plotW + 0.5) continue;
    const major = (n % 5 + 5) % 5 === 0;
    g.globalAlpha = major ? 0.7 : 0.3;
    g.strokeStyle = colors.grid;
    g.beginPath();
    g.moveTo(Math.round(x) + 0.5, plotTop);
    g.lineTo(Math.round(x) + 0.5, plotBottom);
    g.stroke();
  }
  g.globalAlpha = 1;
};
var drawTimeAxis = (g, anchorT, t0, t1, step, plotLeft, plotW, plotBottom, colors) => {
  g.fillStyle = colors.textDim;
  g.font = "10px Consolas, monospace";
  g.textAlign = "center";
  g.textBaseline = "top";
  g.strokeStyle = colors.grid;
  const firstGrid = anchorT + Math.ceil((t0 - anchorT) / step) * step;
  for (let t = firstGrid; t <= t1; t += step) {
    const x = plotLeft + (t - t0) / (t1 - t0) * plotW;
    if (x < plotLeft || x > plotLeft + plotW) continue;
    g.fillText(fmtAxisLabel(t - anchorT, step), x, plotBottom + 6);
    g.beginPath();
    g.moveTo(Math.round(x) + 0.5, plotBottom);
    g.lineTo(Math.round(x) + 0.5, plotBottom + 4);
    g.stroke();
  }
};

// plugins/wave/src/firmware.ts
var FIRMWARE_FILES = [
  {
    name: "nnwave.h",
    text: `/*
 * NN-Wave v1 —— 轻量二进制波形协议（发送端）
 * 本文件为纯 C99 代码，C 与 C++ 工程均可直接包含（声明已用 extern "C" 包裹）。
 * 帧格式: [AA 55][type][N][seq][float32×N 小端][CRC8]
 *   type 0x01 = 数据帧（N 个 float32）
 *   type 0x02 = 通道名元数据帧（payload 为若干 [len][utf8]，补 0x00 到 4N 字节）
 *   CRC8 多项式 0x07，初值 0x00，覆盖 type..data
 * 通道数上限：N 为 1 字节，协议/固件/上位机统一上限 64（NNWAVE_MAX_CHANNELS）
 * 上位机：NNSerialTool 波形插件（协议选 NN-Wave）
 */
#ifndef NNWAVE_H
#define NNWAVE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* 通道数硬上限：帧内 N 字段 1 字节 + 上位机解析器同值校验，两端一致 */
#define NNWAVE_MAX_CHANNELS 64

typedef struct {
    int (*write)(const uint8_t *data, size_t len); /* 阻塞发送回调，返回 0 表示成功 */
    uint8_t seq;                                   /* 帧序号，自动递增（上位机据此统计丢帧） */
} nnwave_t;

/* 初始化：注入发送回调（如 HAL_UART_Transmit 的包装） */
int nnwave_init(nnwave_t *h, int (*write)(const uint8_t *data, size_t len));

/* 发送一帧数据：channels[0..count-1] 对应波形 CH1..CHn（count ≤ NNWAVE_MAX_CHANNELS） */
int nnwave_send(nnwave_t *h, const float *channels, uint8_t count);

/* （可选）发送通道名，波形图例将显示这些名字；上电时发一次即可 */
int nnwave_send_names(nnwave_t *h, const char *const *names, uint8_t count);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* NNWAVE_H */
`
  },
  {
    name: "nnwave.c",
    text: `#include "nnwave.h"

#include <string.h>

static uint8_t nnwave_crc8(const uint8_t *d, size_t n) {
    uint8_t crc = 0;
    while (n--) {
        crc ^= *d++;
        for (int i = 0; i < 8; i++) {
            crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x07) : (uint8_t)(crc << 1);
        }
    }
    return crc;
}

/* 组帧并发送；payload 固定 4*count 字节 */
static int nnwave_frame(nnwave_t *h, uint8_t type, uint8_t count, const uint8_t *payload) {
    uint8_t buf[6 + 4 * NNWAVE_MAX_CHANNELS];
    size_t len = 6 + 4 * (size_t)count;
    if (!h || !h->write || count == 0 || count > NNWAVE_MAX_CHANNELS) return -1;
    buf[0] = 0xAA;
    buf[1] = 0x55;
    buf[2] = type;
    buf[3] = count;
    buf[4] = h->seq++;
    memcpy(buf + 5, payload, 4 * (size_t)count);
    buf[len - 1] = nnwave_crc8(buf + 2, len - 3);
    return h->write(buf, len);
}

int nnwave_init(nnwave_t *h, int (*write)(const uint8_t *data, size_t len)) {
    if (!h || !write) return -1;
    h->write = write;
    h->seq = 0;
    return 0;
}

int nnwave_send(nnwave_t *h, const float *channels, uint8_t count) {
    if (!h || !channels) return -1;
    /* float32 小端 = 常见 MCU（ARM/x86/RISC-V 小端核）的内存布局，直接透传 */
    return nnwave_frame(h, 0x01, count, (const uint8_t *)channels);
}

int nnwave_send_names(nnwave_t *h, const char *const *names, uint8_t count) {
    uint8_t payload[4 * NNWAVE_MAX_CHANNELS];
    size_t p = 0;
    if (!h || !names) return -1;
    memset(payload, 0, sizeof(payload));
    for (uint8_t i = 0; i < count; i++) {
        const char *s = names[i] ? names[i] : "";
        size_t n = strlen(s);
        if (n > 62) n = 62; /* 单名最长 62 字节，留 1 字节长度位 */
        if (p + 1 + n > 4 * (size_t)count) break;
        payload[p++] = (uint8_t)n;
        memcpy(payload + p, s, n);
        p += n;
    }
    return nnwave_frame(h, 0x02, count, payload);
}
`
  },
  {
    name: "README.md",
    text: `# NN-Wave 固件接入说明

## 1. 加入工程

把 \`nnwave.c\` / \`nnwave.h\` 加入你的固件工程；

## 2. 实现发送回调（以 STM32 HAL 为例）

\`\`\`c
static int uart_write(const uint8_t *d, size_t n) {
    return HAL_UART_Transmit(&huart1, (uint8_t *)d, (uint16_t)n, 20) == HAL_OK ? 0 : -1;
}
\`\`\`

## 3. 初始化并周期性发送

\`\`\`c
nnwave_t nnw;
float ch[3] = {0};

nnwave_init(&nnw, uart_write);
const char *names[3] = {"温度", "湿度", "电流"};
nnwave_send_names(&nnw, names, 3);   /* 可选：上电发一次通道名 */

while (1) {
    ch[0] = read_temp();  ch[1] = read_humi();  ch[2] = read_current();
    nnwave_send(&nnw, ch, 3);
    HAL_Delay(10);       /* 100 Hz 刷新 */
}
\`\`\`

## 4. 上位机

NNSerialTool 波形插件 → 数据源选对应会话。

## 通道数上限

**最多 64 通道**（协议 N 字段为 1 字节，固件 \`NNWAVE_MAX_CHANNELS\` 与上位机解析器统一按 64 校验，
超出即整帧丢弃）。通道数在 \`nnwave_send\` 的 \`count\` 参数里逐帧指定，可动态增减；
上位机按本帧 N 值自动扩展图例。每通道在引擎里为 200 万点环形缓冲。

注意：通道名帧 payload 容量 = 4×N 字节，每个名字占 len+1 字节（C/Rust 模板一致）；
中文名每字 3 字节，N 较小时请用短名（如 "T1"）。

## 带宽参考

帧长 = 6 + 4×通道数 字节。
8 通道 @100Hz ≈ 3.3 KB/s，9600 波特率即可跑；1 通道 @1kHz ≈ 10 KB/s；
64 通道 @100Hz ≈ 26.2 KB/s，建议 115200 及以上波特率。
大端核（极少见）需在 \`nnwave_send\` 里逐字节装填 float。`
  }
];

// plugins/wave/src/nnprintf-export.ts
var NNPRINTF_FILES = [
  {
    name: "NNPrintf.h",
    text: `/*---------------------------------------------------------------------------
 * NNPrintf.h —— 嵌入式分级日志库（单头文件，纯 C99，C/C++ 工程均可直接包含）
 *
 * 特性
 *   1. 六级日志：TRACE / DEBUG / INFO / WARNING / ERROR / FATAL
 *   2. 双层等级开关：
 *        编译期  NNPRINTF_COMPILE_LEVEL —— 低于它的调用整体剔除（零代码零开销）
 *        运行期  nnprintf_set_level()  —— 不重新编译即可收紧输出
 *   3. 输出钩子 NNPRINTF_OUTPUT(line)：整行交给用户自填的发送函数，默认空
 *   4. 行前缀 [标签]--（与本人 reprintf.h 历史格式一致），上位机 NNSerialTool
 *      会按 [INFO]/[WARNING]/[ERROR] 等标签自动着色
 *   5. 可选：毫秒时间戳 / 文件行号 / ANSI 终端颜色（均默认关闭）
 *
 * 快速上手
 *   #define NNPRINTF_OUTPUT(line)  uart_send_line(line)   // 包含前定义，或直接改本文件
 *   #define NNPRINTF_GET_MS()      HAL_GetTick()          // 可选：启用时间戳
 *   #include "NNPrintf.h"
 *   NNPrintf(INFO, "温度 %.1f", t);      // [INFO]--温度 25.0
 *   NNPrintf(ERROR, "code=%d", e);       // [ERROR]--code=-1
 *   NNPrintf_INFO(...); NNPrintf_DEBUG(...); NNPrintf_WARNING(...); NNPrintf_ERROR(...); NNPrintf_FATAL(...); NNPrintf_TRACE(...);
 *
 *   ※ 需要输出 %f 时：
 *       Keil 请勾选 Options → Target → Use MicroLib 并确认 C 库支持 %f；
 *       不少精简 C 库默认把 %f 打成空，固件侧先用整数/定点值（_100x）最稳。
 *
 * 等级开关用法
 *   #define NNPRINTF_COMPILE_LEVEL NNPRINTF_LVL_INFO   // 包含前定义：INFO 及以上才编译
 *   nnprintf_set_level(NNPRINTF_LVL_ERROR);            // 运行期再收紧（仅当前编译单元）
 *---------------------------------------------------------------------------*/
#ifndef __NNPRINTF_H__
#define __NNPRINTF_H__

#include <stdarg.h>                                     //va_list / va_start
#include <stdint.h>                                     //uint8_t / uint32_t
#include <stdio.h>                                      //vsnprintf / snprintf

#ifdef __cplusplus
extern "C" {
#endif

/* ================= 用户配置区（包含前 #define 覆盖即可） ================= */

#ifndef NNPRINTF_COMPILE_LEVEL
#define NNPRINTF_COMPILE_LEVEL      NNPRINTF_LVL_TRACE  //编译期最高输出等级，默认全开
#endif

#ifndef NNPRINTF_OUTPUT
#define NNPRINTF_OUTPUT(line)       ((void)0)           /* ★用户自填：整行输出钩子，默认空 */
#endif

#ifndef NNPRINTF_LINE_SIZE
#define NNPRINTF_LINE_SIZE          256                 //单行组装缓冲（含前缀与行尾）
#endif

#ifndef NNPRINTF_EOL
#define NNPRINTF_EOL                "\\r\\n"              //行结束符（串口工具通用 CRLF）
#endif

#ifndef NNPRINTF_SEP
#define NNPRINTF_SEP                "--"                //标签后分隔符，[INFO]--xxx
#endif

/* #define NNPRINTF_ANSI_COLOR                        */ //启用 ANSI 颜色（仅 ANSI 终端有效）
/* #define NNPRINTF_WITH_LOCATION                     */ //前缀追加 [文件:行]
/* #define NNPRINTF_GET_MS()      HAL_GetTick()       */ //定义后自动带 [秒.毫秒] 时间戳

/* ============================ 等级常量 ============================ */
/* 数值必须从小到大：越严重越高，过滤只做 >= 比较一遍 */

#define NNPRINTF_LVL_TRACE          0                   //最细跟踪
#define NNPRINTF_LVL_DEBUG          1                   //调试
#define NNPRINTF_LVL_INFO           2                   //常规信息
#define NNPRINTF_LVL_WARN           3                   //告警
#define NNPRINTF_LVL_ERROR          4                   //错误
#define NNPRINTF_LVL_FATAL          5                   //致命
#define NNPRINTF_LVL_NONE           6                   //全关（运行期用）

/* 短等级名：NNPrintf(INFO, ...) 形态依赖它们；怕污染命名空间就在包含前
 * 定义 NNPRINTF_NO_SHORT_LEVELS，改用 NNPrintf_INFO(...) 便捷宏 */

#ifndef NNPRINTF_NO_SHORT_LEVELS
#define TRACE                       NNPRINTF_LVL_TRACE
#define DEBUG                       NNPRINTF_LVL_DEBUG
#define INFO                        NNPRINTF_LVL_INFO
#define WARNING                     NNPRINTF_LVL_WARN
#define ERROR                       NNPRINTF_LVL_ERROR
#define FATAL                       NNPRINTF_LVL_FATAL
#endif

/* ============================ 对外接口 ============================ */

/* 设置运行期输出下限（低于它的等级直接丢弃）；返回旧等级，便于临时切换后恢复。
 * 注意：单头文件实现，每个包含它的 .c 各有一份状态，跨编译单元不共享 */
static inline uint8_t nnprintf_set_level(uint8_t level);

/* ======================= 编译期等级分派 ======================= */
/* NNPrintf(INFO, ...) → NNPRINTF_SINK_INFO(...)：短名参与宏拼接，
 * 各 SINK 独立做编译期 #if——被剔除的调用连实参求值都不会发生。
 * __FILE__/__LINE__ 在宏层取（调用点）；函数体内取会变成头文件自己的位置 */

#if NNPRINTF_COMPILE_LEVEL <= NNPRINTF_LVL_TRACE
#define NNPRINTF_SINK_TRACE(...)    nnprintf_line(NNPRINTF_LVL_TRACE, __FILE__, __LINE__, __VA_ARGS__)
#else
#define NNPRINTF_SINK_TRACE(...)    ((void)0)
#endif

#if NNPRINTF_COMPILE_LEVEL <= NNPRINTF_LVL_DEBUG
#define NNPRINTF_SINK_DEBUG(...)    nnprintf_line(NNPRINTF_LVL_DEBUG, __FILE__, __LINE__, __VA_ARGS__)
#else
#define NNPRINTF_SINK_DEBUG(...)    ((void)0)
#endif

#if NNPRINTF_COMPILE_LEVEL <= NNPRINTF_LVL_INFO
#define NNPRINTF_SINK_INFO(...)     nnprintf_line(NNPRINTF_LVL_INFO, __FILE__, __LINE__, __VA_ARGS__)
#else
#define NNPRINTF_SINK_INFO(...)     ((void)0)
#endif

#if NNPRINTF_COMPILE_LEVEL <= NNPRINTF_LVL_WARN
#define NNPRINTF_SINK_WARNING(...)  nnprintf_line(NNPRINTF_LVL_WARN, __FILE__, __LINE__, __VA_ARGS__)
#else
#define NNPRINTF_SINK_WARNING(...)  ((void)0)
#endif

#if NNPRINTF_COMPILE_LEVEL <= NNPRINTF_LVL_ERROR
#define NNPRINTF_SINK_ERROR(...)    nnprintf_line(NNPRINTF_LVL_ERROR, __FILE__, __LINE__, __VA_ARGS__)
#else
#define NNPRINTF_SINK_ERROR(...)    ((void)0)
#endif

#if NNPRINTF_COMPILE_LEVEL <= NNPRINTF_LVL_FATAL
#define NNPRINTF_SINK_FATAL(...)    nnprintf_line(NNPRINTF_LVL_FATAL, __FILE__, __LINE__, __VA_ARGS__)
#else
#define NNPRINTF_SINK_FATAL(...)    ((void)0)
#endif

/* 核心入口：等级须传短名（INFO/DEBUG/...），实际是宏拼接分派 */
#define NNPrintf(lvl, ...)          NNPRINTF_SINK_##lvl(__VA_ARGS__)

/* 便捷宏：不想用短等级名时的等价写法 */
#define NNPrintf_TRACE(...)         NNPRINTF_SINK_TRACE(__VA_ARGS__)
#define NNPrintf_DEBUG(...)         NNPRINTF_SINK_DEBUG(__VA_ARGS__)
#define NNPrintf_INFO(...)          NNPRINTF_SINK_INFO(__VA_ARGS__)
#define NNPrintf_WARNING(...)       NNPRINTF_SINK_WARNING(__VA_ARGS__)
#define NNPrintf_ERROR(...)         NNPRINTF_SINK_ERROR(__VA_ARGS__)
#define NNPrintf_FATAL(...)         NNPRINTF_SINK_FATAL(__VA_ARGS__)

/* ============================ 实现 ============================ */

#if defined(__GNUC__) || defined(__clang__)
#define NNPRINTF_UNUSED             __attribute__((unused))
#else
#define NNPRINTF_UNUSED
#endif

static uint8_t nnprintf_level NNPRINTF_UNUSED = NNPRINTF_LVL_TRACE;  //运行期等级（每编译单元一份）

static inline uint8_t nnprintf_set_level(uint8_t level)
{
    uint8_t old = nnprintf_level;                       //备份旧等级
    nnprintf_level = level;                             //应用新等级
    return old;
}

/* 等级标签与 ANSI 颜色（下标 = 等级常量，运行期按数值索引——
 * 注意不能在这里用 ## 拼接：## 是预处理符，对函数的运行期形参无效） */
static const char *const NNPRINTF_UNUSED nnprintf_tags[6] = {
    "[TRACE]", "[DEBUG]", "[INFO]", "[WARNING]", "[ERROR]", "[FATAL]"
};

#if defined(NNPRINTF_ANSI_COLOR)
static const char *const NNPRINTF_UNUSED nnprintf_colors[6] = {
    "\\x1b[90m", "\\x1b[90m", "\\x1b[32m", "\\x1b[33m", "\\x1b[31m", "\\x1b[35m"  //灰灰绿黄红品
};
#define NNPRINTF_CLR_END            "\\x1b[0m"           //整行结束复位
#else
static const char *const NNPRINTF_UNUSED nnprintf_colors[6] = {
    "", "", "", "", "", ""                              //未启用 ANSI 颜色：全空串
};
#define NNPRINTF_CLR_END            ""
#endif

/* 拼接工具：把一段以 NUL 结尾的文本追加到行缓冲（超长静默截断） */
static inline int nnprintf_append(char *buf, int pos, int cap, const char *text)
{
    while(pos < cap - 1 && *text != '\\0')buf[pos++] = *text++;
    return pos;
}

/* 行组装与输出：前缀 → 正文 → 行尾，整行交给 NNPRINTF_OUTPUT。
 * file/line 由 SINK 宏在调用点注入（仅 NNPRINTF_WITH_LOCATION 启用时打印） */
static inline void nnprintf_line(uint8_t lvl, const char *file, int line, const char *fmt, ...)
{
    char buf[NNPRINTF_LINE_SIZE];
    int  pos = 0;
    int  cap = NNPRINTF_LINE_SIZE;
    va_list ap;

    if(fmt == NULL)return;
    if(lvl > NNPRINTF_LVL_FATAL)return;                 //非法等级防御
    if(lvl < nnprintf_level)return;                     //运行期等级过滤
#if !defined(NNPRINTF_WITH_LOCATION)
    (void)file;                                         //位置未启用：仅压栈传递不打印
    (void)line;
#endif

    buf[0] = '\\0';
#if defined(NNPRINTF_GET_MS)
    {
        uint32_t ms = (uint32_t)NNPRINTF_GET_MS();      //毫秒时基（用户注入）
        pos += snprintf(buf + pos, (size_t)(cap - pos), "[%u.%03u]", ms / 1000u, ms % 1000u);
        if(pos > cap - 1)pos = cap - 1;                 //vsnprintf 返回"应有长度"，截断即钳位
    }
#endif
    pos = nnprintf_append(buf, pos, cap, nnprintf_colors[lvl]); //ANSI 颜色（未启用为空）
    pos = nnprintf_append(buf, pos, cap, nnprintf_tags[lvl]);   //等级标签 [INFO] 等
    pos = nnprintf_append(buf, pos, cap, NNPRINTF_SEP);         //分隔符 --
#if defined(NNPRINTF_WITH_LOCATION)
    if(file != NULL)
        pos += snprintf(buf + pos, (size_t)(cap - pos), "[%s:%d]", file, line);
    if(pos > cap - 1)pos = cap - 1;                     //钳位，防下面负长度
#endif

    va_start(ap, fmt);
    pos += vsnprintf(buf + pos, (size_t)(cap - pos), fmt, ap);  //用户正文
    va_end(ap);

    /* 行尾永远完整：按 EOL 实际长度钳位，颜色复位不挤占行尾空间 */
    {
        const char *eol = NNPRINTF_EOL;
        int elen = (int)(sizeof(NNPRINTF_EOL) - 1);
        if(pos > cap - elen - 1)pos = cap - elen - 1;           //截断钳位
        pos = nnprintf_append(buf, pos, cap - elen, NNPRINTF_CLR_END);  //颜色复位（未启用为空）
        while(*eol != '\\0')buf[pos++] = *eol++;                 //完整写入行尾
        buf[pos] = '\\0';                                        //NUL 收尾
    }
    NNPRINTF_OUTPUT(buf);                               //★整行交给用户钩子
}

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif //__NNPRINTF_H__
`
  }
];

// plugins/wave/src/svg-export.ts
var WIDTH = 1200;
var AXIS_W = 76;
var PANE_H = 110;
var PAD_L = 12;
var TIME_AXIS_H2 = 30;
var esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
var buildWaveSvg = (engine, opts, colors) => {
  if (engine.t.count < 2) return null;
  const visIdx = engine.channels.map((_, i) => i).filter((i) => engine.visible[i] !== false);
  if (visIdx.length === 0) return null;
  const t0 = engine.t.at(0);
  const t1 = engine.lastT;
  const span = Math.max(1, t1 - t0);
  const panes = opts.overlay ? [{ channels: visIdx, top: PAD_L, height: PANE_H }] : visIdx.map((ch, i) => ({ channels: [ch], top: PAD_L + PANE_H * i, height: PANE_H }));
  const plotLeft = PAD_L;
  const plotRight = WIDTH - AXIS_W;
  const plotW = plotRight - plotLeft;
  const plotBottom = PAD_L + PANE_H * panes.length;
  const height = plotBottom + TIME_AXIS_H2 + 12;
  const cols = Math.min(1200, Math.max(1, Math.floor(plotW)));
  const rangeOf = (ch) => {
    const manual = opts.yRanges.get(ch);
    if (manual) return manual;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < engine.t.count; i++) {
      const v = engine.channels[ch].at(i);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!isFinite(lo) || !isFinite(hi)) return { min: -1, max: 1 };
    if (lo === hi) return { min: lo - 1, max: hi + 1 };
    const pad = (hi - lo) * 0.1;
    return { min: lo - pad, max: hi + pad };
  };
  let paneRange = null;
  if (opts.overlay) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const ch of visIdx) {
      const r = rangeOf(ch);
      lo = Math.min(lo, r.min);
      hi = Math.max(hi, r.max);
    }
    const pad = (hi - lo) * 0.1;
    paneRange = { min: lo - pad, max: hi + pad };
  }
  const parts = [];
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace("T", " ").slice(0, 19);
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" font-family="Consolas, monospace">`
  );
  parts.push(`<rect width="100%" height="100%" fill="${colors.bg}"/>`);
  parts.push(
    `<text x="${PAD_L}" y="16" font-size="13" fill="${colors.text}">NNSerialTool 波形导出 · ${esc(stamp)} · 全量 ${engine.t.count} 帧</text>`
  );
  const yTickLabels = [];
  for (const pane of panes) {
    const range = opts.overlay && paneRange ? paneRange : rangeOf(pane.channels[0]);
    const yOf = (v) => pane.top + pane.height - (v - range.min) / (range.max - range.min) * pane.height;
    parts.push(
      `<rect x="${plotLeft}" y="${pane.top}" width="${plotW}" height="${pane.height}" fill="none" stroke="${colors.border}"/>`
    );
    const label = pane.channels.map((ch) => engine.names[ch] ?? `CH${ch + 1}`).join(" / ");
    parts.push(`<text x="${plotLeft + 6}" y="${pane.top + 14}" font-size="12" fill="${colors.text}">${esc(label)}</text>`);
    const step = niceStep(range.max - range.min, 4);
    for (let v = Math.ceil(range.min / step) * step; v <= range.max; v += step) {
      const y = pane.top + pane.height - (v - range.min) / (range.max - range.min) * pane.height;
      if (y < pane.top + 6 || y > pane.top + pane.height - 2) continue;
      parts.push(
        `<line x1="${plotLeft}" y1="${y}" x2="${plotRight}" y2="${y}" stroke="${colors.grid}"/>`
      );
      parts.push(`<text x="${plotRight + 6}" y="${y}" font-size="10" fill="${colors.textDim}">${esc(fmtValue(v))}</text>`);
      yTickLabels.push(fmtValue(v));
    }
    for (const ch of pane.channels) {
      const color = colors.palette[ch % colors.palette.length];
      const yOf2 = (v) => pane.top + pane.height - (v - range.min) / (range.max - range.min) * pane.height;
      const style = opts.style ?? "bars";
      if (style === "dots") {
        const stride = Math.max(1, Math.ceil(engine.t.count / 8e3));
        for (let i = 0; i < engine.t.count; i += stride) {
          const x = (plotLeft + (engine.t.at(i) - t0) / span * plotW).toFixed(1);
          const y = yOf2(engine.channels[ch].at(i)).toFixed(1);
          parts.push(`<rect x="${+x - 1.5}" y="${+y - 1.5}" width="3" height="3" fill="${color}"/>`);
        }
        continue;
      }
      if (style === "line") {
        const stride = Math.max(1, Math.ceil(engine.t.count / 4e3));
        const segs2 = [];
        let started = false;
        for (let i = 0; i < engine.t.count; i += stride) {
          const x = (plotLeft + (engine.t.at(i) - t0) / span * plotW).toFixed(1);
          const y = yOf2(engine.channels[ch].at(i)).toFixed(1);
          segs2.push(`${started ? "L" : "M"}${x} ${y}`);
          started = true;
        }
        parts.push(`<path d="${segs2.join(" ")}" fill="none" stroke="${color}" stroke-width="1.4"/>`);
        continue;
      }
      const mins = new Float64Array(cols).fill(Infinity);
      const maxs = new Float64Array(cols).fill(-Infinity);
      for (let i = 0; i < engine.t.count; i++) {
        const t = engine.t.at(i);
        const x = (t - t0) / span * cols;
        const col = Math.min(cols - 1, Math.max(0, Math.floor(x)));
        const v = engine.channels[ch].at(i);
        if (v < mins[col]) mins[col] = v;
        if (v > maxs[col]) maxs[col] = v;
      }
      const segs = [];
      let lastCol = -2;
      for (let col = 0; col < cols; col++) {
        if (mins[col] > maxs[col]) continue;
        const x = (plotLeft + col + 0.5).toFixed(1);
        if (col - lastCol > 1 || segs.length === 0) {
          segs.push(`M${x} ${yOf2(maxs[col]).toFixed(1)}`);
        }
        segs.push(`L${x} ${yOf2(mins[col]).toFixed(1)}`);
        lastCol = col;
      }
      parts.push(`<path d="${segs.join(" ")}" fill="none" stroke="${color}" stroke-width="1.2"/>`);
    }
  }
  const tStep = niceStep(span, 10);
  for (let t = Math.ceil(t0 / tStep) * tStep; t <= t1; t += tStep) {
    const x = plotLeft + (t - t0) / span * plotW;
    if (x < plotLeft || x > plotLeft + plotW) continue;
    parts.push(`<text x="${x.toFixed(1)}" y="${plotBottom + 16}" font-size="10" fill="${colors.textDim}" text-anchor="middle">${esc(fmtDuration(t - t0))}</text>`);
  }
  parts.push("</svg>");
  void yTickLabels;
  return parts.join("\n");
};

// plugins/wave/src/palette.ts
function hsvToRgb(h, s, v) {
  const hh = (h % 360 + 360) % 360 / 60;
  const ss = Math.min(1, Math.max(0, s));
  const vv = Math.min(1, Math.max(0, v));
  const c = vv * ss;
  const x = c * (1 - Math.abs(hh % 2 - 1));
  const m = vv - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 1) [r, g, b] = [c, x, 0];
  else if (hh < 2) [r, g, b] = [x, c, 0];
  else if (hh < 3) [r, g, b] = [0, c, x];
  else if (hh < 4) [r, g, b] = [0, x, c];
  else if (hh < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255)
  };
}
function rgbToHsv(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === rn) h = 60 * ((gn - bn) / d % 6);
    else if (max === gn) h = 60 * ((bn - rn) / d + 2);
    else h = 60 * ((rn - gn) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : d / max, v: max };
}
function rgbToHex({ r, g, b }) {
  const to2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${to2(r)}${to2(g)}${to2(b)}`.toUpperCase();
}
function hexToRgb(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: n >> 16 & 255, g: n >> 8 & 255, b: n & 255 };
}
function placePalette(anchor, popW, popH, vw, vh, margin = 8, gap = 8, scale = 1) {
  const w = popW * scale;
  const h = popH * scale;
  const cx = anchor.left + anchor.width / 2;
  const left = Math.max(margin, Math.min(cx - w / 2, vw - margin - w));
  let placement = "above";
  let top = anchor.top - gap - h;
  if (top < margin) {
    placement = "below";
    top = anchor.bottom + gap;
  }
  if (top + h > vh - margin) top = Math.max(margin, vh - margin - h);
  return { left, top, placement };
}
var zoomAffectsFixed = null;
function detectZoomAffectsFixed() {
  const html = document.documentElement;
  const prev = html.style.zoom;
  try {
    html.style.zoom = "2";
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;top:100px;left:0;width:0;height:0;visibility:hidden;pointer-events:none;";
    document.body.appendChild(probe);
    const top = probe.getBoundingClientRect().top;
    probe.remove();
    return Math.abs(top - 200) < Math.abs(top - 100);
  } catch {
    return true;
  } finally {
    html.style.zoom = prev;
  }
}
function fixedPxUnit() {
  const zoom = Number(document.documentElement.style.zoom) || 1;
  if (zoomAffectsFixed === null) zoomAffectsFixed = detectZoomAffectsFixed();
  return zoomAffectsFixed ? zoom : 1;
}

// plugins/wave/src/analysis.ts
var EMPTY_STATS = { min: NaN, max: NaN, vpp: NaN, mean: NaN, rms: NaN, freq: null, count: 0 };
var channelStats = (engine, ch, i0, i1) => {
  const n = i1 - i0;
  const ring = engine.channels[ch];
  if (!ring || n <= 1) return EMPTY_STATS;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (let i = i0; i < i1; i++) {
    const v = ring.at(i);
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return EMPTY_STATS;
  const mean = sum / n;
  let sq = 0;
  for (let i = i0; i < i1; i++) {
    const v = ring.at(i);
    if (!Number.isFinite(v)) continue;
    const d = v - mean;
    sq += d * d;
  }
  const rms = Math.sqrt(sq / n);
  let crossings = 0;
  let prev = 0;
  let started = false;
  for (let i = i0; i < i1; i++) {
    const v = ring.at(i) - mean;
    if (!Number.isFinite(v)) continue;
    const s = v >= 0 ? 1 : -1;
    if (!started) {
      started = true;
      prev = s;
      continue;
    }
    if (s !== prev) {
      crossings += 1;
      prev = s;
    }
  }
  const span = engine.t.at(i1 - 1) - engine.t.at(i0);
  const freq = span > 0 && crossings >= 2 ? crossings / 2 / (span / 1e3) : null;
  return { min, max, vpp: max - min, mean, rms, freq, count: n };
};
var buildCsv = (engine, names, cols, i0, i1, maxRows = 2e5) => {
  const n = Math.min(i1 - i0, maxRows);
  if (n <= 0 || cols.length === 0) return "";
  const t0 = engine.t.at(i0);
  const head = ["time_s", ...cols.map((c) => `"${(names[c] ?? `CH${c + 1}`).replace(/"/g, '""')}"`)].join(",");
  const lines = [head];
  for (let i = 0; i < n; i++) {
    const idx = i0 + i;
    const ts = ((engine.t.at(idx) - t0) / 1e3).toFixed(6);
    const row = [ts];
    for (const c of cols) {
      const v = engine.channels[c].at(idx);
      row.push(Number.isFinite(v) ? String(+v.toFixed(6)) : "");
    }
    lines.push(row.join(","));
  }
  return lines.join("\n");
};
var fftSpectrum = (engine, ch, i0, i1) => {
  const ring = engine.channels[ch];
  const n = i1 - i0;
  if (!ring || n < 16) return null;
  const span = engine.t.at(i1 - 1) - engine.t.at(i0);
  if (!(span > 0)) return null;
  const meanDt = span / (n - 1);
  const sampleHz = 1e3 / meanDt;
  let nfft = 1;
  while (nfft * 2 <= Math.min(n, 8192)) nfft *= 2;
  if (nfft < 16) return null;
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  const tStart = engine.t.at(i0);
  const tEnd = engine.t.at(i1 - 1);
  const dtGrid = (tEnd - tStart) / (nfft - 1);
  const grid = new Float64Array(nfft);
  let cur = i0;
  for (let k = 0; k < nfft; k++) {
    const tk = tStart + k * dtGrid;
    while (cur + 1 < i1 - 1 && engine.t.at(cur + 1) <= tk) cur++;
    const ta = engine.t.at(cur);
    const tb = engine.t.at(Math.min(cur + 1, i1 - 1));
    const va = ring.at(cur);
    const vb = ring.at(Math.min(cur + 1, i1 - 1));
    const w = tb > ta ? Math.min(1, Math.max(0, (tk - ta) / (tb - ta))) : 0;
    grid[k] = va + (vb - va) * w;
  }
  let mean = 0;
  for (let k = 0; k < nfft; k++) mean += grid[k];
  mean /= nfft;
  let winSum = 0;
  for (let k = 0; k < nfft; k++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * k / (nfft - 1));
    winSum += w;
    re[k] = (grid[k] - mean) * w;
  }
  const winGain = winSum / nfft;
  for (let i = 1, j = 0; i < nfft; i++) {
    let bit = nfft >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= nfft; len <<= 1) {
    const ang = -2 * Math.PI / len;
    for (let i = 0; i < nfft; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
      }
    }
  }
  const half = nfft / 2;
  const fsEff = (nfft - 1) / (span / 1e3);
  const freqs = new Float32Array(half);
  const mags = new Float32Array(half);
  for (let k = 0; k < half; k++) {
    freqs[k] = k * fsEff / nfft;
    mags[k] = 2 * Math.hypot(re[k], im[k]) / (nfft * winGain);
  }
  return { freqs, mags, sampleHz, fsEff, nfft };
};
var movingAverage = (values, n) => {
  const k = Math.max(1, Math.round(n));
  if (k <= 1) return values.slice();
  const out = new Float32Array(values.length);
  let acc = 0;
  for (let i = 0; i < values.length; i++) {
    acc += values[i];
    if (i >= k) acc -= values[i - k];
    out[i] = acc / Math.min(i + 1, k);
  }
  return out;
};
var sliceChannel = (engine, ch, i0, i1) => {
  const n = Math.max(0, i1 - i0);
  const out = new Float32Array(n);
  const ring = engine.channels[ch];
  if (!ring) return out;
  for (let i = 0; i < n; i++) out[i] = ring.at(i0 + i);
  return out;
};

// plugins/wave/src/main.ts
var STYLE_ID = "nnwave-plugin-style";
var CSS = `
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
var ensureStyle = () => {
  if (document.getElementById(STYLE_ID)) return;
  const tag = document.createElement("style");
  tag.id = STYLE_ID;
  tag.textContent = CSS;
  document.head.appendChild(tag);
};
var esc2 = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function activate(ctx) {
  ctx.registerProtocol({
    id: "nnwave",
    name: "NN-Wave",
    description: "AA 55 | 类型 | 通道数 | 序号 | float32×N | CRC8（固件模板随插件导出）",
    createParser: () => createNnWaveParser()
  });
  ctx.registerView({
    id: "wave",
    name: "波形",
    tip: "串口/网络数据的实时波形显示",
    blocks: 2,
    component: {
      mount(el) {
        return mountWave(el, ctx);
      },
      unmount(el) {
        el.innerHTML = "";
      }
    }
  });
}
var mountWave = (el, ctx) => {
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
  const root = el.querySelector(".wavep");
  const canvas = el.querySelector(".wavep-canvas");
  const wrap = el.querySelector(".wavep-wrap");
  const vscroll = el.querySelector(".wavep-vscroll");
  const vthumb = el.querySelector(".wavep-vthumb");
  const ovCanvas = el.querySelector(".wavep-ovcanvas");
  const sourceSel = el.querySelector(".wavep-source");
  const btnOverlay = el.querySelector(".wavep-overlay");
  const btnFreeze = el.querySelector(".wavep-freeze");
  const btnFollow = el.querySelector(".wavep-follow");
  const btnCursor = el.querySelector(".wavep-cursorbtn");
  const btnClear = el.querySelector(".wavep-clear");
  const btnExportMenu = el.querySelector(".wavep-export-menu");
  const exportMenu = el.querySelector(".wavep-menu");
  const legendEl = el.querySelector(".wavep-legend");
  const statsEl = el.querySelector(".wavep-stats");
  const windowEl = el.querySelector(".wavep-window");
  const view = defaultViewState();
  let viewDirty = true;
  let cursorMode = false;
  const markDirty = () => {
    viewDirty = true;
  };
  const engine = new WaveEngine();
  engine.setProtocol({ id: "nnwave", name: "NN-Wave", createParser: () => createNnWaveParser() });
  const colorOverrides = {};
  const buildColors = () => {
    const base = ctx.themeColors();
    const entries = Object.entries(colorOverrides);
    if (entries.length === 0) return base;
    const n = Math.max(base.palette.length, engine.channels.length);
    const palette = Array.from({ length: n }, (_, i) => base.palette[i % base.palette.length]);
    for (const [k, v] of entries) {
      const idx = Number(k);
      if (Number.isInteger(idx) && idx >= 0 && idx < n) palette[idx] = v;
    }
    return { ...base, palette };
  };
  const PRESET_COLORS = ["#E5484D", "#F76B15", "#FFC53D", "#46A758", "#12A594", "#3E63DD", "#8E4EC6", "#E93D82"];
  const POP_W = 272;
  let paletteOpenIndex = -1;
  let paletteCleanup = null;
  const closePalette = () => {
    paletteCleanup?.();
    paletteCleanup = null;
    paletteOpenIndex = -1;
    persist();
  };
  const openPalette = (index, anchorEl) => {
    if (paletteOpenIndex === index && paletteCleanup) {
      closePalette();
      return;
    }
    closePalette();
    paletteOpenIndex = index;
    const unit = fixedPxUnit();
    const pop = document.createElement("div");
    pop.className = "wavep-pop" + (ctx.theme() === "dark" ? " theme-dark" : "");
    const chName = esc2(engine.names[index] ?? `CH${index + 1}`);
    pop.innerHTML = `
      <div class="wavep-pop-head">
        <span class="wavep-pop-title">${chName} 颜色</span>
        <button type="button" class="wavep-pop-close" title="关闭">✕</button>
      </div>
      <div class="wavep-pop-body">
        <div class="wavep-pop-left">
          <span class="wavep-pop-label">常用色</span>
          <div class="wavep-swatches">${PRESET_COLORS.map((c) => `<span class="wavep-swatch" data-color="${c}" style="background:${c}" title="${c}"></span>`).join("")}</div>
          <span class="wavep-pop-label">自定义</span>
          <input type="text" class="wavep-hex" maxlength="7" spellcheck="false" />
        </div>
        <div class="wavep-pop-right">
          <div class="wavep-sv" title="饱和度 / 明度"><div class="wavep-sv-cursor"></div></div>
          <div class="wavep-hue" title="色相"><div class="wavep-hue-cursor"></div></div>
        </div>
      </div>`;
    document.body.appendChild(pop);
    const sv = pop.querySelector(".wavep-sv");
    const svCursor = pop.querySelector(".wavep-sv-cursor");
    const hue = pop.querySelector(".wavep-hue");
    const hueCursor = pop.querySelector(".wavep-hue-cursor");
    const hexInput = pop.querySelector(".wavep-hex");
    const btnClose = pop.querySelector(".wavep-pop-close");
    const initial = buildColors().palette[index % buildColors().palette.length];
    const initRgb = hexToRgb(initial) ?? { r: 255, g: 255, b: 255 };
    let hsv = rgbToHsv(initRgb.r, initRgb.g, initRgb.b);
    const applyLive = (hex) => {
      colorOverrides[index] = hex;
      markDirty();
      updateLegend();
    };
    const syncUi = () => {
      const { h, s, v } = hsv;
      sv.style.background = `linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, hsl(${Math.round(h)}, 100%, 50%))`;
      svCursor.style.left = `${s * 100}%`;
      svCursor.style.top = `${(1 - v) * 100}%`;
      hueCursor.style.left = `${h / 360 * 100}%`;
      hexInput.value = rgbToHex(hsvToRgb(h, s, v));
    };
    const dragTo = (e, kind) => {
      const target = kind === "sv" ? sv : hue;
      const r = target.getBoundingClientRect();
      const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / (r.width || 1)));
      const fy = Math.min(1, Math.max(0, (e.clientY - r.top) / (r.height || 1)));
      hsv = kind === "sv" ? { ...hsv, s: fx, v: 1 - fy } : { ...hsv, h: fx * 360 };
      syncUi();
      applyLive(rgbToHex(hsvToRgb(hsv.h, hsv.s, hsv.v)));
    };
    const bindDrag = (target, kind) => {
      target.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        target.setPointerCapture(e.pointerId);
        dragTo(e, kind);
      });
      target.addEventListener("pointermove", (e) => {
        if (target.hasPointerCapture(e.pointerId)) dragTo(e, kind);
      });
      const end = (e) => {
        if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId);
        persist();
      };
      target.addEventListener("pointerup", end);
      target.addEventListener("pointercancel", end);
    };
    bindDrag(sv, "sv");
    bindDrag(hue, "hue");
    pop.querySelectorAll(".wavep-swatch").forEach(
      (sw) => sw.addEventListener("click", () => {
        const c = sw.dataset.color ?? "";
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
        syncUi();
        return;
      }
      hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
      syncUi();
      applyLive(rgbToHex(rgb));
      persist();
    };
    hexInput.addEventListener("change", commitHex);
    hexInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitHex();
        hexInput.blur();
      }
    });
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
    window.addEventListener("resize", onResize);
    const onDocPointerDown = (e) => {
      const t = e.target;
      if (pop.contains(t) || anchorEl.contains(t)) return;
      closePalette();
    };
    const onKey = (e) => {
      if (e.key === "Escape") closePalette();
    };
    document.addEventListener("pointerdown", onDocPointerDown, true);
    window.addEventListener("keydown", onKey);
    btnClose.addEventListener("click", closePalette);
    paletteCleanup = () => {
      window.removeEventListener("resize", onResize);
      document.removeEventListener("pointerdown", onDocPointerDown, true);
      window.removeEventListener("keydown", onKey);
      pop.remove();
    };
  };
  const unsubs = [];
  unsubs.push(ctx.onRawData((e) => engine.handleRaw(e)));
  if (ctx.onSessionsChange) unsubs.push(ctx.onSessionsChange(() => renderSessions()));
  const renderSessions = () => {
    const list = ctx.listSessions();
    const cur = sourceSel.value;
    sourceSel.innerHTML = '<option value="">选择数据源会话</option>' + list.map(
      (s) => `<option value="${esc2(s.id)}">${esc2(s.name)}${s.status === "connected" ? "" : "（未连接）"}</option>`
    ).join("");
    if (cur && list.some((s) => s.id === cur)) sourceSel.value = cur;
    else sourceSel.value = engine.attachedSessionId && list.some((s) => s.id === engine.attachedSessionId) ? engine.attachedSessionId : "";
  };
  renderSessions();
  sourceSel.addEventListener("change", () => {
    engine.attach(sourceSel.value);
    markDirty();
  });
  const updateButtons = () => {
    btnOverlay.textContent = view.overlay ? "叠加" : "分栏";
    btnFreeze.textContent = view.frozen ? "已冻结" : "冻结";
    btnFreeze.classList.toggle("active", view.frozen);
    btnFollow.style.display = !view.follow && !view.frozen ? "" : "none";
    btnCursor.classList.toggle("active", cursorMode);
  };
  const STYLE_LABEL = { line: "曲线", dots: "点", bars: "峰谷" };
  const STYLE_ORDER = ["line", "dots", "bars"];
  btnOverlay.addEventListener("click", () => {
    view.overlay = !view.overlay;
    view.yRanges.clear();
    view.paneScroll = 0;
    setHover(null);
    updateButtons();
    markDirty();
  });
  const btnStyle = el.querySelector(".wavep-style");
  btnStyle.addEventListener("click", () => {
    const order = STYLE_ORDER;
    const at = order.indexOf(view.style);
    view.style = order[(at < 0 ? 0 : at + 1) % order.length];
    btnStyle.textContent = STYLE_LABEL[view.style] ?? "曲线";
    persist();
    markDirty();
  });
  btnFreeze.addEventListener("click", () => {
    if (!view.frozen) {
      view.rightT = currentT1();
      view.frozen = true;
      ctx.notify("已冻结显示（后台继续采集）");
    } else {
      view.frozen = false;
      view.follow = true;
    }
    updateButtons();
    markDirty();
  });
  btnFollow.addEventListener("click", () => {
    view.follow = true;
    view.frozen = false;
    updateButtons();
    markDirty();
  });
  btnCursor.addEventListener("click", () => {
    cursorMode = !cursorMode;
    updateButtons();
  });
  btnClear.addEventListener("click", () => {
    engine.clear();
    fpsFrames = 0;
    fps = 0;
    fpsMark = performance.now();
    markDirty();
  });
  const hudEl = el.querySelector(".wavep-hud");
  const measurePanel = el.querySelector(".wavep-measure");
  const measureBody = el.querySelector(".wavep-measure-body");
  const mathPanel = el.querySelector(".wavep-math");
  const mathCanvas = el.querySelector(".wavep-math-canvas");
  const mathOp = el.querySelector(".wavep-math-op");
  const mathA = el.querySelector(".wavep-math-a");
  const mathB = el.querySelector(".wavep-math-b");
  const mathN = el.querySelector(".wavep-math-num");
  const mathFoot = el.querySelector(".wavep-math-foot");
  const btnMeasure = el.querySelector(".wavep-measurebtn");
  const btnMath = el.querySelector(".wavep-mathbtn");
  const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const visibleChannels = () => engine.channels.map((_, i) => i).filter((i) => engine.visible[i] !== false);
  let measureOpen = false;
  let mathOpen = false;
  let lastPointer = null;
  const windowRange = () => {
    if (engine.t.count < 2 || !(geom.t1 > geom.t0)) return null;
    const i0 = Math.max(0, engine.lowerBound(geom.t0));
    const i1 = Math.min(engine.t.count, Math.max(i0 + 1, engine.lowerBound(geom.t1) + 1));
    return i1 - i0 >= 2 ? { i0, i1 } : null;
  };
  const timeText = (t) => {
    const epoch = t + (Date.now() - performance.now());
    const d = new Date(epoch);
    const p = (n, w = 2) => String(n).padStart(w, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  };
  const relativeText = (t) => {
    const first = engine.t.count > 0 ? engine.t.at(0) : t;
    return `+${((t - first) / 1e3).toFixed(3)} s`;
  };
  const updateHud = () => {
    if (view.hoverT === null || !lastPointer || engine.t.count === 0) {
      hudEl.style.display = "none";
      return;
    }
    const idx = engine.nearestIndex(view.hoverT);
    if (idx < 0) {
      hudEl.style.display = "none";
      return;
    }
    const palette = buildColors().palette;
    const focus = view.hoverCh;
    const chs = focus !== null && !view.overlay ? [focus] : visibleChannels().slice(0, 8);
    let dtLine = "";
    if (view.cursorA !== null && view.cursorB !== null) {
      const dt = Math.abs(view.cursorB - view.cursorA);
      if (dt > 0) {
        const hz = 1e3 / dt;
        const hzText = hz >= 100 ? hz.toFixed(0) : hz >= 1 ? hz.toFixed(1) : hz.toFixed(2);
        dtLine = `<div class="wavep-hud-dt">Δt ${fmtDuration(dt)} · ${hzText} Hz</div>`;
      }
    }
    const rows = chs.map((ch) => {
      const color = palette[ch % palette.length];
      const name = engine.names[ch] ?? `CH${ch + 1}`;
      return `<div class="wavep-hud-row"><span><i style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${color};margin-right:5px"></i><b>${escapeHtml(name)}</b></span><span>${fmtValue(engine.channels[ch].at(idx))}</span></div>`;
    }).join("");
    hudEl.innerHTML = `<div class="wavep-hud-time">${timeText(engine.t.at(idx))}<span class="wavep-hud-el">${relativeText(engine.t.at(idx))}</span></div>${dtLine}${rows}`;
    hudEl.style.display = "";
    const wr = wrap.getBoundingClientRect();
    const scale = wr.width / (wrap.offsetWidth || 1) || 1;
    const px = (lastPointer.x - wr.left) / scale;
    const py = (lastPointer.y - wr.top) / scale;
    const w = hudEl.offsetWidth;
    const h = hudEl.offsetHeight;
    const WW = wrap.offsetWidth;
    const WH = wrap.offsetHeight;
    const gap = 14 / scale;
    const cands = [
      { x: px + gap, y: py + gap },
      // 右下（默认）
      { x: px - gap - w, y: py + gap },
      // 左下
      { x: px + gap, y: py - gap - h },
      // 右上
      { x: px - gap - w, y: py - gap - h }
      // 左上
    ];
    const fits = (c) => c.x >= 6 && c.y >= 6 && c.x + w <= WW - 6 && c.y + h <= WH - 6;
    let pos = cands.find(fits);
    if (!pos) {
      pos = { x: px < WW / 2 ? WW - w - 6 : 6, y: py < WH / 2 ? WH - h - 6 : 6 };
      const covers = px >= pos.x - 4 && px <= pos.x + w + 4 && py >= pos.y - 4 && py <= pos.y + h + 4;
      if (covers) {
        pos.x = px < WW / 2 ? Math.max(6, Math.min(WW - w - 6, px + 24)) : Math.min(WW - w - 6, Math.max(6, px - w - 24));
      }
    }
    hudEl.style.left = `${Math.round(pos.x)}px`;
    hudEl.style.top = `${Math.round(pos.y)}px`;
  };
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
    const rows = chs.slice(0, 24).map((ch) => {
      const s = channelStats(engine, ch, r.i0, r.i1);
      const cur = engine.channels[ch].at(r.i1 - 1);
      const color = palette[ch % palette.length];
      const name = engine.names[ch] ?? `CH${ch + 1}`;
      return `<div class="wavep-measure-row" title="${escapeHtml(name)}：Vpp ${fmtValue(s.vpp)} / RMS ${fmtValue(s.rms)} / 均值 ${fmtValue(s.mean)}"><span style="color:${color};overflow:hidden;text-overflow:ellipsis">${escapeHtml(name)}</span><span>${fmtValue(cur)}</span><span>${fmtValue(s.vpp)}</span><span>${fmtValue(s.rms)}</span><span>${s.freq !== null ? s.freq.toFixed(1) + " Hz" : "—"}</span></div>`;
    }).join("");
    measureBody.innerHTML = head + rows;
  };
  let mathCfg = ctx.storage.get("wave.math", { op: "diff", a: 0, b: 1, n: 9 });
  if (!mathCfg || typeof mathCfg !== "object") mathCfg = { op: "diff", a: 0, b: 1, n: 9 };
  const saveMathCfg = () => {
    mathCfg = {
      op: ["diff", "avg", "fft"].includes(mathOp.value) ? mathOp.value : "diff",
      a: Number(mathA.value) || 0,
      b: Number(mathB.value) || 0,
      n: Math.min(999, Math.max(2, Number(mathN.value) || 9))
    };
    ctx.storage.set("wave.math", mathCfg);
    renderMath();
  };
  const syncMathSelectors = () => {
    const opts = engine.channels.map((_, i) => `<option value="${i}">${escapeHtml(engine.names[i] ?? `CH${i + 1}`)}</option>`).join("");
    if (mathA.dataset.count !== String(engine.channels.length)) {
      mathA.innerHTML = opts;
      mathB.innerHTML = opts;
      mathA.dataset.count = String(engine.channels.length);
    }
    mathA.value = String(Math.min(mathCfg.a, Math.max(0, engine.channels.length - 1)));
    mathB.value = String(Math.min(mathCfg.b, Math.max(0, engine.channels.length - 1)));
    mathOp.value = mathCfg.op;
    mathN.value = String(mathCfg.n);
    const isFft = mathCfg.op === "fft";
    const isAvg = mathCfg.op === "avg";
    mathB.style.display = mathCfg.op === "diff" ? "" : "none";
    mathN.parentElement.style.display = isAvg ? "" : "none";
    void isFft;
  };
  const drawMathCanvas = (values, spectrum, unit) => {
    const dpr = (window.devicePixelRatio || 1) * (Number(document.documentElement.style.zoom) || 1);
    const cssW = mathCanvas.clientWidth || 240;
    const cssH = mathCanvas.clientHeight || 110;
    const W = Math.round(cssW * dpr);
    const H = Math.round(cssH * dpr);
    if (mathCanvas.width !== W || mathCanvas.height !== H) {
      mathCanvas.width = W;
      mathCanvas.height = H;
    }
    const g = mathCanvas.getContext("2d");
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
      const bins = spectrum.mags.length - 1;
      for (let k = 1; k < spectrum.mags.length; k++) {
        const x = L + k / bins * pw;
        const h = spectrum.mags[k] / maxMag * ph;
        g.fillRect(x, T + ph - h, Math.max(1, pw / bins - 0.5), h);
      }
      g.fillStyle = colors.textDim;
      g.font = "9px Consolas, monospace";
      g.textAlign = "left";
      g.textBaseline = "top";
      g.fillText("0 Hz", L, T + ph + 3);
      g.textAlign = "right";
      g.fillText(`${(spectrum.fsEff / 2).toFixed(0)} Hz`, L + pw, T + ph + 3);
      g.textAlign = "left";
      g.textBaseline = "middle";
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
    const yOf = (v) => T + ph - (v - min) / (max - min) * ph;
    g.strokeStyle = colors.accent;
    g.lineWidth = 1.6;
    g.beginPath();
    const stride = Math.max(1, Math.ceil(values.length / (pw * 2)));
    for (let i = 0; i < values.length; i += stride) {
      const x = L + i / (values.length - 1) * pw;
      const y = yOf(values[i]);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
    g.fillStyle = colors.textDim;
    g.font = "9px Consolas, monospace";
    g.textAlign = "left";
    g.textBaseline = "middle";
    g.fillText(fmtValue(max), 2, T + 5);
    g.fillText(fmtValue(min), 2, T + ph - 5);
    g.textBaseline = "top";
    g.fillText(unit, L, T + ph + 3);
  };
  const renderMath = () => {
    if (!mathOpen) return;
    syncMathSelectors();
    const r = windowRange();
    if (!r || engine.channels.length === 0) {
      drawMathCanvas(null, null, "");
      mathFoot.textContent = "当前时间窗内无数据";
      return;
    }
    const aName = engine.names[mathCfg.a] ?? `CH${mathCfg.a + 1}`;
    if (mathCfg.op === "fft") {
      const spec = fftSpectrum(engine, mathCfg.a, r.i0, r.i1);
      drawMathCanvas(null, spec, "");
      if (spec) {
        let pk = 1;
        for (let k = 2; k < spec.mags.length; k++) if (spec.mags[k] > spec.mags[pk]) pk = k;
        const pkHz = spec.freqs[pk];
        const zero = channelStats(engine, mathCfg.a, r.i0, r.i1).freq;
        mathFoot.textContent = `${aName} 采样≈${spec.sampleHz.toFixed(1)} Hz · ${spec.nfft} 点 FFT · 分辨率 ${(spec.fsEff / spec.nfft).toFixed(2)} Hz · 谱峰 ${pkHz.toFixed(2)} Hz` + (zero ? ` · 过零 ${zero.toFixed(2)} Hz` : "");
      } else {
        mathFoot.textContent = `${aName} 样本不足，无法做 FFT`;
      }
      return;
    }
    const av = sliceChannel(engine, mathCfg.a, r.i0, r.i1);
    if (mathCfg.op === "diff") {
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
  const setMeasureOpen = (on) => {
    if (on && mathOpen) setMathOpen(false);
    measureOpen = on;
    measurePanel.style.display = on ? "" : "none";
    btnMeasure.classList.toggle("active", on);
    if (on) renderMeasure();
  };
  const setMathOpen = (on) => {
    if (on && measureOpen) {
      measureOpen = false;
      measurePanel.style.display = "none";
      btnMeasure.classList.remove("active");
    }
    mathOpen = on;
    mathPanel.style.display = on ? "" : "none";
    btnMath.classList.toggle("active", on);
    if (on) renderMath();
  };
  btnMeasure.addEventListener("click", () => setMeasureOpen(!measureOpen));
  btnMath.addEventListener("click", () => setMathOpen(!mathOpen));
  for (const btn of el.querySelectorAll(".wavep-panel-close")) {
    btn.addEventListener("click", () => {
      const which = btn.dataset.close;
      if (which === "measure") setMeasureOpen(false);
      if (which === "math") setMathOpen(false);
    });
  }
  mathOp.addEventListener("change", saveMathCfg);
  mathA.addEventListener("change", saveMathCfg);
  mathB.addEventListener("change", saveMathCfg);
  mathN.addEventListener("change", saveMathCfg);
  const exportCsv = () => {
    const r = windowRange();
    const cols = visibleChannels();
    if (!r || cols.length === 0) {
      ctx.notify("当前没有可导出的波形数据");
      return;
    }
    if (!ctx.exportTextFiles) {
      ctx.notify("当前应用版本过旧，不支持文件导出");
      return;
    }
    const csv = buildCsv(engine, engine.names, cols, r.i0, r.i1, 2e5);
    if (!csv) {
      ctx.notify("当前没有可导出的波形数据");
      return;
    }
    const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    void ctx.exportTextFiles("选择 CSV 导出目录", [{ name: `wave-${stamp}.csv`, text: csv }], "wave-csv").then((dir) => ctx.notify(dir ? `CSV 已导出到 ${dir}（${r.i1 - r.i0} 点 × ${cols.length} 通道）` : "CSV 导出已取消")).catch(() => ctx.notify("CSV 导出失败"));
  };
  const exportProtocol = () => {
    void (async () => {
      if (!ctx.exportTextFiles) {
        ctx.notify("当前应用版本过旧，不支持文件导出");
        return;
      }
      try {
        const dir = await ctx.exportTextFiles("选择协议文件导出目录", FIRMWARE_FILES, "nnwave-protocol");
        ctx.notify(dir ? `协议文件已导出到 ${dir} 下的 nnwave-protocol 子目录` : "已取消导出");
      } catch (e) {
        ctx.notify("协议文件导出失败：" + (e instanceof Error ? e.message : String(e)));
      }
    })();
  };
  const exportSvg = () => {
    void (async () => {
      if (!ctx.exportTextFiles) {
        ctx.notify("当前应用版本过旧，不支持文件导出");
        return;
      }
      const svg = buildWaveSvg(engine, { overlay: view.overlay, yRanges: view.yRanges, style: view.style }, ctx.themeColors());
      if (!svg) {
        ctx.notify("暂无波形数据可导出");
        return;
      }
      const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:T]/g, "-").slice(0, 19);
      try {
        const dir = await ctx.exportTextFiles("选择SVG导出目录", [{ name: `wave-${stamp}.svg`, text: svg }], "wave-svg");
        ctx.notify(dir ? `波形 SVG 已导出到 ${dir} 下的 wave-svg 子目录` : "已取消导出");
      } catch (e) {
        ctx.notify("SVG 导出失败：" + (e instanceof Error ? e.message : String(e)));
      }
    })();
  };
  const exportLogLib = () => {
    void (async () => {
      if (!ctx.exportTextFiles) {
        ctx.notify("当前应用版本过旧，不支持文件导出");
        return;
      }
      try {
        const dir = await ctx.exportTextFiles("选择日志库导出目录", NNPRINTF_FILES, "nnprintf-log");
        ctx.notify(dir ? `NNPrintf.h 已导出到 ${dir} 下的 nnprintf-log 子目录` : "已取消导出");
      } catch (e) {
        ctx.notify("日志库导出失败：" + (e instanceof Error ? e.message : String(e)));
      }
    })();
  };
  const closeExportMenu = () => {
    exportMenu.style.display = "none";
  };
  btnExportMenu.addEventListener("click", (e) => {
    e.stopPropagation();
    exportMenu.style.display = exportMenu.style.display === "none" ? "" : "none";
  });
  exportMenu.addEventListener("click", (e) => {
    const item = e.target.closest(".wavep-menu-item");
    if (!item) return;
    closeExportMenu();
    const kind = item.dataset.export;
    if (kind === "svg") exportSvg();
    else if (kind === "csv") exportCsv();
    else if (kind === "protocol") exportProtocol();
    else if (kind === "loglib") exportLogLib();
  });
  document.addEventListener("pointerdown", (e) => {
    if (!exportMenu.contains(e.target) && e.target !== btnExportMenu) closeExportMenu();
  });
  const pointerPos = (e) => {
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width / (canvas.clientWidth || 1);
    return { x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale };
  };
  let geom = {
    t0: 0,
    t1: 0,
    plotLeft: 0,
    plotWidth: 1,
    panes: [],
    viewport: { top: 0, height: 0 },
    layout: null
  };
  const inPlot = (x) => x >= geom.plotLeft && x <= geom.plotLeft + geom.plotWidth;
  const timeAtX = (x) => geom.t0 + (x - geom.plotLeft) / geom.plotWidth * view.windowMs;
  const currentT1 = () => view.frozen ? view.rightT : view.follow ? engine.lastT : view.rightT;
  let ovRange = null;
  const ovPointer = (e) => {
    const rect = ovCanvas.getBoundingClientRect();
    const scale = rect.width / (ovCanvas.clientWidth || 1);
    const x = (e.clientX - rect.left) / scale;
    if (!ovRange) return null;
    const frac = Math.min(1, Math.max(0, x / (ovCanvas.clientWidth || 1)));
    return { x, t: ovRange.fullT0 + frac * (ovRange.fullT1 - ovRange.fullT0) };
  };
  const clampWindow = (rightT, windowMs) => {
    const firstT = engine.t.count > 0 ? engine.t.at(0) : 0;
    const minRightT = firstT + windowMs;
    const clampedRight = Math.min(Math.max(rightT, Math.min(minRightT, engine.lastT)), engine.lastT);
    return { rightT: clampedRight, follow: !view.frozen && clampedRight >= engine.lastT - 1 };
  };
  const findPaneChannel = (y) => {
    if (view.overlay) return null;
    for (const p of geom.panes) {
      if (y >= p.top && y <= p.top + p.height && p.top + p.height > geom.viewport.top && p.top < geom.viewport.top + geom.viewport.height)
        return p.ch;
    }
    return null;
  };
  const scaleY = (ch, factor) => {
    const targets = ch === null ? engine.channels.map((_, i) => i).filter((i) => engine.visible[i] !== false) : [ch];
    for (const c of targets) {
      const base = view.yRanges.get(c) ?? lastYRanges.get(c);
      if (!base) continue;
      const center = (base.min + base.max) / 2;
      const half = (base.max - base.min) / 2 * factor;
      if (half < 1e-9) continue;
      view.yRanges.set(c, { min: center - half, max: center + half });
    }
    markDirty();
  };
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const { x, y } = pointerPos(e);
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
      const tAt = timeAtX(x);
      view.windowMs = newWindow;
      const rightEdge = geom.plotLeft + geom.plotWidth;
      const newRightT = tAt + (rightEdge - x) / geom.plotWidth * newWindow;
      const firstT = engine.t.count > 0 ? engine.t.at(0) : 0;
      const minRightT = firstT + newWindow;
      view.rightT = newRightT >= engine.lastT - 1 ? engine.lastT : Math.max(newRightT, Math.min(minRightT, engine.lastT));
      view.follow = !view.frozen && view.rightT >= engine.lastT - 1;
      updateButtons();
      markDirty();
    },
    { passive: false }
  );
  let drag = null;
  canvas.addEventListener("pointerdown", (e) => {
    const { x, y } = pointerPos(e);
    canvas.setPointerCapture(e.pointerId);
    if (x <= geom.plotLeft + 4) {
      const ch = findPaneChannel(y);
      const base = (ch !== null ? view.yRanges.get(ch) : void 0) ?? (ch !== null ? lastYRanges.get(ch) : void 0);
      if (base) {
        drag = { kind: "yscale", ch, startY: y, base };
      } else if (ch === null) {
        const vis = engine.channels.map((_, i) => i).filter((i) => engine.visible[i] !== false);
        const ranges = vis.map((c) => view.yRanges.get(c) ?? lastYRanges.get(c)).filter((r) => !!r);
        if (ranges.length) {
          const min = Math.min(...ranges.map((r) => r.min));
          const max = Math.max(...ranges.map((r) => r.max));
          drag = { kind: "yscale", ch: null, startY: y, base: { min, max } };
        }
      }
    } else {
      drag = { kind: "pan", startX: x, startRightT: currentT1() };
    }
  });
  canvas.addEventListener("pointermove", (e) => {
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
        hudEl.style.display = "none";
        markDirty();
      }
      if (!drag && !view.overlay) {
        const pane = geom.panes.find((q) => p.y >= q.top && p.y < q.top + q.height);
        setHover(pane ? pane.ch : null);
      }
    }
    if (!drag) return;
    const { x, y } = pointerPos(e);
    if (drag.kind === "pan") {
      const dt = (x - drag.startX) / geom.plotWidth * view.windowMs;
      const firstT = engine.t.count > 0 ? engine.t.at(0) : 0;
      const minRightT = firstT + view.windowMs;
      view.rightT = Math.min(Math.max(drag.startRightT - dt, Math.min(minRightT, engine.lastT)), engine.lastT);
      view.follow = !view.frozen && view.rightT >= engine.lastT - 1;
      if (view.follow) view.rightT = engine.lastT;
    } else if (drag.kind === "scroll") {
      view.paneScroll = clamp(drag.startScroll + (y - drag.startY) * drag.ratio, 0, drag.scrollMax);
    } else if (drag.kind === "ov-pan" || drag.kind === "ov-left" || drag.kind === "ov-right") {
      return;
    } else {
      const factor = Math.exp((y - drag.startY) * 5e-3);
      const center = (drag.base.min + drag.base.max) / 2;
      const half = (drag.base.max - drag.base.min) / 2 * factor;
      const targets = drag.ch === null ? engine.channels.map((_, i) => i).filter((i) => engine.visible[i] !== false) : [drag.ch];
      for (const c of targets) view.yRanges.set(c, { min: center - half, max: center + half });
    }
    updateButtons();
    markDirty();
  });
  const endDrag = (e) => {
    drag = null;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  const syncVScroll = () => {
    const layout = geom.layout;
    vscroll.style.display = layout ? "" : "none";
    if (!layout) return;
    const trackH = vscroll.clientHeight || 1;
    const thumbH = Math.max(24, Math.min(trackH, layout.thumbH));
    const y = view.paneScroll / layout.scrollMax * (trackH - thumbH);
    vthumb.style.height = `${thumbH}px`;
    vthumb.style.top = `${y}px`;
  };
  vscroll.addEventListener("pointerdown", (e) => {
    const layout = geom.layout;
    if (!layout) return;
    e.preventDefault();
    vscroll.setPointerCapture(e.pointerId);
    const rect = vscroll.getBoundingClientRect();
    const scale = rect.height / (vscroll.clientHeight || 1);
    const yLayout = (e.clientY - rect.top) / scale;
    const trackH = vscroll.clientHeight;
    const thumbH = Math.max(24, Math.min(trackH, layout.thumbH));
    const thumbY = view.paneScroll / layout.scrollMax * (trackH - thumbH);
    const inThumb = yLayout >= thumbY && yLayout <= thumbY + thumbH;
    let ratio = layout.scrollMax / (trackH - thumbH || 1);
    let startY = yLayout;
    let startScroll = view.paneScroll;
    if (!inThumb) {
      startScroll = clamp((yLayout - thumbH / 2) / (trackH - thumbH || 1) * layout.scrollMax, 0, layout.scrollMax);
      view.paneScroll = startScroll;
      startY = yLayout;
    }
    drag = { kind: "scroll", startY, startScroll, ratio, scrollMax: layout.scrollMax };
    vthumb.classList.add("dragging");
    markDirty();
  });
  vscroll.addEventListener("pointermove", (e) => {
    if (!drag || drag.kind !== "scroll") return;
    const rect = vscroll.getBoundingClientRect();
    const scale = rect.height / (vscroll.clientHeight || 1);
    const yLayout = (e.clientY - rect.top) / scale;
    view.paneScroll = clamp(drag.startScroll + (yLayout - drag.startY) * drag.ratio, 0, drag.scrollMax);
    markDirty();
  });
  const endVScroll = (e) => {
    if (vscroll.hasPointerCapture(e.pointerId)) vscroll.releasePointerCapture(e.pointerId);
    if (drag?.kind === "scroll") {
      drag = null;
      vthumb.classList.remove("dragging");
      markDirty();
    }
  };
  vscroll.addEventListener("pointerup", endVScroll);
  vscroll.addEventListener("pointercancel", endVScroll);
  vscroll.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (!geom.layout) return;
      view.paneScroll = clamp(view.paneScroll + e.deltaY, 0, geom.layout.scrollMax);
      markDirty();
    },
    { passive: false }
  );
  const OV_EDGE = 6;
  const ovSetWindow = (rightT, windowMs) => {
    const { rightT: r, follow } = clampWindow(rightT, windowMs);
    view.rightT = r;
    view.follow = follow;
    view.frozen = false;
  };
  ovCanvas.addEventListener("pointerdown", (e) => {
    const pos = ovPointer(e);
    if (!pos || !ovRange) return;
    e.preventDefault();
    ovCanvas.setPointerCapture(e.pointerId);
    const cssW = ovCanvas.clientWidth || 1;
    const range = ovRange.fullT1 - ovRange.fullT0 || 1;
    const winL = (geom.t1 - view.windowMs - ovRange.fullT0) / range * cssW;
    const winR = (geom.t1 - ovRange.fullT0) / range * cssW;
    if (Math.abs(pos.x - winL) <= OV_EDGE && winR - winL > 12) {
      view.follow = false;
      view.frozen = false;
      drag = { kind: "ov-left", anchorT: currentT1() };
    } else if (Math.abs(pos.x - winR) <= OV_EDGE && winR - winL > 12) {
      view.follow = false;
      view.frozen = false;
      drag = { kind: "ov-right", anchorT: geom.t0 };
    } else if (pos.x > winL && pos.x < winR) {
      view.follow = false;
      view.frozen = false;
      drag = { kind: "ov-pan", grabT: pos.t, startRightT: currentT1() };
    } else {
      ovSetWindow(pos.t + view.windowMs / 2, view.windowMs);
      updateButtons();
    }
    markDirty();
  });
  ovCanvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const pos = ovPointer(e);
    if (!pos || !ovRange) return;
    if (drag.kind === "ov-pan") {
      ovSetWindow(drag.startRightT + (pos.t - drag.grabT), view.windowMs);
      if (view.follow) view.rightT = engine.lastT;
    } else if (drag.kind === "ov-left") {
      const w = clamp(drag.anchorT - pos.t, MIN_WINDOW, MAX_WINDOW);
      view.windowMs = w;
      ovSetWindow(drag.anchorT, w);
      view.follow = false;
    } else if (drag.kind === "ov-right") {
      const w = clamp(pos.t - drag.anchorT, MIN_WINDOW, MAX_WINDOW);
      view.windowMs = w;
      ovSetWindow(pos.t, w);
      view.follow = false;
    } else return;
    updateButtons();
    markDirty();
  });
  const endOvDrag = (e) => {
    if (ovCanvas.hasPointerCapture(e.pointerId)) ovCanvas.releasePointerCapture(e.pointerId);
    if (drag?.kind === "ov-pan" || drag?.kind === "ov-left" || drag?.kind === "ov-right") {
      drag = null;
      updateButtons();
      markDirty();
    }
  };
  ovCanvas.addEventListener("pointerup", endOvDrag);
  ovCanvas.addEventListener("pointercancel", endOvDrag);
  ovCanvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (geom.layout) {
        view.paneScroll = clamp(view.paneScroll + e.deltaY, 0, geom.layout.scrollMax);
        markDirty();
        return;
      }
      const pos = ovPointer(e);
      if (!pos) return;
      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      const oldWindow = view.windowMs;
      const newWindow = Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, oldWindow * factor));
      const anchoredRight = pos.t + (currentT1() - pos.t) * (newWindow / oldWindow);
      view.windowMs = newWindow;
      ovSetWindow(anchoredRight, newWindow);
      updateButtons();
      markDirty();
    },
    { passive: false }
  );
  canvas.addEventListener("pointerleave", () => {
    lastPointer = null;
    view.hoverT = null;
    setHover(null);
    hudEl.style.display = "none";
    markDirty();
  });
  canvas.addEventListener("dblclick", () => {
    view.follow = true;
    view.frozen = false;
    view.windowMs = 1e4;
    view.yRanges.clear();
    view.paneScroll = 0;
    view.cursorA = null;
    view.cursorB = null;
    updateButtons();
    markDirty();
  });
  canvas.addEventListener("click", (e) => {
    if (!cursorMode) return;
    const { x } = pointerPos(e);
    if (!inPlot(x)) return;
    const t = timeAtX(x);
    const px = (c) => geom.plotLeft + (c - geom.t0) / view.windowMs * geom.plotWidth;
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
  let legendChipCount = -1;
  const rebuildLegendStructure = () => {
    closePalette();
    if (engine.channels.length === 0) {
      legendEl.innerHTML = '<span class="wavep-empty">选择数据源并收到数据后，通道将出现在这里</span>';
      legendChipCount = 0;
      return;
    }
    legendEl.innerHTML = engine.channels.map(
      (_, i) => `<span class="wavep-chip" data-index="${i}" title="点击色块换色 / 双击恢复默认；点击其余区域隐藏或显示"><span class="wavep-chip-top"><i class="wavep-dot"></i><span class="wavep-chip-name"></span></span><span class="wavep-chip-bottom"><span class="wavep-chip-val"></span><span class="wavep-chip-delta"></span></span></span>`
    ).join("");
    legendChipCount = engine.channels.length;
    legendEl.classList.toggle("dense", engine.channels.length > 12);
  };
  const updateLegend = () => {
    if (engine.channels.length !== legendChipCount) rebuildLegendStructure();
    if (legendChipCount === 0) return;
    const palette = buildColors().palette;
    const va = view.cursorA !== null ? engine.nearestIndex(view.cursorA) : -1;
    const vb = view.cursorB !== null ? engine.nearestIndex(view.cursorB) : -1;
    const hasDelta = view.cursorA !== null && view.cursorB !== null;
    legendEl.classList.toggle("has-delta", hasDelta);
    for (let i = 0; i < engine.channels.length; i++) {
      const chip = legendEl.querySelector(`.wavep-chip[data-index="${i}"]`);
      if (!chip) continue;
      const ring = engine.channels[i];
      const value = ring.count > 0 ? ring.at(ring.count - 1) : NaN;
      const vaV = va >= 0 ? ring.at(va) : NaN;
      const vbV = vb >= 0 ? ring.at(vb) : NaN;
      const delta = view.cursorA !== null && view.cursorB !== null ? fmtValue(vbV - vaV) : "";
      const visible = engine.visible[i] !== false;
      const color = palette[i % palette.length];
      chip.classList.toggle("off", !visible);
      chip.querySelector(".wavep-dot").style.background = color;
      chip.querySelector(".wavep-chip-name").textContent = engine.names[i] ?? `CH${i + 1}`;
      chip.querySelector(".wavep-chip-val").textContent = fmtValue(value);
      const deltaEl = chip.querySelector(".wavep-chip-delta");
      deltaEl.textContent = delta;
      deltaEl.title = delta ? `游标差值 Δ ${delta}` : "";
    }
  };
  const setHover = (index) => {
    if (view.hoverCh === index) return;
    view.hoverCh = index;
    legendEl.classList.toggle("hovering", index !== null);
    for (const chip of legendEl.querySelectorAll(".wavep-chip")) {
      chip.classList.toggle("hot", index !== null && Number(chip.dataset.index) === index);
    }
    markDirty();
  };
  legendEl.addEventListener("pointerover", (e) => {
    const chip = e.target.closest(".wavep-chip");
    if (chip) setHover(Number(chip.dataset.index));
  });
  legendEl.addEventListener("pointerout", (e) => {
    const chip = e.target.closest(".wavep-chip");
    if (!chip) return;
    const to = e.relatedTarget;
    if (to && chip.contains(to)) return;
    setHover(null);
  });
  legendEl.addEventListener("pointerleave", () => setHover(null));
  legendEl.addEventListener("click", (e) => {
    const target = e.target;
    const chip = target.closest(".wavep-chip");
    if (!chip) return;
    const index = Number(chip.dataset.index);
    if (target.closest(".wavep-dot")) {
      openPalette(index, target.closest(".wavep-dot"));
      return;
    }
    engine.visible[index] = !(engine.visible[index] !== false);
    chip.classList.toggle("off", engine.visible[index] === false);
    markDirty();
  });
  legendEl.addEventListener("dblclick", (e) => {
    const target = e.target;
    const chip = target.closest(".wavep-chip");
    if (!chip || !target.closest(".wavep-dot")) return;
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
    const deltaHint = view.cursorA !== null && view.cursorB !== null ? " · 蓝色数字 = 游标 A→B 差值" : "";
    statsEl.textContent = `帧率 ${fps}/s · 帧 ${s.frames} · 丢帧 ${s.drops} · 解析错误 ${s.errors} · 字节 ${s.bytes} · 通道 ${total}${shown !== total ? `（显示 ${shown}）` : ""}${deltaHint}`;
    windowEl.textContent = `时间窗 ${fmtDuration(view.windowMs)}`;
  };
  let rafId = 0;
  let lastDrawnVersion = -1;
  let lastTheme = null;
  let lastCanvasW = 0;
  let fps = 0;
  let fpsMark = 0;
  let fpsFrames = 0;
  let uiMark = 0;
  let resizeObserver = null;
  unsubs.push(
    ctx.onThemeChange((t) => {
      lastTheme = null;
      ovStripAt = 0;
      void t;
      if (paletteOpenIndex >= 0 && paletteCleanup) {
        const idx = paletteOpenIndex;
        const anchor = document.querySelector(`.wavep-chip[data-index="${idx}"] .wavep-dot`);
        closePalette();
        if (anchor) openPalette(idx, anchor);
      }
      markDirty();
    })
  );
  const ovCache = document.createElement("canvas");
  let ovStripAt = 0;
  const renderOverview = () => {
    const now = performance.now();
    const g = ovCanvas.getContext("2d");
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
      ovStripAt = 0;
    }
    if (canvas.clientWidth !== lastCanvasW) {
      lastCanvasW = canvas.clientWidth;
      viewDirty = true;
    }
    if (engine.version !== lastDrawnVersion || viewDirty) {
      lastDrawnVersion = engine.version;
      viewDirty = false;
      geom = drawWave(canvas, engine, view, buildColors());
      renderOverview();
      syncVScroll();
    }
  };
  const loop = (now) => {
    draw();
    if (now - fpsMark >= 1e3) {
      fps = Math.max(0, engine.stats.frames - fpsFrames);
      fpsFrames = engine.stats.frames;
      fpsMark = now;
    }
    if (now - uiMark >= 200) {
      uiMark = now;
      updateLegend();
      renderStatus();
      if (measureOpen) renderMeasure();
      if (mathOpen) renderMath();
      if (view.hoverT !== null) updateHud();
    }
    rafId = requestAnimationFrame(loop);
  };
  const restore = () => {
    try {
      const saved = ctx.storage.get(
        "wave-view",
        null
      );
      if (!saved) return;
      if (typeof saved.overlay === "boolean") view.overlay = saved.overlay;
      if (typeof saved.windowMs === "number")
        view.windowMs = Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, saved.windowMs));
      if (saved.style === "line" || saved.style === "dots" || saved.style === "bars") view.style = saved.style;
      if (saved.colors && typeof saved.colors === "object") {
        for (const [k, v] of Object.entries(saved.colors)) {
          const idx = Number(k);
          if (Number.isInteger(idx) && idx >= 0 && /^#[0-9a-fA-F]{6}$/.test(String(v))) colorOverrides[idx] = String(v);
        }
      }
      updateButtons();
      btnStyle.textContent = STYLE_LABEL[view.style] ?? "曲线";
    } catch {
    }
  };
  restore();
  resizeObserver = new ResizeObserver(() => markDirty());
  resizeObserver.observe(wrap);
  rafId = requestAnimationFrame(loop);
  markDirty();
  const persist = () => {
    try {
      ctx.storage.set("wave-view", { overlay: view.overlay, windowMs: view.windowMs, style: view.style, colors: { ...colorOverrides } });
    } catch {
    }
  };
  return () => {
    cancelAnimationFrame(rafId);
    closePalette();
    resizeObserver?.disconnect();
    unsubs.forEach((fn) => fn());
    persist();
  };
};
export {
  activate as default
};
