// 插件构建脚本：把带 src/main.ts 的插件目录用 esbuild 打包成单文件 main.js。
//   node scripts/build-plugins.mjs
// 产物提交回仓库（main.js），CI 与本地自检共用；hello-view 等无 src/ 的纯 JS 插件自动跳过。
import { build } from 'esbuild';
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginsDir = join(root, 'plugins');

const dirs = readdirSync(pluginsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(pluginsDir, d.name, 'src', 'main.ts')))
  .map((d) => d.name);

if (dirs.length === 0) {
  console.log('没有需要构建的插件（无 src/main.ts）');
  process.exit(0);
}

for (const id of dirs) {
  await build({
    entryPoints: [join(pluginsDir, id, 'src', 'main.ts')],
    outfile: join(pluginsDir, id, 'main.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    charset: 'utf8',
    logLevel: 'info',
  });
  console.log(`✓ ${id} → main.js`);
}
