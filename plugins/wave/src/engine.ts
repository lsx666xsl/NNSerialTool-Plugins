// 波形数据引擎（自包含移植）：每通道定容环形缓冲 + 丢帧统计 + 会话过滤。
// 数据到达只写缓冲（version 自增），渲染循环对比 version 决定是否重绘。
import type { ParserInstance, ProtocolDef, RawDataEvent, WaveFrame } from './types';

export const RING_CAPACITY = 200_000; // 每通道点位上限（约 30 分钟 @100Hz），超出丢最旧

// 定容环形缓冲：逻辑序 0..count-1 即时间升序
export class Ring {
  data: Float32Array | Float64Array;
  head = 0;
  count = 0;

  constructor(readonly capacity: number, ctor: Float32ArrayConstructor | Float64ArrayConstructor) {
    this.data = new ctor(capacity);
  }

  push(v: number) {
    this.data[(this.head + this.count) % this.capacity] = v;
    if (this.count < this.capacity) this.count++;
    else this.head = (this.head + 1) % this.capacity;
  }

  at(i: number): number {
    return this.data[(this.head + i) % this.capacity];
  }

  clear() {
    this.head = 0;
    this.count = 0;
  }
}

export interface WaveStats {
  frames: number;
  bytes: number;
  drops: number;
  errors: number;
}

export class WaveEngine {
  readonly capacity = RING_CAPACITY;
  t = new Ring(RING_CAPACITY, Float64Array);
  channels: Ring[] = [];
  names: string[] = [];
  visible: boolean[] = [];
  attachedSessionId = '';
  stats: WaveStats = { frames: 0, bytes: 0, drops: 0, errors: 0 };
  version = 0;

  private parser: ParserInstance | null = null;
  private protocolId = '';
  private lastSeq = -1;

  // 选择协议并重置解析状态（切换协议时调用）
  setProtocol(def: ProtocolDef) {
    if (this.protocolId === def.id) return;
    this.protocolId = def.id;
    const parser = def.createParser();
    // 支持元数据回调的解析器（如 NN-Wave 的通道名下发）：原样存储，展示层兜底 CHn
    if ('onMeta' in parser) {
      (parser as { onMeta?: (names: string[]) => void }).onMeta = (names) => {
        if (names.length === 0) return;
        this.names = names.slice();
        this.version++;
      };
    }
    this.parser = parser;
  }

  // 绑定数据源会话；切换会话清空缓冲重新开始
  attach(sessionId: string) {
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
  private ensureChannels(n: number) {
    while (this.channels.length < n) {
      this.channels.push(new Ring(this.capacity, Float32Array));
      this.visible.push(true);
      if (!this.names[this.channels.length - 1]) this.names[this.channels.length - 1] = `CH${this.channels.length}`;
    }
  }

  handleRaw(e: RawDataEvent) {
    if (!this.attachedSessionId || e.sessionId !== this.attachedSessionId || !this.parser) return;
    this.stats.bytes += e.bytes.length;
    let frames: WaveFrame[];
    try {
      frames = this.parser.feed(e.bytes, e.t);
    } catch {
      this.stats.errors++;
      return;
    }
    for (const f of frames) this.ingest(f);
  }

  private ingest(f: WaveFrame) {
    this.ensureChannels(f.channels.length);
    for (let c = 0; c < f.channels.length; c++) this.channels[c].push(f.channels[c]);
    this.t.push(f.t);
    if (f.seq !== undefined) {
      if (this.lastSeq >= 0) this.stats.drops += (f.seq - this.lastSeq - 1) & 0xff;
      this.lastSeq = f.seq;
    }
    this.stats.frames++;
    this.version++;
  }

  get lastT(): number {
    return this.t.count > 0 ? this.t.at(this.t.count - 1) : 0;
  }

  // 在逻辑序上二分查找第一个 t >= time 的下标（缓冲按 push 序即时间升序）
  lowerBound(time: number): number {
    let lo = 0;
    let hi = this.t.count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.t.at(mid) < time) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // 离指定时间最近的样本下标（游标取值用）
  nearestIndex(time: number): number {
    const count = this.t.count;
    if (count === 0) return -1;
    const i = this.lowerBound(time);
    if (i === 0) return 0;
    if (i === count) return count - 1;
    return Math.abs(this.t.at(i) - time) < Math.abs(time - this.t.at(i - 1)) ? i : i - 1;
  }
}
