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
/** 离线（宿主包不可解析）时本文件不注册任何用例，避免把「跳过」当成「通过」。 */
const testHost = bridge === undefined ? test.skip : test;

/**
 * 组装一个不经 Cordis 容器的服务实例：只借用原型方法，注入最小依赖。
 * 这样单测覆盖的是端点逻辑本身（`getState` / `setSessionModel` / `pendingState` / `presetCatalog`），
 * 不依赖宿主的 Service 基类与网关。
 * @param {object} [options] - 选项。
 * @returns {object} 服务实例替身。
 */
function service(options = {}) {
  const proto = bridge.ApproveForMeService.prototype;
  const snapshot = { value: options.config ?? { reviewer: { model: 'zai/glm-5.3', effort: 'low' }, trigger: { presets: ['auto-approve'], unknown: 'skip' } } };
  const writes = [];
  const audits = [];
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
  return {
    ctx: { get: (name) => (name === 'permissionPresets' ? options.service : undefined) },
    deps: { settingsSnapshot: () => snapshot, sessionStore: store, pending: options.pending, audit: (fields) => audits.push(fields) },
    writes,
    audits,
    choiceOf: bridge.createSessionChoiceReader(store),
    config: proto.config,
    permissionPresetsService: proto.permissionPresetsService,
    pendingState: proto.pendingState,
    presetCatalog: proto.presetCatalog,
    sessionOf: () => options.session,
    getState: proto.getState,
    setSessionModel: proto.setSessionModel,
  };
}

testHost('getState：活会话命中接管名单时 active=true 且带 preset', () => {
  const instance = service({
    session: { id: 's1' },
    service: { current: () => 'auto-approve', defaultPreset: 'workspace-write' },
  });
  const state = instance.getState('s1');
  assert.equal(state.found, true);
  assert.equal(state.preset, 'auto-approve');
  assert.equal(state.active, true);
});

testHost('getState：非接管预设下 active=false', () => {
  const instance = service({
    session: { id: 's1' },
    service: { current: () => 'workspace-write', defaultPreset: 'workspace-write' },
  });
  assert.equal(instance.getState('s1').active, false);
  assert.equal(instance.getState('s1').preset, 'workspace-write');
});

testHost('getState：非活会话用 defaultPreset 判定，控件在会话开始前也能显隐（R15）', () => {
  const instance = service({
    session: undefined,
    service: { current: () => 'auto-approve', defaultPreset: 'auto-approve' },
  });
  const state = instance.getState('s1');
  assert.equal(state.found, false);
  assert.equal(state.preset, 'auto-approve');
  assert.equal(state.active, true);
});

testHost('getState：服务缺失时按 trigger.unknown 折算（skip → 不接管）', () => {
  const instance = service({ session: { id: 's1' }, service: undefined });
  const state = instance.getState('s1');
  assert.equal(state.preset, null);
  assert.equal(state.active, false);
});

testHost('getState：trigger.unknown=review 且服务缺失时视为接管', () => {
  const instance = service({
    session: { id: 's1' },
    service: undefined,
    config: { reviewer: {}, trigger: { presets: ['auto-approve'], unknown: 'review' } },
  });
  assert.equal(instance.getState('s1').active, true);
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

testHost('setSessionModel（R14）：会话在宿主里不存在时仍按传入 id 落盘', () => {
  const instance = service({ session: undefined });
  assert.deepEqual(instance.setSessionModel('s-not-live', 'zai/glm-5.3', 'max'), { ok: true });
  assert.deepEqual(instance.writes, [{ id: 's-not-live', model: 'zai/glm-5.3', effort: 'max' }]);
});

testHost('setSessionModel（R14）：活会话用会话对象自己的 id 落盘', () => {
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

testHost('getState（R14）：非活会话也读得到已落盘的选择，层级为 session', () => {
  const instance = service({
    session: undefined,
    stored: { s1: { model: 'zai/glm-5.3', effort: 'max' } },
    service: { current: () => 'auto-approve', defaultPreset: 'auto-approve' },
  });
  const state = instance.getState('s1');
  assert.equal(state.found, false);
  assert.equal(state.sessionModel, 'zai/glm-5.3');
  assert.equal(state.sessionEffort, 'max');
  assert.equal(state.effective, 'zai/glm-5.3');
  assert.equal(state.layer, 'session');
});

testHost('getState（R14）：清除条目后回落全局层，而不是仍报 session', () => {
  const instance = service({
    session: undefined,
    stored: { s1: { model: null, effort: '' } },
    service: { current: () => 'auto-approve', defaultPreset: 'auto-approve' },
  });
  const state = instance.getState('s1');
  assert.equal(state.sessionModel, null);
  assert.equal(state.layer, 'global');
  assert.equal(state.effective, 'zai/glm-5.3');
});
