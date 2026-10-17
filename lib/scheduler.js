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
 * @param {number} [options.queueMax] - 全局排队上限（跨会话合计；同一 `sessionId` 的请求另行串行）。
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
   * @param {AbortSignal} [signal] - 审查中止信号：排队中被中止即移出队列、清等待计时器（design §5.1）。
   * @returns {Promise<{ok: true} | {ok: false, reason: string, timeoutMs?: number, aborted?: boolean}>} 许可结果；
   *   排队超时携带本实例的等待上限 `timeoutMs`（design §5.1 失败包络），排队中止携带 `aborted`。
   */
  function acquire(sessionId, signal) {
    if (signal?.aborted === true) return Promise.resolve({ ok: false, reason: 'queue-aborted', aborted: true });
    if (inFlight < maxConcurrent && !busySessions.has(sessionId)) {
      inFlight += 1;
      busySessions.add(sessionId);
      return Promise.resolve({ ok: true });
    }
    if (queue.length >= queueMax) return Promise.resolve({ ok: false, reason: 'queue-overflow' } );
    return new Promise((resolvePromise) => {
      const entry = { sessionId, signal, resolve: resolvePromise, timer: undefined, onAbort: undefined };
      // 排队中止：移出队列、清计时器、空位即时开放；监听器挂接异常不外泄（超时与正常唤醒仍在）。
      entry.onAbort = () => {
        clearTimeout(entry.timer);
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        resolvePromise({ ok: false, reason: 'queue-aborted', aborted: true });
        drain();
      };
      if (signal !== undefined && signal !== null) {
        try {
          signal.addEventListener('abort', entry.onAbort, { once: true });
        } catch { /* 信号对象不可监听时只保留超时与正常唤醒两条结束路径。 */ }
      }
      entry.timer = setTimeout(() => {
        detachAbort(entry);
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        resolvePromise({ ok: false, reason: 'queue-timeout', timeoutMs: queueTimeoutMs });
      }, queueTimeoutMs);
      queue.push(entry);
    });
  }

  /** 摘掉排队项的中止监听（正常结束路径：被唤醒或超时到点后不再响应中止）。 */
  function detachAbort(entry) {
    if (entry.onAbort === undefined || entry.signal === undefined || entry.signal === null) return;
    try {
      entry.signal.removeEventListener('abort', entry.onAbort);
    } catch { /* 摘除失败不改变已定的结束路径。 */ }
    entry.onAbort = undefined;
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
      detachAbort(entry);
      // 许可交接处复核：唤醒时信号已中止的等待者不占用执行位——按排队中止失败返回，
      // 空位继续让给后续等待者（消除释放与中止的竞速窗口，design §5.1）。
      if (entry.signal?.aborted === true) {
        entry.resolve({ ok: false, reason: 'queue-aborted', aborted: true });
        continue;
      }
      inFlight += 1;
      busySessions.add(entry.sessionId);
      entry.resolve({ ok: true });
    }
  }

  /**
   * 执行一次独立审查任务，带并发、排队与冷却（design §5.1）。
   * 任务回调收到排队等待时长 `queueMs`（从进入调度到获得执行许可）；立即执行的请求为 0，
   * 冷却中或队列已满被拒的请求不会执行任务。失败信封在排队超时携带 `queueMs`（实际等待时长）与
   * `timeoutMs`（本实例实际生效的等待上限——通知与结算引用它，不在结算时现读配置）；排队中止
   * （请求取消）携带 `aborted`，不执行任务、不计数。队列已满与冷却中被拒没有等待期，不携带。
   * @param {{sessionId?: string}} key - 串行键（会话 id）。
   * @param {(queueMs: number) => Promise<object>} task - 实际审查任务。
   * @param {{signal?: AbortSignal}} [options] - 本请求的审查中止信号（gate 的 reviewSignal）。
   * @returns {Promise<{ok: true, value: object} | {ok: false, reason: string, queueMs?: number, timeoutMs?: number, aborted?: boolean}>} 任务结果或拒绝原因。
   */
  async function run(key, task, options = {}) {
    if (breakerOpen()) return { ok: false, reason: 'breaker-open' };
    const sessionId = key?.sessionId ?? '-';
    const signal = options?.signal;
    const enteredAt = now();
    const permit = await acquire(sessionId, signal);
    if (permit.ok !== true) {
      return permit.reason === 'queue-timeout'
        ? { ok: false, reason: permit.reason, queueMs: now() - enteredAt, timeoutMs: permit.timeoutMs }
        : { ok: false, reason: permit.reason, ...(permit.aborted === true ? { aborted: true } : {}) };
    }
    // 取得许可后、任务启动前复核信号：已中止立即释放执行位、不执行任务（design §5.1）。
    if (signal?.aborted === true) {
      release(sessionId);
      return { ok: false, reason: 'queue-aborted', aborted: true };
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
