// SVG 导出器自测：esbuild 打包真实源码 → 喂 300 帧三角函数 → 断言 SVG 输出。
// 用法：node scripts/svg-selftest.mjs（在插件仓库根）
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tmp = join(root, '.tmp-svg-selftest');
mkdirSync(tmp, { recursive: true });

const waveSrcDir = join(root, 'plugins', 'wave', 'src').replace(/\\/g, '/');
writeFileSync(
  join(tmp, 'entry.ts'),
  `export * from '${waveSrcDir}/engine';\nexport * from '${waveSrcDir}/nnwave';\nexport * from '${waveSrcDir}/svg-export';\n`
);

const r = spawnSync(
  process.execPath,
  [join(root, 'node_modules', 'esbuild', 'bin', 'esbuild'), join(tmp, 'entry.ts'), '--bundle', '--format=esm', `--outfile=${join(tmp, 'core.mjs')}`, '--log-level=error'],
  { stdio: 'pipe' }
);
if (r.status !== 0) {
  console.error(r.stderr.toString());
  process.exit(1);
}

const core = await import(pathToFileURL(join(tmp, 'core.mjs')).href);
const engine = new core.WaveEngine();
engine.setProtocol({ id: 'nnwave', createParser: () => core.createNnWaveParser() });
engine.attach('s1');
const frame = (i) => {
  const f = new Uint8Array(18);
  const dv = new DataView(f.buffer);
  f.set([0xaa, 0x55, 1, 3, i & 255]);
  const t = i / 50;
  [Math.sin(2 * Math.PI * t), Math.cos(2 * Math.PI * t), 0.5 * Math.sin(4 * Math.PI * t)].forEach((v, c) =>
    dv.setFloat32(5 + c * 4, v, true)
  );
  let crc = 0;
  for (let k = 2; k < 17; k++) {
    crc ^= f[k];
    for (let b = 0; b < 8; b++) crc = crc & 128 ? ((crc << 1) ^ 0x07) & 255 : (crc << 1) & 255;
  }
  f[17] = crc;
  return f;
};
for (let i = 0; i < 300; i++) engine.handleRaw({ sessionId: 's1', sessionName: 't', bytes: frame(i), t: i * 20 });

const colors = { bg: '#fff', panel: '#fff', border: '#ddd', text: '#000', textDim: '#888', grid: '#eee', accent: '#00f', palette: ['#f00', '#0f0', '#00f'] };
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? ' (' + detail + ')' : ''}`); }
  else { fail++; console.error(`  FAIL  ${name}${detail ? ' (' + detail + ')' : ''}`); }
};

const svg1 = core.buildWaveSvg(engine, { overlay: false, yRanges: new Map() }, colors);
check('分栏 SVG 生成', !!svg1 && svg1.startsWith('<svg'));
check('分栏含三条通道折线', svg1 !== null && (svg1.match(/<path /g) || []).length >= 3, `paths=${svg1 ? (svg1.match(/<path /g) || []).length : 0}`);
check('含 Y 轴刻度标签', svg1 !== null && svg1.includes('font-size="10"'));
const svg2 = core.buildWaveSvg(engine, { overlay: true, yRanges: new Map() }, colors);
check('叠加 SVG 生成', !!svg2 && svg2.startsWith('<svg'));
check('空引擎返回 null', core.buildWaveSvg(new core.WaveEngine(), { overlay: false, yRanges: new Map() }, colors) === null);

rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
