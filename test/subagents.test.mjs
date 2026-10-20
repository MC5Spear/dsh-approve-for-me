import assert from 'node:assert/strict';
import test from 'node:test';
import { isVolatile } from '@deepseek-ai/cosmokit';
import { Config, normalizeConfig } from '../lib/config.js';
import { createMode } from '../lib/mode.js';
import {
  createSubagentCoverage,
  isDelegated,
  latestPolicyOf,
  rootOf,
} from '../lib/subagents.js';

/**
 * 构造假会话：header（身份字段 parentSession/isSeeded/delegationDepth/origin）、事件流（permission/preset、approval/policy）、append 记录。
 * @param {object} [options] - 选项。
 * @returns {object} 假 session。
 */
function fakeSession(options = {}) {
  const events = [];
  for (const preset of options.presets ?? []) events.push({ type: 'permission/preset', data: { preset } });
  for (const policy of options.policies ?? []) {
    events.push({ type: 'approval/policy', data: policy === undefined ? { policy: 'never', source: 'delegation' } : policy });
  }
  if (options.appendThrows === true) {
    return {
      id: options.id ?? 's1',
      header: options.header ?? {},
      snapshotEvents: () => events,
      append() {
        throw new Error('append denied');
      },
    };
  }
  const appended = [];
  return {
    id: options.id ?? 's1',
    header: options.header ?? {},
    snapshotEvents: () => events,
    appended,
    append(type, data) {
      appended.push({ type, data });
    },
  };
}

/** 三级链：root（无父）← mid ← child；mid/child 用委派子会话的真实身份形态（design §2.2）。 */
function chain(options = {}) {
  const root = fakeSession({ id: 'root', presets: options.rootPresets ?? ['auto-approve'] });
  const mid = fakeSession({
    id: 'mid',
    header: { parentSession: 'root', isSeeded: false, delegationDepth: 1, origin: 'subagent' },
  });
  const child = fakeSession({
    id: 'child',
    header: { parentSession: 'mid', isSeeded: false, delegationDepth: 2, origin: 'subagent' },
    policies: options.childPolicies ?? [undefined],
    appendThrows: options.appendThrows,
  });
  const list = [root, mid, child];
  return { root, mid, child, list };
}

/**
 * 构造覆盖装配。
 * @param {object} [options] - 选项：config、presetsById（服务读到的预设名）、sessions。
 * @returns {object} 句柄（coverage 与 audits）。
 */
function harness(options = {}) {
  const audits = [];
  const presetsById = options.presetsById ?? { root: 'auto-approve' };
  const list = options.list;
  const coverage = createSubagentCoverage({
    current: () => options.config ?? { trigger: { presets: ['auto-approve'], subagents: 'review' } },
    permissionPresets: () => ({ current: (session) => presetsById[session.id] }),
    sessionsOf: () => ({ list: () => list ?? [] }),
    audit: (fields) => audits.push(fields),
  });
  return { coverage, audits };
}

const ask = (session) => ({ agent: { session } });

test('isDelegated：按身份识别（design §2.2）——委派子会话恒 depth≥1，分叉会话为假', () => {
  // 非 seed 委派（depth 1）与 seed 式委派（isSeeded 真＋depth 2）都是委派子会话。
  assert.equal(
    isDelegated(fakeSession({ header: { parentSession: 'root', isSeeded: false, delegationDepth: 1, origin: 'subagent' } })),
    true,
  );
  assert.equal(
    isDelegated(fakeSession({ header: { parentSession: 'root', isSeeded: true, delegationDepth: 2, origin: 'subagent' } })),
    true,
    'seed 式委派 depth≥1，不得因 isSeeded 误判成分叉',
  );
  // 分叉会话：isSeeded 真且 depth 为 0（持久化回读）或缺席（内存新建主用例）。
  assert.equal(
    isDelegated(fakeSession({ header: { parentSession: 'root', isSeeded: true, delegationDepth: 0 } })),
    false,
  );
  assert.equal(
    isDelegated(fakeSession({ header: { parentSession: 'root', isSeeded: true } })),
    false,
    '内存新建分叉会话 delegationDepth 缺席',
  );
  // 非数值 depth 按缺席处理；残余组合按主会话对待。
  assert.equal(
    isDelegated(fakeSession({ header: { parentSession: 'root', isSeeded: true, delegationDepth: '1' } })),
    false,
  );
  assert.equal(isDelegated(fakeSession({ header: { parentSession: 'root' } })), false);
  // 主会话与缺形。
  assert.equal(isDelegated(fakeSession({ header: { isSeeded: false, delegationDepth: 0 } })), false);
  assert.equal(isDelegated(fakeSession()), false);
  assert.equal(isDelegated(undefined), false);
});

test('子代理观察登记容量：超 1000 会话后最旧淘汰（skip 行，design §8.3）', () => {
  const { coverage, audits } = harness({ list: [] });
  // 1001 个互不相干的委派子会话：根不可达 → 各写一行 skip（键 sub|id|-）。
  for (let index = 0; index < 1001; index += 1) {
    coverage.modeOf(
      ask(fakeSession({ id: `s${index}`, header: { parentSession: 'ghost', isSeeded: false, delegationDepth: 1, origin: 'subagent' } })),
    );
  }
  assert.equal(audits.length, 1001, '每个新会话各写一行 skip');
  coverage.modeOf(
    ask(fakeSession({ id: 's0', header: { parentSession: 'ghost', isSeeded: false, delegationDepth: 1, origin: 'subagent' } })),
  );
  assert.equal(audits.length, 1002, 's0 已被淘汰，再来＝新一行（变异：去掉容量淘汰 → 仍 1001）');
});

test('rootOf：多级上溯到根；父不在表内 → undefined；环路 → undefined', () => {
  const { root, mid, child, list } = chain();
  const lookup = (id) => list.find((item) => item.id === id);
  assert.equal(rootOf(child, lookup), root);
  assert.equal(rootOf(root, lookup), root);
  // 父不在活会话表：链断。
  assert.equal(rootOf(child, () => undefined), undefined);
  // 自引用环：安全终止。
  const loop = [{ id: 'a', header: { parentSession: 'a' } }];
  assert.equal(rootOf(loop[0], (id) => loop.find((item) => item.id === id)), undefined);
});

test('latestPolicyOf：取最后一条 approval/policy；无事件 → undefined', () => {
  const s = fakeSession({ policies: [{ policy: 'never', source: 'delegation' }, { policy: 'ask' }] });
  assert.equal(latestPolicyOf(s), 'ask');
  assert.equal(latestPolicyOf(fakeSession()), undefined);
  assert.equal(latestPolicyOf(undefined), undefined);
});

test('onSessionCreated：根预设命中 → 恰好追加一条 {policy:"ask"}，无 source 字段', () => {
  const { child, list } = chain();
  const { coverage, audits } = harness({ list });
  coverage.onSessionCreated(child);
  assert.equal(child.appended.length, 1);
  assert.equal(child.appended[0].type, 'approval/policy');
  assert.deepEqual(child.appended[0].data, { policy: 'ask' });
  const cover = audits.find((entry) => entry.action === 'review');
  assert.equal(cover.preset, 'subagent');
  assert.match(cover.reason, /根会话权限预设「auto-approve」命中/);
});

test('onSessionCreated：幂等——已是 ask 则零追加', () => {
  const { child, list } = chain({ childPolicies: [{ policy: 'never', source: 'delegation' }, { policy: 'ask' }] });
  const { coverage } = harness({ list });
  coverage.onSessionCreated(child);
  assert.equal(child.appended.length, 0);
});

test('onSessionCreated：根预设不在名单 → 零追加 + skip 审计', () => {
  const { child, list } = chain({ rootPresets: ['workspace-write'] });
  const { coverage, audits } = harness({ list, presetsById: { root: 'workspace-write' } });
  coverage.onSessionCreated(child);
  assert.equal(child.appended.length, 0);
  const skip = audits.find((entry) => entry.action === 'skip');
  assert.equal(skip.preset, 'workspace-write');
  assert.match(skip.reason, /不在接管名单内/);
});

test('onSessionCreated：根不可达（父不在表）→ 零追加 + skip 审计', () => {
  const orphan = fakeSession({
    id: 'orphan',
    header: { parentSession: 'gone', isSeeded: false, delegationDepth: 1, origin: 'subagent' },
    policies: [undefined],
  });
  const { coverage, audits } = harness({ list: [orphan] });
  coverage.onSessionCreated(orphan);
  assert.equal(orphan.appended.length, 0);
  const skip = audits.find((entry) => entry.action === 'skip');
  assert.match(skip.reason, /不可达/);
});

test('onSessionCreated：trigger.subagents=skip → 零追加 + skip 审计', () => {
  const { child, list } = chain();
  const { coverage, audits } = harness({
    list,
    config: { trigger: { presets: ['auto-approve'], subagents: 'skip' } },
  });
  coverage.onSessionCreated(child);
  assert.equal(child.appended.length, 0);
  const skip = audits.find((entry) => entry.action === 'skip');
  assert.equal(skip.preset, 'subagent-skip');
});

test('onSessionCreated：append 抛错 → 吞掉并写 error 审计，监听器本身不抛（同步监听器抛错会回滚会话挂载）', () => {
  const { child, list } = chain({ appendThrows: true });
  const { coverage, audits } = harness({ list });
  assert.doesNotThrow(() => coverage.onSessionCreated(child));
  const error = audits.find((entry) => entry.source === 'error');
  assert.match(error.reason, /append denied/);
});

test('onSessionCreated：非委派会话（主会话）→ 不追加、无审计', () => {
  const root = fakeSession({ id: 'root', presets: ['auto-approve'] });
  const { coverage, audits } = harness({ list: [root] });
  coverage.onSessionCreated(root);
  assert.equal(audits.length, 0);
});

test('sweep：对活表里的可覆盖委派会话补翻；主会话、分叉会话与已 ask 会话不动', () => {
  const { child, mid, root, list } = chain({ childPolicies: [undefined] });
  const alreadyAsk = fakeSession({
    id: 'asked',
    header: { parentSession: 'root', isSeeded: false, delegationDepth: 1, origin: 'subagent' },
    policies: [{ policy: 'ask' }],
  });
  const fork = fakeSession({ id: 'forked', header: { parentSession: 'root', isSeeded: true }, policies: [undefined] });
  const full = [root, mid, child, alreadyAsk, fork];
  const { coverage } = harness({ list: full });
  coverage.sweep();
  assert.equal(child.appended.length, 1);
  assert.equal(alreadyAsk.appended.length, 0);
  assert.equal(root.appended.length, 0);
  assert.equal(mid.appended.length, 0);
  assert.equal(fork.appended.length, 0, '分叉会话（isSeeded 真、depth 缺席）不被补翻');
});

test('modeOf：委派 + 根命中 → auto，审计 preset=subagent 每会话一行', () => {
  const { child, list } = chain();
  const { coverage, audits } = harness({ list });
  assert.equal(coverage.modeOf(ask(child)), 'auto');
  assert.equal(coverage.modeOf(ask(child)), 'auto');
  const reviews = audits.filter((entry) => entry.action === 'review');
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].preset, 'subagent');
});

test('modeOf：委派 + subagents=skip / 根不命中 → off', () => {
  const { child, list } = chain();
  const skipAll = harness({ list, config: { trigger: { presets: ['auto-approve'], subagents: 'skip' } } });
  assert.equal(skipAll.coverage.modeOf(ask(child)), 'off');
  const notListed = harness({ list, presetsById: { root: 'workspace-write' } });
  assert.equal(notListed.coverage.modeOf(ask(child)), 'off');
});

test('modeOf：非委派会话 → undefined（落回预设分支）', () => {
  const root = fakeSession({ id: 'root', presets: ['auto-approve'] });
  const { coverage } = harness({ list: [root] });
  assert.equal(coverage.modeOf(ask(root)), undefined);
  assert.equal(coverage.modeOf({}), undefined);
});

test('分叉会话（design §2.2 按主会话对待）：modeOf → undefined、不写子代理审计', () => {
  // 根会话在表且预设命中。若退回仅按 parentSession 判委派，分叉会被误接管，本组断言须红。
  const root = fakeSession({ id: 'root', presets: ['auto-approve'] });
  const list = [root];
  const { coverage, audits } = harness({ list, presetsById: { root: 'auto-approve' } });
  const liveForm = ask(fakeSession({ id: 'fork-live', header: { parentSession: 'root', isSeeded: true }, policies: [undefined] }));
  const reloadedForm = ask(
    fakeSession({ id: 'fork-disk', header: { parentSession: 'root', isSeeded: true, delegationDepth: 0 }, policies: [undefined] }),
  );
  assert.equal(coverage.modeOf(liveForm), undefined, '内存新建分叉（depth 缺席）＝主会话形态');
  assert.equal(coverage.modeOf(reloadedForm), undefined, '持久化回读分叉（depth 0）＝主会话形态');
  assert.equal(audits.length, 0, '分叉会话不得产生子代理 skip/review 审计行');
});

test('分叉会话：onSessionCreated → 不追加审批策略、无审计（人工通道由主会话分支保留）', () => {
  const root = fakeSession({ id: 'root', presets: ['auto-approve'] });
  const fork = fakeSession({
    id: 'forked',
    header: { parentSession: 'root', isSeeded: true },
    policies: [undefined],
  });
  const { coverage, audits } = harness({ list: [root, fork], presetsById: { root: 'auto-approve' } });
  coverage.onSessionCreated(fork);
  assert.equal(fork.appended.length, 0, '分叉会话保持宿主默认审批策略，不翻 ask');
  assert.equal(audits.length, 0);
});

test('分叉会话：presetOf → undefined（按主会话分支取名，不沿根链）', () => {
  const root = fakeSession({ id: 'root', presets: ['auto-approve'] });
  const fork = fakeSession({ id: 'forked', header: { parentSession: 'root', isSeeded: true }, policies: [undefined] });
  const { coverage } = harness({ list: [root, fork], presetsById: { root: 'auto-approve' } });
  assert.equal(coverage.presetOf(ask(fork)), undefined);
});

test('createMode：coverage 先于预设分支；非委派不受影响', () => {
  const audits = [];
  const coverageStub = {
    modeOf(request) {
      if (request?.agent?.session?.id === 'child') return 'auto';
      return undefined;
    },
  };
  const mode = createMode({
    current: () => ({ trigger: { presets: ['auto-approve'], unknown: 'skip' } }),
    permissionPresets: () => ({ current: () => 'workspace-write' }),
    audit: (fields) => audits.push(fields),
    coverage: coverageStub,
  });
  // 委派子会话：coverage 直接接管（即便预设服务报的是 workspace-write）。
  assert.equal(mode.mode(ask({ id: 'child' })), 'auto');
  // 主会话：走原有预设分支（workspace-write → off）。
  assert.equal(mode.mode(ask({ id: 'root' })), 'off');
  // 无 coverage 时行为不变（旧调用形态）。
  const legacy = createMode({
    current: () => ({ trigger: { presets: ['auto-approve'], unknown: 'skip' } }),
    permissionPresets: () => ({ current: () => 'auto-approve' }),
    audit: () => {},
  });
  assert.equal(legacy.mode(ask({ id: 'root' })), 'auto');
});

test('config：trigger.subagents 默认 review；skip 合法；非法值被 schema 拒', () => {
  assert.equal(normalizeConfig({}).trigger.subagents, 'review');
  // raw resolve 的默认值是 volatile 引用（0.1.7 与 0.2.0-rc.2 同版实测维持）
  // ——引用当前值是 review，归一化后解包。
  const rawDefault = Config({}).trigger.subagents;
  assert.equal(isVolatile(rawDefault), true, '默认值应是 volatile 引用（否则锚到的 schemastery <3.18.4）');
  assert.equal(rawDefault.get(), 'review');
  assert.equal(normalizeConfig({ trigger: { subagents: 'skip' } }).trigger.subagents, 'skip');
  assert.throws(() => Config({ trigger: { subagents: 'nope' } }));
});
