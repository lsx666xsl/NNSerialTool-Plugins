// 插件打包：把 plugins/<id> 打成 packages/<id>-<version>.zip，并可选重建 index.json。
//   node scripts/pack-plugins.mjs            # 打包所有插件
//   node scripts/pack-plugins.mjs --clean    # 先删 packages/ 里的旧版本 zip 再打包
//   node scripts/pack-plugins.mjs --index    # 打包后调用 build-index.mjs 重建索引（需 --commit <sha>）
// 说明：仓库原先没有入库的打包脚本（build 只产 main.js），首次发布需要它。
import { zipSync } from 'fflate';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginsDir = join(root, 'plugins');
const packagesDir = join(root, 'packages');
const args = process.argv.slice(2);
const CLEAN = args.includes('--clean');
const WITH_INDEX = args.includes('--index');

mkdirSync(packagesDir, { recursive: true });
if (CLEAN) {
  for (const f of readdirSync(packagesDir)) {
    if (f.endsWith('.zip')) rmSync(join(packagesDir, f), { force: true });
  }
  console.log('已清理旧 zip');
}

const ids = readdirSync(pluginsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(pluginsDir, d.name, 'plugin.json')))
  .map((d) => d.name);

const packed = [];
for (const id of ids) {
  const dir = join(pluginsDir, id);
  const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'));
  const entry = manifest.entry ?? 'main.js';
  const files = {};
  for (const name of ['plugin.json', entry]) {
    const p = join(dir, name);
    if (!existsSync(p)) {
      console.warn(`  ! ${id}: 缺少 ${name}，跳过`);
      continue;
    }
    files[name] = new Uint8Array(readFileSync(p));
  }
  if (!files[entry]) {
    console.warn(`  ! ${id}: 没有入口文件 ${entry}，跳过`);
    continue;
  }
  const zip = zipSync(files, { level: 9 });
  const outName = `${id}-${manifest.version}.zip`;
  writeFileSync(join(packagesDir, outName), zip);
  const sha = createHash('sha256').update(zip).digest('hex');
  packed.push({ id, version: manifest.version, file: outName, size: zip.length, sha256: sha });
  console.log(`  ✓ ${id} ${manifest.version} → packages/${outName}  ${zip.length} B  sha256=${sha.slice(0, 12)}…`);
}

writeFileSync(join(root, '.tmp-pack-result.json'), JSON.stringify(packed, null, 2));
console.log(`\n打包完成：${packed.length} 个插件`);

if (WITH_INDEX) {
  console.log('\n下一步请执行（index.json 的 download 需要指向含 zip 的提交）：');
  console.log('  npm run check -- --commit <含 zip 的提交 SHA>   # 或 node scripts/build-index.mjs --commit <sha>');
}
