/**
 * dsh-approve-for-me — 权限预设判定（接管开关）。
 *
 * 插件只在会话权限预设命中 `trigger.presets` 时接管审批（设计「插件侧判定与跳过」）：预设是使用者可见的
 * 唯一入口，避免插件在「工作区内修改」等预设下改变原有的原生审批行为。
 *
 * 判定顺序：插件配置 → 权限预设服务（读会话投影）→ 服务缺失或投影未注册时回退折叠
 * `permission/preset` 事件 → 仍不可判定时按 `trigger.unknown` 处置。判定本身不解析模型、
 * 不调 LLM、不写会话，只写一行审计。
 * @module dsh-approve-for-me/mode
 */

/** `trigger.unknown` 的两个合法取值；非法值按 `skip` 回退。 */
const UNKNOWN_REVIEW = 'review';
const UNKNOWN_SKIP = 'skip';

/**
 * 折叠 `permission/preset` 事件，得到最近一次显式选择的预设名。
 * 服务缺失（无 `permissionPresets`）或投影单元未注册时用它回退，语义与
 * `lib/model-resolver.js` 折叠 `model/selection` 一致。
 * @param {{snapshotEvents?: () => readonly object[]} | undefined} session - 发起审批的会话。
 * @returns {string | undefined} 预设名；读不到时返回 `undefined`。
 */
export function foldPresetEvent(session) {
  if (session === undefined || session === null || typeof session.snapshotEvents !== 'function') return undefined;
  let events;
  try {
    events = session.snapshotEvents();
  } catch {
    return undefined;
  }
  if (!Array.isArray(events)) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'permission/preset') continue;
    const preset = event.data?.preset;
    if (typeof preset === 'string' && preset.length > 0) return preset;
  }
  return undefined;
}

/**
 * 判断一个预设名是否落在接管名单内。
 * @param {unknown} preset - 预设名；`undefined` 表示不可判定。
 * @param {object} trigger - `trigger` 分节。
 * @returns {{active: boolean, unknown: boolean}} 判定结果；不可判定时按 `trigger.unknown` 折算。
 */
export function isActivePreset(preset, trigger) {
  const wanted = Array.isArray(trigger?.presets) ? trigger.presets : [];
  if (typeof preset === 'string' && preset.length > 0) {
    return { active: wanted.includes(preset), unknown: false };
  }
  const unknown = trigger?.unknown === UNKNOWN_REVIEW ? UNKNOWN_REVIEW : UNKNOWN_SKIP;
  return { active: unknown === UNKNOWN_REVIEW, unknown: true };
}

/**
 * 读取当前会话的权限预设名。
 * @param {() => {current?: (session: object) => string} | undefined} permissionPresets - 服务读取器。
 * @param {object | undefined} session - 发起审批的会话。
 * @returns {string | undefined} 预设名；服务缺失、投影未注册或会话不可用时返回 `undefined`。
 */
export function presetNameOf(permissionPresets, session) {
  const service = permissionPresets?.();
  if (service === undefined || service === null || typeof service.current !== 'function') return undefined;
  if (session === undefined || session === null) return undefined;
  try {
    const name = service.current(session);
    return typeof name === 'string' && name.length > 0 ? name : undefined;
  } catch {
    // 投影单元未注册时 `current()` 会抛：回退到事件折叠，而不是当作「不接管」。
    return undefined;
  }
}

/**
 * 会话或部署级的接管判定；供 gate（活会话）与 `getState`（可能是非活会话）共用，保证只此一份实现。
 * @param {object} deps - 注入点。
 * @param {() => {current?: (session: object) => string, defaultPreset?: string} | undefined} deps.permissionPresets - 服务读取器。
 * @param {object} deps.trigger - `trigger` 分节。
 * @param {object | undefined} session - 目标会话；非活会话传 `undefined`。
 * @returns {{preset: string | null, active: boolean, resolved: boolean}} `resolved=false` 表示连 `defaultPreset` 都取不到。
 */
export function resolveActivation(deps, session) {
  const trigger = deps.trigger ?? {};
  const service = deps.permissionPresets?.();
  const live = session === undefined || session === null ? undefined : presetNameOf(deps.permissionPresets, session) ?? foldPresetEvent(session);
  if (typeof live === 'string' && live.length > 0) {
    return { preset: live, ...isActivePreset(live, trigger), resolved: true };
  }
  // 非活会话（或服务读不到）用「未来会话的默认预设」回退：新会话将要使用的就是它。
  // 该 getter 与 `current()` 一样可能在投影未注册时抛错，因此单独兜住。
  let fallback;
  try {
    const value = service?.defaultPreset;
    if (typeof value === 'string' && value.length > 0) fallback = value;
  } catch {
    fallback = undefined;
  }
  if (fallback !== undefined) {
    return { preset: fallback, ...isActivePreset(fallback, trigger), resolved: true };
  }
  return { preset: null, ...isActivePreset(undefined, trigger), resolved: false };
}

/**
 * 创建预设判定器。
 * @param {object} deps - 注入点。
 * @param {() => object} deps.current - 读取当前生效配置。
 * @param {() => {current?: (session: object) => string} | undefined} deps.permissionPresets - `ctx.get('permissionPresets')`。
 * @param {(fields: object) => void} [deps.audit] - 审计入口。
 * @param {{modeOf?: (request: object) => 'auto' | 'off' | undefined}} [deps.coverage]
 *   - 子代理覆盖装配（lib/subagents.js）；`modeOf` 对非委派会话返回 `undefined`。
 * @returns {{mode: (request: object) => 'auto' | 'off'}} 判定器。
 */
export function createMode(deps) {
  const { current, permissionPresets, audit = () => {}, coverage } = deps;
  /** 已写过 skip 行的 `会话|预设` 组合；`trigger.auditEverySkip` 为真时不使用。 */
  const skipWritten = new Set();
  /** 已写过 review 行的会话。 */
  const reviewWritten = new Set();
  /** 已写过 gate 跳过行的 `会话|因` 组合（R40）；宿主在 mode 闭包——gate 的应答者逐请求调用，自身不能持有状态。 */
  const gateSkipWritten = new Set();

  /**
   * 去重记忆的容量上界（R41）：键含 sessionId 而无会话结束信号，只能容量淘汰；
   * 1000 会话足够（同因首行的去重记忆量级，gate 跳过键含 why 原文、键空间更大，同上限治理）；
   * 超限删最旧（Set 迭代序＝插入序）。
   */
  const WRITTEN_MAX_ENTRIES = 1000;

  /** 超限淘汰最旧并登记新键。 */
  function rememberWritten(set, key) {
    set.add(key);
    if (set.size > WRITTEN_MAX_ENTRIES) set.delete(set.values().next().value);
  }

  /**
   * gate 跳过路径（预设命中但 screen 判定跳过）的审计去重（R40）：同一 `(会话, 因)` 只放行第一行；
   * `trigger.auditEverySkip` 为真时全量放行。
   * @param {string} sessionId - 会话 id；未知时 `-`。
   * @param {string} why - screen 的跳过原因原文。
   * @returns {boolean} 是否写行。
   */
  function gateSkip(sessionId, why) {
    const key = `${sessionId}|${why}`;
    if (current()?.trigger?.auditEverySkip !== true && gateSkipWritten.has(key)) return false;
    rememberWritten(gateSkipWritten, key);
    return true;
  }

  /**
   * 写一行跳过审计；同一 `(会话, 预设)` 只写一行，除非 `trigger.auditEverySkip`。
   * @param {string} sessionId - 会话 id；未知时 `-`。
   * @param {string} preset - 预设名或来源标记。
   * @param {string} source - `preset` / `config`。
   * @param {string} reason - 人类可读的说明。
   * @returns {void}
   */
  function auditSkip(sessionId, preset, source, reason) {
    const key = `${sessionId}|${preset}`;
    if (current()?.trigger?.auditEverySkip !== true && skipWritten.has(key)) return;
    rememberWritten(skipWritten, key);
    audit({ phase: 'screen', action: 'skip', source, preset, inject: 'no', reason });
  }

  /**
   * 按预设接管时写一行「已接管」审计；每个会话只写一行。
   * @param {string} sessionId - 会话 id。
   * @param {string} preset - 命中的预设名。
   * @returns {void}
   */
  function auditReview(sessionId, preset) {
    if (reviewWritten.has(sessionId)) return;
    rememberWritten(reviewWritten, sessionId);
    audit({
      phase: 'screen',
      action: 'review',
      source: 'preset',
      preset,
      inject: 'no',
      reason: `权限预设「${preset}」命中，本次审批由插件接管`,
    });
  }

  /**
   * 判定本次审批是否接管。
   * @param {{agent?: {session?: object}}} request - 审批请求。
   * @returns {'auto' | 'off'} `auto` = 接管并审查；`off` = 原样交给下一个应答者。
   */
  function mode(request) {
    // 配置级关闭（0.1.7）：`mode` 是 volatile 字段、宿主原地更新，apply 期的注册检查
    // 不会重跑——这里请求期首查，热改为 `off` 后下一次审批立即走 `next()`（设计 §6.1 适配点 4）。
    if (current()?.mode === 'off') return 'off';
    // 子代理分支（R24 / 设计 §2.2）：委派子会话没有可命中的预设名，
    // 判定与审计都由 coverage 自己完成；非委派会话返回 undefined，落回下方预设分支。
    const viaCoverage = coverage?.modeOf?.(request);
    if (viaCoverage !== undefined) return viaCoverage;
    const trigger = current()?.trigger ?? {};
    const session = request?.agent?.session;
    const sessionId = typeof session?.id === 'string' ? session.id : '-';
    const unknown = trigger.unknown === UNKNOWN_REVIEW || trigger.unknown === UNKNOWN_SKIP
      ? trigger.unknown
      : UNKNOWN_SKIP;

    if (trigger.unknown !== undefined && trigger.unknown !== UNKNOWN_REVIEW && trigger.unknown !== UNKNOWN_SKIP) {
      auditSkip(sessionId, 'invalid-config', 'config', `trigger.unknown 取值非法，按 skip 回退：${String(trigger.unknown)}`);
    }

    const name = presetNameOf(permissionPresets, session) ?? foldPresetEvent(session);
    if (name === undefined) {
      if (unknown === UNKNOWN_REVIEW) {
        auditReview(sessionId, 'unknown-review');
        return 'auto';
      }
      auditSkip(sessionId, 'unknown-skip', 'preset', '权限预设不可判定，按 trigger.unknown=skip 不接管');
      return 'off';
    }

    const { active } = isActivePreset(name, trigger);
    if (active) {
      auditReview(sessionId, name);
      return 'auto';
    }
    auditSkip(sessionId, name, 'preset', `权限预设「${name}」不在接管名单内`);
    return 'off';
  }

  /**
   * 本次触发接管命中的权限预设名（§8.2 `preset`）：与 `mode()` 同一判定源但不写审计、
   * 不改去重记忆；子代理分支先问 coverage（根会话命中名），非委派走本会话预设解析。
   * @param {{agent?: {session?: object}}} request - 审批请求。
   * @returns {string | undefined} 命中的预设名；取不到（配置关闭/不可判定）时 `undefined`。
   */
  function presetOf(request) {
    const viaCoverage = coverage?.presetOf?.(request);
    if (viaCoverage !== undefined) return viaCoverage;
    if (current()?.mode === 'off') return undefined;
    const session = request?.agent?.session;
    return presetNameOf(permissionPresets, session) ?? foldPresetEvent(session) ?? undefined;
  }

  return { mode, gateSkip, presetOf };
}
