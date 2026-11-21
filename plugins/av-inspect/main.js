var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// plugins/av-inspect/src/container.ts
var fourcc = (b, o) => {
  if (o + 4 > b.length) return "????";
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]).replace(/[^\x20-\x7e]/g, ".");
};
var u16 = (b, o) => o + 2 <= b.length ? b[o] << 8 | b[o + 1] : 0;
var u32 = (b, o) => o + 4 <= b.length ? b[o] * 16777216 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3] : 0;
var u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
var le16 = (b, o) => o + 2 <= b.length ? b[o] | b[o + 1] << 8 : 0;
var le32 = (b, o) => o + 4 <= b.length ? b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] * 16777216 : 0;
var MP4_CONTAINERS = /* @__PURE__ */ new Set([
  "moov",
  "trak",
  "mdia",
  "minf",
  "stbl",
  "edts",
  "dinf",
  "udta",
  "mvex",
  "moof",
  "traf",
  "ilst",
  "wave",
  "sinf",
  "schi",
  "meta",
  "tref",
  "ipro",
  "mfra",
  "skip",
  "free"
]);
var MP4_SAMPLE_CODECS = {
  avc1: "H.264",
  avc3: "H.264",
  hvc1: "H.265",
  hev1: "H.265",
  av01: "AV1",
  vp09: "VP9",
  mp4a: "AAC",
  ac_3: "AC-3",
  ec_3: "E-AC-3",
  opus: "Opus",
  alac: "ALAC"
};
function isMp4(b) {
  return b.length >= 12 && fourcc(b, 4) === "ftyp";
}
function isAvi(b) {
  return b.length >= 12 && fourcc(b, 0) === "RIFF" && fourcc(b, 8) === "AVI ";
}
function parseMp4(b) {
  const nodes = [];
  const info = { container: "MP4 / ISO BMFF" };
  let trackCount = 0;
  let sampleCount = 0;
  let video = "";
  let audio = "";
  let duration = 0;
  let timescale = 0;
  let trackTimescale = 0;
  let curHandler = "";
  let boxCount = 0;
  const addNode = (offset, size, type, depth, detail = "") => {
    if (nodes.length >= 5e3) return;
    boxCount++;
    nodes.push({
      offset,
      size,
      type,
      depth,
      label: type === "stsd" ? "stsd (编码配置)" : type,
      detail
    });
  };
  const parseStsd = (start, end, depth) => {
    const count = u32(b, start + 4);
    let p = start + 8;
    for (let i = 0; i < count && p + 8 <= end && i < 64; i++) {
      const size = u32(b, p);
      if (size < 8 || p + size > end) break;
      const type = fourcc(b, p + 4);
      const codec = MP4_SAMPLE_CODECS[type] ?? "";
      let detail = codec;
      if (type === "avc1" || type === "avc3" || type === "hvc1" || type === "hev1" || type === "av01" || type === "vp09") {
        const w = u16(b, p + 32);
        const h = u16(b, p + 34);
        if (w && h) detail += ` ${w}×${h}`;
        if (w && h) info.video = `${codec} ${w}×${h}`;
        video = codec;
      } else if (type === "mp4a" || type === "ac_3" || type === "ec_3" || type === "opus" || type === "alac") {
        const ch = u16(b, p + 24);
        const rate = u32(b, p + 32) / 65536;
        if (ch) detail += ` ${ch}ch`;
        if (rate) detail += ` ${Math.round(rate)}Hz`;
        if (ch || rate) info.audio = `${codec} ${ch}ch ${Math.round(rate)}Hz`;
        audio = codec;
      }
      addNode(p, size, type, depth, detail);
      p += size;
    }
  };
  const walk = (start, end, depth) => {
    let p = start;
    let guard = 0;
    while (p + 8 <= end && guard++ < 2e5) {
      let size = u32(b, p);
      const type = fourcc(b, p + 4);
      if (size === 1) size = u64(b, p + 8);
      if (size === 0) size = end - p;
      if (size < 8 || p + size > end) break;
      const payload = p + 8;
      let detail = "";
      if (type === "ftyp") {
        const brand = fourcc(b, payload);
        detail = `brand ${brand}`;
        info.brand = brand;
      } else if (type === "mvhd") {
        const v = b[payload];
        timescale = u32(b, payload + (v === 1 ? 20 : 12));
        duration = v === 1 ? u64(b, payload + 24) : u32(b, payload + 16);
        if (timescale && duration) info.duration = `${(duration / timescale).toFixed(3)} s`;
      } else if (type === "mdhd") {
        const v = b[payload];
        const ts = u32(b, payload + (v === 1 ? 20 : 12));
        if (ts) trackTimescale = ts;
        if (ts && !timescale) timescale = ts;
      } else if (type === "trak") {
        trackCount++;
      } else if (type === "hdlr") {
        const handler = fourcc(b, payload + 8);
        curHandler = handler;
        if (handler === "vide") info.video_handler = "vide";
        if (handler === "soun") info.audio_handler = "soun";
      } else if (type === "stts") {
        sampleCount += u32(b, payload + 8);
        const entryCount = Math.min(64, u32(b, payload + 4));
        let cnt = 0;
        let dur = 0;
        for (let k = 0; k < entryCount; k++) {
          const o = payload + 8 + k * 8;
          if (o + 8 > p + size) break;
          cnt += u32(b, o);
          dur += u32(b, o + 4) * u32(b, o);
        }
        if (cnt > 0 && dur > 0) {
          const ts = trackTimescale || timescale || 0;
          if (ts) {
            const lastSec = dur / ts;
            const intervalMs = dur / cnt / ts * 1e3;
            const fps = intervalMs > 0 ? 1e3 / intervalMs : 0;
            const txt = `首帧 0.000s / 末帧 ${lastSec.toFixed(3)}s / 间隔 ${intervalMs.toFixed(2)}ms${fps ? ` / ${fps.toFixed(3)} fps` : ""}`;
            if (curHandler === "soun") info.audio_pts = txt;
            else info.video_pts = txt;
          }
        }
        detail = `${u32(b, payload + 4)} 组时长`;
      } else if (type === "ctts") {
        const entryCount = Math.min(256, u32(b, payload + 4));
        let nonzero = 0;
        for (let k = 0; k < entryCount; k++) {
          const o = payload + 8 + k * 8;
          if (o + 8 > p + size) break;
          if (u32(b, o + 4) !== 0) nonzero++;
        }
        detail = nonzero ? `CTTS 非零偏移 ${nonzero} 组（B 帧重排）` : "CTTS 全零（无重排）";
        if (nonzero) info[`${curHandler === "soun" ? "audio" : "video"}_ctts`] = `${nonzero} 组非零（有 B 帧重排）`;
      } else if (type === "stsz") {
      } else if (type === "mdat") {
        detail = "媒体数据";
      }
      addNode(p, size, type, depth, detail);
      if (type === "stsd") parseStsd(payload, p + size, depth + 1);
      else if (MP4_CONTAINERS.has(type)) {
        walk(payload + (type === "meta" ? 4 : 0), p + size, depth + 1);
      }
      p += size;
    }
  };
  walk(0, b.length, 0);
  info.tracks = trackCount;
  if (sampleCount) info.samples = sampleCount;
  if (video) info.video_codec = video;
  if (audio) info.audio_codec = audio;
  info.boxes = boxCount;
  return { format: "MP4", info, nodes };
}
function parseAvi(b) {
  const nodes = [];
  const info = { container: "AVI / RIFF" };
  let videoCodec = "";
  let frames = 0;
  let width = 0;
  let height = 0;
  let fps = 0;
  let chunkCount = 0;
  const walk = (start, end, depth) => {
    let p = start;
    let guard = 0;
    while (p + 8 <= end && guard++ < 2e5) {
      const id = fourcc(b, p);
      const size = le32(b, p + 4);
      if (size < 0 || p + 8 + size > b.length) break;
      const data = p + 8;
      let detail = "";
      if (id === "LIST") {
        const listType = fourcc(b, data);
        detail = listType;
        if (nodes.length < 5e3) {
          nodes.push({ offset: p, size: size + 8, type: `LIST ${listType}`, label: `LIST ${listType}`, detail, depth });
        }
        walk(data + 4, Math.min(b.length, data + size), depth + 1);
      } else {
        if (nodes.length >= 5e3) return;
        if (id === "avih") {
          const us = le32(b, data);
          frames = le32(b, data + 16);
          width = le32(b, data + 32);
          height = le32(b, data + 36);
          if (us) fps = 1e6 / us;
          detail = `${width}×${height} ${frames} 帧`;
        } else if (id === "strh") {
          const type = fourcc(b, data);
          const handler = fourcc(b, data + 4);
          const scale = le32(b, data + 20);
          const rate = le32(b, data + 24);
          const length = le32(b, data + 32);
          if (type === "vids") {
            videoCodec = handler;
            if (scale) fps = rate / scale;
            if (!frames) frames = length;
            detail = `vids ${handler} ${fps ? fps.toFixed(3) + " fps" : ""}`;
          } else if (type === "auds") {
            detail = `auds ${handler}`;
          }
        } else if (id === "strf") {
          const w = le32(b, data + 4);
          const h = le32(b, data + 8);
          const bits = le16(b, data + 14);
          if (w > 0 && h > 0 && w < 16384 && h < 16384) {
            width = w;
            height = h;
            detail = `${w}×${h} ${bits}bit`;
          } else {
            const ch = le16(b, data + 2);
            const rate = le32(b, data + 4);
            detail = `${ch}ch ${rate}Hz`;
            info.audio = `${ch}ch ${rate}Hz`;
          }
        } else if (id === "movi") {
          detail = "媒体数据";
        } else if (id === "idx1") {
          detail = `${size / 16} 个索引`;
        }
        if (id === "00dc" || id === "00db" || id === "01wb") chunkCount++;
        if (nodes.length < 5e3) {
          nodes.push({ offset: p, size: size + 8, type: id, label: id, detail, depth });
        }
      }
      p = data + size + (size & 1);
    }
  };
  walk(12, Math.min(b.length, le32(b, 4) + 8), 0);
  if (width && height) info.resolution = `${width}×${height}`;
  if (videoCodec) info.video_codec = videoCodec;
  if (fps) info.fps = fps.toFixed(3);
  if (frames) info.frames = frames;
  if (chunkCount) info.media_chunks = chunkCount;
  info.chunks = nodes.length;
  return { format: "AVI", info, nodes };
}

// plugins/av-inspect/src/main.ts
var H264_NAMES = {
  1: "SLICE",
  2: "SLICE-DPA",
  3: "SLICE-DPB",
  4: "SLICE-DPC",
  5: "IDR",
  6: "SEI",
  7: "SPS",
  8: "PPS",
  9: "AUD",
  10: "END-SEQ",
  11: "END-STREAM",
  12: "FILLER",
  13: "SPS-EXT",
  14: "PREFIX",
  15: "SUBSET-SPS",
  19: "AUX-SLICE"
};
var H265_NAMES = {
  0: "TRAIL-N",
  1: "TRAIL-R",
  2: "TSA-N",
  3: "TSA-R",
  4: "STSA-N",
  5: "STSA-R",
  6: "RADL-N",
  7: "RADL-R",
  8: "RASL-N",
  9: "RASL-R",
  16: "BLA-W-LP",
  17: "BLA-W-RADL",
  18: "BLA-N-LP",
  19: "BLA-N-RADL",
  20: "IDR-W-RADL",
  21: "IDR-N-LP",
  32: "VPS",
  33: "SPS",
  34: "PPS",
  35: "AUD",
  39: "SEI-PREFIX",
  40: "SEI-SUFFIX"
};
var SAMPLE_RATES = [96e3, 88200, 64e3, 48e3, 44100, 32e3, 24e3, 22050, 16e3, 12e3, 11025, 8e3, 7350];
var TS_STREAM_TYPES = {
  15: "AAC ADTS",
  27: "H.264",
  36: "H.265",
  3: "MPEG-2 audio",
  4: "MPEG-2 audio",
  129: "AC-3",
  135: "E-AC-3",
  21: "ID3/metadata"
};
var hex = (b, n = 64) => Array.from(b.slice(0, n), (x) => x.toString(16).padStart(2, "0")).join(" ");
function detectFormat(b) {
  if (b.length < 4) return null;
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "mjpeg";
  if (b[0] === 82 && b[1] === 73 && b[2] === 70 && b[3] === 70 && b[8] === 87 && b[9] === 65 && b[10] === 86 && b[11] === 69) return "wav";
  for (let i = 0; i < Math.min(400, b.length - 376); i++) {
    if (b[i] === 71 && b[i + 188] === 71 && b[i + 376] === 71) return "ts";
  }
  for (let i = 0; i < Math.min(4096, b.length - 7); i++) {
    if (b[i] === 255 && (b[i + 1] & 246) === 240) {
      const len = (b[i + 3] & 3) << 11 | b[i + 4] << 3 | b[i + 5] >> 5;
      if (len >= 7 && len <= 8191 && i + len <= b.length + 1) return "aac";
    }
  }
  return detectNalFormat(b);
}
function detectNalFormat(b) {
  const HEVC_HEADERS = [64, 66, 68, 78, 80];
  const limit = Math.min(b.length, 256 * 1024);
  for (let from = 0; from < limit; ) {
    const sc = findStart(b, from);
    if (!sc) return null;
    const pos = sc.pos + sc.len;
    if (pos >= b.length) return null;
    const h = b[pos];
    const hevcType = h >> 1 & 63;
    const h264Type = h & 31;
    if (HEVC_HEADERS.includes(h)) return "h265";
    if (hevcType > 40 && h264Type >= 1 && h264Type <= 23) return "h264";
    from = pos;
  }
  return null;
}
function findStart(b, from) {
  for (let i = Math.max(0, from); i + 3 <= b.length; i++) {
    if (b[i] === 0 && b[i + 1] === 0) {
      if (b[i + 2] === 1) return { pos: i, len: 3 };
      if (i + 3 < b.length && b[i + 2] === 0 && b[i + 3] === 1) return { pos: i, len: 4 };
    }
  }
  return null;
}
function trimZeros(b) {
  let end = b.length;
  while (end > 0 && b[end - 1] === 0) end--;
  return b.slice(0, end);
}
var BitReader = class {
  constructor(data) {
    this.data = data;
    __publicField(this, "bit", 0);
  }
  u(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (this.bit >= this.data.length * 8) throw new Error("SPS 越界");
      const byte = this.data[this.bit >> 3];
      const bit = byte >> 7 - (this.bit & 7) & 1;
      v = v * 2 + bit;
      this.bit++;
    }
    return v;
  }
  ue() {
    let zeros = 0;
    while (this.u(1) === 0) {
      zeros++;
      if (zeros > 31) throw new Error("SPS ue 越界");
    }
    return 2 ** zeros - 1 + (zeros ? this.u(zeros) : 0);
  }
  se() {
    const v = this.ue();
    return v & 1 ? (v + 1) / 2 : -(v / 2);
  }
};
function stripEmulation(b) {
  const out = [];
  for (let i = 0; i < b.length; i++) {
    if (i >= 2 && b[i] === 3 && b[i - 1] === 0 && b[i - 2] === 0) continue;
    out.push(b[i]);
  }
  return Uint8Array.from(out);
}
var SLICE_TYPES = ["P", "B", "I", "SP", "SI"];
function parseH264SliceType(payload) {
  try {
    const rbsp = stripEmulation(payload.subarray(1));
    if (rbsp.length < 1) return null;
    const br = new BitReader(rbsp);
    br.ue();
    const st = br.ue();
    const base = SLICE_TYPES[st % 5];
    return base ?? null;
  } catch {
    return null;
  }
}
function parseJpegFrame(b, start) {
  let end = -1;
  for (let k = start + 2; k + 1 < b.length; k++) {
    if (b[k] === 255 && b[k + 1] === 217) {
      end = k + 2;
      break;
    }
  }
  if (end < 0) return null;
  let i = start + 2;
  let width = 0;
  let height = 0;
  let comps = 0;
  let sawSof = false;
  let qtables = 0;
  let q0 = 0;
  let subsampling = "";
  while (i + 1 < end) {
    if (b[i] !== 255) {
      i++;
      continue;
    }
    const marker = b[i + 1];
    if (marker === 217) break;
    if (marker === 0 || marker === 255) {
      i += marker === 255 ? 1 : 2;
      continue;
    }
    if (marker >= 208 && marker <= 216) {
      i += 2;
      continue;
    }
    if (i + 3 >= end) break;
    const len = b[i + 2] << 8 | b[i + 3];
    if (len < 2) break;
    if (marker === 219 && i + 4 < end) {
      const pq = b[i + 4] >> 4;
      const tq = b[i + 4] & 15;
      if (pq === 0 && i + 5 < end) {
        qtables = Math.max(qtables, tq + 1);
        if (q0 === 0) q0 = b[i + 5];
      } else if (pq === 1 && i + 6 < end) {
        qtables = Math.max(qtables, tq + 1);
        if (q0 === 0) q0 = b[i + 5] << 8 | b[i + 6];
      }
    }
    const isSof = marker >= 192 && marker <= 207 && marker !== 196 && marker !== 200 && marker !== 204;
    if (isSof && i + 9 < end) {
      height = b[i + 5] << 8 | b[i + 6];
      width = b[i + 7] << 8 | b[i + 8];
      comps = b[i + 9];
      if (comps >= 3 && i + 9 + comps * 3 <= end + 2) {
        const ySamp = b[i + 11];
        const cSamp = b[i + 14];
        const yh = ySamp >> 4;
        const yv = ySamp & 15;
        const ch = cSamp >> 4;
        const cv = cSamp & 15;
        if (yh === 2 && yv === 2 && ch === 1 && cv === 1) subsampling = "4:2:0";
        else if (yh === 2 && yv === 1 && ch === 1 && cv === 1) subsampling = "4:2:2";
        else if (yh === 1 && yv === 1) subsampling = "4:4:4";
        else subsampling = `${yh}x${yv}`;
      } else if (comps === 1) {
        subsampling = "4:0:0 (灰度)";
      }
      sawSof = true;
      break;
    }
    i += 2 + len;
  }
  if (!sawSof) return null;
  return { width, height, comps, size: end - start, qtables, q0, subsampling };
}
function skipScalingList(br, size) {
  let last = 8;
  let next = 8;
  for (let j = 0; j < size; j++) {
    if (next !== 0) {
      const delta = br.se();
      next = (last + delta + 256) % 256;
    }
    last = next === 0 ? last : next;
  }
}
function parseH264Sps(nal) {
  const rbsp = stripEmulation(nal.slice(1));
  const br = new BitReader(rbsp);
  const profile = br.u(8);
  br.u(8);
  const level = br.u(8);
  br.ue();
  let chroma = 1;
  const high = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];
  if (high.includes(profile)) {
    chroma = br.ue();
    if (chroma === 3) br.u(1);
    br.ue();
    br.ue();
    br.u(1);
    if (br.u(1)) {
      for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
        if (br.u(1)) skipScalingList(br, i < 6 ? 16 : 64);
      }
    }
  }
  br.ue();
  const pocType = br.ue();
  if (pocType === 0) br.ue();
  else if (pocType === 1) {
    br.u(1);
    br.se();
    br.se();
    const n = br.ue();
    for (let i = 0; i < n; i++) br.se();
  }
  br.ue();
  br.u(1);
  const wMbs = br.ue() + 1;
  const hMap = br.ue() + 1;
  const frameMbsOnly = br.u(1);
  if (!frameMbsOnly) br.u(1);
  br.u(1);
  let cropL = 0, cropR = 0, cropT = 0, cropB = 0;
  if (br.u(1)) {
    cropL = br.ue();
    cropR = br.ue();
    cropT = br.ue();
    cropB = br.ue();
  }
  const cropX = chroma === 3 ? 1 : 2;
  const cropY = chroma === 1 ? 2 : 1;
  const width = wMbs * 16 - (cropL + cropR) * cropX;
  const height = (2 - frameMbsOnly) * hMap * 16 - (cropT + cropB) * cropY;
  const out = {
    profile: `H.264 profile ${profile}`,
    level: (level / 10).toFixed(1),
    resolution: `${width}×${height}`,
    chroma: chroma === 1 ? "4:2:0" : chroma === 2 ? "4:2:2" : "4:4:4"
  };
  try {
    const u322 = () => br.u(16) * 65536 + br.u(16);
    if (br.u(1)) {
      if (br.u(1)) {
        const idc = br.u(8);
        if (idc === 255) {
          const sarW = br.u(16);
          const sarH = br.u(16);
          out.aspect_ratio = `${sarW}:${sarH}`;
        } else {
          out.aspect_ratio = idc === 1 ? "1:1" : `idc ${idc}`;
        }
      }
      if (br.u(1)) br.u(1);
      if (br.u(1)) {
        br.u(3);
        br.u(1);
        if (br.u(1)) {
          br.u(8);
          br.u(8);
          br.u(8);
        }
      }
      if (br.u(1)) {
        br.ue();
        br.ue();
      }
      if (br.u(1)) {
        const numUnits = u322();
        const timeScale = u322();
        br.u(1);
        if (numUnits > 0 && timeScale > 0) out.fps = (timeScale / (2 * numUnits)).toFixed(3);
      }
    }
  } catch {
  }
  if (!out.fps) out.fps_hint = "无 VUI timing，需容器提供";
  return out;
}
var Analyzer = class {
  constructor() {
    __publicField(this, "buf", new Uint8Array(0));
    __publicField(this, "total", 0);
    __publicField(this, "base", 0);
    __publicField(this, "pos", 0);
    __publicField(this, "fmt", "auto");
    __publicField(this, "actual", null);
    __publicField(this, "rows", []);
    __publicField(this, "info", {});
    __publicField(this, "errors", 0);
    __publicField(this, "firstT", 0);
    __publicField(this, "lastT", 0);
    __publicField(this, "tsBase", -1);
    __publicField(this, "tsPids", /* @__PURE__ */ new Map());
    __publicField(this, "tsTypes", /* @__PURE__ */ new Map());
    __publicField(this, "pmtPid", -1);
    __publicField(this, "wavDone", false);
    __publicField(this, "rowSeq", 0);
    // A/V 时间线事件：t=到达时刻(ms)，s=流(v/a)，key=关键帧，size=字节
    __publicField(this, "events", []);
    // 帧类型/长度统计（H.264 片类型 + GOP）
    __publicField(this, "sliceCount", {});
    __publicField(this, "gopSizes", []);
    __publicField(this, "gopFrames", 0);
    // 真实图像帧计数（只算片/JPEG，不算 SPS/PPS/SEI/AUD）：fps 必须用它，
    // 否则把参数集 NAL 当帧算，会算出 86000 fps 这种荒谬值
    __publicField(this, "picCount", 0);
    __publicField(this, "picFirstT", 0);
    __publicField(this, "picLastT", 0);
  }
  setFormat(f) {
    this.fmt = f;
    this.clear();
  }
  clear() {
    this.buf = new Uint8Array(0);
    this.total = 0;
    this.base = 0;
    this.pos = 0;
    this.actual = null;
    this.rows = [];
    this.info = {};
    this.errors = 0;
    this.firstT = 0;
    this.lastT = 0;
    this.tsBase = -1;
    this.tsPids.clear();
    this.tsTypes.clear();
    this.pmtPid = -1;
    this.wavDone = false;
    this.rowSeq = 0;
    this.events = [];
    this.sliceCount = {};
    this.gopSizes = [];
    this.gopFrames = 0;
    this.picCount = 0;
    this.picFirstT = 0;
    this.picLastT = 0;
  }
  feed(bytes, t) {
    if (!bytes.length) return;
    if (!this.firstT) this.firstT = t;
    this.lastT = t;
    this.total += bytes.length;
    const merged = new Uint8Array(this.buf.length + bytes.length);
    merged.set(this.buf);
    merged.set(bytes, this.buf.length);
    this.buf = merged;
    if (this.fmt !== "auto" && !this.actual) this.actual = this.fmt;
    if (!this.actual) {
      const d = detectFormat(this.buf);
      if (d) this.actual = d;
    }
    if (!this.actual) return;
    try {
      if (this.actual === "h264") this.parseH264(false);
      else if (this.actual === "h265") this.parseH264(true);
      else if (this.actual === "aac") this.parseAac();
      else if (this.actual === "ts") this.parseTs();
      else if (this.actual === "wav") this.parseWav();
      else if (this.actual === "mjpeg") this.parseJpeg();
    } catch {
      this.errors++;
    }
    const CAP = 8 * 1024 * 1024;
    if (this.buf.length > CAP) {
      const keepBytes = CAP / 2;
      const drop = Math.max(this.pos, this.buf.length - keepBytes);
      if (drop > 0) {
        this.buf = this.buf.slice(drop);
        this.base += drop;
        this.pos = Math.max(0, this.pos - drop);
      }
    }
  }
  push(row, stream = "v") {
    this.rows.push({
      ...row,
      n: ++this.rowSeq,
      time: this.lastT,
      hex: row.hex ?? ""
    });
    if (this.rows.length > 5e3) this.rows.splice(0, this.rows.length - 5e3);
    this.events.push({ t: this.lastT, s: stream, key: row.key, size: row.size });
    if (this.events.length > 2e4) this.events.splice(0, this.events.length - 2e4);
  }
  parseH264(hevc) {
    let guard = 0;
    while (guard++ < 5e3) {
      const start = findStart(this.buf, this.pos);
      if (!start) {
        this.pos = Math.max(0, this.buf.length - 4);
        return;
      }
      this.pos = start.pos;
      const next = findStart(this.buf, start.pos + start.len);
      if (!next) return;
      const payload = trimZeros(this.buf.slice(start.pos + start.len, next.pos));
      if (!payload.length) {
        this.pos = next.pos;
        continue;
      }
      const h = payload[0];
      const type = hevc ? h >> 1 & 63 : h & 31;
      const key = hevc ? type >= 16 && type <= 21 : type === 5;
      if (hevc && type <= 21) {
        this.picCount++;
        if (!this.picFirstT) this.picFirstT = this.lastT;
        this.picLastT = this.lastT;
      }
      const names = hevc ? H265_NAMES : H264_NAMES;
      const name = names[type] ?? (hevc ? `NAL-${type}` : `NAL-${type}`);
      let slice = null;
      if (!hevc && (type === 1 || type === 5)) {
        slice = parseH264SliceType(payload);
        if (slice) {
          this.sliceCount[slice] = (this.sliceCount[slice] ?? 0) + 1;
          this.picCount++;
          if (!this.picFirstT) this.picFirstT = this.lastT;
          this.picLastT = this.lastT;
          if (slice === "I") {
            if (this.gopFrames > 0) this.gopSizes.push(this.gopFrames);
            this.gopFrames = 0;
          }
          this.gopFrames += 1;
        }
      }
      if (!hevc && type === 7) {
        try {
          Object.assign(this.info, parseH264Sps(payload));
        } catch {
          this.info.sps = "SPS 解析失败";
        }
      }
      if (!hevc && type === 6) {
        try {
          const rbsp = stripEmulation(payload.subarray(1));
          const types = [];
          let p = 0;
          while (p < rbsp.length && types.length < 8) {
            let pt = 0;
            while (p < rbsp.length && rbsp[p] === 255) {
              pt += 255;
              p++;
            }
            if (p >= rbsp.length) break;
            pt += rbsp[p++];
            let ps = 0;
            while (p < rbsp.length && rbsp[p] === 255) {
              ps += 255;
              p++;
            }
            if (p >= rbsp.length) break;
            ps += rbsp[p++];
            types.push(pt);
            p += ps;
            if (rbsp[p] === 128) break;
          }
          if (types.length) this.info.sei = types.map((t) => `type ${t}`).join(", ");
        } catch {
        }
      }
      this.push({
        offset: this.base + start.pos,
        size: next.pos - start.pos,
        kind: name,
        key,
        detail: `${hevc ? "H.265" : "H.264"} type=${type} ref=${hevc ? "" : h >> 5 & 3}${slice ? ` · ${slice} 片` : ""}`,
        hex: hex(payload)
      }, "v");
      this.pos = next.pos;
    }
  }
  /*
  *   描述：MJPEG（连续 JPEG 帧）解析：逐帧定位 SOI…EOI，读 SOF 取分辨率。
  *         每帧都是独立关键帧（帧内编码），这也是 MJPEG 码率高的原因。
  */
  parseJpeg() {
    let guard = 0;
    while (guard++ < 2e3) {
      let start = -1;
      for (let i = this.pos; i + 2 < this.buf.length; i++) {
        if (this.buf[i] === 255 && this.buf[i + 1] === 216 && this.buf[i + 2] === 255) {
          start = i;
          break;
        }
      }
      if (start < 0) {
        this.pos = Math.max(0, this.buf.length - 2);
        return;
      }
      const frame = parseJpegFrame(this.buf, start);
      if (!frame) {
        this.pos = start;
        return;
      }
      if (frame.width && frame.height) {
        this.info.width = frame.width;
        this.info.height = frame.height;
        this.info.comps = frame.comps;
        if (frame.subsampling) this.info.subsampling = frame.subsampling;
        if (frame.qtables) this.info.dqt = `${frame.qtables} 张表 · 首值 ${frame.q0}`;
      }
      this.picCount++;
      if (!this.picFirstT) this.picFirstT = this.lastT;
      this.picLastT = this.lastT;
      this.push({
        offset: this.base + start,
        size: frame.size,
        kind: "JPEG 帧",
        key: true,
        detail: `${frame.width}×${frame.height} ${frame.comps}分量${frame.subsampling ? " " + frame.subsampling : ""}${frame.qtables ? ` · DQT×${frame.qtables} Q0=${frame.q0}` : ""}`,
        hex: hex(this.buf.slice(start, Math.min(start + 64, this.buf.length)))
      }, "v");
      this.pos = start + frame.size;
    }
  }
  /*
  *   描述：A/V 汇总结论（时长、帧数、码率、分辨率、GOP、音频参数），供 UI 顶部的“流概览”使用。
  */
  summary() {
    const durMs = Math.max(0, this.lastT - this.firstT);
    let vCount = 0, vBytes = 0, vKey = 0, aCount = 0, aBytes = 0;
    let vFirst = 0, vLast = 0, aFirst = 0, aLast = 0;
    for (const e of this.events) {
      if (e.s === "v") {
        vCount++;
        vBytes += e.size;
        if (e.key) vKey++;
        if (!vFirst) vFirst = e.t;
        vLast = e.t;
      } else {
        aCount++;
        aBytes += e.size;
        if (!aFirst) aFirst = e.t;
        aLast = e.t;
      }
    }
    const gopAvg = this.gopSizes.length ? Math.round(this.gopSizes.reduce((n, v) => n + v, 0) / this.gopSizes.length) : 0;
    const kbps = (bytes) => durMs > 0 ? bytes * 8 / durMs : 0;
    const dim = /^(\d+)×(\d+)$/.exec(String(this.info.resolution ?? ""));
    return {
      durMs,
      video: {
        count: vCount,
        bytes: vBytes,
        kbps: kbps(vBytes),
        // fps 只按真实图像帧算（片/JPEG），且用图像帧自己的首末时间
        fps: this.picCount > 1 && this.picLastT > this.picFirstT ? (this.picCount - 1) / ((this.picLastT - this.picFirstT) / 1e3) : 0,
        keyFrames: vKey,
        gopAvg,
        slices: { ...this.sliceCount },
        width: Number(this.info.width ?? 0) || (dim ? Number(dim[1]) : 0),
        height: Number(this.info.height ?? 0) || (dim ? Number(dim[2]) : 0),
        // MJPEG 的分量数（1=灰度 / 3=YCbCr）此前只出现在 info 栅格与帧表，概览里看不到
        comps: Number(this.info.comps ?? 0),
        spanMs: vLast > vFirst ? vLast - vFirst : 0
      },
      audio: {
        count: aCount,
        bytes: aBytes,
        kbps: kbps(aBytes),
        spanMs: aLast > aFirst ? aLast - aFirst : 0,
        sampleRate: parseInt(String(this.info.sample_rate ?? "0"), 10) || 0,
        channels: parseInt(String(this.info.channels ?? "0"), 10) || 0
      }
    };
  }
  parseAac() {
    let guard = 0;
    while (guard++ < 5e3) {
      const b = this.buf;
      if (this.pos + 7 > b.length) return;
      const i = this.pos;
      if (b[i] !== 255 || (b[i + 1] & 246) !== 240) {
        this.pos++;
        this.errors++;
        continue;
      }
      const profile = b[i + 2] >> 6 & 3;
      const sf = b[i + 2] >> 2 & 15;
      if (sf >= SAMPLE_RATES.length) {
        this.pos++;
        this.errors++;
        continue;
      }
      const channels = (b[i + 2] & 1) << 2 | b[i + 3] >> 6;
      const frameLen = (b[i + 3] & 3) << 11 | b[i + 4] << 3 | b[i + 5] >> 5;
      if (frameLen < 7 || i + frameLen > b.length) return;
      this.info.codec = "AAC ADTS";
      this.info.sample_rate = `${SAMPLE_RATES[sf]} Hz`;
      this.info.channels = `${channels} ch`;
      this.info.profile = `AAC profile ${profile}`;
      this.push({
        offset: this.base + i,
        size: frameLen,
        kind: "AAC",
        key: false,
        detail: `${SAMPLE_RATES[sf]}Hz ${channels}ch`,
        hex: hex(b.slice(i, i + frameLen))
      }, "a");
      this.pos += frameLen;
    }
  }
  parseTs() {
    const b = this.buf;
    if (this.tsBase < 0) {
      for (let i = 0; i < Math.min(400, b.length - 376); i++) {
        if (b[i] === 71 && b[i + 188] === 71 && b[i + 376] === 71) {
          this.tsBase = i;
          break;
        }
      }
      if (this.tsBase < 0) return;
      this.pos = this.tsBase;
    }
    let guard = 0;
    while (guard++ < 5e3) {
      const i = this.pos;
      if (i + 188 > b.length) return;
      if (b[i] !== 71) {
        this.pos++;
        this.errors++;
        continue;
      }
      const pusi = !!(b[i + 1] & 64);
      const pid = (b[i + 1] & 31) << 8 | b[i + 2];
      const afc = b[i + 3] >> 4 & 3;
      let p = i + 4;
      if (afc & 2) p += 1 + b[p];
      if (p > i + 188) {
        this.pos += 188;
        this.errors++;
        continue;
      }
      this.tsPids.set(pid, (this.tsPids.get(pid) ?? 0) + 1);
      if (pusi && afc & 1) {
        const payload = b.slice(p, i + 188);
        if (pid === 0) this.parsePat(payload);
        else if (pid === this.pmtPid) this.parsePmt(payload);
        if (payload.length) {
          const stream = this.tsTypes.get(pid);
          this.push({
            offset: this.base + i,
            size: 188,
            kind: `TS PID 0x${pid.toString(16).padStart(4, "0")}`,
            key: false,
            detail: stream ? TS_STREAM_TYPES[stream] ?? `type 0x${stream.toString(16)}` : "PES",
            hex: hex(payload)
          }, stream === 15 ? "a" : "v");
        }
      }
      this.pos += 188;
    }
  }
  parsePat(payload) {
    let p = 1 + payload[0];
    if (p + 8 > payload.length || payload[p] !== 0) return;
    const sectionLen = (payload[p + 1] & 15) << 8 | payload[p + 2];
    const end = Math.min(payload.length, p + 3 + sectionLen - 4);
    let q = p + 8;
    while (q + 4 <= end) {
      const prog = payload[q] << 8 | payload[q + 1];
      const pid = (payload[q + 2] & 31) << 8 | payload[q + 3];
      if (prog !== 0) this.pmtPid = pid;
      q += 4;
    }
    this.info.pat = this.pmtPid >= 0 ? `PMT PID 0x${this.pmtPid.toString(16)}` : "PAT 已发现";
  }
  parsePmt(payload) {
    let p = 1 + payload[0];
    if (p + 12 > payload.length || payload[p] !== 2) return;
    const sectionLen = (payload[p + 1] & 15) << 8 | payload[p + 2];
    const end = Math.min(payload.length, p + 3 + sectionLen - 4);
    const infoLen = (payload[p + 10] & 15) << 8 | payload[p + 11];
    let q = p + 12 + infoLen;
    while (q + 5 <= end) {
      const type = payload[q];
      const pid = (payload[q + 1] & 31) << 8 | payload[q + 2];
      const esLen = (payload[q + 3] & 15) << 8 | payload[q + 4];
      this.tsTypes.set(pid, type);
      q += 5 + esLen;
    }
    this.info.pmt = `${this.tsTypes.size} 个流`;
    this.info.pids = `${this.tsPids.size} 个 PID`;
  }
  parseWav() {
    if (this.wavDone || this.buf.length < 44) return;
    const b = this.buf;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (b[0] !== 82 || b[8] !== 87) return;
    let p = 12;
    let fmt = -1, channels = 0, rate = 0, bits = 0, data = 0;
    while (p + 8 <= b.length) {
      const id = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
      const size = dv.getUint32(p + 4, true);
      if (id === "fmt " && p + 24 <= b.length) {
        fmt = dv.getUint16(p + 8, true);
        channels = dv.getUint16(p + 10, true);
        rate = dv.getUint32(p + 12, true);
        bits = dv.getUint16(p + 22, true);
      } else if (id === "data") data = size;
      p += 8 + size + (size & 1);
    }
    this.info.codec = fmt === 1 ? "PCM" : fmt === 3 ? "IEEE float" : `WAV fmt ${fmt}`;
    this.info.sample_rate = `${rate} Hz`;
    this.info.channels = `${channels} ch`;
    this.info.bit_depth = `${bits} bit`;
    this.info.data_size = data;
    this.push({
      offset: 0,
      size: Math.min(b.length, 44),
      kind: "WAV",
      key: true,
      detail: `${rate}Hz ${channels}ch ${bits}bit`,
      hex: hex(b)
    }, "a");
    this.wavDone = true;
    this.pos = b.length;
  }
};
var STYLE = `
.av-root { display:flex; flex-direction:column; height:100%; min-height:0; gap:10px; padding:12px; box-sizing:border-box;
  color:#23262b; font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif; }
.av-bar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.av-label { font-size:12px; color:#8a9099; white-space:nowrap; }
.av-select { font-size:12px; padding:5px 8px; border:1px solid rgba(23,26,33,.14); border-radius:6px; background:#fff; color:#23262b; max-width:260px; }
.av-btn { font-size:12px; padding:5px 11px; border:1px solid rgba(23,26,33,.14); border-radius:6px; background:#fff; color:#3b414b; cursor:pointer; }
.av-btn:hover { background:rgba(59,111,212,.08); }
.av-btn.primary { background:#3b6fd4; color:#fff; border-color:#3b6fd4; }
.av-cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:8px; }
.av-card { border:1px solid rgba(23,26,33,.1); border-radius:8px; padding:8px 10px; background:#fff; min-width:0; }
.av-card .k { font-size:11px; color:#8a9099; }
.av-card .v { font-size:17px; font-weight:700; margin-top:3px; color:#23262b; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.av-info { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:6px 14px; font-size:12px;
  border:1px solid rgba(23,26,33,.1); border-radius:8px; padding:8px 10px; background:#fff; }
.av-info span { color:#8a9099; }
.av-info b { color:#3b414b; font-weight:600; }
.av-table-wrap { flex:1; min-height:100px; overflow:auto; border:1px solid rgba(23,26,33,.1); border-radius:8px; background:#fff; }
/* A/V 概览 + 时间线 */
.av-sum { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:2px 14px;
  font-size:12px; padding:6px 8px; border-radius:8px; background:rgba(23,26,33,.03);
  box-shadow:inset 0 0 0 1px rgba(23,26,33,.08); }
.av-sum span { color:#8a9099; }
.av-sum b { color:#3563c2; font-variant-numeric:tabular-nums; }
.theme-dark .av-sum { background:rgba(255,255,255,.05); box-shadow:inset 0 0 0 1px rgba(255,255,255,.09); }
.theme-dark .av-sum span { color:#7c828c; }
.theme-dark .av-sum b { color:#8fbdf7; }
.av-tl { height:60px; flex-shrink:0; border-radius:8px; overflow:hidden; box-shadow:inset 0 0 0 1px rgba(23,26,33,.08); }
.theme-dark .av-tl { box-shadow:inset 0 0 0 1px rgba(255,255,255,.09); }
.av-tl-canvas { display:block; width:100%; height:60px; }
/* 帧大小曲线（编码器码率包络）：关键帧红、普通视频帧蓝、音频帧绿 */
.av-fs { height:64px; flex-shrink:0; border-radius:8px; overflow:hidden; box-shadow:inset 0 0 0 1px rgba(23,26,33,.08); }
.theme-dark .av-fs { box-shadow:inset 0 0 0 1px rgba(255,255,255,.09); }
.av-fs-canvas { display:block; width:100%; height:64px; }
.av-table { width:100%; border-collapse:collapse; font-size:12px; }
.av-table th { position:sticky; top:0; background:#f5f6f8; color:#6b7280; text-align:left; padding:6px 8px; font-weight:600; z-index:1; }
.av-table td { padding:5px 8px; border-top:1px solid rgba(23,26,33,.06); white-space:nowrap; }
.av-table tr.row { cursor:pointer; }
.av-table tr.row:hover td { background:rgba(59,111,212,.06); }
.av-table tr.sel td { background:rgba(59,111,212,.12); }
.av-key { color:#b7791f; font-weight:700; }
.av-hex { flex-shrink:0; max-height:88px; overflow:auto; margin:0; padding:8px 10px; border:1px solid rgba(23,26,33,.1);
  border-radius:8px; background:#f6f7f9; font:11px/1.5 Consolas,monospace; color:#4b5563; white-space:pre-wrap; word-break:break-all; }
.av-status { font-size:11px; color:#8a9099; display:flex; justify-content:space-between; gap:12px; }
.av-empty { padding:28px; text-align:center; color:#8a9099; font-size:13px; }
.theme-dark .av-root { color:#d6d9de; }
.theme-dark .av-select, .theme-dark .av-btn, .theme-dark .av-card, .theme-dark .av-info {
  background: #2b2d30; border-color: rgba(255, 255, 255, 0.1); color: #d6d9de;
}
/* 原生滚动条 / 下拉列表跟随主题：深色下必须声明 color-scheme，否则 WebView2 会用浅色系统滚动条（白底 + 箭头） */
.av-root { color-scheme: light; scrollbar-width: thin; scrollbar-color: rgba(128,132,140,.45) transparent; }
.theme-dark .av-root { color-scheme: dark; }
.av-root * { scrollbar-width: thin; scrollbar-color: rgba(128,132,140,.45) transparent; }
.av-root *::-webkit-scrollbar { width: 8px; height: 8px; }
.av-root *::-webkit-scrollbar-thumb { background: rgba(128,132,140,.45); border-radius: 4px; }
.av-root *::-webkit-scrollbar-thumb:hover { background: rgba(128,132,140,.7); }
.av-root *::-webkit-scrollbar-track, .av-root *::-webkit-scrollbar-corner { background: transparent; }
.theme-dark .av-table-wrap { background:#2b2d30; border-color:rgba(255,255,255,.1); color:#d6d9de; }
.theme-dark .av-btn:hover { background:rgba(108,167,232,.14); }
.theme-dark .av-card .v, .theme-dark .av-info b { color:#e6e8eb; }
.theme-dark .av-table th { background:#24262a; color:#9da0a8; }
.theme-dark .av-table td { border-color:rgba(255,255,255,.06); }
.theme-dark .av-table tr.row:hover td { background:rgba(108,167,232,.1); }
.theme-dark .av-table tr.sel td { background:rgba(108,167,232,.18); }
.theme-dark .av-hex { background:#24262a; border-color:rgba(255,255,255,.1); color:#aeb3bc; }
.av-tabs { display:flex; gap:4px; border-bottom:1px solid rgba(23,26,33,.1); padding-bottom:6px; flex-shrink:0; }
.av-tab { font-size:12px; padding:5px 12px; border:1px solid transparent; border-radius:6px; background:transparent; color:#8a9099; cursor:pointer; }
.av-tab.on { background:#3b6fd4; color:#fff; }
.av-file { display:flex; flex-direction:column; flex:1; min-height:0; gap:8px; }
.av-root [hidden] { display:none !important; }
.av-file-bar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.av-file-name { font-size:12px; color:#8a9099; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.av-drop { border:1px dashed rgba(59,111,212,.4); border-radius:8px; padding:10px 12px; font-size:12px; color:#8a9099; text-align:center; flex-shrink:0; }
.av-drop.over { background:rgba(59,111,212,.08); border-color:#3b6fd4; color:#3b6fd4; }
.av-file-body { display:grid; grid-template-columns:minmax(240px,1fr) minmax(280px,1.15fr); gap:8px; flex:1; min-height:0; }
.av-tree-wrap, .av-hex-wrap { border:1px solid rgba(23,26,33,.1); border-radius:8px; background:#fff; min-height:0; overflow:auto; }
.av-tree { width:100%; border-collapse:collapse; font-size:11px; }
.av-tree th { position:sticky; top:0; background:#f5f6f8; color:#6b7280; text-align:left; padding:5px 7px; font-weight:600; z-index:1; white-space:nowrap; }
.av-tree td { padding:4px 7px; border-top:1px solid rgba(23,26,33,.06); white-space:nowrap; }
.av-tree tr.row { cursor:pointer; }
.av-tree tr.row:hover td { background:rgba(59,111,212,.06); }
.av-tree tr.sel td { background:rgba(59,111,212,.14); }
.av-tree .depth { color:#b0b4bb; }
.av-hex-wrap { display:flex; flex-direction:column; overflow:hidden; }
.av-hex-bar { display:flex; align-items:center; gap:5px; padding:6px; border-bottom:1px solid rgba(23,26,33,.08); flex-wrap:wrap; flex-shrink:0; }
.av-hex-bar input { width:90px; font-size:11px; padding:3px 5px; border:1px solid rgba(23,26,33,.14); border-radius:4px; background:#fff; color:#23262b; font-family:Consolas,monospace; }
.av-hex-range { font-size:10px; color:#8a9099; margin-left:auto; }
.av-hexdump { margin:0; padding:6px 8px; flex:1; overflow:auto; font:11px/1.55 Consolas,monospace; white-space:pre; color:#4b5563; }
.av-hexline { display:block; }
.av-hexline.hit { background:rgba(59,111,212,.12); }
.av-hex-off { color:#9aa0a8; margin-right:8px; }
.av-hex-ascii { color:#8a9099; margin-left:8px; }
.av-player { position:fixed; inset:0; z-index:9998; background:rgba(10,12,16,.62); display:flex; align-items:center; justify-content:center; padding:24px; }
.av-player-box { width:min(760px,92vw); max-height:86vh; display:flex; flex-direction:column; gap:8px; background:#fff; border:1px solid rgba(23,26,33,.14); border-radius:10px; padding:12px; box-shadow:0 24px 60px rgba(0,0,0,.35); }
.av-player-head { display:flex; align-items:center; justify-content:space-between; font-size:12px; color:#6b7280; }
.av-player-video { width:100%; max-height:60vh; background:#111; border-radius:6px; }
.av-player-msg { font-size:12px; color:#8a9099; line-height:1.5; }
.theme-dark .av-player-box { background:#2b2d30; border-color:rgba(255,255,255,.12); color:#d6d9de; }
.theme-dark .av-player-head { color:#9da0a8; }
.theme-dark .av-tabs { border-color:rgba(255,255,255,.1); }
.theme-dark .av-tab { color:#9da0a8; }
.theme-dark .av-tab.on { background:#3b6fd4; color:#fff; }
.theme-dark .av-drop { border-color:rgba(108,167,232,.4); color:#9da0a8; }
.theme-dark .av-tree-wrap, .theme-dark .av-hex-wrap { background:#2b2d30; border-color:rgba(255,255,255,.1); }
.theme-dark .av-tree th { background:#24262a; color:#9da0a8; }
.theme-dark .av-tree td { border-color:rgba(255,255,255,.06); }
.theme-dark .av-tree tr.row:hover td { background:rgba(108,167,232,.1); }
.theme-dark .av-tree tr.sel td { background:rgba(108,167,232,.2); }
.theme-dark .av-hex-bar { border-color:rgba(255,255,255,.1); }
.theme-dark .av-hex-bar input { background:#24262a; border-color:rgba(255,255,255,.14); color:#d6d9de; }
.theme-dark .av-hexdump { color:#aeb3bc; }
.theme-dark .av-hexline.hit { background:rgba(108,167,232,.16); }
`;
var esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
var bytesText = (n) => n > 1024 * 1024 ? `${(n / 1048576).toFixed(2)} MB` : n > 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;
function activate(ctx) {
  ctx.registerView({
    id: "av",
    name: "音视频解析",
    tip: "实时/文件：H.264/H.265、AAC、MPEG-TS、WAV；MP4/AVI 容器结构与二进制",
    blocks: 2,
    component: {
      mount(el, ctx2) {
        el.innerHTML = `<style>${STYLE}</style>
          <div class="av-root">
            <div class="av-bar">
              <span class="av-label">数据源</span><select class="av-select av-source"></select>
              <span class="av-label">格式</span><select class="av-select av-format">
                <option value="auto">自动识别</option><option value="h264">H.264 Annex-B</option>
                <option value="h265">H.265 Annex-B</option><option value="aac">ADTS AAC</option>
                <option value="ts">MPEG-TS</option><option value="wav">WAV</option>
          <option value="mjpeg">MJPEG / JPEG 序列</option>
              </select>
              <button class="av-btn av-pause">暂停</button>
              <button class="av-btn av-clear">清空</button>
              <button class="av-btn primary av-export">导出 JSON</button>
            </div>
            <div class="av-cards">
              <div class="av-card"><div class="k">识别格式</div><div class="v av-format-v">—</div></div>
              <div class="av-card"><div class="k">数据量</div><div class="v av-bytes">0 B</div></div>
              <div class="av-card"><div class="k">帧 / 包</div><div class="v av-count">0</div></div>
              <div class="av-card"><div class="k">估算码率</div><div class="v av-rate">—</div></div>
              <div class="av-card"><div class="k">关键帧 / 错误</div><div class="v av-keyerr">0 / 0</div></div>
            </div>
            <div class="av-info av-info-box"></div>
        <div class="av-sum av-sum-box"></div>
        <div class="av-tl"><canvas class="av-tl-canvas"></canvas></div>
        <div class="av-fs"><canvas class="av-fs-canvas"></canvas></div>
            <div class="av-table-wrap"><table class="av-table">
              <thead><tr><th>#</th><th>偏移</th><th>类型</th><th>大小</th><th>关键</th><th>详情</th></tr></thead>
              <tbody class="av-body"></tbody>
            </table><div class="av-empty av-empty-box">选择数据源并收到数据后，这里会显示帧/包列表</div></div>
            <pre class="av-hex av-hex-box">选择一行查看前 64 字节</pre>
            <div class="av-status"><span class="av-status-left">未选择数据源</span><span class="av-status-right"></span></div>
          </div>`;
        const $ = (s) => el.querySelector(s);
        const source = $(".av-source");
        const format = $(".av-format");
        const pauseBtn = $(".av-pause");
        const body = $(".av-body");
        const tableWrap = $(".av-table-wrap");
        const emptyBox = $(".av-empty-box");
        const infoBox = $(".av-info-box");
        const sumBox = $(".av-sum-box");
        const tlCanvas = $(".av-tl-canvas");
        const fsCanvas = $(".av-fs-canvas");
        const hexBox = $(".av-hex-box");
        const statusLeft = $(".av-status-left");
        const statusRight = $(".av-status-right");
        const root = $(".av-root");
        const tabs = document.createElement("div");
        tabs.className = "av-tabs";
        tabs.innerHTML = `<button class="av-tab on" data-tab="live">实时数据</button><button class="av-tab" data-tab="file">文件解析</button>`;
        root.insertBefore(tabs, root.firstChild);
        const filePane = document.createElement("div");
        filePane.className = "av-file";
        filePane.hidden = true;
        filePane.innerHTML = `
          <div class="av-file-bar">
            <button class="av-btn primary av-import">导入文件</button>
            <input type="file" class="av-fileinput" hidden accept=".mp4,.m4v,.mov,.avi,.ts,.m2ts,.h264,.h265,.hevc,.aac,.wav,.bin">
            <button class="av-btn av-play" disabled>播放</button>
            <button class="av-btn av-fileclear">关闭文件</button>
            <span class="av-file-name">未导入文件</span>
          </div>
          <div class="av-drop">拖放 MP4 / AVI / 裸码流文件到这里，或点击“导入文件”</div>
          <div class="av-cards">
            <div class="av-card"><div class="k">文件</div><div class="v av-f-name">—</div></div>
            <div class="av-card"><div class="k">大小</div><div class="v av-f-size">—</div></div>
            <div class="av-card"><div class="k">格式</div><div class="v av-f-format">—</div></div>
            <div class="av-card"><div class="k">结构项</div><div class="v av-f-nodes">0</div></div>
          </div>
          <div class="av-info av-f-info"></div>
          <div class="av-file-body">
            <div class="av-tree-wrap"><table class="av-tree">
              <thead><tr><th>层级 / 类型</th><th>偏移</th><th>大小</th><th>详情</th></tr></thead>
              <tbody class="av-tree-body"></tbody>
            </table></div>
            <div class="av-hex-wrap">
              <div class="av-hex-bar">
                <button class="av-btn av-hex-prev">上一页</button>
                <input class="av-hex-input" placeholder="偏移 hex" title="十六进制偏移，可加 0x">
                <button class="av-btn av-hex-go">跳转</button>
                <button class="av-btn av-hex-next">下一页</button>
                <span class="av-hex-range"></span>
              </div>
              <pre class="av-hexdump"></pre>
            </div>
          </div>
          <div class="av-player" hidden>
            <div class="av-player-box">
              <div class="av-player-head"><span>媒体预览</span><button class="av-btn av-player-close">关闭</button></div>
              <video class="av-player-video" controls playsinline></video>
              <div class="av-player-msg"></div>
            </div>
          </div>`;
        root.insertBefore(filePane, statusLeft.parentElement);
        const liveNodes = Array.from(root.children).filter((n) => n !== tabs && n !== filePane);
        const tabLive = tabs.querySelector('[data-tab="live"]');
        const tabFile = tabs.querySelector('[data-tab="file"]');
        const analyzer = new Analyzer();
        let selected = "";
        let paused = false;
        let selectedRow = -1;
        let timer = 0;
        let fileBytes = null;
        let fileNodes = [];
        let fileFormat = "—";
        let fileSelected = -1;
        let hexOffset = 0;
        let fileAnalyzer = null;
        const fileImport = filePane.querySelector(".av-import");
        const fileInput = filePane.querySelector(".av-fileinput");
        const fileClear = filePane.querySelector(".av-fileclear");
        const fileNameEl = filePane.querySelector(".av-file-name");
        const fileDrop = filePane.querySelector(".av-drop");
        const fName = filePane.querySelector(".av-f-name");
        const fSize = filePane.querySelector(".av-f-size");
        const fFormat = filePane.querySelector(".av-f-format");
        const fNodes = filePane.querySelector(".av-f-nodes");
        const fInfo = filePane.querySelector(".av-f-info");
        const treeWrap = filePane.querySelector(".av-tree-wrap");
        const treeBody = filePane.querySelector(".av-tree-body");
        const hexDump = filePane.querySelector(".av-hexdump");
        const hexInput = filePane.querySelector(".av-hex-input");
        const hexRange = filePane.querySelector(".av-hex-range");
        const playBtn = filePane.querySelector(".av-play");
        const player = filePane.querySelector(".av-player");
        const playerVideo = filePane.querySelector(".av-player-video");
        const playerMsg = filePane.querySelector(".av-player-msg");
        let playerUrl = "";
        const closePlayer = () => {
          player.hidden = true;
          playerVideo.pause();
          playerVideo.removeAttribute("src");
          playerVideo.load();
          if (playerUrl) URL.revokeObjectURL(playerUrl);
          playerUrl = "";
        };
        const openPlayer = () => {
          if (!fileBytes) return;
          const name = (fileNameEl.dataset.name || "").toLowerCase();
          player.hidden = false;
          playerMsg.textContent = "";
          playerVideo.hidden = false;
          if (!/\.(mp4|m4v|mov|wav)$/.test(name)) {
            playerVideo.hidden = true;
            playerMsg.textContent = /\.avi$/.test(name) ? "AVI 容器 Chromium/WebView2 不原生支持解码：当前只能查看结构与二进制。可另存为 MP4 再播放。" : "当前格式不支持浏览器内播放（MP4/M4V/MOV/WAV 可播；裸 H.264/AAC/TS 需先封装）。";
            return;
          }
          if (playerUrl) URL.revokeObjectURL(playerUrl);
          const mime = /\.wav$/.test(name) ? "audio/wav" : "video/mp4";
          playerUrl = URL.createObjectURL(new Blob([fileBytes], { type: mime }));
          playerVideo.src = playerUrl;
          playerVideo.onerror = () => {
            playerMsg.textContent = "浏览器无法解码该文件（可能是 HEVC/不支持的编码，或带 DRM）。";
          };
          void playerVideo.play().catch(() => {
          });
        };
        const HELLX_PAGE = 4096;
        const renderFileHex = () => {
          if (!fileBytes || fileBytes.length === 0) {
            hexDump.textContent = "文件为空";
            hexRange.textContent = "";
            return;
          }
          hexOffset = Math.max(0, Math.min(fileBytes.length - 1, hexOffset));
          const start = Math.floor(hexOffset / 16) * 16;
          const end = Math.min(fileBytes.length, start + HELLX_PAGE);
          const bpl = hexDump.clientWidth > 430 ? 16 : 8;
          const sel = fileNodes[fileSelected];
          const lines = [];
          for (let off = start; off < end; off += bpl) {
            const chunk = fileBytes.subarray(off, Math.min(end, off + bpl));
            let bytes = "";
            let ascii = "";
            for (let i = 0; i < bpl; i++) {
              if (i < chunk.length) {
                const v = chunk[i];
                bytes += v.toString(16).padStart(2, "0") + (i === bpl / 2 - 1 ? "  " : " ");
                ascii += v >= 32 && v <= 126 ? String.fromCharCode(v) : ".";
              } else {
                bytes += "   ";
              }
            }
            const hit = sel && off < sel.offset + sel.size && off + bpl > sel.offset;
            lines.push(`<span class="av-hexline${hit ? " hit" : ""}"><span class="av-hex-off">${off.toString(16).padStart(8, "0")}</span>${bytes}<span class="av-hex-ascii">${esc(ascii)}</span></span>`);
          }
          hexDump.innerHTML = lines.join("");
          hexRange.textContent = `${start.toString(16).toUpperCase()}–${end.toString(16).toUpperCase()} / ${fileBytes.length.toString(16).toUpperCase()}`;
          hexInput.value = start.toString(16).toUpperCase();
        };
        const renderFile = () => {
          fileDrop.hidden = !!fileBytes;
          playBtn.disabled = !fileBytes;
          if (!fileBytes) {
            fileNameEl.textContent = "未导入文件";
            fName.textContent = "—";
            fSize.textContent = "—";
            fFormat.textContent = "—";
            fNodes.textContent = "0";
            fInfo.innerHTML = "<div><span>提示：</span><b>导入 MP4/AVI/裸码流文件后显示容器结构与十六进制</b></div>";
            treeBody.innerHTML = "";
            hexDump.textContent = "未导入文件";
            hexRange.textContent = "";
            return;
          }
          fileNameEl.textContent = `${fileBytes.length} 字节`;
          fName.textContent = fileNameEl.dataset.name || "文件";
          fSize.textContent = bytesText(fileBytes.length);
          fFormat.textContent = fileFormat;
          fNodes.textContent = String(fileNodes.length);
          const infoEntries = fileAnalyzer ? Object.entries(fileAnalyzer.info) : [];
          fInfo.innerHTML = infoEntries.length ? infoEntries.map(([k, v]) => `<div><span>${esc(k)}：</span><b>${esc(String(v))}</b></div>`).join("") : "<div><span>提示：</span><b>可点击左侧结构项跳转到对应二进制位置</b></div>";
          const st = treeWrap.scrollTop;
          treeBody.innerHTML = fileNodes.slice(0, 3e3).map((n, i) => `
            <tr class="row${i === fileSelected ? " sel" : ""}" data-fi="${i}">
              <td style="padding-left:${7 + n.depth * 12}px"><span class="depth">${n.depth ? "└ " : ""}</span>${esc(n.label)}</td>
              <td>${n.offset}</td><td>${n.size}</td><td>${esc(n.detail)}</td>
            </tr>`).join("");
          treeWrap.scrollTop = st;
          renderFileHex();
        };
        const loadFile = async (file) => {
          if (!file) return;
          if (file.size > 256 * 1024 * 1024) {
            ctx2.notify("文件超过 256MB，暂不支持（避免 WebView 内存爆掉）");
            return;
          }
          try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            closePlayer();
            fileBytes = bytes;
            fileSelected = -1;
            hexOffset = 0;
            fileNameEl.dataset.name = file.name;
            fileAnalyzer = null;
            if (isMp4(bytes)) {
              const r = parseMp4(bytes);
              fileFormat = r.format;
              fileNodes = r.nodes;
              fileAnalyzer = new Analyzer();
              fileAnalyzer.info = r.info;
            } else if (isAvi(bytes)) {
              const r = parseAvi(bytes);
              fileFormat = r.format;
              fileNodes = r.nodes;
              fileAnalyzer = new Analyzer();
              fileAnalyzer.info = r.info;
            } else {
              const a = new Analyzer();
              a.feed(bytes, 0);
              fileAnalyzer = a;
              fileFormat = (a.actual ?? "RAW").toUpperCase();
              fileNodes = a.rows.slice(0, 3e3).map((row) => ({
                offset: row.offset,
                size: row.size,
                type: row.kind,
                label: row.kind,
                detail: row.detail,
                depth: 0
              }));
            }
            setTab("file");
            renderFile();
          } catch (e) {
            ctx2.notify(`读取文件失败：${e instanceof Error ? e.message : e}`);
          }
        };
        const setTab = (mode) => {
          tabLive.classList.toggle("on", mode === "live");
          tabFile.classList.toggle("on", mode === "file");
          liveNodes.forEach((n) => {
            n.hidden = mode === "file";
          });
          filePane.hidden = mode !== "file";
          if (mode === "file") renderFile();
        };
        tabLive.addEventListener("click", () => setTab("live"));
        tabFile.addEventListener("click", () => setTab("file"));
        fileImport.addEventListener("click", () => fileInput.click());
        fileInput.addEventListener("change", () => {
          const f = fileInput.files?.[0];
          if (f) void loadFile(f);
          fileInput.value = "";
        });
        fileClear.addEventListener("click", () => {
          closePlayer();
          fileBytes = null;
          fileNodes = [];
          fileAnalyzer = null;
          fileFormat = "—";
          fileSelected = -1;
          hexOffset = 0;
          renderFile();
        });
        playBtn.addEventListener("click", openPlayer);
        filePane.querySelector(".av-player-close").addEventListener("click", closePlayer);
        treeBody.addEventListener("click", (e) => {
          const tr = e.target.closest("tr[data-fi]");
          if (!tr) return;
          fileSelected = Number(tr.dataset.fi);
          hexOffset = fileNodes[fileSelected]?.offset ?? 0;
          renderFile();
        });
        const goHex = () => {
          const v = parseInt(hexInput.value.replace(/^0x/i, ""), 16);
          if (Number.isFinite(v)) {
            hexOffset = Math.max(0, Math.min((fileBytes?.length ?? 1) - 1, v));
            renderFileHex();
          }
        };
        filePane.querySelector(".av-hex-go").addEventListener("click", goHex);
        hexInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") goHex();
        });
        filePane.querySelector(".av-hex-prev").addEventListener("click", () => {
          hexOffset = Math.max(0, hexOffset - HELLX_PAGE);
          renderFileHex();
        });
        filePane.querySelector(".av-hex-next").addEventListener("click", () => {
          hexOffset = Math.min((fileBytes?.length ?? 1) - 1, hexOffset + HELLX_PAGE);
          renderFileHex();
        });
        filePane.addEventListener("dragover", (e) => {
          e.preventDefault();
          fileDrop.classList.add("over");
        });
        filePane.addEventListener("dragleave", () => fileDrop.classList.remove("over"));
        filePane.addEventListener("drop", (e) => {
          e.preventDefault();
          fileDrop.classList.remove("over");
          const f = e.dataTransfer?.files?.[0];
          if (f) void loadFile(f);
        });
        const formatName = () => analyzer.fmt === "auto" ? analyzer.actual ?? "等待识别" : analyzer.fmt.toUpperCase();
        const schedule = () => {
          if (timer) return;
          timer = window.setTimeout(() => {
            timer = 0;
            render();
          }, 120);
        };
        const renderSessions = () => {
          const list = ctx2.listSessions();
          if (!selected && list.length) selected = list[0].id;
          if (selected && !list.some((s) => s.id === selected)) selected = list[0]?.id ?? "";
          source.innerHTML = `<option value="">选择数据源会话</option>` + list.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}${s.status === "connected" ? "" : "（未连接）"}</option>`).join("");
          source.value = selected;
          statusLeft.textContent = selected ? `数据源：${list.find((s) => s.id === selected)?.name ?? selected}` : "未选择数据源";
        };
        const render = () => {
          const rate = analyzer.firstT && analyzer.lastT > analyzer.firstT ? (analyzer.total * 8 / 1e3 / ((analyzer.lastT - analyzer.firstT) / 1e3)).toFixed(1) + " kbps" : "—";
          $(".av-format-v").textContent = formatName();
          $(".av-bytes").textContent = bytesText(analyzer.total);
          $(".av-count").textContent = String(analyzer.rows.length);
          $(".av-rate").textContent = rate;
          $(".av-keyerr").textContent = `${analyzer.rows.filter((r) => r.key).length} / ${analyzer.errors}`;
          const info = Object.entries(analyzer.info);
          infoBox.innerHTML = info.length ? info.map(([k, v]) => `<div><span>${esc(k)}：</span><b>${esc(String(v))}</b></div>`).join("") : "<div><span>提示：</span><b>等待码流识别（H.264/H.265、ADTS AAC、MPEG-TS、WAV）</b></div>";
          const rows = analyzer.rows.slice(-160);
          emptyBox.style.display = rows.length ? "none" : "block";
          const scrollTop = tableWrap.scrollTop;
          body.innerHTML = rows.map((r, i) => {
            const idx = analyzer.rows.length - rows.length + i;
            return `<tr class="row${idx === selectedRow ? " sel" : ""}" data-i="${idx}">
              <td>${r.n}</td><td>${r.offset}</td><td>${esc(r.kind)}</td><td>${r.size} B</td>
              <td class="${r.key ? "av-key" : ""}">${r.key ? "●" : ""}</td><td>${esc(r.detail)}</td></tr>`;
          }).join("");
          tableWrap.scrollTop = scrollTop;
          statusRight.textContent = `已解析 ${analyzer.rows.length} 项 · ${analyzer.errors} 个错误`;
          renderAvSummary();
          renderTimeline();
          renderFrameSizes();
          renderHex();
        };
        const renderAvSummary = () => {
          const s = analyzer.summary();
          const dur = s.durMs > 0 ? (s.durMs / 1e3).toFixed(2) + " s" : "—";
          const v = s.video;
          const a = s.audio;
          const fmtK = (n) => n > 0 ? n.toFixed(1) + " kbps" : "—";
          const sliceTxt = Object.entries(v.slices).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`).join(" ") || "—";
          sumBox.innerHTML = [
            `<div><span>总时长：</span><b data-k="dur">${dur}</b></div>`,
            `<div><span>视频：</span><b data-k="v">${v.count ? `${v.count} 帧 · ${fmtK(v.kbps)} · ${v.fps.toFixed(1)} fps` : "无"}</b></div>`,
            v.count ? `<div><span>视频详情：</span><b>${v.width && v.height ? `${v.width}×${v.height}` : "分辨率未知"}${v.comps ? ` ${v.comps}分量` : ""} · 关键帧 ${v.keyFrames} · GOP≈${v.gopAvg || "—"} · 片类型 ${sliceTxt}</b></div>` : "<div><span>视频详情：</span><b>—</b></div>",
            `<div><span>音频：</span><b data-k="a">${a.count ? `${a.count} 帧 · ${fmtK(a.kbps)}${a.sampleRate ? ` · ${a.sampleRate} Hz ${a.channels}ch` : ""}` : "无"}</b></div>`,
            `<div><span>音视频存在性：</span><b data-k="presence">${v.count && a.count ? "音视频都有" : v.count ? "仅视频" : a.count ? "仅音频" : "无数据"}</b></div>`
          ].join("");
        };
        const renderTimeline = () => {
          const dpr = (window.devicePixelRatio || 1) * (Number(document.documentElement.style.zoom) || 1);
          const cssW = tlCanvas.clientWidth || 600;
          const cssH = tlCanvas.clientHeight || 46;
          const W = Math.round(cssW * dpr);
          const H = Math.round(cssH * dpr);
          if (tlCanvas.width !== W || tlCanvas.height !== H) {
            tlCanvas.width = W;
            tlCanvas.height = H;
          }
          const g = tlCanvas.getContext("2d");
          if (!g) return;
          g.setTransform(dpr, 0, 0, dpr, 0, 0);
          g.clearRect(0, 0, cssW, cssH);
          const t0 = analyzer.firstT;
          const t1 = analyzer.lastT;
          const span = Math.max(1, t1 - t0);
          const axisH = 14;
          const laneH = Math.floor((cssH - axisH - 4) / 2);
          g.fillStyle = "rgba(128,132,140,.10)";
          g.fillRect(0, 0, cssW, laneH);
          g.fillRect(0, laneH + 4, cssW, laneH);
          g.fillStyle = "rgba(128,132,140,.85)";
          g.font = "10px Consolas, monospace";
          g.textBaseline = "middle";
          g.fillText("视频", 2, laneH / 2);
          g.fillText("音频", 2, laneH + 4 + laneH / 2);
          for (const e of analyzer.events) {
            const x = (e.t - t0) / span * (cssW - 30) + 30;
            if (e.s === "v") {
              g.fillStyle = e.key ? "#e0837f" : "#6ca7e8";
              g.fillRect(x, 0, e.key ? 2 : 1, laneH);
            } else {
              g.fillStyle = "#6bc97e";
              g.fillRect(x, laneH + 4, 1, laneH);
            }
          }
          g.fillStyle = "rgba(128,132,140,.85)";
          g.textBaseline = "top";
          g.fillText("0 s", 30, cssH - 12);
          const midTxt = (span / 2e3).toFixed(1) + " s";
          g.fillText(midTxt, 30 + (cssW - 30) / 2 - 14, cssH - 12);
          g.fillText((span / 1e3).toFixed(2) + " s", cssW - 42, cssH - 12);
        };
        const renderFrameSizes = () => {
          const dpr = (window.devicePixelRatio || 1) * (Number(document.documentElement.style.zoom) || 1);
          const cssW = fsCanvas.clientWidth || 600;
          const cssH = fsCanvas.clientHeight || 64;
          const W = Math.round(cssW * dpr);
          const H = Math.round(cssH * dpr);
          if (fsCanvas.width !== W || fsCanvas.height !== H) {
            fsCanvas.width = W;
            fsCanvas.height = H;
          }
          const g = fsCanvas.getContext("2d");
          if (!g) return;
          g.setTransform(dpr, 0, 0, dpr, 0, 0);
          g.clearRect(0, 0, cssW, cssH);
          const ev = analyzer.events.slice(-400);
          if (ev.length === 0) return;
          let maxSize = 1;
          let vSum = 0;
          let vN = 0;
          let aSum = 0;
          let aN = 0;
          let kSum = 0;
          let kN = 0;
          for (const e of ev) {
            if (e.size > maxSize) maxSize = e.size;
            if (e.s === "v") {
              vSum += e.size;
              vN++;
              if (e.key) {
                kSum += e.size;
                kN++;
              }
            } else {
              aSum += e.size;
              aN++;
            }
          }
          const labelH = 12;
          const plotH = cssH - labelH - 2;
          const barW = Math.max(1, cssW / ev.length);
          for (let i = 0; i < ev.length; i++) {
            const e = ev[i];
            const ratio = Math.log10(1 + e.size / maxSize * 99) / 2;
            const h = Math.max(1, ratio * plotH);
            g.fillStyle = e.s === "a" ? "#6bc97e" : e.key ? "#e0837f" : "#6ca7e8";
            g.fillRect(i * barW, plotH - h, Math.max(1, barW - (barW > 2 ? 1 : 0)), h);
          }
          g.fillStyle = "rgba(128,132,140,.9)";
          g.font = "9px Consolas, monospace";
          g.textBaseline = "top";
          const vAvg = vN ? Math.round(vSum / vN) : 0;
          const aAvg = aN ? Math.round(aSum / aN) : 0;
          const kAvg = kN ? Math.round(kSum / kN) : 0;
          const parts = [`最大 ${maxSize} B`];
          if (vN) parts.push(`视频均 ${vAvg} B（${vN} 帧）`);
          if (kN) parts.push(`I 帧均 ${kAvg} B`);
          if (aN) parts.push(`音频均 ${aAvg} B（能量包络，${aN} 帧）`);
          g.fillText(parts.join(" · "), 4, plotH + 2);
        };
        const renderHex = () => {
          const r = analyzer.rows[selectedRow];
          hexBox.textContent = r ? `${r.kind}  offset=${r.offset}  size=${r.size}
${r.hex || "(空)"}` : "选择一行查看前 64 字节";
        };
        const renderAll = () => {
          renderSessions();
          render();
        };
        source.addEventListener("change", () => {
          selected = source.value;
          analyzer.clear();
          selectedRow = -1;
          renderAll();
        });
        format.addEventListener("change", () => {
          analyzer.setFormat(format.value);
          selectedRow = -1;
          render();
        });
        pauseBtn.addEventListener("click", () => {
          paused = !paused;
          pauseBtn.textContent = paused ? "继续" : "暂停";
          pauseBtn.classList.toggle("primary", paused);
        });
        $(".av-clear").addEventListener("click", () => {
          analyzer.clear();
          selectedRow = -1;
          render();
        });
        $(".av-export").addEventListener("click", () => {
          const data = {
            format: formatName(),
            totalBytes: analyzer.total,
            parsed: analyzer.rows.length,
            errors: analyzer.errors,
            info: analyzer.info,
            frames: analyzer.rows.map((r) => ({ n: r.n, offset: r.offset, size: r.size, kind: r.kind, key: r.key, detail: r.detail }))
          };
          void ctx2.exportTextFiles("导出音视频分析", [{ name: "av-inspect.json", text: JSON.stringify(data, null, 2) }], "av-inspect").catch(() => {
            try {
              ctx2.notify("导出失败，请重试");
            } catch {
            }
          });
        });
        body.addEventListener("click", (e) => {
          const tr = e.target.closest("tr[data-i]");
          if (!tr) return;
          selectedRow = Number(tr.dataset.i);
          render();
        });
        const offRaw = ctx2.onRawData((e) => {
          if (!selected || paused || e.sessionId !== selected) return;
          analyzer.feed(e.bytes, e.t);
          schedule();
        });
        const offSessions = ctx2.onSessionsChange ? ctx2.onSessionsChange(() => renderSessions()) : () => {
        };
        renderAll();
        return () => {
          if (timer) clearTimeout(timer);
          closePlayer();
          offRaw();
          offSessions();
        };
      },
      unmount(el) {
        el.innerHTML = "";
      }
    }
  });
}
var main_default = activate;
function deactivate() {
}
export {
  Analyzer,
  deactivate,
  main_default as default,
  isAvi,
  isMp4,
  parseAvi,
  parseMp4
};
