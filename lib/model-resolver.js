/**
 * dsh-approve-for-me — 审查模型解析（两级 + 一条规则回退 + 缓存）。
 *
 * 覆盖顺序（先命中先用，R2，设计「两级解析顺序（R2）」/设计「解析顺序」）：
 *   1 `session`       会话级显式选择（会话事件 `approve-for-me/reviewer-model`）；
 *   2 `parent-map`    全局级·按主模型映射 `reviewer.byParentModel[主模型]`；
 *   3 `global`        全局级·默认 `reviewer.model`；
 *   4 `follow-parent` 规则回退层：`reviewer.followParent` 为真时跟随父 agent 当前模型。
 * 每层给出的 `provider/model` 都要过 `listProviders()` 与 `resolveModelInfo()` 校验，失败降级到下一层并留审计。
 * 全部失败时返回 `layer='unavailable'`，由上层按 `fallback` 处置（默认直接拒绝），绥不静默放行。
 * @module dsh-approve-for-me/model-resolver
 */

/** 缓存条目上限；超出按 LRU 淘汰。 */
export const CACHE_MAX_ENTRIES = 64;

/** 解析层名称，与审计 `layer=` 字段取值一致。 */
export const LAYERS = Object.freeze(['session', 'parent-map', 'global', 'follow-parent', 'unavailable']);

/**
 * 折叠会话里的最后一个 `model/selection` 事件，得到父 agent 当前模型。
 * @param {{snapshotEvents?: () => readonly object[]} | undefined} session - 发起会话。
 * @returns {{provider: string, model: string} | undefined} 父模型；事件缺失返回 `undefined`。
 */
export function parentModelOf(session) {
  if (session === undefined || typeof session.snapshotEvents !== 'function') return undefined;
  let events;
  try {
    events = session.snapshotEvents();
  } catch {
    return undefined;
  }
  if (!Array.isArray(events)) return undefined;
  let fromHeader;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'model/selection') {
      const data = event.data;
      if (typeof data?.provider === 'string' && typeof data?.model === 'string') {
        return { provider: data.provider, model: data.model };
      }
      continue;
    }
    // 未显式切换模型的会话没有 `model/selection`；请求头里的路由就是当前模型。
    if (fromHeader === undefined && event?.type === 'request/header') {
      const config = event.data?.header?.config;
      if (typeof config?.provider === 'string' && typeof config?.model === 'string') {
        fromHeader = { provider: config.provider, model: config.model };
      }
    }
  }
  return fromHeader;
}

/**
 * 解析 `provider/model` 形式的候选值。
 * 不含 `/` 的值与 `fallbackProvider` 组合；两者都没有则视为不可用。
 * @param {unknown} value - 配置里的候选值。
 * @param {string | undefined} fallbackProvider - 缺省 provider（父模型或首个已注册 provider）。
 * @returns {{provider: string, model: string} | undefined} 候选路由。
 */
export function parseModelRef(value, fallbackProvider) {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const text = value.trim();
  const slash = text.indexOf('/');
  if (slash > 0 && slash < text.length - 1) return { provider: text.slice(0, slash), model: text.slice(slash + 1) };
  if (fallbackProvider === undefined || fallbackProvider.length === 0) return undefined;
  return { provider: fallbackProvider, model: text };
}

/**
 * 归一化一个审查模型选择（旧字符串写法与 `{ model, effort }` 对象都接受）。
 * @param {unknown} value - 配置值。
 * @returns {{model: string, effort: string} | undefined} 归一化结果；空值时 `undefined`。
 */
export function normalizeModelChoice(value) {
  if (typeof value === 'string') {
    const model = value.trim();
    return model.length === 0 ? undefined : { model, effort: '' };
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const model = typeof value.model === 'string' ? value.model.trim() : '';
    const effort = typeof value.effort === 'string' ? value.effort.trim() : '';
    if (model.length === 0) return undefined;
    return { model, effort };
  }
  return undefined;
}

/**
 * 计算本次审查实际要用的推理档位（档位缺省语义与 codex 一致）：
 * 显式指定且模型支持 → 用它；显式不支持 → 不传并留降级痕迹；未指定 → 支持 `low` 就用 `low`，
 * 否则不传（由模型自己的默认档决定）。
 * @param {readonly {id?: string}[]} efforts - `resolveModelInfo()` 给出的可选档位。
 * @param {string | undefined} explicit - 显式选择的档位。
 * @returns {{effort: string, degraded: boolean}} `effort='none'` 表示不传。
 */
export function pickEffort(efforts, explicit) {
  const list = Array.isArray(efforts) ? efforts : [];
  const supports = (id) => list.some((entry) => entry?.id === id);
  if (typeof explicit === 'string' && explicit.length > 0) {
    return supports(explicit) ? { effort: explicit, degraded: false } : { effort: 'none', degraded: true };
  }
  return { effort: supports('low') ? 'low' : 'none', degraded: false };
}

/**
 * 按主模型查映射：先按纯模型 id（写入形态），未命中再按 `provider/model` 全引用回退（手输的旧键）。
 * @param {Record<string, unknown> | undefined} table - `reviewer.byParentModel`。
 * @param {string} modelId - 主模型的 id。
 * @returns {{model: string, effort: string} | undefined} 归一化后的选择。
 */
export function lookupByParentModel(table, modelId) {
  if (table === null || typeof table !== 'object' || typeof modelId !== 'string' || modelId.length === 0) return undefined;
  const direct = normalizeModelChoice(table[modelId]);
  if (direct !== undefined) return direct;
  for (const [key, value] of Object.entries(table)) {
    if (key === '/' ) continue;
    const slash = key.lastIndexOf('/');
    if (slash <= 0) continue;
    if (key.slice(slash + 1) === modelId) {
      const hit = normalizeModelChoice(value);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/**
 * 创建模型解析器。
 * @param {object} deps - 宿主注入点。
 * @param {{listProviders: () => {id: string}[], resolveModelInfo: (provider: string, model: string) => Promise<object>}} deps.llm
 *   - `ctx.llm`。
 * @param {() => {revision?: number, base?: object, user?: object, value?: object} | undefined} deps.settingsSnapshot
 *   - 读取 `approve-for-me` 命名空间的分层快照。
 * @param {(session: object | undefined) => {kind: string, model?: string} | undefined} [deps.sessionModelOf]
 *   - 读取会话级选择（`lib/session-model.js`）。
 * @param {(fields: object) => void} [deps.audit] - 审计入口。
 * @returns {{configFor: (request: object) => Promise<object>, invalidate: () => void, cacheSize: () => number}}
 *   解析器；`configFor` 只在设置服务读取异常时抛出。
 */
export function createResolver(deps) {
  const { llm, settingsSnapshot, sessionModelOf = () => undefined, audit = () => {} } = deps;
  const cache = new Map();

  /**
   * 清空缓存；设置变更、适配器更新或父模型变化后调用。
   * @returns {void}
   */
  function invalidate() {
    cache.clear();
  }

  /**
   * 校验一个候选路由，并确认期望的推理档位是否受支持。
   * @param {{provider: string, model: string}} candidate - 候选。
   * @param {string | undefined} explicit - 该层显式指定的推理档位。
   * @returns {Promise<{ok: true, effort: string, degraded: boolean} | {ok: false, reason: string}>} 校验结果。
   */
  async function validate(candidate, explicit) {
    const providers = llm.listProviders?.() ?? [];
    if (!providers.some((entry) => entry?.id === candidate.provider)) {
      return { ok: false, reason: `unknown provider ${candidate.provider}` };
    }
    try {
      const info = await llm.resolveModelInfo(candidate.provider, candidate.model);
      const picked = pickEffort(info?.reasoning?.efforts ?? [], explicit);
      return { ok: true, effort: picked.effort, degraded: picked.degraded };
    } catch (error) {
      return { ok: false, reason: `resolveModelInfo failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * 按两级 + 一条规则回退解析一次请求的生效配置。
   * @param {{agent?: {session?: object}}} request - 审批请求。
   * @returns {Promise<object>} 生效配置，附 `resolution` 字段。
   */
  async function configFor(request) {
    const snapshot = settingsSnapshot() ?? {};
    const value = snapshot.value ?? {};
    const user = snapshot.user ?? {};
    const base = snapshot.base ?? {};
    const session = request?.agent?.session;
    const parent = parentModelOf(session);
    const sessionChoice = sessionModelOf(session);
    const sessionRef = sessionChoice?.kind === 'set' ? sessionChoice.model : undefined;
    const key = `${snapshot.revision ?? 0}|${sessionRef ?? '-'}|${sessionChoice?.effort ?? '-'}|${parent?.provider ?? '-'}|${parent?.model ?? '-'}`;

    const cached = cache.get(key);
    if (cached !== undefined) {
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }

    const fallbackProvider = parent?.provider ?? (llm.listProviders?.() ?? [])[0]?.id;
    const reviewer = value.reviewer ?? {};
    const sessionEffort = sessionChoice?.kind === 'set' ? sessionChoice.effort : '';
    const mapped = parent === undefined ? undefined : lookupByParentModel(reviewer.byParentModel, parent.model);
    const global = normalizeModelChoice(reviewer.model);
    const candidates = [
      { layer: 'session', ref: sessionRef, effort: sessionEffort },
      { layer: 'parent-map', ref: mapped?.model, effort: mapped?.effort },
      { layer: 'global', ref: global?.model, effort: global?.effort },
      {
        layer: 'follow-parent',
        ref: reviewer.followParent === false || parent === undefined ? undefined : `${parent.provider}/${parent.model}`,
        effort: '',
      },
    ];

    const degraded = [];
    for (const candidate of candidates) {
      const parsed = parseModelRef(candidate.ref, fallbackProvider);
      if (parsed === undefined) continue;
      const verdict = await validate(parsed, candidate.effort);
      if (verdict.ok !== true) {
        // 与返回值同源：审计的 `degraded` 必须也是 `<layer>:<reason>`（设计「非法值降级」、设计「单行格式」、设计「两处需要额外说明的取值」）。
        const marker = `${candidate.layer}:${verdict.reason}`;
        degraded.push(marker);
        audit({
          phase: 'screen',
          action: 'review',
          layer: candidate.layer,
          model: `${parsed.provider}/${parsed.model}`,
          degraded: marker,
          reason: `模型不可用，降级到下一层：${verdict.reason}`,
        });
        continue;
      }
      if (verdict.degraded === true) {
        // `degraded` 的语法是 `<layer>:<reason>`（设计「非法值降级」、设计「单行格式」），层名前缀不得省略（设计「两处需要额外说明的取值」）。
        const marker = `${candidate.layer}:effort=${String(candidate.effort)} unsupported`;
        degraded.push(marker);
        audit({
          phase: 'screen',
          action: 'review',
          layer: candidate.layer,
          model: `${parsed.provider}/${parsed.model}`,
          effort: 'none',
          degraded: marker,
          reason: '所选模型不支持该推理档位，本次不传档位',
        });
      }
      const resolution = {
        provider: parsed.provider,
        model: parsed.model,
        layer: candidate.layer,
        effort: verdict.effort,
        degraded: degraded.length > 0 ? degraded.join(',') : undefined,
      };
      const resolved = { ...value, resolution };
      cache.set(key, resolved);
      if (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
      return resolved;
    }

    audit({
      phase: 'screen',
      action: 'review',
      layer: 'unavailable',
      degraded: 'all',
      reason: `两级模型解析全部失败：${degraded.join(' | ') || 'no candidate configured'}`,
    });
    return { ...value, resolution: { layer: 'unavailable', effort: 'none', degraded: 'all' } };
  }

  return { configFor, invalidate, cacheSize: () => cache.size };
}
