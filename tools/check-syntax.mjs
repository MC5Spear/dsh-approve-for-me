/**
 * dsh-approve-for-me — 语法自检。
 *
 * 为什么不是一条 `node --check a && node --check b && …`：新增或改名文件时写死清单就会漏。
 * 这里自动枚举入口与 `lib/` 下的全部模块逐个 `node --check`，任何一个失败即整体失败。
 *
 * 为什么必须覆盖 `lib/**`：宿主相关模块（如 `lib/bridge.js`）在离线环境里无法被测试导入，
 * 对应测试文件会整体跳过；若 `--check` 只查三个入口，一个语法错误就能同时躲开测试与自检，形成假绿。
 *
 * 用法：`npm run check`（等价于 `node tools/check-syntax.mjs`）。
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1');

/**
 * 递归收集某目录下指定后缀的文件（相对仓库根）。
 * 递归而非只查一层：`lib/` 当前是扁平的，但新增子目录不该悄悄逃过自检。
 * @param {string} relative - 相对仓库根的目录。
 * @param {string} ext - 文件后缀（如 '.js'/'.mjs'）。
 * @returns {string[]} 相对路径数组。
 */
function collect(relative, ext) {
  const out = [];
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const next = `${relative}/${entry.name}`;
    if (entry.isDirectory()) out.push(...collect(next, ext));
    else if (entry.name.endsWith(ext)) out.push(next);
  }
  return out;
}

const roots = ['client.js', 'typert.host.js'];
// `.mjs` 一并枚举：lib/ 下的 ESM 工作者文件（regex-worker.mjs）也在自检范围。
const targets = [...new Set(['lib/index.js', ...collect('lib', '.js'), ...collect('lib', '.mjs'), ...roots])].sort();

let failed = 0;
for (const target of targets) {
  // `stdio: 'inherit'`：不经过管道采集输出，避免在受限沙箱里因管道限制而失败。
  const result = spawnSync(process.execPath, ['--check', join(root, target)], { stdio: 'inherit' });
  if (result.status !== 0) {
    failed += 1;
    process.stderr.write(`[check] 语法错误：${target}\n`);
  }
}
process.stdout.write(`[check] ${targets.length} 个文件，失败 ${failed} 个\n`);
process.exitCode = failed === 0 ? 0 : 1;
