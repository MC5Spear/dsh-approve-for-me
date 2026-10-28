/**
 * dsh-approve-for-me — 审批应答者的时序与竞速。
 *
 * 审批是 waterfall：不调用 `next()` 卡片就不会出现（design §4.1）。弹卡时机按配置：主会话默认
 * 在审查开始即 `next()` 弹卡、并行审查按结果竞速；关闭「审查期间显示人工审批卡片」时推迟到确定
 * 交给人工才调用这一次 `next()`；无头会话全程不调用（requirements §2.2）。不变量：
 *   I1 `next()` 至多调用一次；
 *   I2 try 起点之后不抛（结算路径自含）；try 之前语句（id/sessionId 现取等）的逃逸由
 *       index.js 应答者的最外层 catch 最终保障——统一 fail-closed 为拒绝（抛 = 服务归一化
 *       为 `unavailable`，与「无通道」不可区分）；
 *   I3 返回前释放全部计时器与监听器；
 *   I4 审查请求不带 `sessionId`、不注册工具，因此不递归、不写主会话；
 *   I8 注入按 `ui.inject` 判定：`all` 放行与拒绝都注入、`reject` 仅拒绝注入、`off` 都不注入；
 *       拒绝时按需撤回（含 catch 分支）。
 * 卡片由宿主原生渲染：本模块不注册任何 slot，经 `pending` 通道写状态条（`reviewing`／`waiting-human`，
 * design §7.4；无头会话不写），与卡片的关系是「按配置时机调用 `next()` 弹卡」「写状态条」与
 * 「结算时撤回」（requirements §6.3＋design §7.4）。
 * @module dsh-approve-for-me/gate
 */

/** 超时环节的四种来源（design §4.4 的超时模板：装配／排队／审查／人工）；文案键走 agent-texts。 */
import { agentT } from './agent-texts.js';
import { REVIEWER_TIMEOUT_DEFAULT_MS } from './config.js';
import { subjectSummary, summarizeText } from './record-fields.js';

/**
 * 解析本次请求的 Agent 文案语言：每次请求从生效配置现取（热生效）；
 * 缺失或非法值回落 `en`（＝schema 默认；与 reviewer 共用 agentLangOf 归一——readonly-tools
 * 生产路径同样经 agentLangOf 归一后传入，模块基线缺省 zh 仅直测路径）。
 * @param {object} cfg - 生效配置。
 * @returns {'zh' | 'en'} 语言。
 */
export function agentLangOf(cfg) {
  return cfg?.language?.agent === 'zh' ? 'zh' : 'en';
}

/**
 * 审查计时器中止在飞审查流时的 abort reason 文本（design §5.3 计数口径）。
 *
 * 慢通道也是不可信通道：审查超时引发的 abort 型 error **计入**冷却。reviewer 按「中止 reason 是本标记」
 * 与他路先结算的中止（`REVIEW_SUPERSEDED`，不计入）区分。两处必须同源，文本改动即口径漂移。
 */
export const REVIEW_TIMEOUT_ABORT_MESSAGE = 'approve-for-me: review timeout';

/**
 * gate 他路先结算（人工先答/卡片关闭/请求取消/人工超时竞速获胜，以及人工时限环节与中止侧的回调抛错）
 * 中止在飞审查流的标记 reason（design §5.3 计数口径）。这类 abort 型 error 不是通道故障——
 * 审查没得出结论是因为结论已不再需要——reviewer 据此给 verdict 打 `superseded: true`，index 层的冷却计数跳过。
 * 审查环节的计时回调抛错不在此列：它与真实超时同权计数，走超时标记（见 `settleCallbackError`）。用 Symbol 防伪造。
 */
export const REVIEW_SUPERSEDED = Symbol('approve-for-me: review superseded');

/**
 * 组装注入给主模型的**超时**文本。
 *
 * 超时不是安全判定：必须点明「没等到结论 + 可重试」，否则主模型会把超时当成「判定为危险」而放弃或绕路
 * （design §4.4）。仅当 `timeoutMs` 是正数时把毫秒数写进文案。
 * 超时文案不含「绕过拒绝」末句；zh/en 两档正文均来自 agent-texts（design §7.5）。
 * @param {'assembly' | 'review' | 'human' | 'queue'} stage - 超时环节。
 * @param {number | undefined} timeoutMs - 该环节的时限；非正数或缺失时不写毫秒数。
 * @param {string} [lang='zh'] - 文案语言（缺省 zh＝内部直调契约，运行时调用均显式传 agentLangOf 的返回值）。
 * @returns {string} 注入文本。
 */
export function timeoutText(stage, timeoutMs, lang = 'zh') {
  const label = agentT(lang, `gate.timeout.${stage in { assembly: 1, review: 1, human: 1, queue: 1 } ? stage : 'review'}`);
  const suffix = Number.isFinite(timeoutMs) && timeoutMs > 0 ? ` ${timeoutMs} ms` : '';
  return agentT(lang, 'gate.timeout.body').replaceAll('{stage}', label).replaceAll('{suffix}', suffix);
}

/**
 * 组装注入给主模型的**通道故障**文本。
 *
 * `error` 判定不是安全判定：审查器或其模型侧故障、没得出结论。沿用拒绝模板会让主模型把故障读成
 * 「判定为危险、不许绕过」，把可放行的操作当成终局拒绝——拒绝是结算终态，重新审查须由主模型
 * 再次发起请求，不存在自动恢复。本模板与超时文案同一口径：
 * 点明非安全判定、可直接重试（重试重新发起一次自动审查），末行是防风暴指引，不含 `REJECTION_INSTRUCTIONS`。
 * @param {string | undefined} reason - 故障原因（审计 reason 原文，可带 `attempt N/M:` 前缀）。
 * @param {string} [lang='zh'] - 文案语言（缺省 zh＝内部直调契约，运行时调用均显式传 agentLangOf 的返回值）。
 * @returns {string} 注入文本。
 */
export function errorText(reason, lang = 'zh') {
  return agentT(lang, 'gate.error.body').replaceAll('{reason}', reason ?? agentT(lang, 'gate.noReason'));
}

/**
 * 组装注入给主模型的**规则命中的直接拒绝**文本（需求 §4.3：规则强制检查与硬性危险拦截命中）。
 *
 * 与 `rejectText` 的差异：说明命中规则形态与位置（`reason` 原文承载）＋告知合规重送路径
 * （仅移除被命中字样或改用实质更安全形态后重送不算规避）；**不**带 `REJECTION_INSTRUCTIONS`
 * 禁止绕过尾句——该尾句只用于安全拒绝类（LLM 拒绝与升权超上限）。
 * @param {string | undefined} reason - 命中的规则形态与位置（审计 reason 原文）。
 * @param {string} [lang='zh'] - 文案语言（缺省 zh＝内部直调契约，运行时调用均显式传 agentLangOf 的返回值）。
 * @returns {string} 注入文本。
 */
export function ruleRejectText(reason, lang = 'zh') {
  return agentT(lang, 'gate.ruleReject.body').replaceAll('{reason}', reason ?? agentT(lang, 'gate.noReason'));
}

/**
 * 组装注入给主模型的拒绝文本。末句＝codex `REJECTION_INSTRUCTIONS`（en 原文／zh 现行译文与 en 保持一致，design §7.5）。
 * 仅用于 `deny` 判定（LLM 给出 `outcome:'deny'`、升权超上限、无证据直拒）；规则命中与硬性危险拦截走
 * `ruleRejectText`（需求 §4.3 的独立通知类型）；`error` 判定走通道故障模板。
 * @param {string | undefined} reason - 拒绝原因。
 * @param {{risk?: string, auth?: string} | undefined} fields - 风险与授权证据。
 * @param {string} [lang='zh'] - 文案语言（缺省 zh＝内部直调契约，运行时调用均显式传 agentLangOf 的返回值）。
 * @returns {string} 注入文本。
 */
export function rejectText(reason, fields, lang = 'zh') {
  const risk = fields?.risk ?? '-';
  const authorization = fields?.auth ?? '-';
  return agentT(lang, 'gate.reject.body')
    .replaceAll('{reason}', reason ?? agentT(lang, 'gate.noReason'))
    .replaceAll('{risk}', risk)
    .replaceAll('{auth}', authorization);
}

/**
 * 组装注入给主模型的放行文本；仅在 `ui.inject='all'` 时使用（design §4.4）。
 * @param {{tool?: string, command?: string, reason?: string}} [fields] - 放行信息。
 * @param {string} [lang='zh'] - 文案语言（缺省 zh＝内部直调契约，运行时调用均显式传 agentLangOf 的返回值）。
 * @returns {string} 注入文本。
 */
export function allowText(fields, lang = 'zh') {
  const body = agentT(lang, 'gate.allow.body');
  const parts = body.split('\n');
  const head = parts[0];
  const tail = parts[parts.length - 1];
  const lines = [head];
  if (fields?.tool !== undefined && fields.tool !== '') lines.push(parts[1].replaceAll('{tool}', fields.tool));
  if (fields?.command !== undefined && fields.command !== '') lines.push(parts[2].replaceAll('{command}', fields.command));
  if (fields?.reason !== undefined && fields.reason !== '') lines.push(parts[3].replaceAll('{reason}', fields.reason));
  lines.push(tail);
  return lines.join('\n');
}

/**
 * @param {unknown} error - 捕获值。
 * @returns {string} 单行文本（Error 取 message，其余取 String，均不含堆栈）。
 */
export function describeError(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * 逃逸出口的生效配置读取（design §4.1）：读取抛错按未取得配置处理，默认值由各消费方自带
 * （语言 `en`、注入上限 2048、注入开关 `all`；脱敏与审计的回退在装配层）。
 * @param {(() => object) | undefined} fn - 配置读取函数（`rt.cfg`）。
 * @returns {object | undefined} 生效配置；读取抛错或函数缺失时 `undefined`。
 */
function tryConfig(fn) {
  try {
    return fn?.();
  } catch {
    return undefined;
  }
}

/**
 * 按字节上限裁剪注入文本；超出时保留头部并追加截断标记（design §4.4）。
 * @param {string} text - 原始文本（调用方已完成脱敏）。
 * @param {number | undefined} maxBytes - `ui.injectMaxBytes`。
 * @returns {{text: string, bytes: number, truncated: boolean}} 结果与原始字节数。
 */
export function clipInject(text, maxBytes) {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || bytes <= maxBytes) {
    return { text, bytes, truncated: false };
  }
  const marker = `\n<truncated bytes="${bytes}" />`;
  const budget = Math.max(1, Math.floor(maxBytes) - Buffer.byteLength(marker, 'utf8'));
  let head = text;
  while (head.length > 0 && Buffer.byteLength(head, 'utf8') > budget) {
    head = head.slice(0, -1);
  }
  return { text: `${head}${marker}`, bytes, truncated: true };
}

/**
 * 把 `next()` 包成单次调用守护：第二次调用抛错——审批 waterfall 里一个请求只应消费一次人工通道。
 * 提取为导出工厂以便直测；`onApprovalRequest` 内部即用它。
 * @param {() => Promise<string>} next - 下一个应答者。
 * @returns {() => Promise<string>} 守护后的调用。
 */
export function guardNext(next) {
  let called = false;
  return () => {
    if (called) throw new Error('approve-for-me: next() called twice');
    called = true;
    return Promise.resolve().then(() => next());
  };
}

/**
 * `approval/request` 应答者（prepend）。
 * @param {{agent?: object, toolName?: string, callId?: string, reason?: string, signal?: AbortSignal}} request
 *   - 审批请求。
 * @param {() => Promise<string>} next - 下一个应答者。
 * @param {object} rt - 运行时契约（design §1.2）。
 * @returns {Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>} 闭集结果。
 */
export async function onApprovalRequest(request, next, rt) {
  const id = rt.nextId();
  // 卡片状态表的键：在 `try` 之外声明，`finally` 才能清理（`finally` 与 `try` 不同作用域）。
  const sessionId = request?.agent?.session?.id;
  const callId = typeof request?.callId === 'string' ? request.callId : id;
  // 是否真的把卡片要过来了（关闭审查期间弹卡时 `next()` 可能永远不被调用）。
  // 与 `sessionId` 同理：catch 分支也要读它，必须声明在 `try` 之外。
  let cardRaised = false;
  const originalSignal = request?.signal;
  let gateRef;
  // 注入口径：配置未取到时（`configFor` 自身抛错）按默认 `all` 保守留痕；catch 分支要读它们，
  // 因此声明在 try 之外（design §4.1／§4.4 边界）。
  let injectAllow = true;
  let injectReject = true;
  const timers = [];
  const cancels = [];
  /** 结算记录（design §8.4）是否已落：每审批恰一条结算，竞速分支的重复到达只落第一条。 */
  let settled = false;
  /** 审批跨度起点：恒为请求进入时刻（design §8.5 装配差值口径——结算起点即装配起点：读取配置、解析模型、回查与证据采集全部计入审批跨度，不塞进执行侧）；主流程不再在 screen 后覆盖。请求入口真起点由 requestEntryAt 单独持有——`timeoutFrom=request` 的人工预算从它起算。 */
  const requestEntryAt = Date.now();
  let approvalStartedAt = requestEntryAt;
  /** 确实交人工的时刻（design §8.5 `humanWaitMs` 的起点）：未交人工的路径保持 `undefined`。 */
  let handoffAt;
  /** 生效配置与 screen 结果的引用：逃逸路径（configFor/screen 抛错）取不到时保持 `undefined`。 */
  let activeCfg;
  let activePre;
  /**
   * 落一条结算记录（design §8.4）：按词汇表携带可取得字段；身份与背景字段、起止时间与在场的
   * `queueMs` 可取得时必带，取不到的字段明确缺失。`rt.onSettle` 缺省或抛错都不影响结算本身。
   * @param {'allowed-once' | 'rejected' | 'cancelled'} outcome - 最终结算。
   * @param {'rule' | 'hard' | 'llm' | 'human' | 'timeout' | 'gateway' | 'signal' | 'error'} source - 结算来源。
   * @param {object} [extra] - 其余在场字段（`stage`、`reason`、`queueMs`、`subject`、`escalation`、`preset`）。
   * @returns {void}
   */
  const settleRecord = (outcome, source, extra = {}) => {
    if (settled) return;
    settled = true;
    const endedAt = Date.now();
    try {
      rt.onSettle?.({
        kind: 'settle',
        sessionId,
        callId,
        toolName: typeof request?.toolName === 'string' ? request.toolName : undefined,
        approvalId: id,
        origin: rt.isHeadless?.(request) === true ? 'subagent' : 'main',
        startedAt: approvalStartedAt ?? endedAt,
        endedAt,
        humanWaitMs: handoffAt === undefined ? undefined : Math.max(0, endedAt - handoffAt),
        outcome,
        source,
        escalation: activePre?.fields?.mode,
        // preset 读取自身防抛（design §4.1）：取不到时该字段明确缺失，记录照常落盘。
        preset: (() => {
          try {
            return rt.preset?.(request);
          } catch {
            return undefined;
          }
        })(),
        ...extra,
      });
    } catch {
      // 记录通道故障＝观测范围故障：吞掉，绝不改变结算结果。
    }
  };
  /** 摘要文本字段的统一口径（design §8.2）：先脱敏再按 `context.maxEntryBytes` 保留首尾；配置取不到时不裁剪语义。 */
  const reasonSummary = (reason) =>
    typeof reason === 'string' && reason.length > 0 ? summarizeText(reason, activeCfg, rt.redact) : undefined;
  // label 透传给 rt.timer/rt.onAbort：回调抛错时结算形状带 label，本层据此选超时环节。
  const armTimer = (ms, onFire, label) => {
    const timer = rt.timer(ms, onFire, label);
    timers.push(timer);
    return timer;
  };
  const armAbort = (signal, onFire, label) => {
    const cancel = rt.onAbort(signal, onFire, label);
    cancels.push(cancel);
    return cancel;
  };
  const callNext = guardNext(next);
  const humanOf = () =>
    callNext().then(
      (outcome) => ({ kind: 'human', outcome }),
      (error) => ({ kind: 'human-closed', error }),
    );
  /** 注入通道是否曾抛错：decide 行 degraded 补 `inject-fail` 留痕，不改变结算。 */
  let injectFailed = false;
  /** 注入一条会话页条目；脱敏 + 字节上限在这里统一施加（design §4.4）。 */
  const deliver = (text, cfg) => {
    const redacted = typeof rt.redact === 'function' ? rt.redact(text) : text;
    const clipped = clipInject(redacted, cfg?.ui?.injectMaxBytes);
    // 注入通道抛错（替身或宿主 inject 异常）不得中断结算——留痕后照常返回。
    // 防御口径三处同款：本函数、下方 catch 分支的注入、index.js 逃逸出口的注入（均 try/catch 留痕）。
    try {
      rt.inject(request?.agent, clipped.text);
    } catch {
      injectFailed = true;
    }
    return clipped;
  };
  /** decide 行并入 `inject-fail` 降级标记；既有降级值以 `+` 连接。 */
  const injectFailFields = (fields) =>
    injectFailed
      ? { degraded: fields?.degraded && fields.degraded !== 'none' ? `${fields.degraded}+inject-fail` : 'inject-fail' }
      : {};

  try {
    // 预设未命中「自动审批」时完全不介入：不解析模型、不调 LLM、不注入（design §2.1）。
    if (rt.mode(request) !== 'auto') return await callNext();

    // 装配并入审查时限（requirements §4.2／design §4.3）：接管判定通过后即建立取消监听与
    // 装配计时器，配置读取、审查模型解析、操作回查与送审证据采集（装配）与之竞速——装配挂起
    // 按审查时限有界等待，无固定内部上限：计时器时限取当前生效配置的 reviewer.timeoutMs（与
    // configFor 的配置读取同源的先验值；读不到时取 schema 默认）。装配消耗不补回、起点回溯请求
    // 进入时刻；到点即弃置装配结果（弃置＝中止该步骤对结算的影响；宿主服务签名不带中止信号，
    // 物理中止不可达）。排队等待不消耗审查预算——审查计时器经审查开始回调在出队后按剩余预算
    // 武装（design §4.3/§5.1，见下文）。
    const assemblyTimeoutMs = () => {
      const ms = tryConfig(rt.cfg)?.reviewer?.timeoutMs;
      return Number.isFinite(ms) && ms >= 0 ? ms : REVIEWER_TIMEOUT_DEFAULT_MS;
    };
    let assemblyMs = assemblyTimeoutMs();
    const cancelled = armAbort(originalSignal, () => ({ kind: 'cancelled' }), 'request');
    const assemblyTimer = armTimer(assemblyMs, () => ({ kind: 'assembly-timeout', timeoutMs: assemblyMs }), 'assembly');
    // 装配异常经外层 catch 按内部错误结算。
    const assembly = (async () => {
      const cfg = await rt.configFor(request);
      const located = await rt.locate(request);
      // 送审证据在装配段采集（design §3.2/§4.3）：与配置读取、回查共用审查预算，经 rt 契约随
      // 请求传入审查入口——排队与在飞期间的配置热改不换走本请求的取材。
      const evidence = rt.evidence?.(request, cfg);
      return { cfg, located, evidence };
    })().then(
      (done) => ({ kind: 'assembly-done', ...done }),
      (error) => ({ kind: 'assembly-error', error }),
    );
    const firstAssembly = await Promise.race([assembly, assemblyTimer.promise, cancelled.promise]);
    if (firstAssembly.kind === 'cancelled') {
      // 装配期间请求取消：卡片未弹、审查未起，直接按取消结算；取消不计数（design §5.3）。
      rt.audit({ id, phase: 'decide', decision: 'cancelled', source: 'signal', inject: 'no' });
      settleRecord('cancelled', 'signal');
      return 'cancelled';
    }
    if (firstAssembly.kind === 'assembly-error') throw firstAssembly.error;
    if (firstAssembly.kind === 'callback-error' && firstAssembly.side === 'abort') {
      // 取消监听回调抛错：保持取消语义（requirements §4.2「取消处理自身出错时保持取消语义」；
      // 生产监听回调不可抛、rt.onAbort 出错时收束为该形状，与审查侧 settleCallbackError 同口径），不计数。
      rt.audit({ id, phase: 'decide', decision: 'cancelled', source: 'signal', inject: 'no' });
      settleRecord('cancelled', 'signal');
      return 'cancelled';
    }
    if (firstAssembly.kind !== 'assembly-done') {
      // 装配超时（或装配计时器回调抛错）：按超时拒绝结算，环节记装配、不写成审查超时
      // （requirements §4.3），并经 rt.countTimeout 与真实审查超时同一路径计数（design §5.3）。
      // 配置未读到时语言与注入按全局配置回落（与外层 catch 同款防御）。
      const fallbackCfg = tryConfig(rt.cfg);
      assemblyMs = firstAssembly.timeoutMs ?? assemblyMs;
      const callbackError = firstAssembly.kind === 'callback-error' ? firstAssembly.error : undefined;
      const text = timeoutText('assembly', assemblyMs, agentLangOf(fallbackCfg));
      const doInject = fallbackCfg?.ui?.inject !== 'off';
      const injected = doInject ? deliver(text, fallbackCfg) : undefined;
      const why = callbackError === undefined
        ? '装配超时：配置读取、审查模型解析或操作回查未在时限内完成'
        : `计时回调抛错（assembly）：${describeError(callbackError)}`;
      try { rt.countTimeout?.(); } catch { /* 计数通道故障不改变结算 */ }
      rt.audit({
        id,
        phase: 'decide',
        decision: 'rejected',
        source: 'timeout',
        inject: doInject ? 'yes' : 'no',
        injectBytes: injected?.bytes ?? 0,
        reason: callbackError === undefined ? undefined : why,
        ...injectFailFields(),
      });
      settleRecord('rejected', 'timeout', { stage: 'assembly', reason: reasonSummary(why) });
      return 'rejected';
    }

    const { cfg, located, evidence } = firstAssembly;
    activeCfg = cfg;
    injectAllow = cfg.ui.inject === 'all';
    injectReject = cfg.ui.inject !== 'off';
    const pre = rt.screen(request, located, cfg);
    activePre = pre;

    if (pre.action === 'skip') {
      // 三类跳过（mode=off／工具清单过滤／非升权）留痕——同 `(会话, 因)` 首行去重（记忆宿主在 mode 闭包，
      // 应答者逐请求调用不能自持状态）；`trigger.auditEverySkip` 为真时全量。reason 取 why 原文（含上下文，比裸 token 可查）。
      if (rt.gateSkip?.(sessionId, pre.why) !== false) {
        rt.audit({ id, phase: 'screen', action: 'skip', source: 'policy', reason: pre.why, ...pre.fields });
      }
      return await callNext();
    }

    if (pre.action === 'deny') {
      // 规则强制检查与硬性危险拦截命中：不调 next()、不消耗 LLM，LLM 与人工都不能推翻。
      // 结算来源随命中层区分（design §12.1）：硬性拦截 `hard`，规则直拒 `rule`。
      // 通知分型（需求 §4.3）：规则命中的直接拒绝走专用模板（含合规重送路径、无禁止绕过尾句）；
      // 升权超上限与无证据直拒仍走安全拒绝模板。
      const ruleHit = pre.fields.source === 'hard' || pre.fields.source === 'rule';
      const injected = injectReject
        ? deliver(
            ruleHit ? ruleRejectText(pre.reason, agentLangOf(cfg)) : rejectText(pre.reason, pre.fields, agentLangOf(cfg)),
            cfg,
          )
        : undefined;
      settleRecord('rejected', pre.fields.source === 'hard' ? 'hard' : 'rule', {
        reason: reasonSummary(pre.reason),
        subject: subjectSummary(located, cfg, rt.redact),
      });
      rt.audit({
        id,
        phase: 'screen',
        decision: 'rejected',
        source: 'rule',
        reason: pre.reason,
        inject: injectReject ? 'yes' : 'no',
        injectBytes: injected?.bytes ?? 0,
        ...pre.fields,
      });
      return 'rejected';
    }

    // 审查开始即写一条 screen 审计：它同时是本次请求的计时起点，
    // 之后的 review/decide 行据此得到真实耗时（design §8.1）。
    rt.audit({ id, phase: 'screen', ...pre.fields });

    // 卡片状态表的登记点（design §7.4）：客户端据 sessionId 轮询。卡片视角的 startedAt 取
    // 登记时刻；结算记录的跨度起点（approvalStartedAt）保持请求进入锚点（§8.5 装配差值口径），
    // 两者服务不同视图，不共用。
    const startedAt = Date.now();
    const setPending = (state, extra = {}) =>
      rt.pending?.set?.(sessionId, { callId, state, startedAt, ...extra });

    const gate = rt.withdraw(request);
    gateRef = gate;
    // 无头会话（委派子代理，design §2.2）：没有可交互的人工应答者——全程不 `next()`、
    // 不写 pending 卡片态、`fallback='ask'` 也按拒绝结算（交人工等于无限挂起）。
    const headless = rt.isHeadless?.(request) === true;
    // 人工卡片：默认在审查期间就让卡片出现（`ui.humanCardDuringReview = true`）；
    // 关闭时推迟到「确定需要人工」之后才调用唯一的一次 `next()`（requirements §4.1）。
    const cardDuringReview = !headless && cfg.ui.humanCardDuringReview !== false;
    let human;
    const humanOnce = () => {
      if (human === undefined) human = humanOf();
      cardRaised = true;
      return human;
    };
    // 审查时限零值与装配耗尽（requirements §4.4「立即超时，不开始尝试」）：能走到这里说明
    // 规则层（skip／deny）已放行——零值或预算已被装配（含规则判定）耗尽时，不发起 LLM 审查，
    // 按装配环节超时结算；时限为正且尚有余量时才弹卡进入审查竞速。检查先于弹卡执行：
    // 该路径的立即结算与收尾信号恢复在同一同步块完成，宿主的撤回通道观测不到投影信号，
    // 先弹后撤的卡片必然残留为可操作的孤儿分发；且一张弹出即撤的卡片展示的是一次从未
    // 开始的尝试，没有存在意义。人工预算耗尽的既定语义维持「照常弹卡并随立即结算撤回」：
    // 该路径有审查竞速的异步边界，撤回可被宿主观测（两类预算耗尽的差别在结算路径有无
    // 异步边界，design §4.3）。
    const reviewDeadlineAt = requestEntryAt + cfg.reviewer.timeoutMs;
    if (cfg.reviewer.timeoutMs <= 0 || reviewDeadlineAt - Date.now() <= 0) {
      // 检查先于 humanOnce，无卡可撤（cardRaised 恒假，守卫保留作防御）；审查未起也就无
      // 在飞流可中止。零值/耗尽到点与其他超时同一路径计数（design §5.3）。
      if (cardRaised && gate.canWithdraw) gate.abort(new Error('approve-for-me: review timeout'));
      try { rt.countTimeout?.(); } catch { /* 计数通道故障不改变结算 */ }
      const text = timeoutText('assembly', cfg.reviewer.timeoutMs, agentLangOf(cfg));
      const injected = injectReject ? deliver(text, cfg) : undefined;
      rt.audit({
        id,
        phase: 'decide',
        decision: 'rejected',
        source: 'timeout',
        inject: injectReject ? 'yes' : 'no',
        injectBytes: injected?.bytes ?? 0,
        ...injectFailFields(),
      });
      settleRecord('rejected', 'timeout', {
        stage: 'assembly',
        reason: reasonSummary(cfg.reviewer.timeoutMs <= 0
          ? '审查时限为零，立即超时（不开始尝试）'
          : '审查时限被装配耗尽，立即超时（不开始尝试）'),
      });
      return 'rejected';
    }
    if (cardDuringReview) humanOnce();
    const reviewAbort = new AbortController();
    // null 与 undefined 同路径（AbortSignal.any 对 null 成员抛 TypeError；rt.onAbort 侧同款口径）。
    const reviewSignal = originalSignal === undefined || originalSignal === null
      ? reviewAbort.signal
      : AbortSignal.any([reviewAbort.signal, originalSignal]);
    // 审查计时器三段预算（design §4.3/§5.1）：请求进入时只建竞速占位——排队等待不消耗审查
    // 预算，队列段的超时由排队上限承担；出队交接复核后经 `onReviewStart` 回调按剩余预算
    // （时限 − 非排队流逝）武装真实计时器，到点结果经本 Promise 兑现，回调触达前永不结算。
    let settleReviewTimer;
    const reviewTimerRace = new Promise((resolve) => { settleReviewTimer = resolve; });
    /**
     * 武装审查计时器并补写卡片审查截止；`rt.review` 的审查开始回调（index 在调度器任务体
     * 首步、交接复核后触发）调用。非排队流逝＝请求进入起、扣除排队等待 `queueMs`：装配
     * （含证据采集）消耗不补回，排队不计入；剩余非正＝装配已耗尽预算，按装配环节超时
     * 立即结算（design §5.1：环节记装配、不开始尝试），不走钳位武装。
     */
    const armReviewBudget = (queueMs) => {
      // 竞速已结算（人工时限先到、请求取消等他路先收束）：不武装、不补写——迟到的回调不得
      // 在收尾清理（pending.clear）之后重新登记幽灵状态条目（design §7.4 以结算为界）。
      if (settled) return;
      const elapsedExQueue = Math.max(0, Date.now() - Math.max(0, queueMs ?? 0) - requestEntryAt);
      // 剩余非正＝装配已耗尽预算（design §5.1）：不武装审查计时器——钳 1ms 会把装配耗尽
      // 冒充成审查超时。中止信号用审查超时形状，令任务体在发起模型调用前返回（不开始
      // 尝试）；计数经任务结果照旧（design §5.3 与真实超时同路），gate 侧不重复计数。
      if (cfg.reviewer.timeoutMs - elapsedExQueue <= 0) {
        reviewAbort.abort(new Error(REVIEW_TIMEOUT_ABORT_MESSAGE));
        settleReviewTimer({ kind: 'assembly-exhausted' });
        return;
      }
      const remainingMs = cfg.reviewer.timeoutMs - elapsedExQueue;
      const timer = armTimer(remainingMs, () => {
        reviewAbort.abort(new Error(REVIEW_TIMEOUT_ABORT_MESSAGE));
        return { kind: 'review', verdict: { decision: 'error', reason: 'review timeout', timedOut: true } };
      }, 'review');
      timer.promise.then(settleReviewTimer, settleReviewTimer);
      // 卡片补写审查截止（design §7.4）：排队段只显示状态不带倒计时，出队武装后才有截止时刻。
      if (!headless) setPending('reviewing', { deadlineAt: Date.now() + remainingMs, deadlineKind: 'review' });
    };
    // 审查记录的审批上下文（design §8.2 摘要字段词汇表）：审查请求不带 sessionId（I4），reviewer 与存储都不查会话，
    // 会话/调用/工具名只能在这里（三个字段都已在作用域内）补进审查调用的 opts，随判定一起回到 onReview 落进记录；
    // approvalId/origin/escalation/preset 同源补入——审查记录与结算记录靠 approvalId 合并。
    const review = rt.review(request, located, pre, cfg, {
      id,
      signal: reviewSignal,
      // 审查开始回调（design §5.1）：回调未触达（队列满/排队超时/冷却/排队中止）时计时器保持
      // 占位，队列段的超时由排队上限结算，不按审查超时补计。
      onReviewStart: armReviewBudget,
      // 装配段采集的送审证据（design §3.2）：随请求传入，生产路径不在审查入口重复采集。
      evidence,
      trace: {
        sessionId,
        callId,
        toolName: request?.toolName,
        approvalId: id,
        origin: headless ? 'subagent' : 'main',
        escalation: pre.fields?.mode,
        // preset 读取防抛（design §4.1，与结算记录同款）：取不到时该字段缺失——背景信息不成立
        // 不得让审查整个夭折（否则 preset 服务故障会把审批翻成内部异常拒绝）。
        preset: (() => {
          try {
            return rt.preset?.(request);
          } catch {
            return undefined;
          }
        })(),
      },
    }).then(
      (verdict) => ({ kind: 'review', verdict }),
      (error) => ({ kind: 'review', verdict: { decision: 'error', reason: describeError(error) } }),
    );

    // `timeoutFrom=request` 的人工截止时间：从请求进入应答者起算（requirements §4.2），异步配置读取、模型解析、定位与排队等待都消耗该预算（人工预算不排除排队段，与审查预算的三段划分不同）；`handoff` 起算不使用该值。交人工（含竞速期计时器）只用剩余时间，预算已耗尽不重新赠予——与人工 0 同权直接按人工超时结算。
    const humanDeadlineAt = requestEntryAt + cfg.human.timeoutMs;
    let humanTimer =
      cardDuringReview && cfg.fallback === 'ask' && cfg.human.timeoutFrom === 'request'
        ? cfg.human.timeoutMs === 0 || humanDeadlineAt - Date.now() <= 0
          ? { promise: Promise.resolve({ kind: 'human-timeout' }) }
          : armTimer(humanDeadlineAt - Date.now(), () => ({ kind: 'human-timeout' }), 'human')
        : { promise: new Promise(() => {}) };

    // 关闭模式不把人工放进竞速：卡片此刻还没出现，人工无法作答（requirements §4.1）。
    // 状态条从审查开始就是 `reviewing`；排队段不带审查截止——审查计时器尚未武装
    // （design §7.4/§5.1），出队后由审查开始回调补写截止时刻；零值与装配耗尽在进入审查
    // 竞速前已按立即超时结算，不会以无截止形态驻留。无头会话没有卡片可驱动，pending 状态表不写。
    if (!headless) {
      setPending('reviewing');
    }
    const racers = [review, reviewTimerRace, cancelled.promise];
    if (cardDuringReview) racers.push(humanOnce(), humanTimer.promise);
    const first = await Promise.race(racers);

    if (first.kind === 'review') {
      if (first.verdict.decision === 'allow') {
        // 卡片没被要过来时（关闭审查期间弹卡）没有可撤回的对象：不改写 signal，审计记缺省值 `skipped`。
        if (cardRaised && gate.canWithdraw) gate.abort(new Error('approve-for-me: auto-approved'));
        const injected = injectAllow
          ? deliver(allowText({ tool: request?.toolName, command: located?.command, reason: first.verdict.reason }, agentLangOf(cfg)), cfg)
          : undefined;
        rt.audit({
          id,
          phase: 'decide',
          decision: 'allowed-once',
          source: 'llm',
          inject: injectAllow ? 'yes' : 'no',
          injectBytes: injected?.bytes ?? 0,
          withdraw: cardRaised ? (gate.canWithdraw ? 'ok' : 'unavailable') : 'skipped',
          ...first.verdict.fields,
          ...injectFailFields(first.verdict.fields),
        });
        settleRecord('allowed-once', 'llm', {
          reason: reasonSummary(first.verdict.reason),
          queueMs: first.verdict.queueMs,
          subject: subjectSummary(located, cfg, rt.redact),
        });
        return 'allowed-once';
      }
      if (cfg.fallback === 'reject' || headless) {
        // 无头会话（委派子代理）没有人工通道：`fallback='ask'` 也按拒绝结算。
        if (cardRaised && gate.canWithdraw) gate.abort(new Error('approve-for-me: review rejected'));
        // 三文案按结局分选，选择逻辑集中在本分支：超时／deny（判定为危险）／
        // 其余 error（含 queue-overflow、breaker-open、空输出、内部异常收敛的 error 判定）→ 通道故障。
        // 环节与时限取审查层带来的真值（排队超时的环节是 queue、时限是排队等待上限），缺失时按审查超时回退。
        const text = first.verdict.timedOut === true
          ? timeoutText(first.verdict.timeoutStage ?? 'review', first.verdict.timeoutMs ?? cfg.reviewer.timeoutMs, agentLangOf(cfg))
          : first.verdict.decision === 'deny'
            ? rejectText(first.verdict.reason, first.verdict.fields, agentLangOf(cfg))
            : errorText(first.verdict.reason, agentLangOf(cfg));
        const injected = injectReject ? deliver(text, cfg) : undefined;
        rt.audit({
          id,
          phase: 'decide',
          decision: 'rejected',
          source: 'llm',
          inject: injectReject ? 'yes' : 'no',
          injectBytes: injected?.bytes ?? 0,
          ...first.verdict.fields,
          ...injectFailFields(first.verdict.fields),
        });
        // 结算来源与环节（design §8.4）：排队超时＝timeout＋stage=queue（队列已满与冷却未执行＝llm＋stage=queue，
        // 由 index 的失败判定带 stage）；审查超时＝timeout＋stage=review；其余＝llm。
        settleRecord('rejected', first.verdict.timedOut === true ? 'timeout' : 'llm', {
          stage: first.verdict.timedOut === true ? (first.verdict.timeoutStage ?? 'review') : first.verdict.stage,
          reason: reasonSummary(first.verdict.reason),
          queueMs: first.verdict.queueMs,
          subject: subjectSummary(located, cfg, rt.redact),
        });
        return 'rejected';
      }
      // fallback === 'ask'：交人工；计时器必须新建，不能复用已清理的对象。
      if (cfg.human.timeoutFrom === 'handoff') {
        // 零时限＝交人工即耗尽：不调 next() 弹卡（马上消失的卡片，requirements §4.2）、不写 handoff 行，
        // 直接按人工超时结算（stage=human、humanWaitMs 缺失＝未真的交人工）。
        if (cfg.human.timeoutMs === 0) return await settleTimeout();
        if (!cardDuringReview) humanOnce();
        humanTimer = armTimer(cfg.human.timeoutMs, () => ({ kind: 'human-timeout' }), 'human');
      } else {
        // `timeoutFrom='request'`：截止时间从请求进入起算（humanDeadlineAt 的定义处），装配前置等待与审查都可能已吃掉大半预算。
        // 关闭模式下剩余 ≤ 0 时**不调 next()**：否则卡片会一闪而过又被撤回（requirements §4.2）。
        const left = humanDeadlineAt - Date.now();
        // 预算已耗尽＝没有真的交人工：不写 `handoff` 行，只留下面 settleTimeout 的 `decide source=timeout`。
        if (left <= 0) return await settleTimeout();
        if (!cardDuringReview) humanOnce();
        humanTimer = armTimer(left, () => ({ kind: 'human-timeout' }), 'human');
      }
      // 确实进入等人工（卡片已在屏幕上或刚刚弹出）才记 handoff 行（design §4.1）；
      // 该时点也是 `humanWaitMs` 的起点（design §8.5：从确实交人工起算）。
      handoffAt = Date.now();
      rt.audit({ id, phase: 'handoff', decision: 'ask', source: 'llm', inject: 'no', ...first.verdict.fields });
      // 人工时限就是卡片倒计时的权威（design §7.4）；状态改写为 `waiting-human` 并携带原因类别。
      // 人工时限为 0：交人工立即按拒绝结算，不登记人工阶段的卡片状态——不出现无截止时间
      // 的人工待决状态（design §4.3：零时限瞬态不得进入状态表）。
      if (cfg.human.timeoutMs > 0) {
        // 原因类别（design §7.4）：审查超时 / 模型判定拒绝 / 其余通道故障
        // （队列已满、冷却未执行、正文为空等未取得有效结论的 error 判定）。
        const pendingCause = first.verdict.timedOut === true ? 'timeout' : first.verdict.decision === 'deny' ? 'deny' : 'error';
        setPending('waiting-human', {
          cause: pendingCause,
          reason: pendingCause === 'timeout' ? '' : (first.verdict.reason ?? ''),
          deadlineAt: cfg.human.timeoutFrom === 'handoff' ? Date.now() + cfg.human.timeoutMs : humanDeadlineAt,
          deadlineKind: 'human',
        });
      }
      const second = await Promise.race([humanOnce(), humanTimer.promise, cancelled.promise]);
      return await settleHuman(second);
    }

    if (first.kind === 'human') {
      reviewAbort.abort(REVIEW_SUPERSEDED);
      rt.audit({ id, phase: 'decide', decision: first.outcome, source: 'human', inject: 'no' });
      // 抢答：审查未收束即人工作答，没有「确实交人工」的等待段，humanWaitMs 缺失（design §8.5）。
      settleRecord(first.outcome, 'human', {
        subject: located === undefined ? undefined : subjectSummary(located, cfg, rt.redact),
      });
      return first.outcome;
    }

    if (first.kind === 'human-timeout') return await settleTimeout();

    // 出队回调发现剩余非正（design §5.1 装配耗尽）：立即按装配环节超时结算——与进入竞速前
    // 的零值/装配耗尽同形状（rejected/timeout、stage=assembly、不开始尝试）。
    if (first.kind === 'assembly-exhausted') return settleAssemblyExhausted();

    if (first.kind === 'callback-error') return await settleCallbackError(first);

    if (first.kind === 'human-closed') {
      reviewAbort.abort(REVIEW_SUPERSEDED);
      rt.audit({ id, phase: 'decide', decision: 'cancelled', source: 'gateway', inject: 'no' });
      settleRecord('cancelled', 'gateway');
      return 'cancelled';
    }

    // first.kind === 'cancelled'：原始 signal 表达「工具调用被取消」。
    reviewAbort.abort(REVIEW_SUPERSEDED);
    if (cardRaised && gate.canWithdraw) gate.abort(new Error('approve-for-me: tool cancelled'));
    rt.audit({ id, phase: 'decide', decision: 'cancelled', source: 'signal', inject: 'no' });
    settleRecord('cancelled', 'signal');
    return 'cancelled';

    /**
     * 人工超时：撤回卡片、拒绝、注入**超时**文案（点明可重试）。
     * 可得字段（design §8.4）：`subject` 与其他结算同源（回查结果生成）；`reason` 取本次审查结论
     * 携带的理由——无 review 记录的故障转人工路径（冷却未执行、队列已满、排队超时）没有审查记录
     * 可承载理由，结算记录是该理由的唯一留痕，结论在场必须保存；审查未收束（人工时限在审查竞速
     * 期间到点，first 为 human-timeout）时明确缺失、不伪造；`queueMs` 结论携带时随结算保存。
     * @returns {Promise<'rejected'>} 结果。
     */
    async function settleTimeout() {
      reviewAbort.abort(REVIEW_SUPERSEDED);
      if (cardRaised && gate.canWithdraw) gate.abort(new Error('approve-for-me: human timeout'));
      const injected = injectReject ? deliver(timeoutText('human', cfg.human.timeoutMs, agentLangOf(cfg)), cfg) : undefined;
      const verdict = first.kind === 'review' ? first.verdict : undefined;
      const reason = verdict !== undefined && typeof verdict.reason === 'string' ? reasonSummary(verdict.reason) : undefined;
      rt.audit({
        id,
        phase: 'decide',
        decision: 'rejected',
        source: 'timeout',
        inject: injectReject ? 'yes' : 'no',
        injectBytes: injected?.bytes ?? 0,
        ...(reason !== undefined ? { reason } : {}),
        ...injectFailFields(),
      });
      // 人工时限到点：stage=human；handoffAt 未定义＝预算在审查期间耗尽、未及交人工（humanWaitMs 缺失）。
      settleRecord('rejected', 'timeout', {
        stage: 'human',
        subject: subjectSummary(located, cfg, rt.redact),
        ...(reason !== undefined ? { reason } : {}),
        ...(verdict?.queueMs !== undefined ? { queueMs: verdict.queueMs } : {}),
      });
      return 'rejected';
    }

    /**
     * 出队回调发现剩余非正（design §5.1 装配耗尽）的立即结算：与进入竞速前的零值／装配
     * 耗尽同形状——rejected/timeout、环节记装配、通知按装配超时模板、不开始尝试（中止
     * 信号已在 `armReviewBudget` 发出，任务体在发起模型调用前返回）。计数差别：这里审查
     * 任务已在跑，计数经任务结果照旧（design §5.3，scheduler.record 在任务体内结算），
     * gate 侧不重复 `countTimeout` 防双计。
     * @returns {'rejected'} 结果。
     */
    function settleAssemblyExhausted() {
      if (cardRaised && gate.canWithdraw) gate.abort(new Error('approve-for-me: review timeout'));
      const injected = injectReject ? deliver(timeoutText('assembly', cfg.reviewer.timeoutMs, agentLangOf(cfg)), cfg) : undefined;
      rt.audit({
        id,
        phase: 'decide',
        decision: 'rejected',
        source: 'timeout',
        inject: injectReject ? 'yes' : 'no',
        injectBytes: injected?.bytes ?? 0,
        ...injectFailFields(),
      });
      settleRecord('rejected', 'timeout', {
        stage: 'assembly',
        reason: reasonSummary('审查时限被装配耗尽，立即超时（不开始尝试）'),
        subject: subjectSummary(located, cfg, rt.redact),
      });
      return 'rejected';
    }

    /**
     * 计时/中止回调抛错的结算（design §4.2）：按本义结算——timer 侧按超时语义拒绝
     * （label 决定环节，缺省 review），abort 侧按取消语义；decide 行 source=error、
     * reason 点明「计时回调抛错／中止回调抛错」。gate 仍是唯一 decide 行写入者。
     * 计数口径（design §5.3）：审查环节的计时回调抛错与其他审查超时同权——在飞审查流按超时标记中止，
     * reviewer 走既有 error 判定、经唯一计数点计数；人工时限环节与中止侧维持被替代标记，不计。
     * label 闭集契约：armTimer 的调用点只用 'review'、'human' 与 'assembly' 三个 label（'assembly'
     * 的装配竞速结果——timer 侧与 abort 侧——都在装配分支就地结算、不进入本函数）；新增计时器必须显式归类——缺省/未知 label
     * 一律按审查环节超时结算并计数（fail-closed 方向，宁多计不漏计）。
     * @param {{side: 'timer' | 'abort', label?: string, error: unknown}} race - 竞速结果。
     * @returns {Promise<'rejected' | 'cancelled'>} 结果。
     */
    async function settleCallbackError(race) {
      reviewAbort.abort(
        race.side === 'timer' && race.label !== 'human'
          ? new Error(REVIEW_TIMEOUT_ABORT_MESSAGE)
          : REVIEW_SUPERSEDED,
      );
      if (race.side === 'abort') {
        if (cardRaised && gate.canWithdraw) gate.abort(new Error('approve-for-me: abort callback threw'));
        rt.audit({
          id,
          phase: 'decide',
          decision: 'cancelled',
          source: 'error',
          inject: 'no',
          reason: `中止回调抛错（${race.label ?? 'request'}）：${describeError(race.error)}`,
          ...injectFailFields(),
        });
        // 中止侧回调抛错无法辨认环节：stage 省略（design §8.4）。
        settleRecord('cancelled', 'error', {
          reason: reasonSummary(`中止回调抛错（${race.label ?? 'request'}）：${describeError(race.error)}`),
        });
        return 'cancelled';
      }
      const stage = race.label === 'human' ? 'human' : 'review';
      if (cardRaised && gate.canWithdraw) gate.abort(new Error('approve-for-me: timer callback threw'));
      const ms = stage === 'human' ? cfg.human.timeoutMs : cfg.reviewer.timeoutMs;
      const injected = injectReject ? deliver(timeoutText(stage, ms, agentLangOf(cfg)), cfg) : undefined;
      rt.audit({
        id,
        phase: 'decide',
        decision: 'rejected',
        source: 'error',
        inject: injectReject ? 'yes' : 'no',
        injectBytes: injected?.bytes ?? 0,
        reason: `计时回调抛错（${race.label ?? 'review'}）：${describeError(race.error)}`,
        ...injectFailFields(),
      });
      settleRecord('rejected', 'error', {
        stage,
        reason: reasonSummary(`计时回调抛错（${race.label ?? 'review'}）：${describeError(race.error)}`),
      });
      return 'rejected';
    }

    /**
     * 交人工阶段的结算。
     * @param {{kind: string, outcome?: string}} race - 竞速结果。
     * @returns {Promise<string>} 闭集结果。
     */
    async function settleHuman(race) {
      if (race.kind === 'human') {
        rt.audit({ id, phase: 'decide', decision: race.outcome, source: 'human', inject: 'no' });
        settleRecord(race.outcome, 'human');
        return race.outcome;
      }
      if (race.kind === 'human-timeout') return await settleTimeout();
      if (race.kind === 'callback-error') return await settleCallbackError(race);
      if (race.kind === 'human-closed') {
        rt.audit({ id, phase: 'decide', decision: 'cancelled', source: 'gateway', inject: 'no' });
        settleRecord('cancelled', 'gateway');
        return 'cancelled';
      }
      if (cardRaised && gate.canWithdraw) gate.abort(new Error('approve-for-me: tool cancelled during handoff'));
      rt.audit({ id, phase: 'decide', decision: 'cancelled', source: 'signal', inject: 'no' });
      settleRecord('cancelled', 'signal');
      return 'cancelled';
    }
  } catch (error) {
    // I2/I8：绝不外抛；错误路径一律 fail-closed——拒绝 + 按 `ui.inject` 注入 + 按需撤回，不交人工。
    if (cardRaised && gateRef?.canWithdraw === true) gateRef.abort(error);
    // 注入文本走语言档；内部异常是通道故障不是安全判定：`gate.internalError` 键拼进
    // 通道故障模板的 {reason} 位，不另包拒绝模板。审计行 reason 的措辞是排除项，保持中文不动。
    // 生效配置读取一律防抛（design §4.1）：读取抛错按未取得配置处理，语言回落 `en`、注入上限回落 2048。
    const errorLang = agentLangOf(tryConfig(rt.cfg));
    const text = errorText(agentT(errorLang, 'gate.internalError').replaceAll('{error}', describeError(error)), errorLang);
    let bytes = 0;
    /** catch 分支的注入同样不得外抛——三处注入调用点同口径（deliver、本处、index.js 逃逸出口）：try/catch 留痕后继续 fail-closed。 */
    let injectFailedHere = false;
    if (injectReject) {
      const redacted = typeof rt.redact === 'function' ? rt.redact(text) : text;
      const clipped = clipInject(redacted, tryConfig(rt.cfg)?.ui?.injectMaxBytes ?? 2048);
      bytes = clipped.bytes;
      try {
        rt.inject(request?.agent, clipped.text);
      } catch {
        injectFailedHere = true;
      }
    }
    rt.audit({
      id,
      phase: 'error',
      decision: 'rejected',
      source: 'error',
      inject: injectReject ? 'yes' : 'no',
      injectBytes: bytes,
      ...(injectFailedHere ? { degraded: 'inject-fail' } : {}),
      // 只写 `reason`：审计字段表里没有 `why` 这一列，写它等于多一个不会被渲染的字段（design §8.1）。
      reason: `审查器内部错误：${describeError(error)}`,
    });
    // 应答者逃逸（主流程抛错、入口最外层捕获并按拒绝结算）：身份背景取得到就带（design §8.4「可取得时必带」）。
    settleRecord('rejected', 'error', {
      reason: reasonSummary(`审查器内部错误：${describeError(error)}`),
    });
    return 'rejected';
  } finally {
    for (const timer of timers) timer.clear();
    for (const cancel of cancels) cancel.clear();
    // 收尾恢复请求对象的原始信号（design §4.2）：请求对象离场不携带投影副作用，再次到达按新请求处理；
    // 同一性守卫在 restore 内部——信号已不是本次写入的投影时跳过、不覆盖新值；
    // 恢复自身失败只留观测记录，不中断其余清理。
    try {
      gateRef?.restore?.();
    } catch (error) {
      rt.audit({ id, phase: 'error', source: 'signal', reason: `收尾恢复请求信号失败：${describeError(error)}` });
    }
    // 结算即从卡片状态表移除：下次读取不再渲染本审批的状态行；轮询随会话清理收尾，
    // 命令与按钮由宿主挂载期持有（design §7.4 限定宿主仍挂载，撤回卸载后由宿主清理）。
    rt.pending?.clear?.(sessionId, callId);
  }
}
