/**
 * dsh-approve-for-me — 命令回查与会话取材。
 *
 * 审批请求本身不带工具参数，因此真实命令要从会话日志回查。两种形态都覆盖：
 * 模型直接调用工具时命中 `tool/call` 的 `data.callId`（`arguments` 是 JSON 字符串）；
 * 代码模式下工具在 `run_code` 内派发，命中 `tool/code-dispatch-start` 的
 * `data.subCallId`（形如 `<callId>:code:<n>`，`arguments` 是对象）。
 * 取材与脱敏规则见 design §3.2；产物只是给审查器的证据文本，不写回会话。
 *
 * 事件读取用 `session.snapshotEvents()` 的无参同步读法一次取得全量数组；宿主签名
 * 另有分页形态 `snapshotEvents(fromSeq, toSeqExclusive)`，无参调用兼容。本读法的
 * 假设是「一次取全量、返回数组可倒序扫描」；宿主升级时重验该读法（design §3.2）。
 * @module dsh-approve-for-me/transcript
 */
import { isAbsolute, resolve } from 'node:path';
import { compilePattern } from './policy.js';

/** 截断标记形如 codex 的 `<truncated omitted_approx_tokens="N" />`；N 按字节数 / 4 估算。 */
const TRUNCATED_TEMPLATE = (approxTokens) => `<truncated omitted_approx_tokens="${approxTokens}" />`;

/** 纳入上下文的会话事件类型。 */
const CONTEXT_EVENT_TYPES = new Set([
  'request/header',
  'step/end',
  'user/message',
  'developer/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'tool/code-dispatch-start',
  'tool/ptc-dispatch-start',
]);

/**
 * 来源标签词表（design §3.2 表／§7.5 不变块）：两语言逐字节一致的唯一权威，系统提示
 * （`lib/agent-texts.js` 证据处理段）按同一拼写引用，测试钉住两处不漂移。
 * `injectedPrefix` 是 `injected (<kind>):` 族的字面前缀（kind 原值回显）。
 */
export const SOURCE_LABELS = Object.freeze({
  user: 'user:',
  userQuestionReply: 'user (ask_user_question reply):',
  agentInstructions: 'user (AGENTS.md instructions):',
  developer: 'developer:',
  injectedPrefix: 'injected (',
  sourceNotRecorded: 'injected (source not recorded):',
});

/** 可信授权来源的 `user/message` kind→行首标签（SOURCE_LABELS 的 kind 视图）。 */
const TRUSTED_USER_LABELS = new Map([
  ['user', SOURCE_LABELS.user],
  ['user-question-reply', SOURCE_LABELS.userQuestionReply],
  ['agent-instructions', SOURCE_LABELS.agentInstructions],
]);

/** `developer/message` 的行首标签（可信授权来源，正文取 `data.message.content` 的文本块）。 */
const DEVELOPER_LABEL = SOURCE_LABELS.developer;

/** 来源缺席或 `kind` 非字符串时的行首标签：不可信证据，不默认升级为真人授权。 */
const SOURCE_NOT_RECORDED_LABEL = SOURCE_LABELS.sourceNotRecorded;

/**
 * `user/message` 的行首来源标签（design §3.2 标签表）：可信四类之外的 kind 一律落
 * `injected (<kind>):` 一族——宿主 `MessageSourceMap` 是开放词表，不逐 kind 维护可信映射；
 * 本插件自身注入（`plugin:approve-for-me`）同按 injected 渲染，不得呈现为用户授权。
 * @param {unknown} source - 事件的 `data.source`。
 * @returns {string} 行首标签（含结尾冒号）。
 */
function userSourceLabel(source) {
  const kind = source?.kind;
  if (typeof kind !== 'string') return SOURCE_NOT_RECORDED_LABEL;
  const trusted = TRUSTED_USER_LABELS.get(kind);
  if (trusted !== undefined) return trusted;
  return `injected (${kind}):`;
}

/**
 * 单行归一（design §3.3）：CR、LF、U+2028、U+2029 与 U+0085 一律替换为两字符字面 `\n`。
 * 归一统一行分隔符的呈现：每个分隔符字符恰替换为一个字面（CRLF 呈现为两个连续字面），
 * 不合并、不丢弃、不截断；五类分隔符映射到同一字面，不保留原种类，归一不可逆。
 * 替换在行文本离开渲染函数时完成，先于 `</` 转义、脱敏与两级
 * 裁剪——由此证据文本的每个行首都由代码控制（来源标签或截断标记），正文里形似标签的
 * 文本只能落在行中、不构成新行。
 * @param {string} text - 渲染输出。
 * @returns {string} 单行文本。
 */
export function normalizeSingleLine(text) {
  return text.replace(/[\r\n\u2028\u2029\u0085]/gu, '\\n');
}

/** 代码模式派发事件的两代名（`code` 为旧名、`ptc` 为现名），两代都要认。 */
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
  // 代理对边界回退：切点落在代理对中间（前字符高代理、后字符低代理）时让出一码元，
  // 产物不含孤立代理项——预算恰含整对时二分自然停在整对之后，不进本分支。
  const splitsPair = (index) => index > 0 && index < text.length
    && /[\uD800-\uDBFF]/u.test(text[index - 1]) && /[\uDC00-\uDFFF]/u.test(text[index]);
  if (side === 'head') {
    if (splitsPair(low)) low -= 1;
    return text.slice(0, low);
  }
  if (splitsPair(text.length - low)) low -= 1;
  return text.slice(text.length - low);
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
 * 读取会话事件快照：`snapshotEvents()` 的无参同步读法一次取得全量数组（design §3.2）。
 * 读取服务缺失、抛错或返回非数组时返回 `undefined`。
 * @param {{snapshotEvents?: () => readonly object[]} | undefined} session - 发起会话。
 * @returns {readonly object[] | undefined} 事件数组。
 */
export function readEvents(session) {
  if (session === undefined || typeof session.snapshotEvents !== 'function') return undefined;
  try {
    const events = session.snapshotEvents();
    return Array.isArray(events) ? events : undefined;
  } catch {
    return undefined;
  }
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
  if (callId === undefined) return undefined;
  return findToolCallIn(readEvents(session), callId);
}

/**
 * 在既定事件数组内倒序回查工具调用参数（design §3.1）。
 * @param {readonly object[] | undefined} events - 事件快照。
 * @param {string} callId - 审批请求的 `callId`。
 * @returns {object | undefined} 命中的事件 `data`。
 */
function findToolCallIn(events, callId) {
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
 * 合法目录值：非空字符串且为绝对路径（`node:path` 平台默认判定，design §3.1）。
 * @param {unknown} value - 候选目录值。
 * @returns {string | undefined} 合法值原样返回；非法返回 `undefined`。
 */
function validDir(value) {
  return typeof value === 'string' && value.length > 0 && isAbsolute(value) ? value : undefined;
}

/**
 * 折叠会话当前目录（design §3.1）：在与回查同一次事件快照内倒序扫描，取最后一条
 * `working-directory/change` 事件的合法 `cwd`（非法值跳过该事件继续倒序）；无合法事件时
 * 取会话头 `header.cwd`（同一合法性判定）；再无则缺失。宿主目录服务以同一事件流维护会话
 * 投影——`header.cwd` 起步、`working-directory/change` 覆写、变更只追加事件不改会话头——
 * 本折叠与该投影在合法事件流下同义；宿主在投影为空时使用的部署回退目录对插件不可知，
 * 不以猜测值顶替。
 * @param {{header?: {cwd?: unknown}} | undefined} session - 发起会话。
 * @param {readonly object[] | undefined} events - 与回查共用的事件快照。
 * @returns {string | undefined} 会话当前目录。
 */
export function foldSessionCwd(session, events) {
  if (Array.isArray(events)) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== 'working-directory/change') continue;
      const cwd = validDir(event?.data?.cwd);
      if (cwd !== undefined) return cwd;
    }
  }
  return validDir(session?.header?.cwd);
}

/**
 * 按宿主 pwsh `resolveWorkdir` 同义规则折算实际执行目录（design §3.1）：`workdir` 是绝对
 * 路径时取原值；是相对路径且会话当前目录在场时取 `resolve(会话当前目录, workdir)`；
 * `workdir` 缺省、空串或非字符串时（宿主工具 schema 先行拒绝非字符串，执行不携带它）会话
 * 当前目录即执行目录；是相对路径而会话当前目录缺失时执行目录缺失，不伪造。`workdir` 来自
 * 被审参数、属不可信证据——折算只决定取证根的目录选择，不是权限来源。
 * @param {string | undefined} sessionCwd - 会话当前目录。
 * @param {unknown} workdir - 回查参数里的 `workdir`。
 * @returns {string | undefined} 实际执行目录。
 */
export function resolveExecutionDir(sessionCwd, workdir) {
  if (typeof workdir !== 'string' || workdir === '') return sessionCwd;
  if (isAbsolute(workdir)) return workdir;
  if (sessionCwd !== undefined) return resolve(sessionCwd, workdir);
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
 * 回查一次审批请求对应的命令与目录（design §3.1 两级折算）。
 *
 * 事件快照一次读取，回查（`findToolCallIn`）与会话当前目录折叠（`foldSessionCwd`）共用同一
 * 快照；`cwd`＝实际执行目录（`resolveExecutionDir` 折算 `workdir`），`sessionCwd`＝会话当前
 * 目录（可取得时携带）。实际执行目录缺失记 `degraded=cwd`，会话当前目录缺失记
 * `degraded=session-cwd`（两者可并存）。
 * @param {{agent?: {session?: object}, callId?: string}} request - 审批请求。
 * @returns {{command?: string, cwd?: string, sessionCwd?: string, description?: string, arguments?: object, degraded: string[]}}
 *   回查不到工具调用时仍返回目录折算，并把 `command` 记入 `degraded`（读取异常内部已吞，本函数不返回 `null`）。
 */
export function locate(request) {
  const session = request?.agent?.session;
  const events = readEvents(session);
  const data = findToolCallIn(events, request?.callId);
  const sessionCwd = foldSessionCwd(session, events);
  const degraded = [];
  if (sessionCwd === undefined) degraded.push('session-cwd');
  const args = data === undefined ? undefined : parseArguments(data.arguments);
  const cwd = resolveExecutionDir(sessionCwd, args?.workdir);
  if (cwd === undefined) degraded.push('cwd');
  if (data === undefined) {
    // 命令回查不到不等于没有目录：`unknownSubject` 分支仍需要目录作证据。
    return { cwd, ...(sessionCwd !== undefined ? { sessionCwd } : {}), degraded: [...degraded, 'command'] };
  }
  const command = typeof args?.command === 'string' ? args.command : undefined;
  const description = typeof args?.description === 'string' ? args.description : undefined;
  if (args === undefined) degraded.push('command');
  return {
    command,
    cwd,
    ...(sessionCwd !== undefined ? { sessionCwd } : {}),
    description,
    arguments: args,
    degraded,
  };
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
      return `${userSourceLabel(data.source)} ${blocksText(data.content)}`;
    case 'developer/message':
      return `${DEVELOPER_LABEL} ${blocksText(data.message?.content)}`;
    case 'assistant/message':
      return `assistant: ${blocksText(data.message?.content)}`;
    case 'tool/call':
      return `tool ${data.name ?? '?'} call: ${data.arguments ?? ''}`;
    case 'tool/result':
      return cfg.includeToolResults === false ? undefined : `tool result: ${blocksText(data.message?.content)}`;
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
 * 拼接内容块里的可见文本；reasoning 块不进上下文（design §3.2）。
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
 * 上下文采集降级标记：读取失败（接口缺失、抛错或返回非事件数组）标记 `transcript-read-failed`，
 * 会话上下文确实没取到，不与预算截断（`transcript-truncated`）混用同一标记（requirements §3.1 缺失须可辨认）。
 */
export const TRANSCRIPT_READ_FAILED = 'transcript-read-failed';
export const TRANSCRIPT_TRUNCATED = 'transcript-truncated';

/**
 * 从会话尾部取最近上下文，按预算截断并脱敏。
 * @param {{snapshotEvents?: () => readonly object[]} | undefined} session - 发起会话。
 * @param {object} cfg - `context` 配置。
 * @returns {{text: string, entries: number, truncated: boolean, degraded: string[]}} 证据文本。
 */
export function collectEvidence(session, cfg) {
  const degraded = [];
  // 零条数是主动不取事件的显式意图：判定先于一切读取与服务检查——
  // 不调用 snapshotEvents、不检查读取服务，因此快照抛错或服务缺失都不产生读取降级（design §3.2）。
  const maxEntries = Number.isFinite(cfg?.maxEntries) ? cfg.maxEntries : 40;
  if (maxEntries === 0) {
    return { text: '', entries: 0, truncated: false, degraded };
  }
  if (session === undefined || typeof session.snapshotEvents !== 'function') {
    return { text: '', entries: 0, truncated: false, degraded: [TRANSCRIPT_READ_FAILED] };
  }
  let events;
  try {
    events = session.snapshotEvents();
  } catch {
    return { text: '', entries: 0, truncated: false, degraded: [TRANSCRIPT_READ_FAILED] };
  }
  if (!Array.isArray(events)) return { text: '', entries: 0, truncated: false, degraded: [TRANSCRIPT_READ_FAILED] };

  const maxEntryBytes = Number.isFinite(cfg?.maxEntryBytes) ? cfg.maxEntryBytes : 4096;
  const maxTranscriptBytes = Number.isFinite(cfg?.maxTranscriptBytes) ? cfg.maxTranscriptBytes : 24576;

  const lines = [];
  for (let index = events.length - 1; index >= 0 && lines.length < maxEntries; index -= 1) {
    const event = events[index];
    if (!CONTEXT_EVENT_TYPES.has(event?.type)) continue;
    const rendered = renderEvent(event, cfg ?? {});
    if (rendered === undefined) continue;
    // 单行归一（design §3.3）：行文本离开渲染函数时完成，先于 `</` 转义、脱敏与两级裁剪；
    // 归一后文本按同一口径计量（脱敏匹配与字节预算都作用于单行形态）。
    const line = normalizeSingleLine(rendered);
    // `</` 先转义再截断：证据里的闭合标签不得被模型当成提示词结构（design §3.3）。
    const escaped = line.replace(/<\//gu, '<\\/');
    const redacted = redact(escaped, cfg?.redactPatterns);
    const clipped = truncateKeepEnds(redacted, maxEntryBytes);
    if (clipped.truncated) degraded.push(`entry:${event.type}`);
    lines.push(clipped.text);
  }
  const joined = lines.reverse().join('\n');
  const clipped = truncateKeepEnds(joined, maxTranscriptBytes);
  if (clipped.truncated) degraded.push(TRANSCRIPT_TRUNCATED);
  return { text: clipped.text, entries: lines.length, truncated: clipped.truncated, degraded };
}
