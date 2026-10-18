import assert from 'node:assert/strict';
import test from 'node:test';
import { agentLangOf, allowText, guardNext, onApprovalRequest, rejectText, REVIEW_SUPERSEDED, REVIEW_TIMEOUT_ABORT_MESSAGE, timeoutText } from '../lib/gate.js';
import { createScheduler } from '../lib/scheduler.js';
import { DEFAULT_DENY_PATTERNS, screen } from '../lib/policy.js';

/** 默认配置：审查超时 1 秒、人工通道关闭、注入范围 `all`。 */
function baseConfig(overrides = {}) {
  return {
    reviewer: { timeoutMs: 1000, ...(overrides.reviewer ?? {}) },
    human: { timeoutMs: 1000, timeoutFrom: 'request', ...(overrides.human ?? {}) },
    fallback: 'reject',
    // 注入文案断言按 zh 档写：显式声明语言，不依赖缺失回落的方向（回落已统一为 en）。
    language: { agent: 'zh', ...(overrides.language ?? {}) },
    ui: { inject: 'all', injectMaxBytes: 2048, ...(overrides.ui ?? {}) },
    ...overrides,
  };
}

/** 构造一次 gate 调用的运行时契约与可观测状态。 */
function makeRt(cfg, options = {}) {
  const state = { nextCalls: 0, nextResolvers: [], nextRejectors: [], injections: [], audits: [], timers: [], cancels: [], aborts: [], pending: [], settles: [], reviewSignals: [], countTimeouts: 0 };
  const rt = {
    nextId: () => 'req-1',
    mode: () => options.mode ?? 'auto',
    // §8.2 preset：接管命中的权限预设名（不提供时与生产「取不到」一致，记录里 preset 缺失）。
    ...(options.preset === undefined ? {} : { preset: () => options.preset }),
    // 无头（委派子代理）请求的标记（requirements §2.2／design §2.2）；缺省视为主会话。
    ...(options.isHeadless === undefined ? {} : { isHeadless: () => options.isHeadless }),
    // §8.4 结算记录捕获：gate 是唯一写入者，每审批恰一条。
    onSettle(entry) {
      state.settles.push(entry);
    },
    cfg: () => cfg,
    async configFor() {
      // 装配延迟测试缝（与 reviewDelayMs 同款）：把等待注入装配阶段——人工 request 起算的预算从
      // 请求进入应答者就开始消耗，configFor 的耗时必须吃掉该预算（反例：装配耗时挤占人工预算）。
      if (options.configForDelayMs !== undefined) await delay(options.configForDelayMs);
      // 装配挂死测试缝：永不 resolve，装配备用计时器是唯一出口。
      if (options.configForNever === true) await new Promise(() => {});
      if (options.configThrows === true) throw new Error('cfg boom');
      return cfg;
    },
    async locate() {
      return options.located ?? { command: 'npm i', cwd: 'C:/work', degraded: [] };
    },
    // §5.3 计数缝：装配期/零值立即超时的计数调用在此计数（生产接线为 scheduler.record）。
    countTimeout() {
      state.countTimeouts += 1;
    },
    screen() {
      return options.pre ?? { action: 'review', why: 'ok', fields: { action: 'review', mode: 'danger-full-access', tool: 'pwsh' } };
    },
    async review(_request, _located, _pre, _cfg, opts) {
      // §5.3 计数口径测试缝：捕获传入的在飞审查信号，供断言中止标记（超时/被替代）。
      state.reviewSignals.push(opts?.signal);
      if (options.reviewDelayMs !== undefined) await delay(options.reviewDelayMs);
      if (options.reviewThrows === true) throw new Error('review exploded');
      // 测试缝（迟到观测端到端链）：真实审查器收尾时写 phase=review 审计行且带 late 观测（与 reviewer 的 review 审计行同形）。
      if (options.reviewWritesAudit === true) {
        state.audits.push({
          phase: 'review',
          decision: options.verdict?.decision ?? 'allow',
          late: opts?.signal?.aborted === true ? 'yes' : 'no',
        });
      }
      return options.verdict ?? {
        decision: 'allow',
        risk: 'low',
        authorization: 'high',
        reason: 'ok',
        toolCalls: 0,
        fields: { risk: 'low', auth: 'high', tools: 0, degraded: 'none' },
      };
    },
    timer(ms, onFire, label) {
      let settle;
      const promise = new Promise((resolve) => {
        settle = resolve;
      });
      const handle = setTimeout(() => {
        let value;
        try {
          // 测试钩子：按 label 注入回调抛错——模拟生产契约里 rt.timer 包装的回调异常路径。
          if (options.timerFireThrows === true || options.timerFireThrows === label) throw new Error('timer cb boom');
          value = onFire();
        } catch (error) {
          value = { kind: 'callback-error', side: 'timer', label, error };
        }
        settle(value);
      }, ms);
      const entry = { ms, label, promise, cleared: false };
      // 手动触发缝：装配计时器取先验时限（缺省 90 s），测试里手动提前到点。
      entry.fire = () => {
        let value;
        try {
          if (options.timerFireThrows === true || options.timerFireThrows === label) throw new Error('timer cb boom');
          value = onFire();
        } catch (error) {
          value = { kind: 'callback-error', side: 'timer', label, error };
        }
        settle(value);
      };
      entry.clear = () => {
        entry.cleared = true;
        clearTimeout(handle);
      };
      state.timers.push(entry);
      return entry;
    },
    onAbort(signal, onFire, label) {
      let settle;
      const promise = new Promise((resolve) => {
        settle = resolve;
      });
      const listener = () => {
        let value;
        try {
          if (options.abortFireThrows === true) throw new Error('abort cb boom');
          value = onFire();
        } catch (error) {
          value = { kind: 'callback-error', side: 'abort', label, error };
        }
        settle(value);
      };
      // 已中止特判（镜像生产 lib/index.js 的 onAbort 形态）：gate 的取消监听注册晚于装配，
      // 装配等待期间已中止的 signal 靠 addEventListener 收不到事件——必须补微任务补发，
      // 否则 cancelled.promise 永不 resolve，G8 的取消竞速断言不可达。
      if (signal !== undefined && signal !== null && signal.aborted === true) {
        queueMicrotask(listener);
      } else if (signal !== undefined && signal !== null) {
        signal.addEventListener('abort', listener, { once: true });
      }
      const entry = { promise, cleared: false };
      entry.clear = () => {
        entry.cleared = true;
        signal?.removeEventListener?.('abort', listener);
      };
      state.cancels.push(entry);
      return entry;
    },
    withdraw(request) {
      // 镜像真实 withdraw（lib/index.js）：投影信号捕获＋同一性守卫恢复——gate 的收尾恢复
      // 依赖这两点，假实现必须同形，否则 §4.2 用例测的是假实现自己。
      const original = request.signal;
      const canWithdraw = !Object.isFrozen(request);
      const controller = new AbortController();
      let projected;
      if (canWithdraw) {
        // null 与 undefined 同路径（与真实 withdraw 一致；AbortSignal.any 对 null 成员抛 TypeError）。
        projected = original === undefined || original === null
          ? controller.signal
          : AbortSignal.any([original, controller.signal]);
        request.signal = projected;
      }
      return {
        signal: controller.signal,
        original,
        canWithdraw,
        abort(reason) {
          state.aborts.push(reason);
          controller.abort(reason);
        },
        restore() {
          if (canWithdraw && request.signal === projected) request.signal = original;
        },
      };
    },
    inject(_agent, text) {
      state.injections.push(text);
    },
    audit(fields) {
      state.audits.push(fields);
    },
    // 卡片状态表：记录每次写入与清理，便于断言状态迁移（design §7.4）。
    pending: {
      set(sessionId, record) {
        state.pending.push({ op: 'set', sessionId, ...record });
      },
      clear(sessionId, callId) {
        state.pending.push({ op: 'clear', sessionId, callId });
      },
    },
  };
  const next = () => {
    state.nextCalls += 1;
    return new Promise((resolve, reject) => {
      state.nextResolvers.push(resolve);
      state.nextRejectors.push(reject);
    });
  };
  return { rt, state, next };
}

/** 让微任务与已排定的定时器先跑一轮。 */
const tick = () => new Promise((resolve) => setImmediate(resolve));
/** 延时。 */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 构造一次请求。 */
const request = (signal) => ({ agent: { session: { id: 's1' }, inject: () => {} }, toolName: 'pwsh', callId: 'call_1', reason: 'escalate sandbox to danger-full-access: x', ...(signal === undefined ? {} : { signal }) });

test('路径 1：审查 allow → allowed-once，撤回卡片，按 ui.inject=all 注入放行留痕', async () => {
  const { rt, state, next } = makeRt(baseConfig());
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'allowed-once');
  assert.equal(state.nextCalls, 1);
  assert.equal(state.injections.length, 1);
  assert.match(state.injections[0], /已自动放行/);
  assert.equal(state.aborts.length, 1);
  assert.match(String(state.aborts[0]), /auto-approved/);
  const decide = state.audits.find((entry) => entry.phase === 'decide');
  assert.equal(decide.decision, 'allowed-once');
  assert.equal(decide.source, 'llm');
  assert.equal(decide.withdraw, 'ok');
  assert.equal(decide.inject, 'yes');
});

test('路径 1：request 冻结时降级为不可撤回，功能不受影响', async () => {
  const { rt, state, next } = makeRt(baseConfig());
  const frozen = Object.freeze(request());
  const outcome = await onApprovalRequest(frozen, next, rt);
  assert.equal(outcome, 'allowed-once');
  const decide = state.audits.find((entry) => entry.phase === 'decide');
  assert.equal(decide.withdraw, 'unavailable');
  assert.equal(state.aborts.length, 0);
});

test('路径 2：规则强制检查命中 → rejected + 注入，且不调用 next()', async () => {
  // 配置默认不启用文本拒绝规则（requirements §5.3：denyPatterns 默认 []）——规则命中只在
  // 显式配置清单的部署里发生；DEFAULT_DENY_PATTERNS 是非空的出厂参考清单，本用例显式注入以构造规则命中。
  const { rt, state, next } = makeRt(baseConfig({ denyPatterns: [...DEFAULT_DENY_PATTERNS] }), {
    pre: {
      action: 'deny',
      why: 'deny pattern',
      reason: '键 "script" 命中模式 (^|[^A-Za-z0-9])(mkfs|diskpart|fdisk|parted)\\b',
      fields: { action: 'deny', tool: 'pwsh' },
    },
  });
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'rejected');
  assert.equal(state.nextCalls, 0);
  assert.equal(state.injections.length, 1);
  assert.match(state.injections[0], /命中模式/);
  const screen = state.audits.find((entry) => entry.phase === 'screen' && entry.decision === 'rejected');
  assert.equal(screen.source, 'rule');
  assert.equal(screen.inject, 'yes');
  // deny 审计行带上规则层 reason（含命中键与模式，design §8.1），排障可从日志定位命中了什么。
  assert.match(screen.reason, /键 "script" 命中模式/);
  assert.match(screen.reason, /mkfs/);
});

test('路径 2：审查 deny（fallback=reject）→ rejected + 撤回 + 注入', async () => {
  const { rt, state, next } = makeRt(baseConfig(), {
    verdict: { decision: 'deny', risk: 'high', authorization: 'low', reason: 'dangerous', toolCalls: 1, fields: { risk: 'high', auth: 'low', tools: 1, degraded: 'none' } },
  });
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'rejected');
  assert.equal(state.nextCalls, 1);
  assert.equal(state.aborts.length, 1);
  assert.match(state.injections[0], /dangerous/);
  assert.match(state.injections[0], /风险：high；授权证据：low/);
});

test('路径 3：审查超时 → rejected + 注入（超时文案，点明可重试）', async () => {
  const { rt, state, next } = makeRt(baseConfig({ reviewer: { timeoutMs: 20 } }), {
    reviewDelayMs: 200,
    verdict: { decision: 'allow', reason: 'late', toolCalls: 0, fields: {} },
  });
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'rejected');
  assert.match(state.injections[0], /自动审批未在时限内完成（超时）/u);
  assert.match(state.injections[0], /超时环节：审查超时 20 ms/u);
  assert.match(state.injections[0], /这不是「判定为危险」/u);
  assert.match(state.injections[0], /可以直接重试/u);
  // 超时不是危险判定：不得出现 codex 的通用拒绝末句。
  assert.doesNotMatch(state.injections[0], /不要用等价手段绕过该拒绝/u);
  const decide = state.audits.find((entry) => entry.phase === 'decide');
  assert.equal(decide.source, 'llm');
  // 正时限对照（与零值路径的分界）：开卡模式下卡片照常随审查弹出、结算时正确撤回——
  // 该路径有 await 竞速边界，宿主撤回通道可观测投影信号。
  assert.equal(state.nextCalls, 1, '正时限：卡片随审查开始弹出');
  assert.equal(state.aborts.length, 1, '超时结算撤回已弹卡片（waterfall + cancel 成对）');
  assert.equal(state.pending.filter((entry) => entry.op === 'set').length, 1, 'reviewing 卡片状态在场');
});

test('路径 3：reviewer.timeoutMs=0 立即超时（不开始尝试，环节记装配，不弹卡＋计数）', async () => {
  const { rt, state, next } = makeRt(baseConfig({ reviewer: { timeoutMs: 0 } }));
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'rejected');
  // 不开始尝试：review 从未被调用、审查信号不存在。
  assert.equal(state.reviewSignals.length, 0);
  assert.match(state.injections[0], /超时环节：装配超时/u);
  assert.doesNotMatch(state.injections[0], /ms/u);
  // 零值/装配耗尽先于弹卡拒绝：默认 humanCardDuringReview=true 也不调
  // next()——立即结算与收尾信号恢复同拍完成，先弹后撤的卡片会残留为可操作的孤儿分发；
  // 一张弹出即撤的卡片展示的也是一次从未开始的尝试。不弹卡即无撤回动作。
  assert.equal(state.nextCalls, 0, '零值路径不调 next()：不弹卡');
  assert.equal(state.aborts.length, 0, '无卡可撤：无撤回动作');
  // 卡片状态表零登记（客户端无瞬态、无残留条目可轮询）；收尾 clear 照常执行。
  assert.equal(state.pending.filter((entry) => entry.op === 'set').length, 0, '不注册卡片状态');
  assert.equal(state.pending.filter((entry) => entry.op === 'clear').length, 1, '收尾清理照常');
  assert.equal(state.audits.some((entry) => entry.phase === 'handoff'), false, '无 handoff 行');
  assert.equal(state.settles.length, 1, '结算恰一条');
  assert.equal(state.countTimeouts, 1, '零值立即到点与真实超时同一路径计数（design §5.3）');
  const decide = state.audits.find((entry) => entry.phase === 'decide');
  assert.equal(decide.source, 'timeout');
  assert.equal(decide.decision, 'rejected');
  assert.equal(state.settles[0].stage, 'assembly');
});

// ── 零值/装配耗尽的弹卡边界（design §4.3）对照 ───────────────────────────────

test('零值 × 关卡（humanCardDuringReview=false）：与开卡一致——不弹卡、按装配超时拒绝', async () => {
  const { rt, state, next } = makeRt(baseConfig({ reviewer: { timeoutMs: 0 }, ui: { humanCardDuringReview: false } }));
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'rejected');
  // 关卡开关不改变零值路径：两条开关态在同一分支结算（不弹卡）。
  assert.equal(state.nextCalls, 0);
  assert.equal(state.aborts.length, 0);
  assert.equal(state.pending.filter((entry) => entry.op === 'set').length, 0);
  assert.equal(state.settles[0].stage, 'assembly');
  assert.equal(state.settles[0].source, 'timeout');
  assert.match(state.injections[0], /超时环节：装配超时/u);
});

test('零值起算组合：timeoutFrom=request/handoff 在审查零值下等价（同一分支结算）', async () => {
  for (const timeoutFrom of ['request', 'handoff']) {
    const { rt, state, next } = makeRt(
      baseConfig({ reviewer: { timeoutMs: 0 }, human: { timeoutMs: 5000, timeoutFrom } }),
    );
    assert.equal(await onApprovalRequest(request(), next, rt), 'rejected', `timeoutFrom=${timeoutFrom}`);
    assert.equal(state.nextCalls, 0, `timeoutFrom=${timeoutFrom}：零值路径不弹卡`);
    assert.equal(state.settles.length, 1, `timeoutFrom=${timeoutFrom}：结算恰一条`);
    assert.equal(state.settles[0].source, 'timeout', `timeoutFrom=${timeoutFrom}：按超时结算`);
    assert.equal(state.settles[0].stage, 'assembly', `timeoutFrom=${timeoutFrom}：环节记装配`);
  }
});

test('路径 4：req.signal abort → cancelled，不注入', async () => {
  const controller = new AbortController();
  const { rt, state, next } = makeRt(baseConfig({ reviewer: { timeoutMs: 30000 } }), {
    reviewDelayMs: 50,
  });
  const promise = onApprovalRequest(request(controller.signal), next, rt);
  await tick();
  controller.abort();
  const outcome = await promise;
  assert.equal(outcome, 'cancelled');
  assert.equal(state.injections.length, 0);
  const decide = state.audits.find((entry) => entry.phase === 'decide');
  assert.equal(decide.source, 'signal');
  assert.equal(decide.decision, 'cancelled');
});

test('路径 5：fallback=ask，人工先答 → 人工结果，审查被取消', async () => {
  const { rt, state, next } = makeRt(baseConfig({ fallback: 'ask', reviewer: { timeoutMs: 30000 } }), {
    verdict: { decision: 'deny', risk: 'high', authorization: 'low', reason: 'risky', toolCalls: 0, fields: { risk: 'high', auth: 'low', tools: 0, degraded: 'none' } },
  });
  const promise = onApprovalRequest(request(), next, rt);
  await tick();
  assert.equal(state.nextCalls, 1);
  state.nextResolvers[0]('allowed-once');
  const outcome = await promise;
  assert.equal(outcome, 'allowed-once');
  const sources = state.audits.filter((entry) => entry.phase === 'decide').map((entry) => entry.source);
  assert.deepEqual(sources, ['human']);
});

test('路径 5：fallback=ask，审查未放行 → handoff 审计，人工超时 → rejected + 注入', async () => {
  const { rt, state, next } = makeRt(baseConfig({ fallback: 'ask', human: { timeoutMs: 20, timeoutFrom: 'request' }, reviewer: { timeoutMs: 30000 } }), {
    verdict: { decision: 'deny', risk: 'medium', authorization: 'low', reason: 'needs human', toolCalls: 0, fields: { risk: 'medium', auth: 'low', tools: 0, degraded: 'none' } },
  });
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'rejected');
  assert.match(state.injections[0], /超时环节：人工未在时限内响应 20 ms/u);
  assert.doesNotMatch(state.injections[0], /不要用等价手段绕过该拒绝/u);
  assert.ok(state.audits.some((entry) => entry.phase === 'handoff' && entry.decision === 'ask'));
  const decide = state.audits.find((entry) => entry.phase === 'decide');
  assert.equal(decide.source, 'timeout');
  assert.equal(decide.inject, 'yes');
});

test('路径 5：timeoutFrom=handoff 时交人工后新建完整计时器', async () => {
  const { rt, state, next } = makeRt(
    baseConfig({ fallback: 'ask', human: { timeoutMs: 30, timeoutFrom: 'handoff' }, reviewer: { timeoutMs: 30000 } }),
    {
      verdict: { decision: 'error', reason: 'llm down', toolCalls: 0, fields: { risk: undefined, auth: undefined, tools: 0, degraded: 'none' } },
    },
  );
  const promise = onApprovalRequest(request(), next, rt);
  await tick();
  await delay(50);
  const outcome = await promise;
  assert.equal(outcome, 'rejected');
  // 交人工后新建的完整计时器（30ms）在场——装配计时器（label=assembly）不与其混同。
  assert.ok(state.timers.some((entry) => entry.ms === 30 && entry.label === 'human'));
});

test('路径 5：交人工阶段 req.signal abort → cancelled（source=signal）', async () => {
  const controller = new AbortController();
  const { rt, state, next } = makeRt(baseConfig({ fallback: 'ask', human: { timeoutMs: 5000, timeoutFrom: 'request' }, reviewer: { timeoutMs: 30000 } }), {
    verdict: { decision: 'deny', reason: 'x', toolCalls: 0, fields: {} },
  });
  const promise = onApprovalRequest(request(controller.signal), next, rt);
  await tick();
  controller.abort();
  const outcome = await promise;
  assert.equal(outcome, 'cancelled');
  const decide = state.audits.find((entry) => entry.phase === 'decide');
  assert.equal(decide.source, 'signal');
});

test('skip 路径原样下传且 next() 只调用一次', async () => {
  const { rt, state, next } = makeRt(baseConfig(), { pre: { action: 'skip', why: 'not a sandbox escalation', fields: { action: 'skip' } } });
  const promise = onApprovalRequest(request(), next, rt);
  await tick();
  assert.equal(state.nextCalls, 1);
  state.nextResolvers[0]('allowed-once');
  assert.equal(await promise, 'allowed-once');
  assert.equal(state.injections.length, 0);
  // 三类跳过留一行 screen skip 审计（rt.gateSkip 缺省＝不去重，保底可观测）。
  assert.equal(state.audits.length, 1);
  assert.equal(state.audits[0].phase, 'screen');
  assert.equal(state.audits[0].action, 'skip');
  assert.equal(state.audits[0].reason, 'not a sandbox escalation');
});

test('插件内部异常：fail-closed 为 rejected + 注入 + 撤回，相位为 error', async () => {
  const { rt, state, next } = makeRt(baseConfig(), { configThrows: true });
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'rejected');
  assert.equal(state.nextCalls, 0);
  assert.equal(state.injections.length, 1);
  assert.match(state.injections[0], /审查器内部错误/);
  const audit = state.audits.find((entry) => entry.phase === 'error');
  assert.equal(audit.source, 'error');
  assert.equal(audit.decision, 'rejected');
  assert.equal(audit.inject, 'yes');
  assert.match(audit.reason, /cfg boom/);
});

test('ui.inject=reject：放行不注入，拒绝注入', async () => {
  const allowed = makeRt(baseConfig({ ui: { inject: 'reject' } }));
  assert.equal(await onApprovalRequest(request(), allowed.next, allowed.rt), 'allowed-once');
  assert.equal(allowed.state.injections.length, 0);
  assert.equal(allowed.state.audits.find((entry) => entry.phase === 'decide').inject, 'no');

  const denied = makeRt(baseConfig({ ui: { inject: 'reject' } }), {
    verdict: { decision: 'deny', reason: 'nope', toolCalls: 0, fields: {} },
  });
  assert.equal(await onApprovalRequest(request(), denied.next, denied.rt), 'rejected');
  assert.equal(denied.state.injections.length, 1);
  assert.equal(denied.state.audits.find((entry) => entry.phase === 'decide').inject, 'yes');
});

test('ui.inject=off：放行与拒绝都不注入，审计记 inject=no', async () => {
  const allowed = makeRt(baseConfig({ ui: { inject: 'off' } }));
  assert.equal(await onApprovalRequest(request(), allowed.next, allowed.rt), 'allowed-once');
  assert.equal(allowed.state.injections.length, 0);

  const denied = makeRt(baseConfig({ ui: { inject: 'off' } }), {
    verdict: { decision: 'deny', reason: 'nope', toolCalls: 0, fields: {} },
  });
  assert.equal(await onApprovalRequest(request(), denied.next, denied.rt), 'rejected');
  assert.equal(denied.state.injections.length, 0);
  assert.equal(denied.state.audits.find((entry) => entry.phase === 'decide').inject, 'no');
});

test('规则拒绝在 ui.inject=off 下也不注入', async () => {
  const { rt, state, next } = makeRt(baseConfig({ ui: { inject: 'off' } }), {
    pre: { action: 'deny', why: 'deny pattern', reason: '命令命中规则', fields: { action: 'deny', tool: 'pwsh' } },
  });
  assert.equal(await onApprovalRequest(request(), next, rt), 'rejected');
  assert.equal(state.injections.length, 0);
  assert.equal(state.audits.find((entry) => entry.phase === 'screen').inject, 'no');
});

test('注入文本按 ui.injectMaxBytes 截断并留痕', async () => {
  const { rt, state, next } = makeRt(baseConfig({ ui: { inject: 'all', injectMaxBytes: 64 } }));
  assert.equal(await onApprovalRequest(request(), next, rt), 'allowed-once');
  assert.match(state.injections[0], /<truncated bytes="\d+" \/>/);
  assert.ok(Buffer.byteLength(state.injections[0], 'utf8') <= 64);
});

test('预设未命中时完全不介入：不调 configFor、不注入', async () => {
  const { rt, state, next } = makeRt(baseConfig(), { mode: 'off' });
  const promise = onApprovalRequest(request(), next, rt);
  await tick();
  assert.equal(state.nextCalls, 1);
  state.nextResolvers[0]('rejected');
  assert.equal(await promise, 'rejected');
  assert.equal(state.injections.length, 0);
  assert.equal(state.audits.length, 0);
});

test('审查函数抛错：fallback=reject 时 fail-closed 拒绝并注入', async () => {
  const { rt, state, next } = makeRt(baseConfig(), { reviewThrows: true });
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'rejected');
  assert.equal(state.injections.length, 1);
  const decide = state.audits.find((entry) => entry.phase === 'decide');
  assert.equal(decide.source, 'llm');
  assert.equal(decide.inject, 'yes');
});

test('审查函数抛错：fallback=ask 时按设计交人工，人工不答则超时拒绝', async () => {
  const { rt, state, next } = makeRt(baseConfig({ fallback: 'ask', human: { timeoutMs: 20, timeoutFrom: 'request' } }), { reviewThrows: true });
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'rejected');
  assert.ok(state.audits.some((entry) => entry.phase === 'handoff'));
});

test('finally 清理全部计时器与监听器', async () => {
  const { rt, state, next } = makeRt(baseConfig({ fallback: 'ask', human: { timeoutMs: 5000, timeoutFrom: 'request' } }));
  const promise = onApprovalRequest(request(), next, rt);
  await tick();
  state.nextResolvers[0]('rejected');
  await promise;
  for (const timer of state.timers) assert.equal(timer.cleared, true, '计时器未清理');
  for (const cancel of state.cancels) assert.equal(cancel.cleared, true, '监听器未清理');
});

test('rejectText 输出注入模板并含风险与授权', () => {
  const text = rejectText('reason here', { risk: 'high', auth: 'unknown' });
  assert.match(text, /本次升权请求被拒绝/);
  assert.match(text, /风险：high；授权证据：unknown/);
  assert.match(text, /不要用等价手段绕过该拒绝/);
});

test('allowText 含工具、命令与理由', () => {
  const text = allowText({ tool: 'pwsh', command: 'npm i', reason: '常见安装命令' });
  assert.match(text, /已自动放行/);
  assert.match(text, /工具：pwsh/);
  assert.match(text, /命令：npm i/);
  assert.match(text, /理由：常见安装命令/);
});

test('timeoutText：三种来源各自成句，且不带「绕过该拒绝」末句', () => {
  const review = timeoutText('review', 90000);
  assert.match(review, /自动审批未在时限内完成（超时）/u);
  assert.match(review, /超时环节：审查超时 90000 ms/u);
  assert.match(review, /可以直接重试/u);
  assert.match(timeoutText('human', 300000), /超时环节：人工未在时限内响应 300000 ms/u);
  assert.match(timeoutText('queue', 30000), /超时环节：排队超时 30000 ms/u);
  // 时限未知（0 / 缺失）时不写毫秒数，句子仍然成立。
  assert.match(timeoutText('review', 0), /超时环节：审查超时\n/u);
  assert.doesNotMatch(timeoutText('queue', undefined), /不要用等价手段绕过该拒绝/u);
});

test('关闭弹卡（requirements §4.1）：审查期间不调 next()，allow 时全程无卡片', async () => {
  const { rt, state, next } = makeRt(baseConfig({ fallback: 'ask', ui: { humanCardDuringReview: false } }));
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'allowed-once');
  // 人工通道从未被打开：卡片不该在审查期间出现（requirements §4.1 humanCardDuringReview）。
  assert.equal(state.nextCalls, 0);
  assert.equal(state.aborts.length, 0, '未取用卡片就无需撤回');
});

test('关闭弹卡：deny + ask 时交人工才调 next()，且只调一次', async () => {
  const { rt, state, next } = makeRt(
    baseConfig({ fallback: 'ask', human: { timeoutMs: 5000, timeoutFrom: 'handoff' }, ui: { humanCardDuringReview: false } }),
    { verdict: { decision: 'deny', reason: 'risky', toolCalls: 0, fields: { risk: 'high', auth: 'low', tools: 0, degraded: 'none' } } },
  );
  const promise = onApprovalRequest(request(), next, rt);
  await tick();
  await tick();
  assert.equal(state.nextCalls, 1, '交人工时调用 next()');
  assert.ok(state.audits.some((entry) => entry.phase === 'handoff' && entry.decision === 'ask'));
  // 状态表先写 reviewing，再在交人工时改写成 waiting-human 并带上原因类别与理由（design §7.4）。
  const sets = state.pending.filter((entry) => entry.op === 'set');
  const states = sets.map((entry) => entry.state);
  assert.deepEqual(states, ['reviewing', 'waiting-human']);
  assert.equal(sets[1].cause, 'deny', '模型判定拒绝交人工：cause=deny');
  assert.equal(sets[1].reason, 'risky');
  assert.equal(sets[1].deadlineKind, 'human', '交人工后倒计时按人工截止时间分派');
  assert.ok(sets[1].deadlineAt - Date.now() > 0, '人工时限为正数');
  state.nextResolvers[0]('rejected');
  const outcome = await promise;
  assert.equal(outcome, 'rejected');
  // 结算后必须清理状态条目，客户端据此停止轮询。
  assert.ok(state.pending.some((entry) => entry.op === 'clear' && entry.callId === 'call_1' && entry.sessionId === 's1'));
});

test('关闭弹卡：timeoutFrom=request 且剩余≤0 时不弹卡，直接按人工超时结算', async () => {
  const { rt, state, next } = makeRt(
    baseConfig({ fallback: 'ask', human: { timeoutMs: 30, timeoutFrom: 'request' }, reviewer: { timeoutMs: 2000 }, ui: { humanCardDuringReview: false } }),
    { reviewDelayMs: 60, verdict: { decision: 'deny', reason: 'late', toolCalls: 0, fields: {} } },
  );
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'rejected');
  // 审查耗尽人工预算：不许闪一张卡片出来（requirements §4.2 剩余时间条款）。
  assert.equal(state.nextCalls, 0);
  assert.match(state.injections[0], /超时环节：人工未在时限内响应 30 ms/u);
  // 没有真的交人工，就不该留下 handoff 行；结算行仍是超时来源。
  assert.equal(state.audits.some((entry) => entry.phase === 'handoff'), false, '预算耗尽时不应写 handoff 行');
  assert.equal(state.audits.find((entry) => entry.phase === 'decide').source, 'timeout');
});

test('卡片状态（requirements §6.3／design §7.4）：reviewing 带审查时限，超时转人工时换成人工时限', async () => {
  const { rt, state, next } = makeRt(
    baseConfig({ fallback: 'ask', reviewer: { timeoutMs: 20 }, human: { timeoutMs: 4000, timeoutFrom: 'handoff' } }),
    { reviewDelayMs: 200, verdict: { decision: 'allow', reason: 'late', toolCalls: 0, fields: {} } },
  );
  const promise = onApprovalRequest(request(), next, rt);
  await tick();
  const first = state.pending.find((entry) => entry.op === 'set');
  assert.equal(first.state, 'reviewing');
  assert.equal(first.deadlineKind, 'review');
  // 截止起点回溯请求进入时刻（requirements §4.2：装配消耗同一份预算）——与状态条登记点的
  // 差 ≤ 时限值，慢机下不小于时限减去装配余量。
  assert.ok(first.deadlineAt - first.startedAt <= 20 && first.deadlineAt - first.startedAt >= 10);
  await delay(40);
  await tick();
  const second = state.pending.filter((entry) => entry.op === 'set')[1];
  assert.equal(second.state, 'waiting-human', '审查超时后状态转 waiting-human（design §7.4）');
  assert.equal(second.cause, 'timeout', '审查超时交人工：cause=timeout');
  assert.equal(second.deadlineKind, 'human');
  assert.ok(second.deadlineAt - Date.now() > 0, '人工时限为正数');
  state.nextResolvers[0]('rejected');
  await promise;
});

test('卡片状态 cause=error（design §7.4）：通道故障交人工时 cause=error 并带故障理由', async () => {
  const { rt, state, next } = makeRt(
    baseConfig({ fallback: 'ask', reviewer: { timeoutMs: 30000 }, human: { timeoutMs: 5000, timeoutFrom: 'handoff' } }),
    { verdict: { decision: 'error', reason: 'empty output', toolCalls: 0, fields: {} } },
  );
  const promise = onApprovalRequest(request(), next, rt);
  await tick();
  await tick();
  const sets = state.pending.filter((entry) => entry.op === 'set');
  assert.equal(sets[1].state, 'waiting-human');
  assert.equal(sets[1].cause, 'error', 'error 判定（未超时）交人工：cause=error');
  assert.equal(sets[1].reason, 'empty output', '通道故障理由随状态透传');
  assert.equal(sets[1].deadlineKind, 'human');
  state.nextResolvers[0]('rejected');
  await promise;
});

test('人工时限为 0 时不登记人工阶段卡片状态，交人工立即按拒绝结算（requirements §4.2）', async () => {
  const { rt, state, next } = makeRt(
    baseConfig({ fallback: 'ask', reviewer: { timeoutMs: 30000 }, human: { timeoutMs: 0, timeoutFrom: 'handoff' } }),
    { verdict: { decision: 'deny', reason: 'x', toolCalls: 0, fields: {} } },
  );
  const promise = onApprovalRequest(request(), next, rt);
  await tick();
  await tick();
  // reviewing 状态恒带审查截止（design §7.4）；
  // 人工阶段零时限：不登记无截止时间的人工待决状态（§4.3），立即按拒绝结算。
  const sets = state.pending.filter((entry) => entry.op === 'set');
  assert.equal(sets.length, 1, '只有 reviewing 一条，没有人工阶段状态');
  assert.equal(sets[0].state, 'reviewing');
  assert.ok(Number.isFinite(sets[0].deadlineAt), '审查截止恒有值');
  assert.equal(sets[0].deadlineKind, 'review');
  // 卡片在入口弹出（humanCardDuringReview 默认开）后立即被超时结算撤回：没有人工等待段。
  assert.equal(state.nextCalls, 1);
  const outcome = await promise;
  assert.equal(outcome, 'rejected');
});

test('handoff 起算＋人工零时限＋关弹卡时不弹马上消失的卡片（requirements §4.2）', async () => {
  const { rt, state, next } = makeRt(
    baseConfig({
      fallback: 'ask',
      reviewer: { timeoutMs: 30000 },
      human: { timeoutMs: 0, timeoutFrom: 'handoff' },
      ui: { humanCardDuringReview: false },
    }),
    { verdict: { decision: 'deny', reason: 'x', toolCalls: 0, fields: {} } },
  );
  const promise = onApprovalRequest(request(), next, rt);
  await tick();
  await tick();
  // 关闭「审查期间弹卡」＋handoff 起算＋人工时限 0：交人工即耗尽，一次都不该调 next()
  // （弹了马上撤回＝requirements §4.2 禁止的马上消失卡片），直接按人工超时结算。
  assert.equal(state.nextCalls, 0, '零时限人工不弹卡：next() 一次都不调');
  const outcome = await promise;
  assert.equal(outcome, 'rejected');
  const decide = state.audits.find((entry) => entry.phase === 'decide');
  assert.equal(decide.source, 'timeout', '按人工超时结算');
  assert.equal(state.audits.some((entry) => entry.phase === 'handoff'), false, '没有真的交人工：不写 handoff 行');
  const settle = state.settles.at(-1);
  assert.equal(settle.outcome, 'rejected');
  assert.equal(settle.source, 'timeout');
  assert.equal(settle.stage, 'human', '环节是人工（虽然未真的等待）');
  assert.equal(settle.humanWaitMs, undefined, '未交人工：humanWaitMs 缺失');
});

// ── 人工 request 起算的预算覆盖装配前置等待 ────────────────────
// 组义（G1–G10 为套内自编组号）：验证 human.timeoutFrom='request' 时人工预算的起算点、
// 装配等待对预算的消耗、耗尽语义（不弹卡/不 next）与交人工后的计时器重建、取消与迟到结算。

test('G1 request 起算：configFor 延迟 100ms 耗尽 20ms 人工预算 → 不调 next，按人工超时拒绝（关卡）', async () => {
  const { rt, state, next } = makeRt(
    baseConfig({ fallback: 'ask', human: { timeoutMs: 20, timeoutFrom: 'request' }, reviewer: { timeoutMs: 2000 }, ui: { humanCardDuringReview: false } }),
    { configForDelayMs: 100, verdict: { decision: 'deny', reason: 'late', toolCalls: 0, fields: {} } },
  );
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'rejected');
  assert.equal(state.nextCalls, 0, '预算耗尽：不调人工 next（关卡不弹卡）');
  // 结算恰一条：source=timeout、stage=human、humanWaitMs 缺失（未真的交人工）。
  const settle = state.settles.at(-1);
  assert.equal(settle.outcome, 'rejected');
  assert.equal(settle.source, 'timeout');
  assert.equal(settle.stage, 'human');
  assert.equal(settle.humanWaitMs, undefined, '未交人工：humanWaitMs 缺失');
  assert.equal(state.audits.some((entry) => entry.phase === 'handoff'), false, '无 handoff 行');
  assert.match(state.injections[0], /超时环节：人工未在时限内响应 20 ms/u, '注入超时文案环节为人工');
  // 未建任何人工计时器：预算耗尽不重新赠予全额。
  assert.equal(state.timers.some((entry) => entry.label === 'human'), false, '预算耗尽不建人工计时器');
});

test('G2 request 起算：装配等待已耗尽预算时，开卡模式弹卡后立即超时撤回（与人工 0 同权）', async () => {
  const { rt, state, next } = makeRt(
    baseConfig({ fallback: 'ask', human: { timeoutMs: 20, timeoutFrom: 'request' }, reviewer: { timeoutMs: 2000 } }),
    { configForDelayMs: 100, verdict: { decision: 'deny', reason: 'late', toolCalls: 0, fields: {} } },
  );
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'rejected');
  // 开卡模式：卡片随审查开始弹出（nextCalls=1），随后被立即结算撤回。
  assert.equal(state.nextCalls, 1, '卡片随审查开始弹出恰一次');
  const sets = state.pending.filter((entry) => entry.op === 'set');
  assert.equal(sets.length, 1, '只有 reviewing 状态，无 waiting-human');
  assert.equal(sets[0].state, 'reviewing');
  const clears = state.pending.filter((entry) => entry.op === 'clear');
  assert.equal(clears.length, 1, '状态条目清理恰一次');
  assert.equal(state.aborts.length, 1, '撤回（withdraw.abort）被调用');
  const settle = state.settles.at(-1);
  assert.equal(settle.source, 'timeout');
  assert.equal(settle.stage, 'human');
  // 直接断言未建任何人工计时器：错误实现建全额计时器后到点结算时其余断言照过，本断言拦截。
  assert.equal(state.timers.some((entry) => entry.label === 'human'), false, '耗尽预算不建人工计时器（不重新赠予）');
});

test('G3 request 起算：预算尚有余额 → 交人工计时器只用剩余', async () => {
  const { rt, state, next } = makeRt(
    baseConfig({ fallback: 'ask', human: { timeoutMs: 100, timeoutFrom: 'request' }, reviewer: { timeoutMs: 2000 } }),
    { configForDelayMs: 30, verdict: { decision: 'deny', reason: 'risky', toolCalls: 0, fields: {} } },
  );
  const promise = onApprovalRequest(request(), next, rt);
  // 等装配延迟（30ms）与审查完成后再观测（setImmediate 不跨真实定时器）。
  await delay(60);
  await tick();
  await tick();
  assert.ok(state.audits.some((entry) => entry.phase === 'handoff'), '预算有余额：真的交人工');
  const humanTimer = state.timers.find((entry) => entry.label === 'human');
  assert.ok(humanTimer, '交人工建立计时器');
  assert.ok(humanTimer.ms <= 70, `人工计时器只用剩余预算（≤70ms，实际 ${humanTimer.ms}）`);
  state.nextResolvers[0]('rejected');
  const outcome = await promise;
  assert.equal(outcome, 'rejected');
  const settle = state.settles.at(-1);
  assert.equal(settle.source, 'human', '人工作答后按 human 结算');
});

test('G4 request 起算：waiting-human 的可见截止时间从请求进入起算', async () => {
  const { rt, state, next } = makeRt(
    baseConfig({ fallback: 'ask', human: { timeoutMs: 200, timeoutFrom: 'request' }, reviewer: { timeoutMs: 2000 } }),
    { configForDelayMs: 50, verdict: { decision: 'deny', reason: 'risky', toolCalls: 0, fields: {} } },
  );
  const entry = Date.now();
  const promise = onApprovalRequest(request(), next, rt);
  // 等装配延迟（50ms）与审查完成后再观测。
  await delay(90);
  await tick();
  await tick();
  const waiting = state.pending.filter((entry_) => entry_.op === 'set').find((entry_) => entry_.state === 'waiting-human');
  assert.ok(waiting, '应进入 waiting-human');
  // 筛查时刻＝reviewing 状态登记的 startedAt（screen 之后、configFor 延迟已消耗）。
  const reviewing = state.pending.filter((entry_) => entry_.op === 'set').find((entry_) => entry_.state === 'reviewing');
  assert.ok(reviewing, '应有 reviewing 状态');
  // 截止时间＝请求进入＋全额：从 entry 起算不超全额＋容差（定时器精度），且严格早于「筛查时刻＋全额」
  // （configFor 延迟 50ms 保证两时刻可区分），证明起点在装配之前。
  assert.ok(waiting.deadlineAt - entry <= 200 + 60, `deadlineAt 应从请求进入起算（entry+200±容差，差 ${waiting.deadlineAt - entry}）`);
  assert.ok(waiting.deadlineAt < reviewing.startedAt + 200, `deadlineAt 严格早于筛查时刻+全额（${waiting.deadlineAt} < ${reviewing.startedAt + 200}）`);
  state.nextResolvers[0]('rejected');
  await promise;
});

test('G5 handoff 起算：装配等待不改变交人工后的全额计时器', async () => {
  const { rt, state, next } = makeRt(
    baseConfig({ fallback: 'ask', human: { timeoutMs: 300, timeoutFrom: 'handoff' }, reviewer: { timeoutMs: 2000 } }),
    { configForDelayMs: 100, verdict: { decision: 'deny', reason: 'risky', toolCalls: 0, fields: {} } },
  );
  const promise = onApprovalRequest(request(), next, rt);
  // 等装配延迟（100ms）与审查完成后再观测。
  await delay(140);
  await tick();
  await tick();
  const humanTimer = state.timers.find((entry) => entry.label === 'human');
  assert.ok(humanTimer, 'handoff 起算建立人工计时器');
  assert.equal(humanTimer.ms, 300, 'handoff 起算给全额（装配等待不吃预算）');
  state.nextResolvers[0]('rejected');
  await promise;
});

test('G6 request 起算＋人工 0：两态各自立即拒绝（现行语义钉回归）', async () => {
  // 开卡：卡片随审查开始弹出后立即被超时结算撤回。
  const open = makeRt(
    baseConfig({ fallback: 'ask', human: { timeoutMs: 0, timeoutFrom: 'request' }, reviewer: { timeoutMs: 2000 } }),
    { verdict: { decision: 'deny', reason: 'x', toolCalls: 0, fields: {} } },
  );
  const openOutcome = await onApprovalRequest(request(), open.next, open.rt);
  assert.equal(openOutcome, 'rejected');
  assert.equal(open.state.nextCalls, 1, '开卡模式：入口弹卡恰一次');
  assert.equal(open.state.pending.filter((e) => e.op === 'set').length, 1, '只有 reviewing');
  assert.equal(open.state.pending.filter((e) => e.op === 'clear').length, 1, '弹卡立即撤回');

  // 关卡：审查后不调 next 直接超时。
  const closed = makeRt(
    baseConfig({ fallback: 'ask', human: { timeoutMs: 0, timeoutFrom: 'request' }, reviewer: { timeoutMs: 2000 }, ui: { humanCardDuringReview: false } }),
    { verdict: { decision: 'deny', reason: 'x', toolCalls: 0, fields: {} } },
  );
  const closedOutcome = await onApprovalRequest(request(), closed.next, closed.rt);
  assert.equal(closedOutcome, 'rejected');
  assert.equal(closed.state.nextCalls, 0, '关卡模式：一次都不调 next');
  assert.equal(closed.state.settles.at(-1).source, 'timeout');
});

test('G7 无头：request 起算预算耗尽语义不变——不弹卡、不 next、不 handoff，审查照常按拒绝结算', async () => {
  const { rt, state, next } = makeRt(
    baseConfig({ fallback: 'ask', human: { timeoutMs: 20, timeoutFrom: 'request' }, reviewer: { timeoutMs: 2000 } }),
    { isHeadless: true, configForDelayMs: 100, verdict: { decision: 'deny', reason: '高危命令', toolCalls: 0, fields: {} } },
  );
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'rejected', '无头无人工通道：审查拒绝照常生效');
  assert.equal(state.nextCalls, 0);
  assert.equal(state.pending.filter((entry) => entry.op === 'set').length, 0, 'pending 状态表零写入');
  assert.equal(state.audits.some((entry) => entry.phase === 'handoff'), false, '无 handoff 行');
});

test('G8 装配等待期间请求取消 → cancelled，不悬挂', async () => {
  const { rt, state, next } = makeRt(
    baseConfig({ fallback: 'ask', human: { timeoutMs: 5000, timeoutFrom: 'request' }, reviewer: { timeoutMs: 2000 } }),
    { configForDelayMs: 100, reviewDelayMs: 50, verdict: { decision: 'allow', reason: 'ok', toolCalls: 0, fields: {} } },
  );
  const controller = new AbortController();
  const promise = onApprovalRequest(request(controller.signal), next, rt);
  await delay(30);
  controller.abort('user cancelled');
  const outcome = await promise;
  assert.equal(outcome, 'cancelled');
  const settle = state.settles.at(-1);
  assert.equal(settle.outcome, 'cancelled');
  assert.equal(settle.source, 'signal', '取消来源是请求信号');
});

test('G9 预算耗尽立即结算后，迟到的 allow 不改判、不重复通知（含 G10 资源清理断言）', async () => {
  const { rt, state, next } = makeRt(
    baseConfig({ fallback: 'ask', human: { timeoutMs: 20, timeoutFrom: 'request' }, reviewer: { timeoutMs: 2000 } }),
    { configForDelayMs: 100, reviewDelayMs: 120, verdict: { decision: 'allow', reason: 'late ok', toolCalls: 0, fields: {} } },
  );
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'rejected');
  assert.equal(state.settles.filter((entry) => entry.outcome === 'rejected').length, 1, '结算恰一条 rejected');
  assert.equal(state.audits.filter((entry) => entry.phase === 'decide').length, 1, 'decide 行恰一条');
  assert.equal(state.injections.length, 1, '无第二次注入');
  // G10：计时器与监听器全清理、pending 清理恰一次。
  await tick();
  assert.ok(state.timers.every((entry) => entry.cleared === true), '全部计时器已清理');
  assert.ok(state.cancels.every((entry) => entry.cleared === true), '全部监听器已清理');
  assert.equal(state.pending.filter((entry) => entry.op === 'clear').length, 1, 'pending 清理恰一次');
});

// ── 装配并入审查时限 ──────────────────────────────────────────────

test('装配挂死：装配计时器按先验真实时限到点 → rejected/timeout，环节记装配，与真实超时同路计数', async () => {
  const { rt, state, next } = makeRt(baseConfig({ reviewer: { timeoutMs: 30000 } }), {
    configForNever: true,
    verdict: { decision: 'allow', reason: 'never reached', toolCalls: 0, fields: {} },
  });
  const promise = onApprovalRequest(request(), next, rt);
  await tick();
  const assemblyTimer = state.timers.find((entry) => entry.label === 'assembly' && entry.cleared === false);
  assert.ok(assemblyTimer, '装配计时器在场');
  assert.equal(assemblyTimer.ms, 30000, '装配计时器取先验真实时限（非固定内部上限，design §4.3）');
  assemblyTimer.fire();
  const outcome = await promise;
  assert.equal(outcome, 'rejected');
  assert.equal(state.reviewSignals.length, 0, '审查从未开始');
  assert.equal(state.nextCalls, 0, '卡片未弹（装配期无人工）');
  assert.match(state.injections[0], /超时环节：装配超时 30000 ms/u);
  assert.equal(state.countTimeouts, 1, '装配超时与真实审查超时同一路径计数（design §5.3）');
  const decide = state.audits.find((entry) => entry.phase === 'decide');
  assert.equal(decide.source, 'timeout');
  assert.equal(state.settles[0].source, 'timeout', '装配分支（含回调抛错）按装配超时结算，source=timeout（design §5.3 分置）');
  assert.equal(state.settles[0].stage, 'assembly');
  assert.equal(state.settles[0].outcome, 'rejected');
});

test('装配慢于真实时限：装配计时器按回溯起点到点拒绝（不开始尝试，环节记装配，计数）', async () => {
  const { rt, state, next } = makeRt(baseConfig({ reviewer: { timeoutMs: 30 } }), {
    configForDelayMs: 60,
    verdict: { decision: 'allow', reason: 'never reached', toolCalls: 0, fields: {} },
  });
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'rejected');
  assert.equal(state.reviewSignals.length, 0, '预算被装配耗尽：审查未开始');
  // 装配耗尽与零值同款：检查先于弹卡，默认开卡配置下也不调 next()、无撤回动作、
  // 不注册卡片状态——宿主不会收到弹出即撤的孤儿分发。
  assert.equal(state.nextCalls, 0, '装配耗尽不弹卡（不调 next()）');
  assert.equal(state.aborts.length, 0, '无卡可撤：无撤回动作');
  assert.equal(state.pending.filter((entry) => entry.op === 'set').length, 0, '不注册卡片状态');
  assert.match(state.injections[0], /超时环节：装配超时 30 ms/u);
  assert.equal(state.countTimeouts, 1, '装配耗尽到点与真实超时同一路径计数');
  assert.equal(state.settles[0].stage, 'assembly');
});

test('装配慢但有限不误杀：消耗部分预算后审查照常竞速放行', async () => {
  const { rt, state, next } = makeRt(baseConfig({ reviewer: { timeoutMs: 100 } }), {
    configForDelayMs: 40,
    verdict: { decision: 'allow', reason: 'ok', toolCalls: 0, fields: { risk: 'low', auth: 'high', tools: 0, degraded: 'none' } },
  });
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'allowed-once');
  // 装配计时器已拆（不泄漏）；审查计时器用剩余预算（≤ 100）。
  const assemblyTimers = state.timers.filter((entry) => entry.label === 'assembly');
  assert.ok(assemblyTimers.length >= 1);
  assert.ok(assemblyTimers.every((entry) => entry.cleared === true), '装配备用计时器已清理');
  const reviewTimer = state.timers.find((entry) => entry.label === 'review');
  assert.ok(reviewTimer && reviewTimer.ms <= 100 && reviewTimer.ms >= 1, '审查计时器用剩余预算');
});

test('装配期间取消：不弹卡、不审查，按 cancelled/signal 结算', async () => {  const controller = new AbortController();
  const { rt, state, next } = makeRt(baseConfig({ reviewer: { timeoutMs: 30000 } }), {
    configForDelayMs: 5000,
    reviewDelayMs: 5000,
  });
  const promise = onApprovalRequest(request(controller.signal), next, rt);
  await delay(30);
  controller.abort('user cancelled');
  const outcome = await promise;
  assert.equal(outcome, 'cancelled');
  assert.equal(state.nextCalls, 0);
  assert.equal(state.reviewSignals.length, 0);
  const settle = state.settles.at(-1);
  assert.equal(settle.source, 'signal');
  assert.ok(state.timers.every((entry) => entry.cleared === true), '计时器全清理');
});

test('装配竞速中止回调抛错：保持取消语义，不按装配超时、不计数（requirements §4.2）', async () => {
  const controller = new AbortController();
  const { rt, state, next } = makeRt(baseConfig({ reviewer: { timeoutMs: 30000 } }), {
    configForDelayMs: 5000,
    abortFireThrows: true,
  });
  const promise = onApprovalRequest(request(controller.signal), next, rt);
  await delay(30);
  controller.abort('user cancelled');
  const outcome = await promise;
  assert.equal(outcome, 'cancelled');
  assert.equal(state.countTimeouts, 0, '取消方向不计数（design §5.3）');
  const settle = state.settles.at(-1);
  assert.equal(settle.outcome, 'cancelled');
  assert.equal(settle.source, 'signal');
  assert.equal(state.reviewSignals.length, 0, '审查未开始');
});

test('排队超时（requirements §4.3）：审查层标记 timedOut 与真实环节，注入写明排队超时及排队上限', async () => {
  const { rt, state, next } = makeRt(baseConfig({ concurrency: { queueTimeoutMs: 30000 } }));
  rt.review = async () => ({
    decision: 'error',
    reason: '审查未执行：queue-timeout',
    toolCalls: 0,
    timedOut: true,
    timeoutStage: 'queue',
    timeoutMs: 30000,
    fields: { degraded: 'queue-timeout', tools: 0 },
  });
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'rejected');
  assert.match(state.injections[0], /自动审批未在时限内完成（超时）/u);
  // 环节与时限必须是真的：不能把排队超时写成「审查超时 90000 ms」。
  assert.match(state.injections[0], /超时环节：排队超时 30000 ms/u);
  assert.doesNotMatch(state.injections[0], /审查超时/u);
});

test('超时文案缺环节信息时按审查超时回退（老调用方的兼容路径）', async () => {
  const { rt, state, next } = makeRt(baseConfig({ reviewer: { timeoutMs: 1234 } }));
  rt.review = async () => ({ decision: 'error', reason: '审查未执行：queue-timeout', toolCalls: 0, timedOut: true, fields: {} });
  await onApprovalRequest(request(), next, rt);
  assert.match(state.injections[0], /超时环节：审查超时 1234 ms/u);
});

test('并发占满不冒充超时（requirements §4.3）：queue-overflow 走通道故障文案，既非超时也非拒绝模板', async () => {
  const { rt, state, next } = makeRt(baseConfig());
  rt.review = async () => ({ decision: 'error', reason: '审查未执行：queue-overflow', toolCalls: 0, fields: { degraded: 'queue-overflow', tools: 0 } });
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'rejected');
  assert.match(state.injections[0], /通道故障/u);
  assert.match(state.injections[0], /可以直接重试/u);
  assert.match(state.injections[0], /queue-overflow/u);
  assert.doesNotMatch(state.injections[0], /不要用等价手段绕过该拒绝/u, '调度失败不是安全判定，不得注入绕过禁令');
  assert.doesNotMatch(state.injections[0], /超时环节/u, 'queue-overflow 不是超时，不冒充超时文案');
});

// ── 无头路径（requirements §2.2／design §2.2）：委派子代理没有人工通道 ──────────

test('无头 allow：不调 next()、不写 pending 卡片态，放行注入直达发起者', async () => {
  const { rt, state, next } = makeRt(baseConfig(), { isHeadless: true });
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'allowed-once');
  // 无头：卡片路径完全关闭——next 从未被调用（waterfall 游标未消耗），pending 状态表零写入。
  assert.equal(state.nextCalls, 0);
  assert.equal(state.pending.filter((entry) => entry.op === 'set').length, 0);
  // 收尾清理仍发生（finally 的 clear 无害：表中本无条目）。
  assert.equal(state.pending.filter((entry) => entry.op === 'clear').length, 1);
  assert.equal(state.injections.length, 1);
  assert.match(state.injections[0], /已自动放行/u);
  // 没有卡片被要过来 ⇒ 无撤回动作。
  assert.equal(state.aborts.length, 0);
});

test('无头 reject（fallback=ask 也按拒绝结算）：不 handoff、不 next()，注入拒绝原因', async () => {
  const { rt, state, next } = makeRt(
    baseConfig({ fallback: 'ask' }),
    {
      isHeadless: true,
      // 审查结论闭集是 allow|deny|error（lib/reviewer.js）：deny 判定走拒绝模板（三文案分选）。
      verdict: {
        decision: 'deny',
        reason: '高危：脚本改写系统目录',
        toolCalls: 0,
        fields: { risk: 'high', auth: 'none', tools: 0, degraded: 'none' },
      },
    },
  );
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'rejected');
  assert.equal(state.nextCalls, 0);
  assert.equal(state.pending.filter((entry) => entry.op === 'set').length, 0);
  const handoff = state.audits.find((entry) => entry.phase === 'handoff');
  assert.equal(handoff, undefined);
  assert.equal(state.injections.length, 1);
  assert.match(state.injections[0], /本次升权请求被拒绝/u);
  assert.match(state.injections[0], /高危：脚本改写系统目录/u);
});

test('无头超时（timedOut 判定）：按超时文案拒绝，说明可重试，不 next()', async () => {
  const { rt, state, next } = makeRt(
    baseConfig({ fallback: 'ask', reviewer: { timeoutMs: 1500 } }),
    {
      isHeadless: true,
      verdict: {
        decision: 'error',
        reason: '审查未执行：review timeout',
        toolCalls: 0,
        timedOut: true,
        timeoutStage: 'review',
        timeoutMs: 1500,
        fields: { degraded: 'review-timeout', tools: 0 },
      },
    },
  );
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'rejected');
  assert.equal(state.nextCalls, 0);
  assert.equal(state.pending.filter((entry) => entry.op === 'set').length, 0);
  assert.equal(state.injections.length, 1);
  // 超时文案要点（requirements §4.3）：点明「这是超时」与真实环节/时限，且不含「不要绕过」的拒绝措辞。
  assert.match(state.injections[0], /自动审批未在时限内完成（超时）/u);
  assert.match(state.injections[0], /超时环节：审查超时 1500 ms/u);
  assert.doesNotMatch(state.injections[0], /不要用等价手段绕过该拒绝/u);
});

test('agentLangOf：显式 zh/en 原样，缺失/非法回落 en（回落方向统一）', () => {
  assert.equal(agentLangOf({ language: { agent: 'zh' } }), 'zh');
  assert.equal(agentLangOf({ language: { agent: 'en' } }), 'en');
  assert.equal(agentLangOf({}), 'en', '配置缺失时回落 en（＝schema 默认，与 reviewer/readonly-tools 同向）');
  assert.equal(agentLangOf(undefined), 'en');
  assert.equal(agentLangOf({ language: { agent: 'fr' } }), 'en', '非法值回落 en');
  // 变红判据：若 gate 回落改回 zh，缺失与非法两档断言红；
  // 该回落同时喂给 index 层逃逸注入（runEscape 未配 language 时即走本回落）。
});

test('回落谓词单源（requirements §5.3／design §4.1）：字面谓词在 lib/ 内只许住在 gate.js 的 agentLangOf', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const libDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib');
  const literal = "cfg?.language?.agent === 'zh' ? 'zh' : 'en'";
  const hits = [];
  for (const file of readdirSync(libDir)) {
    if (!file.endsWith('.js')) continue;
    const source = readFileSync(join(libDir, file), 'utf8');
    for (let at = source.indexOf(literal); at !== -1; at = source.indexOf(literal, at + 1)) hits.push(file);
  }
  // 变红判据：在任一 lib 文件里重新内联该谓词，
  // hits 多出一项即红——守住「改一处副本而其余不动不会有测试变红」的缺口。
  assert.deepEqual(hits, ['gate.js']);
});

// ── 计时/中止回调抛错的结算（design §5.3） ──────────────────────────────────

test('审查计时回调抛错：按超时语义拒绝，decide 点明「计时回调抛错（review）」', async () => {
  // 时距拉大（竞速确定性，design §4.1）：计时 40ms vs 审查 5000ms，慢机上也不会拼错时序。
  const { rt, state, next } = makeRt(baseConfig({ reviewer: { timeoutMs: 40 } }), {
    timerFireThrows: 'review',
    reviewDelayMs: 5000,
  });
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'rejected');
  const decide = state.audits.find((row) => row.phase === 'decide');
  assert.equal(decide.decision, 'rejected');
  assert.equal(decide.source, 'error', '回调抛错不是正常超时：source=error 与超时行可区分');
  assert.match(decide.reason, /计时回调抛错（review）/u);
  assert.equal(state.injections.length, 1, '超时语义照常注入');
});

test('中止回调抛错：按取消语义结算，decide 点明「中止回调抛错（request）」', async () => {
  const { rt, state, next } = makeRt(baseConfig(), { abortFireThrows: true, reviewDelayMs: 5000 });
  const controller = new AbortController();
  const promise = onApprovalRequest(request(controller.signal), next, rt);
  await tick();
  controller.abort(new Error('user cancel'));
  assert.equal(await promise, 'cancelled');
  const decide = state.audits.find((row) => row.phase === 'decide');
  assert.equal(decide.decision, 'cancelled');
  assert.equal(decide.source, 'error', '与正常取消的 source=signal 可区分');
  assert.match(decide.reason, /中止回调抛错（request）/u);
  assert.equal(state.injections.length, 0);
});

test('人工计时回调抛错：label=human 按人工超时语义拒绝（内层竞速路径）', async () => {
  const cfg = baseConfig({
    fallback: 'ask',
    reviewer: { timeoutMs: 5000 },
    human: { timeoutMs: 40, timeoutFrom: 'handoff' },
  });
  const { rt, state, next } = makeRt(cfg, {
    timerFireThrows: 'human',
    verdict: { decision: 'deny', risk: 'high', authorization: 'low', reason: 'risky', toolCalls: 0, fields: { risk: 'high', auth: 'low', tools: 0, degraded: 'none' } },
  });
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'rejected');
  const decide = state.audits.find((row) => row.phase === 'decide');
  assert.equal(decide.source, 'error');
  assert.match(decide.reason, /计时回调抛错（human）/u);
});

// ── 迟到结论的 gate 侧行为（design §8.1；迟到不改写结果 requirements §4.1） ────

test('gate 侧：人工抢先结算后迟到的审查照常收尾，decide 行不追加', async () => {
  const cfg = baseConfig({ fallback: 'ask', reviewer: { timeoutMs: 5000 } });
  const { rt, state, next } = makeRt(cfg, { reviewDelayMs: 60 });
  const promise = onApprovalRequest(request(), next, rt);
  await tick();
  state.nextResolvers[0]('allowed-once');
  assert.equal(await promise, 'allowed-once');
  assert.equal(state.audits.filter((row) => row.phase === 'decide').length, 1);
  // 等迟到的审查收尾（5000ms 审查计时器已被 finally 清掉，审查承诺自然完成）。
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
  assert.equal(state.audits.filter((row) => row.phase === 'decide').length, 1, '迟到结论不得追加 decide 行');
});

test('端到端链：审查超时结算后，迟到的 review 行 late=yes 且 decide 恰一行', async () => {
  // 时距 ≥10×（30ms 超时 vs 400ms 审查延迟）：慢机上竞速也不会拼错时序。
  const { rt, state, next } = makeRt(baseConfig({ reviewer: { timeoutMs: 30 } }), {
    reviewDelayMs: 400,
    reviewWritesAudit: true,
  });
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'rejected');
  const decideRows = state.audits.filter((row) => row.phase === 'decide');
  assert.equal(decideRows.length, 1, 'decide 恰一行');
  // 超时由本层计时器驱动、以 error 判定走 review 路（gate.js 超时 onFire）：source=llm，超时语义看注入文案。
  assert.equal(decideRows[0].source, 'llm');
  assert.equal(state.injections.length, 1);
  assert.match(state.injections[0], /超时/u, '按超时语义结算（超时文案）');
  // 超时抢先 abort 审查信号后，审查仍在跑——等它收尾，finish 行必须带 late=yes（整条链一次断完）。
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 600));
  const lateRow = state.audits.find((row) => row.phase === 'review');
  assert.ok(lateRow, '迟到审查收尾必须留下 review 行');
  assert.equal(lateRow.late, 'yes');
  assert.equal(state.audits.filter((row) => row.phase === 'decide').length, 1, '迟到结论不追加 decide');
});

test('逃逸 catch 分支的注入抛错不外逃，error 行留 degraded=inject-fail（design §4.4）', async () => {
  const { rt, state, next } = makeRt(baseConfig());
  rt.configFor = () => {
    throw new Error('config boom');
  };
  rt.inject = () => {
    throw new Error('inject exploded in catch branch');
  };
  // 逃逸 catch 分支的注入同样不得外抛——fail-closed 照常、审计行照写。
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'rejected');
  const errorRow = state.audits.find((row) => row.phase === 'error');
  assert.ok(errorRow, '「审查器内部错误」审计行必须照写');
  assert.match(errorRow.reason, /审查器内部错误：.*config boom/u);
  assert.equal(errorRow.degraded, 'inject-fail');
});

// ── gate 跳过路径的审计去重接线（requirements §5.3／design §8.1） ────────────

test('gate 接线：经 rt.gateSkip 判定，同 (会话, 因) 第二行不写', async () => {
  const calls = [];
  const { rt, state, next } = makeRt(baseConfig(), {
    pre: { action: 'skip', why: 'not a sandbox escalation', fields: { action: 'skip' } },
  });
  rt.gateSkip = (sessionId, why) => {
    calls.push([sessionId, why]);
    return calls.length === 1;
  };
  const first = onApprovalRequest(request(), next, rt);
  await tick();
  state.nextResolvers[0]('allowed-once');
  assert.equal(await first, 'allowed-once');
  const second = onApprovalRequest(request(), next, rt);
  await tick();
  state.nextResolvers[1]('allowed-once');
  assert.equal(await second, 'allowed-once');
  assert.equal(calls.length, 2, '两次跳过各问一次 gateSkip');
  assert.deepEqual(calls[0], ['s1', 'not a sandbox escalation'], '参数为 (会话 id, 跳过原因原文)');
  assert.equal(state.audits.length, 1, '第二次同因跳过被去重');
});

// ── 在册守护的直接用例（design §4.1／§4.4） ────────────────────────────────

test('guardNext：第二次调用抛错（导出直测，design §4.1 next 至多一次）', async () => {
  let calls = 0;
  const guarded = guardNext(async () => {
    calls += 1;
    return 'ok';
  });
  assert.equal(await guarded(), 'ok');
  assert.equal(calls, 1);
  await assert.rejects(async () => guarded(), /next\(\) called twice/u);
});

test('注入通道抛错：结算语义不变，decide 行 degraded 追加 inject-fail（design §4.4）', async () => {
  const allow = makeRt(baseConfig());
  allow.rt.inject = () => {
    throw new Error('inject exploded');
  };
  const outcome = await onApprovalRequest(request(), allow.next, allow.rt);
  assert.equal(outcome, 'allowed-once', '注入失败不得改写结算语义');
  const decide = allow.state.audits.find((row) => row.phase === 'decide');
  assert.equal(decide.degraded, 'inject-fail');

  const deny = makeRt(baseConfig(), {
    verdict: { decision: 'deny', risk: 'high', authorization: 'low', reason: 'risky', toolCalls: 0, fields: { risk: 'high', auth: 'low', tools: 0, degraded: 'model' } },
  });
  deny.rt.inject = () => {
    throw new Error('inject exploded');
  };
  const denied = await onApprovalRequest(request(), deny.next, deny.rt);
  assert.equal(denied, 'rejected');
  const mergeDecide = deny.state.audits.find((row) => row.phase === 'decide');
  assert.equal(mergeDecide.degraded, 'model+inject-fail', '既有降级值以 + 连接，不整段覆盖');
});

// ── error 判定与拒绝分文案（requirements §4.3；三文案选择集中在结算分支） ────

test('审查流 error 判定 → 通道故障模板：点明非安全判定、可直接重试，不带绕过禁令', async () => {
  const { rt, state, next } = makeRt(baseConfig(), {
    verdict: {
      decision: 'error',
      reason: 'attempt 2/2: empty payload',
      toolCalls: 0,
      fields: { degraded: 'output-empty', tools: 0, reason: 'attempt 2/2: empty payload' },
    },
  });
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'rejected', '结算仍 fail-closed（本条只改注入语义）');
  const injected = state.injections[0];
  assert.match(injected, /通道故障/u);
  assert.match(injected, /可以直接重试/u);
  assert.match(injected, /重试会重新发起一次自动审查/u);
  assert.match(injected, /attempt 2\/2: empty payload/u, '审计 reason 原文进模板（尝试进度前缀随 reason 透传）');
  assert.match(injected, /不要连续反复重试/u, '防风暴指引必须在场，不得写成无限重试许可');
  assert.doesNotMatch(injected, /不要用等价手段绕过该拒绝/u, 'REJECTION_INSTRUCTIONS 只保留给 deny');
  // decide 行不因文案分选改变：source=llm、inject=yes、fail-closed 结算。
  const decide = state.audits.find((row) => row.phase === 'decide');
  assert.equal(decide.decision, 'rejected');
  assert.equal(decide.source, 'llm');
  assert.equal(decide.inject, 'yes');
});

test('deny 判定仍用拒绝模板（末句逐字回归）', async () => {
  const { rt, state, next } = makeRt(baseConfig(), {
    verdict: { decision: 'deny', reason: 'risky', toolCalls: 0, fields: { risk: 'high', auth: 'low', tools: 0, degraded: 'none' } },
  });
  await onApprovalRequest(request(), next, rt);
  assert.match(state.injections[0], /本次升权请求被拒绝/u);
  assert.match(state.injections[0], /风险：high；授权证据：low/u);
  assert.equal(
    state.injections[0].endsWith('不要用等价手段绕过该拒绝；改用更安全的替代方案，或在告知风险后请用户明确批准；否则停止并请求用户输入。'),
    true,
    'deny 末句逐字不变',
  );
  assert.doesNotMatch(state.injections[0], /通道故障/u, 'deny 不冒充通道故障');
});

test('规则命中的直接拒绝走专用模板（含重送路径、无禁止绕过尾句）', async () => {
  // 需求 §4.3 通知分型：denyPatterns 规则直拒（source=rule）说明命中形态并告知合规重送路径，
  // 不带 REJECTION_INSTRUCTIONS 尾句——尾句只用于安全拒绝类。
  const { rt, state, next } = makeRt(baseConfig(), {
    pre: { action: 'deny', why: 'pattern', reason: '命令命中规则强制拒绝清单：键 "command" 命中模式 mkfs', fields: { mode: 'danger-full-access', tool: 'pwsh', source: 'rule' } },
  });
  await onApprovalRequest(request(), next, rt);
  const injected = state.injections[0];
  assert.match(injected, /被规则直接拒绝（未经模型审查/u);
  assert.match(injected, /命中规则：命令命中规则强制拒绝清单/u);
  assert.match(injected, /合规重送路径/u);
  assert.match(injected, /不算规避审查/u);
  assert.match(injected, /换等价写法达到同一危险结果的，仍按试图绕过审查处理/u, '边界句在场：等价写法仍按绕过处理');
  assert.doesNotMatch(injected, /不要用等价手段绕过该拒绝/u, '规则命中不使用禁止绕过尾句');
  assert.doesNotMatch(injected, /风险：/u, '规则命中无风险分级语义（未经模型审查）');
  assert.equal(state.settles[0].source, 'rule');
});

test('升权超上限直拒仍走安全拒绝模板（禁止绕过尾句在场）', async () => {
  // 无 source 的直拒（升权超上限、无证据直拒）不属「规则命中」，保留安全拒绝模板与末句。
  const { rt, state, next } = makeRt(baseConfig(), {
    pre: { action: 'deny', why: 'ceiling', reason: '升权目标 universe 超过自动放行上限 danger-full-access', fields: { mode: 'universe', tool: 'pwsh' } },
  });
  await onApprovalRequest(request(), next, rt);
  assert.match(state.injections[0], /本次升权请求被拒绝/u);
  assert.match(state.injections[0], /不要用等价手段绕过该拒绝/u, '升权超上限属安全拒绝类，尾句保留');
  assert.doesNotMatch(state.injections[0], /合规重送路径/u);
});

test('超时文案回归：timedOut 判定不受三文案分选影响', async () => {
  const { rt, state, next } = makeRt(baseConfig(), {
    verdict: { decision: 'error', reason: 'review timeout', toolCalls: 0, timedOut: true, fields: {} },
  });
  await onApprovalRequest(request(), next, rt);
  assert.match(state.injections[0], /自动审批未在时限内完成（超时）/u);
  assert.match(state.injections[0], /超时环节：审查超时/u);
  assert.doesNotMatch(state.injections[0], /通道故障/u);
  assert.doesNotMatch(state.injections[0], /不要用等价手段绕过该拒绝/u);
});

test('breaker-open 走通道故障模板，reason 带冷却说明', async () => {
  const { rt, state, next } = makeRt(baseConfig(), {
    verdict: {
      decision: 'error',
      reason: '审查未执行：breaker-open（冷却中，拒绝密集或故障密集）',
      toolCalls: 0,
      fields: { degraded: 'breaker-open', tools: 0, reason: '审查未执行：breaker-open（冷却中，拒绝密集或故障密集）' },
    },
  });
  await onApprovalRequest(request(), next, rt);
  assert.match(state.injections[0], /通道故障/u);
  assert.match(state.injections[0], /breaker-open（冷却中，拒绝密集或故障密集）/u);
  assert.match(state.injections[0], /可以直接重试/u);
  assert.doesNotMatch(state.injections[0], /不要用等价手段绕过该拒绝/u);
});

test('内部异常 catch 分支注入同样走通道故障模板（gate.internalError 拼 {reason} 位）', async () => {
  // configFor 抛错直接进 catch 逃逸分支（不经过 review 包装的 error verdict 路径）。
  const { rt, state, next } = makeRt(baseConfig());
  rt.configFor = async () => {
    throw new Error('cfg exploded');
  };
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'rejected');
  const injected = state.injections[0];
  assert.match(injected, /通道故障/u);
  assert.match(injected, /审查器内部错误：.*cfg exploded/u, 'gate.internalError 键拼进 {reason} 位');
  assert.match(injected, /可以直接重试/u);
  assert.doesNotMatch(injected, /不要用等价手段绕过该拒绝/u);
  const errorLine = state.audits.find((row) => row.phase === 'error');
  assert.equal(errorLine.decision, 'rejected');
  assert.equal(errorLine.source, 'error');
});

// ── error 计入冷却（gate 接线层；requirements §4.4／design §5.3） ────────────

test('连续 error 冷却打开：下一请求零 LLM 调用、注入通道故障模板（真调度器接线）', async () => {
  const { rt, state, next } = makeRt(baseConfig());
  // 与 lib/index.js 的 rt.review 同形接线：scheduler.run 包审查任务、record 在任务体内结算
  // （dedupe 同 key 单次计数）、superseded 跳过、失败映射 error verdict（design §5.3）。
  const scheduler = createScheduler({ max: 2 });
  let llmCalls = 0;
  rt.review = async (req, located, pre, cfg, opts) => {
    const result = await scheduler.run({ sessionId: 's1', callId: req?.callId }, async () => {
      llmCalls += 1;
      const value = {
        decision: 'error',
        reason: 'attempt 2/2: empty payload',
        toolCalls: 0,
        fields: { degraded: 'output-empty', tools: 0, reason: 'attempt 2/2: empty payload' },
      };
      if (value.superseded !== true) scheduler.record(value.decision);
      return value;
    });
    if (result.ok !== true) {
      const reason = result.reason === 'breaker-open'
        ? '审查未执行：breaker-open（冷却中，拒绝密集或故障密集）'
        : `审查未执行：${result.reason}`;
      const fields = { degraded: result.reason, tools: 0, reason };
      return { decision: 'error', reason, toolCalls: 0, fields };
    }
    return result.value;
  };
  // 前三个请求（不同 callId）：error 判定经 record 计数，第三次打开冷却（consecutiveDenials=3 缺省）。
  for (let index = 1; index <= 3; index += 1) {
    const outcome = await onApprovalRequest({ ...request(), callId: `c${index}` }, next, rt);
    assert.equal(outcome, 'rejected');
  }
  assert.equal(llmCalls, 3);
  assert.equal(scheduler.state().breakerOpen, true, 'error 与 deny 同权：三次连发打开冷却');
  // 第四个请求：零 LLM 调用（计数不增），注入通道故障模板并写明 breaker-open。
  const outcome = await onApprovalRequest({ ...request(), callId: 'c4' }, next, rt);
  assert.equal(outcome, 'rejected');
  assert.equal(llmCalls, 3, '冷却打开后不得再发起 LLM 调用');
  const injected = state.injections[3];
  assert.match(injected, /通道故障/u);
  assert.match(injected, /breaker-open（冷却中，拒绝密集或故障密集）/u);
  assert.doesNotMatch(injected, /不要用等价手段绕过该拒绝/u);
  const decide = state.audits.filter((row) => row.phase === 'decide').at(-1);
  assert.equal(decide.inject, 'yes');
});

// ── §8.4 结算记录：每审批恰一条、全路径覆盖 ─────────────────────────────────

/** 断言结算行公共骨架：kind/approvalId/起止/身份背景字段。 */
function assertSettleShape(settle, { outcome, source }) {
  assert.equal(settle.kind, 'settle');
  assert.equal(settle.approvalId, 'req-1', '审批实例 id＝应答者入口生成的请求 id');
  assert.equal(settle.sessionId, 's1');
  assert.equal(settle.callId, 'call_1');
  assert.equal(settle.toolName, 'pwsh');
  assert.equal(settle.outcome, outcome);
  assert.equal(settle.source, source);
  assert.equal(Number.isFinite(settle.startedAt), true);
  assert.equal(Number.isFinite(settle.endedAt), true);
}

test('结算记录：allow → allowed-once/llm，queueMs 与身份背景字段在场', async () => {
  const { rt, state, next } = makeRt(baseConfig(), { preset: 'auto-approve' });
  rt.review = async () => ({
    decision: 'allow',
    reason: 'ok',
    toolCalls: 0,
    queueMs: 7,
    fields: { risk: 'low', auth: 'high', tools: 0, degraded: 'none' },
  });
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'allowed-once');
  assert.equal(state.settles.length, 1);
  const settle = state.settles[0];
  assertSettleShape(settle, { outcome: 'allowed-once', source: 'llm' });
  assert.equal(settle.queueMs, 7, '排队观测随判定返回并进结算');
  assert.equal(settle.origin, 'main');
  assert.equal(settle.escalation, 'danger-full-access', '升权目标取 screen 的 fields.mode');
  assert.equal(settle.preset, 'auto-approve');
  assert.match(settle.reason, /ok/);
  assert.match(settle.subject, /npm i/, '无审查记录路径也带 subject 摘要');
  assert.equal(settle.humanWaitMs, undefined, '未交人工：humanWaitMs 缺失（§8.5）');
  assert.equal(settle.stage, undefined, '非调度失败不写 stage');
});

test('结算记录：无头会话 origin=subagent；preset 取不到时缺失', async () => {
  const { rt, state, next } = makeRt(baseConfig(), { isHeadless: true });
  await onApprovalRequest(request(), next, rt);
  assert.equal(state.settles.length, 1);
  assert.equal(state.settles[0].origin, 'subagent');
  assert.equal(state.settles[0].preset, undefined);
});

test('结算记录：规则直拒 → rejected/rule，subject/escalation 可查', async () => {
  const { rt, state, next } = makeRt(baseConfig(), {
    pre: { action: 'deny', why: 'pattern', reason: '命中拒绝模式', fields: { mode: 'danger-full-access', tool: 'pwsh' } },
  });
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'rejected');
  assert.equal(state.settles.length, 1);
  const settle = state.settles[0];
  assertSettleShape(settle, { outcome: 'rejected', source: 'rule' });
  assert.equal(settle.escalation, 'danger-full-access');
  assert.match(settle.reason, /命中拒绝模式/);
  assert.match(settle.subject, /npm i/);
});

test('结算记录：硬性危险拦截 → rejected/hard，审计行 source=hard，不调 LLM 不调 next（真实 screen 接线）', async () => {
  // pre 取真实 screen() 输出（无害替身文本；判定是纯函数，不执行命令）——经 gate 全链映射到
  // 结算 source=hard 与审计行 source=hard（design §12.1：与规则直拒同语义、来源可区分）。
  const located = { command: 'Remove-Item -Recurse -Force C:\\probe\\harmless', cwd: 'C:/work', degraded: [], arguments: { command: 'Remove-Item -Recurse -Force C:\\probe\\harmless' } };
  const pre = screen(request(), located, { mode: 'rules', tools: [], allowEscalationTo: 'danger-full-access', denyPatterns: [], unknownSubject: 'reject' });
  assert.equal(pre.action, 'deny', '前置：真实 screen 应命中硬性危险拦截');
  assert.equal(pre.fields.source, 'hard');
  const { rt, state, next } = makeRt(baseConfig(), { pre, preset: 'auto-approve' });
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'rejected');
  assert.equal(state.settles.length, 1);
  assertSettleShape(state.settles[0], { outcome: 'rejected', source: 'hard' });
  assert.match(state.settles[0].reason, /命中硬性危险拦截（hard-h1-powershell）/u);
  const auditRow = state.audits.find((row) => row.phase === 'screen');
  assert.equal(auditRow?.source, 'hard', '审计 screen 行 source 应为 hard（fields 覆盖）');
  assert.match(auditRow?.reason, /hard-h1-powershell/u);
  assert.equal(state.reviewSignals.length, 0, '硬性危险拦截不经 LLM：审查零调用（未经 LLM 直接拒绝）');
  assert.equal(state.nextCalls, 0, '不调用 next()：宿主审批通道不参与');
  // 通知分型（需求 §4.3）：硬性拦截命中走「规则命中的直接拒绝」模板——重送路径在场、禁止绕过尾句缺席。
  const injectedHard = state.injections[0];
  assert.match(injectedHard, /被规则直接拒绝（未经模型审查/u);
  assert.match(injectedHard, /命中规则：命中硬性危险拦截（hard-h1-powershell）/u);
  assert.match(injectedHard, /合规重送路径/u);
  assert.doesNotMatch(injectedHard, /不要用等价手段绕过该拒绝/u, '硬性拦截不使用禁止绕过尾句');
});

test('结算记录：审查超时 → rejected/timeout，stage=review', async () => {
  const { rt, state, next } = makeRt(baseConfig({ reviewer: { timeoutMs: 20 } }), {
    reviewDelayMs: 100,
    verdict: { decision: 'allow', reason: 'late', toolCalls: 0, fields: {} },
  });
  await onApprovalRequest(request(), next, rt);
  assertSettleShape(state.settles[0], { outcome: 'rejected', source: 'timeout' });
  assert.equal(state.settles[0].stage, 'review');
});

test('结算记录：排队超时 → timeout+stage=queue，queueMs 承载实际等待；队列已满/冷却 → llm+stage=queue', async () => {
  const queueTimeout = makeRt(baseConfig({ concurrency: { queueTimeoutMs: 30000 } }));
  queueTimeout.rt.review = async () => ({
    decision: 'error',
    reason: '审查未执行：queue-timeout',
    toolCalls: 0,
    timedOut: true,
    timeoutStage: 'queue',
    timeoutMs: 30000,
    queueMs: 31,
    stage: 'queue',
    fields: { degraded: 'queue-timeout', tools: 0 },
  });
  await onApprovalRequest(request(), queueTimeout.next, queueTimeout.rt);
  assertSettleShape(queueTimeout.state.settles[0], { outcome: 'rejected', source: 'timeout' });
  assert.equal(queueTimeout.state.settles[0].stage, 'queue');
  assert.equal(queueTimeout.state.settles[0].queueMs, 31);

  const breaker = makeRt(baseConfig());
  breaker.rt.review = async () => ({
    decision: 'error',
    reason: '审查未执行：breaker-open（冷却中，拒绝密集或故障密集）',
    toolCalls: 0,
    stage: 'queue',
    fields: { degraded: 'breaker-open', tools: 0 },
  });
  await onApprovalRequest(request(), breaker.next, breaker.rt);
  assertSettleShape(breaker.state.settles[0], { outcome: 'rejected', source: 'llm' });
  assert.equal(breaker.state.settles[0].stage, 'queue');
  assert.match(breaker.state.settles[0].reason, /审查未执行：breaker-open/);
});

test('结算记录：交人工后人工作答 → source=human，humanWaitMs 从交人工起算', async () => {
  const { rt, state, next } = makeRt(baseConfig({ fallback: 'ask', reviewer: { timeoutMs: 30000 }, human: { timeoutMs: 5000, timeoutFrom: 'handoff' } }), {
    verdict: { decision: 'deny', reason: 'risky', toolCalls: 0, fields: {} },
  });
  const promise = onApprovalRequest(request(), next, rt);
  await tick();
  await delay(15);
  state.nextResolvers[0]('rejected');
  const outcome = await promise;
  assert.equal(outcome, 'rejected');
  assertSettleShape(state.settles[0], { outcome: 'rejected', source: 'human' });
  assert.ok(Number.isFinite(state.settles[0].humanWaitMs) && state.settles[0].humanWaitMs >= 10, '等待段≥真实间隔');
});

test('结算记录：审查未收束即抢答 → source=human，humanWaitMs 缺失', async () => {
  const { rt, state, next } = makeRt(baseConfig({ fallback: 'ask', reviewer: { timeoutMs: 30000 } }), {
    reviewDelayMs: 5000,
  });
  const promise = onApprovalRequest(request(), next, rt);
  await tick();
  state.nextResolvers[0]('allowed-once');
  const outcome = await promise;
  assert.equal(outcome, 'allowed-once');
  assertSettleShape(state.settles[0], { outcome: 'allowed-once', source: 'human' });
  assert.equal(state.settles[0].humanWaitMs, undefined, '抢答没有「确实交人工」的等待段');
  assert.equal(state.settles.length, 1, '竞速分支重复到达只落一条结算');
});

test('结算记录：人工超时 → rejected/timeout，stage=human', async () => {
  const { rt, state, next } = makeRt(baseConfig({ fallback: 'ask', human: { timeoutMs: 20, timeoutFrom: 'request' }, reviewer: { timeoutMs: 30000 } }), {
    verdict: { decision: 'deny', reason: 'needs human', toolCalls: 0, fields: {} },
  });
  await onApprovalRequest(request(), next, rt);
  assertSettleShape(state.settles[0], { outcome: 'rejected', source: 'timeout' });
  assert.equal(state.settles[0].stage, 'human');
});

test('结算记录：卡片关闭 → cancelled/gateway；请求取消 → cancelled/signal', async () => {
  const closed = makeRt(baseConfig({ fallback: 'ask', reviewer: { timeoutMs: 30000 }, human: { timeoutMs: 5000, timeoutFrom: 'handoff' } }), {
    verdict: { decision: 'deny', reason: 'x', toolCalls: 0, fields: {} },
  });
  const closedPromise = onApprovalRequest(request(), closed.next, closed.rt);
  await tick();
  await tick();
  // 人工通道以拒绝收尾＝卡片被关闭（gateway）；解析 undefined 只是「无结论的人工作答」。
  closed.state.nextRejectors[0](new Error('card closed'));
  assert.equal(await closedPromise, 'cancelled');
  assertSettleShape(closed.state.settles[0], { outcome: 'cancelled', source: 'gateway' });

  const controller = new AbortController();
  const cancelled = makeRt(baseConfig({ fallback: 'ask', reviewer: { timeoutMs: 30000 }, human: { timeoutMs: 5000, timeoutFrom: 'request' } }), {
    verdict: { decision: 'deny', reason: 'x', toolCalls: 0, fields: {} },
  });
  const cancelledPromise = onApprovalRequest(request(controller.signal), cancelled.next, cancelled.rt);
  await tick();
  controller.abort();
  assert.equal(await cancelledPromise, 'cancelled');
  assertSettleShape(cancelled.state.settles[0], { outcome: 'cancelled', source: 'signal' });
});

test('结算记录：计时回调抛错 → rejected/error 且 stage 标注环节', async () => {
  const { rt, state, next } = makeRt(
    baseConfig({ fallback: 'ask', reviewer: { timeoutMs: 30000 }, human: { timeoutMs: 15, timeoutFrom: 'handoff' } }),
    { timerFireThrows: true, verdict: { decision: 'deny', reason: 'x', toolCalls: 0, fields: {} } },
  );
  await onApprovalRequest(request(), next, rt);
  const settle = state.settles[0];
  assertSettleShape(settle, { outcome: 'rejected', source: 'error' });
  assert.equal(settle.stage, 'human', '人工计时回调抛错按 human 环节');
  assert.match(settle.reason, /计时回调抛错/);
});

test('结算记录：应答者逃逸 → rejected/error，取不到的背景字段明确缺失', async () => {
  const { rt, state, next } = makeRt(baseConfig(), { configThrows: true });
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'rejected');
  const settle = state.settles[0];
  assertSettleShape(settle, { outcome: 'rejected', source: 'error' });
  assert.equal(settle.escalation, undefined, 'configFor 抛错：screen 未执行，escalation 缺失');
  assert.equal(settle.preset, undefined);
  assert.equal(settle.origin, 'main', 'origin 只看会话形态，不依赖配置');
  assert.match(settle.reason, /审查器内部错误：/);
});

test('结算记录：onSettle 抛错不影响结算结果', async () => {
  const { rt, state, next } = makeRt(baseConfig());
  rt.onSettle = () => {
    throw new Error('settle channel exploded');
  };
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'allowed-once');
  assert.equal(state.settles.length, 0);
});

// ── design §5.3 计数口径：计时回调抛错的中止标记 ──────────────────────────
// 两种情形的计数差异全部由中止标记承载：审查环节的计时回调抛错复用超时标记
// （reviewer 零改动、按超时计数）；人工时限环节与中止侧维持被替代标记（不计数）。

test('design §5.3 审查计时回调抛错：在飞审查信号按超时标记中止（与真实超时同权计数）', async () => {
  // 时距拉大（40ms 计时 vs 5000ms 审查）：慢机上竞速不会拼错时序。
  const { rt, state, next } = makeRt(baseConfig({ reviewer: { timeoutMs: 40 } }), {
    timerFireThrows: 'review',
    reviewDelayMs: 5000,
  });
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'rejected');
  const signal = state.reviewSignals[0];
  assert.equal(signal.aborted, true, '回调抛错结算后审查信号中止');
  assert.equal(
    signal.reason.message,
    REVIEW_TIMEOUT_ABORT_MESSAGE,
    '中止标记＝超时标记：reviewer 按超时计数，不按被替代跳过',
  );
});

test('§5.3 人工计时回调抛错：在飞审查信号按被替代标记中止（不计数）', async () => {
  const cfg = baseConfig({
    fallback: 'ask',
    reviewer: { timeoutMs: 30000 },
    human: { timeoutMs: 15, timeoutFrom: 'handoff' },
  });
  const { rt, state, next } = makeRt(cfg, {
    timerFireThrows: true,
    reviewDelayMs: 5000,
    verdict: { decision: 'deny', risk: 'high', authorization: 'low', reason: 'risky', toolCalls: 0, fields: { risk: 'high', auth: 'low', tools: 0, degraded: 'none' } },
  });
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'rejected');
  assert.equal(state.reviewSignals[0].reason, REVIEW_SUPERSEDED, '人工环节的回调抛错＝他路先结算（不计数）');
});

test('§5.3 中止侧回调抛错：在飞审查信号不带超时标记（不计数）', async () => {
  const { rt, state, next } = makeRt(baseConfig(), { abortFireThrows: true, reviewDelayMs: 5000 });
  const controller = new AbortController();
  const promise = onApprovalRequest(request(controller.signal), next, rt);
  await tick();
  controller.abort(new Error('user cancel'));
  assert.equal(await promise, 'cancelled');
  const signal = state.reviewSignals[0];
  assert.equal(signal.aborted, true);
  assert.notEqual(signal.reason.message, REVIEW_TIMEOUT_ABORT_MESSAGE, '中止侧回调抛错不冒用超时标记（reviewer 按被替代跳过）');
});

test('design §5.3 计数口径端到端：审查计时回调抛错与真实超时同形——两次计数后第三次被冷却拦截', async () => {  // 公共审批流水线注入不了回调抛错（design §5.3），故在 gate 层直接驱动：fake rt 的计时器注入抛错，
  // 审查侧用最小镜像把 gate 的中止标记接到**真 scheduler**（lib/scheduler.js）上——
  // 镜像的仅是 index.js rt.review 的调度包装与 reviewer 的中止分类出口，
  // 两处各有真接线测试（冷却计数真接线用例／reviewer 用例）；本用例验证的是「两种情形在计数上同权」这一判据。
  for (const [label, throwMode] of [['计时回调抛错', true], ['真实超时', false]]) {
    const scheduler = createScheduler({ breaker: { consecutiveDenials: 2, windowDenials: 99, cooldownMs: 600000 } });
    const { rt, state, next } = makeRt(baseConfig({ reviewer: { timeoutMs: 40 } }), {
      ...(throwMode ? { timerFireThrows: 'review' } : {}),
      reviewDelayMs: 250,
    });
    const baseReview = rt.review;
    rt.review = async (req, located, pre, cfg, opts) => {
      const sessionId = typeof req?.agent?.session?.id === 'string' ? req.agent.session.id : '-';
      const result = await scheduler.run({ sessionId, callId: req?.callId }, async () => {
        const value = await baseReview(req, located, pre, cfg, opts);
        const signal = opts?.signal;
        if (signal?.aborted === true) {
          // 镜像 reviewer：非超时标记的中止＝被替代（不计数），超时标记照常计数。
          const superseded = !(signal.reason instanceof Error && signal.reason.message === REVIEW_TIMEOUT_ABORT_MESSAGE);
          const classified = { decision: 'error', reason: 'aborted', toolCalls: 0, ...(superseded ? { superseded: true } : {}) };
          if (classified.superseded !== true) scheduler.record(classified.decision);
          return classified;
        }
        return value;
      });
      if (result.ok !== true) {
        const reason = `审查未执行：${result.reason}`;
        return { decision: 'error', reason, toolCalls: 0, fields: { degraded: result.reason, reason }, stage: 'queue' };
      }
      return result.value;
    };
    // 前两次到达：各自完整结算（第 2 次的审查排队等第 1 次释放——每会话串行 1）。
    for (let index = 0; index < 2; index += 1) {
      assert.equal(await onApprovalRequest(request(), next, rt), 'rejected', `${label}：第 ${index + 1} 次到达按拒绝结算`);
    }
    for (let i = 0; i < 150 && scheduler.state().breakerOpen !== true; i += 1) await delay(20);
    assert.equal(scheduler.state().breakerOpen, true, `${label}：两次计数后冷却打开`);
    // 第三次到达：冷却拦截，审查不再发起（信号捕获数停在 2），结算点明冷却。
    assert.equal(await onApprovalRequest(request(), next, rt), 'rejected');
    assert.equal(state.reviewSignals.length, 2, `${label}：第三次审查未执行`);
    assert.match(state.settles.at(-1).reason, /breaker-open/u, `${label}：第三次结算点明冷却`);
  }
});

test('design §5.3 计数口径端到端（装配侧）：装配超时/装配计时回调抛错两次计数后，第三次被冷却拦截', async () => {
  // 装配期超时在 rt.review 之前就结算（gate 就地调 rt.countTimeout，镜像 index 接线＝scheduler.record('error')）；
  // 两次装配侧超时打开冷却后，第三次请求装配恢复正常、进入审查包装（镜像 index 的 scheduler.run 接线），
  // 由冷却拦截：LLM 不发起（在飞信号不增）、结算点明 breaker-open。
  for (const [label, mode] of [['装配真实超时', 'hang'], ['装配计时回调抛错', 'throw']]) {
    const scheduler = createScheduler({ breaker: { consecutiveDenials: 2, windowDenials: 99, cooldownMs: 600000 } });
    const { rt, state, next } = makeRt(baseConfig({ reviewer: { timeoutMs: 40 } }), {
      // 抛错模式须让装配慢于计时器：计时器到点触发回调（此时才注入抛错），装配未完成即按回调错误结算。
      ...(mode === 'throw' ? { timerFireThrows: 'assembly', configForDelayMs: 120 } : { configForNever: true }),
    });
    const cfgOf = rt.cfg;
    rt.countTimeout = () => scheduler.record('error');
    // 前两次：装配侧就地产出 rejected/timeout，各计一次。
    for (let index = 0; index < 2; index += 1) {
      assert.equal(await onApprovalRequest(request(), next, rt), 'rejected', `${label}：第 ${index + 1} 次到达按拒绝结算`);
      assert.equal(state.settles.at(-1).stage, 'assembly', `${label}：环节记装配`);
      assert.equal(state.settles.at(-1).source, 'timeout', `${label}：装配分支（含回调抛错）按装配超时结算`);
    }
    assert.equal(scheduler.state().breakerOpen, true, `${label}：两次装配超时计数后冷却打开`);
    // 第三次：装配恢复正常（覆写挂死/抛错缝），审查包装接到真调度器。
    rt.configFor = async () => cfgOf();
    const baseReview = rt.review;
    rt.review = async (req, located, pre, cfg, opts) => {
      const result = await scheduler.run({ sessionId: '-', callId: req?.callId }, async () => baseReview(req, located, pre, cfg, opts));
      if (result.ok !== true) {
        const reason = `审查未执行：${result.reason}`;
        return { decision: 'error', reason, toolCalls: 0, fields: { degraded: result.reason, reason }, stage: 'queue' };
      }
      return result.value;
    };
    assert.equal(await onApprovalRequest(request(), next, rt), 'rejected', `${label}：第三次按拒绝结算`);
    assert.equal(state.reviewSignals.length, 0, `${label}：第三次冷却拦截，审查未发起`);
    assert.match(state.settles.at(-1).reason, /breaker-open/u, `${label}：第三次结算点明冷却`);
  }
});

// ── design §4.2 收尾恢复请求信号 ───────────────────────────────────────────

test('design §4.2 收尾恢复：结算后请求对象的信号回到原始值，投影不残留', async () => {
  const { rt, state, next } = makeRt(baseConfig());
  const controller = new AbortController();
  const req = request(controller.signal);
  const outcome = await onApprovalRequest(req, next, rt);
  assert.equal(outcome, 'allowed-once');
  assert.equal(req.signal, controller.signal, '结算后信号恢复为进入时的原始值（同一性，非新信号）');
  assert.equal(state.pending.filter((row) => row.op === 'clear').length, 1, '卡片状态照常清理');
});

test('§4.2 同一性守卫：审查在飞期间信号被第三方改写 → 收尾不覆盖新值', async () => {
  const { rt, state, next } = makeRt(baseConfig(), { reviewDelayMs: 80 });
  const controller = new AbortController();
  const req = request(controller.signal);
  const promise = onApprovalRequest(req, next, rt);
  await tick();
  // 审查在飞时，后续到达的审批或宿主改写了请求对象的信号。
  const sentinel = new AbortController().signal;
  req.signal = sentinel;
  assert.equal(await promise, 'allowed-once');
  assert.equal(req.signal, sentinel, '收尾恢复跳过：不把第三方写入的信号覆盖回旧值');
});

test('§4.2 冻结请求：无投影写入、无恢复动作，审批照常完成', async () => {
  const { rt, state, next } = makeRt(baseConfig());
  const controller = new AbortController();
  const req = Object.freeze(request(controller.signal));
  const outcome = await onApprovalRequest(req, next, rt);
  assert.equal(outcome, 'allowed-once');
  assert.equal(req.signal, controller.signal, '冻结对象的信号从不被改写');
});

test('§4.2 恢复自身失败：只留观测记录，不中断其余清理与结算', async () => {
  const { rt, state, next } = makeRt(baseConfig());
  const base = rt.withdraw;
  rt.withdraw = (req) => {
    const handle = base(req);
    return { ...handle, restore() { throw new Error('restore boom'); } };
  };
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'allowed-once', '恢复失败不影响结算结果');
  const row = state.audits.find((entry) => entry.phase === 'error' && entry.source === 'signal');
  assert.ok(row, '恢复失败必须留下观测记录');
  assert.match(row.reason, /收尾恢复请求信号失败：Error: restore boom/u);
  assert.equal(state.pending.filter((entry) => entry.op === 'clear').length, 1, '卡片状态清理照常执行');
});

// ── requirements §4.1 逃逸出口的生效配置读取防抛 ────────────────────────────

test('requirements §4.1 gate catch 自含：生效配置读取抛错不外抛，语言回落 en，注入走通道故障模板', async () => {
  const { rt, state, next } = makeRt(baseConfig()); // language zh：读取抛错时应回落 en
  rt.configFor = () => {
    throw new Error('cfg boom');
  };
  rt.cfg = () => {
    throw new Error('cfg read boom');
  };
  // 现行行为：读取按未取得配置处理，语言回落 en、注入上限回落 2048，fail-closed 照常。
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'rejected');
  assert.equal(state.injections.length, 1, '逃逸仍注入（通道故障模板）');
  assert.equal(
    state.injections[0].split('\n')[0],
    '[approve-for-me] Automatic approval channel failure; this escalation request is treated as rejected.',
    '配置不可读时语言回落 en（zh 配置不生效）',
  );
  assert.match(state.injections[0], /Reason: reviewer internal error: Error: cfg boom/u);
  const errorRow = state.audits.find((row) => row.phase === 'error');
  assert.ok(errorRow, '「审查器内部错误」审计行必须照写');
});

test('§4.1 preset 读取抛错不外抛：两处读取（审查 opts 与结算记录）各自防抛，审查照常执行', async () => {
  const { rt, state, next } = makeRt(baseConfig());
  rt.preset = () => {
    throw new Error('preset boom');
  };
  // preset 在审查调用 opts（gate.js 主流程）与结算记录两处被读取，两处都必须防抛：
  // 只防结算一处时审查仍被中止（rejected/error 且零审查发起），本用例以审查发起数区分两条路径。
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(state.reviewSignals.length, 1, 'preset 读取失败不得中止审查（审查照常发起）');
  assert.equal(outcome, 'allowed-once', '结论按默认判定放行（未被翻成内部异常拒绝）');
  const settle = state.settles[0];
  assertSettleShape(settle, { outcome: 'allowed-once', source: 'llm' });
  assert.equal(settle.preset, undefined, '结算记录的 preset 读取防抛：字段缺失');
});
