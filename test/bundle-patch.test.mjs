import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * bundle patch 形状守护＋发布范围守护（design §9.1）。
 *
 * 预设注入主路径＝本包 cordis.patch.yml 的 permission 行四档重述（随包装卸）；
 * pnpm 不执行依赖卸载脚本，生命周期脚本不能承载卸载清理；本文件断言防止重新引入。
 * 本文件不解析 YAML（无解析依赖）：按行定位做定向断言——不猜结构，找不到锚点就红。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const patchText = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
const patchLines = patchText.split('\n');

/**
 * npm 生命周期脚本禁令的**规则**——按规则判全，不靠人工名单（名单会漏键）。
 *
 * npm 会在生命周期事件前后执行同名前后缀脚本，且 `npm run <script>` 也会执行 `pre<script>` /
 * `post<script>` 影子钩子（pretest 会在 npm test 时跑）。因此规则不靠枚举：
 *   1. 禁止任何以 `pre` / `post` 开头的 scripts 键——覆盖 npm 文档全部生命周期键
 *      （preinstall/install/postinstall、prepublish/prepublishOnly/prepack/postpack、
 *      prepare/preprepare/postprepare、preuninstall/uninstall/postuninstall、publish/postpublish）
 *      及对仓库自有脚本的影子钩子（如 pretest）；
 *   2. 禁止裸键 install / uninstall / publish（不以 pre/post 开头的生命周期事件名）。
 * 仓库自有脚本名（test、check、probe:* 等）均不以 pre/post 开头，不受影响。
 * @param {string} key - scripts 键名。
 * @returns {boolean} true＝命中禁令（红）。
 */
function isBannedScriptKey(key) {
  return /^(pre|post)/u.test(key) || ['install', 'uninstall', 'publish'].includes(key);
}

/** npm 文档生命周期键全集＋影子钩子样例（矩阵用：规则必须逐一命中，防名单漏键回潮）。 */
const LIFECYCLE_MUTANTS = [
  'preinstall', 'install', 'postinstall',
  'preuninstall', 'uninstall', 'postuninstall',
  'prepare', 'preprepare', 'postprepare',
  'prepublish', 'prepublishOnly', 'prepack', 'postpack',
  'publish', 'postpublish',
  'pretest', 'postcheck', // npm run 影子钩子（对自有脚本的自动前后缀执行）
];

/**
 * 定位条目块：自 `- id: <id>` 行到下一个顶层行（`^- `）或文件尾。
 * @param {string} id - 条目 id。
 * @returns {number[]} 块内行号数组；找不到时抛错（锚点缺失＝红，不是跳过）。
 */
function rowBlock(id) {
  const start = patchLines.findIndex((line) => line === `- id: ${id}`);
  assert.ok(start >= 0, `cordis.patch.yml 缺少 - id: ${id} 条目`);
  const end = patchLines.findIndex((line, index) => index > start && /^- /u.test(line));
  const stop = end === -1 ? patchLines.length : end;
  const indexes = [];
  for (let index = start; index < stop; index += 1) indexes.push(index);
  return indexes;
}

/**
 * 在块内找一个形如 `<indent><key>:` 的条目行号。
 * @param {number[]} block - 块内行号。
 * @param {string} key - 条目键。
 * @returns {number} 行号；找不到时抛错。
 */
function tierIndex(block, key) {
  const at = block.find((index) => new RegExp(`^\\s+${key}:\\s*$`, 'u').test(patchLines[index]));
  assert.ok(at !== undefined, `permission 行内缺少 ${key}: 条目`);
  return at;
}

/**
 * 读取条目块内的标量子键值（如 sandbox / approval）。
 * @param {number} start - 条目行号。
 * @param {string[]} block - 块内行号（限制搜索范围）。
 * @param {string} key - 子键名。
 * @returns {string} 值；找不到时抛错。
 */
function scalarOf(start, block, key) {
  for (let step = 1; step < 8; step += 1) {
    const index = start + step;
    if (!block.includes(index)) break;
    const match = new RegExp(`^\\s+${key}: (.+)$`, 'u').exec(patchLines[index]);
    if (match) return match[1].trim();
    // 遇到下一个同缩进条目（如 `      danger-full-access:`）即停止。
    if (/^\s{6}\S/u.test(patchLines[index]) && /:\s*$/u.test(patchLines[index])) break;
  }
  assert.fail(`条目（行 ${start + 1}）缺少 ${key}: 子键`);
}

test('bundle patch：approve-for-me 插入行在场', () => {
  const insertAt = patchLines.findIndex((line) => line.trim() === '- insert:');
  assert.ok(insertAt >= 0, 'cordis.patch.yml 缺少 - insert: 结构');
  const block = patchLines.slice(insertAt, insertAt + 6).join('\n');
  assert.match(block, /id: approve-for-me/u, '插入行必须挂本包插件行');
  assert.match(block, /name: dsh-approve-for-me/u);
});

test('bundle patch：permission 行重述——name 断言＋四档且序正确', () => {
  const block = rowBlock('permission');
  const blockText = block.map((index) => patchLines[index]).join('\n');
  assert.match(blockText, /name: '@deepseek-ai\/dsh-permission-presets'/u, '重述必须带 name 断言（上游换包名＝告警跳过而非静默错配）');
  assert.match(blockText, /^\s{2}config:\s*$/mu, '重述必须带 config 块');
  assert.match(blockText, /^\s{4}presets:\s*$/mu, '重述必须带 presets 块');
  const order = ['read-only', 'workspace-write', 'auto-approve', 'danger-full-access'].map((key) => tierIndex(block, key));
  for (let index = 1; index < order.length; index += 1) {
    assert.ok(order[index] > order[index - 1], `档位序必须为 read-only→workspace-write→auto-approve→danger-full-access（${order.join(',')}）`);
  }
});

test('bundle patch：三标准档取值与 dsh-base 逐字一致', () => {
  const block = rowBlock('permission');
  assert.equal(scalarOf(tierIndex(block, 'read-only'), block, 'sandbox'), 'read-only');
  assert.equal(scalarOf(tierIndex(block, 'read-only'), block, 'approval'), 'ask');
  // workspace-write 自身的取值必须钉住：它是会话回落目标＋auto-approve 的等同基准，
  // 相等性断言（下一用例）对「两档一起改错」不设防。
  assert.equal(scalarOf(tierIndex(block, 'workspace-write'), block, 'sandbox'), 'workspace-write');
  assert.equal(scalarOf(tierIndex(block, 'workspace-write'), block, 'approval'), 'ask');
  assert.equal(scalarOf(tierIndex(block, 'danger-full-access'), block, 'sandbox'), 'danger-full-access');
  assert.equal(scalarOf(tierIndex(block, 'danger-full-access'), block, 'approval'), 'never');
});

test('bundle patch：auto-approve knobs 与 workspace-write 逐字段等同＋展示名在场', () => {
  const block = rowBlock('permission');
  const workspaceWrite = tierIndex(block, 'workspace-write');
  const autoApprove = tierIndex(block, 'auto-approve');
  // knobs 等同是宿主 derive() 会话回落的前提（design §9.1）：unset 或改值都会让旧会话悬空。
  assert.equal(scalarOf(autoApprove, block, 'sandbox'), scalarOf(workspaceWrite, block, 'sandbox'), 'auto-approve.sandbox 必须与 workspace-write 相同');
  assert.equal(scalarOf(autoApprove, block, 'approval'), scalarOf(workspaceWrite, block, 'approval'), 'auto-approve.approval 必须与 workspace-write 相同');
  assert.match(patchLines[autoApprove + 3] ?? '', /name: 自动审批/u, 'auto-approve 需带展示名');
  assert.match(block.map((index) => patchLines[index]).join('\n'), /自动判定/u, 'auto-approve 需带说明文案');
});

test('bundle patch：重述不写 defaultPreset（design §9.1 禁令）', () => {
  const block = rowBlock('permission');
  for (const index of block) {
    assert.doesNotMatch(patchLines[index], /defaultPreset/u, `行 ${index + 1} 出现 defaultPreset——插件档不得作默认`);
  }
});

test('发布范围守护：package.json 禁止生命周期脚本（design §9.1，防钩子通道回潮）', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const scripts = Object.keys(pkg.scripts ?? {});
  const lifecycle = scripts.filter(isBannedScriptKey);
  assert.deepEqual(lifecycle, [], `scripts 不得声明生命周期键或影子钩子（pnpm 不执行依赖卸载脚本，不能承载卸载清理）：${lifecycle.join(', ')}`);
});

test('发布范围守护：生命周期禁令按规则判全——npm 全集键与影子钩子逐一命中，自有脚本名不误伤', () => {
  // 反例对照：注入的每个生命周期键都必须被拦下——任何 pre*/post* 与裸事件键都算，
  // 新增生命周期键无需改名单即红。
  for (const key of LIFECYCLE_MUTANTS) {
    assert.equal(isBannedScriptKey(key), true, `规则必须拦截生命周期键：${key}`);
  }
  // 仓库自有脚本名（及常见无害键）不得误伤——误伤会让守护失去可信度。
  for (const key of ['test', 'test:offline', 'check', 'check:public-surface', 'probe:typert', 'probe:llm', 'lint']) {
    assert.equal(isBannedScriptKey(key), false, `规则不得误伤自有脚本名：${key}`);
  }
});

test('发布范围守护：files 白名单与 hooks 缺席', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const files = pkg.files ?? [];
  for (const entry of ['cordis.patch.yml', 'lib']) {
    assert.ok(files.includes(entry), `files 白名单缺少 ${entry}`);
  }
  // 发布产物不携带配置清理工具与 hooks；本组断言防止重新引入。
  assert.ok(!files.includes('tools/permission-preset.mjs'), 'files 白名单不得再含配置清理工具');
  assert.equal(existsSync(join(root, 'tools', 'permission-preset.mjs')), false, '配置清理工具脚本必须删除');
  assert.ok(!files.includes('hooks'), 'files 白名单不得再含 hooks');
  assert.equal(existsSync(join(root, 'hooks')), false, 'hooks/ 目录必须删除（生命周期脚本禁令）');
});
