import assert from 'node:assert/strict';
import test from 'node:test';
import { createPendingState } from '../lib/pending-state.js';

/** 固定时钟，便于断言 `updatedAt`。 */
const fixedNow = () => 1_700_000_000_000;

test('写入-读回：一条记录带状态、理由与时限', () => {
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
  pending.set('s1', { callId: 'c2', state: 'denied', reason: 'r' });
  pending.set('s2', { callId: 'c9', state: 'reviewing' });
  assert.deepEqual(pending.list('s1').map((entry) => entry.callId), ['c1', 'c2']);
  assert.deepEqual(pending.list('s2').map((entry) => entry.callId), ['c9']);
  pending.set('s1', { callId: 'c1', state: 'timeout' });
  assert.equal(pending.list('s1').find((entry) => entry.callId === 'c1').state, 'timeout');
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
