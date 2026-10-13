/**
 * dsh-approve-for-me — 并发、排队与冷却。
 *
 * 每次审查都是一次独立 `llm.stream`，因此要有全局上限保护配额；同一会话串行 1 避免自审风暴。
 * 冷却阈值与 codex 一致（连续 3 次拒绝，或最近 50 次中 10 次拒绝），计数口径上 `error` 与 `deny`
 * 同权；但本插件无权中断 agent turn，冷却期间只拒绝本次请求并注入理由（偏离见 design §5.3／requirements §4.4）。
 * 每个到达的请求都是独立审查任务（design §5.1）：同一 `(sessionId, callId)` 重复到达各自执行完整审查，
 * 不共享执行中的任务、也不复用已完成的结果——审批语义里一次调用标识对应一次判断，
 * 复用会让第二次到达拿不到基于本次上下文的结论。
 * @module dsh-approve-for-me/scheduler
 */

/**
 * 创建调度器。
 * @param {object} [options] - 调度参数。
 * @param {number} [options.max] - 全局并发上限。
 * @param {number} [options.queueMax] - 每会话排队上限。
 * @param {number} [options.queueTimeoutMs] - 排队等待上限。
 * @param {{consecutiveDenials?: number, windowSize?: number, windowDenials?: number, cooldownMs?: number}} [options.breaker]
 *   - 冷却阈值。
 * @param {() => number} [options.now] - 时钟注入点。
 * @returns {{run: Function, record: Function, state: Function}} 调度器。
 */
export function createScheduler(options = {}) {
  const maxConcurrent = Number.isFinite(options.max) ? options.max : 2;
  const queueMax = Number.isFinite(options.queueMax) ? options.queueMax : 8;
  const queueTimeoutMs = Number.isFinite(options.queueTimeoutMs) ? options.queueTimeoutMs : 30000;
  const breakerCfg = options.breaker ?? {};
  const consecutiveLimit = Number.isFinite(breakerCfg.consecutiveDenials) ? breakerCfg.consecutiveDenials : 3;
  const windowSize = Number.isFinite(breakerCfg.windowSize) ? breakerCfg.windowSize : 50;
  const windowDenials = Number.isFinite(breakerCfg.windowDenials) ? breakerCfg.windowDenials : 10;
  const cooldownMs = Number.isFinite(breakerCfg.cooldownMs) ? breakerCfg.cooldownMs : 600000;
  const now = options.now ?? (() => Date.now());

  /** 执行中的请求数。 */
  let inFlight = 0;
  /** 正在执行审查的会话 id 集合（每会话串行 1）。 */
  const busySessions = new Set();
  /** 等待中的队列项。 */
  const queue = [];
  /** 冷却状态。 */
  const breaker = { consecutive: 0, window: [], openedAt: undefined };

  /**
   * 冷却是否打开；冷却期结束后自动关闭并清空计数。
   * @returns {boolean} 是否处于打开状态。
   */
  function breakerOpen() {
    if (breaker.openedAt === undefined) return false;
    if (now() - breaker.openedAt >= cooldownMs) {
      breaker.openedAt = undefined;
      breaker.consecutive = 0;
      breaker.window = [];
      return false;
    }
    return true;
  }

  /**
   * 记录一次审查结论，用于冷却判定：`error` 与 `deny` 同权计数——冷却保护的是
   * 「审查通道不再产出可信结论」，无论模型坏还是判定严，打开后的行为一致（拒绝新审查＋冷却）；
   * 观测口径上 decision 字段仍区分两者。`allow` 清零 `consecutive`。
   * 调度失败（`queue-overflow`／`queue-timeout`／`breaker-open`）不是审查结论，不经此入口、不计数。
   * @param {'allow' | 'deny' | 'error'} decision - 审查结论。
   * @returns {void}
   */
  function record(decision) {
    if (decision !== 'allow' && decision !== 'deny' && decision !== 'error') return;
    const denial = decision !== 'allow';
    breaker.consecutive = denial ? breaker.consecutive + 1 : 0;
    breaker.window.push(denial);
    if (breaker.window.length > windowSize) breaker.window.shift();
    const denialsInWindow = breaker.window.filter(Boolean).length;
    if (breaker.consecutive >= consecutiveLimit || denialsInWindow >= windowDenials) {
      breaker.openedAt = now();
    }
  }

  /**
   * 尝试获得执行许可；拿不到就入队等待。
   * @param {string} sessionId - 会话 id（串行键）。
   * @returns {Promise<{ok: true} | {ok: false, reason: string}>} 许可结果。
   */
  function acquire(sessionId) {
    if (inFlight < maxConcurrent && !busySessions.has(sessionId)) {
      inFlight += 1;
      busySessions.add(sessionId);
      return Promise.resolve({ ok: true });
    }
    if (queue.length >= queueMax) return Promise.resolve({ ok: false, reason: 'queue-overflow' } );
    return new Promise((resolvePromise) => {
      const entry = { sessionId, resolve: resolvePromise, timer: undefined };
      entry.timer = setTimeout(() => {
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        resolvePromise({ ok: false, reason: 'queue-timeout' });
      }, queueTimeoutMs);
      queue.push(entry);
    });
  }

  /** 释放许可并唤醒队首可运行的等待者。 */
  function release(sessionId) {
    inFlight -= 1;
    busySessions.delete(sessionId);
    drain();
  }

  /** 按 FIFO 唤醒等待者；同一会话同时只放行一个。 */
  function drain() {
    while (queue.length > 0) {
      const index = queue.findIndex((entry) => inFlight < maxConcurrent && !busySessions.has(entry.sessionId));
      if (index < 0) return;
      const [entry] = queue.splice(index, 1);
      clearTimeout(entry.timer);
      inFlight += 1;
      busySessions.add(entry.sessionId);
      entry.resolve({ ok: true });
    }
  }

  /**
   * 执行一次独立审查任务，带并发、排队与冷却（design §5.1）。
   * 任务回调收到排队等待时长 `queueMs`（从进入调度到获得执行许可）；立即执行的请求为 0，
   * 冷却中或队列已满被拒的请求不会执行任务。失败信封仅在排队超时携带 `queueMs`（实际等待时长）；
   * 队列已满与冷却中被拒没有等待期，不携带。
   * @param {{sessionId?: string}} key - 串行键（会话 id）。
   * @param {(queueMs: number) => Promise<object>} task - 实际审查任务。
   * @returns {Promise<{ok: true, value: object} | {ok: false, reason: string, queueMs?: number}>} 任务结果或拒绝原因。
   */
  async function run(key, task) {
    if (breakerOpen()) return { ok: false, reason: 'breaker-open' };
    const sessionId = key?.sessionId ?? '-';
    const enteredAt = now();
    const permit = await acquire(sessionId);
    if (permit.ok !== true) {
      return permit.reason === 'queue-timeout'
        ? { ok: false, reason: permit.reason, queueMs: now() - enteredAt }
        : { ok: false, reason: permit.reason };
    }
    try {
      const value = await task(Math.max(0, now() - enteredAt));
      return { ok: true, value };
    } catch (error) {
      return { ok: false, reason: `task-error: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      release(sessionId);
    }
  }

  /**
   * 观察调度器内部状态（测试与诊断用）。
   * @returns {{inFlight: number, queued: number, breakerOpen: boolean, consecutive: number}} 状态快照。
   */
  function state() {
    return {
      inFlight,
      queued: queue.length,
      breakerOpen: breakerOpen(),
      consecutive: breaker.consecutive,
    };
  }

  return { run, record, state };
}
