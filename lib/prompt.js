/**
 * dsh-approve-for-me — 审查提示词构建（R28 起正文取自 `lib/agent-texts.js` 双语字典）。
 *
 * 系统提示与输出契约与 codex Guardian 一致（设计「与 codex 的一致点」）；租户策略随包：
 * `assets/tenant-policy.md`（en，现行）与 `assets/tenant-policy.zh.md`（zh，对译），按
 * `language.agent` 读入并替换 `{{ tenant_policy_config }}`。文件读不到时的回退占位行同样
 * 走字典键 `agent.tenantPolicyMissing`（design §21.2）——zh 档触发回退时不得注入英文句。
 * 证据段的结构性防注入（不可信声明、角色前缀、边界标记、`</` 转义）见 设计「防注入」。
 * lang 一律在每次请求现取（热生效）；本模块不在装载期缓存任何语言相关字符串。
 * @module dsh-approve-for-me/prompt
 */
import { agentT } from './agent-texts.js';

/** en 系统提示模板（与 codex Guardian 蓝本逐字相同）；模板正文由 `agent-texts` 唯一持有。 */
export { OUTPUT_CONTRACT, UNTRUSTED_NOTICE } from './agent-texts.js';
import { UNTRUSTED_NOTICE } from './agent-texts.js';

/** 证据段边界标记；两语言共用（不变块）。 */
const TRANSCRIPT_START = '>>> TRANSCRIPT START';
const TRANSCRIPT_END = '>>> TRANSCRIPT END';

/** en 系统提示模板（现状兼容导出：en 档与现行提示逐字相同）。 */
export const SYSTEM_PROMPT_TEMPLATE = agentT('en', 'agent.systemPrompt');

/** 轮次用尽指令（现状兼容导出：zh 现行文案）。 */
export const TOOL_BUDGET_EXHAUSTED = agentT('zh', 'agent.toolBudgetExhausted');

/**
 * 取指定语言的系统提示模板。
 * @param {string} lang - 语言（AGENT_LANGS 之一）。
 * @returns {string} 模板正文（含 `{{ tenant_policy_config }}` 占位）。
 */
export function systemPromptTemplate(lang) {
  return agentT(lang, 'agent.systemPrompt');
}

/**
 * 取指定语言的轮次用尽指令。
 * @param {string} lang - 语言。
 * @returns {string} 指令文本。
 */
export function toolBudgetExhausted(lang) {
  return agentT(lang, 'agent.toolBudgetExhausted');
}

/**
 * 读入指定语言的随包租户策略；读不到时回退到字典占位行（`agent.tenantPolicyMissing`）。
 * @param {string} [lang='en'] - 语言。
 * @returns {string} 策略正文或占位行。
 */
export function tenantPolicy(lang = 'en') {
  const load = agentT(lang, 'agent.tenantPolicy');
  const text = typeof load === 'function' ? load() : load;
  return typeof text === 'string' && text !== '' ? text : agentT(lang, 'agent.tenantPolicyMissing');
}

/**
 * 构建审查器系统提示：模板 + 租户策略 + 输出契约。
 * @param {string} [lang='en'] - 语言；缺省 en（en 档与现状逐字相同，design §21.1 默认档决定）。
 * @param {string} [policy] - 租户策略正文；缺省按 lang 读随包文件（回退占位行）。
 * @returns {string} 系统提示全文。
 */
export function buildSystem(lang = 'en', policy = tenantPolicy(lang)) {
  const filled = systemPromptTemplate(lang).replace('{{ tenant_policy_config }}', policy.trim());
  return `${filled}\n\n${agentT(lang, 'agent.outputContract')}`;
}

/**
 * 渲染待审动作 JSON；`</` 转义防提前闭合（不变块，两语言共用）。
 * @param {object} action - 待审动作。
 * @returns {string} JSON 文本。
 */
export function renderAction(action) {
  const payload = {
    toolName: action?.toolName ?? null,
    command: action?.command ?? null,
    cwd: action?.cwd ?? null,
    requestedMode: action?.mode ?? null,
    justification: action?.justification ?? null,
  };
  return JSON.stringify(payload, null, 2).replace(/<\//gu, '<\\/');
}

/**
 * 构建两条 user 消息的文本：证据与待审动作。
 * 证据与动作分开成段，模型不能把动作段误当成转录的一部分。
 * @param {{evidence?: string, action?: object}} input - 证据文本与动作。
 * @param {string} [lang='en'] - 动作段衔接行语言（R28；缺省 en＝schema 默认）。
 * @returns {{evidenceText: string, actionText: string}} 两段文本。
 */
export function buildUserTexts(input, lang = 'en') {
  const evidence = typeof input?.evidence === 'string' ? input.evidence : '';
  const evidenceText = `${UNTRUSTED_NOTICE}\n${TRANSCRIPT_START}\n${evidence}\n${TRANSCRIPT_END}`;
  const actionText = `${agentT(lang, 'agent.actionHeader')}\n${renderAction(input?.action ?? {})}`;
  return { evidenceText, actionText };
}
