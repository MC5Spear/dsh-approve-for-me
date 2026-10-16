/**
 * dsh-approve-for-me — 子代理覆盖（design §2.2）。
 *
 * 委派机制给每个子会话钉死 `approval/policy=never`，审批服务在该策略下不分发
 * waterfall，插件的应答者根本看不到子代理的升权请求。本模块在 `session/created` 时把
 * **可覆盖**子会话的策略追加翻成 `ask`，让子代理升权走与主会话同一 LLM 审查。
 *
 * 判定锚点是委派链**根会话**的权限预设（根会话必被 `pinInitialPermission` 钉预设；
 * 嵌套子代理的父会话没有稳定预设）。只追加 `approval/policy {policy:'ask'}`，**禁止**整预设
 * 写入——那会连委派捕获的沙箱一起改写。
 *
 * 监听器**永不抛**：`session/created` 的同步监听器抛异常会回滚宿主的会话挂载。
 * 任何失败只写审计，外部还包一层承接（lib/index.js 的 wrap），双保险。
 *
 * @module dsh-approve-for-me/subagents
 */
import { foldPresetEvent, isActivePreset, presetNameOf } from './mode.js';

/**
 * 会话是否为委派子会话（design §2.2 按身份识别）。
 *
 * 带 `parentSession` 且 `delegationDepth` 为不小于 1 的数值即委派子会话（含 seed 式委派）。
 * 分叉会话（`isSeeded` 为真且 `delegationDepth` 为 0 或缺席）不是委派子会话，按主会话对待；
 * `delegationDepth` 非数值按缺席处理。
 * @param {object | undefined} session - 目标会话。
 * @returns {boolean} 委派子会话为真；主会话、分叉会话与其余形态为假。
 */
export function isDelegated(session) {
  const parent = session?.header?.parentSession;
  if (typeof parent !== 'string' || parent.length === 0) return false;
  const depth = session?.header?.delegationDepth;
  return typeof depth === 'number' && depth >= 1;
}

/**
 * 沿 `header.parentSession` 上溯委派链，找到根会话（无父的最早祖先）。
 * @param {object} session - 起点会话（通常是委派子会话）。
 * @param {(id: string) => object | undefined} lookup - 按会话 id 取会话对象（活会话表）。
 * @returns {object | undefined} 根会话；链在任何一环断裂（父不在表内/不可读）时返回 `undefined`。
 */
export function rootOf(session, lookup) {
  const seen = new Set();
  let current = session;
  for (let depth = 0; depth < 16; depth += 1) {
    const id = typeof current?.id === 'string' ? current.id : String(depth);
    if (seen.has(id)) return undefined; // 环路保护：视为不可判定
    seen.add(id);
    const parent = current?.header?.parentSession;
    if (typeof parent !== 'string' || parent.length === 0) return current;
    const next = typeof lookup === 'function' ? lookup(parent) : undefined;
    if (next === undefined || next === null) return undefined; // 父不在活会话表 → 链断
    current = next;
  }
  return undefined; // 超过合理深度：视为不可判定
}

/**
 * 折最后一条 `approval/policy` 事件的策略值（与审批服务 `overrideOf` 同语义）。
 * @param {object | undefined} session - 目标会话。
 * @returns {string | undefined} `'ask' | 'never'`；无事件时 `undefined`。
 */
export function latestPolicyOf(session) {
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
    if (event?.type !== 'approval/policy') continue;
    const policy = event.data?.policy;
    return typeof policy === 'string' ? policy : undefined;
  }
  return undefined;
}

/**
 * 创建子代理覆盖装配。
 * @param {object} deps - 注入点。
 * @param {() => object} deps.current - 读取当前生效配置。
 * @param {() => {current?: (session: object) => string} | undefined} [deps.permissionPresets]
 *   - 权限预设服务读取器（与 lib/mode.js 同形态）。
 * @param {() => {list?: () => object[]} | undefined} [deps.sessionsOf] - sessions 服务读取器。
 * @param {(fields: object) => void} [deps.audit] - 审计入口。
 * @returns {{onSessionCreated: (session: object) => void, sweep: () => void,
 *   modeOf: (request: object) => 'auto' | 'off' | undefined, isDelegated: (session: object) => boolean}}
 *   装配实例；`modeOf` 对非委派会话返回 `undefined`（落回预设分支）。
 */
export function createSubagentCoverage(deps) {
  const { current, permissionPresets, sessionsOf, audit = () => {} } = deps;
  /** 审计的 skip/review 行去重记忆；随本装配实例（fiber）生命周期，不跨实例共享（测试隔离）。 */
  const written = new Set();

  /**
   * 去重记忆容量上界：键含 sessionId 而无会话结束信号，只能容量淘汰；
   * 1000 会话足够（同因首行的去重记忆量级）；超限删最旧（Set 迭代序＝插入序）。
   */
  const WRITTEN_MAX_ENTRIES = 1000;

  /** 超限淘汰最旧并登记新键。 */
  function rememberWritten(key) {
    written.add(key);
    if (written.size > WRITTEN_MAX_ENTRIES) written.delete(written.values().next().value);
  }

  /** 活会话表里按 id 找会话。 */
  const lookup = (id) => {
    try {
      const list = sessionsOf?.();
      const sessions = typeof list?.list === 'function' ? list.list() : [];
      return Array.isArray(sessions) ? sessions.find((item) => item?.id === id) : undefined;
    } catch {
      return undefined;
    }
  };

  /** 去重地写一行 skip 审计。 */
  function auditSkip(sessionId, preset, reason) {
    const key = `sub|${sessionId}|${preset}`;
    if (written.has(key)) return;
    rememberWritten(key);
    audit({ phase: 'screen', action: 'skip', source: 'preset', preset, inject: 'no', reason });
  }

  /** 去重地写一行覆盖审计。 */
  function auditCover(sessionId, preset, reason) {
    const key = `sub|${sessionId}|cover`;
    if (written.has(key)) return;
    rememberWritten(key);
    audit({ phase: 'screen', action: 'review', source: 'preset', preset, inject: 'no', reason });
  }

  /**
   * 覆盖判定：委派链根会话的预设是否命中 `trigger.presets`。
   * @param {object} session - 委派子会话。
   * @param {object} trigger - `trigger` 分节。
   * @returns {{cover: boolean, preset?: string, reason: string}} 判定结果。
   */
  function coverDecision(session, trigger) {
    const root = rootOf(session, lookup);
    if (root === undefined) {
      return { cover: false, reason: '委派链根会话不可达（跨进程或已不在活会话表），保持 never 不接管' };
    }
    const name = presetNameOf(permissionPresets, root) ?? foldPresetEvent(root);
    if (name === undefined) {
      return { cover: false, reason: '根会话权限预设不可判定，保持 never 不接管' };
    }
    if (!isActivePreset(name, trigger).active) {
      return { cover: false, preset: name, reason: `根会话权限预设「${name}」不在接管名单内，保持 never 不接管` };
    }
    return { cover: true, preset: name, reason: `根会话权限预设「${name}」命中，子会话审批策略翻为 ask` };
  }

  /**
   * `session/created` 监听体（也用于装载时补扫）。**永不抛**。
   * @param {object} session - 新会话。
   * @returns {void}
   */
  function onSessionCreated(session) {
    try {
      if (!isDelegated(session)) return;
      const trigger = current()?.trigger ?? {};
      if ((trigger.subagents ?? 'review') === 'skip') {
        auditSkip(session?.id ?? '-', 'subagent-skip', 'trigger.subagents=skip，不介入子代理审批');
        return;
      }
      const policy = latestPolicyOf(session);
      if (policy !== 'never') return; // 已是 ask（或无事件时默认即 ask）：无需翻
      const decision = coverDecision(session, trigger);
      if (!decision.cover) {
        auditSkip(typeof session?.id === 'string' ? session.id : '-', decision.preset ?? '-', decision.reason);
        return;
      }
      session.append('approval/policy', { policy: 'ask' });
      auditCover(typeof session?.id === 'string' ? session.id : '-', 'subagent', decision.reason);
    } catch (error) {
      // 只写审计，不外抛：外抛会回滚宿主的会话挂载。失败时策略保持 never，fail-closed。
      audit({
        phase: 'screen',
        action: 'skip',
        source: 'error',
        inject: 'no',
        reason: `子代理覆盖失败（保持 never 不翻策略）：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * 装载补扫：插件晚于会话创建装载（升级/HMR）时，对活表里的可覆盖委派会话补翻。
   * @returns {void}
   */
  function sweep() {
    try {
      const list = sessionsOf?.();
      const sessions = typeof list?.list === 'function' ? list.list() : [];
      if (!Array.isArray(sessions)) return;
      for (const session of sessions) onSessionCreated(session);
    } catch (error) {
      audit({
        phase: 'screen',
        action: 'skip',
        source: 'error',
        inject: 'no',
        reason: `子代理覆盖补扫失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * gate 的子代理分支（lib/mode.js 的 `mode()` 首先咨询这里）。
   * @param {object} request - 审批请求。
   * @returns {'auto' | 'off' | undefined} 委派子会话返回判定；其余 `undefined`（走预设分支）。
   */
  function modeOf(request) {
    const session = request?.agent?.session;
    if (!isDelegated(session)) return undefined;
    const trigger = current()?.trigger ?? {};
    if ((trigger.subagents ?? 'review') === 'skip') {
      auditSkip(typeof session?.id === 'string' ? session.id : '-', 'subagent-skip', 'trigger.subagents=skip，不介入子代理审批');
      return 'off';
    }
    const decision = coverDecision(session, trigger);
    if (!decision.cover) {
      auditSkip(typeof session?.id === 'string' ? session.id : '-', decision.preset ?? '-', decision.reason);
      return 'off';
    }
    const key = `sub|${session.id}|mode`;
    if (!written.has(key)) {
      rememberWritten(key);
      audit({
        phase: 'screen',
        action: 'review',
        source: 'preset',
        preset: 'subagent',
        inject: 'no',
        reason: `子代理会话（根预设「${decision.preset}」命中），本次审批由插件接管`,
      });
    }
    return 'auto';
  }

  /**
   * 委派子会话命中的根会话预设名（design §8.2 `preset`：委派子代理按根会话命中名）。
   * @param {object} request - 审批请求。
   * @returns {string | undefined} 非委派会话返回 `undefined`（走主会话分支）；根不可达/不可判定时也 `undefined`。
   */
  function presetOf(request) {
    const session = request?.agent?.session;
    if (!isDelegated(session)) return undefined;
    return coverDecision(session, current()?.trigger ?? {}).preset;
  }

  return { onSessionCreated, sweep, modeOf, isDelegated, presetOf };
}
