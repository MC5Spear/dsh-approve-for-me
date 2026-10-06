import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardDefaultPreset, guardOnDisposal, shouldResetResidue } from '../lib/preset-guard.js';

/**
 * R57（设计 §28.3-2；盲审修订）：预设残留防护的判定矩阵与全链行为。
 *
 * 危险形态：宿主设置界面把默认预设选择持久化进 profile patch 的 permission 行 config 覆盖，
 * 且覆盖自带**当时生效的全部 presets**（装着本包时＝四档，无论默认档选的是谁）。卸载后：
 * 默认档悬空＝行装载失败＝全部会话不可用；默认档已是标准档时，被拖入的 auto-approve 条目
 * 仍作为残值滞留（下拉仍显示本包档名）。防护＝disposer 里「数组已除名才做贡献级手术」：
 * 只删本包贡献（auto-approve 条目块＋悬空默认行），按编辑后形态决定整行删除（恢复继承）
 * 或保留行（保全用户有效选择与自定义）。全部用例对临时 profile fixture 断言，任何路径
 * 都不得抛出（best-effort）。
 *
 * 夹具形态纪律：宿主真实写路径产出＝模板注释＋行块、**无独立 `[]` 占位**（yaml Document
 * 重写会把它坍缩进块序列）；「注释＋`[]`＋行」是手工损坏形态，仅用于判重用例。
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

/** 模板注释头（与官方 profile 模板同形）。 */
const TEMPLATE_HEADER = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
].join('\n');

/** 组装覆盖行文本：三标准档＋可选本包条目＋可选默认档行＋可选自定义档。 */
function overrideRow({ withOurs = true, defaultPreset = 'auto-approve', extraTier = null } = {}) {
  const lines = [
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
  ];
  if (withOurs) {
    lines.push('      auto-approve:', '        sandbox: workspace-write', '        approval: ask', "        name: 自动审批");
  }
  if (extraTier !== null) {
    lines.push('      my-custom:', '        sandbox: read-only', '        approval: never');
  }
  lines.push('      danger-full-access:', '        sandbox: danger-full-access', '        approval: never');
  if (defaultPreset !== null) lines.push(`    defaultPreset: ${defaultPreset}`);
  return lines.join('\n');
}

/** 宿主设置写出的典型形态：四档＋defaultPreset=auto-approve（strip(raw) 拖入非易变键）。 */
const SETTINGS_AP = `${TEMPLATE_HEADER}\n${overrideRow()}\n`;
/** 盲审反例形态：默认档已切回标准档，四档仍被拖入覆盖。 */
const SETTINGS_STANDARD = `${TEMPLATE_HEADER}\n${overrideRow({ defaultPreset: 'workspace-write' })}\n`;
/** 计数顶层数组占位行（防双 `[]` 非法文档）。 */
const countPlaceholders = (text) => (text.match(/^\[\]\s*$/gmu) ?? []).length;

test('shouldResetResidue 判定矩阵', () => {
  // 数组无效（缺失/损坏/非数组）＝不可判定，一律不动。
  assert.equal(shouldResetResidue(undefined, true), false);
  assert.equal(shouldResetResidue('nope', true), false);
  assert.equal(shouldResetResidue({ 0: 'x' }, true), false);
  // 数组含本包＝普通关停/升级/热重载，绝不动用户的任何配置。
  assert.equal(shouldResetResidue(['dsh-base', 'dsh-approve-for-me'], true), false);
  // 数组不含本包（正被移除/停用）且覆盖含本包贡献（条目或悬空默认档）＝手术。
  assert.equal(shouldResetResidue(['dsh-base'], true), true);
  // 覆盖不含本包贡献（常态）＝不动。
  assert.equal(shouldResetResidue(['dsh-base'], false), false);
});

test('复位路径：默认档＝auto-approve（设置拖入四档）——整行删除恢复继承', async () => {
  const dir = makeProfile({ bundles: ['dsh-base'], patch: SETTINGS_AP });
  const result = await guardDefaultPreset({ profileDir: dir });
  assert.deepEqual(result, { action: 'reset', reason: 'removed-user-override' });
  const after = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8');
  assert.doesNotMatch(after, /permission|auto-approve|defaultPreset/u, '悬空行整行删除＝恢复继承层');
  assert.match(after, /# Your patch layer/u, '模板头保留');
  assert.equal(countPlaceholders(after), 1, '删空后恰一个 [] 占位');
  rmSync(dir, { recursive: true, force: true });
});

test('复位路径（盲审反例）：默认档已切标准档——条目级清理，行保留、用户选择保全', async () => {
  const dir = makeProfile({ bundles: ['dsh-base'], patch: SETTINGS_STANDARD });
  const result = await guardDefaultPreset({ profileDir: dir });
  assert.deepEqual(result, { action: 'reset', reason: 'removed-tier-entry' });
  const after = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8');
  // 本包条目消失＝外来档名不再残留。
  assert.doesNotMatch(after, /auto-approve/u, 'auto-approve 条目必须删除（盲审反例的残值）');
  // 行保留：用户的有效默认选择与三标准档重述都在（等价于本包从未存在时设置写出的形态）。
  assert.match(after, /- id: permission/u, '行保留');
  assert.match(after, /defaultPreset: workspace-write/u, '用户的有效默认选择必须保全');
  assert.match(after, /read-only:|workspace-write:|danger-full-access:/u);
  assert.equal(countPlaceholders(after), 0, '行保留时不补占位');
  rmSync(dir, { recursive: true, force: true });
});

test('复位路径：本包条目＋自定义档＋标准默认——只删本包条目，自定义保全', async () => {
  const patch = `${TEMPLATE_HEADER}\n${overrideRow({ defaultPreset: 'workspace-write', extraTier: true })}\n`;
  const dir = makeProfile({ bundles: ['dsh-base'], patch });
  const result = await guardDefaultPreset({ profileDir: dir });
  assert.deepEqual(result, { action: 'reset', reason: 'removed-tier-entry' });
  const after = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8');
  assert.doesNotMatch(after, /auto-approve/u);
  assert.match(after, /my-custom:/u, '用户自定义档必须保全');
  assert.match(after, /defaultPreset: workspace-write/u, '用户默认选择必须保全');
  rmSync(dir, { recursive: true, force: true });
});

test('复位路径：悬空默认档但无本包条目、行内全标准——整行删除恢复继承', async () => {
  const patch = `${TEMPLATE_HEADER}\n${overrideRow({ withOurs: false, defaultPreset: 'auto-approve' })}\n`;
  const dir = makeProfile({ bundles: ['dsh-base'], patch });
  const result = await guardDefaultPreset({ profileDir: dir });
  assert.deepEqual(result, { action: 'reset', reason: 'removed-user-override' });
  const after = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8');
  assert.doesNotMatch(after, /permission|auto-approve/u);
  assert.equal(countPlaceholders(after), 1);
  rmSync(dir, { recursive: true, force: true });
});

test('复位路径：悬空默认档＋自定义档——只删悬空默认行，其余保全', async () => {
  const patch = `${TEMPLATE_HEADER}\n${overrideRow({ withOurs: false, defaultPreset: 'auto-approve', extraTier: true })}\n`;
  const dir = makeProfile({ bundles: ['dsh-base'], patch });
  const result = await guardDefaultPreset({ profileDir: dir });
  assert.deepEqual(result, { action: 'reset', reason: 'removed-tier-entry' });
  const after = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8');
  assert.doesNotMatch(after, /defaultPreset/u, '悬空默认行必须删除（会话不可用的源头）');
  assert.match(after, /my-custom:/u, '自定义档保全');
  assert.match(after, /- id: permission/u, '行保留');
  rmSync(dir, { recursive: true, force: true });
});

test('复位路径：行内只剩本包条目（presets 删空风险）——整行删除', async () => {
  const bare = [
    '- id: permission',
    "  name: '@deepseek-ai/dsh-permission-presets'",
    '  config:',
    '    presets:',
    '      auto-approve:',
    '        sandbox: workspace-write',
    '        approval: ask',
  ].join('\n');
  const dir = makeProfile({ bundles: ['dsh-base'], patch: `${bare}\n` });
  const result = await guardDefaultPreset({ profileDir: dir });
  assert.equal(result.reason, 'removed-user-override', 'presets 删空会让 PP 构造器抛错，必须整行删除');
  const after = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8');
  assert.equal(countPlaceholders(after), 1);
  assert.doesNotMatch(after, /permission|auto-approve/u);
  rmSync(dir, { recursive: true, force: true });
});

test('复位路径：引号形态 defaultPreset: "auto-approve" 同样命中', async () => {
  const quoted = SETTINGS_AP.replace('defaultPreset: auto-approve', 'defaultPreset: "auto-approve"');
  const dir = makeProfile({ bundles: ['dsh-base'], patch: quoted });
  const result = await guardDefaultPreset({ profileDir: dir });
  assert.equal(result.action, 'reset');
  const after = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8');
  assert.doesNotMatch(after, /auto-approve/u);
  rmSync(dir, { recursive: true, force: true });
});

test('复位路径：手工损坏形态（注释＋[]＋行）不产出双占位', async () => {
  const dir = makeProfile({ bundles: ['dsh-base'], patch: `${TEMPLATE_HEADER}\n[]\n${overrideRow()}\n` });
  const result = await guardDefaultPreset({ profileDir: dir });
  assert.equal(result.action, 'reset');
  const after = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8');
  assert.equal(countPlaceholders(after), 1, '已有 [] 行时不得再补（双流式序列＝非法 YAML）');
  assert.doesNotMatch(after, /^- /mu);
  rmSync(dir, { recursive: true, force: true });
});

test('复位路径：CRLF 文件判定命中且未删行行尾保留', async () => {
  const crlf = SETTINGS_STANDARD.split('\n').join('\r\n');
  const dir = makeProfile({ bundles: ['dsh-base'], patch: crlf });
  const result = await guardDefaultPreset({ profileDir: dir });
  assert.equal(result.action, 'reset', 'CRLF 行尾不得让锚点正则漏配');
  const after = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8');
  assert.ok(after.includes('\r\n'), '未删行（模板头）的 CRLF 行尾必须原样保留');
  assert.doesNotMatch(after, /auto-approve/u);
  rmSync(dir, { recursive: true, force: true });
});

test('幂等：两种复位形态二次执行都按 not-required 跳过且不再改文件', async () => {
  for (const patch of [SETTINGS_AP, SETTINGS_STANDARD]) {
    const dir = makeProfile({ bundles: ['dsh-base'], patch });
    assert.equal((await guardDefaultPreset({ profileDir: dir })).action, 'reset');
    const afterFirst = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8');
    const second = await guardDefaultPreset({ profileDir: dir });
    assert.deepEqual(second, { action: 'skip', reason: 'not-required' });
    assert.equal(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'), afterFirst, '二次执行不得再动文件');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('不动作：数组仍含本包（升级/重载/关停）——即便残留本包贡献', async () => {
  const dir = makeProfile({ bundles: ['dsh-base', 'dsh-approve-for-me'], patch: SETTINGS_AP });
  const result = await guardDefaultPreset({ profileDir: dir });
  assert.deepEqual(result, { action: 'skip', reason: 'not-required' });
  assert.equal(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'), SETTINGS_AP, '文件必须原样');
  rmSync(dir, { recursive: true, force: true });
});

test('不动作：无覆盖行或行内无本包贡献（常态）', async () => {
  const noRow = makeProfile({ bundles: ['dsh-base'], patch: '# template\n[]\n' });
  assert.deepEqual(await guardDefaultPreset({ profileDir: noRow }), { action: 'skip', reason: 'not-required' });
  // 默认档＝标准且行内无本包条目：设置写在卸载后落下的形态，无本包贡献。
  const noResidue = makeProfile({ bundles: ['dsh-base'], patch: `${TEMPLATE_HEADER}\n${overrideRow({ withOurs: false, defaultPreset: 'workspace-write' })}\n` });
  assert.deepEqual(await guardDefaultPreset({ profileDir: noResidue }), { action: 'skip', reason: 'not-required' });
  assert.match(readFileSync(join(noResidue, 'cordis.patch.yml'), 'utf8'), /defaultPreset: workspace-write/u, '文件必须原样');
  rmSync(noRow, { recursive: true, force: true });
  rmSync(noResidue, { recursive: true, force: true });
});

test('降级路径全表（不得抛出）', async () => {
  // profileContext 缺席（非 profile 环境）。
  assert.deepEqual(await guardDefaultPreset({ profileDir: undefined }), { action: 'skip', reason: 'no-profile' });
  assert.deepEqual(await guardDefaultPreset({ profileDir: '' }), { action: 'skip', reason: 'no-profile' });
  assert.deepEqual(await guardDefaultPreset({}), { action: 'skip', reason: 'no-profile' });
  // manifest 缺失/损坏/无键。
  const dirA = makeProfile({ bundles: ['dsh-base'], patch: SETTINGS_AP });
  rmSync(join(dirA, 'package.json'));
  assert.equal((await guardDefaultPreset({ profileDir: dirA })).reason, 'manifest-unreadable');
  writeFileSync(join(dirA, 'package.json'), '{broken', 'utf8');
  assert.equal((await guardDefaultPreset({ profileDir: dirA })).reason, 'manifest-unreadable');
  const noKey = makeProfile({ patch: SETTINGS_AP });
  assert.equal((await guardDefaultPreset({ profileDir: noKey })).reason, 'not-required', 'manifest 无 bundles 键＝不可判定＝不动');
  // patch 缺失。
  const dirB = makeProfile({ bundles: ['dsh-base'] });
  assert.equal((await guardDefaultPreset({ profileDir: dirB })).reason, 'patch-unreadable');
  // BOM 保留：带 BOM 的文件复位后 BOM 仍在。
  const bomDir = mkdtempSync(join(tmpdir(), 'dsafm-guard-'));
  writeFileSync(join(bomDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-base'] } } }), 'utf8');
  writeFileSync(join(bomDir, 'cordis.patch.yml'), '﻿' + SETTINGS_AP, 'utf8');
  assert.equal((await guardDefaultPreset({ profileDir: bomDir })).action, 'reset');
  assert.ok(readFileSync(join(bomDir, 'cordis.patch.yml'), 'utf8').startsWith('﻿'), 'BOM 保留');
  for (const dir of [dirA, noKey, dirB, bomDir]) rmSync(dir, { recursive: true, force: true });
});

test('guardOnDisposal：接线——复位落 guard 审计，失败性跳过（写失败/不可读）落 error 审计，良性跳过静默', async () => {
  const audits = [];
  const audit = (fields) => audits.push(fields);
  const withAP = makeProfile({ bundles: ['dsh-base'], patch: SETTINGS_AP });
  const withStandard = makeProfile({ bundles: ['dsh-base'], patch: SETTINGS_STANDARD });
  const withPkg = makeProfile({ bundles: ['dsh-base', 'dsh-approve-for-me'], patch: SETTINGS_AP });
  // 写失败注入（确定性）：预占原子写的临时文件名为目录 → writeFileSync 必抛 EISDIR。
  const brokenWrite = makeProfile({ bundles: ['dsh-base'], patch: SETTINGS_AP });
  mkdirSync(join(brokenWrite, 'cordis.patch.yml.dsafm-guard.tmp'), { recursive: true });
  // manifest 不可读注入：损坏 JSON（失败性跳过应留审计）。
  const brokenManifest = makeProfile({ bundles: ['dsh-base'], patch: SETTINGS_AP });
  writeFileSync(join(brokenManifest, 'package.json'), '{broken', 'utf8');
  // patch 不可读注入：删除 patch 文件。
  const noPatch = makeProfile({ bundles: ['dsh-base'], patch: SETTINGS_AP });
  rmSync(join(noPatch, 'cordis.patch.yml'));
  const cases = [
    { name: '复位（整行删除）', dir: withAP, services: { profileContext: { dir: withAP } }, wantAction: 'reset', wantAudits: 1, wantSource: 'guard' },
    { name: '复位（条目级清理）', dir: withStandard, services: { profileContext: { dir: withStandard } }, wantAction: 'reset', wantAudits: 1, wantSource: 'guard' },
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
      assert.match(audits[0].reason, /预设残留防护/u, '审计文案随防护更名');
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
  const dir = makeProfile({ bundles: ['dsh-base'], patch: SETTINGS_AP });
  mkdirSync(join(dir, 'subdir'), { recursive: true });
  writeFileSync(join(dir, 'subdir', 'keep.txt'), 'keep', 'utf8');
  const manifestBefore = readFileSync(join(dir, 'package.json'), 'utf8');
  await guardDefaultPreset({ profileDir: dir });
  assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), manifestBefore, 'manifest 只读');
  assert.equal(readFileSync(join(dir, 'subdir', 'keep.txt'), 'utf8'), 'keep');
  rmSync(dir, { recursive: true, force: true });
});
