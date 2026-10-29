/**
 * dsh-approve-for-me — host 半（插件入口）。
 *
 * 只做接线：把 `approval/request` 应答者 prepend 到审批 waterfall、组装 gate 需要的运行时契约（design §1.2）。
 * 决策逻辑都在 `lib/` 的纯模块里。配置经宿主行 `Config`（volatile 字段为稳定引用）热改生效；
 * 设置服务的调用不存在（行 id 即命名空间，读写全在 profile patch 通道）。
 * 审查请求不带 `sessionId`、不注册工具，因此审查自身不会触发新的审批。
 * @module dsh-approve-for-me
 */
import { join } from 'node:path';
import { BlockAssembler, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { agentT } from './agent-texts.js';
import { AUDIT_VERSION, createAudit } from './audit.js';
import { ApproveForMeService, createSessionChoiceReader } from './bridge.js';
import { Config, normalizeConfig, REVIEWER_TIMEOUT_DEFAULT_MS } from './config.js';
import { agentLangOf, clipInject, errorText, onApprovalRequest } from './gate.js';
import { createMode } from './mode.js';
import { createPendingState } from './pending-state.js';
import { createResolver, normalizeModelChoice } from './model-resolver.js';
import { DEFAULT_REDACT_PATTERNS, screen } from './policy.js';
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

/** 审批、模型与会话服务都必须在场：缺任何一个都无法完成审查（设置服务不在依赖内）。 */
export const inject = ['approval', 'llm', 'sessions'];

/**
 * 组装 gate 的运行时契约。
 * @param {object} ctx - cordis 上下文。
 * @param {() => object} current - 读取当前生效配置。
 * @param {object} parts - 各模块实例。
 * @returns {object} `rt`。
 */
function createRuntime(ctx, current, parts) {
  const { audit, resolver, reviewer, scheduler, tools, mode, pending, coverage, settingsSnapshot, onSettle, traceStoreOf } = parts;
  return {
    nextId: () => globalThis.crypto.randomUUID(),
    mode: (request) => mode.mode(request),
    // 本次触发接管命中的权限预设名（design §8.2 `preset`）：委派子会话按根会话命中名；未命中/取不到时 undefined。
    preset: (request) => mode.presetOf?.(request),
    // gate 跳过路径的审计去重（去重状态存放在 mode 闭包）；缺省真＝不去重（保底可观测）。
    gateSkip: (sessionId, why) => mode.gateSkip?.(sessionId, why) ?? true,
    // 无头判定：委派子会话没有人工通道，gate 据此关闭弹卡与 handoff。
    isHeadless: (request) => coverage?.isDelegated(request?.agent?.session) === true,
    // 结算记录落盘（design §8.4）：gate 是唯一写入者，每审批恰一条；与审查记录经 approvalId 合并。
    onSettle,
    pending,
    configFor: (request, snapshot) => resolver.configFor(request, snapshot),
    // 配置快照（design §4.1 单请求单配置快照）：gate 同步筛选在请求进入时同步读取一次，
    // 经 configFor 的快照参数与模型解析共用；读取抛错由 gate 外层 catch fail-closed。
    settingsSnapshot: () => settingsSnapshot(),
    // 装配期超时计数通道（design §5.3）：gate 在 rt.review 之前按装配环节超时结算时，
    // 经此与真实审查超时同一路径计数（record 对 deny 与 error 同权计数、allow 清零；超时按 error 判定计入）。
    countTimeout: () => scheduler.record('error'),
    locate: (request) => locate(request),
    // 装配段送审证据采集（design §3.2/§4.3）：gate 装配竞速内调用——证据采集与配置读取、回查
    // 共用审查预算，采得的结果经 rt.review 的 opts.evidence 随请求传入审查入口。
    evidence: (request, cfg) => collectEvidence(request?.agent?.session, cfg?.context),
    screen: (request, located, cfg) => screen(request, located, cfg),
    async review(request, located, pre, cfg, opts) {
      const session = request?.agent?.session;
      // 记录存储按请求入口快照（design §8.2 在飞请求配置快照）：进入调度器之前取当前实例，排队与
      // 在飞期间的配置热改不换走本请求的采集档/字节预算；脱敏清单仍由存储在写入时现读（requirements §5.2 的出口例外）。
      const storeSnapshot = traceStoreOf();
      // 送审证据与审查开始回调从 opts 解出，不透传给审查器：证据由 gate 装配段采集传入
      //（design §3.2），缺失时（不经 gate 的直调契约）就地采集作回退；onReviewStart 是 gate 的
      // 审查计时器武装回调（design §5.1），在出队交接复核后、发起审查前触发。
      const { evidence: evidenceFromAssembly, onReviewStart, ...reviewerOpts } = opts ?? {};
      const evidence = evidenceFromAssembly ?? collectEvidence(session, cfg.context);
      // 采集与回查降级标记随装配透传给审查器：并入审查侧降级清单落记录与审计，读取失败时送审证据段附说明行（design §3.2／§3.1）。
      const merged = {
        ...pre,
        evidence: evidence.text,
        evidenceDegraded: Array.isArray(evidence.degraded) ? evidence.degraded : [],
        locatedDegraded: Array.isArray(located?.degraded) ? located.degraded : [],
      };
      // 工具上下文随请求绑定——进入调度器之前按本请求快照构造，经 opts.tools 以门面传入审查循环；
      // 在飞任务不共享实例状态：并发下后到请求不改写在飞任务的基准目录/文案语言/超时/遮蔽清单
      //（热改语义不变：改配置自**下一次**审查生效）。相对路径基准与发起工具的实际执行目录一致
      //（design §3.1 两级折算；执行目录缺失时回退插件进程目录快照，随证据附说明行）。
      const agentLang = agentLangOf(cfg);
      const toolContext = {
        rootDir: located?.cwd ?? process.cwd(),
        lang: agentLang,
        toolTimeoutMs: cfg.reviewer.toolTimeoutMs,
        // 快照持值拷贝：宿主若以原地改数组的方式更新清单，也不得穿透在飞任务（字段级替换之外的防御）。
        redactPatterns: [...cfg.context.redactPatterns],
      };
      const taskTools = {
        schemas: agentT(agentLang, 'tool.schemas'),
        run: (toolName, toolArgs, signal) => tools.run(toolName, toolArgs, signal, toolContext),
      };
      const sessionId = typeof session?.id === 'string' ? session.id : '-';
      const result = await scheduler.run(
        { sessionId, callId: request?.callId },
        async (queueMs) => {
          // 审查开始回调（design §5.1）：出队交接复核后、发起审查前触发——gate 借此按剩余预算
          // 武装审查计时器（排队等待不消耗审查预算）并补写卡片审查截止；回调未触达时（本任务体
          // 不执行）计时器保持占位，队列段的超时由排队上限结算，不按审查超时补计。
          onReviewStart?.(queueMs);
          const value = await reviewer.review(request, located, merged, cfg, {
            ...reviewerOpts,
            tools: taskTools,
            queueMs,
            // 请求级记录回调覆盖（design §8.2）：本请求的审查记录进入口快照存储，采集计划随
            // entry.tracePlan 透传——在飞请求不被后续配置改写采集档。
            onReview: (entry) => storeSnapshot.record(entry, entry?.tracePlan),
          });
          // 计数接线（design §5.3）：record 在任务体内结算；superseded（gate 他路先结算中止，
          // 非通道故障）不计数。
          if (value.superseded !== true) scheduler.record(value.decision);
          return value;
        },
        // 取消贯通（design §5.1）：审查中止信号进调度器——排队中被中止即移出队列，
        // 许可交接处复核，已中止不执行任务（不发起 llm.stream）。
        { signal: opts?.signal },
      );
      if (result.ok !== true) {
        if (result.aborted === true) {
          // 排队中止（请求已取消，design §5.1）：审查未执行——取消的结算与审计由 gate 的竞速
          // 路径承担（cancelled/signal），此处不写 error 审计行、不计数，只按被替代形状返回
          // 观测值；迟到到达时被 gate 竞速丢弃，不改判、不重复通知。审查计时器在出队回调才
          // 武装，排队段不出现审查超时中止形态（design §5.1）。
          return {
            decision: 'error',
            reason: `审查未执行：${result.reason}`,
            toolCalls: 0,
            fields: { degraded: result.reason, tools: 0, reason: `审查未执行：${result.reason}` },
            superseded: true,
            stage: 'queue',
          };
        }
        // 并发/排队/冷却未执行审查：按审查失败处理，由 gate 依 fallback 结算（error 判定 → 通道故障模板）。
        // 排队超时属于「没等到结论」，标记 timedOut 并带上真实环节与时限，让注入文案写明是排队超时、时限是排队等待上限
        // （design §4.4 的超时模板；写成「审查超时 <reviewer.timeoutMs>」会是假信息）。
        // 冷却未执行点明冷却语义：拒绝密集或故障密集都会打开，主模型得到「稍后重试或报告用户」的指引。
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
          // 结算记录的环节观测（design §8.4）：队列已满与冷却未执行发生在调度环节（stage=queue）；
          // 排队超时是 timeout＋stage=queue，实际等待时长由 queueMs 承载；时限取失败包络携带的
          // 实例等待上限（design §5.1）——不在结算时现读配置，排队期间的配置变化既不改实际时限、
          // 也不改写通知内容；包络为纯数值，缺失时由 gate 按审查时限回退。
          stage: 'queue',
          ...(result.reason === 'queue-timeout'
            ? {
              timedOut: true,
              timeoutStage: 'queue',
              timeoutMs: result.timeoutMs,
              queueMs: result.queueMs,
            }
            : {}),
          // 交接处冷却复查拒绝携带实际排队时长（design §5.1／§8.4）：转人工超时结算经审查结论
          // 带入该字段；入队前的冷却拒绝没有等待期、字段缺失。
          ...(result.reason === 'breaker-open' && result.queueMs !== undefined
            ? { queueMs: result.queueMs }
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
      // 入参上界由 config 层保证 ≤ 2^31-1（毫秒字段 .max(2147483647)），setTimeout 不会溢出。
      const handle = setTimeout(() => {
        let value;
        try {
          value = onFire();
        } catch (error) {
          // 回调抛错按固定错误形状结算，不产生 undefined——undefined 会让 gate 取 `first.kind` 抛
          // TypeError、退化成 error 结算，超时语义与「计时回调抛错」标记双双丢失；
          // label 由 gate 的 armTimer 传入，闭集为 'review'/'human'/'assembly'（'assembly'
          // 的竞速结果在 gate 装配分支就地结算），结算据此选超时环节。
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
      // 监听器抛错不得冒泡成未捕获异常——按取消方向的固定错误形状结算，由 gate 按本义结算为 cancelled。
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
      let projected;
      if (canWithdraw) {
        // 改写后的 signal 供网关投影；审批服务已在 dispatch 前捕获原始 signal，
        // 因此撤回只影响下游卡片，不影响与原始 signal 的竞速。null 与 undefined 同路径
        // （AbortSignal.any 对 null 成员抛 TypeError，onAbort 侧同款口径）。
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
          try {
            controller.abort(reason);
          } catch {
            // 重复 abort 无副作用；忽略。
          }
        },
        restore() {
          // 同一性守卫（design §4.2）：仅当请求上的信号仍是本次写入的投影信号才回写原始值——
          // 信号已被后续到达的审批或宿主改写时跳过，不覆盖新值；
          // 冻结对象没有投影写入，也没有恢复动作。
          if (canWithdraw && request.signal === projected) request.signal = original;
        },
      };
    },
    inject(agent, text) {
      // 消息源必须是 v4 生产者自有形状（lib/source.js 单一权威）；kind 取字面量 `plugin`
      // 的形状会被宿主行准入拒绝并中断当轮。
      // 宿主 inject 的异常原样上抛，交 gate 注入通道的 catch 留痕（decide 行 degraded 并入
      // inject-fail，design §4.4／§8.2）——这里不吞异常，否则该降级标记在生产路径不可达。
      agent?.inject?.(injectionMessage(text));
    },
    audit,
    // 生效配置读取防抛（design §4.1）：读取抛错时回退随包默认脱敏清单（静态，不读生效配置）。
    redact: (text) => {
      try {
        return redact(text, current()?.context?.redactPatterns);
      } catch {
        return redact(text, DEFAULT_REDACT_PATTERNS);
      }
    },
    cfg: current,
  };
}

/**
 * 审查记录目录（design §8.3）：`$DSH_HOME/approve-for-me/reviews/`。
 * home 取法与拒止围栏同源（lib/readonly-tools.js 的 `dshHome`）：自己写在哪就拒读到哪。
 * @returns {string} 绝对路径。
 */
function reviewsDir() {
  return join(dshHome(), 'approve-for-me', 'reviews');
}

/**
 * 惰性创建、单实例长存的审查记录存储（design §8.3/§8.2）。
 * 事实源是 JSONL，实例只维护回读窗口并按需重放——实例长存保证采集热改期间的写入、结算与
 * 读回（RPC/详情）落在同一实例上，写入与读回同源，不会出现热改窗口内互相看不见的两组状态。
 * 签名只含 `capture|maxRecords|maxBytes`——它们改变落盘形状，变化时在原实例上 `reconfigure`
 * （窗口即时裁剪到新上限），不重建实例；脱敏清单不在签名里，`redact` 每次现读生效配置，
 * 模式热改只热生效脱敏、不触发重配。降级回调由存储组装好一行审计的字段形状，直接转发给 audit。
 * @param {() => object} current - 读取当前生效配置。
 * @param {(fields: object) => void} audit - 审计入口。
 * @returns {() => object} 取存储实例的函数（恒为同一实例）。
 */
function createTraceStoreProvider(current, audit) {
  let store;
  let signature = '';
  return () => {
    // 生效配置读取防抛（design §4.1）：读取抛错时按默认采集档（summary｜200｜8192）继续落盘。
    let trace = {};
    try {
      trace = current()?.ui?.trace ?? {};
    } catch {
      trace = {};
    }
    const next = `${trace.capture ?? 'summary'}|${trace.maxRecords ?? 200}|${trace.maxBytes ?? 8192}`;
    if (store === undefined) {
      signature = next;
      store = createTraceStore({
        dir: reviewsDir(),
        capture: trace.capture,
        maxRecords: trace.maxRecords,
        maxBytes: trace.maxBytes,
        // 复用 transcript.redact（与证据/注入同一套脱敏），不另写一份实现；
        // 读取抛错时回退随包默认清单（design §4.1）。
        redact: (text) => {
          try {
            return redact(text, current()?.context?.redactPatterns);
          } catch {
            return redact(text, DEFAULT_REDACT_PATTERNS);
          }
        },
        onDegrade: (fields) => audit(fields),
      });
    } else if (next !== signature) {
      // 签名变化原地重配：在飞请求的采集档不受影响（record 携带请求入口快照的采集计划覆盖），
      // 无计划的写入（结算记录）按重配后的现行值整形。
      signature = next;
      store.reconfigure({ capture: trace.capture, maxRecords: trace.maxRecords, maxBytes: trace.maxBytes });
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
  // 读通道：config 的 volatile 字段是稳定引用对象，宿主对"仅 volatile 值变化"
  // 原地更新引用、不重启插件——current() 每次现算 normalizeConfig（内部解包引用），重算即热改生效。
  const current = () => normalizeConfig(config);
  // 审计 reason 落笔前统一过 `context.redactPatterns`——并入同一读取器（thunk、热生效），
  // 收尾在 createAudit 层：prompt/raw/review/skip/降级等全部 reason 来源一次覆盖，未来新出口不再漏。
  // 生效配置读取防抛（design §4.1）：读取抛错时审计默认开启，按默认行预算与随包默认脱敏清单继续写。
  const audit = createAudit(() => {
    try {
      return { ...current()?.audit, redactPatterns: current()?.context?.redactPatterns };
    } catch {
      return { redactPatterns: DEFAULT_REDACT_PATTERNS };
    }
  });

  /** 模型解析缓存失效器；事件监听可能早于它赋值，故先给空实现。 */
  let invalidate = () => {};

  // 设置快照（供模型解析的缓存键与 getState）：revision 随 volatile 热改递增。
  // 设置服务的调用不存在（describe 有 revision 自增与事件外溢副作用），直接给生效值。
  let settingsRevision = 0;
  const settingsSnapshot = () => ({ revision: settingsRevision, value: current() });

  // 会话级选择的文件载体（design §6.3）；构造不落盘，读写异常由存储内部消化。
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

  // 子代理覆盖（design §2.2）：委派子会话按委派链根会话预设判定，翻 approval/policy=ask。
  // 覆盖判定与监听都自行接住异常（session/created 的同步监听器抛错会回滚会话挂载）。
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

  // 预设判定：只在会话权限预设命中 `trigger.presets` 时接管（design §2.1）；
  // 委派子会话先走 coverage 分支（无预设名可判）。
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
  // 审查记录存储（design §8.3）：惰性创建、单实例长存、签名变化原地重配——JSONL 是事实源、
  // 窗口惰性重放；写入与读回始终同一实例，采集热改期间两组状态互不可见的现象无从产生。
  const traceStoreOf = createTraceStoreProvider(current, audit);
  // RPC 侧的稳定门面（`lib/bridge.js` 按 `deps.traceStore` 读取）：委托到单实例存储，
  // 读路径与写路径同源。
  const traceStore = {
    list: (sessionId) => traceStoreOf().list(sessionId),
    // 详情按审批实例 id 取两类记录的合并详情（design §8.3/§8.5）。
    approval: (sessionId, approvalId) => traceStoreOf().approval(sessionId, approvalId),
    // 某会话的记录读取是否处于降级（读失败或末行撕裂）——页面据此提示「记录读取失败或不完整，列表可能缺少条目」。
    degraded: (sessionId) => traceStoreOf().degraded(sessionId),
  };
  const reviewer = createReviewer({
    llm: ctx.llm,
    blocks: { BlockAssembler },
    messages: { createUserMessage, createAssistantMessage, createToolResultMessage },
    tools,
    prompt,
    audit,
    // 摘要文本字段的脱敏函数（design §8.2：subject/evidence/probes/reason 先脱敏再裁剪）：按生效配置热取；
    // 读取防抛（design §4.1）：抛错时回退随包默认清单——审查结论已产出，记录不因配置不可读整条丢失。
    redactText: (text) => {
      try {
        return redact(text, current()?.context?.redactPatterns);
      } catch {
        return redact(text, DEFAULT_REDACT_PATTERNS);
      }
    },
    // 落审查记录回调（design §8.2）：审批上下文（sessionId/callId/toolName/approvalId/origin/escalation/preset）
    // 由 gate 经 opts.trace 补进 entry，随判定汇合点一起落盘。
    onReview: (entry) => {
      traceStoreOf().record(entry);
    },
  });
  const scheduler = createScheduler({ ...(current()?.concurrency ?? {}), breaker: current()?.breaker ?? {} });

  // 审批卡片的自动审批状态表：gate 写、RPC 读（design §7.4）。
  const pending = createPendingState();

  let bridge;
  try {
    // resolver 传入状态服务：getState 与审批共用同一模型选择逻辑与缓存（design §6.2／§7.2.0）。
    bridge = new ApproveForMeService(ctx, { settingsSnapshot, audit, sessionStore, pending, traceStore, resolver });
  } catch (error) {
    // RPC 通道不可用时下拉不渲染；审批功能与卡片不受影响（design §7.1／§7.3 降级）。
    audit({ phase: 'screen', action: 'skip', source: 'error', reason: `状态服务注册失败：${String(error)}` });
  }

  const rt = createRuntime(ctx, current, {
    audit,
    resolver,
    reviewer,
    scheduler,
    tools,
    mode,
    pending,
    coverage,
    // 配置快照（design §4.1 单请求单配置快照）：gate 同步筛选在请求进入时读取一次，
    // 筛选与模型解析共用同一份（含 revision，作解析缓存键）；热改自下一请求生效。
    settingsSnapshot,
    // 记录存储提供器（design §8.2 在飞请求配置快照）：rt.review 在请求入口取实例快照。
    traceStoreOf,
    // 结算记录落盘（design §8.4）：与审查记录同一个存储实例（同一 approvalId 命名空间）。
    onSettle: (entry) => {
      traceStoreOf().record(entry);
    },
  });

  const answerer = async (request, next) => {
    try {
      return await onApprovalRequest(request, next, rt);
    } catch (error) {
      // gate.js 头注不变量 I2（「try 起点之后不抛；try 之前的逃逸由本 catch 最终保障」）的
      // 承接实现：任何逃逸异常一律 fail-closed 为拒绝，并按 `ui.inject` 留痕。
      // 逃逸出口（design §4.1／§4.4）：生效配置读取一律防抛，读取抛错按未取得配置处理、回退 requirements §5.3 默认值——
      // 语言 `en`、脱敏用随包默认清单（静态，不读生效配置）、注入上限 2048、注入开关 `all`；
      // 通知按通道故障模板呈现（与内部异常通知同构，不另维护逃逸专用正文）。
      let escapeCfg;
      try {
        escapeCfg = current();
      } catch {
        escapeCfg = undefined;
      }
      const escapeLang = agentLangOf(escapeCfg);
      const escapeReason = agentT(escapeLang, 'gate.escape.reason').replaceAll('{error}', String(error));
      const patterns = escapeCfg?.context?.redactPatterns ?? DEFAULT_REDACT_PATTERNS;
      const clipped = clipInject(
        redact(errorText(escapeReason, escapeLang), patterns),
        escapeCfg?.ui?.injectMaxBytes ?? 2048,
      );
      const inject = (escapeCfg?.ui?.inject ?? 'all') !== 'off';
      // 逃逸注入不外抛（三处注入调用点同口径：gate 的 deliver 与其 catch 分支、本逃逸出口）：
      // 逃逸常由请求对象自身的 getter 触发，同一会话的宿主 inject 再抛时，第二异常不得逃出
      // 本 catch——否则无结算、无审计、不返回 rejected。留痕走下方 error 行 degraded。
      let escapeInjectFailed = false;
      if (inject) {
        try {
          rt.inject(request?.agent, clipped.text);
        } catch {
          escapeInjectFailed = true;
        }
      }
      // design §8.4 应答者逃逸也要有结算记录：gate 的 try 之前的语句抛错时没有经过任何结算分支，
      // 这里补一条只有结算的记录（新 approvalId——该审批从未执行审查，与队列失败同形）。
      // 背景读取防抛（design §4.1）：触发逃逸的可能是请求对象自身的 getter（如 session.id）——
      // 会话 id 取不到时按缺省会话 '-'（与 rt.review 对非字符串会话 id 的约定一致；空串与
      // 空白串在这里也归 '-'，比 rt.review 更严——避免落进会被存储丢弃的空键）；
      // callId/toolName 同款逐字段防抛，无头判定取不到按主会话处理；
      // 逃逸出口不得因背景读取失败丢失结算记录。
      // 存储按 reviewId 去重，即便极端情形重复落也只保留第一条。留痕尽力而为，绝不影响 fail-closed。
      let escapeSessionId = '-';
      try {
        const session = request?.agent?.session;
        if (typeof session?.id === 'string' && session.id.trim().length > 0) escapeSessionId = session.id;
      } catch {
      }
      let escapeCallId;
      try {
        escapeCallId = request?.callId;
      } catch {
        escapeCallId = undefined;
      }
      let escapeToolName;
      try {
        escapeToolName = request?.toolName;
      } catch {
        escapeToolName = undefined;
      }
      let escapeOrigin = 'main';
      try {
        escapeOrigin = rt.isHeadless?.(request) === true ? 'subagent' : 'main';
      } catch {
      }
      try {
        rt.onSettle({
          kind: 'settle',
          approvalId: rt.nextId(),
          sessionId: escapeSessionId,
          origin: escapeOrigin,
          callId: escapeCallId,
          toolName: escapeToolName,
          startedAt: Date.now(),
          endedAt: Date.now(),
          outcome: 'rejected',
          source: 'error',
          reason: `应答者逃逸异常：${String(error)}`,
        });
      } catch {
        // 结算留痕失败只降级，不吞掉拒绝语义。
      }
      audit({
        phase: 'error',
        decision: 'rejected',
        source: 'error',
        inject: inject ? 'yes' : 'no',
        injectBytes: clipped.bytes,
        ...(escapeInjectFailed ? { degraded: 'inject-fail' } : {}),
        reason: `应答者逃逸异常：${String(error)}`,
      });
      return 'rejected';
    }
  };

  if ((current()?.enabled ?? true) === false) {
    writeStartupLine(current(), 'no answerer registered (disabled by configuration)');
    return;
  }

  ctx.on('approval/request', answerer, true);

  // 子代理覆盖接线（design §2.2）：与应答器同一注册条件——只有 `enabled=false`（非 volatile）
  // 在装载期不注册；`mode` 是 volatile，off 冷启动同样注册，跳过在请求期由 mode()/screen 现判，
  // 只在装载期判断会让「热切 off 再切回」的实例拿不回应答器。追加动作在事件时点判 mode：
  // off 期间不翻子会话策略（见 lib/subagents.js）。监听器内部自行接住异常，这里再包一层——
  // session/created 的同步监听器抛错会回滚会话挂载，双保险是强制要求；装载补扫覆盖插件晚于
  // 会话创建装载的场景（升级/HMR）。
  try {
    ctx.on?.('session/created', (session) => {
      try {
        coverage.onSessionCreated(session);
      } catch (error) {
        audit({ phase: 'screen', action: 'skip', source: 'error', reason: `子代理覆盖监听回退捕获：${String(error)}` });
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
 * `reviewer.model` 可能是字符串（旧写法）或 `{ model, effort }` 对象（design §6.2），必须
 * 归一化后渲染：直接插值会写成 `model=[object Object]`（design §8.1）。
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
    `reviewTimeout=${cfg?.reviewer?.timeoutMs ?? REVIEWER_TIMEOUT_DEFAULT_MS} ` +
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
 * 会话级选择的文件载体路径（design §6.3）：`$DSH_HOME/approve-for-me/session-models.json`。
 * home 取法与 reviewsDir/拒止围栏同源（lib/readonly-tools.js 的 `dshHome`）。
 * @returns {string} 绝对路径。
 */
function sessionStoreFile() {
  return join(dshHome(), 'approve-for-me', 'session-models.json');
}

export default { name, inject, Config, apply };
