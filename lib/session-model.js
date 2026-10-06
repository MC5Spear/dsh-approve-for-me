/**
 * dsh-approve-for-me — 会话级审查模型的**只读兼容**折叠。
 *
 * 会话级选择的现行载体是文件 `<DSH_HOME>/approve-for-me/session-models.json`（`lib/session-store.js`），
 * 本模块只在文件里没有该会话条目时兜底：把历史上写入过的事件类型 `approve-for-me/reviewer-model`
 * 折叠出最近一条语义。它**不写**任何事件——宿主持久化读路径拒绝未知事件类型，写进去会让该会话
 * 重启后无法恢复。折叠规则：
 *   - `{ model: '<provider>/<model>' }` → 本会话显式指定，覆盖全局级；
 *   - `{ model: null }` → 显式清除（含义「跟随全局」），继续往更早的事件找没有意义，
 *     因此折叠结果直接是 `clear`。
 * 写入口只有 composer 下拉（经 `approveForMe/setSessionModel` RPC），因此这里不做校验：
 * 非法引用的降级由 `lib/model-resolver.js` 的 `validate()` 负责，与全局级同一套规则。
 * @module dsh-approve-for-me/session-model
 */

/** 会话级审查模型的事件类型；命名空间前缀与设置命名空间同名。 */
export const SESSION_MODEL_EVENT = 'approve-for-me/reviewer-model';

/**
 * 折叠事件列表，得到会话级选择的最终语义。
 * @param {readonly object[] | undefined} events - `session.snapshotEvents()` 的结果。
 * @returns {{kind: 'set', model: string, effort: string} | {kind: 'clear'} | undefined} 折叠结果；
 *   没有任何相关事件时返回 `undefined`（表示「未选择」，与显式清除区分只影响审计措辞）。
 */
export function foldSessionModel(events) {
  if (!Array.isArray(events)) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== SESSION_MODEL_EVENT) continue;
    const model = event.data?.model;
    if (model === null) return { kind: 'clear' };
    if (typeof model === 'string' && model.trim().length > 0) {
      const effort = typeof event.data?.effort === 'string' ? event.data.effort.trim() : '';
      return { kind: 'set', model: model.trim(), effort };
    }
    // 空串等非法载荷当作「未设置」继续往前找，不让坏数据把整条链路打断。
  }
  return undefined;
}

/**
 * 读取会话级选择；事件读取不可用时返回 `undefined`（视作未选择）。
 * @param {{snapshotEvents?: () => readonly object[]} | undefined} session - 发起审批的会话。
 * @returns {{kind: 'set', model: string} | {kind: 'clear'} | undefined} 折叠结果。
 */
export function sessionModelOf(session) {
  if (session === undefined || session === null || typeof session.snapshotEvents !== 'function') return undefined;
  let events;
  try {
    events = session.snapshotEvents();
  } catch {
    return undefined;
  }
  return foldSessionModel(events);
}

// 这里**不提供**写事件的函数。宿主 `session.append` 虽接受任意类型，但持久化的读路径拒绝未知事件类型
//（`dsh-session-persistence` 校验事件白名单，`append` 没有 `ignorable` 通道），写进去会让该会话在重启后
// 无法恢复。会话级选择一律走文件载体 `lib/session-store.js`；本模块只负责读旧事件做兼容。
