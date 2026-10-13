/**
 * dsh-approve-for-me — 注入消息的 v4 源形状（单一权威）。
 *
 * 0.1.7 的会话格式 v4 退役了 v3 的插件源包装（source 的 kind 取字面量 plugin、
 * 另带 plugin 名字段）：宿主在 `session.append` 的行准入里校验每个持久化消息的
 * `source.kind`，kind 缺失或等于该字面量即抛
 * `format v4 message requires a producer-owned source kind`
 * （`@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js` 的 `source()` 函数）。
 * 三方插件的规范形状由同一文件的迁移器 `rewritePluginSource` 给出：
 * `{ kind: 'plugin:<插件名>' }`，不带 `plugin` 字段。
 *
 * 回归测试 `test/v4-source.test.mjs` 用 0.1.7 真校验器 `assertV4RowAdmission`
 * 守住本形状：改回旧形状必须变红。
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
