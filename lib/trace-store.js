/**
 * dsh-approve-for-me — 审查记录的存储与查询（design §8.3「数据层」）。
 *
 * 事实源是插件自有 JSONL：`~/.dsh/approve-for-me/reviews/<sessionId>.jsonl`，一行一条 JSON；
 * 内存只维护「回读窗口」（每会话最近 `maxRecords` 条）。不写会话事件：宿主的持久化读路径拒绝
 * 未标 `ignorable` 的未知事件类型，自造事件会让该会话在重启后读不出来（design §6.3／§8.3，不写会话事件）。
 *
 * 六个边界里属于本模块的部分（design §8.3 表，逐条落实）：
 * - 事实源：JSONL 唯一；`maxRecords` 是回读窗口，不是磁盘保留量——磁盘保留由按会话分片 +
 *   单文件行数上限（`maxRecords × 4`，超限重写只留窗口）控制。
 * - 重启可见性：首次访问某会话时从 JSONL 重放窗口；文件缺失按空处理；末行撕裂（写方被打断的
 *   短写残迹）跳过该行并审计一行、撕裂后的首次追加前补换行自愈，中部坏行只丢该行，都不抛错。
 * - `reviewId` 稳定：`${sessionId}:${callId ?? '-'}:${kind}:${approvalId}`（design §8.3）。
 *   `kind` 与审批实例 id 都进主键：审查记录与结算记录不互撞，同一审批同类记录只一条（去重键即 reviewId）。
 *   审批实例 id（approvalId）由 gate 在应答者入口生成（先于接管判定），任何产生记录的路径都持有。
 *   旧格式行（无 `kind` 与 `approvalId` 字段，第三段是审批事件序号或开始时刻）按字段缺失判定：
 *   读取路径按自身 reviewId 合成 approvalId、独立成行、不合并、不写回磁盘（design §8.3 旧格式行兼容）。
 * - 并发写：每会话一条串行写队列（Promise 链），同一时刻只有一个 append 在飞；跨进程只靠
 *   「打开-追加-关闭」的短写 + 单行 JSON，不做锁——乱序只影响顺序，不破坏行结构。
 * - 会话分叉归属：文件名＝会话 id，分叉会话读自己的（初始为空）文件，不做分叉继承。
 * - 清理与降级：行数超限重写留窗口；`reviews/` 文件数超 `maxSessions` 删最旧；读失败返回
 *   空列表并审计一行；写失败不抛给调用方（记录留在内存窗口，审批不回滚）并审计一行。
 *   **双实例共享同一目录不受支持**：轮转（整文件重写）只在「本进程是唯一写者」的前提下安全。
 * @module dsh-approve-for-me/trace-store
 */
import { appendFile, mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 单文件行数上限相对窗口的倍数（design §8.3「事实源」：`maxRecords × 4`）。 */
export const LINE_CAP_FACTOR = 4;

/** `capture` 缺省档（与 `ui.trace.capture` 的 schema 默认一致）。 */
export const DEFAULT_CAPTURE = 'summary';

/** 每会话回读窗口缺省大小（与 `ui.trace.maxRecords` 的默认一致）。 */
export const DEFAULT_MAX_RECORDS = 200;

/** `full` 档单字段字节上限缺省值（与 `ui.trace.maxBytes` 的默认一致）。 */
export const DEFAULT_MAX_BYTES = 8192;

/** `reviews/` 下会话文件数缺省上限。 */
export const DEFAULT_MAX_SESSIONS = 50;

/** 摘要字段（design §8.2 摘要字段词汇表）：产品字段白名单，不依赖 `capture`，恒落盘。
 *  存储行另含存储内部字段（行主键 reviewId、会话键、落盘时刻 recordedAt），不进产品投影。 */
const SUMMARY_FIELDS = Object.freeze([
  'kind',
  'approvalId',
  'callId',
  'toolName',
  'origin',
  'escalation',
  'preset',
  'startedAt',
  'endedAt',
  'queueMs',
  'reviewMs',
  'humanWaitMs',
  'decision',
  'outcome',
  'source',
  'stage',
  'model',
  'effort',
  'layer',
  'tokens',
  'attempts',
  'reason',
  'risk',
  'auth',
  'fieldsDefaulted',
  'subject',
  'evidence',
  'probes',
  'tools',
  'capture',
  'degraded',
  'configTag',
  'policyTag',
  'truncated',
]);

/** 详情字段：仅 `capture=full` 落盘（先脱敏、再按 `maxBytes` 截断）。 */
const DETAIL_FIELDS = Object.freeze(['prompt', 'input', 'reasoning', 'output']);

/**
 * 归一化会话 id：去掉单层 `session-` 前缀，`session-<uuid>` 与 `<uuid>` 指向同一文件
 * （客户端带前缀、宿主不带，与 `lib/session-store.js` 同一套归一化）。
 * @param {unknown} sessionId - 会话 id。
 * @returns {string | undefined} 文件键；空值返回 `undefined`。
 */
function keyOf(sessionId) {
  if (typeof sessionId !== 'string') return undefined;
  const text = sessionId.trim();
  if (text.length === 0) return undefined;
  const prefix = 'session-';
  return text.startsWith(prefix) && text.length > prefix.length ? text.slice(prefix.length) : text;
}

/**
 * 组装 reviewId：`${sessionId}:${callId ?? '-'}:${kind}:${approvalId}`（design §8.3 存储行主键）。
 * `kind` 进键让审查记录（`review`）与结算记录（`settle`）不互撞；`approvalId` 进键保证同一审批
 * 同类记录只一条（去重键即 reviewId）。`approvalId` 缺失时回退 `startedAt`（毫秒数字串），
 * 只出现在未接线的旧路径上。
 * @param {string} sessionId - 会话 id（归一化后，作文件键与 id 首段）。
 * @param {string | null | undefined} callId - 工具调用 id；缺失用 `-`。
 * @param {string} kind - 存储行类别（`review` / `settle`）。
 * @param {string | number | null | undefined} approvalId - 审批实例 id；缺失回退 `startedAt`。
 * @param {number} [startedAt] - `approvalId` 缺失时的回退键（整数毫秒）。
 * @returns {string} reviewId。
 */
export function reviewIdOf(sessionId, callId, kind, approvalId, startedAt = 0) {
  const call = typeof callId === 'string' && callId.length > 0 ? callId : '-';
  const tail =
    approvalId !== undefined && approvalId !== null && approvalId !== '' ? String(approvalId) : String(startedAt);
  return `${sessionId}:${call}:${kind}:${tail}`;
}

/**
 * 判定一行是否旧格式并合成其审批实例 id（design §8.3 旧格式行兼容）：按**字段缺失**判定
 * （无 `kind` 与 `approvalId` 即旧格式，不按 reviewId 的段数或第三段含义识别——旧记录的
 * 第三段可能是审批事件序号，也可能是开始时刻）。合成 `approvalId` 取该行自身 `reviewId`
 * 全文，仅读取时使用、不落盘。
 * @param {object} row - 存储行。
 * @returns {boolean} 是否旧格式行。
 */
function isLegacyRow(row) {
  return row?.kind === undefined && row?.approvalId === undefined;
}

/**
 * 按字节上限截断文本：超限时切到不破坏多字节字符的边界并置 `truncated`。
 * @param {string} text - 原文（已脱敏）。
 * @param {number} maxBytes - 字节上限。
 * @returns {{text: string, truncated: boolean}} 截断结果。
 */
function clampText(text, maxBytes) {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let end = Math.min(maxBytes, bytes.length);
  // 退过 UTF-8 后续字节（10xxxxxx）直到落在字符边界，避免末尾产生替换字符。
  while (end > 0 && (bytes[end - 1] & 0xc0) === 0x80) end -= 1;
  if (end > 0) {
    const lead = bytes[end - 1];
    const width = (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf8) === 0xf0 ? 4 : 1;
    // 首字节在界内但整字符越界的，整字符放弃，宁可少一个字符也不输出残字。
    if (width > 1 && end - 1 + width > maxBytes) end -= 1;
  }
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true };
}

/**
 * 创建审查记录存储。
 *
 * `record` 返回的 Promise 永不 reject：写失败按「记录留在内存 + 一行降级审计」处理，
 * 调用方（审批主流程）不感知存储问题。
 * @param {object} [options] - 选项。
 * @param {string} [options.dir] - JSONL 根目录；缺省 `~/.dsh/approve-for-me/reviews`（测试注入临时目录）。
 * @param {'off' | 'summary' | 'full'} [options.capture] - 采集档；`off`/`summary` 只落摘要字段，`full` 另落详情全文。
 * @param {number} [options.maxRecords] - 每会话回读窗口大小，默认 200；磁盘行数上限＝它 × 4。
 * @param {number} [options.maxBytes] - `full` 档单字段字节上限，超出截断并置 `truncated`。
 * @param {number} [options.maxSessions] - `reviews/` 下会话文件数上限，超限删最旧，默认 50。
 * @param {(text: string) => string} [options.redact] - 详情字段的脱敏函数（截断前套用）。
 * @param {() => number} [options.now] - 时间源（毫秒），默认 `Date.now`。
 * @param {(fields: {phase: string, action: string, source: string, degraded: string, sessionId?: string, reviewId?: string, reason: string}) => void} [options.onDegrade]
 *   - 降级回调（一行审计）；`degraded` 取 `read-failed` | `torn-line` | `file-store-failed`。
 * @returns {{record: (entry: object) => Promise<boolean>, list: (sessionId: string) => object[], approval: (sessionId: string, approvalId: string) => ({review?: object, settle?: object, legacy?: object} | null), degraded: (sessionId: string) => boolean, flush: () => Promise<void>}} 存储实例。
 */
export function createTraceStore({
  dir,
  capture = DEFAULT_CAPTURE,
  maxRecords = DEFAULT_MAX_RECORDS,
  maxBytes = DEFAULT_MAX_BYTES,
  maxSessions = DEFAULT_MAX_SESSIONS,
  redact,
  now = Date.now,
  onDegrade,
} = {}) {
  const root = typeof dir === 'string' && dir.length > 0 ? dir : join(homedir(), '.dsh', 'approve-for-me', 'reviews');
  const full = capture === 'full';
  const limit = Number.isFinite(maxRecords) && maxRecords > 0 ? Math.floor(maxRecords) : DEFAULT_MAX_RECORDS;
  const byteLimit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_MAX_BYTES;
  const sessionLimit =
    Number.isFinite(maxSessions) && maxSessions > 0 ? Math.floor(maxSessions) : DEFAULT_MAX_SESSIONS;
  const lineCap = limit * LINE_CAP_FACTOR;

  /** 会话键 → 窗口记录数组（旧在前）；内存环只是 JSONL 的回读窗口。 */
  const windows = new Map();
  /** 会话键 → 文件当前行数；重写成功后回落到窗口大小。 */
  const lineCounts = new Map();
  /** 已完成首次重放的会话键；读失败也标记，避免每次查询都重复失败与审计。 */
  const loadedKeys = new Set();
  /** 重放时发现末行撕裂的会话键；下次追加前先补一个换行，避免新记录粘进残行。 */
  const tornTails = new Set();
  /**
   * 读取处于降级的会话键（design §8.3）：重放时读失败或末行撕裂即置位——窗口可能不完整，
   * 页面据此提示「列表可能不完整」；整文件重写成功（撕裂残迹一并消掉）后清除。文件缺失是
   * 合法的「没有历史」，不置位。
   */
  const readFailed = new Set();
  /** 会话键 → 写队列尾；同一会话同一时刻只有一个 append 在飞。 */
  const queues = new Map();
  /** 建目录的可复用 Promise；失败不缓存，下次写入重试。 */
  let dirReady;

  /**
   * 写一行降级审计；回调自身异常不得牵连存储主流程。
   * @param {string} degraded - 降级类别。
   * @param {string | undefined} sessionId - 会话键（可缺）。
   * @param {string | undefined} reviewId - 相关记录（可缺）。
   * @param {unknown} reason - 失败原因。
   * @returns {void}
   */
  function degrade(degraded, sessionId, reviewId, reason) {
    try {
      onDegrade?.({
        phase: 'trace',
        action: 'skip',
        source: 'trace',
        degraded,
        sessionId,
        reviewId,
        reason: String(reason?.message ?? reason ?? ''),
      });
    } catch {
      // 降级回调失败＝审计通道失败，没有下一级承接，只能吞掉。
    }
  }

  /**
   * 首次访问某会话时从 JSONL 重放窗口（重启可见性）。
   * 文件缺失＝没有历史（合法）；读失败按空窗口降级；末行撕裂跳过并审计。
   * @param {string} key - 会话键。
   * @returns {void}
   */
  function ensureLoaded(key) {
    if (loadedKeys.has(key)) return;
    loadedKeys.add(key);
    let text;
    try {
      text = readFileSync(join(root, `${key}.jsonl`), 'utf8');
    } catch (error) {
      // 文件缺失＝没有历史（合法）；读失败按空窗口降级并标记读取降级。
      if (error?.code !== 'ENOENT') {
        readFailed.add(key);
        degrade('read-failed', key, undefined, error);
      }
      return;
    }
    const lines = text.split('\n');
    let lastNonEmpty = -1;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i].trim().length > 0) {
        lastNonEmpty = i;
        break;
      }
    }
    const window = [];
    let count = 0;
    for (let i = 0; i <= lastNonEmpty; i += 1) {
      const line = lines[i];
      if (line.trim().length === 0) continue;
      count += 1;
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        // 只有末行按撕裂处理（跨进程短写被打断的残迹）；中部坏行是既成损坏，丢该行不丢整个文件。
        if (i === lastNonEmpty) {
          readFailed.add(key);
          degrade('torn-line', key, undefined, line.slice(0, 64));
          tornTails.add(key);
        }
        continue;
      }
      if (value === null || typeof value !== 'object' || typeof value.reviewId !== 'string') continue;
      window.push(value);
      if (window.length > limit) window.shift();
    }
    windows.set(key, window);
    lineCounts.set(key, count);
  }

  /**
   * 建根目录（懒建，成功后复用）；失败时清缓存让下次写入重试。
   * @returns {Promise<void>} 完成或拒绝。
   */
  function ensureDir() {
    if (dirReady === undefined) {
      dirReady = mkdir(root, { recursive: true }).catch((error) => {
        dirReady = undefined;
        throw error;
      });
    }
    return dirReady;
  }

  /**
   * 按 `capture` 档裁剪一条待落盘记录：摘要字段（产品字段白名单＝design §8.2 词汇表）恒留；
   * `full` 档另落脱敏 + 截断后的详情。记录自带的 `truncated`（生产侧摘要裁剪已置真）并入场级标记。
   * @param {string} key - 会话键。
   * @param {object} entry - 调用方给的原始字段。
   * @param {string} reviewId - 组装好的 reviewId。
   * @returns {object} 待落盘记录。
   */
  function shapeRecord(key, entry, reviewId) {
    const shaped = { reviewId, truncated: entry?.truncated === true };
    for (const field of SUMMARY_FIELDS) {
      if (field === 'truncated') continue;
      if (entry[field] !== undefined) shaped[field] = entry[field];
    }
    if (shaped.startedAt === undefined) shaped.startedAt = now();
    if (full) {
      for (const field of DETAIL_FIELDS) {
        const value = entry[field];
        if (value === undefined || value === null) continue;
        let text = String(value);
        if (typeof redact === 'function') text = redact(text);
        const clamped = clampText(text, byteLimit);
        if (clamped.truncated) shaped.truncated = true;
        shaped[field] = clamped.text;
      }
    }
    shaped.recordedAt = now();
    shaped.sessionId = key;
    return shaped;
  }

  /**
   * 行数超限后整文件重写、只留窗口（磁盘保留边界）。只在「本进程是唯一写者」的前提下安全
   * （模块头：双实例共享同一目录不受支持）；失败保留原文件，行数仍超限，下次写入重试。
   * @param {string} key - 会话键。
   * @param {object[]} window - 窗口记录。
   * @returns {Promise<boolean>} 是否重写成功。
   */
  async function rewrite(key, window) {
    try {
      const body = window.map((row) => JSON.stringify(row)).join('\n');
      await writeFile(join(root, `${key}.jsonl`), body.length === 0 ? '' : `${body}\n`, 'utf8');
      lineCounts.set(key, window.length);
      tornTails.delete(key); // 重写只落窗口内已解析的行，撕裂残迹一并消掉。
      readFailed.delete(key); // 重写成功＝文件内容回到已知完整状态，读取降级解除。
      return true;
    } catch (error) {
      degrade('file-store-failed', key, undefined, error);
      return false;
    }
  }

  /**
   * `reviews/` 文件数超限删最旧（按 mtime，同名序补时间戳粒度）。
   * 只在新建会话文件后跑：既有的文件数只会因新文件而增长。
   * @param {string} key - 触发清理的会话键。
   * @returns {Promise<void>}
   */
  async function sweep(key) {
    let names;
    try {
      names = (await readdir(root)).filter((name) => name.endsWith('.jsonl'));
    } catch {
      return; // 目录读不到（还没建）＝没有可清理的。
    }
    if (names.length <= sessionLimit) return;
    const stamped = [];
    for (const name of names) {
      try {
        const info = await stat(join(root, name));
        stamped.push({ name, mtimeMs: info.mtimeMs });
      } catch {
        // stat 失败的文件不参与本次排序。
      }
    }
    if (stamped.length <= sessionLimit) return;
    stamped.sort((left, right) => left.mtimeMs - right.mtimeMs || (left.name < right.name ? -1 : 1));
    // NTFS 同毫秒批次（时间戳粒度＝时钟中断间隔）里 mtime 会相等，名字序补齐可能把「刚建的新文件」
    // 排成最旧——触发本次清扫的 key 刚落第一行，定义上是最新文件，不参与删除候选。
    const victims = stamped.filter((item) => item.name !== `${key}.jsonl`);
    let failure;
    for (const item of victims.slice(0, stamped.length - sessionLimit)) {
      try {
        await unlink(join(root, item.name));
      } catch (error) {
        failure = error;
      }
    }
    if (failure !== undefined) degrade('file-store-failed', key, undefined, failure);
  }

  /**
   * 队列任务体：重放 → 去重 → 落一条 JSONL 行 → 维护窗口、行数、清理。
   * @param {string} key - 会话键。
   * @param {object} entry - 原始字段。
   * @returns {Promise<boolean>} 是否真的追加了（去重或失败为 `false`）。
   */
  async function appendOne(key, entry) {
    ensureLoaded(key);
    const window = windows.get(key) ?? [];
    windows.set(key, window);
    const startedAt = Number.isFinite(entry?.startedAt) ? entry.startedAt : now();
    // 存储行主键（design §8.3）：kind 与 approvalId 都进键——审查记录与结算记录不互撞、同类只一条。
    const kind = entry?.kind === 'settle' ? 'settle' : 'review';
    const reviewId = reviewIdOf(key, entry?.callId, kind, entry?.approvalId, startedAt);
    if (window.some((row) => row.reviewId === reviewId)) return false; // 同一 reviewId 不重复追加
    const shaped = shapeRecord(key, entry ?? {}, reviewId);
    try {
      await ensureDir();
      // 「打开-追加-关闭」的短写 + 单行 JSON：跨进程乱序只影响顺序，不破坏行结构（不做锁）。
      // 上次重放发现末行撕裂时先补换行自愈，保证本条独占一行。
      const heal = tornTails.has(key) ? '\n' : '';
      await appendFile(join(root, `${key}.jsonl`), `${heal}${JSON.stringify(shaped)}\n`, 'utf8');
      tornTails.delete(key);
    } catch (error) {
      // 写失败不回滚已完成的审批：记录留在内存窗口（重启即丢），只审计一行。
      window.push(shaped);
      if (window.length > limit) window.shift();
      degrade('file-store-failed', key, reviewId, error);
      return false;
    }
    window.push(shaped);
    if (window.length > limit) window.shift();
    const lines = (lineCounts.get(key) ?? 0) + 1;
    lineCounts.set(key, lines);
    if (lines > lineCap) await rewrite(key, window);
    if (lines === 1) await sweep(key); // 首行＝新文件刚建，这是文件数唯一会增长的时机
    sweepMemory(); // 内存侧会话键数对齐磁盘侧
    return true;
  }

  /**
   * 内存侧会话键数对齐磁盘侧 `maxSessions`（design §8.3）：windows/lineCounts/loadedKeys
   * 同步淘汰最旧会话键（Map/Set 迭代序＝插入序）；`queues` 中仍有在飞写入的键本轮跳过、留待下轮。
   * tornTails 不在清扫范围：它有重写与补换行两条自愈清理。被淘汰的键下次访问会经
   * `ensureLoaded` 从 JSONL 惰性重放，正确性不受影响（内存环只是回读窗口）。
   * @returns {void}
   */
  function sweepMemory() {
    if (loadedKeys.size <= sessionLimit) return;
    for (const key of loadedKeys) {
      if (loadedKeys.size <= sessionLimit) break;
      if (queues.has(key)) continue;
      loadedKeys.delete(key);
      windows.delete(key);
      lineCounts.delete(key);
    }
  }

  return {
    /**
     * 落一条审查或结算记录（每会话串行）。
     * @param {object} entry - 记录字段：`sessionId` 必填；`kind`（`review`/`settle`，缺省按 `review`）
     *   与 `approvalId` 组成去重键；摘要字段与（`full` 档）`prompt`/`input`/`reasoning`/`output`
     *   按存在取用。
     * @returns {Promise<boolean>} 是否追加了新行；重复 `reviewId`、参数非法或写失败为 `false`（永不 reject）。
     */
    record(entry) {
      const key = keyOf(entry?.sessionId);
      if (key === undefined) return Promise.resolve(false);
      const task = (queues.get(key) ?? Promise.resolve())
        .then(() => appendOne(key, entry))
        .catch(() => false) // 任务体内部已自承接，这里只防队列链断裂。
        .finally(() => {
          // 队列尾落定即摘除（仍是尾才删，避免误删后续任务）：queues 因此与在飞写一一对应，
          // sweepMemory 据此识别「在飞写入的键本轮不淘汰」。
          if (queues.get(key) === task) queues.delete(key);
        });
      queues.set(key, task);
      return task;
    },

    /**
     * 列出某会话窗口内的存储行（旧在前）。旧格式行（无 `kind` 与 `approvalId`）按 design §8.3 在副本上
     * 合成 `approvalId`（取该行自身 `reviewId` 全文），独立成行、不合并、不写回磁盘。
     * @param {string} sessionId - 会话 id（带或不带 `session-` 前缀）。
     * @returns {object[]} 记录副本数组；无文件或读失败时为空。
     */
    list(sessionId) {
      const key = keyOf(sessionId);
      if (key === undefined) return [];
      ensureLoaded(key);
      return (windows.get(key) ?? []).map((row) =>
        isLegacyRow(row) ? { ...row, approvalId: row.reviewId } : { ...row },
      );
    },

    /**
     * 按审批实例 id 取该审批两类记录的原始行（design §8.3/§8.5：详情端点按 `approvalId` 返回合并详情，
     * 不按存储行主键单查）。旧格式行的合成 `approvalId` 与查询口径一致。
     * @param {string} sessionId - 会话 id。
     * @param {string} approvalId - 审批实例 id（旧格式行为其自身 `reviewId` 全文）。
     * @returns {{review?: object, settle?: object, legacy?: object} | null} 两类记录的原始行副本；
     *   旧格式行以 `legacy` 返回；窗口内找不到时 `null`。
     */
    approval(sessionId, approvalId) {
      const key = keyOf(sessionId);
      if (key === undefined || typeof approvalId !== 'string' || approvalId.length === 0) return null;
      ensureLoaded(key);
      const result = {};
      for (const row of windows.get(key) ?? []) {
        if (isLegacyRow(row)) {
          if (row.reviewId === approvalId) result.legacy = { ...row, approvalId: row.reviewId };
          continue;
        }
        if (row.approvalId === approvalId) {
          if (row.kind === 'settle') result.settle = { ...row };
          else result.review = { ...row };
        }
      }
      return Object.keys(result).length > 0 ? result : null;
    },

    /**
     * 某会话的记录读取是否处于降级：读失败或末行撕裂即真（窗口可能不完整）；
     * 文件缺失（没有历史）与正常读取为假。
     * @param {string} sessionId - 会话 id。
     * @returns {boolean} 是否降级。
     */
    degraded(sessionId) {
      const key = keyOf(sessionId);
      if (key === undefined) return false;
      ensureLoaded(key);
      return readFailed.has(key);
    },

    /**
     * 等全部在飞的写任务落定（测试与收尾用）。
     * @returns {Promise<void>} 完成即止；队列永不 reject。
     */
    async flush() {
      await Promise.all([...queues.values()]);
    },
  };
}

export default createTraceStore;
