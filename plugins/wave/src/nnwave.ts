// NN-Wave v1 帧解析器（自包含移植，与固件模板 nnwave.c 严格一致）。
// 帧格式: [AA 55][type][N][seq][float32×N 小端][CRC8]
//   type 0x01 数据帧；0x02 元数据帧（payload 为若干 [len][utf8 通道名]，0x00 补齐 4N 字节）
//   CRC8 多项式 0x07，初值 0x00，覆盖 type..data
import type { ParserInstance, WaveFrame } from './types';

const STX0 = 0xaa;
const STX1 = 0x55;
const MAX_CHANNELS = 64;
const MAX_BUFFER = 1 << 20;

export const crc8 = (data: Uint8Array, start: number, end: number): number => {
  let crc = 0;
  for (let i = start; i < end; i++) {
    crc ^= data[i];
    for (let b = 0; b < 8; b++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
};

export interface NnWaveParser extends ParserInstance {
  onMeta?: (names: string[]) => void;
}

export const createNnWaveParser = (): NnWaveParser => {
  let buf = new Uint8Array(0);
  const parser: NnWaveParser = {
    onMeta: undefined,
    feed(bytes, t) {
      const merged = new Uint8Array(buf.length + bytes.length);
      merged.set(buf);
      merged.set(bytes, buf.length);
      buf = merged;

      const frames: WaveFrame[] = [];
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
        if (type === 0x01) {
          const channels: number[] = new Array(n);
          for (let c = 0; c < n; c++) channels[c] = dv.getFloat32(i + 5 + c * 4, true);
          frames.push({ t, channels, seq: buf[i + 4] });
        } else if (type === 0x02) {
          const names: string[] = [];
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
    },
  };
  return parser;
};
