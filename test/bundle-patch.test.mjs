import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * R57（设计 §28.2/§28.6/§28.10）：bundle patch 形状守护＋发布面守护。
 *
 * 预设注入主路径＝本包 cordis.patch.yml 的 permission 行四档重述（随包装卸）；
 * 生命周期脚本是被实测否决的路径（pnpm 不执行依赖卸载脚本），禁止回潮。
 * 本文件不解析 YAML（无解析依赖）：按行定位做定向断言，与 lib/permission-preset.js
 * 的锚点式文本编辑同一哲学——不猜结构，找不到锚点就红。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const patchText = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
const patchLines = patchText.split('\n');

/** npm 生命周期脚本键全集（出现任何一个即红——R57 生命周期脚本禁令）。 */
const LIFECYCLE_SCRIPT_KEYS = [
  'preinstall', 'install', 'postinstall',
  'preuninstall', 'uninstall', 'postuninstall',
  'prepare', 'prepublishOnly', 'prepack', 'postpack',
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
  // 相等性断言（下一用例）对「两档一起改错」不设防（实现审查 R57 发现 1）。
  assert.equal(scalarOf(tierIndex(block, 'workspace-write'), block, 'sandbox'), 'workspace-write');
  assert.equal(scalarOf(tierIndex(block, 'workspace-write'), block, 'approval'), 'ask');
  assert.equal(scalarOf(tierIndex(block, 'danger-full-access'), block, 'sandbox'), 'danger-full-access');
  assert.equal(scalarOf(tierIndex(block, 'danger-full-access'), block, 'approval'), 'never');
});

test('bundle patch：auto-approve knobs 与 workspace-write 逐字段等同＋展示名在场', () => {
  const block = rowBlock('permission');
  const workspaceWrite = tierIndex(block, 'workspace-write');
  const autoApprove = tierIndex(block, 'auto-approve');
  // knobs 等同是宿主 derive() 会话回落的前提（设计 §28.3-1）：unset 或改值都会让旧会话悬空。
  assert.equal(scalarOf(autoApprove, block, 'sandbox'), scalarOf(workspaceWrite, block, 'sandbox'), 'auto-approve.sandbox 必须与 workspace-write 相同');
  assert.equal(scalarOf(autoApprove, block, 'approval'), scalarOf(workspaceWrite, block, 'approval'), 'auto-approve.approval 必须与 workspace-write 相同');
  assert.match(patchLines[autoApprove + 3] ?? '', /name: 自动审批/u, 'auto-approve 需带展示名');
  assert.match(block.map((index) => patchLines[index]).join('\n'), /自动判定/u, 'auto-approve 需带说明文案');
});

test('bundle patch：重述不写 defaultPreset（R26 禁令）', () => {
  const block = rowBlock('permission');
  for (const index of block) {
    assert.doesNotMatch(patchLines[index], /defaultPreset/u, `行 ${index + 1} 出现 defaultPreset——插件档不得作默认`);
  }
});

test('发布面守护：package.json 禁止生命周期脚本（R57 禁令，防钩子通道回潮）', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const scripts = Object.keys(pkg.scripts ?? {});
  const lifecycle = scripts.filter((key) => LIFECYCLE_SCRIPT_KEYS.includes(key));
  assert.deepEqual(lifecycle, [], `scripts 不得声明生命周期键（实测否决的通道）：${lifecycle.join(', ')}`);
});

test('发布面守护：files 白名单与 hooks 缺席', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const files = pkg.files ?? [];
  for (const entry of ['cordis.patch.yml', 'lib', 'tools/permission-preset.mjs']) {
    assert.ok(files.includes(entry), `files 白名单缺少 ${entry}`);
  }
  assert.ok(!files.includes('hooks'), 'files 白名单不得再含 hooks');
  assert.equal(existsSync(join(root, 'hooks')), false, 'hooks/ 目录必须删除（生命周期脚本禁令）');
});
