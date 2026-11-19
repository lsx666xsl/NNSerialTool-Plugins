// 音视频解析插件：从任意会话的原始 RX 字节流里做增量协议识别。
// 设计目标：不依赖宿主内部数据结构，只消费 ctx.onRawData 的字节；
// 解析结果全部是只读统计 + 帧/包列表 + 十六进制预览，方便音视频联调时快速判断码流。
//
// 第二个入口是“文件解析”：用页面内 <input type=file>（无需额外宿主权限）导入
// MP4/AVI/裸码流，显示容器 box/chunk 树，并在右侧做可翻页的十六进制查看。
import { isMp4, isAvi, parseMp4, parseAvi, type TreeNode } from './container';

type Fmt = 'auto' | 'h264' | 'h265' | 'aac' | 'ts' | 'wav' | 'mjpeg';
type Row = {
  n: number;
  offset: number;
  size: number;
  time: number;
  kind: string;
  key: boolean;
  detail: string;
  hex: string;
};
type InfoMap = Record<string, string | number>;

const H264_NAMES: Record<number, string> = {
  1: 'SLICE', 2: 'SLICE-DPA', 3: 'SLICE-DPB', 4: 'SLICE-DPC', 5: 'IDR',
  6: 'SEI', 7: 'SPS', 8: 'PPS', 9: 'AUD', 10: 'END-SEQ', 11: 'END-STREAM',
  12: 'FILLER', 13: 'SPS-EXT', 14: 'PREFIX', 15: 'SUBSET-SPS', 19: 'AUX-SLICE',
};
const H265_NAMES: Record<number, string> = {
  0: 'TRAIL-N', 1: 'TRAIL-R', 2: 'TSA-N', 3: 'TSA-R', 4: 'STSA-N', 5: 'STSA-R',
  6: 'RADL-N', 7: 'RADL-R', 8: 'RASL-N', 9: 'RASL-R', 16: 'BLA-W-LP', 17: 'BLA-W-RADL',
  18: 'BLA-N-LP', 19: 'BLA-N-RADL', 20: 'IDR-W-RADL', 21: 'IDR-N-LP', 32: 'VPS',
  33: 'SPS', 34: 'PPS', 35: 'AUD', 39: 'SEI-PREFIX', 40: 'SEI-SUFFIX',
};
const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const TS_STREAM_TYPES: Record<number, string> = {
  0x0f: 'AAC ADTS', 0x1b: 'H.264', 0x24: 'H.265', 0x03: 'MPEG-2 audio',
  0x04: 'MPEG-2 audio', 0x81: 'AC-3', 0x87: 'E-AC-3', 0x15: 'ID3/metadata',
};

const hex = (b: Uint8Array, n = 64) =>
  Array.from(b.slice(0, n), (x) => x.toString(16).padStart(2, '0')).join(' ');

function detectFormat(b: Uint8Array): Fmt | null {
  if (b.length < 4) return null;
  // MJPEG / JPEG 序列：SOI(FFD8FF) 开头且能找到 SOF 标记
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'mjpeg';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45) return 'wav';
  // MPEG-TS: 三个连续 188 字节包以 0x47 同步
  for (let i = 0; i < Math.min(400, b.length - 376); i++) {
    if (b[i] === 0x47 && b[i + 188] === 0x47 && b[i + 376] === 0x47) return 'ts';
  }
  // ADTS AAC：同步字 + 合理 frame_length
  for (let i = 0; i < Math.min(4096, b.length - 7); i++) {
    if (b[i] === 0xff && (b[i + 1] & 0xf6) === 0xf0) {
      const len = ((b[i + 3] & 3) << 11) | (b[i + 4] << 3) | (b[i + 5] >> 5);
      if (len >= 7 && len <= 8191 && i + len <= b.length + 1) return 'aac';
    }
  }
  // H.264/H.265 Annex-B 判定见 detectNalFormat（单看第一个 NAL 头字节不足以定案）
  return detectNalFormat(b);
}

/*
*   描述：从 Annex-B 起始码序列里判定 H.264 / H.265。
*         抓流经常不是从码流头开始的（会话先连上、用户后切到本视图），首个 NAL 往往是
*         普通片，而 H.264 非 IDR 片头 0x41 / 0x65 与 HEVC 的 VPS/SPS 头字节存在重叠：
*         只按“第一个 NAL 头”判会把 H.264 片误判成 H.265（type=32 VPS），之后整个解析全错。
*         这里逐个 NAL 头找“决定性证据”，找不到就不锁定格式（返回 null），等后续数据
*         ——下一个 IDR 会带来 SPS/PPS，1~2 秒内一定能判定。
*/
function detectNalFormat(b: Uint8Array): Fmt | null {
  // HEVC 决定性头字节：VPS 0x40 / SPS 0x42 / PPS 0x44 / SEI 0x4e 0x50（层号 0）
  const HEVC_HEADERS = [0x40, 0x42, 0x44, 0x4e, 0x50];
  const limit = Math.min(b.length, 256 * 1024);
  for (let from = 0; from < limit;) {
    const sc = findStart(b, from);
    if (!sc) return null;
    const pos = sc.pos + sc.len;
    if (pos >= b.length) return null; // 头字节还没收到，等下一包，不能猜
    const h = b[pos];
    const hevcType = (h >> 1) & 0x3f;
    const h264Type = h & 0x1f;
    if (HEVC_HEADERS.includes(h)) return 'h265';
    // HEVC 的 nal_unit_type 只到 40，超出即 H.264（如 SPS 0x67→51、IDR 0x65→50、PPS 0x68→52）
    if (hevcType > 40 && h264Type >= 1 && h264Type <= 23) return 'h264';
    from = pos;
  }
  return null;
}

function findStart(b: Uint8Array, from: number): { pos: number; len: number } | null {
  for (let i = Math.max(0, from); i + 3 <= b.length; i++) {
    if (b[i] === 0 && b[i + 1] === 0) {
      if (b[i + 2] === 1) return { pos: i, len: 3 };
      if (i + 3 < b.length && b[i + 2] === 0 && b[i + 3] === 1) return { pos: i, len: 4 };
    }
  }
  return null;
}

function trimZeros(b: Uint8Array): Uint8Array {
  let end = b.length;
  while (end > 0 && b[end - 1] === 0) end--;
  return b.slice(0, end);
}

class BitReader {
  private bit = 0;
  constructor(private data: Uint8Array) {}
  u(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (this.bit >= this.data.length * 8) throw new Error('SPS 越界');
      const byte = this.data[this.bit >> 3];
      const bit = (byte >> (7 - (this.bit & 7))) & 1;
      v = v * 2 + bit;
      this.bit++;
    }
    return v;
  }
  ue(): number {
    let zeros = 0;
    while (this.u(1) === 0) {
      zeros++;
      if (zeros > 31) throw new Error('SPS ue 越界');
    }
    return 2 ** zeros - 1 + (zeros ? this.u(zeros) : 0);
  }
  se(): number {
    const v = this.ue();
    return v & 1 ? (v + 1) / 2 : -(v / 2);
  }
}

function stripEmulation(b: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < b.length; i++) {
    if (i >= 2 && b[i] === 3 && b[i - 1] === 0 && b[i - 2] === 0) continue;
    out.push(b[i]);
  }
  return Uint8Array.from(out);
}

/*
*   描述：解析 H.264 片头（NAL type 1/5）的 slice_type：I / P / B / SP / SI。
*         读 first_mb_in_slice(ue) + slice_type(ue)（5=IDR 中的 I 片，7=SI）。
*/
const SLICE_TYPES = ['P', 'B', 'I', 'SP', 'SI'] as const;
function parseH264SliceType(payload: Uint8Array): string | null {
  try {
    const rbsp = stripEmulation(payload.subarray(1));
    if (rbsp.length < 1) return null;
    const br = new BitReader(rbsp);
    br.ue(); // first_mb_in_slice
    const st = br.ue(); // slice_type（0..9，%5 得到 P/B/I/SP/SI）
    const base = SLICE_TYPES[st % 5];
    return base ?? null;
  } catch {
    return null;
  }
}

/*
*   描述：解析一帧 JPEG（MJPEG）的 SOF 段，取宽高与分量数。
*         找不到 SOF 时返回 null（该帧仍在传输或数据损坏）。
*/
function parseJpegFrame(
  b: Uint8Array,
  start: number
): { width: number; height: number; comps: number; size: number; qtables: number; q0: number; subsampling: string } | null {
  // 先找 EOI：帧是否收全只看这一件事（内层按段扫描时若要求剩余 ≥4 字节，
  // 会把“EOI 正好落在缓冲末尾”的最后一帧永久判成未完成 —— 实测少 1 帧）。
  let end = -1;
  for (let k = start + 2; k + 1 < b.length; k++) {
    if (b[k] === 0xff && b[k + 1] === 0xd9) {
      end = k + 2;
      break;
    }
  }
  if (end < 0) return null;
  let i = start + 2; // 跳过 SOI
  let width = 0;
  let height = 0;
  let comps = 0;
  let sawSof = false;
  let qtables = 0;
  let q0 = 0; // 第一张量化表的首值：数值越大压缩越狠（质量越低）
  let subsampling = '';
  while (i + 1 < end) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    if (marker === 0xd9) break; // EOI
    if (marker === 0x00 || marker === 0xff) { i += marker === 0xff ? 1 : 2; continue; }
    // 无长度的独立标记（RST0~RST7、SOI）
    if (marker >= 0xd0 && marker <= 0xd8) { i += 2; continue; }
    if (i + 3 >= end) break; // 段头未收全
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) break;
    // DQT：量化表（1 字节精度/表号 + 64 个系数，或 2 字节精度）
    if (marker === 0xdb && i + 4 < end) {
      const pq = b[i + 4] >> 4;
      const tq = b[i + 4] & 0x0f;
      if (pq === 0 && i + 5 < end) {
        qtables = Math.max(qtables, tq + 1);
        if (q0 === 0) q0 = b[i + 5];
      } else if (pq === 1 && i + 6 < end) {
        qtables = Math.max(qtables, tq + 1);
        if (q0 === 0) q0 = (b[i + 5] << 8) | b[i + 6];
      }
    }
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof && i + 9 < end) {
      height = (b[i + 5] << 8) | b[i + 6];
      width = (b[i + 7] << 8) | b[i + 8];
      comps = b[i + 9];
      // 分量采样因子：Y 的 (h,v) 相对 Cb/Cr 决定 4:2:0 / 4:2:2 / 4:4:4
      if (comps >= 3 && i + 9 + comps * 3 <= end + 2) {
        const ySamp = b[i + 11];
        const cSamp = b[i + 14];
        const yh = ySamp >> 4;
        const yv = ySamp & 0x0f;
        const ch = cSamp >> 4;
        const cv = cSamp & 0x0f;
        if (yh === 2 && yv === 2 && ch === 1 && cv === 1) subsampling = '4:2:0';
        else if (yh === 2 && yv === 1 && ch === 1 && cv === 1) subsampling = '4:2:2';
        else if (yh === 1 && yv === 1) subsampling = '4:4:4';
        else subsampling = `${yh}x${yv}`;
      } else if (comps === 1) {
        subsampling = '4:0:0 (灰度)';
      }
      sawSof = true;
      break;
    }
    i += 2 + len;
  }
  if (!sawSof) return null;
  return { width, height, comps, size: end - start, qtables, q0, subsampling };
}

function skipScalingList(br: BitReader, size: number) {
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

function parseH264Sps(nal: Uint8Array): InfoMap {
  const rbsp = stripEmulation(nal.slice(1));
  const br = new BitReader(rbsp);
  const profile = br.u(8);
  br.u(8); // constraint flags
  const level = br.u(8);
  br.ue(); // sps id
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
  br.ue(); // log2_max_frame_num_minus4
  const pocType = br.ue();
  if (pocType === 0) br.ue();
  else if (pocType === 1) {
    br.u(1); br.se(); br.se();
    const n = br.ue();
    for (let i = 0; i < n; i++) br.se();
  }
  br.ue(); // max_num_ref_frames
  br.u(1); // gaps
  const wMbs = br.ue() + 1;
  const hMap = br.ue() + 1;
  const frameMbsOnly = br.u(1);
  if (!frameMbsOnly) br.u(1);
  br.u(1); // direct8x8
  let cropL = 0, cropR = 0, cropT = 0, cropB = 0;
  if (br.u(1)) {
    cropL = br.ue(); cropR = br.ue(); cropT = br.ue(); cropB = br.ue();
  }
  const cropX = chroma === 3 ? 1 : 2;
  const cropY = chroma === 1 ? 2 : 1;
  const width = wMbs * 16 - (cropL + cropR) * cropX;
  const height = (2 - frameMbsOnly) * hMap * 16 - (cropT + cropB) * cropY;
  const out: InfoMap = {
    profile: `H.264 profile ${profile}`,
    level: (level / 10).toFixed(1),
    resolution: `${width}×${height}`,
    chroma: chroma === 1 ? '4:2:0' : chroma === 2 ? '4:2:2' : '4:4:4',
  };
  // VUI：真实帧率 / 宽高比 / 色彩矩阵——裸流没有容器时这些只能从 SPS 拿
  try {
    const u32 = () => br.u(16) * 65536 + br.u(16);
    if (br.u(1)) {
      // aspect_ratio_info_present_flag
      if (br.u(1)) {
        const idc = br.u(8);
        if (idc === 255) {
          const sarW = br.u(16);
          const sarH = br.u(16);
          out.aspect_ratio = `${sarW}:${sarH}`;
        } else {
          out.aspect_ratio = idc === 1 ? '1:1' : `idc ${idc}`;
        }
      }
      if (br.u(1)) br.u(1); // overscan_info
      if (br.u(1)) {
        br.u(3); // video_format
        br.u(1); // full_range
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
        // timing_info_present_flag：fps = time_scale / (2 * num_units_in_tick)
        const numUnits = u32();
        const timeScale = u32();
        br.u(1); // fixed_frame_rate_flag
        if (numUnits > 0 && timeScale > 0) out.fps = (timeScale / (2 * numUnits)).toFixed(3);
      }
    }
  } catch {
    /* VUI 不完整不影响基础字段 */
  }
  if (!out.fps) out.fps_hint = '无 VUI timing，需容器提供';
  return out;
}

class Analyzer {
  buf = new Uint8Array(0);
  total = 0;
  base = 0;
  pos = 0;
  fmt: Fmt = 'auto';
  actual: Fmt | null = null;
  rows: Row[] = [];
  info: InfoMap = {};
  errors = 0;
  firstT = 0;
  lastT = 0;
  private tsBase = -1;
  private tsPids = new Map<number, number>();
  private tsTypes = new Map<number, number>();
  private pmtPid = -1;
  private wavDone = false;
  private rowSeq = 0;
  // A/V 时间线事件：t=到达时刻(ms)，s=流(v/a)，key=关键帧，size=字节
  events: { t: number; s: 'v' | 'a'; key: boolean; size: number }[] = [];
  // 帧类型/长度统计（H.264 片类型 + GOP）
  sliceCount: Record<string, number> = {};
  gopSizes: number[] = [];
  private gopFrames = 0;
  // 真实图像帧计数（只算片/JPEG，不算 SPS/PPS/SEI/AUD）：fps 必须用它，
  // 否则把参数集 NAL 当帧算，会算出 86000 fps 这种荒谬值
  private picCount = 0;
  private picFirstT = 0;
  private picLastT = 0;

  setFormat(f: Fmt) {
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

  feed(bytes: Uint8Array, t: number) {
    if (!bytes.length) return;
    if (!this.firstT) this.firstT = t;
    this.lastT = t;
    this.total += bytes.length;
    const merged = new Uint8Array(this.buf.length + bytes.length);
    merged.set(this.buf);
    merged.set(bytes, this.buf.length);
    this.buf = merged;
    if (this.fmt !== 'auto' && !this.actual) this.actual = this.fmt;
    if (!this.actual) {
      const d = detectFormat(this.buf);
      if (d) this.actual = d;
    }
    if (!this.actual) return;
    try {
      if (this.actual === 'h264') this.parseH264(false);
      else if (this.actual === 'h265') this.parseH264(true);
      else if (this.actual === 'aac') this.parseAac();
      else if (this.actual === 'ts') this.parseTs();
      else if (this.actual === 'wav') this.parseWav();
      else if (this.actual === 'mjpeg') this.parseJpeg();
    } catch {
      this.errors++;
    }
    // 缓冲上限：优先丢弃已解析部分；若解析位置长期停滞（半帧、只有单个起始码、未识别格式），
    // 必须强制丢弃最旧数据，否则缓冲区会无限增长（安全扫描实测：文本/单起始码/无 EOI 三条路径
    // 都能绕过“pos > 4MB 才裁剪”的旧条件，最终把 WebView 撑爆）。
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

  private push(row: Omit<Row, 'n' | 'time' | 'hex'> & { hex?: string }, stream: 'v' | 'a' = 'v') {
    this.rows.push({
      ...row,
      n: ++this.rowSeq,
      time: this.lastT,
      hex: row.hex ?? '',
    });
    // 长时间抓流时保留最近 5000 项，避免行数组无限增长；
    // 行号仍单调递增，UI 用绝对序号展示。
    if (this.rows.length > 5000) this.rows.splice(0, this.rows.length - 5000);
    // 时间线事件按到达时刻记录（最多保留最近 20000 条，够画几分钟的时间线）
    this.events.push({ t: this.lastT, s: stream, key: row.key, size: row.size });
    if (this.events.length > 20000) this.events.splice(0, this.events.length - 20000);
  }

  private parseH264(hevc: boolean) {
    let guard = 0;
    while (guard++ < 5000) {
      const start = findStart(this.buf, this.pos);
      if (!start) {
        this.pos = Math.max(0, this.buf.length - 4);
        return;
      }
      this.pos = start.pos;
      const next = findStart(this.buf, start.pos + start.len);
      if (!next) return;
      const payload = trimZeros(this.buf.slice(start.pos + start.len, next.pos));
      if (!payload.length) { this.pos = next.pos; continue; }
      const h = payload[0];
      const type = hevc ? (h >> 1) & 0x3f : h & 0x1f;
      const key = hevc ? (type >= 16 && type <= 21) : type === 5;
      // HEVC 的图像帧：nal_unit_type 0..21（含 IDR/IRAP），32+ 是 VPS/SPS/PPS/SEI，不算帧
      if (hevc && type <= 21) {
        this.picCount++;
        if (!this.picFirstT) this.picFirstT = this.lastT;
        this.picLastT = this.lastT;
      }
      const names = hevc ? H265_NAMES : H264_NAMES;
      const name = names[type] ?? (hevc ? `NAL-${type}` : `NAL-${type}`);
      // 片类型（I/P/B/SP/SI）：仅 H.264 的 1/5 号 NAL 有片头；用于帧类型统计与 GOP 长度
      let slice: string | null = null;
      if (!hevc && (type === 1 || type === 5)) {
        slice = parseH264SliceType(payload);
        if (slice) {
          this.sliceCount[slice] = (this.sliceCount[slice] ?? 0) + 1;
          this.picCount++;
          if (!this.picFirstT) this.picFirstT = this.lastT;
          this.picLastT = this.lastT;
          // IDR 或 I 片视为新 GOP 起点
          if (slice === 'I') {
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
          this.info.sps = 'SPS 解析失败';
        }
      }
      // SEI（NAL 6）：列出负载类型（1=画面时码、5=用户数据、6=恢复点、47=HDR 元数据等）
      if (!hevc && type === 6) {
        try {
          const rbsp = stripEmulation(payload.subarray(1));
          const types: number[] = [];
          let p = 0;
          while (p < rbsp.length && types.length < 8) {
            let pt = 0;
            while (p < rbsp.length && rbsp[p] === 0xff) { pt += 255; p++; }
            if (p >= rbsp.length) break;
            pt += rbsp[p++];
            let ps = 0;
            while (p < rbsp.length && rbsp[p] === 0xff) { ps += 255; p++; }
            if (p >= rbsp.length) break;
            ps += rbsp[p++];
            types.push(pt);
            p += ps;
            if (rbsp[p] === 0x80) break;
          }
          if (types.length) this.info.sei = types.map((t) => `type ${t}`).join(', ');
        } catch {
          /* SEI 解析失败忽略 */
        }
      }
      this.push({
        offset: this.base + start.pos,
        size: next.pos - start.pos,
        kind: name,
        key,
        detail: `${hevc ? 'H.265' : 'H.264'} type=${type} ref=${hevc ? '' : (h >> 5) & 3}${slice ? ` · ${slice} 片` : ''}`,
        hex: hex(payload),
      }, 'v');
      this.pos = next.pos;
    }
  }

  /*
  *   描述：MJPEG（连续 JPEG 帧）解析：逐帧定位 SOI…EOI，读 SOF 取分辨率。
  *         每帧都是独立关键帧（帧内编码），这也是 MJPEG 码率高的原因。
  */
  private parseJpeg() {
    let guard = 0;
    while (guard++ < 2000) {
      // 找下一个 SOI
      let start = -1;
      for (let i = this.pos; i + 2 < this.buf.length; i++) {
        if (this.buf[i] === 0xff && this.buf[i + 1] === 0xd8 && this.buf[i + 2] === 0xff) { start = i; break; }
      }
      if (start < 0) {
        this.pos = Math.max(0, this.buf.length - 2);
        return;
      }
      const frame = parseJpegFrame(this.buf, start);
      if (!frame) {
        // 帧还没收全：停在 SOI 处等后续数据
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
        kind: 'JPEG 帧',
        key: true,
        detail: `${frame.width}×${frame.height} ${frame.comps}分量${frame.subsampling ? ' ' + frame.subsampling : ''}${frame.qtables ? ` · DQT×${frame.qtables} Q0=${frame.q0}` : ''}`,
        hex: hex(this.buf.slice(start, Math.min(start + 64, this.buf.length))),
      }, 'v');
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
      if (e.s === 'v') {
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
    const kbps = (bytes: number) => (durMs > 0 ? (bytes * 8) / durMs : 0); // bit/ms === kbit/s
    // H.264 的分辨率由 SPS 解析成 "宽×高" 字符串（info.resolution），概览也要用上，
    // 否则会显示“分辨率未知”。MJPEG 路径另存了数值型 width/height，两者都兼容。
    const dim = /^(\d+)×(\d+)$/.exec(String(this.info.resolution ?? ''));
    return {
      durMs,
      video: {
        count: vCount,
        bytes: vBytes,
        kbps: kbps(vBytes),
        // fps 只按真实图像帧算（片/JPEG），且用图像帧自己的首末时间
        fps: this.picCount > 1 && this.picLastT > this.picFirstT ? (this.picCount - 1) / ((this.picLastT - this.picFirstT) / 1000) : 0,
        keyFrames: vKey,
        gopAvg,
        slices: { ...this.sliceCount },
        width: Number(this.info.width ?? 0) || (dim ? Number(dim[1]) : 0),
        height: Number(this.info.height ?? 0) || (dim ? Number(dim[2]) : 0),
        // MJPEG 的分量数（1=灰度 / 3=YCbCr）此前只出现在 info 栅格与帧表，概览里看不到
        comps: Number(this.info.comps ?? 0),
        spanMs: vLast > vFirst ? vLast - vFirst : 0,
      },
      audio: {
        count: aCount,
        bytes: aBytes,
        kbps: kbps(aBytes),
        spanMs: aLast > aFirst ? aLast - aFirst : 0,
        sampleRate: parseInt(String(this.info.sample_rate ?? '0'), 10) || 0,
        channels: parseInt(String(this.info.channels ?? '0'), 10) || 0,
      },
    };
  }

  private parseAac() {
    let guard = 0;
    while (guard++ < 5000) {
      const b = this.buf;
      if (this.pos + 7 > b.length) return;
      const i = this.pos;
      if (b[i] !== 0xff || (b[i + 1] & 0xf6) !== 0xf0) {
        this.pos++;
        this.errors++;
        continue;
      }
      const profile = (b[i + 2] >> 6) & 3;
      const sf = (b[i + 2] >> 2) & 0xf;
      if (sf >= SAMPLE_RATES.length) { this.pos++; this.errors++; continue; }
      const channels = ((b[i + 2] & 1) << 2) | (b[i + 3] >> 6);
      const frameLen = ((b[i + 3] & 3) << 11) | (b[i + 4] << 3) | (b[i + 5] >> 5);
      if (frameLen < 7 || i + frameLen > b.length) return;
      this.info.codec = 'AAC ADTS';
      this.info.sample_rate = `${SAMPLE_RATES[sf]} Hz`;
      this.info.channels = `${channels} ch`;
      this.info.profile = `AAC profile ${profile}`;
      this.push({
        offset: this.base + i, size: frameLen, kind: 'AAC',
        key: false, detail: `${SAMPLE_RATES[sf]}Hz ${channels}ch`,
        hex: hex(b.slice(i, i + frameLen)),
      }, 'a');
      this.pos += frameLen;
    }
  }

  private parseTs() {
    const b = this.buf;
    if (this.tsBase < 0) {
      for (let i = 0; i < Math.min(400, b.length - 376); i++) {
        if (b[i] === 0x47 && b[i + 188] === 0x47 && b[i + 376] === 0x47) {
          this.tsBase = i;
          break;
        }
      }
      if (this.tsBase < 0) return;
      this.pos = this.tsBase;
    }
    let guard = 0;
    while (guard++ < 5000) {
      const i = this.pos;
      if (i + 188 > b.length) return;
      if (b[i] !== 0x47) { this.pos++; this.errors++; continue; }
      const pusi = !!(b[i + 1] & 0x40);
      const pid = ((b[i + 1] & 0x1f) << 8) | b[i + 2];
      const afc = (b[i + 3] >> 4) & 3;
      let p = i + 4;
      if (afc & 2) p += 1 + b[p];
      if (p > i + 188) { this.pos += 188; this.errors++; continue; }
      this.tsPids.set(pid, (this.tsPids.get(pid) ?? 0) + 1);
      if (pusi && (afc & 1)) {
        const payload = b.slice(p, i + 188);
        if (pid === 0) this.parsePat(payload);
        else if (pid === this.pmtPid) this.parsePmt(payload);
        if (payload.length) {
          const stream = this.tsTypes.get(pid);
          this.push({
            offset: this.base + i, size: 188, kind: `TS PID 0x${pid.toString(16).padStart(4, '0')}`,
            key: false, detail: stream ? TS_STREAM_TYPES[stream] ?? `type 0x${stream.toString(16)}` : 'PES',
            hex: hex(payload),
          }, stream === 0x0f ? 'a' : 'v');
        }
      }
      this.pos += 188;
    }
  }

  private parsePat(payload: Uint8Array) {
    let p = 1 + payload[0];
    if (p + 8 > payload.length || payload[p] !== 0) return;
    const sectionLen = ((payload[p + 1] & 0x0f) << 8) | payload[p + 2];
    const end = Math.min(payload.length, p + 3 + sectionLen - 4);
    let q = p + 8;
    while (q + 4 <= end) {
      const prog = (payload[q] << 8) | payload[q + 1];
      const pid = ((payload[q + 2] & 0x1f) << 8) | payload[q + 3];
      if (prog !== 0) this.pmtPid = pid;
      q += 4;
    }
    this.info.pat = this.pmtPid >= 0 ? `PMT PID 0x${this.pmtPid.toString(16)}` : 'PAT 已发现';
  }

  private parsePmt(payload: Uint8Array) {
    let p = 1 + payload[0];
    if (p + 12 > payload.length || payload[p] !== 2) return;
    const sectionLen = ((payload[p + 1] & 0x0f) << 8) | payload[p + 2];
    const end = Math.min(payload.length, p + 3 + sectionLen - 4);
    const infoLen = ((payload[p + 10] & 0x0f) << 8) | payload[p + 11];
    let q = p + 12 + infoLen;
    while (q + 5 <= end) {
      const type = payload[q];
      const pid = ((payload[q + 1] & 0x1f) << 8) | payload[q + 2];
      const esLen = ((payload[q + 3] & 0x0f) << 8) | payload[q + 4];
      this.tsTypes.set(pid, type);
      q += 5 + esLen;
    }
    this.info.pmt = `${this.tsTypes.size} 个流`;
    this.info.pids = `${this.tsPids.size} 个 PID`;
  }

  private parseWav() {
    if (this.wavDone || this.buf.length < 44) return;
    const b = this.buf;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (b[0] !== 0x52 || b[8] !== 0x57) return;
    let p = 12;
    let fmt = -1, channels = 0, rate = 0, bits = 0, data = 0;
    while (p + 8 <= b.length) {
      const id = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
      const size = dv.getUint32(p + 4, true);
      if (id === 'fmt ' && p + 24 <= b.length) {
        fmt = dv.getUint16(p + 8, true);
        channels = dv.getUint16(p + 10, true);
        rate = dv.getUint32(p + 12, true);
        bits = dv.getUint16(p + 22, true);
      } else if (id === 'data') data = size;
      p += 8 + size + (size & 1);
    }
    this.info.codec = fmt === 1 ? 'PCM' : fmt === 3 ? 'IEEE float' : `WAV fmt ${fmt}`;
    this.info.sample_rate = `${rate} Hz`;
    this.info.channels = `${channels} ch`;
    this.info.bit_depth = `${bits} bit`;
    this.info.data_size = data;
    this.push({
      offset: 0, size: Math.min(b.length, 44), kind: 'WAV',
      key: true, detail: `${rate}Hz ${channels}ch ${bits}bit`, hex: hex(b),
    }, 'a');
    this.wavDone = true;
    this.pos = b.length;
  }
}

const STYLE = `
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
.theme-dark .av-select, .theme-dark .av-btn, .theme-dark .av-card, .theme-dark .av-info,
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

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const bytesText = (n: number) => n > 1024 * 1024 ? `${(n / 1048576).toFixed(2)} MB` : n > 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;

function activate(ctx: any) {
  ctx.registerView({
    id: 'av',
    name: '音视频解析',
    tip: '实时/文件：H.264/H.265、AAC、MPEG-TS、WAV；MP4/AVI 容器结构与二进制',
    blocks: 2,
    component: {
      mount(el: HTMLElement, ctx: any) {
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
        const $ = (s: string) => el.querySelector(s) as HTMLElement;
        const source = $('.av-source') as HTMLSelectElement;
        const format = $('.av-format') as HTMLSelectElement;
        const pauseBtn = $('.av-pause') as HTMLButtonElement;
        const body = $('.av-body') as HTMLElement;
        const tableWrap = $('.av-table-wrap') as HTMLElement;
        const emptyBox = $('.av-empty-box') as HTMLElement;
        const infoBox = $('.av-info-box') as HTMLElement;
        const sumBox = $('.av-sum-box') as HTMLElement;
        const tlCanvas = $('.av-tl-canvas') as HTMLCanvasElement;
        const fsCanvas = $('.av-fs-canvas') as HTMLCanvasElement;
        const hexBox = $('.av-hex-box') as HTMLElement;
        const statusLeft = $('.av-status-left') as HTMLElement;
        const statusRight = $('.av-status-right') as HTMLElement;
        const root = $('.av-root') as HTMLElement;
        const tabs = document.createElement('div');
        tabs.className = 'av-tabs';
        tabs.innerHTML = `<button class="av-tab on" data-tab="live">实时数据</button><button class="av-tab" data-tab="file">文件解析</button>`;
        root.insertBefore(tabs, root.firstChild);
        const filePane = document.createElement('div');
        filePane.className = 'av-file';
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
        root.insertBefore(filePane, statusLeft.parentElement as Node);
        const liveNodes = Array.from(root.children).filter((n) => n !== tabs && n !== filePane) as HTMLElement[];
        const tabLive = tabs.querySelector('[data-tab="live"]') as HTMLElement;
        const tabFile = tabs.querySelector('[data-tab="file"]') as HTMLElement;
        const analyzer = new Analyzer();
        let selected = '';
        let paused = false;
        let selectedRow = -1;
        let timer = 0;

        // ---------- 文件解析 ----------
        let fileBytes: Uint8Array | null = null;
        let fileNodes: TreeNode[] = [];
        let fileFormat = '—';
        let fileSelected = -1;
        let hexOffset = 0;
        let fileAnalyzer: Analyzer | null = null;
        const fileImport = filePane.querySelector('.av-import') as HTMLButtonElement;
        const fileInput = filePane.querySelector('.av-fileinput') as HTMLInputElement;
        const fileClear = filePane.querySelector('.av-fileclear') as HTMLButtonElement;
        const fileNameEl = filePane.querySelector('.av-file-name') as HTMLElement;
        const fileDrop = filePane.querySelector('.av-drop') as HTMLElement;
        const fName = filePane.querySelector('.av-f-name') as HTMLElement;
        const fSize = filePane.querySelector('.av-f-size') as HTMLElement;
        const fFormat = filePane.querySelector('.av-f-format') as HTMLElement;
        const fNodes = filePane.querySelector('.av-f-nodes') as HTMLElement;
        const fInfo = filePane.querySelector('.av-f-info') as HTMLElement;
        const treeWrap = filePane.querySelector('.av-tree-wrap') as HTMLElement;
        const treeBody = filePane.querySelector('.av-tree-body') as HTMLElement;
        const hexDump = filePane.querySelector('.av-hexdump') as HTMLElement;
        const hexInput = filePane.querySelector('.av-hex-input') as HTMLInputElement;
        const hexRange = filePane.querySelector('.av-hex-range') as HTMLElement;
        const playBtn = filePane.querySelector('.av-play') as HTMLButtonElement;
        const player = filePane.querySelector('.av-player') as HTMLElement;
        const playerVideo = filePane.querySelector('.av-player-video') as HTMLVideoElement;
        const playerMsg = filePane.querySelector('.av-player-msg') as HTMLElement;
        let playerUrl = '';
        const closePlayer = () => {
          player.hidden = true;
          playerVideo.pause();
          playerVideo.removeAttribute('src');
          playerVideo.load();
          if (playerUrl) URL.revokeObjectURL(playerUrl);
          playerUrl = '';
        };
        const openPlayer = () => {
          if (!fileBytes) return;
          const name = (fileNameEl.dataset.name || '').toLowerCase();
          player.hidden = false;
          playerMsg.textContent = '';
          playerVideo.hidden = false;
          if (!/\.(mp4|m4v|mov|wav)$/.test(name)) {
            playerVideo.hidden = true;
            playerMsg.textContent = /\.avi$/.test(name)
              ? 'AVI 容器 Chromium/WebView2 不原生支持解码：当前只能查看结构与二进制。可另存为 MP4 再播放。'
              : '当前格式不支持浏览器内播放（MP4/M4V/MOV/WAV 可播；裸 H.264/AAC/TS 需先封装）。';
            return;
          }
          if (playerUrl) URL.revokeObjectURL(playerUrl);
          const mime = /\.wav$/.test(name) ? 'audio/wav' : 'video/mp4';
          playerUrl = URL.createObjectURL(new Blob([fileBytes], { type: mime }));
          playerVideo.src = playerUrl;
          playerVideo.onerror = () => {
            playerMsg.textContent = '浏览器无法解码该文件（可能是 HEVC/不支持的编码，或带 DRM）。';
          };
          void playerVideo.play().catch(() => {});
        };
        const HELLX_PAGE = 4096;

        const renderFileHex = () => {
          if (!fileBytes || fileBytes.length === 0) {
            hexDump.textContent = '文件为空';
            hexRange.textContent = '';
            return;
          }
          hexOffset = Math.max(0, Math.min(fileBytes.length - 1, hexOffset));
          const start = Math.floor(hexOffset / 16) * 16;
          const end = Math.min(fileBytes.length, start + HELLX_PAGE);
          // 窄面板用 8 字节/行，宽面板用标准 16 字节/行，避免二进制区横向滚动。
          const bpl = hexDump.clientWidth > 430 ? 16 : 8;
          const sel = fileNodes[fileSelected];
          const lines: string[] = [];
          for (let off = start; off < end; off += bpl) {
            const chunk = fileBytes.subarray(off, Math.min(end, off + bpl));
            let bytes = '';
            let ascii = '';
            for (let i = 0; i < bpl; i++) {
              if (i < chunk.length) {
                const v = chunk[i];
                bytes += v.toString(16).padStart(2, '0') + (i === bpl / 2 - 1 ? '  ' : ' ');
                ascii += v >= 0x20 && v <= 0x7e ? String.fromCharCode(v) : '.';
              } else {
                bytes += '   ';
              }
            }
            const hit = sel && off < sel.offset + sel.size && off + bpl > sel.offset;
            lines.push(`<span class="av-hexline${hit ? ' hit' : ''}"><span class="av-hex-off">${off.toString(16).padStart(8, '0')}</span>${bytes}<span class="av-hex-ascii">${esc(ascii)}</span></span>`);
          }
          hexDump.innerHTML = lines.join('');
          hexRange.textContent = `${start.toString(16).toUpperCase()}–${end.toString(16).toUpperCase()} / ${fileBytes.length.toString(16).toUpperCase()}`;
          hexInput.value = start.toString(16).toUpperCase();
        };

        const renderFile = () => {
          fileDrop.hidden = !!fileBytes;
          playBtn.disabled = !fileBytes;
          if (!fileBytes) {
            fileNameEl.textContent = '未导入文件';
            fName.textContent = '—';
            fSize.textContent = '—';
            fFormat.textContent = '—';
            fNodes.textContent = '0';
            fInfo.innerHTML = '<div><span>提示：</span><b>导入 MP4/AVI/裸码流文件后显示容器结构与十六进制</b></div>';
            treeBody.innerHTML = '';
            hexDump.textContent = '未导入文件';
            hexRange.textContent = '';
            return;
          }
          fileNameEl.textContent = `${fileBytes.length} 字节`;
          fName.textContent = fileNameEl.dataset.name || '文件';
          fSize.textContent = bytesText(fileBytes.length);
          fFormat.textContent = fileFormat;
          fNodes.textContent = String(fileNodes.length);
          const infoEntries = fileAnalyzer ? Object.entries(fileAnalyzer.info) : [];
          fInfo.innerHTML = infoEntries.length
            ? infoEntries.map(([k, v]) => `<div><span>${esc(k)}：</span><b>${esc(String(v))}</b></div>`).join('')
            : '<div><span>提示：</span><b>可点击左侧结构项跳转到对应二进制位置</b></div>';
          const st = treeWrap.scrollTop;
          treeBody.innerHTML = fileNodes.slice(0, 3000).map((n, i) => `
            <tr class="row${i === fileSelected ? ' sel' : ''}" data-fi="${i}">
              <td style="padding-left:${7 + n.depth * 12}px"><span class="depth">${n.depth ? '└ ' : ''}</span>${esc(n.label)}</td>
              <td>${n.offset}</td><td>${n.size}</td><td>${esc(n.detail)}</td>
            </tr>`).join('');
          treeWrap.scrollTop = st;
          renderFileHex();
        };

        const loadFile = async (file: File) => {
          if (!file) return;
          if (file.size > 256 * 1024 * 1024) {
            ctx.notify('文件超过 256MB，暂不支持（避免 WebView 内存爆掉）');
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
              // 复用 info 显示：用匿名 Analyzer 仅承载 info
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
              fileFormat = (a.actual ?? 'RAW').toUpperCase();
              fileNodes = a.rows.slice(0, 3000).map((row) => ({
                offset: row.offset, size: row.size, type: row.kind, label: row.kind,
                detail: row.detail, depth: 0,
              }));
            }
            setTab('file');
            renderFile();
          } catch (e) {
            ctx.notify(`读取文件失败：${e instanceof Error ? e.message : e}`);
          }
        };

        const setTab = (mode: 'live' | 'file') => {
          tabLive.classList.toggle('on', mode === 'live');
          tabFile.classList.toggle('on', mode === 'file');
          liveNodes.forEach((n) => { n.hidden = mode === 'file'; });
          filePane.hidden = mode !== 'file';
          if (mode === 'file') renderFile();
        };
        tabLive.addEventListener('click', () => setTab('live'));
        tabFile.addEventListener('click', () => setTab('file'));
        fileImport.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => {
          const f = fileInput.files?.[0];
          if (f) void loadFile(f);
          fileInput.value = '';
        });
        fileClear.addEventListener('click', () => {
          closePlayer();
          fileBytes = null;
          fileNodes = [];
          fileAnalyzer = null;
          fileFormat = '—';
          fileSelected = -1;
          hexOffset = 0;
          renderFile();
        });
        playBtn.addEventListener('click', openPlayer);
        (filePane.querySelector('.av-player-close') as HTMLElement).addEventListener('click', closePlayer);
        treeBody.addEventListener('click', (e) => {
          const tr = (e.target as HTMLElement).closest('tr[data-fi]') as HTMLElement | null;
          if (!tr) return;
          fileSelected = Number(tr.dataset.fi);
          hexOffset = fileNodes[fileSelected]?.offset ?? 0;
          renderFile();
        });
        const goHex = () => {
          const v = parseInt(hexInput.value.replace(/^0x/i, ''), 16);
          if (Number.isFinite(v)) {
            hexOffset = Math.max(0, Math.min((fileBytes?.length ?? 1) - 1, v));
            renderFileHex();
          }
        };
        (filePane.querySelector('.av-hex-go') as HTMLElement).addEventListener('click', goHex);
        hexInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') goHex(); });
        (filePane.querySelector('.av-hex-prev') as HTMLElement).addEventListener('click', () => {
          hexOffset = Math.max(0, hexOffset - HELLX_PAGE);
          renderFileHex();
        });
        (filePane.querySelector('.av-hex-next') as HTMLElement).addEventListener('click', () => {
          hexOffset = Math.min((fileBytes?.length ?? 1) - 1, hexOffset + HELLX_PAGE);
          renderFileHex();
        });
        filePane.addEventListener('dragover', (e) => { e.preventDefault(); fileDrop.classList.add('over'); });
        filePane.addEventListener('dragleave', () => fileDrop.classList.remove('over'));
        filePane.addEventListener('drop', (e) => {
          e.preventDefault();
          fileDrop.classList.remove('over');
          const f = e.dataTransfer?.files?.[0];
          if (f) void loadFile(f);
        });

        const formatName = () => analyzer.fmt === 'auto' ? (analyzer.actual ?? '等待识别') : analyzer.fmt.toUpperCase();
        const schedule = () => {
          if (timer) return;
          timer = window.setTimeout(() => { timer = 0; render(); }, 120);
        };
        const renderSessions = () => {
          const list = ctx.listSessions();
          if (!selected && list.length) selected = list[0].id;
          if (selected && !list.some((s: any) => s.id === selected)) selected = list[0]?.id ?? '';
          source.innerHTML = `<option value="">选择数据源会话</option>` + list
            .map((s: any) => `<option value="${esc(s.id)}">${esc(s.name)}${s.status === 'connected' ? '' : '（未连接）'}</option>`)
            .join('');
          source.value = selected;
          statusLeft.textContent = selected
            ? `数据源：${list.find((s: any) => s.id === selected)?.name ?? selected}`
            : '未选择数据源';
        };
        const render = () => {
          const rate = analyzer.firstT && analyzer.lastT > analyzer.firstT
            ? (analyzer.total * 8 / 1000 / ((analyzer.lastT - analyzer.firstT) / 1000)).toFixed(1) + ' kbps'
            : '—';
          $('.av-format-v').textContent = formatName();
          $('.av-bytes').textContent = bytesText(analyzer.total);
          $('.av-count').textContent = String(analyzer.rows.length);
          $('.av-rate').textContent = rate;
          $('.av-keyerr').textContent = `${analyzer.rows.filter((r) => r.key).length} / ${analyzer.errors}`;
          const info = Object.entries(analyzer.info);
          infoBox.innerHTML = info.length
            ? info.map(([k, v]) => `<div><span>${esc(k)}：</span><b>${esc(String(v))}</b></div>`).join('')
            : '<div><span>提示：</span><b>等待码流识别（H.264/H.265、ADTS AAC、MPEG-TS、WAV）</b></div>';
          const rows = analyzer.rows.slice(-160);
          emptyBox.style.display = rows.length ? 'none' : 'block';
          const scrollTop = tableWrap.scrollTop;
          body.innerHTML = rows.map((r, i) => {
            const idx = analyzer.rows.length - rows.length + i;
            return `<tr class="row${idx === selectedRow ? ' sel' : ''}" data-i="${idx}">
              <td>${r.n}</td><td>${r.offset}</td><td>${esc(r.kind)}</td><td>${r.size} B</td>
              <td class="${r.key ? 'av-key' : ''}">${r.key ? '●' : ''}</td><td>${esc(r.detail)}</td></tr>`;
          }).join('');
          tableWrap.scrollTop = scrollTop;
          statusRight.textContent = `已解析 ${analyzer.rows.length} 项 · ${analyzer.errors} 个错误`;
          renderAvSummary();
          renderTimeline();
          renderFrameSizes();
          renderHex();
        };
        /*
        *   描述：A/V 汇总结论（时长、视频/音频帧数与码率、分辨率、GOP、音频参数）。
        *         用户关心的是“这段码流里什么时候有视频、什么时候有音频、各自多长”。
        */
        const renderAvSummary = () => {
          const s = analyzer.summary();
          const dur = s.durMs > 0 ? (s.durMs / 1000).toFixed(2) + ' s' : '—';
          const v = s.video;
          const a = s.audio;
          const fmtK = (n: number) => (n > 0 ? n.toFixed(1) + ' kbps' : '—');
          const sliceTxt = Object.entries(v.slices).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`).join(' ') || '—';
          sumBox.innerHTML = [
            `<div><span>总时长：</span><b data-k="dur">${dur}</b></div>`,
            `<div><span>视频：</span><b data-k="v">${v.count ? `${v.count} 帧 · ${fmtK(v.kbps)} · ${v.fps.toFixed(1)} fps` : '无'}</b></div>`,
            v.count
              ? `<div><span>视频详情：</span><b>${v.width && v.height ? `${v.width}×${v.height}` : '分辨率未知'}${v.comps ? ` ${v.comps}分量` : ''} · 关键帧 ${v.keyFrames} · GOP≈${v.gopAvg || '—'} · 片类型 ${sliceTxt}</b></div>`
              : '<div><span>视频详情：</span><b>—</b></div>',
            `<div><span>音频：</span><b data-k="a">${a.count ? `${a.count} 帧 · ${fmtK(a.kbps)}${a.sampleRate ? ` · ${a.sampleRate} Hz ${a.channels}ch` : ''}` : '无'}</b></div>`,
            `<div><span>音视频存在性：</span><b data-k="presence">${v.count && a.count ? '音视频都有' : v.count ? '仅视频' : a.count ? '仅音频' : '无数据'}</b></div>`,
          ].join('');
        };
        /*
        *   描述：A/V 时间线：两行泳道（视频/音频），按到达时间打点；关键帧用高亮色。
        *         一眼能看出“什么时候有视频、什么时候有音频、中间有没有断流”。
        */
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
          const g = tlCanvas.getContext('2d');
          if (!g) return;
          g.setTransform(dpr, 0, 0, dpr, 0, 0);
          g.clearRect(0, 0, cssW, cssH);
          const t0 = analyzer.firstT;
          const t1 = analyzer.lastT;
          const span = Math.max(1, t1 - t0);
          const axisH = 14;
          const laneH = Math.floor((cssH - axisH - 4) / 2);
          // 泳道背景
          g.fillStyle = 'rgba(128,132,140,.10)';
          g.fillRect(0, 0, cssW, laneH);
          g.fillRect(0, laneH + 4, cssW, laneH);
          g.fillStyle = 'rgba(128,132,140,.85)';
          g.font = '10px Consolas, monospace';
          g.textBaseline = 'middle';
          g.fillText('视频', 2, laneH / 2);
          g.fillText('音频', 2, laneH + 4 + laneH / 2);
          for (const e of analyzer.events) {
            const x = ((e.t - t0) / span) * (cssW - 30) + 30;
            if (e.s === 'v') {
              g.fillStyle = e.key ? '#e0837f' : '#6ca7e8';
              g.fillRect(x, 0, e.key ? 2 : 1, laneH);
            } else {
              g.fillStyle = '#6bc97e';
              g.fillRect(x, laneH + 4, 1, laneH);
            }
          }
          // 时间刻度
          g.fillStyle = 'rgba(128,132,140,.85)';
          g.textBaseline = 'top';
          g.fillText('0 s', 30, cssH - 12);
          const midTxt = (span / 2000).toFixed(1) + ' s';
          g.fillText(midTxt, 30 + (cssW - 30) / 2 - 14, cssH - 12);
          g.fillText((span / 1000).toFixed(2) + ' s', cssW - 42, cssH - 12);
        };
        /*
        *   描述：帧大小曲线（码率包络）：最近 400 帧的字节数柱状图。
        *         关键帧=红、普通视频帧=蓝、音频帧=绿；音频的柱高即为“能量包络”的近似
        *         （AAC 不解码就无法得到真实 PCM 幅度，帧字节数是最接近的代理量）。
        */
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
          const g = fsCanvas.getContext('2d');
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
            if (e.s === 'v') {
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
            // 对数刻度：I 帧通常是 P 帧的 5~10 倍，线性刻度会把普通帧压成一条线
            const ratio = Math.log10(1 + (e.size / maxSize) * 99) / 2;
            const h = Math.max(1, ratio * plotH);
            g.fillStyle = e.s === 'a' ? '#6bc97e' : e.key ? '#e0837f' : '#6ca7e8';
            g.fillRect(i * barW, plotH - h, Math.max(1, barW - (barW > 2 ? 1 : 0)), h);
          }
          g.fillStyle = 'rgba(128,132,140,.9)';
          g.font = '9px Consolas, monospace';
          g.textBaseline = 'top';
          const vAvg = vN ? Math.round(vSum / vN) : 0;
          const aAvg = aN ? Math.round(aSum / aN) : 0;
          const kAvg = kN ? Math.round(kSum / kN) : 0;
          const parts = [`最大 ${maxSize} B`];
          if (vN) parts.push(`视频均 ${vAvg} B（${vN} 帧）`);
          if (kN) parts.push(`I 帧均 ${kAvg} B`);
          if (aN) parts.push(`音频均 ${aAvg} B（能量包络，${aN} 帧）`);
          g.fillText(parts.join(' · '), 4, plotH + 2);
        };

        const renderHex = () => {
          const r = analyzer.rows[selectedRow];
          hexBox.textContent = r ? `${r.kind}  offset=${r.offset}  size=${r.size}\n${r.hex || '(空)'}` : '选择一行查看前 64 字节';
        };
        const renderAll = () => { renderSessions(); render(); };

        source.addEventListener('change', () => {
          selected = source.value;
          analyzer.clear();
          selectedRow = -1;
          renderAll();
        });
        format.addEventListener('change', () => {
          analyzer.setFormat(format.value as Fmt);
          selectedRow = -1;
          render();
        });
        pauseBtn.addEventListener('click', () => {
          paused = !paused;
          pauseBtn.textContent = paused ? '继续' : '暂停';
          pauseBtn.classList.toggle('primary', paused);
        });
        $('.av-clear').addEventListener('click', () => {
          analyzer.clear();
          selectedRow = -1;
          render();
        });
        $('.av-export').addEventListener('click', () => {
          const data = {
            format: formatName(), totalBytes: analyzer.total, parsed: analyzer.rows.length,
            errors: analyzer.errors, info: analyzer.info,
            frames: analyzer.rows.map((r) => ({ n: r.n, offset: r.offset, size: r.size, kind: r.kind, key: r.key, detail: r.detail })),
          };
          void ctx.exportTextFiles('导出音视频分析', [{ name: 'av-inspect.json', text: JSON.stringify(data, null, 2) }], 'av-inspect')
            .catch(() => { try { ctx.notify('导出失败，请重试'); } catch {} });
        });
        body.addEventListener('click', (e) => {
          const tr = (e.target as HTMLElement).closest('tr[data-i]') as HTMLElement | null;
          if (!tr) return;
          selectedRow = Number(tr.dataset.i);
          render();
        });
        const offRaw = ctx.onRawData((e: any) => {
          if (!selected || paused || e.sessionId !== selected) return;
          analyzer.feed(e.bytes, e.t);
          schedule();
        });
        const offSessions = ctx.onSessionsChange ? ctx.onSessionsChange(() => renderSessions()) : () => {};
        renderAll();
        return () => {
          if (timer) clearTimeout(timer);
          closePlayer();
          offRaw();
          offSessions();
        };
      },
      unmount(el: HTMLElement) { el.innerHTML = ''; },
    },
  });
}

export default activate;
export { Analyzer, isMp4, isAvi, parseMp4, parseAvi };
export function deactivate() {}
