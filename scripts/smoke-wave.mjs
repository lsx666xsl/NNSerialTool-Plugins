// 波形插件构建链自检：安装依赖 → esbuild 打包 → 打 zip → 重建索引 → activate 冒烟。
// 由主会话调用；CI 中的等价步骤见 .github/workflows/ci.yml。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fail = (msg) => {
  console.error('✗ ' + msg);
  process.exit(1);
};
const run = (cmd, args, cwd = root) => {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} 失败`);
};

// 1) 依赖
if (!existsSync(join(root, 'node_modules', 'esbuild'))) {
  run('npm', ['install', '--no-fund', '--no-audit']);
}
if (!existsSync(join(root, 'node_modules', 'fflate'))) {
  run('npm', ['install', 'fflate', '--save-dev', '--no-fund', '--no-audit']);
}

// 2) esbuild 打包（含 src/main.ts 的插件）
run('node', ['scripts/build-plugins.mjs']);

// 3) 打 zip（fflate，正斜杠条目，与宿主安装器一致）
const requireFrom = createRequire(join(root, 'package.json'));
const { zipSync } = requireFrom('fflate');
const pluginsDir = join(root, 'plugins');
mkdirSync(join(root, 'packages'), { recursive: true });
for (const id of ['wave', 'hello-view']) {
  const dir = join(pluginsDir, id);
  const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'));
  const files = {};
  for (const name of ['plugin.json', manifest.entry]) {
    if (!existsSync(join(dir, name))) fail(`${id} 缺少 ${name}`);
    files[name] = new Uint8Array(readFileSync(join(dir, name)));
  }
  const out = join(root, 'packages', `${id}-${manifest.version}.zip`);
  writeFileSync(out, zipSync(files));
  console.log(`✓ ${out}`);
}

// 4) 重建市场索引
run('node', ['scripts/build-index.mjs']);

// 5) 冒烟：wave/main.js activate 应注册 1 视图 + 1 协议
const mainSrc = readFileSync(join(pluginsDir, 'wave', 'main.js'), 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(mainSrc).toString('base64'));
const views = [];
const protocols = [];
await mod.default({
  registerView: (d) => views.push(d),
  registerProtocol: (d) => protocols.push(d),
});
if (views.length !== 1 || views[0].id !== 'wave' || typeof views[0].component.mount !== 'function') {
  fail('wave 视图注册异常');
}
if (protocols.length !== 1 || protocols[0].id !== 'nnwave' || typeof protocols[0].createParser !== 'function') {
  fail('NN-Wave 协议注册异常');
}

// 6) 解析器冒烟：一帧 3 通道 [1.5, 2.25, -3.5]
const parser = protocols[0].createParser();
const f = new Uint8Array(6 + 12);
const dv = new DataView(f.buffer);
f.set([0xaa, 0x55, 0x01, 3, 0]);
[1.5, 2.25, -3.5].forEach((v, c) => dv.setFloat32(5 + c * 4, v, true));
let crc = 0;
for (let i = 2; i < 17; i++) {
  crc ^= f[i];
  for (let b = 0; b < 8; b++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
}
f[17] = crc;
const frames = parser.feed(f, 1000);
if (frames.length !== 1 || frames[0].channels.join() !== '1.5,2.25,-3.5' || frames[0].seq !== 0) {
  fail('NN-Wave 解析冒烟失败');
}

console.log('✓ wave 插件构建链自检全部通过');
