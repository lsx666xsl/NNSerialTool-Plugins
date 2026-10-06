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
  g.fillText("暂无数据 — 在上方选择已连接的会话开始采集", x + w / 2, y + h / 2);
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

// plugins/wave/src/firmware.ts
var FIRMWARE_FILES = [
  {
    name: "nnwave.h",
    text: `/*
 * NN-Wave v1 —— 轻量二进制波形协议（发送端）
 * 帧格式: [AA 55][type][N][seq][float32×N 小端][CRC8]
 *   type 0x01 = 数据帧（N 个 float32）
 *   type 0x02 = 通道名元数据帧（payload 为若干 [len][utf8]，补 0x00 到 4N 字节）
 *   CRC8 多项式 0x07，初值 0x00，覆盖 type..data
 * 上位机：NNSerialTool 波形插件（协议选 NN-Wave）
 */
#ifndef NNWAVE_H
#define NNWAVE_H

#include <stddef.h>
#include <stdint.h>

#define NNWAVE_MAX_CHANNELS 64

typedef struct {
    int (*write)(const uint8_t *data, size_t len); /* 阻塞发送回调，返回 0 表示成功 */
    uint8_t seq;                                   /* 帧序号，自动递增（上位机据此统计丢帧） */
} nnwave_t;

/* 初始化：注入发送回调（如 HAL_UART_Transmit 的包装） */
int nnwave_init(nnwave_t *h, int (*write)(const uint8_t *data, size_t len));

/* 发送一帧数据：channels[0..count-1] 对应波形 CH1..CHn */
int nnwave_send(nnwave_t *h, const float *channels, uint8_t count);

/* （可选）发送通道名，波形图例将显示这些名字；上电时发一次即可 */
int nnwave_send_names(nnwave_t *h, const char *const *names, uint8_t count);

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

## 带宽参考

帧长 = 6 + 4×通道数 字节。
8 通道 @100Hz ≈ 3.3 KB/s，9600 波特率即可跑；1 通道 @1kHz ≈ 10 KB/s。
大端核（极少见）需在 \`nnwave_send\` 里逐字节装填 float。`
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
.wavep-dot { cursor:pointer; }
.wavep-color-input { position:absolute; width:0; height:0; opacity:0; pointer-events:none; }
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
        <button type="button" class="wavep-btn wavep-clear">清空</button>
        <button type="button" class="wavep-btn wavep-export">导出SVG</button>
        <button type="button" class="wavep-btn wavep-export-protocol">导出协议文件</button>
      </div>
      <div class="wavep-wrap"><canvas class="wavep-canvas"></canvas></div>
      <div class="wavep-legend"></div>
      <div class="wavep-status"><span class="wavep-stats"></span><span class="wavep-window"></span></div>
      <input type="color" class="wavep-color-input" />
    </div>`;
  const root = el.querySelector(".wavep");
  const canvas = el.querySelector(".wavep-canvas");
  const wrap = el.querySelector(".wavep-wrap");
  const sourceSel = el.querySelector(".wavep-source");
  const btnOverlay = el.querySelector(".wavep-overlay");
  const btnFreeze = el.querySelector(".wavep-freeze");
  const btnFollow = el.querySelector(".wavep-follow");
  const btnCursor = el.querySelector(".wavep-cursorbtn");
  const btnClear = el.querySelector(".wavep-clear");
  const btnSvgExport = el.querySelector(".wavep-export");
  const btnExport = el.querySelector(".wavep-export-protocol");
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
  let pendingColorIndex = -1;
  const colorInput = el.querySelector(".wavep-color-input");
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
    updateButtons();
    markDirty();
  });
  const btnStyle = el.querySelector(".wavep-style");
  btnStyle.addEventListener("click", () => {
    const order = STYLE_ORDER;
    view.style = order[(order.indexOf(view.style) + 1) % order.length];
    btnStyle.textContent = view.style === "line" ? "曲线" : view.style === "dots" ? "点" : "峰谷";
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
    markDirty();
  });
  const exportProtocol = () => {
    void (async () => {
      if (!ctx.exportTextFiles) {
        ctx.notify("当前应用版本过旧，不支持文件导出");
        return;
      }
      const dir = await ctx.exportTextFiles("选择协议文件导出目录", FIRMWARE_FILES, "NN-Wave协议文件");
      if (dir) ctx.notify(`协议文件已导出到 ${dir} 的 NN-Wave协议文件 子目录`);
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
      const dir = await ctx.exportTextFiles("选择SVG导出目录", [{ name: `wave-${stamp}.svg`, text: svg }], "NN-Wave波形快照");
      if (dir) ctx.notify(`波形 SVG 已导出到 ${dir} 的 NN-Wave波形快照 子目录`);
    })();
  };
  btnSvgExport.addEventListener("click", exportSvg);
  btnExport.addEventListener("click", exportProtocol);
  const pointerPos = (e) => {
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width / (canvas.clientWidth || 1);
    return { x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale };
  };
  let geom = { t0: 0, t1: 0, plotLeft: 0, plotWidth: 1 };
  const inPlot = (x) => x >= geom.plotLeft && x <= geom.plotLeft + geom.plotWidth;
  const timeAtX = (x) => geom.t0 + (x - geom.plotLeft) / geom.plotWidth * view.windowMs;
  const currentT1 = () => view.frozen ? view.rightT : view.follow ? engine.lastT : view.rightT;
  const findPaneChannel = (y) => {
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
      if (!inPlot(x)) return;
      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      if (e.shiftKey) {
        scaleY(findPaneChannel(y), factor);
        return;
      }
      const tAt = timeAtX(x);
      const newWindow = Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, view.windowMs * factor));
      const rightEdge = geom.plotLeft + geom.plotWidth;
      const newRightT = tAt + (rightEdge - x) / geom.plotWidth * newWindow;
      view.windowMs = newWindow;
      if (view.follow && x > rightEdge - 40) {
      } else {
        view.follow = newRightT >= engine.lastT - 1;
        view.rightT = view.follow ? engine.lastT : newRightT;
      }
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
    if (!drag) return;
    const { x, y } = pointerPos(e);
    if (drag.kind === "pan") {
      const dt = (x - drag.startX) / geom.plotWidth * view.windowMs;
      view.rightT = drag.startRightT - dt;
      view.follow = !view.frozen && view.rightT >= engine.lastT - 1;
      if (view.follow) view.rightT = engine.lastT;
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
  canvas.addEventListener("dblclick", () => {
    view.follow = true;
    view.frozen = false;
    view.windowMs = 1e4;
    view.yRanges.clear();
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
    if (engine.channels.length === 0) {
      legendEl.innerHTML = '<span class="wavep-empty">选择数据源并收到数据后，通道将出现在这里</span>';
      legendChipCount = 0;
      return;
    }
    legendEl.innerHTML = engine.channels.map(
      (_, i) => `<span class="wavep-chip" data-index="${i}" title="点击色块换色 / 双击恢复默认；点击其余区域隐藏或显示"><i class="wavep-dot"></i><span class="wavep-chip-name"></span><span class="wavep-chip-val"></span><span class="wavep-chip-delta"></span></span>`
    ).join("");
    legendChipCount = engine.channels.length;
  };
  const updateLegend = () => {
    if (engine.channels.length !== legendChipCount) rebuildLegendStructure();
    if (legendChipCount === 0) return;
    const palette = buildColors().palette;
    const va = view.cursorA !== null ? engine.nearestIndex(view.cursorA) : -1;
    const vb = view.cursorB !== null ? engine.nearestIndex(view.cursorB) : -1;
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
      chip.querySelector(".wavep-chip-delta").textContent = delta ? "Δ " + delta : "";
    }
  };
  legendEl.addEventListener("click", (e) => {
    const target = e.target;
    const chip = target.closest(".wavep-chip");
    if (!chip) return;
    const index = Number(chip.dataset.index);
    if (target.closest(".wavep-dot")) {
      pendingColorIndex = index;
      colorInput.value = buildColors().palette[index % buildColors().palette.length];
      colorInput.click();
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
  colorInput.addEventListener("change", () => {
    if (pendingColorIndex < 0) return;
    const v = colorInput.value;
    if (/^#[0-9a-fA-F]{6}$/.test(v)) {
      colorOverrides[pendingColorIndex] = v;
      persist();
      markDirty();
      updateLegend();
    }
    pendingColorIndex = -1;
  });
  const renderStatus = () => {
    const s = engine.stats;
    statsEl.textContent = `帧率 ${fps}/s · 帧 ${s.frames} · 丢帧 ${s.drops} · 解析错误 ${s.errors} · 字节 ${s.bytes}`;
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
  const loop = (now) => {
    draw();
    if (now - fpsMark >= 1e3) {
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
    resizeObserver?.disconnect();
    unsubs.forEach((fn) => fn());
    persist();
  };
};
export {
  activate as default
};
