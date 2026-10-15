/**
 * TYPERT 清单一致性测试。
 *
 * 判据单源：rc.1 契约的检查函数住在 `tools/typert-contract.mjs`，本文件与
 * `tools/check-typert-manifest.mjs` 共用同一份——两处各自维护会在离线检查器一侧漂移
 * （按 rc.6 的 `codec.schema` 字段校验会漂出一批假红，故收敛为单源）。
 * 契约依据：`dsh-typert-loader/lib/index.js:153-212`（注册期校验）与
 * `dsh-typert-registry/lib/index.js:509-518`（`create()` 返回值即 schema，须为 zod v4 实例）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TYPERT } from '../typert.host.js';
import { checkCodec, checkInvocation } from '../tools/typert-contract.mjs';

test('TYPERT 清单：顶层形状合规', () => {
  assert.equal(TYPERT.package, 'dsh-approve-for-me');
  assert.equal(TYPERT.face, 'host');
  assert.ok(Array.isArray(TYPERT.schemas), 'schemas 必须是数组');
  assert.ok(Array.isArray(TYPERT.invocations) && TYPERT.invocations.length > 0, 'invocations 必须非空');
});

test('TYPERT 清单：每条 invocation 满足 rc.1 契约（含 create() 工厂）', () => {
  const failures = {};
  for (const invocation of TYPERT.invocations) {
    const found = checkInvocation(invocation);
    if (Object.keys(found).length > 0) failures[invocation.id ?? '<无 id>'] = found;
  }
  assert.deepEqual(failures, {}, `以下端点不合规：${JSON.stringify(failures, null, 2)}`);
});

test('TYPERT 清单：端点 id 唯一且与 service/namespace/method 自洽', () => {
  const ids = TYPERT.invocations.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, 'id 必须唯一');
  for (const item of TYPERT.invocations) {
    assert.equal(item.id, `dsh-approve-for-me#${item.namespace}/${item.method}`, `${item.id} 与 namespace/method 不自洽`);
    assert.equal(item.service, item.namespace, `${item.id} 的 service 与 namespace 不一致`);
  }
});

test('TYPERT 清单：checkCodec 本身能失败（对照，防恒真）', () => {
  // 反面对照：缺 create 的 codec 必须被判不合规——正是装载失败的形状。
  const legacy = { mode: 'strict', typeSymbol: 'x#y', schema: {} };
  assert.deepEqual(checkCodec(legacy), ['create 缺失或不是函数（rc.1 要求 create() 工厂）']);
  assert.ok(checkCodec({ mode: 'strict', typeSymbol: 'x#y', create: () => ({}) }).some((item) => item.includes('_zod')));
  assert.deepEqual(checkCodec({ mode: 'strict', typeSymbol: 'x#y', create: () => ({ _zod: {} }) }), []);
  // 正面：真实清单里的 codec 逐个通过（与上一测试同源，此处示证 checkCodec 不恒真也不恒假）。
  for (const item of TYPERT.invocations) {
    assert.deepEqual(checkCodec(item.result), [], `${item.id} result 应合规`);
  }
});

// ── getState 结果扩展（design §7.1 三处同步／§7.2.0 modelIssues） ─────────────

/** 从清单取 getState 的 invocation。 */
function getStateInvocation() {
  return TYPERT.invocations.find((item) => item.method === 'getState');
}

/** 从服务模型取 getState 的成员声明与 GetStateResult 类型声明。 */
function getStateDeclarations() {
  const serviceModel = TYPERT.model.services.find((entry) => entry.key === 'approveForMe');
  const member = serviceModel.members.find((entry) => entry.name === 'getState');
  const type = serviceModel.types.find((entry) => entry.name === 'GetStateResult');
  const issue = serviceModel.types.find((entry) => entry.name === 'ModelIssue');
  return { member, type, issue };
}

test('getState 结果 schema：modelIssues 七字段不被校验或投影丢失，byParentModel 字段已退役', () => {
  const invocation = getStateInvocation();
  const schema = invocation.result.create();
  const sample = {
    found: true,
    sessionModel: 'zai/glm-5.3',
    sessionEffort: 'low',
    globalDefault: 'zai/glm-5.3',
    globalEffort: '',
    modelIssues: [
      {
        scope: 'rule',
        ruleProvider: null,
        ruleModel: 'anthropic/claude-3',
        configured: 'ghost/nope',
        reason: 'unknown provider ghost',
        effectiveLayer: 'follow-parent',
        effectiveModel: '',
      },
      { scope: 'global', ruleProvider: null, ruleModel: '', configured: 'ghost/x', reason: 'unknown provider ghost', effectiveLayer: 'unavailable', effectiveModel: '' },
    ],
    effective: 'zai/glm-5.3',
    effectiveEffort: 'low',
    layer: 'global',
    preset: null,
    active: true,
    trace: { capture: 'summary', ownView: true, turnSummary: true, legacyRow: false },
  };
  const parsed = schema.parse(sample);
  // 七字段逐个在场：缺任何一处声明都会在校验或投影环节丢失（design §7.1）。
  for (const field of ['scope', 'ruleProvider', 'ruleModel', 'configured', 'reason', 'effectiveLayer', 'effectiveModel']) {
    assert.equal(field in parsed.modelIssues[0], true, `modelIssues.${field} 必须保留`);
  }
  assert.equal(parsed.modelIssues.length, 2);
  // 旧结构字段已从结果 schema 退役。
  assert.equal('byParentModel' in parsed, false);
  assert.equal(JSON.stringify(schema).includes('byParentModel'), false);
  // 缺 modelIssues 的载荷必须被校验拒绝（必填，不是可选扩展）。
  assert.throws(() => schema.parse({ ...sample, modelIssues: undefined }));
});

test('getState 三处同步：类型声明与成员描述都含 modelIssues，不含退役字段', () => {
  const { member, type, issue } = getStateDeclarations();
  assert.match(type.declaration, /modelIssues: \{ scope: string; ruleProvider: string \| null; ruleModel: string; configured: string; reason: string; effectiveLayer: string; effectiveModel: string \}\[\]/u);
  assert.doesNotMatch(type.declaration, /byParentModel/u, 'GetStateResult 类型不得再含退役字段');
  assert.match(issue.declaration, /scope: string; ruleProvider: string \| null; ruleModel: string; configured: string; reason: string; effectiveLayer: string; effectiveModel: string/u);
  // 成员描述：签名改为 Promise（getState 现为异步选择），jsDoc 提及 modelIssues。
  assert.match(member.signature, /Promise<GetStateResult>/u);
  assert.match(member.jsDoc, /modelIssues/u);
  assert.match(member.summary, /diagnostics/u);
});

// ── traceRecord 详情 capture 字段（design §8.2 词汇表／ISS-19 三处同步） ────────

/** 从清单取 traceRecord 的 invocation 与服务模型声明。 */
function getTraceRecordParts() {
  const invocation = TYPERT.invocations.find((item) => item.method === 'traceRecord');
  const serviceModel = TYPERT.model.services.find((entry) => entry.key === 'approveForMe');
  const member = serviceModel.members.find((entry) => entry.name === 'traceRecord');
  const type = serviceModel.types.find((entry) => entry.name === 'TraceRecordResult');
  return { invocation, member, type };
}

test('traceRecord 三处同步：结果 schema、类型声明与成员描述都含 capture 生效标记', () => {
  const { invocation, member, type } = getTraceRecordParts();
  assert.ok(invocation, 'traceRecord invocation 应在清单');
  // ① 结果 schema：capture 为可选字符串，能透传三档值（缺任何一处声明该字段在校验或投影环节丢失）。
  const schema = invocation.result.create();
  const base = {
    record: {
      approvalId: 'a-1', callId: null, toolName: null, origin: null, escalation: null,
      startedAt: 1, endedAt: 2, queueMs: 0, reviewMs: 0, humanWaitMs: null,
      decision: 'rejected', outcome: 'rejected', source: 'llm', model: null, effort: null,
      risk: null, auth: null, reason: '', subject: null, truncated: false,
    },
  };
  for (const tier of ['off', 'summary', 'full']) {
    const parsed = schema.parse({ record: { ...base.record, capture: tier } });
    assert.equal(parsed.record.capture, tier, `capture=${tier} 应通过校验并保留`);
  }
  const without = schema.parse(base);
  assert.equal('capture' in without.record, false, '旧记录无 capture 应照常通过（可选字段）');
  // ② 类型声明串：`capture?: string;` 在 tools 与 degraded 之间。
  assert.match(type.declaration, /tools\?: number; capture\?: string; fieldsDefaulted\?: string;/u, 'TraceRecordResult 类型声明应含 capture（tools 后）');
  // ③ 成员 jsDoc：提及写入时采集档。
  assert.match(member.jsDoc, /capture/u, 'traceRecord 成员 jsDoc 应提及 capture 采集档');
  assert.match(member.jsDoc, /off\/summary\/full/u, 'jsDoc 应写明三档取值与缺省');
});
