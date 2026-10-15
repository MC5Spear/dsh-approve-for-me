import assert from 'node:assert/strict';
import test from 'node:test';
import { collectModelIssues, createResolver, normalizeModelChoice, parentModelOf, parseModelRef, pickEffort } from '../lib/model-resolver.js';
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
    listProviders: () => (options.providers ?? [{ id: 'deepseek-official' }, { id: 'zai' }, { id: 'openrouter' }, { id: 'anthropic' }]),
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

test('parseModelRef 按首斜杠解析 provider，模型 id 内斜杠保留；无斜杠时用回退 provider', () => {
  assert.deepEqual(parseModelRef('zai/glm-5.3', undefined), { provider: 'zai', model: 'glm-5.3' });
  assert.deepEqual(parseModelRef('openrouter/anthropic/claude-3', undefined), { provider: 'openrouter', model: 'anthropic/claude-3' });
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

test('层级 1：会话级选择优先于映射与全局默认', async () => {
  const { resolver } = harness({
    snapshot: {
      revision: 1,
      value: {
        reviewer: {
          byParentModel: { 'deepseek-v4-flash': 'zai/glm-5.3' },
          model: 'deepseek-official/deepseek-v4-pro',
        },
      },
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

test('层级 2：旧字典纯 id 键按通用匹配命中', async () => {
  const { resolver } = harness({
    snapshot: { revision: 1, value: { reviewer: { byParentModel: { 'deepseek-v4-flash': 'zai/glm-5.3' } } }, base: {}, user: {} },
  });
  const cfg = await resolver.configFor({ agent: { session: session({ parent: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }) } });
  assert.equal(cfg.resolution.layer, 'parent-map');
  assert.equal(cfg.resolution.provider, 'zai');
});

test('层级 3：全局默认先于零值语义（follow-parent）', async () => {
  const { resolver } = harness({
    snapshot: { revision: 1, value: { reviewer: { model: 'deepseek-official/deepseek-v4-pro' } }, base: {}, user: {} },
  });
  const cfg = await resolver.configFor({ agent: { session: session({ parent: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }) } });
  assert.equal(cfg.resolution.layer, 'global');
  assert.equal(cfg.resolution.model, 'deepseek-v4-pro');
});

test('全局默认未设置的零值语义：使用执行助手当前模型（layer=follow-parent）', async () => {
  const { resolver } = harness({
    snapshot: { revision: 1, value: { reviewer: {} }, base: {}, user: {} },
  });
  const cfg = await resolver.configFor({ agent: { session: session({ parent: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }) } });
  assert.equal(cfg.resolution.layer, 'follow-parent');
  assert.equal(cfg.resolution.provider, 'deepseek-official');
  assert.equal(cfg.resolution.model, 'deepseek-v4-flash');
});

test('followParent 残留键不参与解析：未声明键不读取，零值语义照常生效', async () => {
  const { resolver } = harness({
    // 残留键以原值出现在快照里（存量配置未迁移的形态）；解析不读取它。
    snapshot: { revision: 1, value: { reviewer: { followParent: false } }, base: {}, user: {} },
  });
  const cfg = await resolver.configFor({ agent: { session: session({ parent: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }) } });
  assert.equal(cfg.resolution.layer, 'follow-parent');
  assert.equal(cfg.resolution.model, 'deepseek-v4-flash');
});

test('零值语义下父模型不可得 → unavailable', async () => {
  const { resolver, audits } = harness({
    snapshot: { revision: 1, value: { reviewer: {} }, base: {}, user: {} },
  });
  const cfg = await resolver.configFor({ agent: { session: session() } });
  assert.equal(cfg.resolution.layer, 'unavailable');
  assert.equal(cfg.resolution.degraded, 'all');
  const last = audits[audits.length - 1];
  assert.equal(last.layer, 'unavailable');
  assert.match(String(last.reason), /follow-parent:parent model unavailable/u);
});

test('零值语义下父模型不可用 → unavailable（不静默选别的模型）', async () => {
  const { resolver } = harness({
    snapshot: { revision: 1, value: { reviewer: {} }, base: {}, user: {} },
  });
  const cfg = await resolver.configFor({ agent: { session: session({ parent: { provider: 'ghost', model: 'nope' } }) } });
  assert.equal(cfg.resolution.layer, 'unavailable');
});

test('已设置全局默认不可用 → unavailable（故障，不退执行助手当前模型）', async () => {
  const { resolver, audits } = harness({
    snapshot: { revision: 2, value: { reviewer: { model: 'ghost/nope' } }, base: {}, user: {} },
  });
  const cfg = await resolver.configFor({ agent: { session: session({ parent: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }) } });
  assert.equal(cfg.resolution.layer, 'unavailable');
  assert.equal(cfg.resolution.effort, 'none');
  // 审计的 degraded 与返回值同源，必须带层名前缀（design §6.2 逐层校验留原因／§8.2 词汇表）。
  const degrade = audits.find((entry) => entry.degraded === 'global:unknown provider ghost');
  assert.equal(degrade.layer, 'global');
  // 直退语义：reason 文案不再出现「降级到下一层」式表述。
  assert.match(String(degrade.reason), /直接使用全局默认/u);
  assert.equal(cfg.resolution.degraded, 'all');
  assert.match(String(audits[audits.length - 1].reason), /global:unknown provider ghost/u);
});

test('会话选择不可用：记录原因后直退全局默认（degraded 带层名前缀）', async () => {
  const { resolver, audits } = harness({
    snapshot: { revision: 3, value: { reviewer: { model: 'zai/glm-5.3' } }, base: {}, user: {} },
  });
  const events = [{ type: SESSION_MODEL_EVENT, data: { model: 'ghost/nope', effort: '' } }];
  const cfg = await resolver.configFor({ agent: { session: { snapshotEvents: () => events } } });
  assert.equal(cfg.resolution.layer, 'global');
  assert.equal(cfg.resolution.model, 'glm-5.3');
  assert.equal(cfg.resolution.degraded, 'session:unknown provider ghost');
  assert.ok(audits.some((entry) => entry.degraded === 'session:unknown provider ghost'), '审计行必须留逐层原因');
});

test('会话选择不可用：跳过映射层直取全局默认（映射规则命中且可用也不参与）', async () => {
  const { resolver, calls, audits } = harness({
    snapshot: {
      revision: 4,
      value: {
        reviewer: {
          parentModelRules: [{ parent: { provider: null, model: 'chat' }, choice: { model: 'zai/glm-5.3', effort: '' } }],
          model: 'deepseek-official/deepseek-v4-pro',
        },
      },
      base: {},
      user: {},
    },
  });
  const cfg = await resolver.configFor({
    agent: { session: session({ parent: { provider: 'zai', model: 'chat' }, sessionModel: 'ghost/nope' }) },
  });
  // 会话层失败后不落入映射层：直退全局默认（requirements §5.1／design §6.2 任一层不可用不逐层回退）。
  assert.equal(cfg.resolution.layer, 'global');
  assert.equal(cfg.resolution.model, 'deepseek-v4-pro');
  assert.equal(cfg.resolution.degraded, 'session:unknown provider ghost');
  // 映射目标可用也不被校验：映射层未参与本次解析。
  assert.equal(calls.includes('zai/glm-5.3'), false);
  assert.ok(audits.some((entry) => entry.degraded === 'session:unknown provider ghost'), 'degraded 保留会话层原因');
  assert.equal(audits.some((entry) => entry.layer === 'parent-map'), false, '映射层不应留任何审计行');
});

// ── 父模型映射规则矩阵（design §6.2／§10.2「模型选择与映射」） ────────────────

test('斜杠 id：parent.model 含斜杠不切分，通用规则按完整纯模型 id 命中', async () => {
  const { resolver } = harness({
    snapshot: {
      revision: 11,
      value: {
        reviewer: {
          parentModelRules: [{ parent: { provider: null, model: 'anthropic/claude-3' }, choice: { model: 'zai/glm-5.3', effort: '' } }],
        },
      },
      base: {},
      user: {},
    },
  });
  const cfg = await resolver.configFor({ agent: { session: session({ parent: { provider: 'openrouter', model: 'anthropic/claude-3' } }) } });
  assert.equal(cfg.resolution.layer, 'parent-map');
  assert.equal(cfg.resolution.provider, 'zai');
  assert.equal(cfg.resolution.model, 'glm-5.3');
});

test('精确规则先于通用规则（同 model 双规则，provider 决定赢家）', async () => {
  const { resolver } = harness({
    snapshot: {
      revision: 12,
      value: {
        reviewer: {
          parentModelRules: [
            { parent: { provider: 'openrouter', model: 'anthropic/claude-3' }, choice: { model: 'zai/glm-5.3', effort: 'high' } },
            { parent: { provider: null, model: 'anthropic/claude-3' }, choice: { model: 'deepseek-official/deepseek-v4-pro', effort: '' } },
          ],
        },
      },
      base: {},
      user: {},
    },
  });
  const cfg = await resolver.configFor({ agent: { session: session({ parent: { provider: 'openrouter', model: 'anthropic/claude-3' } }) } });
  assert.equal(cfg.resolution.layer, 'parent-map');
  assert.equal(cfg.resolution.model, 'glm-5.3');
  assert.equal(cfg.resolution.effort, 'high');
});

test('通用规则在 provider 不匹配任何精确规则时命中', async () => {
  const { resolver } = harness({
    snapshot: {
      revision: 13,
      value: {
        reviewer: {
          parentModelRules: [
            { parent: { provider: 'anthropic', model: 'claude-3' }, choice: { model: 'zai/glm-5.3', effort: '' } },
            { parent: { provider: null, model: 'claude-3' }, choice: { model: 'deepseek-official/deepseek-v4-pro', effort: '' } },
          ],
        },
      },
      base: {},
      user: {},
    },
  });
  const cfg = await resolver.configFor({ agent: { session: session({ parent: { provider: 'openrouter', model: 'claude-3' } }) } });
  assert.equal(cfg.resolution.layer, 'parent-map');
  assert.equal(cfg.resolution.model, 'deepseek-v4-pro');
});

test('双 provider 同 id：两条精确规则各自命中各自的 provider', async () => {
  const { resolver } = harness({
    snapshot: {
      revision: 14,
      value: {
        reviewer: {
          parentModelRules: [
            { parent: { provider: 'deepseek-official', model: 'chat' }, choice: { model: 'zai/glm-5.3', effort: '' } },
            { parent: { provider: 'zai', model: 'chat' }, choice: { model: 'deepseek-official/deepseek-v4-pro', effort: '' } },
          ],
        },
      },
      base: {},
      user: {},
    },
  });
  const first = await resolver.configFor({ agent: { session: session({ parent: { provider: 'deepseek-official', model: 'chat' } }) } });
  assert.equal(first.resolution.model, 'glm-5.3');
  const second = await resolver.configFor({ agent: { session: session({ parent: { provider: 'zai', model: 'chat' } }) } });
  assert.equal(second.resolution.model, 'deepseek-v4-pro');
});

test('普通 id：不含斜杠的规则条件按字面命中', async () => {
  const { resolver } = harness({
    snapshot: {
      revision: 15,
      value: {
        reviewer: { parentModelRules: [{ parent: { provider: 'deepseek-official', model: 'deepseek-chat' }, choice: { model: 'zai/glm-5.3', effort: 'low' } }] },
      },
      base: {},
      user: {},
    },
  });
  const cfg = await resolver.configFor({ agent: { session: session({ parent: { provider: 'deepseek-official', model: 'deepseek-chat' } }) } });
  assert.equal(cfg.resolution.layer, 'parent-map');
  assert.equal(cfg.resolution.effort, 'low');
});

test('旧全引用键：读作去掉首个斜杠后的完整纯模型 id', async () => {
  const { resolver } = harness({
    snapshot: {
      revision: 16,
      value: { reviewer: { byParentModel: { 'openrouter/anthropic/claude-3': 'zai/glm-5.3' } } },
      base: {},
      user: {},
    },
  });
  // 父模型 id 为 `anthropic/claude-3`（模型 id 本身含斜杠）：去首斜杠归一后命中。
  const cfg = await resolver.configFor({ agent: { session: session({ parent: { provider: 'openrouter', model: 'anthropic/claude-3' } }) } });
  assert.equal(cfg.resolution.layer, 'parent-map');
  assert.equal(cfg.resolution.model, 'glm-5.3');
});

test('旧全引用键归一冲突：值一致时可用且与枚举顺序无关', async () => {
  // 两个全引用键去首斜杠后归一到同一通用条件 `claude-3`（按字面都不等于它，只能走归一路径）。
  const orderA = harness({
    snapshot: {
      revision: 17,
      value: { reviewer: { byParentModel: { 'anthropic/claude-3': 'zai/glm-5.3', 'openrouter/claude-3': 'zai/glm-5.3' } } },
      base: {},
      user: {},
    },
  });
  const cfgA = await orderA.resolver.configFor({ agent: { session: session({ parent: { provider: 'openrouter', model: 'claude-3' } }) } });
  const orderB = harness({
    snapshot: {
      revision: 17,
      value: { reviewer: { byParentModel: { 'openrouter/claude-3': 'zai/glm-5.3', 'anthropic/claude-3': 'zai/glm-5.3' } } },
      base: {},
      user: {},
    },
  });
  const cfgB = await orderB.resolver.configFor({ agent: { session: session({ parent: { provider: 'openrouter', model: 'claude-3' } }) } });
  assert.equal(cfgA.resolution.layer, 'parent-map');
  assert.deepEqual([cfgA.resolution.provider, cfgA.resolution.model], [cfgB.resolution.provider, cfgB.resolution.model]);
});

test('旧全引用键归一冲突：值不一致时不用冲突别名，审计留痕并直退全局默认', async () => {
  const { resolver, audits } = harness({
    snapshot: {
      revision: 18,
      value: {
        reviewer: {
          byParentModel: { 'anthropic/claude-3': 'zai/glm-5.3', 'openrouter/claude-3': 'deepseek-official/deepseek-v4-pro' },
          model: 'deepseek-official/deepseek-v4-flash',
        },
      },
      base: {},
      user: {},
    },
  });
  const cfg = await resolver.configFor({ agent: { session: session({ parent: { provider: 'openrouter', model: 'claude-3' } }) } });
  // 映射层按未命中处理：三层序继续全局默认，不选枚举顺序里的任一别名。
  assert.equal(cfg.resolution.layer, 'global');
  assert.equal(cfg.resolution.model, 'deepseek-v4-flash');
  assert.ok(audits.some((entry) => entry.degraded === 'parent-map:legacy-alias-conflict'), '冲突必须在审计留痕');
});

test('坏末段键不猜测恢复：被截断的旧键不当作完整 id 的别名', async () => {
  const { resolver } = harness({
    snapshot: {
      revision: 19,
      value: { reviewer: { byParentModel: { 'claude-3': 'zai/glm-5.3' }, model: 'deepseek-official/deepseek-v4-pro' } },
      base: {},
      user: {},
    },
  });
  // 父模型 id 是 `anthropic/claude-3`；末段键 `claude-3` 与它按字面不等（也不含斜杠、无归一读法），
  // 不猜测把 `claude-3` 恢复成 `anthropic/claude-3`——按未命中继续三层序。
  const cfg = await resolver.configFor({ agent: { session: session({ parent: { provider: 'anthropic', model: 'anthropic/claude-3' } }) } });
  assert.equal(cfg.resolution.layer, 'global');
  assert.equal(cfg.resolution.model, 'deepseek-v4-pro');
});

test('精确目标不可用：直退全局默认，不改试通用规则', async () => {
  const { resolver, calls, audits } = harness({
    snapshot: {
      revision: 20,
      value: {
        reviewer: {
          parentModelRules: [
            { parent: { provider: 'openrouter', model: 'anthropic/claude-3' }, choice: { model: 'ghost/nope', effort: '' } },
            { parent: { provider: null, model: 'anthropic/claude-3' }, choice: { model: 'zai/glm-5.3', effort: '' } },
          ],
          model: 'deepseek-official/deepseek-v4-pro',
        },
      },
      base: {},
      user: {},
    },
  });
  const cfg = await resolver.configFor({ agent: { session: session({ parent: { provider: 'openrouter', model: 'anthropic/claude-3' } }) } });
  assert.equal(cfg.resolution.layer, 'global');
  assert.equal(cfg.resolution.model, 'deepseek-v4-pro');
  assert.equal(cfg.resolution.degraded, 'parent-map:unknown provider ghost');
  // 通用规则的目标（zai/glm-5.3）没有被尝试：层内不改试其他规则。
  assert.equal(calls.includes('zai/glm-5.3'), false);
  assert.ok(audits.some((entry) => entry.layer === 'parent-map'));
});

test('映射层选中后不再看零值语义；规则目标为空串按不可用直退', async () => {
  const { resolver, audits } = harness({
    snapshot: {
      revision: 21,
      value: {
        reviewer: {
          parentModelRules: [{ parent: { provider: null, model: 'chat' }, choice: { model: '', effort: '' } }],
          model: 'zai/glm-5.3',
        },
      },
      base: {},
      user: {},
    },
  });
  const cfg = await resolver.configFor({ agent: { session: session({ parent: { provider: 'zai', model: 'chat' } }) } });
  // 规则已被选中但目标未设置：按候选不可用记录原因并直退全局默认，不试零值语义。
  assert.equal(cfg.resolution.layer, 'global');
  assert.equal(cfg.resolution.model, 'glm-5.3');
  assert.match(String(cfg.resolution.degraded), /parent-map:unparsable model reference/u);
  assert.ok(audits.some((entry) => entry.degraded === 'parent-map:unparsable model reference'));
});

test('同 id 切换 provider 后缓存不串：缓存键含父 provider', async () => {
  const { resolver, calls } = harness({
    snapshot: {
      revision: 22,
      value: {
        reviewer: {
          parentModelRules: [
            { parent: { provider: 'deepseek-official', model: 'chat' }, choice: { model: 'zai/glm-5.3', effort: '' } },
            { parent: { provider: 'zai', model: 'chat' }, choice: { model: 'deepseek-official/deepseek-v4-pro', effort: '' } },
          ],
        },
      },
      base: {},
      user: {},
    },
  });
  const viaDeepseek = await resolver.configFor({ agent: { session: session({ parent: { provider: 'deepseek-official', model: 'chat' } }) } });
  assert.equal(viaDeepseek.resolution.model, 'glm-5.3');
  const viaZai = await resolver.configFor({ agent: { session: session({ parent: { provider: 'zai', model: 'chat' } }) } });
  assert.equal(viaZai.resolution.model, 'deepseek-v4-pro');
  // 回到第一个 provider 仍命中第一条（未被第二条的缓存覆盖）。
  const again = await resolver.configFor({ agent: { session: session({ parent: { provider: 'deepseek-official', model: 'chat' } }) } });
  assert.equal(again.resolution.model, 'glm-5.3');
  assert.equal(calls.filter((entry) => entry === 'zai/glm-5.3').length, 1, '同一候选只校验一次（缓存命中）');
});

test('运行时重复条件：按可见配置错误抛出，不按清单顺序选赢家', async () => {
  const { resolver } = harness({
    snapshot: {
      revision: 23,
      value: {
        reviewer: {
          parentModelRules: [
            { parent: { provider: null, model: 'chat' }, choice: { model: 'zai/glm-5.3', effort: '' } },
            { parent: { provider: null, model: 'chat' }, choice: { model: 'deepseek-official/deepseek-v4-pro', effort: '' } },
          ],
        },
      },
      base: {},
      user: {},
    },
  });
  await assert.rejects(
    () => resolver.configFor({ agent: { session: session({ parent: { provider: 'zai', model: 'chat' } }) } }),
    /重复匹配条件/u,
    '重复条件必须按可见配置错误拒绝结算',
  );
});

test('运行时重复条件：首尾空白对按同一键拒绝（与装载/读取同口径）', async () => {
  const { resolver } = harness({
    snapshot: {
      revision: 90,
      value: {
        reviewer: {
          parentModelRules: [
            { parent: { provider: 'foo', model: 'm' }, choice: { model: 'zai/glm-5.3', effort: '' } },
            { parent: { provider: ' foo ', model: ' m ' }, choice: { model: 'zai/glm-5.3', effort: 'low' } },
          ],
        },
      },
      base: {},
      user: {},
    },
  });
  await assert.rejects(
    () => resolver.configFor({ agent: { session: session({ parent: { provider: 'foo', model: 'm' } }) } }),
    /重复匹配条件/u,
    '空白对必须按可见配置错误拒绝结算',
  );
});

test('匹配语义：条件侧去首尾空白参与比较，精确规则仍优先于在前的通用规则', async () => {
  const { resolver } = harness({
    snapshot: {
      revision: 91,
      value: {
        reviewer: {
          parentModelRules: [
            { parent: { provider: null, model: ' m ' }, choice: { model: 'deepseek-official/deepseek-v4-pro', effort: '' } },
            { parent: { provider: ' foo ', model: ' m ' }, choice: { model: 'zai/glm-5.3', effort: 'low' } },
          ],
        },
      },
      base: {},
      user: {},
    },
  });
  const cfg = await resolver.configFor({ agent: { session: session({ parent: { provider: 'foo', model: 'm' } }) } });
  assert.equal(cfg.resolution.layer, 'parent-map');
  assert.equal(cfg.resolution.model, 'glm-5.3', '条件『 foo 』『 m 』去首尾空白后命中父模型 foo/m');
  assert.equal(cfg.resolution.effort, 'low', '通用规则在前不改变精确优先的层内顺序');
  // 父模型侧按原值参与比较：带空白不参与归一命中，按未命中路径继续。
  const miss = await resolver.configFor({ agent: { session: session({ parent: { provider: 'foo', model: ' m' } }) } });
  assert.notEqual(miss.resolution.layer, 'parent-map', '父模型值带空白不得经归一命中条件');
});

test('新结构规则带档位：choice.effort 随映射生效', async () => {
  const { resolver } = harness({
    snapshot: {
      revision: 24,
      value: {
        reviewer: { parentModelRules: [{ parent: { provider: null, model: 'deepseek-v4-flash' }, choice: { model: 'zai/glm-5.3', effort: 'high' } }] },
      },
      base: {},
      user: {},
    },
  });
  const cfg = await resolver.configFor({ agent: { session: session({ parent: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }) } });
  assert.equal(cfg.resolution.layer, 'parent-map');
  assert.equal(cfg.resolution.effort, 'high');
});

test('新结构在前、旧字典承接：同条件命中按兼容链次序确定性取值', async () => {
  const { resolver } = harness({
    snapshot: {
      revision: 25,
      value: {
        reviewer: {
          parentModelRules: [{ parent: { provider: null, model: 'deepseek-v4-flash' }, choice: { model: 'zai/glm-5.3', effort: '' } }],
          byParentModel: { 'deepseek-v4-flash': 'deepseek-official/deepseek-v4-pro' },
        },
      },
      base: {},
      user: {},
    },
  });
  const cfg = await resolver.configFor({ agent: { session: session({ parent: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }) } });
  assert.equal(cfg.resolution.layer, 'parent-map');
  assert.equal(cfg.resolution.model, 'glm-5.3');
});

// ── 档位与归一（requirements §5.1） ──────────────────────────────────────────

test('模型不支持 low 档时不传档位并记 effort=none', async () => {
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
  assert.match(String(cfg.resolution.degraded), /(^|,)global:effort=low unsupported(,|$)/u);
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

test('会话级档位随会话级选择优先', async () => {
  const { resolver } = harness({
    snapshot: { revision: 10, value: { reviewer: { model: { model: 'zai/glm-5.3', effort: 'low' } } }, base: {}, user: {} },
  });
  const events = [{ type: SESSION_MODEL_EVENT, data: { model: 'deepseek-official/deepseek-v4-pro', effort: 'high' } }];
  const cfg = await resolver.configFor({ agent: { session: { snapshotEvents: () => events } } });
  assert.equal(cfg.resolution.layer, 'session');
  assert.equal(cfg.resolution.effort, 'high');
});

// ── 缓存（design §6.2 有界查找表） ──────────────────────────────────────────

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

test('unavailable 结果不进缓存：故障恢复后下一次解析即重新校验', async () => {
  const { resolver, calls } = harness({
    snapshot: { revision: 26, value: { reviewer: { model: 'ghost/nope' } }, base: {}, user: {} },
  });
  const request = { agent: { session: session() } };
  const first = await resolver.configFor(request);
  assert.equal(first.resolution.layer, 'unavailable');
  assert.equal(resolver.cacheSize(), 0, '故障结果不驻留缓存');
  const second = await resolver.configFor(request);
  assert.equal(second.resolution.layer, 'unavailable');
  assert.equal(calls.length, 0, 'unknown provider 在 provider 表就被拒，未到 resolveModelInfo');
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

// ── 空全局默认提示条目（design §7.2.0／requirements §5.1、§6.1） ────────────────

/**
 * 构造 collectModelIssues 直调的 llm 替身（与 harness 同目录口径）。
 * @param {object} [options] - 选项。
 * @returns {object} llm 替身。
 */
function issuesLlm(options = {}) {
  const known = options.known ?? ['zai/glm-5.3', 'deepseek-official/deepseek-v4-pro'];
  return {
    listProviders: () => (options.providers ?? [{ id: 'zai' }, { id: 'deepseek-official' }]),
    resolveModelInfo: async (provider, model) => {
      if (!known.includes(`${provider}/${model}`)) throw new Error('unknown model');
      return { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } };
    },
  };
}

test('空全局默认条目字段逐项：scope=global、follow-parent 层、reason 定稿、有父模型填引用', async () => {
  const issues = await collectModelIssues({
    llm: issuesLlm(),
    reviewer: {},
    sessionChoice: undefined,
    parent: { provider: 'zai', model: 'glm-5.3' },
  });
  assert.equal(issues.length, 1, '空全局默认只产生一条 global 条目');
  assert.deepEqual(
    issues[0],
    {
      scope: 'global',
      ruleProvider: null,
      ruleModel: '',
      configured: '',
      reason: '全局默认审查模型未设置',
      effectiveLayer: 'follow-parent',
      effectiveModel: 'zai/glm-5.3',
    },
    '空默认条目七字段逐项（reason 为 design §7.2.0 定稿文案）',
  );
});

test('空全局默认条目两态 effectiveModel：无会话父模型时取空串、以层含义呈现', async () => {
  const issues = await collectModelIssues({
    llm: issuesLlm(),
    reviewer: {},
    sessionChoice: undefined,
    parent: undefined,
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].effectiveLayer, 'follow-parent');
  assert.equal(issues[0].effectiveModel, '', '无会话求值无值可填，取空串');
});

test('空全局默认条目不校验父模型可用性：父模型不在目录仍填引用并记 follow-parent', async () => {
  // 状态提示而非故障（design §7.2.0）：父模型已知即填全引用；父模型不可用的故障由解析侧
  // layer='unavailable' 承载，空默认条目不改写层含义（design §10.2 判据锚）。
  const issues = await collectModelIssues({
    llm: issuesLlm(),
    reviewer: {},
    sessionChoice: undefined,
    parent: { provider: 'ghost', model: 'nope' },
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].configured, '');
  assert.equal(issues[0].effectiveLayer, 'follow-parent');
  assert.equal(issues[0].effectiveModel, 'ghost/nope', '父模型已知即填引用，不因不在目录改判 unavailable');
});

test('空全局默认与「已设置但不可用」global 条目互斥（reviewer.model 空与非空二态）', async () => {
  const unset = await collectModelIssues({
    llm: issuesLlm(),
    reviewer: {},
    sessionChoice: undefined,
    parent: { provider: 'zai', model: 'glm-5.3' },
  });
  assert.equal(unset.length, 1);
  assert.equal(unset[0].configured, '', '空态发空默认条目');

  const broken = await collectModelIssues({
    llm: issuesLlm(),
    reviewer: { model: 'ghost/nope' },
    sessionChoice: undefined,
    parent: { provider: 'zai', model: 'glm-5.3' },
  });
  assert.equal(broken.length, 1, '非空态只发不可用条目，不另发空默认条目');
  assert.equal(broken[0].configured, 'ghost/nope');
  assert.equal(broken[0].effectiveLayer, 'unavailable');
});

test('空全局默认级联并存：映射规则不可用退到空默认时，行条目与顶部空默认条目同屏保留', async () => {
  const issues = await collectModelIssues({
    llm: issuesLlm(),
    reviewer: {
      parentModelRules: [{ parent: { provider: null, model: 'chat' }, choice: { model: 'ghost/nope', effort: '' } }],
    },
    sessionChoice: undefined,
    parent: { provider: 'zai', model: 'glm-5.3' },
  });
  const empty = issues.find((issue) => issue.scope === 'global' && issue.configured === '');
  const rule = issues.find((issue) => issue.scope === 'rule');
  assert.ok(empty !== undefined, '空默认条目在场');
  assert.equal(empty.reason, '全局默认审查模型未设置');
  assert.ok(rule !== undefined, '规则行条目在场');
  assert.equal(rule.configured, 'ghost/nope');
  // 级联的直退终点推演不受空默认条目影响：父模型可用 → follow-parent＋引用。
  assert.equal(rule.effectiveLayer, 'follow-parent');
  assert.equal(rule.effectiveModel, 'zai/glm-5.3');
});

test('空全局默认非空不产生：已设置且可用的全局默认不产生任何 global 条目', async () => {
  const issues = await collectModelIssues({
    llm: issuesLlm(),
    reviewer: { model: 'zai/glm-5.3' },
    sessionChoice: undefined,
    parent: { provider: 'zai', model: 'glm-5.3' },
  });
  assert.deepEqual(issues, [], '可用全局默认不产生条目');
});

test('空全局默认不发 session 作用域条目：会话已选择时宿主仍只发这一类', async () => {
  // 会话控件附近的渲染条件（全局默认为空且会话未单独选择）由客户端匹配；
  // 会话已单独选择且可用时，宿主只发空默认 global 条目，不重复发 session 条目。
  const issues = await collectModelIssues({
    llm: issuesLlm(),
    reviewer: {},
    sessionChoice: { kind: 'set', model: 'zai/glm-5.3', effort: '' },
    parent: { provider: 'zai', model: 'glm-5.3' },
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].scope, 'global');
  assert.equal(issues[0].configured, '');
});

test('空目标规则行发 rule 条目：reason 与不可解析目标同族，空值旧键不发', async () => {
  // 空目标（choice.model 空串）命中时选择层按候选不可用直退全局默认（design §6.2）；
  // 诊断推演同口径（design §7.2.0：空目标规则行按不可解析目标同族发 rule 条目）；空目标不判非法草稿，保存不受阻。
  // 空值旧键排在断言条目之前：若空值旧键未被跳过（异常被外层 try 吞掉），条目收集中断、后面的断言变红。
  const issues = await collectModelIssues({
    llm: issuesLlm(),
    reviewer: {
      model: 'zai/glm-5.3',
      parentModelRules: [{ parent: { provider: null, model: 'chat' }, choice: { model: '', effort: '' } }],
      byParentModel: { 'inert-legacy': '', 'legacy-ghost': 'ghost/nope' },
    },
    sessionChoice: undefined,
    parent: { provider: 'zai', model: 'glm-5.3' },
  });
  const rule = issues.find((issue) => issue.scope === 'rule' && issue.ruleModel === 'chat');
  assert.ok(rule !== undefined, '空目标规则行应发 rule 条目');
  assert.equal(rule.ruleProvider, null);
  assert.equal(rule.configured, '', 'configured 保留空目标原文');
  assert.equal(rule.reason, 'unparsable model reference', 'reason 与不可解析目标同一文案');
  assert.equal(rule.effectiveLayer, 'global');
  assert.equal(rule.effectiveModel, 'zai/glm-5.3');
  // 空值旧键之后的条目必须在场：异常若在空值旧键处中断收集，此断言最先变红。
  const trailing = issues.find((issue) => issue.scope === 'rule' && issue.ruleModel === 'legacy-ghost');
  assert.ok(trailing !== undefined, '空值旧键之后的规则行条目必须在场');
  assert.equal(trailing.configured, 'ghost/nope');
  assert.equal(issues.some((issue) => issue.scope === 'rule' && issue.ruleModel === 'inert-legacy'), false, '空值旧键不被任何路径选中，不发条目');
});

test('无会话求值：规则目标为纯 id 且目录可解析时不发 rule 条目（诊断与选择同口径回退 provider）', async () => {
  // 设置页无会话求值：无父模型时缺省 provider 取首个已注册 provider（与 selectReviewerModel 同口径），
  // 纯 id 目标可解析且可用即无条目，不误报「unparsable model reference」。
  const issues = await collectModelIssues({
    llm: issuesLlm(),
    reviewer: {
      model: 'zai/glm-5.3',
      parentModelRules: [{ parent: { provider: null, model: 'chat' }, choice: { model: 'glm-5.3', effort: '' } }],
    },
    sessionChoice: undefined,
    parent: undefined,
  });
  assert.deepEqual(issues, [], '纯 id 目标按首个已注册 provider 解析且可用，无条目');
});

test('无会话求值：目录无已注册 provider 时纯 id 目标仍按不可用发 rule 条目', async () => {
  const issues = await collectModelIssues({
    llm: issuesLlm({ providers: [] }),
    reviewer: {
      model: 'zai/glm-5.3',
      parentModelRules: [{ parent: { provider: null, model: 'chat' }, choice: { model: 'glm-5.3', effort: '' } }],
    },
    sessionChoice: undefined,
    parent: undefined,
  });
  const rule = issues.find((issue) => issue.scope === 'rule');
  assert.ok(rule !== undefined, '无 provider 可回退时纯 id 目标不可解析，仍按不可用发条目');
  assert.equal(rule.reason, 'unparsable model reference');
});
