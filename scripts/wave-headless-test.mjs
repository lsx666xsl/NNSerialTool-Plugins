// 波形引擎+渲染器无头深度测试（零依赖，esbuild 打包真实源码后驱动）。
// 覆盖：显示 / 断包重组 / 坏帧容错 / 丢帧统计 / 时间窗缩放 / 左右滚动 /
//       自动量程 / 手动量程 / 冻结 / 复位 / 界面缩放（根 zoom）跟随。
//   node scripts/wave-headless-test.mjs（插件仓库版，源码在 plugins/wave/src）
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tmpDir = join(root, '.tmp-wave-headless');
let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}${detail ? '  (' + detail + ')' : ''}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`);
  }
};

// ---------- 1) esbuild 打包真实引擎 + 渲染器 + 解析器（protocol.ts） ----------
mkdirSync(tmpDir, { recursive: true });
const waveDir = join(root, 'plugins', 'wave', 'src').replace(/\\/g, '/');
writeFileSync(
  join(tmpDir, 'entry.ts'),
  `export * from '${waveDir}/engine';\nexport * from '${waveDir}/renderer';\nexport * from '${waveDir}/nnwave';\n`
);
const r = spawnSync(
  process.execPath,
  [
    join(root, 'node_modules', 'esbuild', 'bin', 'esbuild'),
    join(tmpDir, 'entry.ts'),
    '--bundle',
    '--format=esm',
    `--outfile=${join(tmpDir, 'core.mjs')}`,
    '--log-level=error',
  ],
  { stdio: 'pipe' }
);
if (r.status !== 0) {
  console.error(r.stderr.toString());
  process.exit(1);
}

// ---------- 2) 浏览器环境 mock ----------
const calls = { transforms: [], fillTexts: [], paths: [] };
let currentPath = null;
const ctx2d = {
  setTransform: (...a) => calls.transforms.push(a),
  fillRect: () => {},
  beginPath: () => {
    currentPath = [];
  },
  moveTo: (x, y) => currentPath && currentPath.push([x, y]),
  lineTo: (x, y) => currentPath && currentPath.push([x, y]),
  stroke: () => {
    calls.paths.push(currentPath ?? []);
    currentPath = null;
  },
  strokeRect: () => {},
  fillText: (t) => calls.fillTexts.push(String(t)),
  setLineDash: () => {},
  fillStyle: '',
  strokeStyle: '',
  lineWidth: 1,
  font: '',
  textAlign: '',
  textBaseline: '',
};
const makeCanvas = () => ({
  width: 0,
  height: 0,
  clientWidth: 900,
  clientHeight: 500,
  getContext: () => ctx2d,
});
globalThis.document = { documentElement: { style: { zoom: '1' } } };
globalThis.window = { devicePixelRatio: 1 };

const core = await import(pathToFileURL(join(tmpDir, 'core.mjs')).href);
const { WaveEngine, defaultViewState, drawWave, createNnWaveParser } = core;

// ---------- 3) 三角函数数据源（与 wave-tcp-source.mjs 同参数） ----------
// 50Hz、3 通道：sin(2π·t)、cos(2π·t)、0.5·sin(4π·t)；1000 帧 = 20 秒
const DT = 20;
const N = 1000;
const buildFrame = (seq, i) => {
  const t = (i * DT) / 1000;
  const chans = [Math.sin(2 * Math.PI * t), Math.cos(2 * Math.PI * t), 0.5 * Math.sin(4 * Math.PI * t)];
  const f = new Uint8Array(18);
  const dv = new DataView(f.buffer);
  f.set([0xaa, 0x55, 0x01, 3, seq & 0xff]);
  chans.forEach((v, c) => dv.setFloat32(5 + c * 4, v, true));
  let crc = 0;
  for (let k = 2; k < 17; k++) {
    crc ^= f[k];
    for (let b = 0; b < 8; b++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  f[17] = crc;
  return f;
};

let geom; // 最近一次 drawWave 几何（先声明——下方测试块首行即赋值）

const engine = new WaveEngine();
engine.setProtocol({ id: 'nnwave', name: 'NN-Wave', createParser: () => createNnWaveParser() });
engine.attach('s1');

console.log('\n[1] 波形显示');
for (let i = 0; i < N; i++)
  engine.handleRaw({ sessionId: 's1', sessionName: '测试', bytes: buildFrame(i, i), t: i * DT });
check('三通道全部入缓冲', engine.t.count === N && engine.channels.length === 3, `count=${engine.t.count}`);
check('无丢帧无解析错误', engine.stats.drops === 0 && engine.stats.errors === 0, JSON.stringify(engine.stats));

const view = defaultViewState();
const canvas = makeCanvas();
const testColors = () => ({
  bg: '#fff',
  panel: '#fff',
  border: '#ddd',
  text: '#000',
  textDim: '#888',
  grid: '#eee',
  accent: '#00f',
  palette: ['#f00', '#0f0', '#00f'],
});
const channelPaths = () => calls.paths.filter((p) => p.length > 20); // 长路径=通道折线，短路径=网格刻度
const pathExtentY = (p) => {
  let lo = Infinity;
  let hi = -Infinity;
  for (const [, y] of p) {
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  return hi - lo;
};
const pathMeanY = (p) => p.reduce((s, [, y]) => s + y, 0) / p.length;

geom = drawWave(canvas, engine, view, testColors());
{
  const chans = channelPaths();
  check('drawWave 产出三条通道折线', chans.length === 3, `paths=${chans.length}`);
  check('几何返回时间窗=默认 10s', Math.round(geom.t1 - geom.t0) === 10_000, `${Math.round(geom.t1 - geom.t0)}ms`);
}

console.log('\n[2] 断包重组 + 坏帧容错 + 丢帧统计');
{
  const e2 = new WaveEngine();
  e2.setProtocol({ id: 'nnwave', name: 'NN-Wave', createParser: () => createNnWaveParser() });
  e2.attach('s1');
  // 全部帧拼接后按 1~17 字节随机切块喂入（模拟串口粘包/断包）
  const all = new Uint8Array(N * 18);
  for (let i = 0; i < N; i++) all.set(buildFrame(i, i), i * 18);
  let off = 0;
  let t = 0;
  while (off < all.length) {
    const len = 1 + Math.floor(Math.random() * 17);
    e2.handleRaw({ sessionId: 's1', sessionName: '测试', bytes: all.slice(off, off + len), t });
    off += len;
    t += DT;
  }
  check('随机断包后仍完整重组', e2.t.count === N && e2.channels.length === 3, `count=${e2.t.count}`);
  check('断包零丢帧', e2.stats.drops === 0 && e2.stats.errors === 0, JSON.stringify(e2.stats));
  // seq 从 231（i=999 & 0xff）跳到 235 → 丢 3 帧（232/233/234）
  e2.handleRaw({ sessionId: 's1', sessionName: '测试', bytes: buildFrame((N + 3) & 0xff, N), t: N * DT });
  check('seq 跳变计入丢帧', e2.stats.drops === 3, `drops=${e2.stats.drops}`);
  // 坏 CRC 帧被丢弃；好帧 seq=1 自 235 回绕，缺口 21 帧一并计入统计
  const bad = buildFrame(0, 0);
  bad[bad.length - 1] ^= 0xff;
  const before = e2.t.count;
  e2.handleRaw({ sessionId: 's1', sessionName: '测试', bytes: bad, t: 0 });
  e2.handleRaw({ sessionId: 's1', sessionName: '测试', bytes: buildFrame(1, 0), t: 0 });
  check('坏 CRC 丢弃、好帧照收', e2.t.count === before + 1 && e2.stats.errors === 0);
  check('回绕缺口计入丢帧统计', e2.stats.drops === 3 + 21, `drops=${e2.stats.drops}`);
}

console.log('\n[3] 时间窗缩放');
{
  view.windowMs = 2000;
  calls.paths.length = 0;
  geom = drawWave(canvas, engine, view, testColors());
  const dense = channelPaths()[0].length;
  check('缩到 2s 窗口几何正确', Math.round(geom.t1 - geom.t0) === 2000);
  view.windowMs = 20000;
  calls.paths.length = 0;
  geom = drawWave(canvas, engine, view, testColors());
  const sparse = channelPaths()[0].length;
  check('放到 20s 窗口几何正确', Math.round(geom.t1 - geom.t0) === 20000);
  check('窗口越大折线越密', sparse > dense * 3, `dense=${dense} sparse=${sparse}`);
}

console.log('\n[4] 左右滚动（平移窗口看不同段）');
{
  view.windowMs = 750;
  view.follow = false;
  view.rightT = 750; // 窗口 [0, 750ms]：1Hz 正弦相位 [0, 0.75 周期]，均值 +0.21
  calls.paths.length = 0;
  geom = drawWave(canvas, engine, view, testColors());
  check('平移后 t0 对齐数据起点', Math.abs(geom.t0) < 1, `t0=${geom.t0.toFixed(1)}`);
  const headMean = pathMeanY(channelPaths()[0]);
  view.rightT = 8250; // 窗口 [7.5s, 8.25s]：相位 [1.5π, 2.25π]，均值 −0.15
  calls.paths.length = 0;
  geom = drawWave(canvas, engine, view, testColors());
  check('滚动改变绘制窗口', Math.abs(geom.t0 - 7500) < 1, `t0=${geom.t0.toFixed(1)}`);
  const tailMean = pathMeanY(channelPaths()[0]);
  const diff = Math.abs(headMean - tailMean);
  check('滚动后曲线随窗口内容变化', diff > 15, `Δ=${diff.toFixed(1)}px head=${headMean.toFixed(1)} tail=${tailMean.toFixed(1)}`);
}

console.log('\n[5] 自动量程 + 手动量程');
{
  view.windowMs = 20000;
  view.follow = true;
  view.yRanges.clear();
  calls.paths.length = 0;
  geom = drawWave(canvas, engine, view, testColors());
  const paneH = (500 - 8 - 22) / 3;
  const auto = pathExtentY(channelPaths()[0]);
  check('自动量程：数据跨度+10% 比例内边距 ≈ 0.833 栏高', auto > paneH * 0.8 && auto < paneH * 0.86, `extent=${auto.toFixed(0)} paneH=${paneH.toFixed(0)}`);
  view.yRanges.set(0, { min: -10, max: 10 });
  calls.paths.length = 0;
  geom = drawWave(canvas, engine, view, testColors());
  const manual = pathExtentY(channelPaths()[0]);
  check('手动量程 ±10：曲线压缩到约 1/10 栏高', manual < paneH * 0.13, `extent=${manual.toFixed(0)}`);
  view.yRanges.delete(0);
  calls.paths.length = 0;
  geom = drawWave(canvas, engine, view, testColors());
  check('清除手动量程恢复自动', Math.abs(pathExtentY(channelPaths()[0]) - auto) < 2);
}

console.log('\n[5b] 叠加模式共用并集量程');
{
  // 叠加：ch0 = sin ±1（全幅），ch2 = 0.5·sin2t（半幅）——共用并集量程后
  // ch2 的绘制高度应约为 ch0 的一半（旧的逐通道归一化会给出 0.917 倍，此断言可判别）
  view.overlay = true;
  view.windowMs = 20000;
  view.follow = true;
  view.yRanges.clear();
  calls.paths.length = 0;
  geom = drawWave(canvas, engine, view, testColors());
  const paneH = 500 - 8 - 22; // 叠加单栏占满绘图区
  const paths = channelPaths();
  const e0 = pathExtentY(paths[0]);
  const e2 = pathExtentY(paths[2]);
  check('叠加共用量程：半幅通道约为全幅一半', e2 > e0 * 0.35 && e2 < e0 * 0.6, `e0=${e0.toFixed(0)} e2=${e2.toFixed(0)} 比=${(e2 / e0).toFixed(2)}`);
  view.overlay = false;
}

console.log('\n[6] 冻结 + 复位');
{
  view.windowMs = 2000;
  view.frozen = true;
  view.rightT = engine.lastT - 5000; // 冻在 5 秒前
  calls.paths.length = 0;
  geom = drawWave(canvas, engine, view, testColors());
  const frozenT1 = geom.t1;
  for (let i = 0; i < 100; i++)
    engine.handleRaw({ sessionId: 's1', sessionName: '测试', bytes: buildFrame(N + i, N + i), t: (N + i) * DT });
  calls.paths.length = 0;
  geom = drawWave(canvas, engine, view, testColors());
  check('冻结期间新数据不推移画面', geom.t1 === frozenT1, `t1=${geom.t1}`);
  check('冻结期间缓冲仍在增长', engine.t.count === N + 100, `count=${engine.t.count}`);
  // 复位（双击等价）：回默认跟随
  Object.assign(view, defaultViewState());
  calls.paths.length = 0;
  geom = drawWave(canvas, engine, view, testColors());
  check('复位后跟随最新且窗口 10s', view.follow && view.windowMs === 10_000 && Math.round(geom.t1 - geom.t0) === 10_000);
}

console.log('\n[7] 界面缩放（根 zoom）跟随');
{
  document.documentElement.style.zoom = '1';
  calls.transforms.length = 0;
  drawWave(canvas, engine, view, testColors());
  const w1 = canvas.width;
  const t1 = calls.transforms[calls.transforms.length - 1];
  check('zoom=1：背板=CSS 尺寸', w1 === 900 && t1[0] === 1, `width=${w1} scale=${t1[0]}`);
  document.documentElement.style.zoom = '1.5';
  calls.transforms.length = 0;
  drawWave(canvas, engine, view, testColors());
  const w2 = canvas.width;
  const t2 = calls.transforms[calls.transforms.length - 1];
  check('zoom=1.5：背板随界面缩放 1.5 倍', w2 === 1350 && Math.abs(t2[0] - 1.5) < 1e-9, `width=${w2} scale=${t2[0]}`);
  document.documentElement.style.zoom = '1';
}

rmSync(tmpDir, { recursive: true, force: true });
console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
