/**
 * dsh-approve-for-me — 审查与结算记录的摘要字段工具（design §8.2 摘要字段词汇表）。
 *
 * 摘要文本字段（reason/subject/evidence/probes）共用一条预算口径：先脱敏，再按
 * `context.maxEntryBytes` 保留首尾并置截断标记；`configTag` 是影响审查行为的配置子集的
 * 键序稳定哈希。四个生产环节（reviewer/gate 生产、trace-store 白名单、RPC 投影、客户端呈现）
 * 消费同一份词汇表，本模块只提供无状态的纯函数。
 * @module dsh-approve-for-me/lib/record-fields
 */
import { createHash } from 'node:crypto';

/**
 * 键序稳定的序列化：对象键按字典序排列（递归），数组保序——同一配置子集恒得同一字符串。
 * @param {unknown} value - 待序列化值。
 * @returns {string} 稳定 JSON 文本。
 */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const body = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * 影响审查行为的配置子集（design §8.2 `configTag` 条目）：模式与工具名单、升权上限、拒绝规则、
 * 未知动作处置、人工备用、触发条件、审查模型与预算及时限、人工时限、上下文预算与脱敏清单、
 * 并发与冷却、Agent 语言。请求快照绑定——本函数只对传入的 cfg 取值，不读运行时状态。
 * @param {object} cfg - 生效配置（normalizeConfig 产物）。
 * @returns {object} 配置子集。
 */
export function configSubsetOf(cfg) {
  return {
    mode: cfg?.mode,
    tools: cfg?.tools,
    allowEscalationTo: cfg?.allowEscalationTo,
    denyPatterns: cfg?.denyPatterns,
    unknownSubject: cfg?.unknownSubject,
    fallback: cfg?.fallback,
    trigger: cfg?.trigger,
    reviewer: cfg?.reviewer,
    human: cfg?.human,
    context: cfg?.context,
    concurrency: cfg?.concurrency,
    breaker: cfg?.breaker,
    agentLanguage: cfg?.language?.agent,
  };
}

/**
 * 计算生效配置标识 `configTag`：配置子集的键序稳定序列化取 SHA-256 前 12 位十六进制。
 * @param {object} cfg - 生效配置。
 * @returns {string} 12 位十六进制标识。
 */
export function configTagOf(cfg) {
  return createHash('sha256').update(stableStringify(configSubsetOf(cfg)), 'utf8').digest('hex').slice(0, 12);
}

/**
 * 按字节预算保留首尾并置截断标记（摘要文本字段的统一裁剪口径）。
 * 预算内原样返回；超限时首尾各留约一半预算，中间放 `…<truncated bytes="原字节数"/>…`。
 * @param {string} text - 已脱敏的文本。
 * @param {number} maxBytes - 字节上限（`context.maxEntryBytes`）。
 * @returns {{text: string, truncated: boolean}} 结果。
 */
export function clipKeepEnds(text, maxBytes) {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || bytes <= maxBytes) return { text, truncated: false };
  const marker = `…<truncated bytes="${bytes}"/>…`;
  // 首尾平分剩余预算；逐字符退到不破坏多字节字符的边界。
  let budget = Math.max(0, Math.floor(maxBytes) - Buffer.byteLength(marker, 'utf8'));
  let head = text.slice(0, Math.ceil(text.length / 2));
  let tail = text.slice(Math.ceil(text.length / 2));
  while (head.length > 0 && Buffer.byteLength(head, 'utf8') > Math.floor(budget / 2)) head = head.slice(0, -1);
  budget -= Buffer.byteLength(head, 'utf8');
  while (tail.length > 0 && Buffer.byteLength(tail, 'utf8') > budget) tail = tail.slice(1);
  return { text: `${head}${marker}${tail}`, truncated: true };
}

/**
 * 摘要文本的完整口径：先脱敏，再按 `context.maxEntryBytes` 保留首尾。
 * @param {string} text - 原始文本。
 * @param {object} cfg - 生效配置（取 `context.maxEntryBytes`）。
 * @param {(text: string) => string} [redact] - 脱敏函数（缺省不脱敏，仅供单测）。
 * @returns {string} 摘要文本（内嵌截断标记）。
 */
export function summarizeText(text, cfg, redact) {
  const raw = typeof text === 'string' ? text : '';
  const safe = typeof redact === 'function' ? redact(raw) : raw;
  return clipKeepEnds(safe, cfg?.context?.maxEntryBytes).text;
}

/**
 * 操作摘要取材（design §8.2 `subject`）：优先命令原文，回退描述或参数摘要。
 * 都取不到返回 `undefined`，让存储侧省略该字段而不是落一个空串。
 * 参数 JSON 的转换异常回退为安全占位（`[unserializable]`，与 `renderArguments` 同一词汇）。
 * @param {{command?: string, description?: string, arguments?: object} | null} [located] - 回查结果。
 * @returns {string | undefined} 文本。
 */
export function subjectText(located) {
  if (typeof located?.command === 'string' && located.command.length > 0) return located.command;
  if (typeof located?.description === 'string' && located.description.length > 0) return located.description;
  const args = located?.arguments;
  if (args === undefined || args === null) return undefined;
  try {
    return JSON.stringify(args) ?? '[unserializable]';
  } catch {
    return '[unserializable]';
  }
}

/**
 * `subject` 字段的完整口径：取材后先脱敏，再按 `context.maxEntryBytes` 保留首尾。
 * 供审查记录（reviewer）与结算记录（gate 规则直拒等无审查路径）共用同一实现。
 * @param {{command?: string, description?: string, arguments?: object} | null} [located] - 回查结果。
 * @param {object} cfg - 生效配置。
 * @param {(text: string) => string} [redact] - 脱敏函数。
 * @returns {string | undefined} 摘要文本；取不到材时 `undefined`。
 */
export function subjectSummary(located, cfg, redact) {
  const text = subjectText(located);
  return text === undefined ? undefined : summarizeText(text, cfg, redact);
}
