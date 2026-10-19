/**
 * dsh-approve-for-me — 会话级选择的文件载体（design §6.3）。
 *
 * 会话级选择存在 `$DSH_HOME/approve-for-me/session-models.json`，不写会话日志：
 * 宿主持久化读路径拒绝日志里的未知事件类型（`dsh-session-persistence/lib/index.js:184`，
 * 除非 `ignorable: true`），写入事件会让该会话在重启后无法恢复（design §6.3／§8.5，不写会话事件）。
 * 本模块只管存储：读不到按空表处理，写失败返回 `false`，任何 IO 异常都不外抛。
 * @module dsh-approve-for-me/session-store
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 读缓存的存活时间（毫秒）；写入成功后缓存立即刷新，读一致不依赖它。 */
export const READ_TTL_MS = 1000;

/** 条目上限的默认值（design §6.3）。 */
export const MAX_ENTRIES = 200;

/**
 * 归一化会话 id：去掉单层 `session-` 前缀，`session-<uuid>` 与 `<uuid>` 两种形态指向同一条目（design §6.3）。
 * @param {unknown} sessionId - 会话 id。
 * @returns {string | undefined} 归一化后的键；空值返回 `undefined`。
 */
function keyOf(sessionId) {
  if (typeof sessionId !== 'string') return undefined;
  const text = sessionId.trim();
  if (text.length === 0) return undefined;
  const prefix = 'session-';
  return text.startsWith(prefix) && text.length > prefix.length ? text.slice(prefix.length) : text;
}

/**
 * 校验并归一化一个条目；非法条目返回 `undefined`（读取时跳过）。
 * @param {unknown} value - 文件里的条目值。
 * @returns {{model: string | null, effort: string, updatedAt: number} | undefined} 条目。
 */
function entryOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const model =
    value.model === null
      ? null
      : typeof value.model === 'string' && value.model.trim().length > 0
        ? value.model.trim()
        : undefined;
  if (model === undefined) return undefined;
  return {
    model,
    effort: typeof value.effort === 'string' ? value.effort.trim() : '',
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  };
}

/**
 * 解析文件文本；版本或结构不合法退化为空表，非法条目逐个跳过、不牵连合法项（design §6.3）。
 * @param {string} text - 文件内容。
 * @returns {Record<string, {model: string | null, effort: string, updatedAt: number}>} 条目表。
 */
function parseTable(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  if (parsed.version !== 1) return {};
  const raw = parsed.entries;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const entries = {};
  for (const [key, value] of Object.entries(raw)) {
    const entry = entryOf(value);
    if (entry !== undefined) entries[key] = entry;
  }
  return entries;
}

/**
 * 创建会话级选择的文件载体。
 * @param {object} options - 选项。
 * @param {string} options.file - 载体文件路径。
 * @param {number} [options.max] - 条目上限，默认 200。
 * @param {() => number} [options.now] - 时间源（毫秒），默认 `Date.now`。
 * @returns {object} 存储实例：`read` / `write` / `clear` / `all`。
 */
export function createSessionStore({ file, max = MAX_ENTRIES, now = Date.now } = {}) {
  const path = typeof file === 'string' && file.length > 0 ? file : undefined;
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : MAX_ENTRIES;
  let cache;

  /**
   * 读条目表；`READ_TTL_MS` 内复用缓存，读失败按空表。
   * @returns {Record<string, object>} 条目表。
   */
  function entriesNow() {
    if (path === undefined) return {};
    const at = now();
    if (cache !== undefined && at - cache.at < READ_TTL_MS) return cache.entries;
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      cache = { at, entries: {} };
      return cache.entries;
    }
    cache = { at, entries: parseTable(text) };
    return cache.entries;
  }

  /**
   * 临时文件 + rename 原子替换；失败保留旧文件并返回 `false`。
   * @param {Record<string, object>} entries - 完整条目表。
   * @returns {boolean} 是否写入成功。
   */
  function persist(entries) {
    if (path === undefined) return false;
    const temporary = `${path}.tmp`;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(temporary, JSON.stringify({ version: 1, entries }), 'utf8');
      renameSync(temporary, path);
      return true;
    } catch {
      try {
        rmSync(temporary, { force: true });
      } catch {
        // 临时文件可能不存在，或被同名目录占位；清理失败不影响返回值。
      }
      return false;
    }
  }

  /**
   * 超出上限时按 `updatedAt` 升序回收最旧条目（design §6.3）。
   * @param {Record<string, object>} entries - 待写入的条目表（就地修改）。
   * @returns {void}
   */
  function prune(entries) {
    const keys = Object.keys(entries);
    if (keys.length <= limit) return;
    keys.sort((left, right) => entries[left].updatedAt - entries[right].updatedAt);
    for (const key of keys.slice(0, keys.length - limit)) delete entries[key];
  }

  return {
    /**
     * 读会话级选择。
     * @param {string} sessionId - 会话 id。
     * @returns {{model: string | null, effort: string} | undefined} 条目副本；没有条目时 `undefined`。
     */
    read(sessionId) {
      const key = keyOf(sessionId);
      if (key === undefined || path === undefined) return undefined;
      const entry = entriesNow()[key];
      return entry === undefined ? undefined : { model: entry.model, effort: entry.effort };
    },

    /**
     * 写会话级选择；`model` 为 `null` 写清除条目（含义「跟随全局」）。
     * @param {string} sessionId - 会话 id。
     * @param {string | null} model - 模型引用；`null` 表示清除。
     * @param {string} [effort] - 档位；空串＝自动档位（模型支持 low 时选 low，否则不传档位）。
     * @returns {boolean} 是否落盘成功。
     */
    write(sessionId, model, effort = '') {
      const key = keyOf(sessionId);
      if (key === undefined || path === undefined) return false;
      if (model !== null && (typeof model !== 'string' || model.trim().length === 0)) return false;
      const entries = { ...entriesNow() };
      entries[key] = {
        model: model === null ? null : model.trim(),
        effort: typeof effort === 'string' ? effort.trim() : '',
        updatedAt: now(),
      };
      prune(entries);
      if (persist(entries) !== true) return false;
      cache = { at: now(), entries };
      return true;
    },

    /**
     * 删除条目并落盘（维护与测试用；用户可见的「跟随全局」走 `write(id, null)`）。
     * @param {string} sessionId - 会话 id。
     * @returns {boolean} 是否成功；条目本就不存在也返回 `true`。
     */
    clear(sessionId) {
      const key = keyOf(sessionId);
      if (key === undefined || path === undefined) return false;
      const entries = { ...entriesNow() };
      const existed = Object.hasOwn(entries, key);
      if (existed) delete entries[key];
      if (existed && persist(entries) !== true) return false;
      cache = { at: now(), entries };
      return true;
    },

    /**
     * 返回条目表副本（测试用）。
     * @returns {Record<string, {model: string | null, effort: string, updatedAt: number}>} 条目表。
     */
    all() {
      if (path === undefined) return {};
      const entries = entriesNow();
      return Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, { ...entry }]));
    },
  };
}
