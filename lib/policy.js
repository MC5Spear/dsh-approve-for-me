/**
 * dsh-approve-for-me — 规则强制检查（纯函数）。
 *
 * 本模块不引用 cordis、会话或宿主服务，因此可用 `node --test` 直接验证；宿主插件只做适配。
 * 规则强制检查独立于 LLM：命中即拒绝，LLM 与人工都不能推翻（R7）。
 *
 * 术语沿用 `@deepseek-ai/dsh-user-approval` 与 `@deepseek-ai/dsh-sandbox`：
 *   - 审批请求形如 `{ agent, toolName, callId?, reason?, signal? }`，不含工具参数；
 *   - 沙箱升权 reason 形如 `escalate sandbox to <mode>: <justification>`；
 *   - 结果是闭集 `allowed-once | rejected | cancelled | unavailable`。
 * @module dsh-approve-for-me/policy
 */

/** 沙箱模式由窄到宽排序；未知模式视为比任何上限都宽（fail-closed）。 */
export const MODE_RANK = Object.freeze({
  'read-only': 0,
  'workspace-write': 1,
  'danger-full-access': 2,
});

/** 沙箱允许的升权目标闭集（`dsh-sandbox` 的 `ESCALATION_TARGETS`）。 */
export const ESCALATION_TARGETS = Object.freeze(['workspace-write', 'danger-full-access']);

/**
 * 规则强制拒绝清单：只收不可逆的极危险操作，避免把日常命令误判成危险。
 * 每项是 JavaScript 正则源，编译时统一加 `i`；命中即跳过 LLM 直接拒绝（R7）。
 * 前锚取非字母数字边界 `(^|[^A-Za-z0-9])`（R35）：引号、括号、`=`、`$(`、反引号等包裹形态
 * 都是非字母数字，一条规则覆盖全部；词内命中（`grep mkfs readme.md`）按 fail-closed 接受，用户可自定义清单收窄。
 */
export const DEFAULT_DENY_PATTERNS = Object.freeze([
  String.raw`(^|[^A-Za-z0-9])(mkfs|diskpart|fdisk|parted)\b`,
  // format 单列且不加尾锚 `\b`：冒号是非词字符，`\b` 要求后随词字符才成立——`format c:"`、`format c: /q`、
  // 行尾 `format c:` 全都不成立，加锚等于把整条模式判死（R35 判据①逼出的既有死分支）。
  String.raw`(^|[^A-Za-z0-9])format\s+[a-z]:`,
  String.raw`(^|[^A-Za-z0-9])dd\s+.*\bof=/dev/`,
  String.raw`(^|[^A-Za-z0-9])rm\s+(-[a-z]*\s+)*(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+(/|/etc|/usr|/var|/home|\$HOME|[a-z]:\\)(\s|$)`,
  String.raw`(^|[^A-Za-z0-9])Remove-Item\b(?=.*-Recurse)(?=.*-Force).*([a-z]:\\(Windows|Users|Program Files)|\bC:\s*$)`,
  String.raw`(^|[^A-Za-z0-9])(vssadmin\s+delete\s+shadows|bcdedit|cipher\s+/w|wbadmin\s+delete)\b`,
  String.raw`(^|[^A-Za-z0-9])reg\s+delete\s+HKLM`,
  String.raw`(^|[^A-Za-z0-9])(shutdown|Stop-Computer)\b`,
]);

/**
 * 脱敏清单（设计「上下文取材与脱敏」）：写进提示词、工具结果与审计之前统一替换为 `[redacted]`。
 * 只作用于提示词与审计，不改会话日志。
 */
export const DEFAULT_REDACT_PATTERNS = Object.freeze([
  String.raw`sk-[A-Za-z0-9_\-]{8,}`,
  String.raw`\bBearer\s+[A-Za-z0-9._\-]{8,}`,
  String.raw`\b(password|passwd|token|api_key|apikey|secret)\s*[=:]\s*[^\s"'` + '`' + String.raw`]+`,
  String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`,
  String.raw`Authorization:\s*[^\r\n]+`,
  String.raw`://[^/\s:@]+:[^/\s:@]+@`,
]);

/**
 * 解析沙箱升权 reason。
 * @param {unknown} reason - 审批请求的 `reason`。
 * @returns {{mode: string, justification: string} | undefined} 非升权请求返回 `undefined`。
 */
export function parseEscalationReason(reason) {
  if (typeof reason !== 'string') return undefined;
  const match = /^escalate sandbox to ([a-z-]+):\s*([\s\S]*)$/.exec(reason);
  if (match === null) return undefined;
  return { mode: match[1], justification: match[2] };
}

/**
 * 判断请求的模式是否不超过配置上限。
 * @param {string} requested - 请求的沙箱模式。
 * @param {string} ceiling - 允许自动放行的最宽模式。
 * @returns {boolean} 未知模式一律 `false`（fail-closed）。
 */
export function modeWithinCeiling(requested, ceiling) {
  const requestedRank = MODE_RANK[requested];
  const ceilingRank = MODE_RANK[ceiling];
  if (requestedRank === undefined || ceilingRank === undefined) return false;
  return requestedRank <= ceilingRank;
}

/**
 * 从 `tool/code-dispatch-start` 的 `data.arguments`（对象）中取出可读的命令或路径。
 * @param {unknown} args - 回查到的参数对象。
 * @returns {string | undefined} 命令/路径文本；取不到返回 `undefined`。
 */
export function extractSubject(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined;
  for (const key of ['command', 'cmd', 'script', 'path', 'file_path', 'filePath', 'pattern']) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * 编译一条配置里的正则。支持普通源串（加 `i`）与 `/source/flags` 形式。
 * @param {unknown} pattern - 配置里的模式串或 RegExp。
 * @returns {RegExp | undefined} 不可用时返回 `undefined`（该项失效但不影响其余项）。
 */
export function compilePattern(pattern) {
  if (pattern instanceof RegExp) return pattern;
  if (typeof pattern !== 'string' || pattern.length === 0) return undefined;
  const literal = /^\/(.*)\/([a-z]*)$/.exec(pattern);
  try {
    if (literal !== null && literal[1].length > 0) return new RegExp(literal[1], literal[2] || 'i');
    return new RegExp(pattern, 'i');
  } catch {
    return undefined;
  }
}

/**
 * 对一次审批请求做规则强制检查。
 * @param {{toolName?: string, callId?: string, reason?: string}} request - 审批请求。
 * @param {{command?: string, cwd?: string, arguments?: object} | null} located - 回查结果。
 * @param {object} cfg - 已解析的插件配置。
 * @returns {{action: 'skip' | 'deny' | 'review', why: string, reason?: string, fields: object}}
 *   `skip` = 不接管，交给下一个应答者；`deny` = 直接拒绝；`review` = 进入 LLM 审查。
 */
export function screen(request, located, cfg) {
  const base = {
    callId: request?.callId,
    tool: request?.toolName,
    cwd: located?.cwd,
    mode: parseEscalationReason(request?.reason)?.mode,
  };

  if ((cfg?.mode ?? 'rules') === 'off') {
    return { action: 'skip', why: 'mode=off', fields: { ...base, action: 'skip' } };
  }

  const tools = cfg?.tools ?? [];
  if (tools.length > 0 && !tools.includes(request?.toolName)) {
    return {
      action: 'skip',
      why: `tool "${request?.toolName}" is outside the configured tools list`,
      fields: { ...base, action: 'skip' },
    };
  }

  const escalation = parseEscalationReason(request?.reason);
  if (escalation === undefined) {
    // 非沙箱升权请求不归本插件管；保持宿主原有的审批通道不变。
    return { action: 'skip', why: 'not a sandbox escalation', fields: { ...base, action: 'skip' } };
  }

  const ceiling = cfg?.allowEscalationTo ?? 'danger-full-access';
  if (!modeWithinCeiling(escalation.mode, ceiling)) {
    return {
      action: 'deny',
      why: `escalation to "${escalation.mode}" exceeds allowEscalationTo "${ceiling}"`,
      reason: `升权目标 ${escalation.mode} 超过自动放行上限 ${ceiling}`,
      fields: { ...base, action: 'deny' },
    };
  }

  // 规则扫描先于主体判定：扫描对象是 arguments 的全部字符串值，不依赖 extractSubject 的结果，
  // 回查参数无命令类键时其他键的载荷同样过检（命中即直拒，缺证降级标记只随 unknownSubject 处置出现）。
  // R35 主体全量过检：deny 判定遍历 arguments 里全部字符串值（own enumerable，深 ≤4，对象与数组都走），
  // 不再只看 extractSubject 的首键——毒藏后位键（script/args 一类）同样命中；首键语义保留给 evidence 取材。
  // 非命令字符串（env 值、注释一类）也会过检：口径＝宁可误伤，fail-closed。
  const compiledDeny = [];
  for (const pattern of cfg?.denyPatterns ?? []) {
    const compiled = compilePattern(pattern);
    if (compiled !== undefined) compiledDeny.push({ pattern, compiled });
  }
  let hit;
  for (const entry of compiledDeny) {
    eachStringValue(located?.arguments, (text, key) => {
      if (hit === undefined && entry.compiled.test(text)) hit = { pattern: entry.pattern, key };
    });
    if (hit !== undefined) break;
  }
  if (hit !== undefined) {
    return {
      action: 'deny',
      why: `deny pattern ${String(hit.pattern)} matched key "${hit.key}"`,
      reason: `命令命中规则强制拒绝清单：键 "${hit.key}" 命中模式 ${String(hit.pattern)}`,
      fields: { ...base, action: 'deny' },
    };
  }

  const subject = extractSubject(located?.arguments);
  if (subject === undefined) {
    if ((cfg?.unknownSubject ?? 'reject') === 'reject') {
      return {
        action: 'deny',
        why: 'command not found for callId',
        reason: '未能回查到本次调用的命令或参数，按无证据处理',
        fields: { ...base, action: 'deny', degraded: 'command' },
      };
    }
    return {
      action: 'review',
      why: 'command not found; unknownSubject=review',
      fields: { ...base, action: 'review', degraded: 'command' },
    };
  }

  return { action: 'review', why: 'rules passed', fields: { ...base, action: 'review' } };
}

/**
 * 遍历一个值里的全部字符串（own enumerable，对象与数组，深度上限 4 防构造深嵌套）。
 * @param {unknown} value - 任意值。
 * @param {(text: string, key: string) => void} visit - 访问器（key 为点分与下标组合路径，根为 `arguments`）。
 * @param {number} [depth] - 当前深度。
 * @param {string} [key] - 当前键路径。
 * @returns {void}
 */
function eachStringValue(value, visit, depth = 0, key = '') {
  if (typeof value === 'string') {
    visit(value, key === '' ? 'arguments' : key);
    return;
  }
  if (value === null || typeof value !== 'object' || depth >= 4) return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      eachStringValue(value[index], visit, depth + 1, key === '' ? `[${index}]` : `${key}[${index}]`);
    }
    return;
  }
  for (const [name, childValue] of Object.entries(value)) {
    eachStringValue(childValue, visit, depth + 1, key === '' ? String(name) : `${key}.${String(name)}`);
  }
}
