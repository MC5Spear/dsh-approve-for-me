/**
 * 部署脚本 tools/permission-preset.mjs 的合同测试（R26 / 设计 §14.1）。
 *
 * 全部用例跑在临时 home 上（--home 参数），不触碰真实 profile；脚本经子进程执行
 * （stdio: 'inherit'——本沙箱拦 pipe 型 spawn，inherit 可用且能拿 exit code）。
 * 每条断言都能失败：删掉脚本对应行为（插入/备份/恢复/锚点校验）该条即红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'permission-preset.mjs');

/**
 * 构造与真实部署的 profile patch 同形的 permission 块文本。
 * @param {string} defaultPresetLine - defaultPreset 行（空串＝无该键）。
 * @returns {string} patch 全文。
 */
function patchText(defaultPresetLine = '    defaultPreset: workspace-write') {
  return [
    '# test profile patch',
    '- id: webserver',
    "  name: '@deepseek-ai/dsh-host-webserver'",
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
    '      danger-full-access:',
    '        sandbox: danger-full-access',
    '        approval: never',
    ...(defaultPresetLine.length === 0 ? [] : [defaultPresetLine]),
    '- id: ui-chat',
    "  name: '@deepseek-ai/dsh-client-ui-chat'",
    '',
  ].join('\n');
}

/**
 * 建临时 home 并写入 patch。
 * @param {string} patch - patch 全文。
 * @returns {string} home 目录。
 */
function makeHome(patch) {
  const home = mkdtempSync(join(tmpdir(), 'afm-preset-'));
  const profileDir = join(home, 'profiles', 'web');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, 'cordis.patch.yml'), patch, 'utf8');
  return home;
}

/** 跑脚本（继承 stdio，断言只看 exit code 与落盘结果）。 */
const run = (home, ...args) => spawnSync(process.execPath, [SCRIPT, ...args, '--home', home, '--profile', 'web'], { stdio: 'inherit' });
const patchOf = (home) => readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');
const backupPath = (home) => join(home, 'approve-for-me', 'permission-grant.json');

test('--apply 在 workspace-write 之后、danger-full-access 之前插入条目；二次执行幂等', () => {
  const home = makeHome(patchText());
  assert.equal(run(home, '--apply').status, 0, '--apply 应 exit 0');
  const lines = patchOf(home).split('\n');
  const at = (token) => lines.findIndex((line) => line.includes(token));
  const ws = at('workspace-write:');
  const entry = at('auto-approve:');
  const danger = at('danger-full-access:');
  assert.ok(entry > ws, `条目必须排在 workspace-write 之后（ws=${ws} entry=${entry}）`);
  assert.ok(entry < danger, `条目必须排在 danger-full-access 之前（entry=${entry} danger=${danger}）`);
  assert.ok(lines.includes('        name: 自动审批'), '条目应带中文名');
  assert.match(patchOf(home), /description: 与「工作区内修改」相同的沙箱与审批策略/);

  const once = patchOf(home);
  assert.equal(run(home, '--apply').status, 0);
  assert.equal(patchOf(home), once, '二次 --apply 必须零 diff（幂等）');
  assert.equal(existsSync(backupPath(home)), false, 'defaultPreset 未指向插件预设时不得产生备份');
});

test('defaultPreset 指向 auto-approve 时：--apply 备份原值并改标准预设', () => {
  const home = makeHome(patchText('    defaultPreset: auto-approve'));
  assert.equal(run(home, '--apply').status, 0);
  assert.match(patchOf(home), /defaultPreset: workspace-write/, '违反 R26 的 defaultPreset 必须被改写');
  assert.ok(existsSync(backupPath(home)), '原值必须备份');
  assert.equal(JSON.parse(readFileSync(backupPath(home), 'utf8')).defaultPreset, 'auto-approve', '备份记录改写前的原值');
});

test('备份值等于已删条目名时：--revert 必须退到标准预设（否则 permission 行注册失败）', () => {
  // 实测缺陷（2026-09-25，开发期部署演练记录 §9）：盲目写回备份值会让下次启动报
  // `permission: unknown preset "auto-approve"`，整行不激活——本断言就是那条回归。
  const home = makeHome(patchText('    defaultPreset: auto-approve'));
  assert.equal(run(home, '--apply').status, 0);
  assert.equal(run(home, '--revert').status, 0);
  const after = patchOf(home);
  assert.equal(after.includes('auto-approve:'), false, 'revert 必须删条目');
  assert.doesNotMatch(after, /defaultPreset: auto-approve/, '备份值正是已删条目名时不得写回（会让设置注册失败）');
  assert.match(after, /defaultPreset: workspace-write/, '应退到仍存在的标准预设');
  assert.equal(existsSync(backupPath(home)), false, 'revert 必须删备份文件');
});

test('备份值是别的有效预设时：--revert 原样恢复，不改写', () => {
  const home = makeHome(patchText('    defaultPreset: workspace-write'));
  mkdirSync(join(home, 'approve-for-me'), { recursive: true });
  writeFileSync(backupPath(home), JSON.stringify({ defaultPreset: 'read-only' }), 'utf8');
  assert.equal(run(home, '--apply').status, 0);
  assert.equal(run(home, '--revert').status, 0);
  assert.match(patchOf(home), /defaultPreset: read-only/, '非条目名的备份值必须原样恢复');
});

test('备份记录「原值缺失」时：--revert 删除 defaultPreset 键而不是恢复', () => {
  const home = makeHome(patchText(''));
  mkdirSync(join(home, 'approve-for-me'), { recursive: true });
  writeFileSync(backupPath(home), JSON.stringify({ defaultPreset: null }), 'utf8');
  assert.equal(run(home, '--apply').status, 0);
  assert.doesNotMatch(patchOf(home), /defaultPreset/, 'apply 不得凭空添加 defaultPreset');
  assert.equal(run(home, '--revert').status, 0);
  assert.doesNotMatch(patchOf(home), /defaultPreset/, '备份为 null → 保持无键');
  assert.equal(existsSync(backupPath(home)), false);
});

test('锚点缺失时 --apply 报错且不落盘', () => {
  const broken = patchText().split('\n').filter((line) => !line.includes('danger-full-access')).join('\n');
  const home = makeHome(broken);
  const before = patchOf(home);
  const result = run(home, '--apply');
  assert.notEqual(result.status, 0, '锚点缺失必须非零退出');
  assert.equal(patchOf(home), before, '失败时不得写任何字节');
});

test('--revert 对无条目的 patch 幂等（exit 0、零 diff）', () => {
  const home = makeHome(patchText());
  const before = patchOf(home);
  assert.equal(run(home, '--revert').status, 0);
  assert.equal(patchOf(home), before);
});

test('备份文件损坏时 --revert 报可诊断错误且不落盘（r26 S5）', () => {
  const home = makeHome(patchText('    defaultPreset: workspace-write'));
  mkdirSync(join(home, 'approve-for-me'), { recursive: true });
  writeFileSync(backupPath(home), '{not json', 'utf8');
  const before = patchOf(home);
  const result = run(home, '--revert');
  assert.notEqual(result.status, 0, '损坏备份必须非零退出');
  assert.equal(patchOf(home), before, '失败时不得写任何字节');
  // 错误消息必须自证（含「备份文件损坏」），不是裸 JSON 语法错；pipe 被沙箱拦时（status null）只保 exit code 与零落盘两断言。
  const capture = spawnSync(process.execPath, [SCRIPT, '--revert', '--home', home, '--profile', 'web'], { encoding: 'utf8' });
  if (capture.status !== null) {
    assert.match(String(capture.stderr), /备份文件损坏/, '错误消息应可诊断（r26 S5）');
  }
  const brokenShape = JSON.stringify({ oops: 1 });
  writeFileSync(backupPath(home), brokenShape, 'utf8');
  const result2 = run(home, '--revert');
  assert.notEqual(result2.status, 0, '形状不对的备份也必须拒绝');
  assert.equal(patchOf(home), before, '两次失败都不得落盘');
});

test('备份已存在时 --apply 不覆盖旧备份（保留最早的原值，r26 S5）', () => {
  const home = makeHome(patchText('    defaultPreset: auto-approve'));
  mkdirSync(join(home, 'approve-for-me'), { recursive: true });
  const original = JSON.stringify({ defaultPreset: null });
  writeFileSync(backupPath(home), original, 'utf8');
  assert.equal(run(home, '--apply').status, 0);
  assert.equal(readFileSync(backupPath(home), 'utf8'), original, '已有备份必须原样保留（首装时记录的原值才可信）');
  assert.match(patchOf(home), /defaultPreset: workspace-write/);
});

test('干净 profile（官方模板：注释 + 空数组文档 `[]`）：--init-row 必须替换 `[]` 而不是续写（D7 回归）', () => {
  // 官方路径实测：`dsh plugin add` 装完后 profile patch 里没有 `permission` 行（它由 dsh-base 提供），
  // 直接 --apply 会因锚点缺失失败；而模板正文是一行 `[]`，在它之后续写列表项会产出非法 YAML
  // （`end of the stream or a document separator is expected`）——本用例逐字照抄模板正文。
  const template = [
    '# Your patch layer for this dsh profile, applied after every bundle layer:',
    '# a top-level YAML array of loader patch entries (id-targeted config',
    '# overrides, disables, and insert lists; `!!js` expressions allowed).',
    '[]',
    '',
  ].join('\n');
  const home = makeHome(template);
  const failed = run(home, '--apply');
  assert.notEqual(failed.status, 0, '没有 permission 行时 --apply 必须失败（不许瞎猜结构）');
  assert.equal(patchOf(home), template, '失败时不得落盘');

  assert.equal(run(home, '--init-row').status, 0, '--init-row 应成功');
  const afterInit = patchOf(home);
  assert.doesNotMatch(afterInit, /^\[\]\s*$/m, '空数组文档那一行必须被替换掉（留着它就是非法 YAML）');
  assert.match(afterInit, /^- id: permission$/m, '应写入 permission 行');
  assert.match(afterInit, /^      read-only:$/m);
  assert.match(afterInit, /^      workspace-write:$/m);
  assert.match(afterInit, /^      danger-full-access:$/m);
  assert.match(afterInit, /sandbox: danger-full-access\n        approval: never/, '三档取值必须与 base 一致');
  assert.match(afterInit, /^# Your patch layer for this dsh profile/m, '模板原有注释应保留');

  const again = patchOf(home);
  assert.equal(run(home, '--init-row').status, 0);
  assert.equal(patchOf(home), again, '--init-row 二次执行必须零 diff（幂等）');

  assert.equal(run(home, '--apply').status, 0, '补齐后 --apply 应成功');
  assert.match(patchOf(home), /^      auto-approve:$/m, '条目应落在重述行里');
});

test('已有块序列的 patch：--init-row 追加到末尾（另一条路径）', () => {
  const withRows = [
    '# test profile patch',
    '- id: ui-chat',
    "  name: '@deepseek-ai/dsh-client-ui-chat'",
    '',
  ].join('\n');
  const home = makeHome(withRows);
  assert.equal(run(home, '--init-row').status, 0);
  const after = patchOf(home);
  assert.match(after, /^- id: ui-chat$/m, '原有行必须保留');
  assert.match(after, /^- id: permission$/m, '重述行应追加在末尾');
  assert.ok(after.indexOf('- id: permission') > after.indexOf('- id: ui-chat'), '追加位置在末尾');
  assert.equal(run(home, '--apply').status, 0);
  assert.match(patchOf(home), /^      auto-approve:$/m);
});

test('`[]` 行之后还有有效内容：--init-row 必须报错且不落盘（终审漏洞回归）', () => {
  const mixed = [
    '# test profile patch',
    '[]',
    '- id: other-row',
    "  name: '@deepseek-ai/dsh-other'",
    '',
  ].join('\n');
  const home = makeHome(mixed);
  const result = run(home, '--init-row');
  assert.notEqual(result.status, 0, '`[]` 之后还有内容时必须报错，不许静默丢行');
  assert.equal(patchOf(home), mixed, '失败时不得落盘（原内容必须一字不动）');
});

test('带引号的 defaultPreset: "auto-approve"：--apply 禁令与 --revert 兜底都必须生效（终审漏洞回归）', () => {
  // YAML 里 `auto-approve` 与 `"auto-approve"` 是同一个标量；只比对裸串会让 R26 禁令与
  // revert 兜底双双失效，从而复活 D6 那类「defaultPreset 指向已删预设」的启动失败。
  const home = makeHome(patchText('    defaultPreset: "auto-approve"'));
  assert.equal(run(home, '--apply').status, 0);
  assert.match(patchOf(home), /defaultPreset: workspace-write/, '带引号的插件预设名同样必须被改写（R26）');
  assert.ok(existsSync(backupPath(home)), '改写前必须备份');
  assert.equal(JSON.parse(readFileSync(backupPath(home), 'utf8')).defaultPreset, '"auto-approve"', '备份记录改写前的原值（原样）');

  assert.equal(run(home, '--revert').status, 0);
  const after = patchOf(home);
  assert.equal(after.includes('auto-approve:'), false, 'revert 必须删条目');
  assert.doesNotMatch(after, /defaultPreset:\s*['"]?auto-approve['"]?/, '带引号的备份值同样不得写回');
  assert.match(after, /defaultPreset: workspace-write/);
});

test('脚本与共享内核是零依赖的：import 只有 node: 前缀或包内相对路径（删光 node_modules 也能跑）', () => {
  // R57 起实现住在 lib/permission-preset.js、CLI 是薄封装（设计 §28.2/§28.3）——判据不变
  // （零 npm 依赖），机械面扩为：两个文件的 import 只允许 node: 前缀或指向包内内核的相对路径。
  const CORE = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'permission-preset.js');
  const RELATIVE_CORE = '../lib/permission-preset.js';
  for (const file of [SCRIPT, CORE]) {
    const source = readFileSync(file, 'utf8');
    const imports = [...source.matchAll(/^import\s+[^;]+?from\s+'([^']+)';/gm)].map((match) => match[1]);
    assert.ok(imports.length > 0, `${file} 至少应有一条 import（防正则失配造成恒真）`);
    for (const specifier of imports) {
      assert.ok(
        /^node:/.test(specifier) || (file === SCRIPT && specifier === RELATIVE_CORE),
        `禁止非 node: 依赖：${specifier}（${file}）`,
      );
    }
  }
});

/**
 * 造 0.2.x 存量部署的完整生命周期形态：官方模板（注释＋[]）→ --init-row → --apply。
 * @param {string} home - 临时 home。
 * @returns {string} initRow+apply 后的 patch 全文。
 */
function legacyDeployed(home) {
  const profileDir = join(home, 'profiles', 'web');
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '# legacy template\n[]\n', 'utf8');
  assert.equal(run(home, '--init-row').status, 0);
  assert.equal(run(home, '--apply').status, 0);
  return patchOf(home);
}

test('--restore-inherit（盲审反例）：存量部署 revert 后重述遮蔽包内四档——restore 回纯 bundle、零字节差', () => {
  const home = makeHome(patchText(''));
  const deployed = legacyDeployed(home);
  assert.equal(run(home, '--revert').status, 0);
  const afterRevert = patchOf(home);
  assert.equal(afterRevert.includes('- id: permission'), true, '盲审反例前提：--revert 保留整行重述（R26 语义）');

  assert.equal(run(home, '--restore-inherit').status, 0);
  const restored = patchOf(home);
  assert.equal(restored, '# legacy template\n[]\n', '模板→initRow→apply→revert→restore 零字节差往返（纯 bundle 继承）');
  assert.equal(restored.includes('permission'), false, '覆盖行必须消失');
  // 反向钉住遮蔽危害：restore 前 permission 重述在场＝组合三档；restore 后＝组合四档由探针
  // （review-r57-blind-probe）用真 composeEntries 证明，这里钉文件位面。
  assert.equal(deployed.includes('- id: permission'), true);
});

test('--restore-inherit：设置写出的四档覆盖（含 auto-approve 条目与默认档）直接整行回收', () => {
  const home = makeHome([
    '# header',
    '- id: permission',
    "  name: '@deepseek-ai/dsh-permission-presets'",
    '  config:',
    '    presets:',
    '      read-only:',
    '        sandbox: read-only',
    '        approval: ask',
    '      auto-approve:',
    '        sandbox: workspace-write',
    '        approval: ask',
    '      danger-full-access:',
    '        sandbox: danger-full-access',
    '        approval: never',
    '    defaultPreset: workspace-write',
    '',
  ].join('\n'));
  assert.equal(run(home, '--restore-inherit').status, 0);
  const after = patchOf(home);
  assert.doesNotMatch(after, /permission|auto-approve|defaultPreset/u, '整行回收＝纯继承');
  assert.match(after, /# header/u, '其余内容原样');
  assert.match(after, /^\[\]\s*$/mu, '删空后恰一个占位');
});

test('--restore-inherit：保全校验——行内含不认识的键/取值时拒绝代删且不落盘', () => {
  // 自定义预设 id。
  const customTier = makeHome([
    '- id: permission',
    "  name: '@deepseek-ai/dsh-permission-presets'",
    '  config:',
    '    presets:',
    '      read-only:',
    '        sandbox: read-only',
    '        approval: ask',
    '      my-tier:',
    '        sandbox: read-only',
    '        approval: never',
    '',
  ].join('\n'));
  const before = patchOf(customTier);
  const result = run(customTier, '--restore-inherit');
  assert.notEqual(result.status, 0, '含自定义档必须拒绝代删');
  assert.equal(patchOf(customTier), before, '失败零落盘');
  // 自定义 config 键。
  const customKey = makeHome([
    '- id: permission',
    "  name: '@deepseek-ai/dsh-permission-presets'",
    '  config:',
    '    presets:',
    '      read-only:',
    '        sandbox: read-only',
    '        approval: ask',
    '    extraKnob: true',
    '',
  ].join('\n'));
  assert.notEqual(run(customKey, '--restore-inherit').status, 0, '含未知 config 键必须拒绝代删');
  assert.match(patchOf(customKey), /extraKnob: true/u, '原内容一字不动');
  // defaultPreset 取值在四档宇宙外。
  const customDefault = makeHome(patchText('    defaultPreset: my-tier'));
  assert.notEqual(run(customDefault, '--restore-inherit').status, 0, '默认档取值未知必须拒绝代删');
  assert.match(patchOf(customDefault), /defaultPreset: my-tier/u);
});

test('--restore-inherit：幂等——行不存在时零 diff、exit 0', () => {
  const home = makeHome('# clean\n[]\n');
  assert.equal(run(home, '--restore-inherit').status, 0);
  assert.equal(patchOf(home), '# clean\n[]\n', '零动作零 diff');
  // 含其他行但无 permission 覆盖时同样零 diff。
  const noPermission = [
    '# test profile patch',
    '- id: webserver',
    "  name: '@deepseek-ai/dsh-host-webserver'",
    '',
  ].join('\n');
  const home2 = makeHome(noPermission);
  assert.equal(run(home2, '--restore-inherit').status, 0, '无覆盖行＝无需动作（幂等）');
  assert.equal(patchOf(home2), noPermission, '零 diff');
});
