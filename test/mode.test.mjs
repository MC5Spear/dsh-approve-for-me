import assert from 'node:assert/strict';
import test from 'node:test';
import { createMode, foldPresetEvent, isActivePreset, presetNameOf, resolveActivation } from '../lib/mode.js';

/**
 * 构造会话快照。
 * @param {object} [options] - 选项。
 * @returns {object} 假 session。
 */
function session(options = {}) {
  const events = [];
  for (const preset of options.presets ?? []) events.push({ type: 'permission/preset', data: { preset } });
  return { id: options.id ?? 's1', snapshotEvents: () => events };
}

/**
 * 构造判定器。
 * @param {object} [options] - 选项。
 * @returns {{mode: Function, audits: object[]}} 句柄。
 */
function harness(options = {}) {
  const audits = [];
  const mode = createMode({
    current: () => options.config ?? { trigger: { presets: ['auto-approve'], unknown: 'skip', auditEverySkip: false } },
    permissionPresets: () => options.service,
    audit: (fields) => audits.push(fields),
  });
  return { mode: mode.mode, gateSkip: mode.gateSkip, audits };
}

const ask = (s) => ({ agent: { session: s } });

test('foldPresetEvent 取最后一个 permission/preset 事件', () => {
  assert.equal(foldPresetEvent(session({ presets: ['workspace-write', 'auto-approve'] })), 'auto-approve');
  assert.equal(foldPresetEvent(session()), undefined);
  assert.equal(foldPresetEvent(undefined), undefined);
});

test('presetNameOf：服务缺失或抛错时返回 undefined', () => {
  assert.equal(presetNameOf(() => undefined, session()), undefined);
  assert.equal(presetNameOf(() => ({ current: () => { throw new Error('no projection'); } }), session()), undefined);
  assert.equal(presetNameOf(() => ({ current: () => 'auto-approve' }), session()), 'auto-approve');
});

test('命中预设：接管并每会话只写一行 review 审计', () => {
  const { mode, audits } = harness({ service: { current: () => 'auto-approve' } });
  assert.equal(mode(ask(session())), 'auto');
  assert.equal(mode(ask(session())), 'auto');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].phase, 'screen');
  assert.equal(audits[0].action, 'review');
  assert.equal(audits[0].source, 'preset');
  assert.equal(audits[0].preset, 'auto-approve');
  assert.equal(audits[0].inject, 'no');
});

test('未命中预设：不接管，同一 (会话, 预设) 只写一行 skip', () => {
  const { mode, audits } = harness({ service: { current: () => 'workspace-write' } });
  assert.equal(mode(ask(session())), 'off');
  assert.equal(mode(ask(session())), 'off');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'skip');
  assert.equal(audits[0].preset, 'workspace-write');
  assert.equal(audits[0].inject, 'no');
});

test('auditEverySkip=true 时逐次写 skip 行', () => {
  const { mode, audits } = harness({
    config: { trigger: { presets: ['auto-approve'], unknown: 'skip', auditEverySkip: true } },
    service: { current: () => 'workspace-write' },
  });
  mode(ask(session()));
  mode(ask(session()));
  assert.equal(audits.length, 2);
});

test('服务缺失时回退折叠 permission/preset 事件', () => {
  const { mode, audits } = harness();
  assert.equal(mode(ask(session({ presets: ['auto-approve'] }))), 'auto');
  assert.equal(audits[0].preset, 'auto-approve');

  const other = harness();
  assert.equal(other.mode(ask(session({ presets: ['read-only'] }))), 'off');
  assert.equal(other.audits[0].preset, 'read-only');
});

test('预设不可判定：默认 skip 不接管，audit preset=unknown-skip', () => {
  const { mode, audits } = harness();
  assert.equal(mode(ask(session())), 'off');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].preset, 'unknown-skip');
  assert.equal(audits[0].source, 'preset');
});

test('预设不可判定且 trigger.unknown=review 时接管，audit preset=unknown-review', () => {
  const { mode, audits } = harness({
    config: { trigger: { presets: ['auto-approve'], unknown: 'review' } },
  });
  assert.equal(mode(ask(session())), 'auto');
  assert.equal(audits[0].preset, 'unknown-review');
  assert.equal(audits[0].action, 'review');
});

test('trigger.unknown 取值非法：按 skip 兜底并写一行 invalid-config', () => {
  const { mode, audits } = harness({
    config: { trigger: { presets: ['auto-approve'], unknown: 'nope' } },
  });
  assert.equal(mode(ask(session())), 'off');
  const invalid = audits.find((entry) => entry.preset === 'invalid-config');
  assert.equal(invalid.source, 'config');
  assert.ok(audits.some((entry) => entry.preset === 'unknown-skip'));
});

test('接管名单为空时不接管', () => {
  const { mode } = harness({ config: { trigger: { presets: [], unknown: 'skip' } }, service: { current: () => 'auto-approve' } });
  assert.equal(mode(ask(session())), 'off');
});

test('isActivePreset：命中名单、未命中、不可判定按 trigger.unknown', () => {
  const trigger = { presets: ['auto-approve'], unknown: 'skip' };
  assert.deepEqual(isActivePreset('auto-approve', trigger), { active: true, unknown: false });
  assert.deepEqual(isActivePreset('workspace-write', trigger), { active: false, unknown: false });
  // 不可判定（undefined / 空串）：skip 不接管，review 视为接管。
  assert.deepEqual(isActivePreset(undefined, trigger), { active: false, unknown: true });
  assert.deepEqual(isActivePreset('', trigger), { active: false, unknown: true });
  assert.equal(isActivePreset(undefined, { ...trigger, unknown: 'review' }).active, true);
  // 名单缺失等价于空名单。
  assert.equal(isActivePreset('auto-approve', { unknown: 'skip' }).active, false);
});

test('resolveActivation：活会话读服务，非活会话回退默认预设', () => {
  const trigger = { presets: ['auto-approve'], unknown: 'skip' };
  const live = resolveActivation(
    { permissionPresets: () => ({ current: () => 'auto-approve', defaultPreset: 'workspace-write' }), trigger },
    session(),
  );
  assert.deepEqual(live, { preset: 'auto-approve', active: true, resolved: true, unknown: false });
  // 非活会话（无 session）：用 defaultPreset，控件在新会话开始前也能判定显隐（R15）。
  const fresh = resolveActivation(
    { permissionPresets: () => ({ current: () => 'auto-approve', defaultPreset: 'auto-approve' }), trigger },
    undefined,
  );
  assert.deepEqual(fresh, { preset: 'auto-approve', active: true, resolved: true, unknown: false });
});

test('resolveActivation：服务缺失/投影未注册时按 trigger.unknown 折算', () => {
  const unknownSkip = resolveActivation(
    { permissionPresets: () => undefined, trigger: { presets: ['auto-approve'], unknown: 'skip' } },
    session(),
  );
  assert.deepEqual(unknownSkip, { preset: null, active: false, resolved: false, unknown: true });
  const unknownReview = resolveActivation(
    { permissionPresets: () => undefined, trigger: { presets: ['auto-approve'], unknown: 'review' } },
    session(),
  );
  assert.equal(unknownReview.active, true);
  assert.equal(unknownReview.resolved, false);
});

test('resolveActivation：服务读不到时用事件折叠兜底，而不是直接判「不接管」', () => {
  const result = resolveActivation(
    { permissionPresets: () => ({ defaultPreset: 'workspace-write' }), trigger: { presets: ['auto-approve'], unknown: 'skip' } },
    session({ presets: ['auto-approve'] }),
  );
  assert.deepEqual(result, { preset: 'auto-approve', active: true, resolved: true, unknown: false });
});

test('resolveActivation：连 defaultPreset 都取不到时 resolved=false 且会话对象仍报预设', () => {
  const result = resolveActivation(
    {
      permissionPresets: () => ({ current: () => { throw new Error('no projection'); } }),
      trigger: { presets: ['auto-approve'], unknown: 'skip' },
    },
    session(),
  );
  assert.equal(result.preset, null);
  assert.equal(result.resolved, false);
  assert.equal(result.active, false);
});

// ── R40：gate 跳过路径的审计去重通道 ─────────────────────────────────────

test('R40 gateSkip：同 (会话, 因) 首行放行，异因/异会话照常', () => {
  const { gateSkip } = harness();
  assert.equal(gateSkip('s1', 'why-a'), true);
  assert.equal(gateSkip('s1', 'why-a'), false, '同因第二行应被去重');
  assert.equal(gateSkip('s1', 'why-b'), true, '不同因是新行');
  assert.equal(gateSkip('s2', 'why-a'), true, '不同会话是新行');
  // 未知会话 id（'-'）也走同一通道，不抛错。
  assert.equal(typeof gateSkip('-', 'mode=off'), 'boolean');
});

test('R40 gateSkip：auditEverySkip=true 时全量放行', () => {
  const { gateSkip } = harness({
    config: { trigger: { presets: ['auto-approve'], unknown: 'skip', auditEverySkip: true } },
  });
  assert.equal(gateSkip('s1', 'w'), true);
  assert.equal(gateSkip('s1', 'w'), true, '全量口径下不去重');
});

test('R40 gateSkip 容量：超过 1000 个键后最旧淘汰', () => {
  const { gateSkip } = harness();
  gateSkip('k0', 'w');
  for (let index = 1; index <= 1000; index += 1) gateSkip(`k${index}`, 'w');
  assert.equal(gateSkip('k0', 'w'), true, '最旧键已淘汰，再问＝新行（变异：去掉淘汰 → false）');
  // 再问 k0 会重新登记并淘汰此时最旧的 k1；k2 起仍在记忆中。
  assert.equal(gateSkip('k2', 'w'), false, 'k2 仍在记忆中');
});

// ── R41：mode 登记集的容量上限 ──────────────────────────────────────────

test('R41 mode 登记集容量：skipWritten / reviewWritten 超 1000 会话淘汰最旧', () => {
  const skip = harness({ service: { current: () => 'workspace-write' } });
  for (let index = 0; index < 1001; index += 1) skip.mode(ask(session({ id: `s${index}` })));
  assert.equal(skip.audits.length, 1001, '每个新会话各写一行 skip');
  skip.mode(ask(session({ id: 's0' })));
  assert.equal(skip.audits.length, 1002, 's0 已被淘汰，再来＝新一行（变异：去掉淘汰 → 仍 1001）');

  const review = harness({ service: { current: () => 'auto-approve' } });
  for (let index = 0; index < 1001; index += 1) review.mode(ask(session({ id: `s${index}` })));
  assert.equal(review.audits.length, 1001);
  review.mode(ask(session({ id: 's0' })));
  assert.equal(review.audits.length, 1002, 'reviewWritten 同口径淘汰');
});
