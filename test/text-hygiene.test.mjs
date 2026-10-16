import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** 判据自身不扫：规则源码必须能写出被禁词组的字面（与 lint 的词表同例）。 */
const SELF = fileURLToPath(import.meta.url);

/** 不扫的目录：版本库元数据、本机侧工件、依赖与构建产物。 */
const SKIP_DIRS = new Set(['.git', '.local', 'node_modules', 'dist']);
/** 不扫的文件：变更记录是历史档案（档案承载过去），锁文件是生成物。 */
const SKIP_FILES = new Set(['CHANGELOG.md', 'package-lock.json']);

/**
 * 深度遍历仓库内的文本产物（受控中文的载体：文档、代码注释、留档夹具）。
 * @param {string} dir - 起始目录。
 * @returns {Generator<string>} 文件路径。
 */
function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (full === SELF) continue;
    if (statSync(full).isDirectory()) {
      yield* walk(full);
      continue;
    }
    if (/\.(md|js|mjs|txt)$/u.test(name) && !SKIP_FILES.has(name)) yield full;
  }
}

/** 禁用词组：「完成过程」类过程性词组与批次编号——完成过程进 Git，产物只承载现在、按稳定主题定位。 */
const BANNED = [
  [/完成过程/u, '「完成过程」类过程性词组（历史进 Git，产物只承载现在）'],
  [/\bISS-\d+/u, '按修复批次编号的引用（CONTRIBUTING：按稳定主题定位，不按批次编号）'],
];

test('文本防回潮：产物零「完成过程」类词组与批次编号引用', () => {
  const violations = [];
  for (const file of walk(ROOT)) {
    const text = readFileSync(file, 'utf8');
    for (const [pattern, why] of BANNED) {
      const match = text.match(pattern);
      if (match !== null) violations.push(`${relative(ROOT, file)}：${why}（命中「${match[0]}」）`);
    }
  }
  assert.deepEqual(violations, [], '禁用词组零命中（新增引用请改用稳定主题表述）');
});
