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

test('排队上限与排队超时都按拒绝处理；排队超时携带 queueMs 观测', async () => {
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
  // 失败包络只在 queue-timeout 带 queueMs（入口→放弃的实际等待），其他失败不带。
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.reason, 'queue-timeout');
  assert.ok(Number.isFinite(timedOut.queueMs) && timedOut.queueMs >= 0, '排队超时必须携带 queueMs');
  slow.resolve('a');
  await runningSlow;
});

test('同键并发不共享在飞任务——各自排队、各自执行（design §5.1）', async () => {
  let calls = 0;
  const scheduler = createScheduler({ max: 2 });
  const task = async () => {
    calls += 1;
    return { decision: 'allow' };
  };
  const [a, b] = await Promise.all([
    scheduler.run({ sessionId: 's', callId: 'c1' }, task),
    scheduler.run({ sessionId: 's', callId: 'c1' }, task),
  ]);
  assert.deepEqual(a, { ok: true, value: { decision: 'allow' } });
  assert.deepEqual(b, { ok: true, value: { decision: 'allow' } });
  assert.equal(calls, 2, '两次投递都真实执行审查（在飞不共享，design §5.1）');
});

test('任务回调收到 queueMs（入口→许可），排队者测量真实等待', async () => {
  let clock = 0;
  const scheduler = createScheduler({ max: 1, queueTimeoutMs: 10_000, now: () => clock });
  const hold = deferred();
  const seen = [];
  const running = scheduler.run({ sessionId: 'a', callId: '1' }, async (queueMs) => {
    seen.push(queueMs);
    await hold.promise;
    return 'a';
  });
  const queued = scheduler.run({ sessionId: 'b', callId: '2' }, async (queueMs) => {
    seen.push(queueMs);
    return 'b';
  });
  await new Promise((resolve) => setImmediate(resolve));
  clock = 25;
  hold.resolve('x');
  await running;
  await queued;
  assert.equal(seen[0], 0, '首个任务立即取得许可：queueMs=0');
  assert.ok(seen[1] >= 25, `排队任务的 queueMs≥排队时长：${seen[1]}`);
});

test('冷却：连续拒绝达到阈值后打开，冷却期结束后恢复', async () => {
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

test('allow 清零连续计数；error 与 deny 同权计数（requirements §4.4）', () => {
  const scheduler = createScheduler({ breaker: { consecutiveDenials: 2, windowSize: 10, windowDenials: 5 } });
  scheduler.record('deny');
  scheduler.record('allow');
  // error 计入 consecutive 与 window（requirements §4.4：失败与拒绝同权计数）。
  scheduler.record('error');
  assert.equal(scheduler.state().consecutive, 1);
  assert.equal(scheduler.state().breakerOpen, false);
  // 变异对照：record 对 error 继续早退时 consecutive 停在 0，下一断言红。
  scheduler.record('error');
  assert.equal(scheduler.state().breakerOpen, true, 'error 连发达阈值同样打开冷却');
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

// ── 任务不共享与失败不缓存（design §5.1） ────────────────────────────────────

test('缺 callId 不共享：同会话两个无 callId 请求各自执行', async () => {
  let calls = 0;
  const scheduler = createScheduler({ max: 4 });
  const task = async () => {
    calls += 1;
    return calls;
  };
  const [a, b] = await Promise.all([
    scheduler.run({ sessionId: 's' }, task),
    scheduler.run({ sessionId: 's' }, task),
  ]);
  // 变异对照：键若塌缩为 `会话:-` 时两请求会共享同一结果（calls=1、值相等）。
  assert.equal(calls, 2, '缺 callId 的并发请求必须各自执行');
  assert.notEqual(a.value, b.value);
});

test('失败不入 TTL 缓存：queue-timeout 后同 callId 重发重新执行', async () => {
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

test('无 callId 的并发请求各自执行；大批量顺序执行后状态干净', async () => {
  let calls = 0;
  const scheduler = createScheduler({ max: 4 });
  const task = async () => {
    calls += 1;
    return calls;
  };
  const [a, b] = await Promise.all([
    scheduler.run({ sessionId: 's' }, task),
    scheduler.run({ sessionId: 's' }, task),
  ]);
  assert.equal(calls, 2, '缺 callId 的并发请求必须各自执行');
  assert.notEqual(a.value, b.value);

  // 大批量顺序执行：全部完成、无遗留（调度器状态不含 dedupe 键）。
  for (let index = 0; index < 500; index += 1) {
    await scheduler.run({ sessionId: 's', callId: `c${index}` }, async () => index);
  }
  assert.equal(scheduler.state().inFlight, 0);
  assert.equal('dedupeSize' in scheduler.state(), false, '调度器状态不含 dedupe 键');
  const again = await scheduler.run({ sessionId: 's', callId: 'c499' }, async () => 'again');
  assert.deepEqual(again, { ok: true, value: 'again' }, '重发同键重新执行，不复用任何缓存');
});

// ── 排队与冷却零值的现行边界（design §5.1；验证留档，不改语义） ────────

test('queueMax=0 → 满载时不排队，直接按 queue-overflow 拒绝', async () => {
  const scheduler = createScheduler({ max: 1, queueMax: 0, queueTimeoutMs: 1000 });
  const hold = deferred();
  const running = scheduler.run({ sessionId: 'a', callId: '1' }, () => hold.promise);
  const rejected = await scheduler.run({ sessionId: 'b', callId: '2' }, async () => 'never');
  // 现行边界：全局排队上限 0＝不设等待位，争用时立即拒绝（不是无限排队）。
  assert.deepEqual(rejected, { ok: false, reason: 'queue-overflow' });
  hold.resolve('a');
  await running;
});

test('queueTimeoutMs=0 → 争用请求拿不到立即释放的许可即按排队超时拒绝', async () => {
  const scheduler = createScheduler({ max: 1, queueMax: 4, queueTimeoutMs: 0 });
  const hold = deferred();
  const running = scheduler.run({ sessionId: 'a', callId: '1' }, () => hold.promise);
  const timedOut = await scheduler.run({ sessionId: 'b', callId: '2' }, async () => 'never');
  // 现行边界：零等待上限＝零延时计时器在下一宏任务生效，等待许可的请求随即按 queue-timeout 拒绝。
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.reason, 'queue-timeout');
  assert.ok(Number.isFinite(timedOut.queueMs), '零等待超时同样携带 queueMs 观测');
  hold.resolve('a');
  await running;
  // 许可空出后新请求照常执行（零值只影响争用期的等待）。
  const after = await scheduler.run({ sessionId: 'b', callId: '3' }, async () => 'ok');
  assert.deepEqual(after, { ok: true, value: 'ok' });
});

test('cooldownMs=0 → 冷却打开后下次检查即恢复（零时长冷却）', async () => {
  let clock = 0;
  const scheduler = createScheduler({
    breaker: { consecutiveDenials: 2, windowSize: 10, windowDenials: 5, cooldownMs: 0 },
    now: () => clock,
  });
  scheduler.record('deny');
  scheduler.record('deny');
  // 现行边界：冷却时长 0＝now()-openedAt>=0 恒真，下次 run 前检查即自动关闭并清零计数。
  const allowed = await scheduler.run({ sessionId: 's', callId: 'c1' }, async () => 'x');
  assert.deepEqual(allowed, { ok: true, value: 'x' }, '零时长冷却不拦截后续请求');
  assert.equal(scheduler.state().consecutive, 0, '自动关闭同时清空连续计数');
});

// ── error 计入冷却窗口（design §5.3） ──────────────────────────────────────

test('调度器层连续 error 达 consecutiveDenials → 冷却打开，冷却期结束后恢复', async () => {
  let clock = 0;
  const scheduler = createScheduler({
    breaker: { consecutiveDenials: 3, windowSize: 10, windowDenials: 5, cooldownMs: 100 },
    now: () => clock,
  });
  scheduler.record('error');
  scheduler.record('error');
  assert.equal(scheduler.state().breakerOpen, false, '两次 error 未达阈值');
  scheduler.record('error');
  assert.equal(scheduler.state().breakerOpen, true, '第三次 error 打开冷却（与 deny 同权）');
  const blocked = await scheduler.run({ sessionId: 's', callId: 'c1' }, async () => 'x');
  assert.deepEqual(blocked, { ok: false, reason: 'breaker-open' }, '冷却打开后零任务执行');
  clock = 200;
  assert.equal(scheduler.state().breakerOpen, false, '冷却结束自动关闭并清空计数');
});

test('清零语义保持：error、error、allow、error、error → 未打开', () => {
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

test('queue-overflow 不是审查结论：计数不变', () => {
  const scheduler = createScheduler({ breaker: { consecutiveDenials: 3, windowSize: 10, windowDenials: 5 } });
  // 调度失败若误入 record（并发高峰≠通道故障），这里立即红。
  scheduler.record('queue-overflow');
  scheduler.record('queue-timeout');
  scheduler.record('breaker-open');
  assert.equal(scheduler.state().consecutive, 0);
  assert.equal(scheduler.state().breakerOpen, false);
});

// ── 取消贯通与失败包络（design §5.1） ──────────────────────────────────────

test('排队中的请求被中止：移出队列、任务不执行、返回 queue-aborted', async () => {
  const scheduler = createScheduler({ max: 1, queueMax: 4, queueTimeoutMs: 5000 });
  const hold = deferred();
  const started = [];
  const running = scheduler.run({ sessionId: 'a', callId: '1' }, () => hold.promise);
  const controller = new AbortController();
  const queued = scheduler.run({ sessionId: 'b', callId: '2' }, async () => {
    started.push('b');
    return 'b';
  }, { signal: controller.signal });
  await tick();
  assert.equal(scheduler.state().queued, 1, '中止前在队列中');
  controller.abort('user cancelled');
  const aborted = await queued;
  assert.deepEqual(aborted, { ok: false, reason: 'queue-aborted', aborted: true });
  assert.equal(scheduler.state().queued, 0, '中止即移出队列');
  hold.resolve('a');
  await running;
  assert.deepEqual(started, [], '被中止的排队请求不执行任务');
});

test('入队时信号已中止：不占队列名额，直接 queue-aborted', async () => {
  const scheduler = createScheduler({ max: 1, queueMax: 1, queueTimeoutMs: 1000 });
  const hold = deferred();
  const running = scheduler.run({ sessionId: 'a', callId: '1' }, () => hold.promise);
  await tick();
  const controller = new AbortController();
  controller.abort('cancelled');
  // 队列已满（queueMax=1 且本请求若入队会占最后名额）——已中止的请求根本不占名额。
  const first = await scheduler.run({ sessionId: 'b', callId: '2' }, async () => 'b', { signal: controller.signal });
  assert.deepEqual(first, { ok: false, reason: 'queue-aborted', aborted: true });
  const stillQueued = scheduler.run({ sessionId: 'c', callId: '3' }, async () => 'c');
  await tick();
  assert.equal(scheduler.state().queued, 1, '未中止请求仍可入队（名额未被占用）');
  hold.resolve('a');
  await running;
  assert.deepEqual(await stillQueued, { ok: true, value: 'c' });
});

test('队首等待者中止：即时移出且后续等待者照常接力', async () => {
  const scheduler = createScheduler({ max: 1, queueMax: 4, queueTimeoutMs: 5000 });
  const hold = deferred();
  const running = scheduler.run({ sessionId: 'a', callId: '1' }, () => hold.promise);
  const controllerA = new AbortController();
  const started = [];
  const queuedA = scheduler.run({ sessionId: 'b', callId: '2' }, async () => {
    started.push('a2');
    return 'a2';
  }, { signal: controllerA.signal });
  const queuedB = scheduler.run({ sessionId: 'c', callId: '3' }, async () => {
    started.push('b2');
    return 'b2';
  });
  await tick();
  // 队首等待者中止：即时移出、清等待计时器，不占用后续唤醒机会。
  controllerA.abort('cancelled');
  assert.deepEqual(await queuedA, { ok: false, reason: 'queue-aborted', aborted: true });
  assert.equal(scheduler.state().queued, 1, '队首移出后只剩后续等待者');
  hold.resolve('a');
  await running;
  assert.deepEqual(await queuedB, { ok: true, value: 'b2' }, '后续等待者照常接力');
  assert.deepEqual(started, ['b2']);
});

test('取得许可后任务启动前复核：已中止不执行任务、执行位即时释放', async () => {
  const scheduler = createScheduler({ max: 1, queueMax: 4, queueTimeoutMs: 5000 });
  const controller = new AbortController();
  const hold = deferred();
  const running = scheduler.run({ sessionId: 'a', callId: '1' }, () => hold.promise);
  const started = [];
  const queued = scheduler.run({ sessionId: 'b', callId: '2' }, async () => {
    started.push('b');
    return 'b';
  }, { signal: controller.signal });
  await tick();
  // 同一同步段内释放许可并中止：无论中止先于唤醒（排队中止路径）还是落在许可交接后
  // （启动前复核路径），契约一致——任务不启动、不占执行位。
  hold.resolve('a');
  controller.abort('cancelled');
  await running;
  assert.deepEqual(await queued, { ok: false, reason: 'queue-aborted', aborted: true });
  assert.deepEqual(started, []);
  const followUp = await scheduler.run({ sessionId: 'c', callId: '3' }, async () => 'c');
  assert.deepEqual(followUp, { ok: true, value: 'c' }, '执行位已释放');
});

test('排队超时失败包络携带实例实际等待上限 timeoutMs（不在结算时现读配置）', async () => {
  const scheduler = createScheduler({ max: 1, queueMax: 4, queueTimeoutMs: 25 });
  const hold = deferred();
  const running = scheduler.run({ sessionId: 'a', callId: '1' }, () => hold.promise);
  const timedOut = await scheduler.run({ sessionId: 'b', callId: '2' }, async () => 'b');
  assert.equal(timedOut.reason, 'queue-timeout');
  assert.equal(timedOut.timeoutMs, 25, '包络携带本实例的排队等待上限');
  assert.ok(Number.isFinite(timedOut.queueMs));
  hold.resolve('a');
  await running;
});
