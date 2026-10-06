// plugins/wave/src/engine.ts
var RING_CAPACITY = 2e5;
var Ring = class {
  constructor(capacity, ctor) {
    this.capacity = capacity;
    this.data = new ctor(capacity);
  }
  data;
  head = 0;
  count = 0;
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
  capacity = RING_CAPACITY;
  t = new Ring(RING_CAPACITY, Float64Array);
  channels = [];
  names = [];
  visible = [];
  attachedSessionId = "";
  stats = { frames: 0, bytes: 0, drops: 0, errors: 0 };
  version = 0;
  parser = null;
  protocolId = "";
  lastSeq = -1;
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
    this.t.push(f.t);
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
  cursorB: null
});
var MIN_WINDOW = 100;
var MAX_WINDOW = 30 * 6e4;
var AXIS_WIDTH = 64;
var TIME_AXIS_H = 22;
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
  if (!isFinite(v)) return "\u2014";
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
var drawWave = (canvas, engine, view, colors) => {
  const zoom = Number(document.documentElement.style.zoom) || 1;
  const dpr = (window.devicePixelRatio || 1) * zoom;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  const g = canvas.getContext("2d");
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
  const visIdx = [];
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
  const panes = view.overlay ? [{ channels: visIdx, top: plotTop, height: plotBottom - plotTop }] : visIdx.map((ch, i) => ({
    channels: [ch],
    top: plotTop + (plotBottom - plotTop) / visIdx.length * i,
    height: (plotBottom - plotTop) / visIdx.length
  }));
  const px = (t) => plotLeft + (t - t0) / view.windowMs * plotW;
  for (const pane of panes) {
    const auto = /* @__PURE__ */ new Map();
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
      for (const ch of pane.channels) {
        const r = yRangeOf(ch);
        lo = Math.min(lo, r.min);
        hi = Math.max(hi, r.max);
      }
      const pad = (hi - lo) * 0.1;
      paneRange = { min: lo - pad, max: hi + pad };
    }
    const cols = Math.max(1, Math.floor(plotW));
    for (const ch of pane.channels) {
      const range = view.overlay && paneRange ? paneRange : yRangeOf(ch);
      const yOf = (v) => pane.top + pane.height - (v - range.min) / (range.max - range.min) * pane.height;
      const color = colors.palette[ch % colors.palette.length];
      g.lineJoin = "round";
      g.lineCap = "round";
      if (view.style === "bars") {
        const mins = new Float32Array(cols).fill(Infinity);
        const maxs = new Float32Array(cols).fill(-Infinity);
        for (let i = i0; i < i1; i++) {
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
        g.lineWidth = 1.25;
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
        const stride = total > 8e3 ? Math.ceil(total / 8e3) : 1;
        for (let i = i0; i < i1; i += stride) {
          const t = engine.t.at(i);
          if (t < t0 || t > t1) continue;
          const x = plotLeft + (t - t0) / view.windowMs * plotW;
          const y = yOf(engine.channels[ch].at(i));
          g.fillRect(x - 1.5, y - 1.5, 3, 3);
        }
      } else {
        g.beginPath();
        g.strokeStyle = color;
        g.lineWidth = 1.6;
        const total = i1 - i0;
        const stride = total > 2e4 ? Math.ceil(total / 2e4) : 1;
        let started = false;
        for (let i = i0; i < i1; i += stride) {
          const t = engine.t.at(i);
          if (t < t0 || t > t1) continue;
          const x = plotLeft + (t - t0) / view.windowMs * plotW;
          const y = yOf(engine.channels[ch].at(i));
          if (!started) {
            g.moveTo(x, y);
            started = true;
          } else {
            g.lineTo(x, y);
          }
        }
        g.stroke();
      }
    }
    g.strokeStyle = colors.border;
    g.lineWidth = 1;
    g.strokeRect(plotLeft + 0.5, pane.top + 0.5, plotW - 1, pane.height - 1);
    {
      const range = view.overlay && paneRange ? paneRange : yRangeOf(pane.channels[0]);
      const step = niceStep(range.max - range.min, 4);
      g.fillStyle = colors.textDim;
      g.font = "10px Consolas, monospace";
      g.textAlign = "left";
      g.textBaseline = "middle";
      for (let v = Math.ceil(range.min / step) * step; v <= range.max; v += step) {
        const y = pane.top + pane.height - (v - range.min) / (range.max - range.min) * pane.height;
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
  drawTimeAxis(g, t0, t1, plotLeft, plotW, plotBottom, colors);
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
var drawEmpty = (g, x, y, w, h, colors) => {
  g.fillStyle = colors.textDim;
  g.font = "12px sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("\u6682\u65E0\u6570\u636E \u2014 \u5728\u4E0A\u65B9\u9009\u62E9\u5DF2\u8FDE\u63A5\u7684\u4F1A\u8BDD\u5F00\u59CB\u91C7\u96C6", x + w / 2, y + h / 2);
};
var drawTimeAxis = (g, t0, t1, plotLeft, plotW, plotBottom, colors) => {
  const step = niceStep(t1 - t0, 8);
  g.fillStyle = colors.textDim;
  g.font = "10px Consolas, monospace";
  g.textAlign = "center";
  g.textBaseline = "top";
  g.strokeStyle = colors.grid;
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
    const x = plotLeft + (t - t0) / (t1 - t0) * plotW;
    if (x < plotLeft || x > plotLeft + plotW) continue;
    g.fillText(fmtDuration(t - t0), x, plotBottom + 6);
    g.beginPath();
    g.moveTo(Math.round(x) + 0.5, plotBottom);
    g.lineTo(Math.round(x) + 0.5, plotBottom + 4);
    g.stroke();
  }
};

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
export {
  AXIS_WIDTH,
  MAX_WINDOW,
  MIN_WINDOW,
  RING_CAPACITY,
  Ring,
  TIME_AXIS_H,
  WaveEngine,
  crc8,
  createNnWaveParser,
  defaultViewState,
  drawWave,
  fmtDuration,
  fmtValue,
  lastYRanges,
  niceStep
};
