/**
 * dsh-approve-for-me — 并发、排队、去重与熔断。
 *
 * 每次审查都是一次独立 `llm.stream`，因此要有全局上限保护配额；同一会话串行 1 避免自审风暴。
 * 熔断阈值与 codex 一致（连续 3 次拒绝，或最近 50 次中 10 次拒绝），计数口径上 `error` 与 `deny`
 * 同权（R48）；但本插件无权中断 agent turn，熔断期间只拒绝本次请求并注入理由（偏离见设计「dsh 侧设计」）。
 * @module dsh-approve-for-me/scheduler
 */
import { randomUUID } from 'node:crypto';

/** 已完成结果的复用窗口；同一 `(sessionId, callId)` 在窗口内直接复用。 */
export const DEDUPE_TTL_MS = 60000;

/**
 * dedupe 结果缓存的容量上界（R31）：实际约束＝TTL 窗口内的条目数
 * （≈ 并发上限 2 × 每会话排队 8 × 活跃会话数），256 是该窗口的容量上界而非会话总量；
 * 超限删最旧（Map 迭代序＝插入序）。被淘汰的若是在飞条目，该键的并发去重退化为再次执行——容量上界优先。
 */
export const DEDUPE_MAX_ENTRIES = 256;

/**
 * 创建调度器。
 * @param {object} [options] - 调度参数。
 * @param {number} [options.max] - 全局并发上限。
 * @param {number} [options.queueMax] - 每会话排队上限。
 * @param {number} [options.queueTimeoutMs] - 排队等待上限。
 * @param {{consecutiveDenials?: number, windowSize?: number, windowDenials?: number, cooldownMs?: number}} [options.breaker]
 *   - 熔断阈值。
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
  const dedupeTtlMs = Number.isFinite(options.dedupeTtlMs) ? options.dedupeTtlMs : DEDUPE_TTL_MS;

  /** 在飞请求数。 */
  let inFlight = 0;
  /** 正在执行审查的会话 id 集合（每会话串行 1）。 */
  const busySessions = new Set();
  /** 等待中的队列项。 */
  const queue = [];
  /** 去重表：key → {promise} 或 {at, result}。 */
  const dedupe = new Map();
  /** 熔断状态。 */
  const breaker = { consecutive: 0, window: [], openedAt: undefined };

  /**
   * 熔断是否打开；冷却结束后自动关闭并清空计数。
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
   * 记录一次审查结论，用于熔断判定（R48）：`error` 与 `deny` 同权计数——熔断保护的是
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
   * @param {string} sessionId - 会话 id（去重与串行键）。
   * @returns {Promise<{ok: true} | {ok: false, reason: string}>} 许可结果。
   */
  function acquire(sessionId) {
    if (inFlight < maxConcurrent && !busySessions.has(sessionId)) {
      inFlight += 1;
      busySessions.add(sessionId);
      return Promise.resolve({ ok: true });
    }
    if (queue.length >= queueMax) return Promise.resolve({ ok: false, reason: 'queue-overflow' });
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
   * 执行一次审查任务，带并发、排队、去重与熔断。
   * @param {{sessionId?: string, callId?: string}} key - 去重与串行键。
   * @param {() => Promise<object>} task - 实际审查任务。
   * @returns {Promise<{ok: true, value: object} | {ok: false, reason: string}>} 任务结果或拒绝原因。
   */
  async function run(key, task) {
    if (breakerOpen()) return { ok: false, reason: 'breaker-open' };
    const sessionId = key?.sessionId ?? '-';
    // R31：缺 callId 的键不塌缩——任何两次到达都无法证明同源，各自生成请求级随机键独立执行；
    // 有 callId 时保持并发竞速去重（同 callId 并发只执行一次）。键兜底先例＝gate 的 pending 键（lib/gate.js）。
    const callKey = typeof key?.callId === 'string' && key.callId.length > 0 ? key.callId : `anon-${randomUUID()}`;
    const dedupeKey = `${sessionId}:${callKey}`;
    const existing = dedupe.get(dedupeKey);
    if (existing !== undefined) {
      if (existing.promise !== undefined) return existing.promise;
      if (now() - existing.at <= dedupeTtlMs) return existing.result;
      dedupe.delete(dedupeKey);
    }

    const promise = (async () => {
      const permit = await acquire(sessionId);
      if (permit.ok !== true) return { ok: false, reason: permit.reason };
      try {
        const value = await task();
        return { ok: true, value };
      } catch (error) {
        return { ok: false, reason: `task-error: ${error instanceof Error ? error.message : String(error)}` };
      } finally {
        release(sessionId);
      }
    })();

    dedupe.set(dedupeKey, { promise });
    const result = await promise;
    if (result.ok === true) {
      // 只有成功结论进 TTL 复用缓存（R31）：失败（排队超时、任务抛错）复用 60 秒等于把瞬时故障放大；
      // 失败即删除在飞条目，下一次请求重走完整流程。
      dedupe.set(dedupeKey, { at: now(), result });
      if (dedupe.size > DEDUPE_MAX_ENTRIES) dedupe.delete(dedupe.keys().next().value);
    } else {
      dedupe.delete(dedupeKey);
    }
    return result;
  }

  /**
   * 观察调度器内部状态（测试与诊断用）。
   * @returns {{inFlight: number, queued: number, breakerOpen: boolean, consecutive: number, dedupeSize: number}} 状态快照。
   */
  function state() {
    return {
      inFlight,
      queued: queue.length,
      breakerOpen: breakerOpen(),
      consecutive: breaker.consecutive,
      dedupeSize: dedupe.size,
    };
  }

  return { run, record, state };
}
