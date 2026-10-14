/**
 * dsh-approve-for-me — 审查模型解析（三层顺序 + 直退全局默认 + 缓存）。
 *
 * 选择层序（requirements §5.1／design §6.2）：
 *   1 `session`        会话级显式选择（有设置才参与）；
 *   2 `parent-map`     父模型映射（`reviewer.parentModelRules` 结构化规则＋`reviewer.byParentModel` 兼容链）；
 *   3 `global`         全局默认 `reviewer.model`。
 * 任一层选出的目标不可用时记录原因并**直接使用全局默认层**，不在其余层级间逐层回退，
 * 映射层内精确规则不可用时也不改试通用规则。落到全局默认层时：未设置（空）按零值语义
 * 使用执行助手当前模型（`follow-parent`），已设置但不可用按 `unavailable` 故障处理，
 * 不静默选任意模型。状态服务（`lib/bridge.js` 的 `getState`）与审批共用同一选择实现。
 * @module dsh-approve-for-me/model-resolver
 */
import { normalizeRuleProvider, parentModelRuleKey } from './config.js';

/** 缓存条目上限；超出按 LRU 淘汰。 */
export const CACHE_MAX_ENTRIES = 64;

/** 解析层名称，与审计 `layer=` 字段取值一致；`follow-parent` 承载全局默认未设置的零值语义，`unavailable` 承载故障。 */
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
 * 解析 `provider/model` 形式的候选值：按首斜杠切 provider，模型 id 内的斜杠保留。
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
 * 校验一个候选路由，并确认期望的推理档位是否受支持。选择、状态诊断共用本实现。
 * @param {object} llm - 宿主 `ctx.llm`（`listProviders` / `resolveModelInfo`）。
 * @param {{provider: string, model: string}} candidate - 候选。
 * @param {string | undefined} explicit - 该层显式指定的推理档位。
 * @returns {Promise<{ok: true, effort: string, degraded: boolean} | {ok: false, reason: string}>} 校验结果。
 */
export async function validateModelRef(llm, candidate, explicit) {
  const providers = llm?.listProviders?.() ?? [];
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
 * 运行时重复条件检测（design §6.2）：装载与读取路径已在合并层拒绝重复条件；快照值绕过
 * `normalizeConfig` 直传时由此承接——按可见配置错误抛出，请求经异常路径拒绝结算，不按清单顺序选赢家。
 * @param {unknown} rules - `reviewer.parentModelRules`。
 * @returns {void} 重复即抛错。
 */
export function assertNoDuplicateParentRules(rules) {
  if (!Array.isArray(rules)) return;
  const seen = new Set();
  for (const rule of rules) {
    const parent = rule?.parent;
    if (parent === null || typeof parent !== 'object') continue;
    const provider = normalizeRuleProvider(parent.provider);
    if (provider === undefined) continue;
    if (typeof parent.model !== 'string' || parent.model.trim().length === 0) continue;
    const key = parentModelRuleKey(provider, parent.model);
    if (seen.has(key)) {
      throw new Error(
        `approve-for-me: reviewer.parentModelRules 存在重复匹配条件（provider=${provider === null ? '任意' : provider}、` +
          `model=${parent.model}），按可见配置错误拒绝`,
      );
    }
    seen.add(key);
  }
}

/**
 * 归一一条规则的选择：返回 `{model, effort}`；`model` 为空串表示规则被选中但目标未设置。
 * @param {object | undefined} rule - 规则对象。
 * @returns {{model: string, effort: string}} 选择归一值。
 */
function ruleChoiceOf(rule) {
  const choice = rule?.choice;
  if (typeof choice === 'string') {
    return { model: choice.trim(), effort: '' };
  }
  if (choice === null || typeof choice !== 'object') return { model: '', effort: '' };
  return {
    model: typeof choice.model === 'string' ? choice.model.trim() : '',
    effort: typeof choice.effort === 'string' ? choice.effort.trim() : '',
  };
}

/**
 * 新结构规则查找（design §6.2 层内顺序）：先精确匹配（provider 非空且相等、model 相等），
 * 后通用匹配（provider 为空值且 model 相等）。
 * @param {unknown} rules - `reviewer.parentModelRules`。
 * @param {{provider: string, model: string} | undefined} parent - 完整父模型对象。
 * @returns {{model: string, effort: string} | undefined} 被选中规则的选择；未命中返回 `undefined`。
 *   命中但目标未设置时返回 `{model: '', effort: ''}`——规则已被选中，选择层按候选不可用处理。
 */
export function matchParentModelRules(rules, parent) {
  if (!Array.isArray(rules)) return undefined;
  if (parent === null || typeof parent !== 'object' || typeof parent.model !== 'string' || parent.model.length === 0) {
    return undefined;
  }
  let generic;
  for (const rule of rules) {
    const condition = rule?.parent;
    if (condition === null || typeof condition !== 'object') continue;
    if (condition.model !== parent.model) continue;
    const provider = normalizeRuleProvider(condition.provider);
    if (provider === undefined) continue;
    if (provider !== null) {
      // 精确命中即返回：层内精确优先，不再看通用规则。
      if (provider === parent.provider) return ruleChoiceOf(rule);
      continue;
    }
    if (generic === undefined) generic = ruleChoiceOf(rule);
  }
  return generic;
}

/**
 * 旧 `byParentModel` 字典兼容查找（design §6.2 兼容链后两级）：
 * 键面值直接命中（纯模型 id 键，按通用匹配）→ 全引用键读作去掉首个斜杠后的完整纯模型 id（按通用匹配）。
 * 多个旧全引用键归一到同一条件时按选择值判定：值一致则命中结果与字典枚举顺序无关；
 * 值不一致则不使用冲突别名、映射层按未命中处理，冲突由调用方留痕。旧键按字面参与匹配，不做猜测恢复。
 * @param {Record<string, unknown> | undefined} table - `reviewer.byParentModel`。
 * @param {{provider: string, model: string} | undefined} parent - 完整父模型对象。
 * @returns {{choice: {model: string, effort: string} | undefined, conflict: boolean}} 查找结果与归一冲突标记。
 */
export function lookupByParentModel(table, parent) {
  if (table === null || typeof table !== 'object') return { choice: undefined, conflict: false };
  if (parent === null || typeof parent !== 'object' || typeof parent.model !== 'string' || parent.model.length === 0) {
    return { choice: undefined, conflict: false };
  }
  const direct = normalizeModelChoice(table[parent.model]);
  if (direct !== undefined) return { choice: direct, conflict: false };
  let agreed;
  let conflict = false;
  for (const [key, value] of Object.entries(table)) {
    const slash = key.indexOf('/');
    // 首段或末段为空的键不参与归一（如 `/model`、`provider/`），与无斜杠的纯 id 键同理跳过。
    if (slash <= 0 || slash === key.length - 1) continue;
    if (key.slice(slash + 1) !== parent.model) continue;
    const hit = normalizeModelChoice(value);
    if (hit === undefined) continue;
    if (agreed === undefined) agreed = hit;
    else if (agreed.model !== hit.model || agreed.effort !== hit.effort) conflict = true;
  }
  return { choice: conflict ? undefined : agreed, conflict: conflict && agreed !== undefined };
}

/**
 * 父模型映射层完整查找（design §6.2 兼容链四级）：新结构精确规则 → 新结构通用规则 →
 * 旧字典键面值 → 旧字典全引用归一。新结构与旧字典并存时同条件命中按本次序确定性取值。
 * @param {unknown} rules - `reviewer.parentModelRules`。
 * @param {Record<string, unknown> | undefined} table - `reviewer.byParentModel`。
 * @param {{provider: string, model: string} | undefined} parent - 完整父模型对象。
 * @returns {{choice: {model: string, effort: string} | undefined, conflict: boolean}} 查找结果。
 */
export function lookupParentMap(rules, table, parent) {
  const matched = matchParentModelRules(rules, parent);
  if (matched !== undefined) return { choice: matched, conflict: false };
  return lookupByParentModel(table, parent);
}

/**
 * 三层序选择的共享实现（design §6.2）：审批解析（`configFor`）与状态服务（`getState`）共用，
 * 保证状态与审批是同一选择逻辑。
 * 层序：会话选择（有设置才参与）→ 父模型映射 → 全局默认。任一被选候选不可用时记录
 * `<layer>:<reason>` 标记后直接使用全局默认层；映射层内不改试其他规则。全局默认未设置时
 * 按零值语义使用执行助手当前模型；已设置但不可用、或零值语义下父模型不可得／不可用时按 `unavailable` 故障。
 * @param {object} llm - 宿主 `ctx.llm`。
 * @param {object} reviewer - 生效配置的 `reviewer` 分节。
 * @param {{kind: string, model?: string, effort?: string} | undefined} sessionChoice - 会话级选择。
 * @param {{provider: string, model: string} | undefined} parent - 父模型（执行助手当前模型）。
 * @param {(fields: object) => void} [audit] - 审计回调；状态查询不传（查询不落审计行）。
 * @returns {Promise<{layer: string, provider?: string, model?: string, effort: string, degraded?: string}>}
 *   解析结果；`layer='unavailable'` 时无路由，`effort='none'` 表示不传档位。
 * @throws {Error} 规则清单存在重复条件时按可见配置错误抛出（design §6.2）。
 */
export async function selectReviewerModel(llm, reviewer, sessionChoice, parent, audit = () => {}) {
  assertNoDuplicateParentRules(reviewer?.parentModelRules);
  const degraded = [];
  const fallbackProvider = parent?.provider ?? (llm?.listProviders?.() ?? [])[0]?.id;
  const global = normalizeModelChoice(reviewer?.model);

  /**
   * 尝试一个候选：不可用则记录原因并返回 `undefined`（调用方直接落到全局默认层）。
   * @param {string} layer - 候选所属层。
   * @param {string | {provider: string, model: string}} ref - 目标引用或结构化候选。
   * @param {string} effort - 该层显式指定的推理档位（空串＝自动选择）。
   * @returns {Promise<{layer: string, provider: string, model: string, effort: string} | undefined>} 可用候选。
   */
  const tryCandidate = async (layer, ref, effort) => {
    const parsed =
      typeof ref === 'string'
        ? parseModelRef(ref, fallbackProvider)
        : ref !== null && typeof ref === 'object' && typeof ref.provider === 'string' && typeof ref.model === 'string' && ref.model.length > 0
          ? ref
          : undefined;
    if (parsed === undefined) {
      const marker = `${layer}:unparsable model reference`;
      degraded.push(marker);
      audit({ phase: 'screen', action: 'review', layer, degraded: marker, reason: '候选模型引用不可解析，直接使用全局默认' });
      return undefined;
    }
    const verdict = await validateModelRef(llm, parsed, effort);
    if (verdict.ok !== true) {
      // 与返回值同源：审计的 `degraded` 必须也是 `<layer>:<reason>`（design §6.2、design §8.1、design §8.2）。
      const marker = `${layer}:${verdict.reason}`;
      degraded.push(marker);
      audit({
        phase: 'screen',
        action: 'review',
        layer,
        model: `${parsed.provider}/${parsed.model}`,
        degraded: marker,
        reason: `模型不可用，直接使用全局默认：${verdict.reason}`,
      });
      return undefined;
    }
    if (verdict.degraded === true) {
      const marker = `${layer}:effort=${effort} unsupported`;
      degraded.push(marker);
      audit({
        phase: 'screen',
        action: 'review',
        layer,
        model: `${parsed.provider}/${parsed.model}`,
        effort: 'none',
        degraded: marker,
        reason: '所选模型不支持该推理档位，本次不传档位',
      });
    }
    return { layer, provider: parsed.provider, model: parsed.model, effort: verdict.effort };
  };

  const finish = (hit) => (degraded.length > 0 ? { ...hit, degraded: degraded.join(',') } : hit);
  const failAll = (cause) => {
    audit({
      phase: 'screen',
      action: 'review',
      layer: 'unavailable',
      degraded: 'all',
      reason: `模型解析失败，无可用审查模型：${cause}`,
    });
    return { layer: 'unavailable', effort: 'none', degraded: 'all' };
  };

  // 第 1 层：会话选择（有设置才参与）。
  if (sessionChoice?.kind === 'set') {
    const hit = await tryCandidate('session', sessionChoice.model ?? '', sessionChoice.effort ?? '');
    if (hit !== undefined) return finish(hit);
  }

  // 第 2 层：父模型映射。归一冲突按未命中处理并在审计留痕（design §6.2）。
  const mapped = parent === undefined ? undefined : lookupParentMap(reviewer?.parentModelRules, reviewer?.byParentModel, parent);
  if (mapped?.conflict === true) {
    audit({
      phase: 'screen',
      action: 'review',
      layer: 'parent-map',
      degraded: 'parent-map:legacy-alias-conflict',
      reason: `旧全引用键归一到 model=${parent.model} 后选择值不一致，不使用冲突别名，直接使用全局默认`,
    });
  }
  if (mapped?.choice !== undefined) {
    const hit = await tryCandidate('parent-map', mapped.choice.model, mapped.choice.effort);
    if (hit !== undefined) return finish(hit);
  }

  // 第 3 层：全局默认。已设置但不可用＝故障；未设置按零值语义用执行助手当前模型。
  if (global !== undefined) {
    const hit = await tryCandidate('global', global.model, global.effort);
    if (hit !== undefined) return finish(hit);
    return failAll(degraded.join(' | ') || 'no candidate configured');
  }
  if (parent === undefined) {
    return failAll([...degraded, 'follow-parent:parent model unavailable'].join(' | '));
  }
  const followed = await tryCandidate('follow-parent', parent, '');
  if (followed !== undefined) return finish(followed);
  return failAll(degraded.join(' | '));
}

/**
 * 审查模型不可用诊断（design §7.2.0）：按当前配置与目录惰性求值，逐行推演「该配置目标被
 * 选中且不可用」的直退结果；只呈现可见性，不改变 6.2 的回退语义与解析结果本身。
 * 三类作用域：`global`（全局默认）、`rule`（映射行，含旧字典呈现行的兼容读取条件）、
 * `session`（会话选择，仅有会话选择时产生）。global 与 rule 不依赖会话——无会话求值时
 * 全局默认为空的直退层按零值语义记 `follow-parent`、生效引用取空串。
 * @param {object} options - 入参。
 * @param {object} options.llm - 宿主 `ctx.llm`。
 * @param {object} options.reviewer - 生效配置的 `reviewer` 分节。
 * @param {{kind: string, model?: string, effort?: string} | undefined} options.sessionChoice - 会话级选择。
 * @param {{provider: string, model: string} | undefined} options.parent - 父模型。
 * @returns {Promise<{scope: string, ruleProvider: string | null, ruleModel: string, configured: string,
 *   reason: string, effectiveLayer: string, effectiveModel: string}[]>} 诊断条目。
 */
export async function collectModelIssues({ llm, reviewer, sessionChoice, parent }) {
  const issues = [];
  try {
    const global = normalizeModelChoice(reviewer?.model);

    // 直退终点推演（「配置目标被选中且不可用」都直退全局默认层，design §7.2.0）：
    // 已设置且可用 → global；已设置不可用 → unavailable；未设置 → follow-parent
    // （无会话求值时生效引用取空串，有会话时校验执行助手当前模型）。
    let fallback;
    if (global !== undefined) {
      const parsed = parseModelRef(global.model, parent?.provider);
      const verdict = parsed === undefined ? { ok: false, reason: 'unparsable model reference' } : await validateModelRef(llm, parsed, global.effort);
      fallback = verdict.ok === true ? { effectiveLayer: 'global', effectiveModel: global.model } : { effectiveLayer: 'unavailable', effectiveModel: '' };
      if (verdict.ok !== true) {
        issues.push({ scope: 'global', ruleProvider: null, ruleModel: '', configured: global.model, reason: verdict.reason, ...fallback });
      }
    } else if (parent === undefined) {
      fallback = { effectiveLayer: 'follow-parent', effectiveModel: '' };
    } else {
      const verdict = await validateModelRef(llm, parent, '');
      fallback =
        verdict.ok === true
          ? { effectiveLayer: 'follow-parent', effectiveModel: `${parent.provider}/${parent.model}` }
          : { effectiveLayer: 'unavailable', effectiveModel: '' };
    }

    // rule 作用域：新结构规则行＋旧字典呈现行（兼容读取条件＝任意 provider＋键面值或去首斜杠后的完整 id）。
    /** 映射行：{provider, model, choice}；同一目标引用只校验一次（行数有界内的去重）。 */
    const rows = [];
    if (Array.isArray(reviewer?.parentModelRules)) {
      for (const rule of reviewer.parentModelRules) {
        const condition = rule?.parent;
        const provider = condition === null || typeof condition !== 'object' ? null : normalizeRuleProvider(condition.provider);
        rows.push({ provider: provider ?? null, model: typeof condition?.model === 'string' ? condition.model : '', choice: ruleChoiceOf(rule) });
      }
    }
    const legacy = reviewer?.byParentModel;
    if (legacy !== null && typeof legacy === 'object') {
      for (const [key, value] of Object.entries(legacy)) {
        const slash = key.indexOf('/');
        const model = slash > 0 && slash < key.length - 1 ? key.slice(slash + 1) : key;
        rows.push({ provider: null, model, choice: normalizeModelChoice(value) ?? { model: '', effort: '' } });
      }
    }
    const checked = new Map();
    for (const row of rows) {
      if (row.model.length === 0 || row.choice.model.length === 0) continue;
      let verdict = checked.get(row.choice.model);
      if (verdict === undefined) {
        const parsed = parseModelRef(row.choice.model, parent?.provider);
        verdict = parsed === undefined ? { ok: false, reason: 'unparsable model reference' } : await validateModelRef(llm, parsed, row.choice.effort);
        checked.set(row.choice.model, verdict);
      }
      if (verdict.ok !== true) {
        issues.push({
          scope: 'rule',
          ruleProvider: row.provider,
          ruleModel: row.model,
          configured: row.choice.model,
          reason: verdict.reason,
          effectiveLayer: fallback.effectiveLayer,
          effectiveModel: fallback.effectiveModel,
        });
      }
    }

    // session 作用域：仅有会话选择时产生（会话控件场景）。
    if (sessionChoice?.kind === 'set') {
      const parsed = parseModelRef(sessionChoice.model ?? '', parent?.provider);
      const verdict = parsed === undefined ? { ok: false, reason: 'unparsable model reference' } : await validateModelRef(llm, parsed, sessionChoice.effort ?? '');
      if (verdict.ok !== true) {
        issues.push({
          scope: 'session',
          ruleProvider: null,
          ruleModel: '',
          configured: sessionChoice.model,
          reason: verdict.reason,
          effectiveLayer: fallback.effectiveLayer,
          effectiveModel: fallback.effectiveModel,
        });
      }
    }
    return issues;
  } catch (error) {
    // 诊断计算失败不产生条目、不伪造原因，只在 stderr 留痕（design §7.2.0）。
    process.stderr?.write?.(`approve-for-me: modelIssues 计算失败：${error instanceof Error ? error.message : String(error)}\n`);
    return issues;
  }
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
 * @returns {{configFor: (request: object) => Promise<object>, selectFor: (options: object) => Promise<object>,
 *   invalidate: () => void, cacheSize: () => number}} 解析器；`configFor` 只在设置服务读取异常或
 *   规则清单存在重复条件（可见配置错误）时抛出；`selectFor` 供状态服务复用同一选择与缓存。
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
   * 缓存键（design §6.2 有界查找表）：设置快照修订号（承载 `parentModelRules` 规则清单与
   * 兼容字典的一切变化——宿主对 volatile 字段的原地更新会递增修订号）＋会话选择引用与档位＋
   * 父 provider/model。这里保存的是模型路由信息，不是审批结论。
   * @param {{revision?: number}} snapshot - 设置快照。
   * @param {{kind?: string, model?: string, effort?: string} | undefined} sessionChoice - 会话级选择。
   * @param {{provider?: string, model?: string} | undefined} parent - 父模型。
   * @returns {string} 缓存键。
   */
  function cacheKeyOf(snapshot, sessionChoice, parent) {
    const sessionRef = sessionChoice?.kind === 'set' ? sessionChoice.model : undefined;
    return `${snapshot.revision ?? 0}|${sessionRef ?? '-'}|${sessionChoice?.effort ?? '-'}|${parent?.provider ?? '-'}|${parent?.model ?? '-'}`;
  }

  /**
   * 带缓存的共享选择：审批解析（`configFor`）与状态查询（`selectFor`）同一逻辑、同一缓存。
   * `unavailable` 结果不缓存——故障态不长期驻留，恢复后下一次查询即可重新解析。
   * @param {object} snapshot - 本次读取的设置快照（缓存键与配置值同源，避免两次读取间的竞态）。
   * @param {{kind: string, model?: string, effort?: string} | undefined} sessionChoice - 会话级选择。
   * @param {{provider: string, model: string} | undefined} parent - 父模型。
   * @param {(fields: object) => void} auditSink - 审计回调（审批路径传入；状态查询传空函数）。
   * @returns {Promise<object>} 解析结果（`selectReviewerModel` 的返回形状）。
   */
  async function cachedSelect(snapshot, sessionChoice, parent, auditSink) {
    const key = cacheKeyOf(snapshot, sessionChoice, parent);
    const cached = cache.get(key);
    if (cached !== undefined) {
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }
    const resolution = await selectReviewerModel(llm, snapshot.value?.reviewer ?? {}, sessionChoice, parent, auditSink);
    if (resolution.layer !== 'unavailable') {
      cache.set(key, resolution);
      if (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
    }
    return resolution;
  }

  /**
   * 状态服务的共享选择入口：与审批同一逻辑、同一缓存；不落审计行。
   * @param {object} [options] - 入参。
   * @param {{kind: string, model?: string, effort?: string} | undefined} [options.sessionChoice] - 会话级选择。
   * @param {{provider: string, model: string} | undefined} [options.parent] - 父模型。
   * @returns {Promise<object>} 解析结果（`selectReviewerModel` 的返回形状）。
   */
  function selectFor({ sessionChoice, parent } = {}) {
    return cachedSelect(settingsSnapshot() ?? {}, sessionChoice, parent, () => {});
  }

  /**
   * 按三层解析顺序解析一次请求的生效配置。
   * @param {{agent?: {session?: object}}} request - 审批请求。
   * @returns {Promise<object>} 生效配置，附 `resolution` 字段。
   */
  async function configFor(request) {
    const snapshot = settingsSnapshot() ?? {};
    const session = request?.agent?.session;
    const parent = parentModelOf(session);
    const sessionChoice = sessionModelOf(session);
    const resolution = await cachedSelect(snapshot, sessionChoice, parent, audit);
    return { ...snapshot.value, resolution };
  }

  return { configFor, selectFor, invalidate, cacheSize: () => cache.size };
}
