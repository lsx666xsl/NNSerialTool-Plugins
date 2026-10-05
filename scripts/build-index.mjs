// 市场索引生成 / 校验脚本（零依赖，Node 18+）。
//   node scripts/build-index.mjs --check            仅校验 plugins/*/plugin.json（PR 用，失败退出码 1）
//   node scripts/build-index.mjs                    校验 + 读取 packages/*.zip 计算哈希 → 重写 index.json
//   node scripts/build-index.mjs --commit <sha>     下载地址钉住到该提交（不可变 URL）
// 下载地址默认钉 commit：zip 走 @<sha> 不可变 URL，jsDelivr 缓存永远不会造成
// 索引哈希与下载字节不一致（SHA256 校验失败的历史根因就是 @main 可变缓存）；
// 仅显式传 --ref main 时退回分支 URL（本地预览用）。
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginsDir = join(root, 'plugins');
const packagesDir = join(root, 'packages');
const indexPath = join(root, 'index.json');
const argv = process.argv.slice(2);
const commitIdx = argv.indexOf('--commit');
const pinSha = commitIdx >= 0 ? argv[commitIdx + 1] : undefined;
const REF = pinSha && /^[0-9a-f]{7,40}$/.test(pinSha) ? pinSha : 'main';
const CDN = (id, ver) => `https://cdn.jsdelivr.net/gh/lsx666xsl/NNSerialTool-Plugins@${REF}/packages/${id}-${ver}.zip`;

const errors = [];
const entries = [];
let dirCount = 0;

for (const dir of readdirSync(pluginsDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  const id = dir.name;
  dirCount++;
  const manifestPath = join(pluginsDir, id, 'plugin.json');
  const fail = (why) => errors.push(`${id}: ${why}`);

  if (!existsSync(manifestPath)) {
    fail('缺少 plugin.json');
    continue;
  }
  let m;
  try {
    m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    fail(`plugin.json 不是合法 JSON（${e.message}）`);
    continue;
  }
  if (m.id !== id) fail(`plugin.json 的 id "${m.id}" 与目录名 "${id}" 不一致`);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(m.id ?? ''))) fail('id 不符合 ^[a-z0-9][a-z0-9-]{0,63}$');
  if (!m.name) fail('缺少 name');
  if (!/^\d+\.\d+\.\d+$/.test(String(m.version ?? ''))) fail('version 必须是 MAJOR.MINOR.PATCH');
  if (m.apiVersion !== 1) fail('apiVersion 必须为 1');
  if (m.type !== 'view' && m.type !== 'protocol') fail("type 必须为 'view' 或 'protocol'");
  const perms = m.permissions ?? [];
  if (!Array.isArray(perms) || perms.some((p) => !['send', 'storage'].includes(p))) fail("permissions 只允许 'send'/'storage'");
  const entry = m.entry || 'main.js';
  if (!existsSync(join(pluginsDir, id, entry))) fail(`入口文件 ${entry} 不存在`);

  if (errors.length === 0 || errors.every((e) => !e.startsWith(`${id}: `))) {
    // 本插件无错误才进入索引（有错的插件跳过，不阻断其他插件）
    const zip = join(packagesDir, `${id}-${m.version}.zip`);
    if (existsSync(zip)) {
      const buf = readFileSync(zip);
      entries.push({
        id,
        name: m.name,
        version: m.version,
        type: m.type,
        description: m.description ?? '',
        author: m.author ?? '',
        apiVersion: 1,
        minAppVersion: m.minAppVersion ?? undefined,
        size: statSync(zip).size,
        sha256: createHash('sha256').update(buf).digest('hex'),
        download: CDN(id, m.version),
      });
    }
  }
}

// 目录重名检查（同 id 只允许一个目录，天然保证；zip 残留旧版本检查）
if (existsSync(packagesDir)) {
  const zips = readdirSync(packagesDir).filter((f) => f.endsWith('.zip'));
  const known = new Set(entries.map((e) => `${e.id}-${e.version}.zip`));
  for (const z of zips) {
    if (!known.has(z)) errors.push(`packages/${z} 没有对应的 plugins/ 源（旧版本残留？请删除）`);
  }
}

if (errors.length > 0) {
  console.error('✗ 校验失败：');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}

if (process.argv.includes('--check')) {
  console.log(`✓ ${dirCount} 个插件目录校验通过（--check 模式，不写索引）`);
  process.exit(0);
}

const index = {
  apiVersion: 1,
  updatedAt: new Date().toISOString(),
  plugins: entries.sort((a, b) => a.id.localeCompare(b.id)),
};
writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
console.log(`✓ index.json 已生成：${entries.length} 个插件（${dirCount} 个目录，其余缺少 zip 产物）`);
