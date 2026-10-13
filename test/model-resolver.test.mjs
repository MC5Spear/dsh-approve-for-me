import assert from 'node:assert/strict';
import test from 'node:test';
import { createResolver, normalizeModelChoice, parentModelOf, parseModelRef, pickEffort } from '../lib/model-resolver.js';
import { SESSION_MODEL_EVENT, sessionModelOf } from '../lib/session-model.js';

/**
 * 构造会话快照。
 * @param {object} [options] - 选项。
 * @returns {object} 假 session。
 */
function session(options = {}) {
  const events = [];
  if (options.parent !== undefined) events.push({ type: 'model/selection', data: options.parent });
  if (options.sessionModel !== undefined) {
    events.push({ type: SESSION_MODEL_EVENT, data: { model: options.sessionModel } });
  }
  return { header: { cwd: options.cwd ?? 'C:\\work\\proj' }, snapshotEvents: () => events };
}

/**
 * 构造解析器与调用计数。
 * @param {object} [options] - 选项。
 * @returns {{resolver: object, calls: object[], audits: object[]}} 测试句柄。
 */
function harness(options = {}) {
  const calls = [];
  const audits = [];
  const known = options.known ?? ['deepseek-official/deepseek-v4-flash', 'deepseek-official/deepseek-v4-pro', 'zai/glm-5.3'];
  const llm = {
    listProviders: () => (options.providers ?? [{ id: 'deepseek-official' }, { id: 'zai' }]),
    resolveModelInfo: async (provider, model) => {
      calls.push(`${provider}/${model}`);
      if (!known.includes(`${provider}/${model}`)) throw new Error('unknown model');
      return { reasoning: { efforts: options.efforts ?? [{ id: 'low' }, { id: 'high' }] } };
    },
  };
  const resolver = createResolver({
    llm,
    settingsSnapshot: () => options.snapshot ?? { revision: 1, value: {}, base: {}, user: {} },
    sessionModelOf,
    audit: (fields) => audits.push(fields),
  });
  return { resolver, calls, audits };
}

test('parseModelRef 解析 provider/model，无斜杠时用回退 provider', () => {
  assert.deepEqual(parseModelRef('zai/glm-5.3', undefined), { provider: 'zai', model: 'glm-5.3' });
  assert.deepEqual(parseModelRef('glm-5.3', 'zai'), { provider: 'zai', model: 'glm-5.3' });
  assert.equal(parseModelRef('glm-5.3', undefined), undefined);
  assert.equal(parseModelRef('  ', 'zai'), undefined);
});

test('parentModelOf 折叠最后一个 model/selection 事件', () => {
  assert.deepEqual(parentModelOf(session({ parent: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })), {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
  });
  assert.equal(parentModelOf(session()), undefined);
  assert.equal(parentModelOf(undefined), undefined);
});

test('sessionModelOf 折叠会话级选择与清除语义', () => {
  assert.deepEqual(sessionModelOf(session({ sessionModel: 'zai/glm-5.3' })), { kind: 'set', model: 'zai/glm-5.3', effort: '' });
  const events = [
    { type: SESSION_MODEL_EVENT, data: { model: 'zai/glm-5.3' } },
    { type: SESSION_MODEL_EVENT, data: { model: null } },
  ];
  assert.deepEqual(sessionModelOf({ snapshotEvents: () => events }), { kind: 'clear' });
  assert.equal(sessionModelOf(session()), undefined);
  assert.equal(sessionModelOf(undefined), undefined);
});

test('层级 1：会话级选择优先于全局级各项', async () => {
  const { resolver } = harness({
    snapshot: {
      revision: 1,
      value: { reviewer: { byParentModel: { 'deepseek-v4-flash': 'zai/glm-5.3' }, model: 'deepseek-official/deepseek-v4-pro', followParent: true } },
      base: {},
      user: {},
    },
  });
  const cfg = await resolver.configFor({
    agent: { session: session({ parent: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, sessionModel: 'deepseek-official/deepseek-v4-pro' }) },
  });
  assert.equal(cfg.resolution.layer, 'session');
  assert.equal(cfg.resolution.model, 'deepseek-v4-pro');
});

test('层级 1 清除：写 {model:null} 后回落到全局级', async () => {
  const { resolver } = harness({
    snapshot: { revision: 1, value: { reviewer: { model: 'zai/glm-5.3' } }, base: {}, user: {} },
  });
  const events = [
    { type: SESSION_MODEL_EVENT, data: { model: 'deepseek-official/deepseek-v4-pro' } },
    { type: SESSION_MODEL_EVENT, data: { model: null } },
  ];
  const cfg = await resolver.configFor({ agent: { session: { snapshotEvents: () => events } } });
  assert.equal(cfg.resolution.layer, 'global');
  assert.equal(cfg.resolution.model, 'glm-5.3');
});

test('层级 2：按主模型映射命中', async () => {
  const { resolver } = harness({
    snapshot: { revision: 1, value: { reviewer: { byParentModel: { 'deepseek-v4-flash': 'zai/glm-5.3' } } }, base: {}, user: {} },
  });
  const cfg = await resolver.configFor({ agent: { session: session({ parent: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }) } });
  assert.equal(cfg.resolution.layer, 'parent-map');
  assert.equal(cfg.resolution.provider, 'zai');
});

test('层级 3：全局默认先于跟随父模型', async () => {
  const { resolver } = harness({
    snapshot: { revision: 1, value: { reviewer: { model: 'deepseek-official/deepseek-v4-pro', followParent: true } }, base: {}, user: {} },
  });
  const cfg = await resolver.configFor({ agent: { session: session({ parent: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }) } });
  assert.equal(cfg.resolution.layer, 'global');
  assert.equal(cfg.resolution.model, 'deepseek-v4-pro');
});

test('层级 4：前三层都未配置时跟随父模型', async () => {
  const { resolver } = harness({
    snapshot: { revision: 1, value: { reviewer: { followParent: true } }, base: {}, user: {} },
  });
  const cfg = await resolver.configFor({ agent: { session: session({ parent: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }) } });
  assert.equal(cfg.resolution.layer, 'follow-parent');
  assert.equal(cfg.resolution.model, 'deepseek-v4-flash');
});

test('followParent=false 且前三层都未配置 → unavailable', async () => {
  const { resolver, audits } = harness({
    snapshot: { revision: 1, value: { reviewer: { followParent: false } }, base: {}, user: {} },
  });
  const cfg = await resolver.configFor({ agent: { session: session({ parent: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }) } });
  assert.equal(cfg.resolution.layer, 'unavailable');
  assert.equal(audits[audits.length - 1].degraded, 'all');
});

test('非法值逐层降级并留审计，最终命中可用层', async () => {
  const { resolver, calls, audits } = harness({
    snapshot: { revision: 2, value: { reviewer: { model: 'ghost/nope' } }, base: {}, user: {} },
  });
  const cfg = await resolver.configFor({ agent: { session: session() } });
  assert.equal(cfg.resolution.layer, 'unavailable');
  assert.deepEqual(calls, []);
  // 审计的 degraded 与返回值同源，必须带层名前缀（design §6.2 逐层校验留原因／§8.2 词汇表）。
  const degrade = audits.find((entry) => entry.degraded === 'global:unknown provider ghost');
  assert.equal(degrade.layer, 'global');
  // 所有层都失败时，返回值的标记是聚合值 `all`；逐层原因在审计行里（每层一行）。
  assert.equal(cfg.resolution.degraded, 'all');
  assert.match(String(audits[audits.length - 1].reason), /global:unknown provider ghost/u);
});

test('全部层失败：layer=unavailable 且审计 degraded=all', async () => {
  const { resolver, audits } = harness({
    snapshot: { revision: 3, value: { reviewer: { model: 'ghost/nope2' } }, base: {}, user: {} },
  });
  const cfg = await resolver.configFor({ agent: { session: session() } });
  assert.equal(cfg.resolution.layer, 'unavailable');
  assert.equal(cfg.resolution.effort, 'none');
  const last = audits[audits.length - 1];
  assert.equal(last.layer, 'unavailable');
  assert.equal(last.degraded, 'all');
});

test('模型不支持 low 档时降级为不传并记 effort=none', async () => {
  const { resolver } = harness({
    snapshot: { revision: 4, value: { reviewer: { model: 'zai/glm-5.3' } }, base: {}, user: {} },
    efforts: [{ id: 'high' }],
  });
  const cfg = await resolver.configFor({ agent: { session: session() } });
  assert.equal(cfg.resolution.effort, 'none');
});

test('显式档位受支持时原样生效', async () => {
  const { resolver } = harness({
    snapshot: { revision: 6, value: { reviewer: { model: { model: 'zai/glm-5.3', effort: 'high' } } }, base: {}, user: {} },
  });
  const cfg = await resolver.configFor({ agent: { session: session() } });
  assert.equal(cfg.resolution.effort, 'high');
});

test('未指定档位时按 codex 规则：支持 low 就用 low', async () => {
  const { resolver } = harness({
    snapshot: { revision: 7, value: { reviewer: { model: 'zai/glm-5.3' } }, base: {}, user: {} },
  });
  const cfg = await resolver.configFor({ agent: { session: session() } });
  assert.equal(cfg.resolution.effort, 'low');
});

test('显式档位不被支持时不传并记 degraded（带层名前缀，design §8.2）', async () => {
  const { resolver, audits } = harness({
    efforts: [{ id: 'high' }],
    snapshot: { revision: 8, value: { reviewer: { model: { model: 'zai/glm-5.3', effort: 'low' } } }, base: {}, user: {} },
  });
  const cfg = await resolver.configFor({ agent: { session: session() } });
  assert.equal(cfg.resolution.effort, 'none');
  assert.match(String(cfg.resolution.degraded), /^global:effort=low unsupported$/u);
  assert.ok(
    audits.some((entry) => entry.degraded === 'global:effort=low unsupported'),
    '审计行的 degraded 必须带层名前缀',
  );
});

test('normalizeModelChoice：字符串 / 对象 / 空值 / 非字符串非对象（requirements §5.1）', () => {
  assert.deepEqual(normalizeModelChoice(' zai/glm-5.3 '), { model: 'zai/glm-5.3', effort: '' });
  assert.deepEqual(normalizeModelChoice({ model: ' zai/glm-5.3 ', effort: ' high ' }), { model: 'zai/glm-5.3', effort: 'high' });
  assert.deepEqual(normalizeModelChoice({ model: 'zai/glm-5.3' }), { model: 'zai/glm-5.3', effort: '' });
  assert.equal(normalizeModelChoice(''), undefined);
  assert.equal(normalizeModelChoice('   '), undefined);
  assert.equal(normalizeModelChoice({}), undefined);
  assert.equal(normalizeModelChoice({ model: '   ', effort: 'high' }), undefined);
  assert.equal(normalizeModelChoice({ model: 42 }), undefined);
  assert.equal(normalizeModelChoice(null), undefined);
  assert.equal(normalizeModelChoice(undefined), undefined);
  assert.equal(normalizeModelChoice(['zai/glm-5.3']), undefined);
  assert.equal(normalizeModelChoice(7), undefined);
});

test('pickEffort：显式支持用显式、显式不支持记降级、缺省按 codex 取 low（requirements §5.1）', () => {
  assert.deepEqual(pickEffort([{ id: 'low' }, { id: 'high' }], 'high'), { effort: 'high', degraded: false });
  assert.deepEqual(pickEffort([{ id: 'low' }], 'high'), { effort: 'none', degraded: true });
  assert.deepEqual(pickEffort([{ id: 'low' }, { id: 'high' }], ''), { effort: 'low', degraded: false });
  assert.deepEqual(pickEffort([{ id: 'high' }], ''), { effort: 'none', degraded: false });
  assert.deepEqual(pickEffort(undefined, ''), { effort: 'none', degraded: false });
  assert.deepEqual(pickEffort(undefined, 'low'), { effort: 'none', degraded: true });
});

test('按主模型映射支持对象写法（带档位）', async () => {
  const { resolver } = harness({
    snapshot: {
      revision: 9,
      value: { reviewer: { byParentModel: { 'deepseek-v4-flash': { model: 'zai/glm-5.3', effort: 'high' } } } },
      base: {},
      user: {},
    },
  });
  const cfg = await resolver.configFor({ agent: { session: session({ parent: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }) } });
  assert.equal(cfg.resolution.layer, 'parent-map');
  assert.equal(cfg.resolution.effort, 'high');
});

test('会话级档位随会话级选择优先', async () => {
  const { resolver } = harness({
    snapshot: { revision: 10, value: { reviewer: { model: { model: 'zai/glm-5.3', effort: 'low' } } }, base: {}, user: {} },
  });
  const events = [{ type: SESSION_MODEL_EVENT, data: { model: 'deepseek-official/deepseek-v4-pro', effort: 'high' } }];
  const cfg = await resolver.configFor({ agent: { session: { snapshotEvents: () => events } } });
  assert.equal(cfg.resolution.layer, 'session');
  assert.equal(cfg.resolution.effort, 'high');
});

test('缓存命中、会话级值参与 key、失效后重算', async () => {
  const { resolver, calls } = harness({
    snapshot: { revision: 5, value: { reviewer: { model: 'zai/glm-5.3' } }, base: {}, user: {} },
  });
  const plain = { agent: { session: session() } };
  await resolver.configFor(plain);
  await resolver.configFor(plain);
  assert.equal(calls.length, 1);
  assert.equal(resolver.cacheSize(), 1);

  // 会话级选择进入缓存 key：同一会话切模型后立即生效（design §6.2）。
  const chosen = { agent: { session: session({ sessionModel: 'deepseek-official/deepseek-v4-pro' }) } };
  const cfg = await resolver.configFor(chosen);
  assert.equal(cfg.resolution.layer, 'session');
  assert.equal(calls.length, 2);

  resolver.invalidate();
  assert.equal(resolver.cacheSize(), 0);
  await resolver.configFor(plain);
  assert.equal(calls.length, 3);
});

test('层级 2 命中映射后不再看全局默认', async () => {
  const { resolver } = harness({
    snapshot: {
      revision: 1,
      value: { reviewer: { byParentModel: { 'deepseek-v4-flash': 'zai/glm-5.3' } }, model: 'deepseek-official/deepseek-v4-pro' },
      base: {},
      user: {},
    },
  });
  const cfg = await resolver.configFor({ agent: { session: session({ parent: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }) } });
  assert.equal(cfg.resolution.layer, 'parent-map');
});



