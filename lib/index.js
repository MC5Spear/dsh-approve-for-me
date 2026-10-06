/**
 * dsh-approve-for-me — host 半（插件入口）。
 *
 * 只做接线：把 `approval/request` 应答者 prepend 到审批 waterfall、组装 gate 需要的运行时契约（设计「运行时契约」）。
 * 决策逻辑都在 `lib/` 的纯模块里。配置经宿主行 `Config`（volatile 字段为稳定引用）热改生效；
 * 0.1.7 起不再调用设置服务（行 id 即命名空间，读写全在 profile patch 通道）。
 * 审查请求不带 `sessionId`、不注册工具，因此审查自身不会触发新的审批（R1）。
 * @module dsh-approve-for-me
 */
import { join } from 'node:path';
import { BlockAssembler, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { agentT } from './agent-texts.js';
import { AUDIT_VERSION, createAudit } from './audit.js';
import { ApproveForMeService, createSessionChoiceReader } from './bridge.js';
import { Config, normalizeConfig } from './config.js';
import { agentLangOf, clipInject, onApprovalRequest } from './gate.js';
import { createMode } from './mode.js';
import { createPendingState } from './pending-state.js';
import { guardOnDisposal } from './preset-guard.js';
import { createResolver, normalizeModelChoice } from './model-resolver.js';
import { screen } from './policy.js';
import * as prompt from './prompt.js';
import { createReadonlyTools, dshHome } from './readonly-tools.js';
import { createReviewer } from './reviewer.js';
import { createScheduler } from './scheduler.js';
import { sessionModelOf } from './session-model.js';
import { createSessionStore } from './session-store.js';
import { createTraceStore } from './trace-store.js';
import { injectionMessage } from './source.js';
import { collectEvidence, locate, redact } from './transcript.js';
import { createSubagentCoverage } from './subagents.js';

/** cordis 插件名；bundle patch 以 `dsh-approve-for-me` 引用本行。 */
export const name = 'dsh-approve-for-me';

/** 审批、模型与会话服务都必须在场：缺任何一个都无法完成审查（0.1.7 起不再依赖设置服务）。 */
export const inject = ['approval', 'llm', 'sessions'];

/**
 * 组装 gate 的运行时契约。
 * @param {object} ctx - cordis 上下文。
 * @param {() => object} current - 读取当前生效配置。
 * @param {object} parts - 各模块实例。
 * @returns {object} `rt`。
 */
function createRuntime(ctx, current, parts) {
  const { audit, resolver, reviewer, scheduler, tools, mode, pending, coverage } = parts;
  return {
    nextId: () => globalThis.crypto.randomUUID(),
    mode: (request) => mode.mode(request),
    // R40：gate 跳过路径的审计去重（记忆宿主在 mode 闭包）；缺省真＝不去重（保底可观测）。
    gateSkip: (sessionId, why) => mode.gateSkip?.(sessionId, why) ?? true,
    // 无头判定（R24）：委派子会话没有人工通道，gate 据此关闭弹卡与 handoff。
    isHeadless: (request) => coverage?.isDelegated(request?.agent?.session) === true,
    pending,
    configFor: (request) => resolver.configFor(request),
    locate: (request) => locate(request),
    screen: (request, located, cfg) => screen(request, located, cfg),
    async review(request, located, pre, cfg, opts) {
      const session = request?.agent?.session;
      const evidence = collectEvidence(session, cfg.context);
      const merged = { ...pre, evidence: evidence.text };
      // 相对路径以会话工作目录为基准：审查器看到的路径语义与发起工具一致。
      tools.setRoot(located?.cwd ?? process.cwd());
      // R28：模型侧文案（工具说明＋结果模板）按本次配置现设，热生效（回落谓词单源 agentLangOf，R32-3）。
      tools.setLang?.(agentLangOf(cfg));
      // R36：单工具超时与脱敏清单同样每次审查前现设——构造期快照会让热改失效（与 setRoot/setLang 同款接线）；
      // 工具结果、注入、trace 落盘三条 redact 消费路径由此在同一时点后行为一致。
      tools.setToolTimeoutMs?.(cfg.reviewer.toolTimeoutMs);
      tools.setRedactPatterns?.(cfg.context.redactPatterns);
      const sessionId = typeof session?.id === 'string' ? session.id : '-';
      const result = await scheduler.run({ sessionId, callId: request?.callId }, async () => {
        const value = await reviewer.review(request, located, merged, cfg, opts);
        // R48 计数接线（§23.3 决定 3）：record 在任务体内结算——dedupe 同 key 双投递共享在飞任务时
        // 任务只执行一次，record 恰落一次；superseded（gate 他路先结算中止，非通道故障）不计数。
        if (value.superseded !== true) scheduler.record(value.decision);
        return value;
      });
      if (result.ok !== true) {
        // 并发/排队/熔断未执行审查：按审查失败处理，由 gate 依 fallback 结算（error 判定 → 通道故障模板，R46）。
        // 排队超时属于「没等到结论」，标记 timedOut 并带上真实环节与时限，让注入文案写明是排队超时、时限是排队等待上限
        // （设计「五条路径的返回值」的超时模板；写成「审查超时 <reviewer.timeoutMs>」会是假信息）。
        // breaker-open 点明冷却语义（R48）：拒绝密集或故障密集都会打开，主模型得到「稍后重试或报告用户」的指引。
        const reason = result.reason === 'breaker-open'
          ? '审查未执行：breaker-open（冷却中，拒绝密集或故障密集）'
          : `审查未执行：${result.reason}`;
        const fields = { degraded: result.reason, tools: 0, reason };
        audit({ id: opts?.id, phase: 'review', source: 'queue', decision: 'error', ...fields });
        return {
          decision: 'error',
          reason,
          toolCalls: 0,
          fields,
          ...(result.reason === 'queue-timeout'
            ? { timedOut: true, timeoutStage: 'queue', timeoutMs: current()?.concurrency?.queueTimeoutMs }
            : {}),
        };
      }
      return result.value;
    },
    timer(ms, onFire, label) {
      let settle;
      const promise = new Promise((resolvePromise) => {
        settle = resolvePromise;
      });
      // 入参上界由 config 层保证 ≤ 2^31-1（R37：毫秒字段 .max(2147483647)），setTimeout 不会溢出。
      const handle = setTimeout(() => {
        let value;
        try {
          value = onFire();
        } catch (error) {
          // R38：回调抛错按固定错误形状结算，不产生 undefined——undefined 会让 gate 取 `first.kind` 抛
          // TypeError、退化成 error 结算，超时语义与「计时回调抛错」标记双双丢失；
          // label 由 gate 的 armTimer 传入（'review'/'human'），结算据此选超时环节。
          value = { kind: 'callback-error', side: 'timer', label, error };
        }
        settle(value);
      }, ms);
      return {
        promise,
        clear() {
          clearTimeout(handle);
        },
      };
    },
    onAbort(signal, onFire, label) {
      if (signal === undefined || signal === null) {
        return { promise: new Promise(() => {}), clear() {} };
      }
      let settle;
      const promise = new Promise((resolvePromise) => {
        settle = resolvePromise;
      });
      // R38：监听器抛错不得冒泡成未捕获异常——按取消方向的固定错误形状结算，由 gate 按本义结算为 cancelled。
      const listener = () => {
        try {
          settle(onFire());
        } catch (error) {
          settle({ kind: 'callback-error', side: 'abort', label, error });
        }
      };
      if (signal.aborted === true) queueMicrotask(listener);
      else signal.addEventListener('abort', listener, { once: true });
      return {
        promise,
        clear() {
          signal.removeEventListener('abort', listener);
        },
      };
    },
    withdraw(request) {
      const original = request?.signal;
      const canWithdraw = request !== null && typeof request === 'object' && !Object.isFrozen(request);
      const controller = new AbortController();
      if (canWithdraw) {
        // 改写后的 signal 供网关投影；审批服务已在 dispatch 前捕获原始 signal（A2），
        // 因此撤回只影响下游卡片，不影响与原始 signal 的竞速。
        request.signal = original === undefined ? controller.signal : AbortSignal.any([original, controller.signal]);
      }
      return {
        signal: controller.signal,
        original,
        canWithdraw,
        abort(reason) {
          try {
            controller.abort(reason);
          } catch {
            // 重复 abort 无副作用；忽略。
          }
        },
        restore() {
          if (canWithdraw) request.signal = original;
        },
      };
    },
    inject(agent, text) {
      try {
        // 消息源必须是 v4 生产者自有形状（lib/source.js 单一权威）；v3 的
        // kind 取字面量 plugin 的旧包装会被宿主行准入拒绝并中断当轮（2026-09-25 事故）。
        agent?.inject?.(injectionMessage(text));
      } catch {
        // 注入是补充信息；失败不改变已定的拒绝结果。
      }
    },
    audit,
    redact: (text) => redact(text, current()?.context?.redactPatterns),
    cfg: current,
  };
}

/**
 * 审查记录目录（设计 §17.2「路径与结构」）：`$DSH_HOME/approve-for-me/reviews/`。
 * home 取法与拒止围栏同源（lib/readonly-tools.js 的 `dshHome`，R33）：自己写在哪就拒读到哪。
 * @returns {string} 绝对路径。
 */
function reviewsDir() {
  return join(dshHome(), 'approve-for-me', 'reviews');
}

/**
 * 惰性、随配置签名重建的审查记录存储（设计 §17.2/§17.6）。
 * 为什么可以随手重建：事实源是 JSONL，实例只维护回读窗口并按需重放，换实例不丢数据。
 * 签名只含 `capture|maxRecords|maxBytes`——它们改变落盘形状；脱敏清单不在签名里，`redact`
 * 每次现读生效配置，模式热改无需重建。降级回调由存储组装好一行审计的字段形状，直接转发给 audit。
 * @param {() => object} current - 读取当前生效配置。
 * @param {(fields: object) => void} audit - 审计入口。
 * @returns {() => object} 取当前 store 实例的函数。
 */
function createTraceStoreProvider(current, audit) {
  let store;
  let signature = '';
  return () => {
    const trace = current()?.ui?.trace ?? {};
    const next = `${trace.capture ?? 'summary'}|${trace.maxRecords ?? 200}|${trace.maxBytes ?? 8192}`;
    if (store === undefined || next !== signature) {
      signature = next;
      store = createTraceStore({
        dir: reviewsDir(),
        capture: trace.capture,
        maxRecords: trace.maxRecords,
        maxBytes: trace.maxBytes,
        // 复用 transcript.redact（与证据/注入同一套脱敏），不另写一份实现。
        redact: (text) => redact(text, current()?.context?.redactPatterns),
        onDegrade: (fields) => audit(fields),
      });
    }
    return store;
  };
}

/**
 * 注册应答者与状态服务。
 * @param {object} ctx - cordis 上下文（由 `approval`/`llm`/`sessions` 服务增强）。
 * @param {object} [config] - 组合配置入口值；volatile 字段是宿主原地更新的稳定引用。
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  // 0.1.7 读通道：config 的 volatile 字段是稳定引用对象，宿主对"仅 volatile 值变化"
  // 原地更新引用、不重启插件——current() 每次现算 normalizeConfig（内部解包引用），重算即热改生效。
  const current = () => normalizeConfig(config);
  // R34：审计 reason 落笔前统一过 `context.redactPatterns`——并入同一读取器（thunk、热生效），
  // 收口在 createAudit 层：prompt/raw/review/skip/降级等全部 reason 来源一次覆盖，未来新出口不再漏。
  const audit = createAudit(() => ({
    ...current()?.audit,
    redactPatterns: current()?.context?.redactPatterns,
  }));

  // R57（设计 §28.3-2）：默认预设悬空防护——本包被移除/停用（profile manifest 数组已除名）且
  // 用户默认档恰指向 auto-approve 时，unset 该用户层覆盖，防 permission 行装载失败殃及全部会话。
  // 作用域必须先于配置禁用早退注册（config-disabled 形态下摘除防护也要在岗）；良性跳过静默。
  ctx.effect?.(() => async () => {
    try {
      await guardOnDisposal({ ctx, audit });
    } catch (error) {
      audit({ phase: 'screen', action: 'skip', source: 'error', reason: `默认预设悬空防护逃逸异常：${String(error)}` });
    }
  });
  /** 模型解析缓存失效器；事件监听可能早于它赋值，故先给空实现。 */
  let invalidate = () => {};

  // 设置快照（供模型解析的缓存键与 getState）：revision 随 volatile 热改递增。
  // 0.1.7 起不再调用设置服务（describe 有 revision 自增与事件外溢副作用），直接给生效值。
  let settingsRevision = 0;
  const settingsSnapshot = () => ({ revision: settingsRevision, value: current() });

  // 会话级选择的文件载体（设计「会话级选择的文件载体」）；构造不落盘，读写异常由存储内部消化。
  let sessionStore;
  try {
    sessionStore = createSessionStore({ file: sessionStoreFile() });
  } catch (error) {
    sessionStore = undefined;
    audit({ phase: 'screen', action: 'skip', source: 'error', reason: `会话级存储初始化失败：${String(error)}` });
  }
  const sessionChoiceOf = createSessionChoiceReader(sessionStore, sessionModelOf);

  const resolver = createResolver({ llm: ctx.llm, settingsSnapshot, sessionModelOf: sessionChoiceOf, audit });
  invalidate = () => resolver.invalidate();
  // volatile 热改（loader/volatile-update）与模型列表变化都使缓存失效；
  // 前者同时递增 settingsRevision，让模型解析的缓存键感知到配置变化。
  ctx.on?.('loader/volatile-update', () => {
    settingsRevision += 1;
    invalidate();
  });
  ctx.on?.('llm/adapters-updated', invalidate);

  // 子代理覆盖（R24 / 设计 §20）：委派子会话按委派链根会话预设判定，翻 approval/policy=ask。
  // 覆盖判定与监听都自兜异常（session/created 的同步监听器抛错会回滚会话挂载）。
  const coverage = createSubagentCoverage({
    current,
    permissionPresets: () => {
      try {
        return ctx.get?.('permissionPresets');
      } catch {
        return undefined;
      }
    },
    sessionsOf: () => {
      try {
        return ctx.get?.('sessions');
      } catch {
        return undefined;
      }
    },
    audit,
  });

  // 预设判定：只在会话权限预设命中 `trigger.presets` 时接管（设计「插件侧判定与跳过」）；
  // 委派子会话先走 coverage 分支（无预设名可判，R24）。
  const mode = createMode({
    current,
    permissionPresets: () => {
      try {
        return ctx.get?.('permissionPresets');
      } catch {
        return undefined;
      }
    },
    audit,
    coverage,
  });

  const tools = createReadonlyTools({
    rootDir: process.cwd(),
    timeoutMs: current()?.reviewer?.toolTimeoutMs,
    redactPatterns: current()?.context?.redactPatterns,
    redact,
    audit,
  });
  // 审查记录存储（设计 §17.2）：惰性创建、随配置签名重建——JSONL 是事实源、窗口惰性重放，换实例不丢数据。
  const traceStoreOf = createTraceStoreProvider(current, audit);
  // RPC 侧的稳定门面（`lib/bridge.js` 按 `deps.traceStore` 读取）：始终委托到当前签名的实例，
  // 签名变化重建后旧实例的窗口与轮转状态即作废，读路径必须落在最新实例上。
  const traceStore = {
    list: (sessionId) => traceStoreOf().list(sessionId),
    get: (sessionId, reviewId) => traceStoreOf().get(sessionId, reviewId),
  };
  const reviewer = createReviewer({
    llm: ctx.llm,
    blocks: { BlockAssembler },
    messages: { createUserMessage, createAssistantMessage, createToolResultMessage },
    tools,
    prompt,
    audit,
    // 落记录回调：sessionId/callId/toolName 已由 gate 经 opts.trace 补进 entry；
    // askedSeq 在插件内拿不到（approval/asked 会话事件不经过这里），省略后由存储用 startedAt 兜底并落 reviewKeySource。
    onReview: (entry) => {
      traceStoreOf().record(entry);
    },
  });
  const scheduler = createScheduler({ ...(current()?.concurrency ?? {}), breaker: current()?.breaker ?? {} });

  // 审批卡片的自动审批状态表：gate 写、RPC 读（设计「审批卡片内的自动审批状态条与倒计时」）。
  const pending = createPendingState();

  let bridge;
  try {
    bridge = new ApproveForMeService(ctx, { settingsSnapshot, audit, sessionStore, pending, mode, traceStore });
  } catch (error) {
    // RPC 通道不可用时下拉不渲染；审批功能与卡片不受影响（设计「状态通道（供 composer 下拉）」 降级）。
    audit({ phase: 'screen', action: 'skip', source: 'error', reason: `状态服务注册失败：${String(error)}` });
  }

  const rt = createRuntime(ctx, current, { audit, resolver, reviewer, scheduler, tools, mode, pending, coverage });

  const answerer = async (request, next) => {
    try {
      return await onApprovalRequest(request, next, rt);
    } catch (error) {
      // I2 的最终保障：任何逃逸异常一律 fail-closed 为拒绝，并按 `ui.inject` 留痕。
      // 注入文本走语言档（R28）；语言与下行 `ui.inject` 同源，从生效配置现取（热生效）。
      // R34：逃逸出口复用 gate 交付口径——redact + clipInject，与 deliver 同形（不再裸注 String(error)）。
      const escapeLang = agentLangOf(current());
      const raw = agentT(escapeLang, 'gate.escape.body').replaceAll('{error}', String(error));
      const redacted = redact(raw, current()?.context?.redactPatterns);
      const clipped = clipInject(redacted, current()?.ui?.injectMaxBytes);
      const inject = (current()?.ui?.inject ?? 'all') !== 'off';
      if (inject) rt.inject(request?.agent, clipped.text);
      audit({
        phase: 'error',
        decision: 'rejected',
        source: 'error',
        inject: inject ? 'yes' : 'no',
        injectBytes: clipped.bytes,
        reason: `应答者逃逸异常：${String(error)}`,
      });
      return 'rejected';
    }
  };

  if ((current()?.enabled ?? true) === false || (current()?.mode ?? 'rules') === 'off') {
    writeStartupLine(current(), 'no answerer registered (disabled by configuration)');
    return;
  }

  ctx.on('approval/request', answerer, true);

  // 子代理覆盖接线（R24 / 设计 §20）：只在应答者注册的同一条件下挂监听（禁用时翻策略只会留下
  // 无人应答的 ask）。监听器内部自兜异常，这里再包一层——session/created 的同步监听器抛错会回滚
  // 会话挂载，双保险是硬要求；装载补扫覆盖插件晚于会话创建装载的场景（升级/HMR）。
  try {
    ctx.on?.('session/created', (session) => {
      try {
        coverage.onSessionCreated(session);
      } catch (error) {
        audit({ phase: 'screen', action: 'skip', source: 'error', reason: `子代理覆盖监听兜底捕获：${String(error)}` });
      }
    });
    coverage.sweep();
  } catch (error) {
    audit({ phase: 'screen', action: 'skip', source: 'error', reason: `子代理覆盖接线失败：${String(error)}` });
  }
  writeStartupLine(current(), 'answerer registered');
}

/**
 * 启动时写一行生效配置到 stderr；不打印任何凭据。
 * `reviewer.model` 自 设计「模型选择对象化（档位与模型绑定）」 起是 `{ model, effort }` 对象，必须归一化后渲染：
 * 直接插值会写成 `model=[object Object]`（设计「两处需要额外说明的取值」）。
 * @param {object} cfg - 生效配置。
 * @param {string} note - 说明。
 * @returns {void}
 */
function writeStartupLine(cfg, note) {
  const defaultChoice = normalizeModelChoice(cfg?.reviewer?.model);
  const line =
    `[approve-for-me] v=${AUDIT_VERSION} phase=screen action=skip source=- decision=- inject=no ` +
    `mode=${cfg?.mode ?? 'rules'} enabled=${cfg?.enabled === false ? 'false' : 'true'} ` +
    `fallback=${cfg?.fallback ?? 'reject'} tools=${(cfg?.tools ?? []).length} ` +
    `presets=${(cfg?.trigger?.presets ?? []).join('|') || '-'} ` +
    `subagents=${cfg?.trigger?.subagents ?? 'review'} ` +
    `inject=${cfg?.ui?.inject ?? 'all'} ` +
    `allowEscalationTo=${cfg?.allowEscalationTo ?? 'danger-full-access'} ` +
    `reviewTimeout=${cfg?.reviewer?.timeoutMs ?? 90000} ` +
    `model=${defaultChoice?.model ?? '-'} effort=${defaultChoice?.effort || 'none'} ` +
    `maxTokens=${Number.isFinite(cfg?.reviewer?.maxTokens) && cfg.reviewer.maxTokens > 0 ? cfg.reviewer.maxTokens : 'unset'} ` +
    `reason="${note}"`;
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // 日志写不进去不改变插件行为。
  }
}

/**
 * 会话级选择的文件载体路径（设计「路径与结构」）：`$DSH_HOME/approve-for-me/session-models.json`。
 * home 取法与 reviewsDir/拒止围栏同源（lib/readonly-tools.js 的 `dshHome`）。
 * @returns {string} 绝对路径。
 */
function sessionStoreFile() {
  return join(dshHome(), 'approve-for-me', 'session-models.json');
}

export default { name, inject, Config, apply };
