// 波形分析模块自检（本地保留，不入库）：把 analysis.ts 打包成临时 ESM 后跑断言。
//   node scripts/test-analysis.mjs
import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, '.tmp-test');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'analysis.mjs');

await build({
  entryPoints: [join(root, 'plugins', 'wave', 'src', 'analysis.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2020',
  logLevel: 'error',
});

const A = await import(pathToFileURL(outFile).href);

let pass = 0;
let fail = 0;
const check = (name, ok, evidence) => {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${name}${evidence === undefined ? '' : '  (' + JSON.stringify(evidence) + ')'}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}  (${JSON.stringify(evidence)})`);
  }
};

// 简易引擎桩：环形缓冲可用普通数组模拟（at(i) 取值）
const makeEngine = (tArr, chArr) => ({
  t: { count: tArr.length, at: (i) => tArr[i] },
  channels: chArr.map((arr) => ({ at: (i) => arr[i] })),
  lowerBound: () => 0,
  nearestIndex: () => 0,
  names: [],
  visible: [],
  check: () => {},
});

// ---------- channelStats ----------
{
  const N = 1000;
  const t = Array.from({ length: N }, (_, i) => i * 10); // 10ms → 100Hz
  const fs = 100;
  const ch0 = Array.from({ length: N }, (_, i) => Math.sin((2 * Math.PI * 5 * i) / fs)); // 5Hz 正弦
  const eng = makeEngine(t, [ch0]);
  const s = A.channelStats(eng, 0, 0, N);
  check('正弦 Vpp ≈ 2', Math.abs(s.vpp - 2) < 0.05, { vpp: +s.vpp.toFixed(3) });
  check('正弦 RMS ≈ 0.707', Math.abs(s.rms - 0.707) < 0.02, { rms: +s.rms.toFixed(3) });
  check('正弦均值 ≈ 0', Math.abs(s.mean) < 0.02, { mean: +s.mean.toFixed(3) });
  check('过零法估计 5Hz（±8%）', s.freq !== null && Math.abs(s.freq - 5) / 5 < 0.08, { freq: s.freq && +s.freq.toFixed(2) });
  check('统计样本数 = 区间长度', s.count === N, { count: s.count });
}
{
  // 常量信号：Vpp=0、freq=null 不抛
  const eng = makeEngine([0, 10, 20, 30], [Array(4).fill(2.5)]);
  const s = A.channelStats(eng, 0, 0, 4);
  check('常量信号 Vpp=0 且无频率', s.vpp === 0 && s.freq === null, { vpp: s.vpp, freq: s.freq });
}
{
  const eng = makeEngine([], []);
  const s = A.channelStats(eng, 0, 0, 0);
  check('空区间返回 NaN 统计且不抛错', Number.isNaN(s.vpp) && s.count === 0, { count: s.count });
}

// ---------- buildCsv ----------
{
  const t = [0, 100, 200];
  const eng = makeEngine(t, [
    [1, 2, 3],
    [4, 5, 6],
  ]);
  const csv = A.buildCsv(eng, ['CH1', 'CH2'], [0, 1], 0, 3);
  const lines = csv.split('\n');
  check('CSV 表头含 time_s 与通道名', lines[0] === 'time_s,"CH1","CH2"', lines[0]);
  check('CSV 行数 = 数据行 + 表头', lines.length === 4, { lines: lines.length });
  check('CSV 时间列为相对秒（6 位小数）', lines[1].startsWith('0.000000,1,4'), lines[1]);
  check('CSV 第二行时间 0.1s', lines[2].startsWith('0.100000,2,5'), lines[2]);
  check(
    'CSV 最多导出 maxRows 行',
    A.buildCsv(eng, ['CH1'], [0], 0, 3, 2).split('\n').length === 3,
  );
  check('CSV 空区间返回空串', A.buildCsv(eng, ['CH1'], [0], 1, 1) === '', '');
  check(
    'CSV 通道名含逗号/引号时转义',
    A.buildCsv(eng, ['A,B', 'C"D'], [0, 1], 0, 1).split('\n')[0] === 'time_s,"A,B","C""D"',
    A.buildCsv(eng, ['A,B', 'C"D'], [0, 1], 0, 1).split('\n')[0],
  );
}

// ---------- fftSpectrum ----------
{
  const N = 256;
  const fs = 100; // 10ms 间隔
  const t = Array.from({ length: N }, (_, i) => i * 10);
  const f0 = 10;
  const ch0 = Array.from({ length: N }, (_, i) => Math.sin((2 * Math.PI * f0 * i) / fs));
  const eng = makeEngine(t, [ch0]);
  const spec = A.fftSpectrum(eng, 0, 0, N);
  check('FFT 返回非空', !!spec, { nfft: spec?.nfft });
  if (spec) {
    check('FFT 采样率 ≈ 100Hz', Math.abs(spec.sampleHz - 100) < 1, { sampleHz: +spec.sampleHz.toFixed(2) });
    let peak = 1;
    for (let k = 2; k < spec.mags.length; k++) if (spec.mags[k] > spec.mags[peak]) peak = k;
    const peakHz = spec.freqs[peak];
    check('FFT 峰值频率 ≈ 10Hz（±1 个 bin）', Math.abs(peakHz - f0) <= spec.sampleHz / spec.nfft * 1.5, {
      peakHz: +peakHz.toFixed(2),
      binHz: +(spec.sampleHz / spec.nfft).toFixed(2),
    });
    check('FFT 幅值量级合理（0.8~1.2）', Math.abs(spec.mags[peak] - 1) < 0.25, { mag: +spec.mags[peak].toFixed(3) });
  }
  const empty = A.fftSpectrum(makeEngine([0, 1], [[1, 1]]), 0, 0, 2);
  check('样本过少时 FFT 返回 null', empty === null, empty);
}
{
  // 非 2 的幂样本数 → 需要重采样：频率轴必须用“有效采样率”换算，
  // 否则会被放大 (n-1)/(nfft-1) 倍（真实缺陷：曾显示 1.8~1.9 倍）
  const N = 300;
  const fs = 100;
  const t = Array.from({ length: N }, (_, i) => i * 10);
  const f0 = 10;
  const ch0 = Array.from({ length: N }, (_, i) => Math.sin((2 * Math.PI * f0 * i) / fs));
  const spec = A.fftSpectrum(makeEngine(t, [ch0]), 0, 0, N);
  check('重采样后 FFT 返回非空', !!spec, { nfft: spec?.nfft });
  if (spec) {
  let peak = 1;
  for (let k = 2; k < spec.mags.length; k++) if (spec.mags[k] > spec.mags[peak]) peak = k;
  const peakHz = spec.freqs[peak];
  check(
    '重采样后峰值频率仍 ≈ 10Hz（频率轴未放大）',
    Math.abs(peakHz - f0) <= spec.fsEff / spec.nfft * 1.5,
    { peakHz: +peakHz.toFixed(2), binHz: +(spec.fsEff / spec.nfft).toFixed(2), fsEff: +spec.fsEff.toFixed(2) },
  );
  check(
    '有效采样率按重采样比例换算（fsEff = (nfft-1)/(n-1)·fs）',
    Math.abs(spec.fsEff - ((spec.nfft - 1) / (N - 1)) * fs) < 0.5,
    { fsEff: +spec.fsEff.toFixed(2), expect: +(((spec.nfft - 1) / (N - 1)) * fs).toFixed(2) },
  );
  check(
    '频率分辨率 ≈ 1 / 窗口时长',
    Math.abs(spec.fsEff / spec.nfft - 1 / ((N - 1) * 0.01)) < 0.02,
    { binHz: +(spec.fsEff / spec.nfft).toFixed(3), expect: +(1 / ((N - 1) * 0.01)).toFixed(3) },
  );
  }
}

// ---------- movingAverage ----------
{
  const input = new Float32Array([0, 10, 0, 10, 0, 10]);
  const out = A.movingAverage(input, 2);
  check('滑动平均长度不变', out.length === input.length, { len: out.length });
  check('滑动平均首点 = 原值', out[0] === 0, { first: out[0] });
  check('滑动平均收敛到均值 5', Math.abs(out[5] - 5) < 1e-6, { last: out[5] });
  const same = A.movingAverage(input, 1);
  check('N=1 时输出等于输入', Array.from(same).join(',') === Array.from(input).join(','), Array.from(same));
}

// ---------- 时间戳不均匀（合批）时的 FFT：必须按时间重采样 ----------
{
  // 模拟真实情况：帧被合批，多个采样共用同一时间戳（每 3 个采样同时间戳，间隔 30ms/组）
  const groups = 100;
  const per = 3;
  const t = [];
  const ch0 = [];
  const fsNominal = 100; // 采样间隔 10ms
  for (let g = 0; g < groups; g++) {
    const tBase = g * 30; // 每组合批 3 个采样，组间隔 30ms
    for (let k = 0; k < per; k++) {
      const idx = g * per + k;
      t.push(tBase); // 同一批共享同一时间戳
      ch0.push(Math.sin((2 * Math.PI * 5 * (idx * 10)) / 1000)); // 真实 5Hz（按采样序号相位）
    }
  }
  const spec = A.fftSpectrum(makeEngine(t, [ch0]), 0, 0, t.length);
  if (!spec) {
    check('合批时间戳 FFT 返回非空', false, null);
  } else {
    let peak = 1;
    for (let k = 2; k < spec.mags.length; k++) if (spec.mags[k] > spec.mags[peak]) peak = k;
    // 时间戳退化后 5Hz 的正弦在“真实时间”里会被压缩/拉伸，这里只断言不出现旧的系统性放大，
    // 且频率轴分辨率与窗口时长相符（不因重采样而虚高）
    check('合批时间戳：频率轴分辨率 = 1/窗口时长', Math.abs(spec.fsEff / spec.nfft - 1 / ((t[t.length - 1] - t[0]) / 1000)) < 0.05, {
      binHz: +(spec.fsEff / spec.nfft).toFixed(3),
      expect: +(1 / ((t[t.length - 1] - t[0]) / 1000)).toFixed(3),
    });
    check('合批时间戳：峰值频率有限且非 0', Number.isFinite(spec.freqs[peak]) && spec.freqs[peak] > 0, {
      peakHz: +spec.freqs[peak].toFixed(2),
    });
  }
  void fsNominal;
}

rmSync(outDir, { recursive: true, force: true });
{
  const eng = makeEngine([0, 1, 2, 3], [[10, 20, 30, 40]]);
  const s = A.sliceChannel(eng, 0, 1, 3);
  check('sliceChannel 取出子区间', Array.from(s).join(',') === '20,30', Array.from(s));
  const bad = A.sliceChannel(eng, 9, 0, 3);
  check('sliceChannel 通道不存在时返回空数组', bad.length === 3 && Array.from(bad).every((v) => v === 0), Array.from(bad));
}

rmSync(outDir, { recursive: true, force: true });
console.log(`\n分析模块自检：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
