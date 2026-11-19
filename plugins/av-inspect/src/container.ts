// 容器解析：MP4/ISO-BMFF 与 AVI/RIFF 的只读 box/chunk 树。
// 目标是联调时快速定位码流结构（moov/stbl/stsd、movi/strl），不依赖 WASM 解码器。
export type TreeNode = {
  offset: number;
  size: number;
  type: string;
  label: string;
  detail: string;
  depth: number;
};
export type InfoMap = Record<string, string | number>;
export type ContainerResult = {
  format: string;
  info: InfoMap;
  nodes: TreeNode[];
};

const fourcc = (b: Uint8Array, o: number) => {
  if (o + 4 > b.length) return '????';
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]).replace(/[^\x20-\x7e]/g, '.');
};
const u16 = (b: Uint8Array, o: number) => (o + 2 <= b.length ? (b[o] << 8) | b[o + 1] : 0);
const u32 = (b: Uint8Array, o: number) =>
  o + 4 <= b.length ? ((b[o] * 0x1000000) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]) : 0;
const u64 = (b: Uint8Array, o: number) => u32(b, o) * 0x100000000 + u32(b, o + 4);
const le16 = (b: Uint8Array, o: number) => (o + 2 <= b.length ? b[o] | (b[o + 1] << 8) : 0);
const le32 = (b: Uint8Array, o: number) =>
  o + 4 <= b.length ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] * 0x1000000)) : 0;
const hex32 = (n: number) => `0x${n.toString(16).padStart(8, '0')}`;

const MP4_CONTAINERS = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'mvex', 'moof', 'traf',
  'ilst', 'wave', 'sinf', 'schi', 'meta', 'tref', 'ipro', 'mfra', 'skip', 'free',
]);
const MP4_SAMPLE_CODECS: Record<string, string> = {
  avc1: 'H.264', avc3: 'H.264', hvc1: 'H.265', hev1: 'H.265', av01: 'AV1', vp09: 'VP9',
  mp4a: 'AAC', ac_3: 'AC-3', ec_3: 'E-AC-3', opus: 'Opus', alac: 'ALAC',
};

export function isMp4(b: Uint8Array): boolean {
  return b.length >= 12 && fourcc(b, 4) === 'ftyp';
}

export function isAvi(b: Uint8Array): boolean {
  return b.length >= 12 && fourcc(b, 0) === 'RIFF' && fourcc(b, 8) === 'AVI ';
}

export function parseMp4(b: Uint8Array): ContainerResult {
  const nodes: TreeNode[] = [];
  const info: InfoMap = { container: 'MP4 / ISO BMFF' };
  let trackCount = 0;
  let sampleCount = 0;
  let video = '';
  let audio = '';
  let duration = 0;
  let timescale = 0;
  let trackTimescale = 0; // 当前 trak 的 mdhd timescale（stts 换算用）
  let curHandler = ''; // 当前 trak 的 handler（vide/soun），用于把 stts 结果归到视频/音频
  let boxCount = 0;

  const addNode = (offset: number, size: number, type: string, depth: number, detail = '') => {
    if (nodes.length >= 5000) return;
    boxCount++;
    nodes.push({
      offset, size, type, depth,
      label: type === 'stsd' ? 'stsd (编码配置)' : type,
      detail,
    });
  };

  const parseStsd = (start: number, end: number, depth: number) => {
    const count = u32(b, start + 4);
    let p = start + 8;
    for (let i = 0; i < count && p + 8 <= end && i < 64; i++) {
      const size = u32(b, p);
      if (size < 8 || p + size > end) break;
      const type = fourcc(b, p + 4);
      const codec = MP4_SAMPLE_CODECS[type] ?? '';
      let detail = codec;
      if (type === 'avc1' || type === 'avc3' || type === 'hvc1' || type === 'hev1' || type === 'av01' || type === 'vp09') {
        const w = u16(b, p + 32);
        const h = u16(b, p + 34);
        if (w && h) detail += ` ${w}×${h}`;
        if (w && h) info.video = `${codec} ${w}×${h}`;
        video = codec;
      } else if (type === 'mp4a' || type === 'ac_3' || type === 'ec_3' || type === 'opus' || type === 'alac') {
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

  const walk = (start: number, end: number, depth: number) => {
    let p = start;
    let guard = 0;
    while (p + 8 <= end && guard++ < 200000) {
      let size = u32(b, p);
      const type = fourcc(b, p + 4);
      if (size === 1) size = u64(b, p + 8);
      if (size === 0) size = end - p;
      if (size < 8 || p + size > end) break;
      const payload = p + 8;
      let detail = '';
      if (type === 'ftyp') {
        const brand = fourcc(b, payload);
        detail = `brand ${brand}`;
        info.brand = brand;
      } else if (type === 'mvhd') {
        const v = b[payload];
        timescale = u32(b, payload + (v === 1 ? 20 : 12));
        duration = v === 1 ? u64(b, payload + 24) : u32(b, payload + 16);
        if (timescale && duration) info.duration = `${(duration / timescale).toFixed(3)} s`;
      } else if (type === 'mdhd') {
        const v = b[payload];
        const ts = u32(b, payload + (v === 1 ? 20 : 12));
        if (ts) trackTimescale = ts;
        if (ts && !timescale) timescale = ts;
      } else if (type === 'trak') {
        trackCount++;
      } else if (type === 'hdlr') {
        const handler = fourcc(b, payload + 8);
        curHandler = handler;
        if (handler === 'vide') info.video_handler = 'vide';
        if (handler === 'soun') info.audio_handler = 'soun';
      } else if (type === 'stts') {
        sampleCount += u32(b, payload + 8);
        // 时间-采样表：按 (sample_count, sample_delta) 累加，算出该轨首末时间与平均帧间隔
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
            const intervalMs = (dur / cnt / ts) * 1000;
            const fps = intervalMs > 0 ? 1000 / intervalMs : 0;
            const txt = `首帧 0.000s / 末帧 ${lastSec.toFixed(3)}s / 间隔 ${intervalMs.toFixed(2)}ms${fps ? ` / ${fps.toFixed(3)} fps` : ''}`;
            if (curHandler === 'soun') info.audio_pts = txt;
            else info.video_pts = txt;
          }
        }
        detail = `${u32(b, payload + 4)} 组时长`;
      } else if (type === 'ctts') {
        // 组合时间偏移：非零偏移数量≈存在 B 帧重排
        const entryCount = Math.min(256, u32(b, payload + 4));
        let nonzero = 0;
        for (let k = 0; k < entryCount; k++) {
          const o = payload + 8 + k * 8;
          if (o + 8 > p + size) break;
          if (u32(b, o + 4) !== 0) nonzero++;
        }
        detail = nonzero ? `CTTS 非零偏移 ${nonzero} 组（B 帧重排）` : 'CTTS 全零（无重排）';
        if (nonzero) info[`${curHandler === 'soun' ? 'audio' : 'video'}_ctts`] = `${nonzero} 组非零（有 B 帧重排）`;
      } else if (type === 'stsz') {
      } else if (type === 'mdat') {
        detail = '媒体数据';
      }
      addNode(p, size, type, depth, detail);
      if (type === 'stsd') parseStsd(payload, p + size, depth + 1);
      else if (MP4_CONTAINERS.has(type)) {
        // meta 是 FullBox：开头 4 字节 version/flags
        walk(payload + (type === 'meta' ? 4 : 0), p + size, depth + 1);
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
  return { format: 'MP4', info, nodes };
}

const AVI_CONTAINERS = new Set(['LIST']);
export function parseAvi(b: Uint8Array): ContainerResult {
  const nodes: TreeNode[] = [];
  const info: InfoMap = { container: 'AVI / RIFF' };
  let videoCodec = '';
  let frames = 0;
  let width = 0;
  let height = 0;
  let fps = 0;
  let chunkCount = 0;

  const walk = (start: number, end: number, depth: number) => {
    let p = start;
    let guard = 0;
    while (p + 8 <= end && guard++ < 200000) {
      const id = fourcc(b, p);
      const size = le32(b, p + 4);
      if (size < 0 || p + 8 + size > b.length) break;
      const data = p + 8;
      let detail = '';
      if (id === 'LIST') {
        const listType = fourcc(b, data);
        detail = listType;
        if (nodes.length < 5000) {
          nodes.push({ offset: p, size: size + 8, type: `LIST ${listType}`, label: `LIST ${listType}`, detail, depth });
        }
        walk(data + 4, Math.min(b.length, data + size), depth + 1);
      } else {
        if (nodes.length >= 5000) return;
        if (id === 'avih') {
          const us = le32(b, data);
          frames = le32(b, data + 16);
          width = le32(b, data + 32);
          height = le32(b, data + 36);
          if (us) fps = 1000000 / us;
          detail = `${width}×${height} ${frames} 帧`;
        } else if (id === 'strh') {
          const type = fourcc(b, data);
          const handler = fourcc(b, data + 4);
          const scale = le32(b, data + 20);
          const rate = le32(b, data + 24);
          const length = le32(b, data + 32);
          if (type === 'vids') {
            videoCodec = handler;
            if (scale) fps = rate / scale;
            if (!frames) frames = length;
            detail = `vids ${handler} ${fps ? fps.toFixed(3) + ' fps' : ''}`;
          } else if (type === 'auds') {
            detail = `auds ${handler}`;
          }
        } else if (id === 'strf') {
          // 视频 BITMAPINFOHEADER / 音频 WAVEFORMATEX，按前缀猜测
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
        } else if (id === 'movi') {
          detail = '媒体数据';
        } else if (id === 'idx1') {
          detail = `${size / 16} 个索引`;
        }
        if (id === '00dc' || id === '00db' || id === '01wb') chunkCount++;
        if (nodes.length < 5000) {
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
  return { format: 'AVI', info, nodes };
}
