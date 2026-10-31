import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { normalizeDeclaration, admissionFromPackage, deriveLine, admits, loadAdmission } from '../tools/host-admission.mjs';

/**
 * 共享归一模块的固定正反例（design §10.4；需求 1.3 的正反例验证要求）。
 * 归一只管语法（裸精确形），「单一 RC 线」语义由 deriveLine 承担——分层断言。
 */

const SET = '0.2.1-rc.1 || 0.2.1-rc.2 || 0.2.1-rc.3 || 0.2.1-rc.4 || 0.2.1-rc.5';

test('归一：合法声明按 || 拆分去空白，返回字面量成员集合（不冻结顺序与空白）', () => {
  for (const declaration of [SET, '  0.2.1-rc.5||0.2.1-rc.1 ||0.2.1-rc.3||0.2.1-rc.2|| 0.2.1-rc.4 ']) {
    const result = normalizeDeclaration(declaration, '测试位置');
    assert.ok(result.ok, result.ok ? '' : result.error);
    assert.deepEqual([...result.versions].sort(), ['0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4', '0.2.1-rc.5']);
  }
});

test('归一：声明缺席与非字符串报「未声明任何版本」', () => {
  for (const value of [undefined, null, 42, {}]) {
    const result = normalizeDeclaration(value, '测试位置');
    assert.ok(!result.ok);
    assert.equal(result.error, '测试位置 未声明任何版本');
  }
});

test('归一：非法段逐形态报错——前导 v、操作符/范围、构建元数据、空段、前导零（主段与预发布数字段）', () => {
  for (const declaration of [
    'v0.2.1-rc.2',
    '^0.2.1-rc.2',
    '>=0.2.1-rc.2',
    '~4.0.4 || 0.2.1-rc.2',
    '0.2.1-rc.2+build.1',
    '0.2.1-rc.2 ||',
    '|| 0.2.1-rc.2',
    '0.2.1-rc.2 || || 0.2.1-rc.3',
    '1.x',
    '*',
    '0.2.1 - 0.2.5',
    '0.2.01',
    '0.2.1-rc.02',
    '0.2.1-02',
  ]) {
    const result = normalizeDeclaration(declaration, '测试位置');
    assert.ok(!result.ok, `声明「${declaration}」应判非法`);
    assert.match(result.error, /含非精确版本段/u);
  }
  // 含字母或连字符的预发布标识符不受前导零限制（semver 字面规则）。
  assert.ok(normalizeDeclaration('0.2.1-rc.2a', '测试位置').ok);
  assert.ok(normalizeDeclaration('0.2.1-alpha', '测试位置').ok);
});

test('归一：空字符串与全空白的拆分空段同样按非法段计，不静默丢弃', () => {
  for (const declaration of ['', '   ', ' || ']) {
    const result = normalizeDeclaration(declaration, '测试位置');
    assert.ok(!result.ok);
    assert.match(result.error, /含非精确版本段「」/u);
  }
});

test('三处一致：一处缺席、一处集合不同都报可定位差异，不取并集', () => {
  const base = { engines: { dsh: SET }, peerDependencies: { '@deepseek-ai/dsh-llm': SET, '@deepseek-ai/dsh-typert-protocol': SET } };
  assert.ok(admissionFromPackage(base).ok);
  const missing = structuredClone(base);
  delete missing.peerDependencies['@deepseek-ai/dsh-typert-protocol'];
  assert.equal(admissionFromPackage(missing).errors[0], 'peerDependencies.@deepseek-ai/dsh-typert-protocol 未声明任何版本');
  const diverged = structuredClone(base);
  diverged.engines.dsh = '0.2.1-rc.1 || 0.2.1-rc.2 || 0.2.1-rc.3 || 0.2.1-rc.4 || 0.2.1-rc.5 || 0.2.1-rc.6';
  const divergedResult = admissionFromPackage(diverged);
  assert.ok(!divergedResult.ok);
  assert.match(divergedResult.errors.join('；'), /仅 engines\.dsh 有 0\.2\.1-rc\.6/u);
  const memberDiverged = structuredClone(base);
  memberDiverged.peerDependencies['@deepseek-ai/dsh-llm'] = '0.2.1-rc.1 || 0.2.1-rc.2 || 0.2.1-rc.3 || 0.2.1-rc.4 || 0.2.1-rc.6';
  assert.ok(!admissionFromPackage(memberDiverged).ok);
});

test('线导出：单一 RC 线给出线主版本；混线、混通道、正式版本成员都拒绝', () => {
  assert.deepEqual(deriveLine(['0.2.1-rc.2', '0.2.1-rc.5']), { ok: true, line: '0.2.1' });
  for (const members of [
    ['0.2.1-rc.2', '0.2.2-rc.1'],
    ['0.2.1-rc.2', '0.2.1-alpha.5'],
    ['0.2.1-rc.2', '0.2.1'],
    ['0.2.1'],
  ]) {
    const result = deriveLine(members);
    assert.ok(!result.ok, `${members.join('、')} 应判非单一 RC 线`);
    assert.match(result.error, /不是单一 RC 线/u);
  }
});

test('准入判定（需求 1.3 正反例）：集合成员逐个满足；排除清单逐个不满足', () => {
  const admission = loadAdmission();
  assert.ok(admission.ok, admission.ok ? '' : admission.errors.join('；'));
  const { members } = admission;
  for (const member of members) {
    assert.equal(admits(members, member), true, `集合成员 ${member} 必须满足准入`);
  }
  const excluded = [
    '0.2.1', '0.2.0', '0.2.2', '0.2.2-alpha.2',
    '0.2.1-alpha.1', '0.2.1-alpha.5', '0.2.1-beta.1',
    '0.2.1-rc.0', '0.2.1-rc.6', '0.2.1-rc.10',
    '0.2.0-rc.2', '0.3.0', '0.2.1-rc',
  ];
  for (const version of excluded) {
    assert.equal(admits(members, version), false, `排除版本 ${version} 必须不满足准入`);
  }
});

test('当前仓库声明：三处一致、成员为 rc.1–rc.5、线主版本 0.2.1（与 package.json 同步）', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const admission = admissionFromPackage(pkg);
  assert.ok(admission.ok, admission.ok ? '' : admission.errors.join('；'));
  assert.deepEqual(admission.members, ['0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4', '0.2.1-rc.5']);
  assert.deepEqual(deriveLine(admission.members), { ok: true, line: '0.2.1' });
});
