import assert from 'node:assert/strict';
import test from 'node:test';
import { agentLangOf, allowText, errorText, guardNext, onApprovalRequest, rejectText, REVIEW_SUPERSEDED, REVIEW_TIMEOUT_ABORT_MESSAGE, timeoutText } from '../lib/gate.js';
import { createScheduler } from '../lib/scheduler.js';
import { DEFAULT_DENY_PATTERNS } from '../lib/policy.js';

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
  const state = { nextCalls: 0, nextResolvers: [], nextRejectors: [], injections: [], audits: [], timers: [], cancels: [], aborts: [], pending: [], settles: [], reviewSignals: [] };
  const rt = {
    nextId: () => 'req-1',
    mode: () => options.mode ?? 'auto',
    // §8.2 preset：接管命中的权限预设名（不提供时与生产「取不到」一致，记录里 preset 缺失）。
    ...(options.preset === undefined ? {} : { preset: () => options.preset }),
    // R24：无头（委派子代理）请求的标记；缺省（旧形态）视为主会话。
    ...(options.isHeadless === undefined ? {} : { isHeadless: () => options.isHeadless }),
    // §8.4 结算记录捕获：gate 是唯一写入者，每审批恰一条。
    onSettle(entry) {
      state.settles.push(entry);
    },
    cfg: () => cfg,
    async configFor() {
      if (options.configThrows === true) throw new Error('cfg boom');
      return cfg;
    },
    async locate() {
      return options.located ?? { command: 'npm i', cwd: 'C:/work', degraded: [] };
    },
    screen() {
      return options.pre ?? { action: 'review', why: 'ok', fields: { action: 'review', mode: 'danger-full-access', tool: 'pwsh' } };
    },
    async review(_request, _located, _pre, _cfg, opts) {
      // §5.3 计数口径测试缝：捕获传入的在飞审查信号，供断言中止标记（超时/被替代）。
      state.reviewSignals.push(opts?.signal);
      if (options.reviewDelayMs !== undefined) await delay(options.reviewDelayMs);
      if (options.reviewThrows === true) throw new Error('review exploded');
      // 测试缝（R39 端到端链）：真实审查器收尾时写 phase=review 审计行且带 late 观测（reviewer.js:345 同形）。
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
          // 测试钩子（R38）：按 label 注入回调抛错——模拟生产契约里 rt.timer 包装的回调异常路径。
          if (options.timerFireThrows === true || options.timerFireThrows === label) throw new Error('timer cb boom');
          value = onFire();
        } catch (error) {
          value = { kind: 'callback-error', side: 'timer', label, error };
        }
        settle(value);
      }, ms);
      const entry = { ms, promise, cleared: false };
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
      if (signal !== undefined && signal !== null) signal.addEventListener('abort', listener, { once: true });
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
    // 卡片状态表：记录每次写入与清理，便于断言状态迁移（设计「审批卡片内的自动审批状态条与倒计时」）。
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
  // R51：出厂默认清单已空置——规则命中只在显式配置清单的部署里发生，用例按显式注入清单（判据⑤）。
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
  // R52：deny 审计行带上规则层 reason（含命中键与模式），排障可从日志定位命中了什么。
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
});

test('路径 3：reviewer.timeoutMs=0 时不建审查计时器', async () => {
  const { rt, state, next } = makeRt(baseConfig({ reviewer: { timeoutMs: 0 } }));
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'allowed-once');
  assert.equal(state.timers.length, 0);
});

test('路径 4：req.signal abort → cancelled，不注入', async () => {
  const controller = new AbortController();
  const { rt, state, next } = makeRt(baseConfig({ reviewer: { timeoutMs: 0 } }), {
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
  const { rt, state, next } = makeRt(baseConfig({ fallback: 'ask', reviewer: { timeoutMs: 0 } }), {
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
  const { rt, state, next } = makeRt(baseConfig({ fallback: 'ask', human: { timeoutMs: 20, timeoutFrom: 'request' }, reviewer: { timeoutMs: 0 } }), {
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
    baseConfig({ fallback: 'ask', human: { timeoutMs: 30, timeoutFrom: 'handoff' }, reviewer: { timeoutMs: 0 } }),
    {
      verdict: { decision: 'error', reason: 'llm down', toolCalls: 0, fields: { risk: undefined, auth: undefined, tools: 0, degraded: 'none' } },
    },
  );
  const promise = onApprovalRequest(request(), next, rt);
  await tick();
  await delay(50);
  const outcome = await promise;
  assert.equal(outcome, 'rejected');
  assert.ok(state.timers.length >= 1);
  assert.equal(state.timers[0].ms, 30);
});

test('路径 5：交人工阶段 req.signal abort → cancelled（source=signal）', async () => {
  const controller = new AbortController();
  const { rt, state, next } = makeRt(baseConfig({ fallback: 'ask', human: { timeoutMs: 5000, timeoutFrom: 'request' }, reviewer: { timeoutMs: 0 } }), {
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
  // R40：三类跳过留一行 screen skip 审计（rt.gateSkip 缺省＝不去重，保底可观测）。
  assert.equal(state.audits.length, 1);
  assert.equal(state.audits[0].phase, 'screen');
  assert.equal(state.audits[0].action, 'skip');
  assert.equal(state.audits[0].reason, 'not a sandbox escalation');
});

test('插件内部异常：fail-closed 为 rejected + 注入 + 撤回，相位为 error（N17）', async () => {
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

test('关闭弹卡（R11）：审查期间不调 next()，allow 时全程无卡片', async () => {
  const { rt, state, next } = makeRt(baseConfig({ fallback: 'ask', ui: { humanCardDuringReview: false } }));
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'allowed-once');
  // 人工通道从未被打开：卡片不该在审查期间出现（设计「决定：审查期间是否先调用 next() 由配置决定」）。
  assert.equal(state.nextCalls, 0);
  assert.equal(state.aborts.length, 0, '未取用卡片就无需撤回');
});

test('关闭弹卡（R11）：deny + ask 时交人工才调 next()，且只调一次', async () => {
  const { rt, state, next } = makeRt(
    baseConfig({ fallback: 'ask', human: { timeoutMs: 5000, timeoutFrom: 'handoff' }, ui: { humanCardDuringReview: false } }),
    { verdict: { decision: 'deny', reason: 'risky', toolCalls: 0, fields: { risk: 'high', auth: 'low', tools: 0, degraded: 'none' } } },
  );
  const promise = onApprovalRequest(request(), next, rt);
  await tick();
  await tick();
  assert.equal(state.nextCalls, 1, '交人工时调用 next()');
  assert.ok(state.audits.some((entry) => entry.phase === 'handoff' && entry.decision === 'ask'));
  // 状态表先写 reviewing，再在交人工时改写成 denied 并带上理由。
  const states = state.pending.filter((entry) => entry.op === 'set').map((entry) => entry.state);
  assert.deepEqual(states, ['reviewing', 'denied']);
  assert.equal(state.pending.filter((entry) => entry.op === 'set')[1].reason, 'risky');
  state.nextResolvers[0]('rejected');
  const outcome = await promise;
  assert.equal(outcome, 'rejected');
  // 结算后必须清理状态条目，客户端据此停止轮询。
  assert.ok(state.pending.some((entry) => entry.op === 'clear' && entry.callId === 'call_1' && entry.sessionId === 's1'));
});

test('关闭弹卡（R11）：timeoutFrom=request 且剩余≤0 时不弹卡，直接按人工超时结算', async () => {
  const { rt, state, next } = makeRt(
    baseConfig({ fallback: 'ask', human: { timeoutMs: 30, timeoutFrom: 'request' }, reviewer: { timeoutMs: 2000 }, ui: { humanCardDuringReview: false } }),
    { reviewDelayMs: 60, verdict: { decision: 'deny', reason: 'late', toolCalls: 0, fields: {} } },
  );
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'rejected');
  // 审查耗尽人工预算：不许闪一张卡片出来（设计「交人工前先算剩余时间」）。
  assert.equal(state.nextCalls, 0);
  assert.match(state.injections[0], /超时环节：人工未在时限内响应 30 ms/u);
  // 没有真的交人工，就不该留下 handoff 行；结算行仍是超时来源。
  assert.equal(state.audits.some((entry) => entry.phase === 'handoff'), false, '预算耗尽时不应写 handoff 行');
  assert.equal(state.audits.find((entry) => entry.phase === 'decide').source, 'timeout');
});

test('卡片状态（R12/R13）：reviewing 带审查时限，超时转人工时换成人工时限', async () => {
  const { rt, state, next } = makeRt(
    baseConfig({ fallback: 'ask', reviewer: { timeoutMs: 20 }, human: { timeoutMs: 4000, timeoutFrom: 'handoff' } }),
    { reviewDelayMs: 200, verdict: { decision: 'allow', reason: 'late', toolCalls: 0, fields: {} } },
  );
  const promise = onApprovalRequest(request(), next, rt);
  await tick();
  const first = state.pending.find((entry) => entry.op === 'set');
  assert.equal(first.state, 'reviewing');
  assert.equal(first.deadlineKind, 'review');
  assert.equal(first.deadlineAt - first.startedAt, 20);
  await delay(40);
  await tick();
  const second = state.pending.filter((entry) => entry.op === 'set')[1];
  assert.equal(second.state, 'timeout', '审查超时后状态转 timeout');
  assert.equal(second.deadlineKind, 'human');
  assert.ok(second.deadlineAt - Date.now() > 0, '人工时限为正数');
  state.nextResolvers[0]('rejected');
  await promise;
});

test('VER-01：人工时限为 0 时不登记人工阶段卡片状态，交人工立即按拒绝结算', async () => {
  const { rt, state, next } = makeRt(
    baseConfig({ fallback: 'ask', reviewer: { timeoutMs: 0 }, human: { timeoutMs: 0, timeoutFrom: 'handoff' } }),
    { verdict: { decision: 'deny', reason: 'x', toolCalls: 0, fields: {} } },
  );
  const promise = onApprovalRequest(request(), next, rt);
  await tick();
  await tick();
  // 审查无上限的 reviewing 状态合法（deadlineAt=null）；
  // 人工阶段零时限：不登记无截止时间的人工待决状态（§4.3），立即按拒绝结算。
  const sets = state.pending.filter((entry) => entry.op === 'set');
  assert.equal(sets.length, 1, '只有 reviewing 一条，没有人工阶段状态');
  assert.equal(sets[0].state, 'reviewing');
  assert.equal(sets[0].deadlineAt, null);
  assert.equal(sets[0].deadlineKind, null);
  // 卡片在入口弹出（humanCardDuringReview 默认开）后立即被超时结算撤回：没有人工等待段。
  assert.equal(state.nextCalls, 1);
  const outcome = await promise;
  assert.equal(outcome, 'rejected');
});

test('VER-01（盲审缺陷 2）：handoff 起算＋人工零时限＋关弹卡时不弹马上消失的卡片', async () => {
  const { rt, state, next } = makeRt(
    baseConfig({
      fallback: 'ask',
      reviewer: { timeoutMs: 0 },
      human: { timeoutMs: 0, timeoutFrom: 'handoff' },
      ui: { humanCardDuringReview: false },
    }),
    { verdict: { decision: 'deny', reason: 'x', toolCalls: 0, fields: {} } },
  );
  const promise = onApprovalRequest(request(), next, rt);
  await tick();
  await tick();
  // 关闭「审查期间弹卡」＋handoff 起算＋人工时限 0：交人工即耗尽，一次都不该调 next()
  // （弹了马上撤回＝需求 4.2 禁止的马上消失卡片），直接按人工超时结算。
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

test('排队超时（R10）：审查层标记 timedOut 与真实环节，注入写明排队超时及排队上限', async () => {
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

test('并发占满不冒充超时（R46）：queue-overflow 走通道故障文案，既非超时也非拒绝模板', async () => {
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

// ── 无头路径（R24 / 设计 §2.2）：委派子代理没有人工通道 ──────────────────────────

test('R24 无头 allow：不调 next()、不写 pending 卡片态，放行注入直达发起者', async () => {
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

test('R24 无头 reject（fallback=ask 也按拒绝结算）：不 handoff、不 next()，注入拒绝原因', async () => {
  const { rt, state, next } = makeRt(
    baseConfig({ fallback: 'ask' }),
    {
      isHeadless: true,
      // 审查结论闭集是 allow|deny|error（lib/reviewer.js）：deny 判定走拒绝模板（R46 三分选）。
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

test('R24 无头超时（timedOut 判定）：按超时文案拒绝，说明可重试，不 next()（实现审查 S3-4）', async () => {
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
  // 超时文案要点（R10）：点明「这是超时」与真实环节/时限，且不含「不要绕过」的拒绝措辞。
  assert.match(state.injections[0], /自动审批未在时限内完成（超时）/u);
  assert.match(state.injections[0], /超时环节：审查超时 1500 ms/u);
  assert.doesNotMatch(state.injections[0], /不要用等价手段绕过该拒绝/u);
});

test('agentLangOf：显式 zh/en 原样，缺失/非法回落 en（N4 回落方向统一）', () => {
  assert.equal(agentLangOf({ language: { agent: 'zh' } }), 'zh');
  assert.equal(agentLangOf({ language: { agent: 'en' } }), 'en');
  assert.equal(agentLangOf({}), 'en', '配置缺失时回落 en（＝schema 默认，与 reviewer/readonly-tools 同向）');
  assert.equal(agentLangOf(undefined), 'en');
  assert.equal(agentLangOf({ language: { agent: 'fr' } }), 'en', '非法值回落 en');
  // 变红判据：若 gate 回落改回 zh（N4 修正前的分裂方向），缺失与非法两档断言红；
  // 该回落同时喂给 index 层逃逸注入（G1 的 runEscape 未配 language 时即走本回落）。
});

test('回落谓词单源（R32-3）：字面谓词在 lib/ 内只许住在 gate.js 的 agentLangOf', async () => {
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
  // 变红判据：在任一 lib 文件里重新内联该谓词（R32-3 收敛前 index.js/reviewer.js 各有一份），
  // hits 多出一项即红——这正是 r32 登记的「改一处副本而其余不动不会有测试变红」缺口。
  assert.deepEqual(hits, ['gate.js']);
});

// ── R38：计时/中止回调抛错的结算 ─────────────────────────────────────────

test('R38① 审查计时回调抛错：按超时语义拒绝，decide 点明「计时回调抛错（review）」', async () => {
  // 时距拉大（R44-② 竞速确定性）：计时 40ms vs 审查 5000ms，慢机上也不会拼错时序。
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

test('R38② 中止回调抛错：按取消语义结算，decide 点明「中止回调抛错（request）」', async () => {
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

test('R38③ 人工计时回调抛错：label=human 按人工超时语义拒绝（内层竞速路径）', async () => {
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

// ── R39：迟到结论的 gate 侧行为 ──────────────────────────────────────────

test('R39 gate 侧：人工抢先结算后迟到的审查照常收尾，decide 行不追加', async () => {
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

test('R39 端到端链（r45 修正 P3-3）：审查超时结算后，迟到的 review 行 late=yes 且 decide 恰一行', async () => {
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

test('P3-1（r45 修正）：逃逸 catch 分支的注入抛错不外逃，error 行留 degraded=inject-fail', async () => {
  const { rt, state, next } = makeRt(baseConfig());
  rt.configFor = () => {
    throw new Error('config boom');
  };
  rt.inject = () => {
    throw new Error('inject exploded in catch branch');
  };
  // 修复前：catch 分支的裸 rt.inject 把异常抛出 onApprovalRequest（I2 只剩 answerer 外层承接、
  // 且「审查器内部错误」error 行被跳过）；修复后：fail-closed 照常、审计行照写。
  const outcome = await onApprovalRequest(request(), next, rt);
  assert.equal(outcome, 'rejected');
  const errorRow = state.audits.find((row) => row.phase === 'error');
  assert.ok(errorRow, '「审查器内部错误」审计行必须照写');
  assert.match(errorRow.reason, /审查器内部错误：.*config boom/u);
  assert.equal(errorRow.degraded, 'inject-fail');
});

// ── R40：gate 跳过路径的审计去重接线 ─────────────────────────────────────

test('R40 gate 接线：经 rt.gateSkip 判定，同 (会话, 因) 第二行不写', async () => {
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

// ── R44：在册守护的直接用例 ──────────────────────────────────────────────

test('R44① guardNext：第二次调用抛错（导出直测）', async () => {
  let calls = 0;
  const guarded = guardNext(async () => {
    calls += 1;
    return 'ok';
  });
  assert.equal(await guarded(), 'ok');
  assert.equal(calls, 1);
  await assert.rejects(async () => guarded(), /next\(\) called twice/u);
});

test('R44② 注入通道抛错：结算语义不变，decide 行 degraded 追加 inject-fail', async () => {
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

// ── R46：error 判定与拒绝分文案（三文案选择集中在结算分支） ────────────────

test('R46① 审查流 error 判定 → 通道故障模板：点明非安全判定、可直接重试，不带绕过禁令', async () => {
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
  assert.match(injected, /attempt 2\/2: empty payload/u, '审计 reason 原文进模板（R47 前缀随 reason 透传）');
  assert.match(injected, /不要连续反复重试/u, '防风暴指引必须在场，不得写成无限重试许可');
  assert.doesNotMatch(injected, /不要用等价手段绕过该拒绝/u, 'REJECTION_INSTRUCTIONS 只保留给 deny');
  // decide 行不因文案分选改变：source=llm、inject=yes、fail-closed 结算。
  const decide = state.audits.find((row) => row.phase === 'decide');
  assert.equal(decide.decision, 'rejected');
  assert.equal(decide.source, 'llm');
  assert.equal(decide.inject, 'yes');
});

test('R46② deny 判定仍用拒绝模板（末句逐字回归）', async () => {
  const { rt, state, next } = makeRt(baseConfig(), {
    verdict: { decision: 'deny', reason: 'risky', toolCalls: 0, fields: { risk: 'high', auth: 'low', tools: 0, degraded: 'none' } },
  });
  await onApprovalRequest(request(), next, rt);
  assert.match(state.injections[0], /本次升权请求被拒绝/u);
  assert.match(state.injections[0], /风险：high；授权证据：low/u);
  assert.equal(
    state.injections[0].endsWith('不要用等价手段绕过该拒绝；改用更安全的替代方案，或在告知风险后请用户明确批准。'),
    true,
    'deny 末句逐字不变',
  );
  assert.doesNotMatch(state.injections[0], /通道故障/u, 'deny 不冒充通道故障');
});

test('R46②b 超时文案回归：timedOut 判定不受三文案分选影响', async () => {
  const { rt, state, next } = makeRt(baseConfig(), {
    verdict: { decision: 'error', reason: 'review timeout', toolCalls: 0, timedOut: true, fields: {} },
  });
  await onApprovalRequest(request(), next, rt);
  assert.match(state.injections[0], /自动审批未在时限内完成（超时）/u);
  assert.match(state.injections[0], /超时环节：审查超时/u);
  assert.doesNotMatch(state.injections[0], /通道故障/u);
  assert.doesNotMatch(state.injections[0], /不要用等价手段绕过该拒绝/u);
});

test('R46④ breaker-open 走通道故障模板，reason 带冷却说明', async () => {
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

test('R46⑤ 内部异常 catch 分支注入同样走通道故障模板（gate.internalError 拼 {reason} 位）', async () => {
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

// ── R48：error 计入冷却（gate 接线层） ─────────────────────────────────────

test('R48-① 连续 error 冷却打开：下一请求零 LLM 调用、注入通道故障模板（真调度器接线）', async () => {
  const { rt, state, next } = makeRt(baseConfig());
  // 与 lib/index.js 的 rt.review 同形接线：scheduler.run 包审查任务、record 在任务体内结算
  // （dedupe 同 key 单次计数）、superseded 跳过、失败映射 error verdict（§5.3 决定 3）。
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
  const { rt, state, next } = makeRt(baseConfig({ fallback: 'ask', reviewer: { timeoutMs: 0 }, human: { timeoutMs: 5000, timeoutFrom: 'handoff' } }), {
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
  const { rt, state, next } = makeRt(baseConfig({ fallback: 'ask', reviewer: { timeoutMs: 0 } }), {
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
  const { rt, state, next } = makeRt(baseConfig({ fallback: 'ask', human: { timeoutMs: 20, timeoutFrom: 'request' }, reviewer: { timeoutMs: 0 } }), {
    verdict: { decision: 'deny', reason: 'needs human', toolCalls: 0, fields: {} },
  });
  await onApprovalRequest(request(), next, rt);
  assertSettleShape(state.settles[0], { outcome: 'rejected', source: 'timeout' });
  assert.equal(state.settles[0].stage, 'human');
});

test('结算记录：卡片关闭 → cancelled/gateway；请求取消 → cancelled/signal', async () => {
  const closed = makeRt(baseConfig({ fallback: 'ask', reviewer: { timeoutMs: 0 }, human: { timeoutMs: 5000, timeoutFrom: 'handoff' } }), {
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
  const cancelled = makeRt(baseConfig({ fallback: 'ask', reviewer: { timeoutMs: 0 }, human: { timeoutMs: 5000, timeoutFrom: 'request' } }), {
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
    baseConfig({ fallback: 'ask', reviewer: { timeoutMs: 0 }, human: { timeoutMs: 15, timeoutFrom: 'handoff' } }),
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

// ── §5.3 计数口径：计时回调抛错的中止标记（ISS-8，裁定 A）──────────────────
// 两种情形的计数差异全部由中止标记承载：审查环节的计时回调抛错复用超时标记
// （reviewer 零改动、按超时计数）；人工时限环节与中止侧维持被替代标记（不计数）。

test('§5.3 审查计时回调抛错：在飞审查信号按超时标记中止（与真实超时同权计数）', async () => {
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
    reviewer: { timeoutMs: 0 },
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

test('§5.3 计数口径端到端：审查计时回调抛错与真实超时同形——两次计数后第三次被冷却拦截', async () => {
  // 公共审批流水线注入不了回调抛错（设计 §5.3），故在 gate 层直接驱动：fake rt 的计时器注入抛错，
  // 审查侧用最小镜像把 gate 的中止标记接到**真 scheduler**（lib/scheduler.js）上——
  // 镜像的仅是 index.js rt.review 的调度包装（L82-96）与 reviewer 的中止分类（L399-411），
  // 两处各有真接线测试（R48⑤／reviewer 用例）；本用例验证的是「两种情形在计数上同权」这一判据。
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

// ── §4.2 收尾恢复请求信号（ISS-7）────────────────────────────────────────

test('§4.2 收尾恢复：结算后请求对象的信号回到原始值，投影不残留', async () => {
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

// ── §4.1 逃逸出口的生效配置读取防抛（ISS-6）──────────────────────────────

test('§4.1 gate catch 自含：生效配置读取抛错不外抛，语言回落 en，注入走通道故障模板', async () => {
  const { rt, state, next } = makeRt(baseConfig()); // language zh：读取抛错时应回落 en
  rt.configFor = () => {
    throw new Error('cfg boom');
  };
  rt.cfg = () => {
    throw new Error('cfg read boom');
  };
  // 修复前：catch 分支的 rt.cfg?.() 把异常抛出 onApprovalRequest（I2 承接层自身外逃）；
  // 修复后：读取按未取得配置处理，语言回落 en、注入上限回落 2048，fail-closed 照常。
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
