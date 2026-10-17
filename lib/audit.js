/**
 * dsh-approve-for-me — 审计输出（单行，写 stderr）。
 *
 * 落点必须是 stderr：本部署的 stdout 是 token 文件 `current-url.txt`，写 stdout 会污染它。
 * 每行一条，字段顺序固定，便于 `Select-String` 过滤与重跑核对。
 * @module dsh-approve-for-me/audit
 */
import { redact as redactText } from './transcript.js';

/** 审计格式版本；字段增删时递增。 */
export const AUDIT_VERSION = 3;

/** `phase` 允许取值（design §8.1）。 */
export const AUDIT_PHASES = Object.freeze(['screen', 'review', 'tool', 'handoff', 'decide', 'error', 'prompt', 'raw']);

/** `reason` 字段的字符上限；超出截断并置 `truncated=true`。 */
export const REASON_MAX_CHARS = 200;

/** 单行字节上限的回退值；配置缺省时使用。 */
export const DEFAULT_MAX_LINE_BYTES = 4096;

/**
 * `startedAt` 登记表的容量上界（design §8.3）：decide 行写出即删、skip 行不登记已是主回收路径，
 * 本上限是无 decide 跟随路径的回退；超限删最旧（Map 迭代序＝插入序）。
 */
const STARTED_MAX_ENTRIES = 2000;

/**
 * 转义一个字段值：`"` 与 `\` 反斜杠转义，换行折叠为空格。
 * 审计是单行文本，换行会破坏「一行一条」的解析约定。
 * @param {unknown} value - 原始值。
 * @returns {string} 可安全放进 `"..."` 的文本。
 */
export function escapeField(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return text.replace(/[\r\n]+/gu, ' ').replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
}

/**
 * 归一化一个标量字段：空值显示为 `-`。
 * @param {unknown} value - 原始值。
 * @returns {string} 单 token 文本。
 */
function token(value) {
  if (value === undefined || value === null || value === '') return '-';
  return escapeField(value).replace(/\s+/gu, '_');
}

/**
 * 格式化一条审计行。
 * @param {object} fields - 字段集合（见 design §8.1）。
 * @param {{startedAt?: Map<string, number>, now?: number}} state - 计时状态。
 * @returns {{line: string, truncated: boolean}} 单行文本与是否发生截断。
 */
export function formatAuditLine(fields, state = {}) {
  const now = state.now ?? Date.now();
  let truncated = false;
  let reason = fields.reason === undefined || fields.reason === null ? '' : String(fields.reason);
  if (reason.length > REASON_MAX_CHARS) {
    reason = reason.slice(0, REASON_MAX_CHARS);
    truncated = true;
  }
  if (fields.truncated === true) truncated = true;

  const id = fields.id ?? '-';
  let ms = fields.ms;
  if (ms === undefined && id !== '-' && state.startedAt instanceof Map) {
    const started = state.startedAt.get(id);
    if (started !== undefined) ms = Math.max(0, now - started);
  }
  // `path` 与 `decision` 同源：decide 阶段不单独传 path 时取其决策值，便于按结果过滤。
  const path = fields.path ?? (fields.phase === 'decide' ? fields.decision : undefined);

  const line =
    `[approve-for-me] v=${AUDIT_VERSION}` +
    ` ts=${new Date(now).toISOString()}` +
    ` id=${token(id)}` +
    ` phase=${token(fields.phase)}` +
    ` callId=${token(fields.callId)}` +
    ` tool=${token(fields.tool)}` +
    ` cwd="${escapeField(fields.cwd ?? '-')}"` +
    ` mode=${token(fields.mode)}` +
    ` action=${token(fields.action)}` +
    ` path=${token(path)}` +
    ` source=${token(fields.source)}` +
    ` decision=${token(fields.decision)}` +
    ` inject=${fields.inject === 'yes' ? 'yes' : 'no'}` +
    ` injectBytes=${Number.isFinite(fields.injectBytes) ? fields.injectBytes : 0}` +
    ` withdraw=${token(fields.withdraw ?? 'skipped')}` +
    ` layer=${token(fields.layer)}` +
    ` model=${token(fields.model)}` +
    ` effort=${token(fields.effort ?? 'none')}` +
    ` finish=${token(fields.finish)}` +
    ` reasoningTokens=${Number.isFinite(fields.reasoningTokens) ? fields.reasoningTokens : '-'}` +
    ` fieldsDefaulted=${fields.fieldsDefaulted === true ? 'true' : 'false'}` +
    ` risk=${token(fields.risk)}` +
    ` auth=${token(fields.auth)}` +
    ` tools=${Number.isFinite(fields.tools) ? fields.tools : 0}` +
    ` reviewTimeout=${fields.reviewTimeout === 'disabled' ? 'disabled' : Number.isFinite(fields.reviewTimeout) ? fields.reviewTimeout : '-'}` +
    ` degraded=${token(fields.degraded ?? 'none')}` +
    ` ms=${Number.isFinite(ms) ? ms : '-'}` +
    ` late=${fields.late === 'yes' ? 'yes' : 'no'}` +
    ` truncated=${truncated ? 'true' : 'false'}` +
    ` reason="${escapeField(reason)}"`;
  return { line, truncated };
}

/**
 * 创建审计写入口。
 * @param {() => {enabled?: boolean, includePrompt?: boolean, includeRaw?: boolean, maxLineBytes?: number,
 *   redactPatterns?: string[]}} readConfig
 *   读取当前审计配置（设置可能被热改，故用 thunk 而非快照）；`redactPatterns` 由装配方并入
 *   （现读 `context.redactPatterns`，审计 reason 落笔前统一过脱敏）。
 * @param {{write?: (line: string) => void, now?: () => number}} [deps] - 测试注入点。
 * @returns {(fields: object) => void} 审计函数；写入失败不得影响审批主流程。
 */
export function createAudit(readConfig, deps = {}) {
  const write = deps.write ?? ((line) => process.stderr.write(`${line}\n`));
  const now = deps.now ?? (() => Date.now());
  const startedAt = new Map();

  return function audit(fields) {
    try {
      const cfg = readConfig?.() ?? {};
      if (cfg.enabled === false) return;
      if (fields.phase === 'prompt' && cfg.includePrompt !== true) return;
      if (fields.phase === 'raw' && cfg.includeRaw !== true) return;

      // reason 先遮后截——先脱敏再进 formatAuditLine（截断发生在 REASON_MAX_CHARS）；
      // 若先截后遮，跨界秘密的前半段可能不再匹配模式而漏出。
      const safeFields = Array.isArray(cfg.redactPatterns) && cfg.redactPatterns.length > 0
        && typeof fields.reason === 'string'
        ? { ...fields, reason: redactText(fields.reason, cfg.redactPatterns) }
        : fields;

      const id = safeFields.id;
      // 计时起点只登记接管型 screen 行；skip 行不登记（无 decide 跟随，只会滞留）。
      const tracking = safeFields.phase === 'screen' && safeFields.action !== 'skip';
      if (tracking && id !== undefined && id !== '-' && !startedAt.has(id)) {
        startedAt.set(id, now());
        if (startedAt.size > STARTED_MAX_ENTRIES) startedAt.delete(startedAt.keys().next().value);
      }
      const { line } = formatAuditLine(safeFields, { startedAt, now: now() });
      const maxLineBytes = Number.isFinite(cfg.maxLineBytes) ? cfg.maxLineBytes : DEFAULT_MAX_LINE_BYTES;
      let out = line;
      if (Buffer.byteLength(out, 'utf8') > maxLineBytes) {
        // 先去掉 reason，再压成只留身份与阶段的短行；短行仍超预算时按字节裁短。
        // 边界如实：预算小于短行长度时截断标志本身也会被裁掉（预算 1 只剩 `[`），
        // 截断痕迹不保证在任意小预算下幸存，只是常规预算下两级压缩都带 truncated=true。
        const { line: noReason } = formatAuditLine(
          { ...safeFields, reason: '', truncated: true, ms: undefined },
          { now: now() },
        );
        if (Buffer.byteLength(noReason, 'utf8') <= maxLineBytes) {
          out = noReason;
        } else {
          const compact = `[approve-for-me] v=${AUDIT_VERSION} ts=${new Date(now()).toISOString()} id=${token(id)} phase=${token(safeFields.phase)} truncated=true`;
          out = Buffer.byteLength(compact, 'utf8') <= maxLineBytes ? compact : compact.slice(0, maxLineBytes);
        }
      }
      write(out);
      // decide 是终态：一次请求恰一行，写出即回收计时起点（主回收路径；迟到 review 行的 ms 因此为 `-`）。
      if (safeFields.phase === 'decide' && id !== undefined) startedAt.delete(id);
    } catch {
      // 审计是旁路：它自己的失败不得改变审批结果（I2）。
    }
  };
}
