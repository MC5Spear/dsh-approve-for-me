import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardDefaultPreset, guardOnDisposal, shouldResetDefaultPreset } from '../lib/preset-guard.js';

/**
 * R57（设计 §28.3-2）：默认预设悬空防护的判定矩阵与全链行为。
 *
 * 危险形态：宿主设置界面把「默认预设＝auto-approve」持久化进 profile patch 的 permission 行
 * config 覆盖（覆盖自带四档 presets——设置写回路以当时生效配置为基）。本包卸载后该覆盖滞留：
 * 行装载失败＝全部会话不可用，或四档重述作为残值滞留用户层。防护＝disposer 里「数组已除名
 * 才删该覆盖行」。全部用例对临时 profile fixture 断言，任何路径都不得抛出（best-effort）。
 *
 * 夹具形态纪律（实现审查 R57 发现 2）：宿主真实写路径产出＝模板注释＋行块、**无独立 `[]` 占位**
 * （yaml Document 重写会把它坍缩进块序列）；「注释＋`[]`＋行」是手工损坏形态，仅用于判重用例。
 */

/** 造一个临时 profile 目录：manifest＋可选 patch 文本。 */
function makeProfile({ bundles, patch } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsafm-guard-'));
  const manifest = bundles === undefined
    ? { name: 'dsh-profile-x', private: true }
    : { name: 'dsh-profile-x', private: true, dependencies: {}, dsh: { profile: { bundles } } };
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest), 'utf8');
  if (patch !== undefined) writeFileSync(join(dir, 'cordis.patch.yml'), patch, 'utf8');
  return dir;
}

/** 宿主设置界面写出的典型覆盖行（presets＋defaultPreset——strip(raw) 拖入非易变键的形态）。 */
const TEMPLATE_HEADER = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
].join('\n');
const OVERRIDE_ROW = [
  '- id: permission',
  "  name: '@deepseek-ai/dsh-permission-presets'",
  '  config:',
  '    presets:',
  '      read-only:',
  '        sandbox: read-only',
  '        approval: ask',
  '      workspace-write:',
  '        sandbox: workspace-write',
  '        approval: ask',
  '      auto-approve:',
  '        sandbox: workspace-write',
  '        approval: ask',
  "        name: 自动审批",
  '      danger-full-access:',
  '        sandbox: danger-full-access',
  '        approval: never',
  '    defaultPreset: auto-approve',
].join('\n');
/** 宿主真实形态：模板注释＋覆盖行（无 `[]` 占位）。 */
const HOST_REAL = `${TEMPLATE_HEADER}\n${OVERRIDE_ROW}\n`;
/** 计数顶层数组占位行（防双 `[]` 非法文档）。 */
const countPlaceholders = (text) => (text.match(/^\[\]\s*$/gmu) ?? []).length;

test('shouldResetDefaultPreset 判定矩阵', () => {
  // 数组无效（缺失/损坏/非数组）＝不可判定，一律不动。
  assert.equal(shouldResetDefaultPreset(undefined, true), false);
  assert.equal(shouldResetDefaultPreset('nope', true), false);
  assert.equal(shouldResetDefaultPreset({ 0: 'x' }, true), false);
  // 数组含本包＝普通关停/升级/热重载，绝不动用户的默认档选择。
  assert.equal(shouldResetDefaultPreset(['dsh-base', 'dsh-approve-for-me'], true), false);
  // 数组不含本包（正被移除/停用）且覆盖指向本包预设＝复位。
  assert.equal(shouldResetDefaultPreset(['dsh-base'], true), true);
  // 覆盖不指向本包预设（常态：从未选过）＝不动。
  assert.equal(shouldResetDefaultPreset(['dsh-base'], false), false);
});

test('复位路径：删除覆盖行整行（含被拖入的 presets 残值），patch 其余内容原样', async () => {
  const otherRow = '- id: approve-for-me\n  config:\n    fallback: ask\n';
  const dir = makeProfile({ bundles: ['dsh-base'], patch: `# header\n${OVERRIDE_ROW}\n${otherRow}` });
  const result = await guardDefaultPreset({ profileDir: dir });
  assert.deepEqual(result, { action: 'reset', reason: 'removed-user-override' });
  const after = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8');
  // 覆盖行整行消失（defaultPreset 与被拖入的四档 presets 一起）＝零残值。
  assert.doesNotMatch(after, /permission/u, 'permission 覆盖行必须整行删除');
  assert.doesNotMatch(after, /auto-approve|defaultPreset/u);
  // 其余行原样保留；仍有条目时不补占位。
  assert.match(after, /# header/u);
  assert.match(after, /- id: approve-for-me/u);
  assert.match(after, /fallback: ask/u);
  assert.equal(countPlaceholders(after), 0, '仍有条目时不得补 [] 占位');
  rmSync(dir, { recursive: true, force: true });
});

test('复位路径：覆盖行是唯一条目（宿主真实形态，无 [] 占位）——补回恰好一个占位', async () => {
  const dir = makeProfile({ bundles: ['dsh-base'], patch: HOST_REAL });
  const result = await guardDefaultPreset({ profileDir: dir });
  assert.equal(result.action, 'reset');
  const after = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8');
  assert.doesNotMatch(after, /permission|auto-approve|defaultPreset/u);
  assert.match(after, /# Your patch layer/u, '模板头保留');
  // 可解析性断言（实现审查 R57 发现 2）：恰好一个顶层占位、零残留条目。
  assert.equal(countPlaceholders(after), 1, '删空后必须补回恰好一个 [] 占位（宿主 parsePatchList 拒绝 null 与双序列）');
  assert.doesNotMatch(after, /^- /mu);
  rmSync(dir, { recursive: true, force: true });
});

test('复位路径：无注释无占位的裸行文档——手术后恰为 []', async () => {
  const dir = makeProfile({ bundles: ['dsh-base'], patch: `${OVERRIDE_ROW}\n` });
  const result = await guardDefaultPreset({ profileDir: dir });
  assert.equal(result.action, 'reset');
  const after = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8');
  assert.equal(countPlaceholders(after), 1, '清空后必须补回恰好一个 [] 占位');
  assert.doesNotMatch(after, /^- /mu);
  rmSync(dir, { recursive: true, force: true });
});

test('复位路径：手工损坏形态（注释＋[]＋行）不产出双占位——手术后恰一个 []', async () => {
  const dir = makeProfile({ bundles: ['dsh-base'], patch: `${TEMPLATE_HEADER}\n[]\n${OVERRIDE_ROW}\n` });
  const result = await guardDefaultPreset({ profileDir: dir });
  assert.equal(result.action, 'reset');
  const after = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8');
  assert.equal(countPlaceholders(after), 1, '已有 [] 行时不得再补（双流式序列＝非法 YAML）');
  assert.doesNotMatch(after, /^- /mu);
  rmSync(dir, { recursive: true, force: true });
});

test('复位路径：引号形态 defaultPreset: "auto-approve" 同样命中', async () => {
  const quoted = HOST_REAL.replace('defaultPreset: auto-approve', 'defaultPreset: "auto-approve"');
  const dir = makeProfile({ bundles: ['dsh-base'], patch: quoted });
  const result = await guardDefaultPreset({ profileDir: dir });
  assert.equal(result.action, 'reset');
  rmSync(dir, { recursive: true, force: true });
});

test('复位路径：CRLF 文件判定命中且行尾保留（构造性正确需测试钉住）', async () => {
  const crlf = HOST_REAL.split('\n').join('\r\n');
  const dir = makeProfile({ bundles: ['dsh-base'], patch: crlf });
  const result = await guardDefaultPreset({ profileDir: dir });
  assert.equal(result.action, 'reset', 'CRLF 行尾不得让锚点正则漏配');
  const after = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8');
  assert.ok(after.includes('\r\n'), '未删行（模板头）的 CRLF 行尾必须原样保留');
  assert.equal(countPlaceholders(after), 1);
  rmSync(dir, { recursive: true, force: true });
});

test('幂等：复位后立即重跑按 not-required 跳过且不再改文件', async () => {
  const dir = makeProfile({ bundles: ['dsh-base'], patch: HOST_REAL });
  assert.equal((await guardDefaultPreset({ profileDir: dir })).action, 'reset');
  const afterFirst = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8');
  const second = await guardDefaultPreset({ profileDir: dir });
  assert.deepEqual(second, { action: 'skip', reason: 'not-required' });
  assert.equal(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'), afterFirst, '二次执行不得再动文件');
  rmSync(dir, { recursive: true, force: true });
});

test('不动作：数组仍含本包（升级/重载/关停）——即便覆盖悬空指向本包', async () => {
  const dir = makeProfile({ bundles: ['dsh-base', 'dsh-approve-for-me'], patch: HOST_REAL });
  const result = await guardDefaultPreset({ profileDir: dir });
  assert.deepEqual(result, { action: 'skip', reason: 'not-required' });
  assert.match(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'), /defaultPreset: auto-approve/u, '文件必须原样');
  rmSync(dir, { recursive: true, force: true });
});

test('不动作：无覆盖行（常态——从未经设置界面选过本包预设为默认）', async () => {
  const dir = makeProfile({ bundles: ['dsh-base'], patch: '# template\n[]\n' });
  assert.deepEqual(await guardDefaultPreset({ profileDir: dir }), { action: 'skip', reason: 'not-required' });
  rmSync(dir, { recursive: true, force: true });
});

test('不动作：覆盖行存在但 defaultPreset 指向标准档（与本包无关）', async () => {
  const dir = makeProfile({ bundles: ['dsh-base'], patch: HOST_REAL.replace('defaultPreset: auto-approve', 'defaultPreset: read-only') });
  const result = await guardDefaultPreset({ profileDir: dir });
  assert.deepEqual(result, { action: 'skip', reason: 'not-required' });
  assert.match(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'), /defaultPreset: read-only/u);
  rmSync(dir, { recursive: true, force: true });
});

test('降级路径全表（不得抛出）', async () => {
  // profileContext 缺席（非 profile 环境）。
  assert.deepEqual(await guardDefaultPreset({ profileDir: undefined }), { action: 'skip', reason: 'no-profile' });
  assert.deepEqual(await guardDefaultPreset({ profileDir: '' }), { action: 'skip', reason: 'no-profile' });
  assert.deepEqual(await guardDefaultPreset({}), { action: 'skip', reason: 'no-profile' });
  // manifest 缺失/损坏/无键。
  const dirA = makeProfile({ bundles: ['dsh-base'], patch: HOST_REAL });
  rmSync(join(dirA, 'package.json'));
  assert.equal((await guardDefaultPreset({ profileDir: dirA })).reason, 'manifest-unreadable');
  writeFileSync(join(dirA, 'package.json'), '{broken', 'utf8');
  assert.equal((await guardDefaultPreset({ profileDir: dirA })).reason, 'manifest-unreadable');
  const noKey = makeProfile({ patch: HOST_REAL });
  assert.equal((await guardDefaultPreset({ profileDir: noKey })).reason, 'not-required', 'manifest 无 bundles 键＝不可判定＝不动');
  // patch 缺失。
  const dirB = makeProfile({ bundles: ['dsh-base'] });
  assert.equal((await guardDefaultPreset({ profileDir: dirB })).reason, 'patch-unreadable');
  // BOM 保留：带 BOM 的文件复位后 BOM 仍在。
  const bomDir = mkdtempSync(join(tmpdir(), 'dsafm-guard-'));
  writeFileSync(join(bomDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-base'] } } }), 'utf8');
  writeFileSync(join(bomDir, 'cordis.patch.yml'), '﻿' + HOST_REAL, 'utf8');
  assert.equal((await guardDefaultPreset({ profileDir: bomDir })).action, 'reset');
  assert.ok(readFileSync(join(bomDir, 'cordis.patch.yml'), 'utf8').startsWith('﻿'), 'BOM 保留');
  for (const dir of [dirA, noKey, dirB, bomDir]) rmSync(dir, { recursive: true, force: true });
});

test('guardOnDisposal：接线——复位落 guard 审计，失败性跳过（写失败/不可读）落 error 审计，良性跳过静默', async () => {
  const audits = [];
  const audit = (fields) => audits.push(fields);
  const withOverride = makeProfile({ bundles: ['dsh-base'], patch: HOST_REAL });
  const withPkg = makeProfile({ bundles: ['dsh-base', 'dsh-approve-for-me'], patch: HOST_REAL });
  // 写失败注入（确定性）：预占原子写的临时文件名为目录 → writeFileSync 必抛 EISDIR。
  const brokenWrite = makeProfile({ bundles: ['dsh-base'], patch: HOST_REAL });
  mkdirSync(join(brokenWrite, 'cordis.patch.yml.dsafm-guard.tmp'), { recursive: true });
  // manifest 不可读注入：损坏 JSON（失败性跳过应留审计，实现审查 R57 发现 4）。
  const brokenManifest = makeProfile({ bundles: ['dsh-base'], patch: HOST_REAL });
  writeFileSync(join(brokenManifest, 'package.json'), '{broken', 'utf8');
  // patch 不可读注入：删除 patch 文件。
  const noPatch = makeProfile({ bundles: ['dsh-base'], patch: HOST_REAL });
  rmSync(join(noPatch, 'cordis.patch.yml'));
  const cases = [
    { name: '复位', dir: withOverride, services: { profileContext: { dir: withOverride } }, wantAction: 'reset', wantAudits: 1, wantSource: 'guard' },
    { name: '数组仍含本包（良性静默）', dir: withPkg, services: { profileContext: { dir: withPkg } }, wantAction: 'skip', wantAudits: 0 },
    { name: 'profileContext 缺席（良性静默）', dir: undefined, services: {}, wantAction: 'skip', wantAudits: 0 },
    { name: 'patch 写失败（error 审计）', dir: brokenWrite, services: { profileContext: { dir: brokenWrite } }, wantAction: 'skip', wantAudits: 1, wantSource: 'error' },
    { name: 'manifest 不可读（error 审计）', dir: brokenManifest, services: { profileContext: { dir: brokenManifest } }, wantAction: 'skip', wantAudits: 1, wantSource: 'error' },
    { name: 'patch 不可读（error 审计）', dir: noPatch, services: { profileContext: { dir: noPatch } }, wantAction: 'skip', wantAudits: 1, wantSource: 'error' },
  ];
  for (const item of cases) {
    audits.length = 0;
    const ctx = { get: (name) => item.services[name] };
    const result = await guardOnDisposal({ ctx, audit });
    assert.equal(result.action, item.wantAction, `${item.name}：action（${result.reason}）`);
    assert.equal(audits.length, item.wantAudits, `${item.name}：审计行数`);
    if (item.wantSource !== undefined) {
      assert.equal(audits[0].source, item.wantSource, `${item.name}：审计 source`);
      assert.equal(audits[0].phase, 'screen');
      assert.equal(audits[0].action, 'skip');
    }
    if (item.dir !== undefined) rmSync(item.dir, { recursive: true, force: true });
  }
});

test('guardOnDisposal：ctx.get 抛错也按缺席处理（不抛出）', async () => {
  const ctx = {
    get: () => { throw new Error('context disposed'); },
  };
  const result = await guardOnDisposal({ ctx, audit: () => {} });
  assert.equal(result.action, 'skip');
});

test('防护不触碰 manifest 与其他文件：只重写 cordis.patch.yml', async () => {
  const dir = makeProfile({ bundles: ['dsh-base'], patch: HOST_REAL });
  mkdirSync(join(dir, 'subdir'), { recursive: true });
  writeFileSync(join(dir, 'subdir', 'keep.txt'), 'keep', 'utf8');
  const manifestBefore = readFileSync(join(dir, 'package.json'), 'utf8');
  await guardDefaultPreset({ profileDir: dir });
  assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), manifestBefore, 'manifest 只读');
  assert.equal(readFileSync(join(dir, 'subdir', 'keep.txt'), 'utf8'), 'keep');
  rmSync(dir, { recursive: true, force: true });
});
