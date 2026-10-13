import assert from 'node:assert/strict';
import test from 'node:test';
import { createPendingState, PENDING_STATES, PENDING_CAUSES } from '../lib/pending-state.js';

/** 固定时钟，便于断言 `updatedAt`。 */
const fixedNow = () => 1_700_000_000_000;

test('枚举定稿：状态闭集 reviewing/waiting-human，原因类别闭集 deny/timeout/error（design §7.4）', () => {
  assert.deepEqual(PENDING_STATES, ['reviewing', 'waiting-human']);
  assert.deepEqual(PENDING_CAUSES, ['deny', 'timeout', 'error']);
});

test('写入-读回：一条记录带状态、原因类别、理由与时限', () => {
  const pending = createPendingState({ now: fixedNow });
  pending.set('s1', { callId: 'c1', state: 'reviewing', deadlineAt: 1_700_000_090_000, deadlineKind: 'review' });
  const [entry] = pending.list('s1');
  assert.equal(entry.callId, 'c1');
  assert.equal(entry.state, 'reviewing');
  assert.equal(entry.deadlineKind, 'review');
  assert.equal(entry.startedAt, fixedNow());
  assert.equal(entry.updatedAt, fixedNow());
});

test('同一 callId 覆盖写，不同 callId 并存；会话之间互不可见', () => {
  const pending = createPendingState({ now: fixedNow });
  pending.set('s1', { callId: 'c1', state: 'reviewing' });
  pending.set('s1', { callId: 'c2', state: 'waiting-human', cause: 'deny', reason: 'r' });
  pending.set('s2', { callId: 'c9', state: 'reviewing' });
  assert.deepEqual(pending.list('s1').map((entry) => entry.callId), ['c1', 'c2']);
  assert.deepEqual(pending.list('s2').map((entry) => entry.callId), ['c9']);
  pending.set('s1', { callId: 'c1', state: 'waiting-human', cause: 'timeout' });
  const entry = pending.list('s1').find((item) => item.callId === 'c1');
  assert.equal(entry.state, 'waiting-human');
  assert.equal(entry.cause, 'timeout');
  assert.equal(pending.list('s1').length, 2);
});

test('clear 删除单条；会话桶空了自动移除；重复 clear 不抛', () => {
  const pending = createPendingState({ now: fixedNow });
  pending.set('s1', { callId: 'c1', state: 'reviewing' });
  pending.clear('s1', 'c1');
  assert.deepEqual(pending.list('s1'), []);
  pending.clear('s1', 'c1');
  pending.clear('missing', 'c1');
  assert.deepEqual(pending.list('missing'), []);
});

test('归一化：非法状态按 reviewing，缺时限时 deadlineAt/deadlineKind 为 null', () => {
  const pending = createPendingState({ now: fixedNow });
  pending.set('s1', { callId: 'c1', state: 'nonsense', reason: 42, deadlineAt: Number.NaN, deadlineKind: 'weird' });
  const [entry] = pending.list('s1');
  assert.equal(entry.state, 'reviewing');
  assert.equal(entry.reason, '');
  assert.equal(entry.deadlineAt, null);
  assert.equal(entry.deadlineKind, null);
});

test('cause 透传与归一化：三类合法值原样保留，写错或缺失按 error（design §7.4）', () => {
  const pending = createPendingState({ now: fixedNow });
  for (const cause of PENDING_CAUSES) {
    pending.set('s1', { callId: `ok-${cause}`, state: 'waiting-human', cause });
    assert.equal(pending.list('s1').find((entry) => entry.callId === `ok-${cause}`).cause, cause);
  }
  pending.set('s1', { callId: 'bad', state: 'waiting-human', cause: 'denied' });
  assert.equal(pending.list('s1').find((entry) => entry.callId === 'bad').cause, 'error', "写错值 'denied' 应按 error 归一化");
  pending.set('s1', { callId: 'missing', state: 'waiting-human' });
  assert.equal(pending.list('s1').find((entry) => entry.callId === 'missing').cause, 'error', '缺失 cause 应按 error 归一化');
});

test('非法键不写入：空 sessionId 或空 callId 直接丢弃', () => {
  const pending = createPendingState({ now: fixedNow });
  pending.set('', { callId: 'c1', state: 'reviewing' });
  pending.set('s1', { callId: '', state: 'reviewing' });
  pending.set('s1', undefined);
  assert.deepEqual(pending.list(''), []);
  assert.deepEqual(pending.list('s1'), []);
});

test('到期判定交给客户端：deadlineAt 是绝对时间戳，不改写', () => {
  let clock = 1_000;
  const pending = createPendingState({ now: () => clock });
  pending.set('s1', { callId: 'c1', state: 'reviewing', deadlineAt: 5_000, deadlineKind: 'review' });
  clock = 9_999;
  const [entry] = pending.list('s1');
  assert.equal(entry.deadlineAt, 5_000, '读取不因时钟推进而改动时限');
  assert.equal(entry.updatedAt, 1_000, '读取不改写 updatedAt');
});
