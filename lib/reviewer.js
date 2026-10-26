/**
 * dsh-approve-for-me — 审查循环。
 *
 * 用 `ctx.llm.stream({ tools })` 自建循环：工具定义只出现在审查请求里，工具执行由只读封装完成，
 * 全程不经过工具注册表、沙箱策略与审批服务，因此审查自身不会触发新的审批。
 * 消息序列必须满足三条不变量：I5 每个 `tool-call` 恰好一条 `ToolResultMessage`；
 * I6 先 assistant 再 tool；I7 参数解析失败也要回喂错误结果，不得跳过（design §3.6）。
 * 可重试错误类（`retryableOutcome`）在循环外包一层尝试循环：整建尝试至多
 * `REVIEW_MAX_ATTEMPTS` 次（首次＋1 次重试），gate 的审查计时器仍是预算权威（signal 中止即不再尝试）。
 * gate 他路先结算引发的中止型 error 带 `superseded` 标记（非通道故障，不计冷却）。
 * @module dsh-approve-for-me/reviewer
 */
import { agentT } from './agent-texts.js';
import { agentLangOf, REVIEW_SUPERSEDED, REVIEW_TIMEOUT_ABORT_MESSAGE } from './gate.js';
import { clipKeepEnds, configTagOf, subjectText } from './record-fields.js';
import { renderArguments, toolBudgetExhausted } from './prompt.js';
import { PLUGIN_MESSAGE_SOURCE } from './source.js';
import { redact, truncateKeepEnds, TRANSCRIPT_READ_FAILED } from './transcript.js';

/** `rationale` 缺失或空白时的固定文案。 */
export const DEFAULT_RATIONALE = 'No rationale provided by the reviewer.';

/** `risk_level` 允许取值。 */
const RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical']);
/** `user_authorization` 允许取值。 */
const AUTHORIZATION_LEVELS = new Set(['unknown', 'low', 'medium', 'high']);

/**
 * 解析模型最终输出（design §3.7）。
 * 容忍散文包裹与缺省字段；任何无法确定的输入收敛为 `decision='error'`，由上层 fail-closed。
 * `fieldsDefaulted` 只表示「`risk_level`/`user_authorization` 缺失并按 outcome 回退」，是审计观测值，
 * 与「审计行本身被截断」（`lib/audit.js` 的 `truncated`）和「模型输出被截断」（`degraded=output-truncated`）都不是一回事；
 * `defaulted` 是记录字段 `fieldsDefaulted` 的清单形态（`risk`/`auth`/`reason` 的子集，含 rationale 回退）。
 * @param {unknown} text - 模型最后一条 assistant 文本。
 * @returns {{decision: 'allow' | 'deny' | 'error', risk?: string, authorization?: string, reason: string, fieldsDefaulted: boolean, defaulted: string[]}}
 *   解析结果。
 */
export function parseAssessment(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { decision: 'error', reason: 'empty payload', fieldsDefaulted: false, defaulted: [] };
  }
  let parsed = tryParse(text);
  if (parsed === undefined) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) parsed = tryParse(text.slice(start, end + 1));
  }
  if (parsed === undefined || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { decision: 'error', reason: 'not valid JSON', fieldsDefaulted: false, defaulted: [] };
  }
  const outcome = parsed.outcome;
  if (outcome !== 'allow' && outcome !== 'deny') {
    return { decision: 'error', reason: `invalid outcome: ${String(outcome)}`, fieldsDefaulted: false, defaulted: [] };
  }
  const riskDefaulted = !(typeof parsed.risk_level === 'string' && RISK_LEVELS.has(parsed.risk_level));
  const authDefaulted = !(typeof parsed.user_authorization === 'string' && AUTHORIZATION_LEVELS.has(parsed.user_authorization));
  const reasonDefaulted = !(typeof parsed.rationale === 'string' && parsed.rationale.trim().length > 0);
  const risk = riskDefaulted ? (outcome === 'allow' ? 'low' : 'high') : parsed.risk_level;
  const authorization = authDefaulted ? 'unknown' : parsed.user_authorization;
  const reason = reasonDefaulted ? DEFAULT_RATIONALE : parsed.rationale.trim();
  return {
    decision: outcome === 'allow' ? 'allow' : 'deny',
    risk,
    authorization,
    reason,
    fieldsDefaulted: riskDefaulted || authDefaulted,
    defaulted: [
      ...(riskDefaulted ? ['risk'] : []),
      ...(authDefaulted ? ['auth'] : []),
      ...(reasonDefaulted ? ['reason'] : []),
    ],
  };
}

/**
 * 容错解析：整段失败返回 `undefined`。
 * @param {string} text - 待解析文本。
 * @returns {unknown} 解析值。
 */
function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * 把解析结果投影成审计字段（`Verdict.fields` 的唯一定义处）。
 * @param {{decision: string, risk?: string, authorization?: string, reason?: string, fieldsDefaulted?: boolean}} verdict - 判定。
 * @param {{resolution?: object}} cfg - 生效配置。
 * @param {number} toolCalls - 本次审查的工具调用次数。
 * @param {string[]} degraded - 降级标记。
 * @param {{finish?: string, reasoningTokens?: number}} [observed] - 流末观测值（design §3.7）。
 * @returns {object} 审计字段。
 */
export function verdictFields(verdict, cfg, toolCalls, degraded, observed = {}) {
  const resolution = cfg?.resolution ?? {};
  return {
    risk: verdict.risk,
    auth: verdict.authorization,
    tools: toolCalls,
    degraded: degraded.length > 0 ? degraded.join(',') : 'none',
    layer: resolution.layer,
    model: resolution.provider !== undefined ? `${resolution.provider}/${resolution.model}` : undefined,
    effort: resolution.effort,
    finish: observed.finish,
    reasoningTokens: observed.reasoningTokens,
    fieldsDefaulted: verdict.fieldsDefaulted === true,
    reason: verdict.reason,
  };
}

/**
 * 把宿主的 `FinishReason` 收敛成一个短标记，供审计使用（design §3.7）。
 * @param {unknown} finish - `BlockAssembler.finish`（`{kind, failure?}`）或旧式字符串。
 * @returns {string | undefined} `max-tokens` / `stop` / `tool-calls` / `error:EMPTY_RESPONSE` 等。
 */
export function finishTag(finish) {
  if (typeof finish === 'string' && finish.length > 0) return finish;
  if (finish === null || typeof finish !== 'object') return undefined;
  const kind = typeof finish.kind === 'string' ? finish.kind : undefined;
  if (kind === undefined) return undefined;
  const code = typeof finish.failure?.code === 'string' ? finish.failure.code : undefined;
  return code === undefined ? kind : `${kind}:${code}`;
}

/**
 * 判定流末是否表达了「输出被截断」或「没有输出」（design §3.7）。
 * @param {unknown} finish - `BlockAssembler.finish`。
 * @returns {'output-truncated' | 'output-empty' | undefined} 降级标记。
 */
export function finishDegraded(finish) {
  if (finish === null || typeof finish !== 'object') return undefined;
  if (finish.kind === 'max-tokens') return 'output-truncated';
  if (finish.kind === 'error' && finish.failure?.code === 'EMPTY_RESPONSE') return 'output-empty';
  return undefined;
}

/**
 * 审查调用的尝试总次数上界：首次＋1 次重试。
 * 量级依据＝codex「3 次尝试共享同一 deadline」的先例（`ext/guardian-reviewer/src/lib.rs:31`
 * 上下文）收敛为 2，更保守。不做退避间隔：gate 的审查计时器是预算权威，先到仍按超时结算
 * （语义优先于重试），重试不会把慢故障拖过 `reviewer.timeoutMs`。
 */
export const REVIEW_MAX_ATTEMPTS = 2;

/**
 * 可重试错误类的**单一谓词**（新增错误类只改这一处）：
 * - 流抛错（`error` 真值：网络/供应商异常）→ 可重试；
 * - `finish.kind === 'error'`（宿主收敛的供应商侧失败码，含 `INVALID_REQUEST`、`EMPTY_RESPONSE`
 *   ——`INVALID_REQUEST` 看似确定性，同命令重发即恢复，按间歇处理（design §5.2））→ 可重试；
 * - 空输出（`payloadEmpty`：无正文且非截断——`'empty payload'` 在 `finish` 正常收尾时的产出点）→ 可重试；
 * - `finish.kind === 'max-tokens'`（output-truncated：同参数必然复现，改配置才是解）与其余结局 → 不重试；
 *   `layer=unavailable` 在进入尝试循环前已按确定性失败返回（零重试）。
 * @param {unknown} finish - 本次尝试的 `BlockAssembler.finish`。
 * @param {unknown} error - 流迭代抛出的异常（无则 `undefined`）。
 * @param {boolean} [payloadEmpty=false] - 本次尝试无正文且非截断。
 * @returns {boolean} 是否可重试。
 */
export function retryableOutcome(finish, error, payloadEmpty = false) {
  if (error !== undefined && error !== null) return true;
  if (finish?.kind === 'error') return true;
  return payloadEmpty === true && finish?.kind !== 'max-tokens';
}

/**
 * full 档思维链的跨尝试拼界：整建重试会再次产出 reasoning 块，直接拼接会让两段
 * 思维链无归属地连在一起——在下一段开头插 `attempt N` 分隔行，落盘后可按行归属到具体尝试。
 * @param {object} details - 详情素材（仅 full 档填充）。
 * @param {number} attempt - 即将开始的尝试序号。
 * @returns {void} 原地修改 `details.reasoning`。
 */
function markAttemptBoundary(details, attempt) {
  details.reasoning = `${details.reasoning ?? ''}\n[attempt ${attempt}]\n`;
}

/**
 * 创建审查器。
 * @param {object} deps - 宿主注入点；全部由 `lib/index.js` 提供，单测传替身。
 * @param {{stream: (options: object) => AsyncIterable<object>}} deps.llm - `ctx.llm`。
 * @param {{BlockAssembler: new () => object}} deps.blocks - `@deepseek-ai/dsh-llm` 的组装器。
 * @param {{createUserMessage: Function, createAssistantMessage: Function, createToolResultMessage: Function}} deps.messages
 *   - 消息构造器。
 * @param {{schemas: readonly object[], run: Function}} deps.tools - 只读工具集。
 * @param {{buildSystem: Function, buildUserTexts: Function}} deps.prompt - 提示词构建。
 * @param {(fields: object) => void} deps.audit - 审计入口。
 * @param {(entry: object) => void} [deps.onReview] - 审查记录回调（design §8.2）：`finish` 写完审计行后同步调用一次；
 *   fire-and-forget——异常被吞、不 await，绝不改变判定结果与返回时序。
 * @returns {{review: (request: object, located: object | null, pre: object, cfg: object, opts: {id: string, signal: AbortSignal}) => Promise<object>}}
 *   审查器。
 */
export function createReviewer(deps) {
  const { llm, blocks, messages, tools, prompt, audit, onReview, redactText } = deps;

  /**
   * 审查一次升权请求。
   * @param {object} request - 审批请求。
   * @param {{command?: string, cwd?: string, description?: string} | null} located - 回查结果。
   * @param {{fields: object}} pre - `screen()` 的结果。
   * @param {object} cfg - 生效配置。
   * @param {{id: string, signal: AbortSignal, tools?: {schemas: readonly object[], run: Function}}, onReview?: (entry: object) => void, queueMs?: number}} opts - 请求 id、取消信号、请求绑定工具门面、请求级记录回调覆盖与排队等待时长。
   * @returns {Promise<object>} `Verdict`；永不抛出（异常统一转成 `decision='error'`）。
   */
  async function review(request, located, pre, cfg, opts) {
    // 审查侧降级清单的初值是装配透传的三类标记（design §3.1/§3.2）：上下文采集降级、
    // 回查降级与 screen 缺证标记。经 Set 去重后随判定进入审计、记录与注入降级观测，不因审查装配而丢失。
    const seed = [
      ...(Array.isArray(pre?.evidenceDegraded) ? pre.evidenceDegraded : []),
      ...(Array.isArray(pre?.locatedDegraded) ? pre.locatedDegraded : []),
      ...(typeof pre?.fields?.degraded === 'string' && pre.fields.degraded !== 'none'
        ? pre.fields.degraded.split(/[,+]/u)
        : []),
    ];
    const degraded = [...new Set(seed)];
    const resolution = cfg?.resolution ?? {};
    // 详情素材只在 full 档收集（design §8.2 采集档）：off/summary 下这些字段不会落盘，提前拼全文是白做功。
    const wantDetails = cfg?.ui?.trace?.capture === 'full';
    // 记录计时起点：所有判定路径（成功/出错/超时/降级）都汇合到 finish，由它统一补 endedAt/reviewMs 后落记录。
    const startedAt = Date.now();
    /** 详情素材（仅 full 档填充）：提示词、送审命令、思维链（跨轮累加）、最终正文。 */
    const details = {};
    /** 记录字段素材：只读取证逐条摘要（工具名与结果状态一行一条）。 */
    const probes = [];
    /** 是否真的发起过模型流（未进入模型调用时 attempts 记 0，不伪记 1 次）。 */
    let didStream = false;
    /**
     * 尝试序号（有限重试）：声明在 traceOf 可见的作用域——审查层不可用等早退路径
     * 也会经 traceOf 组装记录素材（didStream=false 时 attempts 记 0）。
     */
    let attempt = 1;
    /**
     * 传给 finish 的记录素材；context 是 gate 经 opts.trace 补进来的审批上下文
     * （sessionId/callId/toolName/approvalId/origin/escalation/preset），meta 是记录专属观测值。
     */
    const traceOf = () => ({
      startedAt,
      context: opts?.trace,
      details,
      meta: {
        didStream,
        attempts: didStream ? attempt : 0,
        probes: probes.slice(),
        queueMs: Number.isFinite(opts?.queueMs) ? Math.max(0, Math.round(opts.queueMs)) : undefined,
        subject: subjectText(located),
        evidence: typeof pre?.evidence === 'string' && pre.evidence.length > 0 ? pre.evidence : undefined,
      },
    });
    if (resolution.layer === 'unavailable') {
      const verdict = { decision: 'error', reason: 'model unavailable', toolCalls: 0 };
      return finish(verdict, cfg, opts, degraded.concat('all'), {}, traceOf());
    }

    let toolCalls = 0;
    // Agent 提示语言每次请求从生效配置现取（热生效）；回落谓词单源 agentLangOf
    // （缺失/非法→en＝schema 默认；lib/ 内不得再有第二份内联谓词）。
    const agentLang = agentLangOf(cfg);
    // 请求绑定的工具门面优先（上下文随请求快照传入）；未传时回落实例工具（单测直连路径）。
    const runTools = opts?.tools ?? tools;
    try {
      // 真实参数独立送审——回查到的 arguments 整体渲染为动作证据，不依赖转录取材
      //（`maxEntries=0` 或取样窗口不含本次事件时，动作段仍带真实目标与载荷）。
      // 管线与证据段同一次序：先 `</` 转义、再脱敏、后按预算保留首尾（先遮后截）。
      // 构造在 try 内：renderArguments 已对遍历异常回退占位，这里再不外抛（review 永不抛出契约）。
      let argumentsText;
      if (located?.arguments !== undefined && located?.arguments !== null) {
        const rendered = renderArguments(located.arguments);
        if (rendered !== undefined) {
          const budget = Number.isFinite(cfg?.context?.maxEntryBytes) ? cfg.context.maxEntryBytes : 4096;
          argumentsText = truncateKeepEnds(redact(rendered.replace(/<\//gu, '<\\/'), cfg?.context?.redactPatterns), budget).text;
        }
      }
      const system = prompt.buildSystem(agentLang);
      // 动作段字符串字段送模前按本请求清单遮蔽（「模型输入出口不泄漏」）：命令、理由等
      // 里的秘密形态与参数段同口径处理。只改送模文本——不回写 located（会话事件与 trace 的
      // input 摘要维持原文，后者由落盘出口的既有脱敏处理）；动作 JSON 五字段结构与 `</` 转义不变。
      const patterns = cfg?.context?.redactPatterns;
      const shield = (value) => (typeof value === 'string' ? redact(value, patterns) : value);
      const texts = prompt.buildUserTexts(
        {
          evidence: pre?.evidence ?? '',
          // 读取失败说明行（agent.evidenceReadFailed，design §3.2）：空转录不冒充会话本无上下文。
          evidenceReadFailed: Array.isArray(pre?.evidenceDegraded) && pre.evidenceDegraded.includes(TRANSCRIPT_READ_FAILED),
          action: {
            toolName: shield(request?.toolName),
            command: shield(located?.command),
            cwd: shield(located?.cwd),
            mode: shield(pre?.fields?.mode),
            justification: shield(request?.reason),
          },
          // 回查目录缺失（degraded=cwd）时在动作证据里写明——模型不得把
          // process.cwd() 快照误读成已回查的会话目录（字典键 agent.cwdMissing，zh/en 同步）。
          cwdMissing: located !== null && located?.cwd === undefined,
          // 回查不到调用或参数不可解析（degraded=command）时动作段附说明行（agent.commandMissing）：
          // 触发口径窄于 screen 的 unknownSubject——参数可解析但无命令类键时动作段已带完整参数 JSON，模型可辨认，不另加行。
          commandMissing: Array.isArray(pre?.locatedDegraded) && pre.locatedDegraded.includes('command'),
          argumentsText,
        },
        agentLang,
      );
      if (wantDetails) {
        // 详情素材与 phase=prompt 审计行保持同一份拼接口径，避免两处格式各自漂移。
        details.prompt = `${system}\n---\n${texts.evidenceText}\n---\n${texts.actionText}`;
        details.input = subjectText(located);
      }
      // prompt 审计行每请求一次：整建重试送出的是同一 system/输入，重写同文行只会稀释日志。
      audit({ id: opts?.id, phase: 'prompt', source: 'llm', model: modelId(resolution), ...(cfg?.audit?.includePrompt === true ? { reason: `${system}\n---\n${texts.evidenceText}\n---\n${texts.actionText}` } : {}) });

      const maxToolSteps = Number.isFinite(cfg?.reviewer?.maxToolSteps) ? cfg.reviewer.maxToolSteps : 4;
      let finalText;
      /** 流末观测值（design §3.7）：宿主的 `FinishReason` 只进审计行；用量（reasoningTokens）进审计行并同源写入审查记录 `tokens` 字段。 */
      let finishReason;
      let reasoningTokens;
      /**
       * 最后一次流收尾是否为空正文（无正文或纯空白，且非截断/非供应商失败码）：
       * 重试判定与收敛出口共用，循环外取最后尝试的值——重试用尽仍空正文时按无响应记降级标记。
       */
      let payloadEmpty = false;
      // 有限重试：可重试错误类整建重试，总次数以 REVIEW_MAX_ATTEMPTS 为上界；gate 的审查计时器
      // 是预算权威——signal 已中止（计时到点或请求取消）时不再开始下一次尝试。生产路径
      // `reviewer.timeoutMs=0` 按零值规则立即超时（gate 计时器零值即到点，不进入本层循环）；
      // 不经 gate 直调本函数且未挂计时器的场合，`timeoutMs=0` 仅以次数为上界——这是直调
      // 边界的语义，与生产配置的「零值＝立即」不同，勿混读。工具轮次计数跨尝试累计（tools 字段口径不变）。
      /** 已失败尝试的摘要：只在 `capture='full'` 档进 trace details，最终尝试的结局由 review 行自述。 */
      const failedAttempts = [];
      /**
       * 中止分类出口（design §5.1 取消贯通）：读 signal.reason 区分两类中止结局——
       * 审查计时到点（REVIEW_TIMEOUT_ABORT_MESSAGE）按超时口径返回（与流内超时同权），
       * 其余中止按被替代形状返回（不计数，由 gate 的竞速结算承担）；附带逻辑（failedAttempts
       * 补进 details）逐字段与各调用点一致。未中止返回 undefined。
       */
      const classifyAbort = () => {
        if (opts?.signal?.aborted !== true) return undefined;
        const abortedReason = opts.signal.reason;
        if (wantDetails && failedAttempts.length > 0) details.failedAttempts = failedAttempts;
        if (abortedReason instanceof Error && abortedReason.message === REVIEW_TIMEOUT_ABORT_MESSAGE) {
          return {
            verdict: { decision: 'error', reason: 'review timeout', timedOut: true, toolCalls },
            degraded,
          };
        }
        const suffix = abortedReason === undefined ? '' : `：${errorText(abortedReason)}`;
        return {
          verdict: {
            decision: 'error',
            reason: `aborted（gate 他路先结算，非通道故障）${suffix}`,
            superseded: true,
            toolCalls,
          },
          degraded: degraded.concat('superseded'),
        };
      };
      for (;;) {
        // 每次模型尝试启动前复核信号：已中止不发起 llm.stream——排队等待或上一次尝试结束后
        // 请求已被取消/超时的，不再消耗一次模型调用。
        const attemptAbort = classifyAbort();
        if (attemptAbort !== undefined) {
          return finish(attemptAbort.verdict, cfg, opts, attemptAbort.degraded, {}, traceOf());
        }
        finalText = undefined;
        finishReason = undefined;
        reasoningTokens = undefined;
        // 整建重试：每次尝试从同一 system/输入重建会话，不复用已抛错轮次的残缺消息序列。
        const conversation = [
          messages.createUserMessage({ content: [{ type: 'text', text: texts.evidenceText }], source: PLUGIN_MESSAGE_SOURCE }),
          messages.createUserMessage({ content: [{ type: 'text', text: texts.actionText }], source: PLUGIN_MESSAGE_SOURCE }),
        ];
        try {
          for (let step = 0; step <= maxToolSteps; step += 1) {
            // 每次模型流启动前复核信号（含工具轮之间的步进边界）：工具执行或上一轮流收尾后
            // 请求已被取消/超时的，不再为下一轮开流——每轮 llm.stream 都是一次真实的模型调用，
            // 结论已不再需要时不再消耗。
            const stepAbort = classifyAbort();
            if (stepAbort !== undefined) {
              return finish(stepAbort.verdict, cfg, opts, stepAbort.degraded, {}, traceOf());
            }
            const useTools = step < maxToolSteps;
            if (!useTools) {
              // 轮次用尽：追加一条 user 指令再请求一次，且不再提供工具。
              conversation.push(
                messages.createUserMessage({
                  content: [{ type: 'text', text: toolBudgetExhausted(agentLang) }],
                  source: PLUGIN_MESSAGE_SOURCE,
                }),
              );
            }
            const assembler = new blocks.BlockAssembler();
            didStream = true;
            const stream = llm.stream({
              provider: resolution.provider,
              model: resolution.model,
              ...(resolution.effort === undefined || resolution.effort === 'none' ? {} : { reasoningEffort: resolution.effort }),
              system,
              messages: conversation,
              ...(useTools ? { tools: runTools.schemas } : {}),
              // `maxTokens = 0`（默认）＝不传该字段，由模型／供应商默认值决定（宿主可材料化 adapter 默认值，design §3.6）。
              ...(Number.isFinite(cfg?.reviewer?.maxTokens) && cfg.reviewer.maxTokens > 0 ? { maxTokens: cfg.reviewer.maxTokens } : {}),
              temperature: cfg.reviewer.temperature,
              signal: opts?.signal,
            });
            for await (const chunk of stream) {
              assembler.push(chunk);
            }
            // 判据取自宿主组装器，而不是嗅探 chunk 字段形状（design §3.7）。
            finishReason = assembler.finish ?? finishReason;
            const usage = assembler.usage;
            if (Number.isFinite(usage?.reasoningTokens)) reasoningTokens = usage.reasoningTokens;
            const assembled = assembler.blocks();
            if (wantDetails) {
              // 思维链跨轮累加（带工具调用的每一轮都可能有 reasoning 块）；正文以最终轮的 finalText 为准。
              for (const block of assembled) {
                if (block?.type === 'reasoning' && typeof block.text === 'string') {
                  details.reasoning = `${details.reasoning ?? ''}${block.text}`;
                }
              }
            }
            const calls = assembled.filter((block) => block?.type === 'tool-call');
            if (calls.length === 0) {
              finalText = assembled
                .filter((block) => block?.type === 'text' && typeof block.text === 'string')
                .map((block) => block.text)
                .join('');
              break;
            }
            // I6：先落 assistant（含 tool_calls），再逐条回喂工具结果。
            conversation.push(messages.createAssistantMessage({ content: assembled, source: { provider: resolution.provider, model: resolution.model } }));
            for (const call of calls) {
              toolCalls += 1;
              const parsed = parseArguments(call.arguments);
              // 工具抛错或参数非法都回喂错误结果：跳过会破坏 I5 配对（design §3.6）。
              const result = parsed.ok
                ? await runTool(runTools, call.name, parsed.value, opts?.signal, agentLang)
                : { text: agentT(agentLang, 'tool.argsJsonInvalid').replaceAll('{error}', String(parsed.error)), isError: true };
              // 记录取证摘要素材（design §8.2 `probes`）：工具名与结果状态一行一条。
              probes.push(`${call.name}:${result.isError === true ? 'error' : 'ok'}`);
              conversation.push(
                messages.createToolResultMessage({
                  callId: call.id,
                  content: [{ type: 'text', text: result.text }],
                  isError: result.isError === true,
                }),
              );
            }
          }
        } catch (error) {
          if (attempt < REVIEW_MAX_ATTEMPTS && retryableOutcome(undefined, error) && opts?.signal?.aborted !== true) {
            if (wantDetails) failedAttempts.push({ error: errorText(error) });
            attempt += 1;
            if (wantDetails) markAttemptBoundary(details, attempt);
            continue;
          }
          if (wantDetails && failedAttempts.length > 0) details.failedAttempts = failedAttempts;
          // 计数口径（design §5.3）：他路先结算（人工先答/卡片关闭/取消/人工超时，以及人工时限环节
          // 与中止侧的回调抛错）引发的 abort 型 error 不是通道故障——审查没得出结论是因为结论已不再需要。
          // gate 用 REVIEW_SUPERSEDED 标记这类中止；审查计时器的中止（REVIEW_TIMEOUT_ABORT_MESSAGE，
          // 慢通道，含审查环节的计时回调抛错——该路径复用同一标记，与真实超时同权计数）与非中止的
          // 有机错误照旧计数。
          const signal = opts?.signal;
          if (signal?.aborted === true
            && !(signal.reason instanceof Error && signal.reason.message === REVIEW_TIMEOUT_ABORT_MESSAGE)) {
            const suffix = error === undefined || error === REVIEW_SUPERSEDED ? '' : `：${errorText(error)}`;
            return finish(
              {
                decision: 'error',
                reason: `aborted（gate 他路先结算，非通道故障）${suffix}`,
                superseded: true,
                toolCalls,
              },
              cfg, opts, degraded.concat('superseded'), {}, traceOf(),
            );
          }
          const reason = attempt > 1 ? `attempt ${attempt}/${REVIEW_MAX_ATTEMPTS}: ${errorText(error)}` : errorText(error);
          return finish({ decision: 'error', reason, toolCalls }, cfg, opts, degraded, {}, traceOf());
        }
        // 流完整收尾后的可重试判定：供应商失败码（含 EMPTY_RESPONSE）与空输出重试；
        // max-tokens 截断（同参数必然复现）与有正文的其余结局不重试。
        payloadEmpty = finishDegraded(finishReason) === undefined
          && (typeof finalText !== 'string' || finalText.trim().length === 0);
        if (attempt < REVIEW_MAX_ATTEMPTS && retryableOutcome(finishReason, undefined, payloadEmpty) && opts?.signal?.aborted !== true) {
          if (wantDetails) {
            // 条目必须自带可观测内容：finish 摘要缺位但空输出可重试时记 error 字段，不落空对象。
            const entry = {};
            const tag = finishTag(finishReason);
            if (tag !== undefined) entry.finish = tag;
            if (payloadEmpty) entry.error = 'empty payload';
            failedAttempts.push(entry);
          }
          attempt += 1;
          if (wantDetails) markAttemptBoundary(details, attempt);
          continue;
        }
        break;
      }
      // 失败尝试摘要是回调级观测（onReview 入参；最终结局由 review 行的 reason 前缀＋finish 自述）。
      // 不在 design §8.2 词汇表内：存储白名单按设计不落盘、RPC 与客户端不可见——收集只为回调消费方。
      if (wantDetails && failedAttempts.length > 0) details.failedAttempts = failedAttempts;

      if (wantDetails && typeof finalText === 'string') details.output = finalText;

      audit({
        id: opts?.id,
        phase: 'raw',
        source: 'llm',
        model: modelId(resolution),
        tools: toolCalls,
        finish: finishTag(finishReason),
        ...(cfg?.audit?.includeRaw === true ? { reason: typeof finalText === 'string' ? finalText : '' } : {}),
      });

      const observed = { finish: finishTag(finishReason), reasoningTokens };
      const truncated = finishDegraded(finishReason);
      if (truncated !== undefined) {
        // 截断/空输出一律 fail-closed，不采信任何已解析内容（design §3.7）。
        degraded.push(truncated);
        const base = truncated === 'output-truncated' ? 'output truncated' : 'empty payload';
        const verdict = {
          decision: 'error',
          // 留痕：重试后仍是失败结局时，reason 前缀尝试进度；注入给主模型的原因同带前缀。
          reason: attempt > 1 ? `attempt ${attempt}/${REVIEW_MAX_ATTEMPTS}: ${base}` : base,
          toolCalls,
        };
        return finish(verdict, cfg, opts, degraded, observed, traceOf());
      }
      // 空正文正常收尾（finish 无降级码）与 EMPTY_RESPONSE 同标记（design §3.7 把
      // 「error:EMPTY_RESPONSE 或空正文」在同句定义为无响应）：两者都是「模型没给出
      // 可解析正文」，差别只在观测项（失败码 vs 正常收尾无文本块），收敛口径必须一致
      // ——同为 fail-closed 且 degraded 记 output-empty。判定与重试语义不变：空正文
      // 先按可重试类整建重试，此处只处理重试用尽后的收敛。
      if (payloadEmpty) {
        degraded.push('output-empty');
        const verdict = {
          decision: 'error',
          reason: attempt > 1 ? `attempt ${attempt}/${REVIEW_MAX_ATTEMPTS}: empty payload` : 'empty payload',
          toolCalls,
        };
        return finish(verdict, cfg, opts, degraded, observed, traceOf());
      }
      const parsed = parseAssessment(finalText);
      const verdict = {
        decision: parsed.decision,
        risk: parsed.risk,
        authorization: parsed.authorization,
        reason: parsed.decision === 'error' && attempt > 1
          ? `attempt ${attempt}/${REVIEW_MAX_ATTEMPTS}: ${parsed.reason}`
          : parsed.reason,
        fieldsDefaulted: parsed.fieldsDefaulted,
        // design §8.2 fieldsDefaulted 的清单形态（risk/auth/reason 子集）：随判定进 finish，落记录时按序拼接。
        defaulted: parsed.defaulted,
        toolCalls,
      };
      return finish(verdict, cfg, opts, degraded, observed, traceOf());
    } catch (error) {
      // 装配与观测通道的抛错（提示词构建、审计写入等）是确定性错误：不经重试分类，直接 fail-closed。
      const verdict = { decision: 'error', reason: errorText(error), toolCalls };
      return finish(verdict, cfg, opts, degraded, {}, traceOf());
    }
  }

  /**
   * 写审查阶段审计并补齐 `fields`；记录级 `capture` 生效标记在此落盘（取请求快照的采集档，design §8.2）。
   * @param {object} verdict - 判定。
   * @param {object} cfg - 生效配置。
   * @param {{id: string}} opts - 请求 id。
   * @param {string[]} degraded - 降级标记。
   * @param {{finish?: string, reasoningTokens?: number}} [observed] - 流末观测值。
   * @param {{startedAt?: number, context?: object, details?: object}} [trace] - 审查记录素材（design §8.2）。
   * @returns {object} 带 `fields` 的判定。
   */
  function finish(verdict, cfg, opts, degraded, observed = {}, trace = {}) {
    const fields = verdictFields(verdict, cfg, verdict.toolCalls ?? 0, degraded, observed);
    audit({
      id: opts?.id,
      phase: 'review',
      source: 'llm',
      decision: verdict.decision,
      risk: verdict.risk,
      auth: verdict.authorization,
      tools: verdict.toolCalls ?? 0,
      layer: fields.layer,
      model: fields.model,
      effort: fields.effort,
      finish: fields.finish,
      reasoningTokens: fields.reasoningTokens,
      degraded: fields.degraded,
      // 迟到结论观测：gate 的抢先结算路径（人工回答/人工超时/取消/人工通道关闭）都先 abort 审查信号，
      // 审查自然完成则不 abort——signal 状态就是「本结论是否迟到」的权威标记。
      late: opts?.signal?.aborted === true ? 'yes' : 'no',
      reason: verdict.reason,
    });
    // 落审查记录（design §8.2）：finish 是所有判定的唯一汇合点，在这里回调才能覆盖成功/出错/超时/降级全部路径。
    // fire-and-forget：同步调一次、吞掉一切异常、不 await——记录通道故障绝不能改变判定结果或返回时序。
    const endedAt = Date.now();
    try {
      const context = trace.context ?? {};
      const meta = trace.meta ?? {};
      const lang = agentLangOf(cfg);
      // 记录级 capture 生效标记（design §8.2/§8.5.1）：取本请求快照的采集档，早退与装配抛错路径同样携带——
      // 它是详情缺段分派「未开启全文采集」的唯一可靠依据，防止从全文缺失反推配置。
      const captureEffective =
        cfg?.ui?.trace?.capture === 'off' || cfg?.ui?.trace?.capture === 'full' ? cfg.ui.trace.capture : 'summary';
      /** 摘要文本字段的统一口径（design §8.2）：先脱敏，再按 context.maxEntryBytes 保留首尾；任一字段被裁剪即置 truncated。 */
      let anyTruncated = false;
      const summarize = (text) => {
        const raw = typeof text === 'string' ? text : '';
        const safe = typeof redactText === 'function' ? redactText(raw) : raw;
        const clipped = clipKeepEnds(safe, cfg?.context?.maxEntryBytes);
        if (clipped.truncated) anyTruncated = true;
        return clipped.text;
      };
      // 记录回调优先取请求级覆盖（index 传入请求入口的快照存储，design §8.2 在飞请求配置快照）；
      // 未传时用构造期回调（直测路径）。两条路径的 entry 形状完全一致。
      const recordReview = opts?.onReview ?? onReview;
      recordReview?.({
        ...context,
        kind: 'review',
        approvalId: context.approvalId ?? opts?.id,
        startedAt: trace.startedAt,
        endedAt,
        reviewMs: Number.isFinite(trace.startedAt) ? Math.max(0, endedAt - trace.startedAt) : undefined,
        queueMs: meta.queueMs,
        decision: verdict.decision,
        model: fields.model,
        effort: fields.effort,
        layer: fields.layer,
        attempts: meta.attempts ?? 0,
        // 宿主用量里审查循环当前只读思维链 token（与审计 reasoningTokens 同源），没有就省略该字段。
        tokens: Number.isFinite(observed.reasoningTokens) ? observed.reasoningTokens : undefined,
        reason: summarize(verdict.reason),
        risk: verdict.risk,
        auth: verdict.authorization,
        fieldsDefaulted: Array.isArray(verdict.defaulted) ? verdict.defaulted.join(',') : '',
        subject: meta.subject === undefined ? undefined : summarize(meta.subject),
        evidence: meta.evidence === undefined ? undefined : summarize(meta.evidence),
        probes: meta.probes !== undefined && meta.probes.length > 0 ? summarize(meta.probes.join('\n')) : undefined,
        tools: verdict.toolCalls ?? 0,
        capture: captureEffective,
        // 采集计划控制字段（design §8.2）：capture/maxBytes 取本请求快照，记录回调透传给请求入口的
        // 快照存储——在飞请求的采集档不被后续配置改写；本字段不落盘（存储白名单之外，落盘前剥离）。
        tracePlan: {
          capture: captureEffective,
          ...(Number.isFinite(cfg?.ui?.trace?.maxBytes) ? { maxBytes: cfg.ui.trace.maxBytes } : {}),
        },
        degraded: fields.degraded,
        configTag: configTagOf(cfg),
        policyTag: `${lang}:${typeof prompt.tenantPolicyDigest === 'function' ? prompt.tenantPolicyDigest(lang) : 'missing'}`,
        ...(anyTruncated ? { truncated: true } : {}),
        ...trace.details,
      });
    } catch {
      // 记录回调抛错＝观测范围故障：吞掉，审批主流程照常返回。
    }
    return {
      ...verdict,
      degraded: fields.degraded,
      fields,
      // 结算记录（gate）要用的观测值：排队等待时长随判定一起返回（尝试次数已在审查记录里）。
      queueMs: Number.isFinite(opts?.queueMs) ? Math.max(0, Math.round(opts.queueMs)) : undefined,
    };
  }

  return { review };
}

/**
 * 解析模型给出的工具参数；失败不抛出，交由调用方回喂错误结果（I7）。
 * @param {unknown} raw - 原始 JSON 字符串。
 * @returns {{ok: true, value: object} | {ok: false, error: string}} 解析结果。
 */
export function parseArguments(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return { ok: false, error: 'empty arguments' };
  try {
    const value = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'arguments is not a JSON object' };
    }
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

/**
 * 执行一次只读工具；实现抛错时收敛为错误结果，保证工具循环继续。
 * @param {{run: Function}} tools - 只读工具集。
 * @param {string} name - 工具名。
 * @param {object} args - 参数。
 * @param {AbortSignal} [signal] - 取消信号。
 * @param {string} [lang='en'] - 回喂文案语言（缺省 en＝schema 默认）。
 * @returns {Promise<{text: string, isError: boolean}>} 回喂文本。
 */
async function runTool(tools, name, args, signal, lang = 'en') {
  try {
    const result = await tools.run(name, args, signal);
    return { text: typeof result?.text === 'string' ? result.text : '', isError: result?.isError === true };
  } catch (error) {
    return { text: agentT(lang, 'tool.execFailed').replaceAll('{name}', name).replaceAll('{error}', errorText(error)), isError: true };
  }
}

/**
 * 送审对象 subject 取材的单一权威在 `lib/record-fields.js`（`subjectText`），与 gate 结算记录共用。
 */

/**
 * 渲染审计用的 `provider/model`。
 * @param {{provider?: string, model?: string}} resolution - 模型解析结果。
 * @returns {string | undefined} 标识。
 */
function modelId(resolution) {
  return resolution?.provider === undefined ? undefined : `${resolution.provider}/${resolution.model}`;
}

/**
 * @param {unknown} error - 捕获值。
 * @returns {string} 单行文本（Error 取 message，其余取 String，均不含堆栈）。
 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
