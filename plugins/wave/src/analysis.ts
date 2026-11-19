// 波形分析工具（纯函数）：窗口统计、CSV 导出、FFT 频谱、平滑平均、通道差分。
// 与渲染解耦，便于单测与复用：输入引擎 + 索引区间，输出普通数组/字符串。
import type { WaveEngine } from './engine';

export interface ChannelStats {
  min: number;
  max: number;
  vpp: number; // 峰峰值 max-min
  mean: number;
  rms: number;
  freq: number | null; // 过零法估计基频（Hz），无周期或样本过少时为 null
  count: number; // 参与统计的样本数
}

const EMPTY_STATS: ChannelStats = { min: NaN, max: NaN, vpp: NaN, mean: NaN, rms: NaN, freq: null, count: 0 };

/*
*   描述：统计某通道在 [i0, i1) 索引区间内的 min/max/Vpp/均值/RMS 与过零基频。
*         频率用“去均值后单位时间内的过零次数 ÷ 2”——对正弦/方波等周期信号足够，
*         不做 FFT 峰值搜索（FFT 另由 fftSpectrum 提供）。
*/
export const channelStats = (engine: WaveEngine, ch: number, i0: number, i1: number): ChannelStats => {
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

  // 过零计数（去均值，带符号变化即算一次穿越）
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
  const freq = span > 0 && crossings >= 2 ? (crossings / 2) / (span / 1000) : null;
  return { min, max, vpp: max - min, mean, rms, freq, count: n };
};

/*
*   描述：把 [i0, i1) 区间导成 CSV 文本（time_s + 每个可见通道一列）。
*         时间列用相对窗口起点秒数（保留 6 位小数），便于直接丢进 Excel / Python。
*/
export const buildCsv = (
  engine: WaveEngine,
  names: string[],
  cols: number[],
  i0: number,
  i1: number,
  maxRows = 200_000
): string => {
  const n = Math.min(i1 - i0, maxRows);
  if (n <= 0 || cols.length === 0) return '';
  const t0 = engine.t.at(i0);
  const head = ['time_s', ...cols.map((c) => `"${(names[c] ?? `CH${c + 1}`).replace(/"/g, '""')}"`)].join(',');
  const lines: string[] = [head];
  for (let i = 0; i < n; i++) {
    const idx = i0 + i;
    const ts = ((engine.t.at(idx) - t0) / 1000).toFixed(6);
    const row: string[] = [ts];
    for (const c of cols) {
      const v = engine.channels[c].at(idx);
      row.push(Number.isFinite(v) ? String(+v.toFixed(6)) : '');
    }
    lines.push(row.join(','));
  }
  return lines.join('\n');
};

/*
*   描述：按平均采样间隔把区间重采样到 2 的幂长度后做 FFT（Hann 窗），返回幅值谱。
*         数据本身时间戳不均匀，这里按“平均间隔”线性处理，频谱横轴为近似频率。
*/
export interface Spectrum {
  freqs: Float32Array;
  mags: Float32Array;
  sampleHz: number; // 原始数据的估计采样率（foot 文案用）
  fsEff: number; // 重采样后的有效采样率（频率轴换算用）
  nfft: number;
}

export const fftSpectrum = (engine: WaveEngine, ch: number, i0: number, i1: number): Spectrum | null => {
  const ring = engine.channels[ch];
  const n = i1 - i0;
  if (!ring || n < 16) return null;
  const span = engine.t.at(i1 - 1) - engine.t.at(i0);
  if (!(span > 0)) return null;
  const meanDt = span / (n - 1); // ms
  const sampleHz = 1000 / meanDt;
  // 取 2 的幂（最多 8192 点，够看主频；不追求高分辨率以免拖慢主线程）
  let nfft = 1;
  while (nfft * 2 <= Math.min(n, 8192)) nfft *= 2;
  if (nfft < 16) return null;
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  const tStart = engine.t.at(i0);
  const tEnd = engine.t.at(i1 - 1);
  const dtGrid = (tEnd - tStart) / (nfft - 1);
  // 按**时间戳**线性重采样，而不是按索引等距取样：数据帧合批时多个采样共用同一时间戳，
  // 按索引重采会把时间轴拉长/压缩，频率被系统性带偏（实测 0.8Hz 被算成 1.15Hz）。
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
  // Hann 窗的相干增益是 0.5：不补偿的话满幅正弦的谱峰只有 0.5，读数和示波器对不上
  let winSum = 0;
  for (let k = 0; k < nfft; k++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (nfft - 1)); // Hann
    winSum += w;
    re[k] = (grid[k] - mean) * w;
  }
  const winGain = winSum / nfft;
  // 迭代基 2 FFT（原地）
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
    const ang = (-2 * Math.PI) / len;
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
  // 重采样后点间隔是 step*meanDt，**有效采样率**不再是 1/meanDt：
  //   fsEff = (nfft-1)/span，否则频率轴会被放大 (n-1)/(nfft-1) 倍（实测曾偏 1.8~1.9×）。
  const fsEff = (nfft - 1) / (span / 1000);
  const freqs = new Float32Array(half);
  const mags = new Float32Array(half);
  for (let k = 0; k < half; k++) {
    freqs[k] = (k * fsEff) / nfft;
    // 单边幅度谱并按窗增益归一：满幅正弦的谱峰 ≈ 其幅值（1.0）
    mags[k] = (2 * Math.hypot(re[k], im[k])) / (nfft * winGain);
  }
  return { freqs, mags, sampleHz, fsEff, nfft };
};

/*
*   描述：滑动平均（长度 n 的矩形窗），用于“平滑平均”这类数学通道。
*/
export const movingAverage = (values: Float32Array, n: number): Float32Array => {
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

/*
*   描述：取某通道在区间内的样本数组（数学通道的输入）。
*/
export const sliceChannel = (engine: WaveEngine, ch: number, i0: number, i1: number): Float32Array => {
  const n = Math.max(0, i1 - i0);
  const out = new Float32Array(n);
  const ring = engine.channels[ch];
  if (!ring) return out;
  for (let i = 0; i < n; i++) out[i] = ring.at(i0 + i);
  return out;
};
