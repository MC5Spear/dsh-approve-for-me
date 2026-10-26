/**
 * dsh-approve-for-me — 注入消息的 v4 源形状（单一权威）。
 *
 * 会话格式 v4 要求每个持久化消息带生产者自有源（producer-owned source）：宿主在
 * `session.append` 的行准入里校验 `source.kind`，缺失或取宿主保留字面量即抛
 * `format v4 message requires a producer-owned source kind`
 * （`@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js` 的 `source()` 函数），
 * 当轮中断、会话卡死。三方插件的规范形状是 `{ kind: 'plugin:<插件名>' }`，不带
 * `plugin` 字段（同一文件的迁移器 `rewritePluginSource` 同款）。
 *
 * 回归测试 `test/v4-source.test.mjs` 用宿主锚点树的真校验器
 * `assertV4RowAdmission` 守住本形状：偏离本形状必须变红。
 *
 * @module dsh-approve-for-me/source
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';

/** 本插件消息的生产者自有源形状；冻结防调用方就地改写。 */
export const PLUGIN_MESSAGE_SOURCE = Object.freeze({ kind: 'plugin:approve-for-me' });

/**
 * 构造一条交给 `agent.inject()` 的注入消息。
 * 生产（`lib/index.js` 的 inject 助手）与回归测试共用本工厂，
 * 保证测试校验的就是生产构造的那份形状。
 * @param {string} text - 注入文本。
 * @returns {object} user 角色消息。
 */
export function injectionMessage(text) {
  return createUserMessage({ content: [{ type: 'text', text }], source: PLUGIN_MESSAGE_SOURCE });
}
