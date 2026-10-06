import assert from 'node:assert/strict';
import test from 'node:test';
import { createScheduler } from '../lib/scheduler.js';

/** 可手动放行的任务。 */
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 等一次宏任务，让调度器推进队列。 */
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('全局并发上限：超出上限的任务排队等待', async () => {
  const scheduler = createScheduler({ max: 1, queueMax: 4, queueTimeoutMs: 1000 });
  const first = deferred();
  const started = [];
  const runA = scheduler.run({ sessionId: 'a', callId: '1' }, async () => {
    started.push('a');
    return first.promise;
  });
  const runB = scheduler.run({ sessionId: 'b', callId: '2' }, async () => {
    started.push('b');
    return 'b';
  });
  await tick();
  assert.deepEqual(started, ['a']);
  assert.equal(scheduler.state().queued, 1);
  first.resolve('a');
  assert.deepEqual(await runA, { ok: true, value: 'a' });
  assert.deepEqual(await runB, { ok: true, value: 'b' });
  assert.deepEqual(started, ['a', 'b']);
});

test('同一会话串行 1：第二个任务排队', async () => {
  const scheduler = createScheduler({ max: 2, queueMax: 4, queueTimeoutMs: 1000 });
  const first = deferred();
  const started = [];
  const runA = scheduler.run({ sessionId: 's', callId: '1' }, async () => {
    started.push('1');
    return first.promise;
  });
  const runB = scheduler.run({ sessionId: 's', callId: '2' }, async () => {
    started.push('2');
    return '2';
  });
  await tick();
  assert.deepEqual(started, ['1']);
  first.resolve('1');
  await runA;
  await runB;
  assert.deepEqual(started, ['1', '2']);
});

test('排队上限与排队超时都按拒绝处理', async () => {
  const overflow = createScheduler({ max: 1, queueMax: 1, queueTimeoutMs: 1000 });
  const hold = deferred();
  const running = overflow.run({ sessionId: 'a', callId: '1' }, () => hold.promise);
  const queued = overflow.run({ sessionId: 'b', callId: '2' }, async () => 'b');
  const rejected = await overflow.run({ sessionId: 'c', callId: '3' }, async () => 'c');
  assert.deepEqual(rejected, { ok: false, reason: 'queue-overflow' });
  hold.resolve('a');
  await running;
  await queued;

  const timeout = createScheduler({ max: 1, queueMax: 4, queueTimeoutMs: 10 });
  const slow = deferred();
  const runningSlow = timeout.run({ sessionId: 'a', callId: '1' }, () => slow.promise);
  const timedOut = await timeout.run({ sessionId: 'b', callId: '2' }, async () => 'b');
  assert.deepEqual(timedOut, { ok: false, reason: 'queue-timeout' });
  slow.resolve('a');
  await runningSlow;
});

test('同一 (sessionId, callId) 去重：在飞共享结果，完成后按 TTL 复用', async () => {
  let calls = 0;
  const scheduler = createScheduler({ max: 2, dedupeTtlMs: 1000 });
  const task = async () => {
    calls += 1;
    return { decision: 'allow' };
  };
  const [a, b] = await Promise.all([
    scheduler.run({ sessionId: 's', callId: 'c1' }, task),
    scheduler.run({ sessionId: 's', callId: 'c1' }, task),
  ]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
  const again = await scheduler.run({ sessionId: 's', callId: 'c1' }, task);
  assert.deepEqual(again.value, { decision: 'allow' });
  assert.equal(calls, 1, 'TTL 内应复用已完成结果');
});

test('去重窗口过期后重新执行', async () => {
  let clock = 0;
  let calls = 0;
  const scheduler = createScheduler({ max: 1, dedupeTtlMs: 100, now: () => clock });
  const task = async () => {
    calls += 1;
    return calls;
  };
  await scheduler.run({ sessionId: 's', callId: 'c1' }, task);
  clock = 500;
  const second = await scheduler.run({ sessionId: 's', callId: 'c1' }, task);
  assert.equal(second.value, 2);
});

test('熔断：连续拒绝达到阈值后打开，冷却后恢复', async () => {
  let clock = 0;
  const scheduler = createScheduler({
    max: 1,
    breaker: { consecutiveDenials: 2, windowSize: 10, windowDenials: 5, cooldownMs: 100 },
    now: () => clock,
  });
  scheduler.record('deny');
  scheduler.record('deny');
  assert.equal(scheduler.state().breakerOpen, true);
  const blocked = await scheduler.run({ sessionId: 's', callId: 'c1' }, async () => 'x');
  assert.deepEqual(blocked, { ok: false, reason: 'breaker-open' });

  clock = 200;
  assert.equal(scheduler.state().breakerOpen, false);
  const allowed = await scheduler.run({ sessionId: 's', callId: 'c2' }, async () => 'x');
  assert.deepEqual(allowed, { ok: true, value: 'x' });
});

test('allow 清零连续计数；error 与 deny 同权计数（R48 口径改写）', () => {
  const scheduler = createScheduler({ breaker: { consecutiveDenials: 2, windowSize: 10, windowDenials: 5 } });
  scheduler.record('deny');
  scheduler.record('allow');
  // R48：error 计入 consecutive 与 window（旧口径「失败不计入」已废止）。
  scheduler.record('error');
  assert.equal(scheduler.state().consecutive, 1);
  assert.equal(scheduler.state().breakerOpen, false);
  // 变异对照：record 对 error 继续早退时 consecutive 停在 0，下一断言红。
  scheduler.record('error');
  assert.equal(scheduler.state().breakerOpen, true, 'error 连发达阈值同样打开熔断');
});

test('任务抛错收敛为失败结果，许可仍被释放', async () => {
  const scheduler = createScheduler({ max: 1 });
  const failed = await scheduler.run({ sessionId: 's', callId: 'c1' }, async () => {
    throw new Error('boom');
  });
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /boom/);
  assert.equal(scheduler.state().inFlight, 0);
});

// ── R31：去重键塌缩与失败缓存 ─────────────────────────────────────────────

test('R31① 缺 callId 不共享：同会话两个无 callId 请求各自执行', async () => {
  let calls = 0;
  const scheduler = createScheduler({ max: 4, dedupeTtlMs: 60000 });
  const task = async () => {
    calls += 1;
    return calls;
  };
  const [a, b] = await Promise.all([
    scheduler.run({ sessionId: 's' }, task),
    scheduler.run({ sessionId: 's' }, task),
  ]);
  // 变异对照：键塌缩回 `会话:-` 时两请求共享同一结果（calls=1、值相等）。
  assert.equal(calls, 2, '缺 callId 的并发请求必须各自执行');
  assert.notEqual(a.value, b.value);
});

test('R31② 失败不入 TTL 缓存：queue-timeout 后同 callId 重发重新执行', async () => {
  let calls = 0;
  const scheduler = createScheduler({ max: 1, queueMax: 4, queueTimeoutMs: 10 });
  const hold = deferred();
  const running = scheduler.run({ sessionId: 'a', callId: '1' }, () => hold.promise);
  const failed = await scheduler.run({ sessionId: 'b', callId: '2' }, async () => {
    calls += 1;
    return 'never';
  });
  assert.equal(failed.ok, false, '占满时应按 queue-timeout 拒绝');
  hold.resolve('a');
  await running;
  // 变异对照：失败仍入缓存时，TTL 窗口内的重发直接复用失败结果（calls 保持 0）。
  const retried = await scheduler.run({ sessionId: 'b', callId: '2' }, async () => {
    calls += 1;
    return 'ok';
  });
  assert.deepEqual(retried, { ok: true, value: 'ok' });
  assert.equal(calls, 1, '失败结果不得缓存，重发必须重新执行');
});

test('R31③ dedupe 缓存有界：超过 256 条后最旧淘汰，最新键仍可复用', async () => {
  const scheduler = createScheduler({ max: 1, dedupeTtlMs: 60000 });
  for (let index = 0; index < 2000; index += 1) {
    await scheduler.run({ sessionId: 's', callId: `c${index}` }, async () => index);
  }
  assert.ok(scheduler.state().dedupeSize <= 256, `dedupe 尺寸必须有界：${scheduler.state().dedupeSize}`);
  // 最新键仍在缓存：复用、不执行（变异对照：去掉容量淘汰 → 尺寸 2000，本断言不红但上一条红）。
  let calls = 0;
  const again = await scheduler.run({ sessionId: 's', callId: 'c1999' }, async () => {
    calls += 1;
    return 'again';
  });
  assert.deepEqual(again, { ok: true, value: 1999 });
  assert.equal(calls, 0, '最新键仍应命中缓存');
});

// ── R48：error 计入熔断窗口 ────────────────────────────────────────────────

test('R48-①调度器层 连续 error 达 consecutiveDenials → 熔断打开，冷却后恢复', async () => {
  let clock = 0;
  const scheduler = createScheduler({
    breaker: { consecutiveDenials: 3, windowSize: 10, windowDenials: 5, cooldownMs: 100 },
    now: () => clock,
  });
  scheduler.record('error');
  scheduler.record('error');
  assert.equal(scheduler.state().breakerOpen, false, '两次 error 未达阈值');
  scheduler.record('error');
  assert.equal(scheduler.state().breakerOpen, true, '第三次 error 打开熔断（与 deny 同权）');
  const blocked = await scheduler.run({ sessionId: 's', callId: 'c1' }, async () => 'x');
  assert.deepEqual(blocked, { ok: false, reason: 'breaker-open' }, '熔断打开后零任务执行');
  clock = 200;
  assert.equal(scheduler.state().breakerOpen, false, '冷却结束自动关闭并清空计数');
});

test('R48② 清零语义保持：error、error、allow、error、error → 未打开', () => {
  const scheduler = createScheduler({ breaker: { consecutiveDenials: 3, windowSize: 10, windowDenials: 5 } });
  scheduler.record('error');
  scheduler.record('error');
  scheduler.record('allow');
  scheduler.record('error');
  scheduler.record('error');
  // allow 清零 consecutive：后两次 error 只累计到 2，未达 3；窗口内拒绝计数 4 < 5 也不触发。
  assert.equal(scheduler.state().consecutive, 2);
  assert.equal(scheduler.state().breakerOpen, false, 'allow 清零语义在 error 计数口径下保持');
});

test('R48④ queue-overflow 不是审查结论：计数不变', () => {
  const scheduler = createScheduler({ breaker: { consecutiveDenials: 3, windowSize: 10, windowDenials: 5 } });
  // 调度失败若误入 record（并发高峰≠通道故障），这里立即红。
  scheduler.record('queue-overflow');
  scheduler.record('queue-timeout');
  scheduler.record('breaker-open');
  assert.equal(scheduler.state().consecutive, 0);
  assert.equal(scheduler.state().breakerOpen, false);
});
