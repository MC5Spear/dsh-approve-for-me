/**
 * dsh-approve-for-me — 审批卡片的自动审批状态（供客户端轮询）。
 *
 * gate 在接管路径上把当前状态写进来，客户端从 `approveForMe/pendingState` 读，用来在原生卡片里
 * 显示「正在自动审批 / 等待你决定」与倒计时（design §7.4）。
 *
 * 这是**内存态**：进程重启即丢失；条目在结算时删除（gate 的 `finally`）。客户端只是显示方，
 * 状态与时限的唯一权威在本模块的写入方（gate），客户端不推测。
 * @module dsh-approve-for-me/pending-state
 */

/** 允许的状态取值（design §7.4）：审查中与已交人工；写错值按 `reviewing` 处理，避免把未知状态抛给界面。 */
export const PENDING_STATES = Object.freeze(['reviewing', 'waiting-human']);

/** 交人工条目的原因类别（design §7.4）：`deny` 模型判定拒绝、`timeout` 审查超时、`error` 通道故障。 */
export const PENDING_CAUSES = Object.freeze(['deny', 'timeout', 'error']);

/** 时限归属：审查时限或人工时限。 */
export const DEADLINE_KINDS = Object.freeze(['review', 'human']);

/**
 * 创建状态登记表。
 * @param {{now?: () => number}} [deps] - 注入点；`now` 便于测试注入时钟。
 * @returns {{set: (sessionId: string, record: object) => void, clear: (sessionId: string, callId: string) => void, list: (sessionId: string) => object[]}} 登记表。
 */
export function createPendingState(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  /** sessionId → (callId → 记录)；用 Map 保持写入顺序，客户端按 callId 取自己那一条。 */
  const bySession = new Map();

  /**
   * 归一化一条记录；缺字段填安全默认，非法状态按 `reviewing`、非法原因类别按 `error`
   * （原因子句走「未取得有效结论」，design §7.4）。
   * @param {object} record - 原始记录。
   * @returns {object} 归一化结果。
   */
  function normalize(record) {
    const state = PENDING_STATES.includes(record?.state) ? record.state : 'reviewing';
    const cause = PENDING_CAUSES.includes(record?.cause) ? record.cause : 'error';
    const deadlineAt = Number.isFinite(record?.deadlineAt) ? record.deadlineAt : null;
    const deadlineKind = deadlineAt === null || !DEADLINE_KINDS.includes(record?.deadlineKind)
      ? null
      : record.deadlineKind;
    return {
      callId: typeof record?.callId === 'string' ? record.callId : '',
      state,
      cause,
      reason: typeof record?.reason === 'string' ? record.reason : '',
      startedAt: Number.isFinite(record?.startedAt) ? record.startedAt : now(),
      deadlineAt,
      deadlineKind,
      updatedAt: now(),
    };
  }

  return {
    /**
     * 写入（或覆盖）一条状态。
     * @param {string} sessionId - 会话 id。
     * @param {object} record - `{ callId, state, cause?, reason?, startedAt?, deadlineAt?, deadlineKind? }`。
     * @returns {void}
     */
    set(sessionId, record) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return;
      const entry = normalize(record);
      if (entry.callId.length === 0) return;
      let bucket = bySession.get(sessionId);
      if (bucket === undefined) {
        bucket = new Map();
        bySession.set(sessionId, bucket);
      }
      bucket.set(entry.callId, entry);
    },

    /**
     * 删除一条状态；会话桶空了就一并移除。
     * @param {string} sessionId - 会话 id。
     * @param {string} callId - 调用 id。
     * @returns {void}
     */
    clear(sessionId, callId) {
      const bucket = bySession.get(sessionId);
      if (bucket === undefined) return;
      bucket.delete(callId);
      if (bucket.size === 0) bySession.delete(sessionId);
    },

    /**
     * 列出某会话的全部在飞状态。
     * @param {string} sessionId - 会话 id。
     * @returns {object[]} 记录数组（无则空数组）。
     */
    list(sessionId) {
      const bucket = bySession.get(sessionId);
      return bucket === undefined ? [] : [...bucket.values()];
    },
  };
}

export default createPendingState;
