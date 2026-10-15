import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * 状态服务的端点单测。
 *
 * `lib/bridge.js` 导入 `@deepseek-ai/dsh-typert-protocol`，只有宿主解析环境能加载它；
 * 离线跑 `node --test test/` 时导入失败，本文件整体跳过（与 `test/index.test.mjs` 同一模式）。
 * 需要实跑时：`node --import ./tools/_host-hooks.mjs --test test/bridge.test.mjs`。
 *
 * **只吞「宿主包解析不到」这一种失败**：语法错误、模块内部抛错、被依赖的相对文件缺失都必须让本文件红着，
 * 否则会变成「跳过＝通过」的假绿（`npm run check` 另行兜住 `lib/**` 的语法）。
 * @returns {Promise<object | undefined>} 模块；宿主包不可解析时为 `undefined`。
 */
async function loadBridge() {
  try {
    return await import('../lib/bridge.js');
  } catch (error) {
    const message = String(error?.message ?? error);
    const hostPackageMissing = error?.code === 'ERR_MODULE_NOT_FOUND' && message.includes('@deepseek-ai/');
    if (hostPackageMissing) return undefined;
    throw error;
  }
}

const bridge = await loadBridge();
// model-resolver 与 config 都被 bridge.js 传递依赖：bridge 可加载 ⇒ 它们必然可加载；bridge 缺失时本文件已整体跳过。
const resolverModule = bridge === undefined ? undefined : await import('../lib/model-resolver.js');
const configModule = bridge === undefined ? undefined : await import('../lib/config.js');
/** 离线（宿主包不可解析）时本文件不注册任何用例，避免把「跳过」当成「通过」。 */
const testHost = bridge === undefined ? test.skip : test;

/**
 * 组装一个不经 Cordis 容器的服务实例：只借用原型方法，注入最小依赖。
 * 这样单测覆盖的是端点逻辑本身（`getState` / `setSessionModel` / `pendingState` / `presetCatalog`），
 * 不依赖宿主的 Service 基类与网关。
 * `getState` 与审批共用模型选择（design §6.2）：替身注入同一份 llm 目录；`options.resolver`
 * 传入真实 `createResolver` 产物以验证缓存复用，缺省时走无缓存的直接选择。
 * @param {object} [options] - 选项。
 * @returns {object} 服务实例替身。
 */
function service(options = {}) {
  const proto = bridge.ApproveForMeService.prototype;
  const snapshot = { revision: options.revision ?? 1, value: options.config ?? { reviewer: { model: 'zai/glm-5.3', effort: 'low' }, trigger: { presets: ['auto-approve'], unknown: 'skip' } } };
  const writes = [];
  const audits = [];
  const known = options.known ?? ['zai/glm-5.3', 'zai/glm-5.3-flash', 'deepseek-official/deepseek-v4-pro', 'deepseek-official/deepseek-v4-flash'];
  const llm =
    options.llm ??
    {
      listProviders: () => (options.providers ?? [{ id: 'zai' }, { id: 'deepseek-official' }, { id: 'openrouter' }]),
      resolveModelInfo: async (provider, model) => {
        if (!known.includes(`${provider}/${model}`)) throw new Error('unknown model');
        return { reasoning: { efforts: options.efforts ?? [{ id: 'low' }, { id: 'high' }] } };
      },
    };
  // 文件载体替身：`read(id)` 回放已写条目，`write(id, model, effort)` 记录并返回是否成功。
  const rows = new Map(Object.entries(options.stored ?? {}));
  const store = options.store ?? {
    read: (id) => rows.get(id),
    write: (id, model, effort) => {
      if (options.writeFails === true) return false;
      writes.push({ id, model, effort });
      rows.set(id, { model, effort });
      return true;
    },
  };
  // 快照读取口可注入（默认回放静态 value）：真实配置栈用例传经 normalizeConfig 现算的读取器，
  // 与 lib/index.js 的 settingsSnapshot＝() => ({ revision, value: current() }) 同型。
  const settingsSnapshot = options.settingsSnapshot ?? (() => snapshot);
  const resolver =
    options.resolver ??
    resolverModule.createResolver({ llm, settingsSnapshot, sessionModelOf: bridge.createSessionChoiceReader(store), audit: () => {} });
  return {
    ctx: { get: (name) => (name === 'permissionPresets' ? options.service : undefined), llm },
    deps: { settingsSnapshot, sessionStore: store, pending: options.pending, audit: (fields) => audits.push(fields), traceStore: options.traceStore, llm, resolver },
    writes,
    audits,
    choiceOf: bridge.createSessionChoiceReader(store),
    config: proto.config,
    permissionPresetsService: proto.permissionPresetsService,
    pendingState: proto.pendingState,
    presetCatalog: proto.presetCatalog,
    traceRecords: proto.traceRecords,
    traceRecord: proto.traceRecord,
    sessionOf: () => options.session,
    getState: proto.getState,
    setSessionModel: proto.setSessionModel,
  };
}

testHost('getState：活会话命中接管名单时 active=true 且带 preset', async () => {
  const instance = service({
    session: { id: 's1' },
    service: { current: () => 'auto-approve', defaultPreset: 'workspace-write' },
  });
  const state = await instance.getState('s1');
  assert.equal(state.found, true);
  assert.equal(state.preset, 'auto-approve');
  assert.equal(state.active, true);
});

testHost('getState：非接管预设下 active=false', async () => {
  const instance = service({
    session: { id: 's1' },
    service: { current: () => 'workspace-write', defaultPreset: 'workspace-write' },
  });
  assert.equal((await instance.getState('s1')).active, false);
  assert.equal((await instance.getState('s1')).preset, 'workspace-write');
});

testHost('getState：非活会话用 defaultPreset 判定，控件在会话开始前也能显隐（design §7.3）', async () => {
  const instance = service({
    session: undefined,
    service: { current: () => 'auto-approve', defaultPreset: 'auto-approve' },
  });
  const state = await instance.getState('s1');
  assert.equal(state.found, false);
  assert.equal(state.preset, 'auto-approve');
  assert.equal(state.active, true);
});

testHost('getState：服务缺失时按 trigger.unknown 折算（skip → 不接管）', async () => {
  const instance = service({ session: { id: 's1' }, service: undefined });
  const state = await instance.getState('s1');
  assert.equal(state.preset, null);
  assert.equal(state.active, false);
});

testHost('getState：trigger.unknown=review 且服务缺失时视为接管', async () => {
  const instance = service({
    session: { id: 's1' },
    service: undefined,
    config: { reviewer: {}, trigger: { presets: ['auto-approve'], unknown: 'review' } },
  });
  assert.equal((await instance.getState('s1')).active, true);
});

testHost('pendingState：无登记表或会话无条目时返回空数组，不抛', () => {
  const empty = service({ session: { id: 's1' } });
  assert.deepEqual(empty.pendingState('s1'), { entries: [] });
  const rows = [{ callId: 'c1', state: 'reviewing' }];
  const withRows = service({ session: { id: 's1' }, pending: { list: (id) => (id === 's1' ? rows : []) } });
  assert.deepEqual(withRows.pendingState('s1'), { entries: rows });
  assert.deepEqual(withRows.pendingState('s2'), { entries: [] });
  const throwing = service({ session: { id: 's1' }, pending: { list: () => { throw new Error('boom'); } } });
  assert.deepEqual(throwing.pendingState('s1'), { entries: [] });
});

testHost('presetCatalog：展示名优先、标出默认预设、回显配置里的未知 id', () => {
  const instance = service({
    service: {
      names: ['auto-approve', 'workspace-write'],
      presets: {
        'auto-approve': { name: '自动审批', description: '由审查模型自动决定' },
        'workspace-write': { name: 'workspace-write', description: '' },
      },
      defaultPreset: 'workspace-write',
    },
    config: { reviewer: {}, trigger: { presets: ['auto-approve', 'ghost'], unknown: 'skip' } },
  });
  const catalog = instance.presetCatalog();
  assert.deepEqual(catalog.presets, [
    { id: 'auto-approve', label: '自动审批', description: '由审查模型自动决定', isDefault: false },
    // 宿主没给展示名时回退到 id，而不是空字符串。
    { id: 'workspace-write', label: 'workspace-write', description: '', isDefault: true },
  ]);
  // 配置里存在但目录里没有的 id 照样回显，设置页据此提示。
  assert.deepEqual(catalog.configured, ['auto-approve', 'ghost']);
});

testHost('presetCatalog：服务缺失或抛错时退化为只有配置回显', () => {
  const missing = service({ service: undefined, config: { reviewer: {}, trigger: { presets: ['auto-approve'] } } });
  assert.deepEqual(missing.presetCatalog(), { presets: [], configured: ['auto-approve'] });
  const broken = service({
    service: { get names() { throw new Error('no table'); } },
    config: { reviewer: {}, trigger: { presets: [] } },
  });
  assert.deepEqual(broken.presetCatalog(), { presets: [], configured: [] });
});

testHost('presetCatalog：配置缺省或非数组时 configured 为空', () => {
  const instance = service({ service: undefined, config: { reviewer: {}, trigger: {} } });
  assert.deepEqual(instance.presetCatalog().configured, []);
  const wrongType = service({ service: undefined, config: { reviewer: {}, trigger: { presets: 'auto-approve' } } });
  assert.deepEqual(wrongType.presetCatalog().configured, []);
});

testHost('createSessionChoiceReader：文件条目的 model:null 按清除处理', () => {
  const store = { read: (id) => ({ id, model: null, effort: '' }) };
  // `clear` = 本会话显式清除（继续看全局层）；`undefined` = 本会话根本没写过。
  assert.deepEqual(bridge.createSessionChoiceReader(store)({ id: 's1' }), { kind: 'clear' });
  assert.equal(bridge.createSessionChoiceReader(undefined)({ id: 's1' }), undefined);
  const set = { read: () => ({ model: 'zai/glm-5.3', effort: 'max' }) };
  assert.deepEqual(bridge.createSessionChoiceReader(set)({ id: 's1' }), { kind: 'set', model: 'zai/glm-5.3', effort: 'max' });
});

testHost('setSessionModel（requirements §6.2）：会话在宿主里不存在时仍按传入 id 落盘', () => {
  const instance = service({ session: undefined });
  assert.deepEqual(instance.setSessionModel('s-not-live', 'zai/glm-5.3', 'max'), { ok: true });
  assert.deepEqual(instance.writes, [{ id: 's-not-live', model: 'zai/glm-5.3', effort: 'max' }]);
});

testHost('setSessionModel：活会话用会话对象自己的 id 落盘', () => {
  const instance = service({ session: { id: 's-live' } });
  assert.deepEqual(instance.setSessionModel('s-live', 'zai/glm-5.3', 'high'), { ok: true });
  assert.deepEqual(instance.writes, [{ id: 's-live', model: 'zai/glm-5.3', effort: 'high' }]);
});

testHost('setSessionModel：model=null 写清除条目（含义「跟随全局」）', () => {
  const instance = service({ session: undefined });
  assert.deepEqual(instance.setSessionModel('s1', null, ''), { ok: true });
  assert.deepEqual(instance.writes, [{ id: 's1', model: null, effort: '' }]);
});

testHost('setSessionModel：空引用被拒且不写文件载体（裸模型名按既有回退语义接受）', () => {
  const instance = service({ session: undefined });
  for (const bad of ['', '   ']) {
    const result = instance.setSessionModel('s1', bad, '');
    assert.equal(result.ok, false, `应拒绝 ${JSON.stringify(bad)}`);
    assert.match(result.error, /provider\/model/u);
  }
  assert.deepEqual(instance.writes, []);
});

testHost('setSessionModel：落盘失败时不报成功，并记一行降级审计', () => {
  const instance = service({ session: undefined, writeFails: true });
  const result = instance.setSessionModel('s1', 'zai/glm-5.3', '');
  assert.equal(result.ok, false);
  assert.match(result.error, /写入失败/u);
  assert.deepEqual(instance.writes, []);
  const audit = instance.audits.at(-1);
  assert.equal(audit.degraded, 'session:file-store-failed');
  assert.equal(audit.action, 'skip');
});

testHost('getState：非活会话也读得到已落盘的选择，层级为 session', async () => {
  const instance = service({
    session: undefined,
    stored: { s1: { model: 'zai/glm-5.3', effort: 'max' } },
    service: { current: () => 'auto-approve', defaultPreset: 'auto-approve' },
  });
  const state = await instance.getState('s1');
  assert.equal(state.found, false);
  assert.equal(state.sessionModel, 'zai/glm-5.3');
  assert.equal(state.sessionEffort, 'max');
  assert.equal(state.effective, 'zai/glm-5.3');
  assert.equal(state.layer, 'session');
});

testHost('getState：清除条目后回落全局层，而不是仍报 session', async () => {
  const instance = service({
    session: undefined,
    stored: { s1: { model: null, effort: '' } },
    service: { current: () => 'auto-approve', defaultPreset: 'auto-approve' },
  });
  const state = await instance.getState('s1');
  assert.equal(state.sessionModel, null);
  assert.equal(state.layer, 'global');
  assert.equal(state.effective, 'zai/glm-5.3');
});

// ── 模型选择共享（design §6.2：状态与审批同一逻辑）与 modelIssues（design §7.2.0） ──

testHost('getState 与审批同一选择：映射层精确规则优先于通用规则', async () => {
  const instance = service({
    session: { id: 's1', snapshotEvents: () => [{ type: 'model/selection', data: { provider: 'openrouter', model: 'claude-3' } }] },
    config: {
      reviewer: {
        parentModelRules: [
          { parent: { provider: 'openrouter', model: 'claude-3' }, choice: { model: 'deepseek-official/deepseek-v4-pro', effort: '' } },
          { parent: { provider: null, model: 'claude-3' }, choice: { model: 'zai/glm-5.3', effort: '' } },
        ],
      },
      trigger: { presets: ['auto-approve'], unknown: 'skip' },
    },
  });
  const state = await instance.getState('s1');
  assert.equal(state.layer, 'parent-map');
  assert.equal(state.effective, 'deepseek-official/deepseek-v4-pro');
  // 状态结果不再携带映射字典：映射表经设置页 configForms 读取（design §7.1）。
  assert.equal('byParentModel' in state, false);
});

testHost('getState 通用规则承接：provider 不匹配精确规则时命中通用行', async () => {
  const instance = service({
    session: { id: 's1', snapshotEvents: () => [{ type: 'model/selection', data: { provider: 'zai', model: 'claude-3' } }] },
    config: {
      reviewer: {
        parentModelRules: [
          { parent: { provider: 'openrouter', model: 'claude-3' }, choice: { model: 'deepseek-official/deepseek-v4-pro', effort: '' } },
          { parent: { provider: null, model: 'claude-3' }, choice: { model: 'zai/glm-5.3', effort: '' } },
        ],
      },
      trigger: { presets: ['auto-approve'], unknown: 'skip' },
    },
  });
  const state = await instance.getState('s1');
  assert.equal(state.layer, 'parent-map');
  assert.equal(state.effective, 'zai/glm-5.3');
});

testHost('getState 斜杠 id：父模型 id 含斜杠不切分，按完整纯 id 匹配', async () => {
  const instance = service({
    session: { id: 's1', snapshotEvents: () => [{ type: 'model/selection', data: { provider: 'openrouter', model: 'anthropic/claude-3' } }] },
    config: {
      reviewer: { parentModelRules: [{ parent: { provider: null, model: 'anthropic/claude-3' }, choice: { model: 'zai/glm-5.3', effort: '' } }] },
      trigger: { presets: ['auto-approve'], unknown: 'skip' },
    },
  });
  const state = await instance.getState('s1');
  assert.equal(state.layer, 'parent-map');
  assert.equal(state.effective, 'zai/glm-5.3');
});

testHost('getState 旧配置行为：byParentModel 纯 id 键与全引用键按兼容链读取', async () => {
  const legacy = service({
    session: { id: 's1', snapshotEvents: () => [{ type: 'model/selection', data: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }] },
    config: {
      reviewer: { byParentModel: { 'deepseek-v4-flash': 'zai/glm-5.3' } },
      trigger: { presets: ['auto-approve'], unknown: 'skip' },
    },
  });
  const pure = await legacy.getState('s1');
  assert.equal(pure.layer, 'parent-map');
  assert.equal(pure.effective, 'zai/glm-5.3');

  const refKey = service({
    session: { id: 's1', snapshotEvents: () => [{ type: 'model/selection', data: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } }] },
    config: {
      reviewer: { byParentModel: { 'deepseek-official/deepseek-v4-pro': 'zai/glm-5.3' } },
      trigger: { presets: ['auto-approve'], unknown: 'skip' },
    },
  });
  const aliased = await refKey.getState('s1');
  assert.equal(aliased.layer, 'parent-map');
  assert.equal(aliased.effective, 'zai/glm-5.3');
});

testHost('getState 全局默认未设置时按零值语义跟随父模型（layer=follow-parent）', async () => {
  const instance = service({
    session: { id: 's1', snapshotEvents: () => [{ type: 'model/selection', data: { provider: 'zai', model: 'glm-5.3' } }] },
    config: { reviewer: {}, trigger: { presets: ['auto-approve'], unknown: 'skip' } },
  });
  const state = await instance.getState('s1');
  assert.equal(state.layer, 'follow-parent');
  assert.equal(state.effective, 'zai/glm-5.3');
});

testHost('modelIssues：global 作用域——全局默认不可用给出条目，回退为 unavailable', async () => {
  const instance = service({
    session: undefined,
    config: { reviewer: { model: 'ghost/nope' }, trigger: { presets: ['auto-approve'], unknown: 'skip' } },
  });
  const state = await instance.getState('s1');
  assert.equal(state.layer, 'unavailable');
  assert.equal(state.effective, '');
  assert.equal(state.modelIssues.length, 1);
  const issue = state.modelIssues[0];
  assert.equal(issue.scope, 'global');
  assert.equal(issue.ruleProvider, null);
  assert.equal(issue.ruleModel, '');
  assert.equal(issue.configured, 'ghost/nope');
  assert.match(issue.reason, /unknown provider ghost/u);
  assert.equal(issue.effectiveLayer, 'unavailable');
  assert.equal(issue.effectiveModel, '');
});

testHost('modelIssues：rule 作用域——结构化行与旧字典呈现行按当前生效条件与目标计算', async () => {
  const instance = service({
    session: undefined,
    config: {
      reviewer: {
        model: 'zai/glm-5.3',
        parentModelRules: [
          { parent: { provider: 'openrouter', model: 'claude-3' }, choice: { model: 'ghost/nope', effort: '' } },
          { parent: { provider: null, model: 'chat' }, choice: { model: 'zai/glm-5.3', effort: '' } },
        ],
        byParentModel: { 'anthropic/claude-3': 'ghost/legacy' },
      },
      trigger: { presets: ['auto-approve'], unknown: 'skip' },
    },
  });
  const state = await instance.getState('s1');
  const rows = state.modelIssues.filter((issue) => issue.scope === 'rule');
  assert.equal(rows.length, 2, '结构化坏行与旧字典坏行各一条');
  const structured = rows.find((issue) => issue.ruleProvider === 'openrouter');
  assert.equal(structured.ruleModel, 'claude-3');
  assert.equal(structured.configured, 'ghost/nope');
  assert.match(structured.reason, /unknown provider ghost/u);
  assert.equal(structured.effectiveLayer, 'global', '直退终点是可用的全局默认');
  assert.equal(structured.effectiveModel, 'zai/glm-5.3');
  // 旧字典呈现行按兼容读取条件（任意 provider＋去首斜杠后的完整 id）。
  const legacy = rows.find((issue) => issue.ruleProvider === null && issue.ruleModel === 'claude-3');
  assert.equal(legacy.configured, 'ghost/legacy');
  assert.equal(legacy.effectiveLayer, 'global');
  // 目标可用的行不产生条目。
  assert.equal(rows.some((issue) => issue.configured === 'zai/glm-5.3'), false);
});

testHost('modelIssues：rule 作用域诊断取值随归一——ruleProvider 去首尾空白、ruleModel 按原值透出', async () => {
  const instance = service({
    session: undefined,
    config: {
      reviewer: {
        model: 'zai/glm-5.3',
        parentModelRules: [
          { parent: { provider: ' openrouter ', model: ' claude-3 ' }, choice: { model: 'ghost/nope', effort: '' } },
        ],
      },
      trigger: { presets: ['auto-approve'], unknown: 'skip' },
    },
  });
  const state = await instance.getState('s1');
  const rows = state.modelIssues.filter((issue) => issue.scope === 'rule');
  assert.equal(rows.length, 1, '目录外目标的坏行恰一条');
  const structured = rows[0];
  assert.equal(structured.ruleProvider, 'openrouter', '诊断 provider 值随条件键归一（去首尾空白）');
  assert.equal(structured.ruleModel, ' claude-3 ', '诊断 model 值不经归一、按原值透出');
  assert.equal(structured.configured, 'ghost/nope');
  assert.match(structured.reason, /unknown provider ghost/u);
});

testHost('modelIssues：session 作用域仅会话场景产生；无会话不产生', async () => {
  const withChoice = service({
    session: undefined,
    stored: { s1: { model: 'ghost/nope', effort: '' } },
    config: { reviewer: { model: 'zai/glm-5.3' }, trigger: { presets: ['auto-approve'], unknown: 'skip' } },
  });
  const state = await withChoice.getState('s1');
  const rows = state.modelIssues.filter((issue) => issue.scope === 'session');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].configured, 'ghost/nope');
  assert.equal(rows[0].effectiveLayer, 'global');
  assert.equal(rows[0].effectiveModel, 'zai/glm-5.3');

  const noChoice = service({
    session: undefined,
    config: { reviewer: { model: 'zai/glm-5.3' }, trigger: { presets: ['auto-approve'], unknown: 'skip' } },
  });
  const empty = await noChoice.getState('s1');
  assert.deepEqual(empty.modelIssues, []);
});

testHost('modelIssues：无会话求值且全局默认为空时，rule 条目与空默认条目同屏，生效引用均为空串', async () => {
  const instance = service({
    session: undefined,
    config: {
      reviewer: { parentModelRules: [{ parent: { provider: null, model: 'chat' }, choice: { model: 'ghost/nope', effort: '' } }] },
      trigger: { presets: ['auto-approve'], unknown: 'skip' },
    },
  });
  const state = await instance.getState('s1');
  // 空全局默认（零值语义生效）与规则行不可用级联：两条并存（design §7.2.0）。
  assert.equal(state.modelIssues.length, 2);
  const rule = state.modelIssues.find((issue) => issue.scope === 'rule');
  assert.equal(rule.effectiveLayer, 'follow-parent');
  assert.equal(rule.effectiveModel, '', '无会话值可填时取空串，以层含义呈现');
  const empty = state.modelIssues.find((issue) => issue.scope === 'global');
  assert.equal(empty.configured, '');
  assert.equal(empty.reason, '全局默认审查模型未设置');
  assert.equal(empty.effectiveLayer, 'follow-parent');
  assert.equal(empty.effectiveModel, '', '无会话求值时空默认条目同样取空串');
});

testHost('getState 透传空全局默认条目：真会话填父模型引用，空会话为空串', async () => {
  const live = service({
    session: { id: 's1', snapshotEvents: () => [{ type: 'model/selection', data: { provider: 'zai', model: 'glm-5.3' } }] },
    config: { reviewer: {}, trigger: { presets: ['auto-approve'], unknown: 'skip' } },
  });
  const liveState = await live.getState('s1');
  assert.equal(liveState.layer, 'follow-parent');
  assert.deepEqual(
    liveState.modelIssues,
    [
      {
        scope: 'global',
        ruleProvider: null,
        ruleModel: '',
        configured: '',
        reason: '全局默认审查模型未设置',
        effectiveLayer: 'follow-parent',
        effectiveModel: 'zai/glm-5.3',
      },
    ],
    'composer 真会话求值：空默认条目带父模型引用（客户端按 configured 空串匹配渲染控件附近提示）',
  );

  const bare = service({
    session: undefined,
    config: { reviewer: {}, trigger: { presets: ['auto-approve'], unknown: 'skip' } },
  });
  const bareState = await bare.getState('s1');
  assert.equal(bareState.modelIssues.length, 1);
  assert.equal(bareState.modelIssues[0].effectiveModel, '', '设置页空会话调用：无父模型可填');
});

testHost('modelIssues：级联——规则行不可用且全局默认也不可用时，行条目与顶部条目同时在场', async () => {
  const instance = service({
    session: undefined,
    config: {
      reviewer: {
        model: 'ghost/global',
        parentModelRules: [{ parent: { provider: null, model: 'chat' }, choice: { model: 'ghost/rule', effort: '' } }],
      },
      trigger: { presets: ['auto-approve'], unknown: 'skip' },
    },
  });
  const state = await instance.getState('s1');
  const global = state.modelIssues.find((issue) => issue.scope === 'global');
  const rule = state.modelIssues.find((issue) => issue.scope === 'rule');
  assert.equal(global.configured, 'ghost/global');
  assert.equal(rule.configured, 'ghost/rule');
  assert.equal(rule.effectiveLayer, 'unavailable');
  assert.equal(rule.effectiveModel, '');
});

testHost('getState 经 resolver.selectFor 共享缓存：与审批同一选择逻辑', async () => {
  const shared = service({
    session: { id: 's1', snapshotEvents: () => [{ type: 'model/selection', data: { provider: 'zai', model: 'glm-5.3' } }] },
    config: { reviewer: {}, trigger: { presets: ['auto-approve'], unknown: 'skip' } },
  });
  const state = await shared.getState('s1');
  assert.equal(state.layer, 'follow-parent');
  // 同键第二次查询命中缓存（selectFor 与 configFor 的同一查找表）。
  assert.equal(shared.deps.resolver.cacheSize(), 1);
  const again = await shared.getState('s1');
  assert.equal(again.layer, 'follow-parent');
  assert.equal(shared.deps.resolver.cacheSize(), 1);
});

testHost('getState 遇可见配置错误不抛错：按 unavailable 呈现（审批路径仍按异常结算）', async () => {
  const instance = service({
    session: { id: 's1', snapshotEvents: () => [{ type: 'model/selection', data: { provider: 'zai', model: 'chat' } }] },
    config: {
      reviewer: {
        parentModelRules: [
          { parent: { provider: null, model: 'chat' }, choice: { model: 'zai/glm-5.3', effort: '' } },
          { parent: { provider: '', model: 'chat' }, choice: { model: 'zai/glm-5.3', effort: '' } },
        ],
      },
      trigger: { presets: ['auto-approve'], unknown: 'skip' },
    },
  });
  const state = await instance.getState('s1');
  assert.equal(state.layer, 'unavailable');
  assert.equal(state.effective, '');
});

testHost('getState 快照读取本身抛错不整体抛 RPC：volatile 重复条件经真实 normalizeConfig 呈现不可用', async () => {
  // 真实配置栈：快照值经 normalizeConfig 现算（与 lib/index.js 的 current() 同型）。volatile 层写入
  // 重复条件时读取本身抛错（「重复条件是可见配置错误」）——状态通道按读不到配置呈现，不抛给 RPC。
  const volatile = {
    reviewer: {
      parentModelRules: [
        { parent: { provider: null, model: 'chat' }, choice: { model: 'zai/glm-5.3', effort: '' } },
        { parent: { provider: '', model: 'chat' }, choice: { model: 'zai/glm-5.3', effort: '' } },
      ],
    },
    trigger: { presets: ['auto-approve'], unknown: 'skip' },
  };
  const instance = service({
    session: { id: 's1', snapshotEvents: () => [{ type: 'model/selection', data: { provider: 'zai', model: 'chat' } }] },
    settingsSnapshot: () => ({ revision: 2, value: configModule.normalizeConfig(volatile) }),
  });
  const state = await instance.getState('s1');
  assert.equal(state.layer, 'unavailable', '读不到配置按无可用模型呈现');
  assert.equal(state.effective, '');
  assert.equal(state.modelIssues.length, 1, 'reviewer 降级为空：只发空全局默认条目');
  assert.equal(state.modelIssues[0].configured, '');
});

// ── §8.2/§8.5：traceRecords 合并行与 traceRecord 合并详情 ────────────────────

/** traceStore 替身：预置行 + 降级标记（list 对旧格式行合成 approvalId，与真实存储一致）。 */
function traceStoreOf(rows, degraded = false) {
  return {
    list: () => rows.map((row) => (row.kind === undefined && row.approvalId === undefined ? { ...row, approvalId: row.reviewId } : row)),
    approval: (sessionId, approvalId) => {
      const hit = {};
      for (const row of rows) {
        if (row.approvalId === approvalId || (row.kind === undefined && row.reviewId === approvalId)) {
          if (row.kind === 'settle') hit.settle = { ...row };
          else if (row.kind === 'review') hit.review = { ...row };
          else hit.legacy = { ...row, approvalId: row.reviewId };
        }
      }
      return Object.keys(hit).length > 0 ? hit : null;
    },
    degraded: () => degraded,
  };
}

testHost('traceRecords：同一审批两类记录按 approvalId 合并，旧格式行独立成行，readFailed 透传', () => {
  const instance = service({
    traceStore: traceStoreOf([
      {
        reviewId: 's1:c1:review:ap1',
        kind: 'review',
        approvalId: 'ap1',
        callId: 'c1',
        toolName: 'pwsh',
        origin: 'main',
        escalation: 'danger-full-access',
        startedAt: 1000,
        endedAt: 2500,
        queueMs: 100,
        reviewMs: 1000,
        decision: 'allow',
        model: 'zai/glm-5.3',
        effort: 'low',
        risk: 'low',
        auth: 'high',
        reason: '安全',
        subject: 'npm i',
        truncated: false,
      },
      {
        reviewId: 's1:c1:settle:ap1',
        kind: 'settle',
        approvalId: 'ap1',
        callId: 'c1',
        toolName: 'pwsh',
        origin: 'main',
        startedAt: 1000,
        endedAt: 2900,
        humanWaitMs: 300,
        outcome: 'rejected',
        source: 'human',
        reason: '安全',
        truncated: true,
      },
      { reviewId: 's1:c2:5', callId: 'c2', toolName: 'edit', startedAt: 50, endedAt: 60, decision: 'allowed-once' },
    ]),
  });
  const result = instance.traceRecords('s1');
  assert.equal(result.readFailed, false);
  assert.equal(result.records.length, 2, '两类记录合并成一行，旧格式行独立成行');
  const merged = result.records[0];
  assert.equal(merged.approvalId, 'ap1');
  assert.equal(merged.decision, 'allow', 'decision 在场＝有审查记录');
  assert.equal(merged.outcome, 'rejected', 'outcome 在场＝有结算记录');
  assert.equal(merged.source, 'human');
  assert.equal(merged.startedAt, 1000, '起点取审查记录');
  assert.equal(merged.endedAt, 2900, '终点取结算记录');
  assert.equal(merged.humanWaitMs, 300);
  assert.equal(merged.truncated, true, '任一记录置真即真');
  assert.ok(!('reviewId' in merged), '存储内部字段 reviewId 不进产品投影');
  const legacy = result.records[1];
  assert.equal(legacy.approvalId, 's1:c2:5', '旧格式行合成 approvalId');
  assert.equal(legacy.outcome, null, '旧格式行没有 outcome');
});

testHost('traceRecords：readFailed=true 透传（design §8.3）；traceRecord 按 approvalId 给合并详情', () => {
  const degradedStore = traceStoreOf([], true);
  const degradedInstance = service({ traceStore: degradedStore });
  assert.deepEqual(degradedInstance.traceRecords('s1'), { records: [], readFailed: true });

  const rows = [
    { reviewId: 's1:c1:review:ap1', kind: 'review', approvalId: 'ap1', callId: 'c1', toolName: 'pwsh', origin: 'main', startedAt: 1000, endedAt: 2500, queueMs: 100, reviewMs: 1000, decision: 'error', model: 'zai/glm-5.3', layer: 'session', attempts: 2, evidence: 'EV', probes: 'read_file:ok', configTag: 'a1b2c3d4e5f6', policyTag: 'zh:missing', reason: '审查未执行：queue-overflow', truncated: false },
    { reviewId: 's1:c1:settle:ap1', kind: 'settle', approvalId: 'ap1', callId: 'c1', toolName: 'pwsh', origin: 'subagent', preset: 'auto-approve', startedAt: 1000, endedAt: 2900, outcome: 'rejected', source: 'llm', stage: 'queue', degraded: 'queue-overflow', truncated: false },
  ];
  const instance = service({ traceStore: traceStoreOf(rows) });
  const { record } = instance.traceRecord('s1', 'ap1');
  assert.equal(record.approvalId, 'ap1');
  assert.equal(record.decision, 'error');
  assert.equal(record.outcome, 'rejected');
  // 结算侧独有字段（stage/preset/degraded）从结算记录补入；审查侧（attempts/layer/取证）保留。
  assert.equal(record.stage, 'queue');
  assert.equal(record.preset, 'auto-approve');
  assert.equal(record.degraded, 'queue-overflow');
  assert.equal(record.attempts, 2);
  assert.equal(record.layer, 'session');
  assert.equal(record.evidence, 'EV');
  assert.equal(record.probes, 'read_file:ok');
  assert.equal(record.configTag, 'a1b2c3d4e5f6');
  assert.equal(record.origin, 'main', 'origin 取审查记录（在场优先）');
  assert.deepEqual(instance.traceRecord('s1', 'missing'), { record: null });
});

testHost('traceRecord：旧格式行详情只在场才写补充键——不把 null 塞进 optional 字段（RPC 三处同步）', () => {
  // 旧格式行：无 kind/approvalId，detail schema 的补充字段是 optional（不收 null），
  // 全量投影会让旧记录点开详情必挂 zod 校验。
  const instance = service({
    traceStore: traceStoreOf([
      { reviewId: 's1:c2:5', callId: 'c2', toolName: 'edit', startedAt: 50, endedAt: 60, decision: 'allowed-once', reason: 'r', subject: 'edit a.ts' },
    ]),
  });
  const { record } = instance.traceRecord('s1', 's1:c2:5');
  assert.equal(record.approvalId, 's1:c2:5');
  assert.equal(record.decision, 'allowed-once');
  // 在场的字符串照常透出（reason 与 subject 都是列表字段，null 允许）。
  assert.equal(record.subject, 'edit a.ts');
  // 补充字段（详情 optional 键）一个都不该出现为 null：要么在场、要么键不存在。
  for (const field of ['stage', 'layer', 'attempts', 'preset', 'tools', 'fieldsDefaulted', 'degraded', 'evidence', 'probes', 'configTag', 'policyTag', 'tokens', 'prompt', 'input', 'reasoning', 'output']) {
    if (field in record) assert.notEqual(record[field], null, `旧格式详情的 ${field} 在场时不为 null`);
  }
  assert.equal(record.stage, undefined, '旧格式行不带 stage：键必须缺失而非 null');
  assert.equal(record.evidence, undefined, '旧格式行不带 evidence：键必须缺失而非 null');
  // 新格式详情的对照：结算侧行带 stage，仍按在场写键。
  const rows = [{ reviewId: 's1:c1:settle:ap1', kind: 'settle', approvalId: 'ap1', callId: 'c1', toolName: 'pwsh', origin: 'main', startedAt: 1, endedAt: 2, outcome: 'rejected', source: 'timeout', stage: 'human', truncated: false }];
  const fresh = service({ traceStore: traceStoreOf(rows) });
  const { record: settleOnly } = fresh.traceRecord('s1', 'ap1');
  assert.equal(settleOnly.stage, 'human');
  assert.equal(settleOnly.attempts, undefined, '无审查记录时 attempts 键缺失（非 null）');
});
