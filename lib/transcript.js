/**
 * dsh-approve-for-me — 命令回查与会话取材。
 *
 * 审批请求本身不带工具参数，因此真实命令要从会话日志回查。两种形态都覆盖：
 * 模型直接调用工具时命中 `tool/call` 的 `data.callId`（`arguments` 是 JSON 字符串）；
 * 代码模式下工具在 `run_code` 内派发，命中 `tool/code-dispatch-start` 的
 * `data.subCallId`（形如 `<callId>:code:<n>`，`arguments` 是对象）。
 * 取材与脱敏规则见设计「上下文取材与脱敏」；产物只是给审查器的证据文本，不写回会话。
 *
 * `session.snapshotEvents()` 的同步读法在 dsh 0.2.0-rc.1 被官方标注 deprecated（签名扩展为 `snapshotEvents(fromSeq, toSeqExclusive)`，无参调用仍兼容）——waiver：
 * 本插件沿用无参同步读法，迁移等上游分页读法稳定后再议（设计 §3.2 对应行）。
 * @module dsh-approve-for-me/transcript
 */
import { compilePattern } from './policy.js';

/** 截断标记形如 codex 的 `<truncated omitted_approx_tokens="N" />`；N 按字节数 / 4 估算。 */
const TRUNCATED_TEMPLATE = (approxTokens) => `<truncated omitted_approx_tokens="${approxTokens}" />`;

/** 纳入上下文的会话事件类型。 */
const CONTEXT_EVENT_TYPES = new Set([
  'request/header',
  'step/end',
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'tool/code-dispatch-start',
  'tool/ptc-dispatch-start',
]);

/** 代码模式派发事件的两个代际名；0.1.5 起改为 `ptc`，两版都要认。 */
const DISPATCH_EVENT_SET = new Set(['tool/code-dispatch-start', 'tool/ptc-dispatch-start']);

/**
 * 把文本裁到字节预算内，保留首尾并插入截断标记。
 * 保留首尾而非只留头部：命令与结论常在尾部，只留头部会让审查器看不到关键信息。
 * @param {string} text - 原始文本。
 * @param {number} limitBytes - 字节上限；非正数表示不裁。
 * @returns {{text: string, truncated: boolean, omittedBytes: number}} 裁剪结果。
 */
export function truncateKeepEnds(text, limitBytes) {
  const size = Buffer.byteLength(text, 'utf8');
  if (!Number.isFinite(limitBytes) || limitBytes <= 0 || size <= limitBytes) {
    return { text, truncated: false, omittedBytes: 0 };
  }
  const marker = TRUNCATED_TEMPLATE(Math.ceil((size - limitBytes) / 4));
  const budget = Math.max(2, limitBytes - Buffer.byteLength(marker, 'utf8'));
  const headBytes = Math.ceil(budget * 0.6);
  const tailBytes = Math.max(0, budget - headBytes);
  const head = sliceByBytes(text, headBytes, 'head');
  const tail = tailBytes > 0 ? sliceByBytes(text, tailBytes, 'tail') : '';
  return { text: `${head}${marker}${tail}`, truncated: true, omittedBytes: size - limitBytes };
}

/**
 * 按字节数从一端切字符串，避免切碎代理对。
 * @param {string} text - 原始文本。
 * @param {number} limitBytes - 字节上限。
 * @param {'head' | 'tail'} side - 从头部还是尾部取。
 * @returns {string} 切片。
 */
function sliceByBytes(text, limitBytes, side) {
  if (Buffer.byteLength(text, 'utf8') <= limitBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const chunk = side === 'head' ? text.slice(0, mid) : text.slice(text.length - mid);
    if (Buffer.byteLength(chunk, 'utf8') <= limitBytes) low = mid;
    else high = mid - 1;
  }
  return side === 'head' ? text.slice(0, low) : text.slice(text.length - low);
}

/**
 * 按脱敏清单替换敏感片段。
 * @param {string} text - 原始文本。
 * @param {readonly string[]} [patterns] - 正则源清单；空则原样返回。
 * @returns {string} 脱敏后的文本。
 */
export function redact(text, patterns) {
  if (typeof text !== 'string' || text.length === 0) return '';
  let out = text;
  for (const pattern of patterns ?? []) {
    const compiled = compilePattern(pattern);
    if (compiled === undefined) continue;
    out = out.replace(new RegExp(compiled.source, compiled.flags.includes('g') ? compiled.flags : `${compiled.flags}g`), '[redacted]');
  }
  return out;
}

/**
 * 按 `callId` 回查一次工具调用。
 *
 * 倒序扫描，两种形态都命中：`tool/call` 的 `data.callId`（模型直接调用）与
 * `tool/code-dispatch-start` 的 `data.subCallId`（代码模式下 `run_code` 内的派发）。
 * @param {{snapshotEvents?: () => readonly object[]} | undefined} session - 发起会话。
 * @param {string | undefined} callId - 审批请求的 `callId`。
 * @returns {object | undefined} 命中的事件 `data`。
 */
export function findToolCall(session, callId) {
  if (session === undefined || typeof session.snapshotEvents !== 'function' || callId === undefined) {
    return undefined;
  }
  let events;
  try {
    events = session.snapshotEvents();
  } catch {
    return undefined;
  }
  if (!Array.isArray(events)) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const data = event?.data;
    if (data === undefined || data === null) continue;
    if (event.type === 'tool/call' && data.callId === callId) return data;
    if (DISPATCH_EVENT_SET.has(event.type) && data.subCallId === callId) return data;
  }
  return undefined;
}

/**
 * 解析事件里的 `arguments`：`tool/call` 存 JSON 字符串，派发事件存对象。
 * @param {unknown} raw - 原始 `arguments`。
 * @returns {object | undefined} 解析后的对象。
 */
function parseArguments(raw) {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 回查一次审批请求对应的命令与工作目录。
 * @param {{agent?: {session?: object}, callId?: string}} request - 审批请求。
 * @returns {{command?: string, cwd?: string, description?: string, arguments?: object, degraded: string[]} | null}
 *   回查不到工具调用时仍返回 `cwd`，并把 `command` 记入 `degraded`。
 */
export function locate(request) {
  const session = request?.agent?.session;
  const data = findToolCall(session, request?.callId);
  const cwd = typeof session?.header?.cwd === 'string' && session.header.cwd.length > 0 ? session.header.cwd : undefined;
  const degraded = [];
  if (cwd === undefined) degraded.push('cwd');
  if (data === undefined) {
    // 命令回查不到不等于没有工作目录：`unknownSubject` 分支仍需要 cwd 作证据。
    return { cwd, degraded: [...degraded, 'command'] };
  }
  const args = parseArguments(data.arguments);
  const command = typeof args?.command === 'string' ? args.command : undefined;
  const description = typeof args?.description === 'string' ? args.description : undefined;
  if (args === undefined) degraded.push('command');
  return { command, cwd, description, arguments: args, degraded };
}

/**
 * 把一条会话事件渲染成一行带角色前缀的文本；不相关事件返回 `undefined`。
 * @param {object} event - 会话事件。
 * @param {object} cfg - `context` 配置。
 * @returns {string | undefined} 单行文本。
 */
function renderEvent(event, cfg) {
  const data = event?.data;
  if (data === undefined || data === null) return undefined;
  switch (event.type) {
    case 'user/message':
      return `user: ${blocksText(data.content)}`;
    case 'assistant/message':
      return `assistant: ${blocksText(data.message?.content)}`;
    case 'tool/call':
      return `tool ${data.name ?? '?'} call: ${data.arguments ?? ''}`;
    case 'tool/result':
      return cfg.includeToolResults === false ? undefined : `tool result: ${blocksText(data.message?.content?.[0]?.content)}`;
    case 'tool/code-dispatch-start':
    case 'tool/ptc-dispatch-start':
      return `tool ${data.name ?? '?'} dispatch: ${safeJson(data.arguments)}`;
    case 'step/end':
      return `step end (turn=${data.turn ?? '?'} step=${data.step ?? '?'})`;
    case 'request/header':
      return `request/header (${data.reason ?? 'snapshot'})`;
    default:
      return undefined;
  }
}

/**
 * 拼接内容块里的可见文本；reasoning 块不进上下文（设计「上下文取材与脱敏」）。
 * @param {unknown} blocks - 内容块数组。
 * @returns {string} 文本。
 */
function blocksText(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' ');
}

/**
 * JSON 序列化失败时退回 `String(value)`：证据文本不值得为一次序列化抛错。
 * @param {unknown} value - 任意值。
 * @returns {string} 文本。
 */
function safeJson(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 从会话尾部取最近上下文，按预算截断并脱敏。
 * @param {{snapshotEvents?: () => readonly object[]} | undefined} session - 发起会话。
 * @param {object} cfg - `context` 配置。
 * @returns {{text: string, entries: number, truncated: boolean, degraded: string[]}} 证据文本。
 */
export function collectEvidence(session, cfg) {
  const degraded = [];
  if (session === undefined || typeof session.snapshotEvents !== 'function') {
    return { text: '', entries: 0, truncated: false, degraded: ['transcript'] };
  }
  let events;
  try {
    events = session.snapshotEvents();
  } catch {
    return { text: '', entries: 0, truncated: false, degraded: ['transcript'] };
  }
  if (!Array.isArray(events)) return { text: '', entries: 0, truncated: false, degraded: ['transcript'] };

  const maxEntries = Number.isFinite(cfg?.maxEntries) ? cfg.maxEntries : 40;
  const maxEntryBytes = Number.isFinite(cfg?.maxEntryBytes) ? cfg.maxEntryBytes : 4096;
  const maxTranscriptBytes = Number.isFinite(cfg?.maxTranscriptBytes) ? cfg.maxTranscriptBytes : 24576;

  const lines = [];
  for (let index = events.length - 1; index >= 0 && lines.length < maxEntries; index -= 1) {
    const event = events[index];
    if (!CONTEXT_EVENT_TYPES.has(event?.type)) continue;
    const rendered = renderEvent(event, cfg ?? {});
    if (rendered === undefined) continue;
    // `</` 先转义再截断：证据里的闭合标签不得被模型当成提示词结构（设计「防注入」）。
    const escaped = rendered.replace(/<\//gu, '<\\/');
    const redacted = redact(escaped, cfg?.redactPatterns);
    const clipped = truncateKeepEnds(redacted, maxEntryBytes);
    if (clipped.truncated) degraded.push(`entry:${event.type}`);
    lines.push(clipped.text);
  }
  const joined = lines.reverse().join('\n');
  const clipped = truncateKeepEnds(joined, maxTranscriptBytes);
  if (clipped.truncated) degraded.push('transcript');
  return { text: clipped.text, entries: lines.length, truncated: clipped.truncated, degraded };
}
