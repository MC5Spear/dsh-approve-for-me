/**
 * dsh-approve-for-me — 审查提示词构建（正文取自 `lib/agent-texts.js` 双语字典）。
 *
 * 系统提示改写并节选自 OpenAI Codex Guardian，含保留的上游原句；输出契约采用上游正文、仅改一处换行。
 * 固定来源、版权及改动范围见 agent-texts 头注与 NOTICE。租户策略随包：
 * `assets/tenant-policy.md`（en，现行）与 `assets/tenant-policy.zh.md`（zh，对译），按
 * `language.agent` 读入并替换 `{{ tenant_policy_config }}`。文件读不到时的回退占位行同样
 * 走字典键 `agent.tenantPolicyMissing`（design §7.5）——zh 档触发回退时不得注入英文句。
 * 证据段的结构性防注入（不可信声明、角色前缀、边界标记、`</` 转义）见 design §3.3。
 * lang 一律在每次请求现取（热生效）；按请求取词的路径不在装载期缓存语言相关字符串
 * （`SYSTEM_PROMPT_TEMPLATE`／`TOOL_BUDGET_EXHAUSTED` 两处静态常量别名除外，见下）。
 * @module dsh-approve-for-me/prompt
 */
import { createHash } from 'node:crypto';
import { agentT } from './agent-texts.js';

/** 输出契约采用 Codex 正文，不可信声明为项目拟写；来源与改动见 NOTICE，正文均由 `agent-texts` 持有。 */
export { OUTPUT_CONTRACT, UNTRUSTED_NOTICE } from './agent-texts.js';
import { UNTRUSTED_NOTICE } from './agent-texts.js';

/** 证据段边界标记；两语言共用（不变块）。 */
const TRANSCRIPT_START = '>>> TRANSCRIPT START';
const TRANSCRIPT_END = '>>> TRANSCRIPT END';

/** en 系统提示模板（＝`agentT('en', 'agent.systemPrompt')` 的兼容导出，供既有导入）。 */
export const SYSTEM_PROMPT_TEMPLATE = agentT('en', 'agent.systemPrompt');

/** 轮次用尽指令（＝`agentT('zh', 'agent.toolBudgetExhausted')` 的兼容导出，供既有导入）。 */
export const TOOL_BUDGET_EXHAUSTED = agentT('zh', 'agent.toolBudgetExhausted');

/**
 * @param {string} lang - 语言（AGENT_LANGS 之一）。
 * @returns {string} 模板正文（含 `{{ tenant_policy_config }}` 占位）。
 */
export function systemPromptTemplate(lang) {
  return agentT(lang, 'agent.systemPrompt');
}

/**
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
 * 本次实际加载的租户策略摘要（design §8.2 `policyTag` 的摘要段）：随包策略文件内容的
 * SHA-256 前 12 位十六进制；文件缺失、读取失败或为空时为 `missing`（对应「仅按基础
 * 风险分级执行」的降级状态）。与 `tenantPolicy` 同一读取源（`agent-texts` 的文件缓存），
 * 不读磁盘当前状态。
 * @param {string} [lang='en'] - 语言。
 * @returns {string} 12 位十六进制摘要或 `missing`。
 */
export function tenantPolicyDigest(lang = 'en') {
  const load = agentT(lang, 'agent.tenantPolicy');
  const text = typeof load === 'function' ? load() : load;
  if (typeof text !== 'string' || text === '') return 'missing';
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}

/**
 * 构建审查器系统提示：模板 + 租户策略 + 输出契约。
 * @param {string} [lang='en'] - 语言；缺省 en（＝requirements §5.3 的 `language.agent` 默认值，`lib/config.js` schema default 同源）。
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
 * 把回查到的工具参数序列化为深度受限的证据文本。
 * 深度口径与规则层主体全量过检（`lib/policy.js` 的 `eachStringValue`）相同：深度 ≤4 的字符串值
 * 全量渲染（恰为规则扫描范围），容器在深度 4 不再下钻、其子树整体替换为 `"[depth-exceeded]"`。
 * 自有可枚举键全量保全：渲染容器为无原型对象，键一律写成自有数据属性——JSON 解析可产生的
 * 自有 `__proto__` 键与其它字符串键同等进入产物，不触发原型语义（不改写、不静默丢弃）。
 * 循环检测只跟踪当前递归祖先路径（容器渲染结束即回收，数组与对象一致）：无环的共享对象/数组
 * 按 JSON 语义在每处引用完整渲染，只有祖先回边落 `"[circular]"`。
 * 三个占位符与 `<truncated … />` 同列：两语言一致的不变块，由代码拼接、不进翻译字典。
 * `undefined` 值的键与 Symbol 键按 JSON 序列化语义省略（键名与 undefined 取值都不是载荷证据）；
 * 不可枚举与继承属性不渲染。产物是原始证据文本：送出前还需经 `</` 转义、脱敏与预算截断（reviewer 侧）。
 * @param {object} args - 回查到的参数对象。
 * @returns {string | undefined} 序列化文本；无参数时 `undefined`。
 */
export function renderArguments(args) {
  if (args === undefined || args === null) return undefined;
  try {
    const text = JSON.stringify(renderValue(args, 0, new WeakSet()));
    return text === undefined ? '[unserializable]' : text;
  } catch {
    // 遍历异常（抛错 getter、已 revoke 的 Proxy 等）不外抛：占位呈现，绝不静默丢弃整个参数段
    //（审查器「永不抛出」契约；不因序列化失败静默丢弃整个参数段）。
    return '[unserializable]';
  }
}

/**
 * 深度受限的值渲染；占位符是不变块。
 * @param {unknown} value - 任意值。
 * @param {number} depth - 当前深度（根为 0，与 eachStringValue 同口径）。
 * @param {WeakSet<object>} seen - 当前递归祖先路径（循环引用检测；容器渲染结束即回收）。
 * @returns {unknown} 可 JSON 化的替换值。
 */
function renderValue(value, depth, seen) {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  if (value === undefined) return undefined;
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') return '[unserializable]';
  if (typeof value !== 'object') return '[unserializable]';
  // 循环＝「当前递归祖先路径上的回边」；seen 不做全树已访问集合——无环共享容器按 JSON 语义完整渲染。
  if (seen.has(value)) return '[circular]';
  // 容器在深度 4 不再下钻：与规则扫描同一边界，深度 ≥5 的子树整体占位。
  if (depth >= 4) return '[depth-exceeded]';
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    seen.add(value);
    try {
      return value.map((item) => renderValue(item, depth + 1, seen));
    } finally {
      // 祖先路径回收：兄弟分支复用同一容器不再是循环；遍历中途抛错也不在路径上留残影。
      seen.delete(value);
    }
  }
  if (prototype !== Object.prototype && prototype !== null) return '[unserializable]';
  seen.add(value);
  try {
    // 无原型承载：任意自有键（含 JSON 解析产生的自有 `__proto__`）都定义为自有数据属性——
    // 普通对象上的 `out[key] = v` 会对 `__proto__` 触发继承访问器（原型改写/静默丢键）。
    const out = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      const rendered = renderValue(item, depth + 1, seen);
      if (rendered !== undefined) out[key] = rendered;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * 构建两条 user 消息的文本：证据与待审动作。
 * 证据与动作分开成段，模型不能把动作段误当成转录的一部分。
 * `argumentsText` 是回查到的真实参数段：仅在存在时追加在动作 JSON 之后，
 * 自带标签行（不可信口径），其余行为与既有动作段一致。`cwdMissing` 为真时
 * 追加目录缺失说明行（相对路径按插件进程目录解析，不得冒充会话目录）；
 * `commandMissing` 为真时追加命令回查失败说明行（与 `cwdMissing` 同位同形）。
 * `evidenceReadFailed` 为真时证据段末尾附读取失败说明行——空转录不冒充会话本无上下文。
 * @param {{evidence?: string, action?: object, argumentsText?: string, cwdMissing?: boolean, commandMissing?: boolean, evidenceReadFailed?: boolean}} input - 证据文本、动作、参数段与缺证标记。
 * @param {string} [lang='en'] - 动作段衔接行语言（缺省 en＝schema 默认）。
 * @returns {{evidenceText: string, actionText: string}} 两段文本。
 */
export function buildUserTexts(input, lang = 'en') {
  const evidence = typeof input?.evidence === 'string' ? input.evidence : '';
  let evidenceText = `${UNTRUSTED_NOTICE}\n${TRANSCRIPT_START}\n${evidence}\n${TRANSCRIPT_END}`;
  if (input?.evidenceReadFailed === true) {
    evidenceText += `\n${agentT(lang, 'agent.evidenceReadFailed')}`;
  }
  let actionText = `${agentT(lang, 'agent.actionHeader')}\n${renderAction(input?.action ?? {})}`;
  if (input?.cwdMissing === true) {
    actionText += `\n${agentT(lang, 'agent.cwdMissing')}`;
  }
  if (input?.commandMissing === true) {
    actionText += `\n${agentT(lang, 'agent.commandMissing')}`;
  }
  if (typeof input?.argumentsText === 'string' && input.argumentsText.length > 0) {
    actionText += `\n${agentT(lang, 'agent.actionArgumentsHeader')}\n${input.argumentsText}`;
  }
  return { evidenceText, actionText };
}
