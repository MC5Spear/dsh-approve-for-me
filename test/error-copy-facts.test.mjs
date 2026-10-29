import assert from 'node:assert/strict';
import test from 'node:test';
import { agentT } from '../lib/agent-texts.js';
import { errorCopyFailures } from './helpers/error-copy-facts.mjs';

test('普通错误说明：真实模板和改换措辞的中英正例共用有限事实检查', () => {
  const examples = {
    tool: { zh: '工具 {name} 未能完成，错误详情：{error}', en: 'The tool {name} could not complete; details: {error}' },
    args: { zh: '参数无效：不能使用非 JSON 内容。详情 {error}', en: 'Arguments contain malformed JSON; details: {error}' },
    channel: { zh: '[approve-for-me] 通道出现异常；本次升权予以拒绝。', en: '[approve-for-me] A channel error occurred; reject this escalation request.' },
  };
  for (const lang of ['zh', 'en']) {
    for (const [kind, key] of [['tool', 'tool.failed'], ['args', 'tool.argsJsonInvalid'], ['channel', 'gate.error.body']]) {
      const actual = kind === 'channel' ? agentT(lang, key).split('\n')[0] : agentT(lang, key);
      assert.deepEqual(errorCopyFailures(kind, lang, actual), [], `${kind}/${lang} 真实模板`);
      assert.deepEqual(errorCopyFailures(kind, lang, examples[kind][lang]), [], `${kind}/${lang} 改换措辞`);
    }
  }
});

test('普通错误说明：缺失败事实、错误对象、占位符或单次拒绝事实必须失败', () => {
  const cases = [
    ['tool', 'zh', '工具 {name}：{error}'], ['tool', 'en', 'Tool {name}: {error}'],
    ['tool', 'zh', '工具 {name} 失败。'], ['tool', 'en', 'Tool {name} failed.'],
    ['tool', 'zh', '工具 {name} 失败：{error} {error}'], ['tool', 'en', 'Tool {name} failed: {error} {error}'],
    ['args', 'zh', '参数内容为 JSON：{error}'], ['args', 'en', 'Tool arguments are JSON: {error}'],
    ['channel', 'zh', '[approve-for-me] 通道故障，本次升权允许。'],
    ['channel', 'en', '[approve-for-me] Channel failure; this escalation request is allowed.'],
    ['channel', 'zh', '[approve-for-me] 通道故障，所有升权拒绝处理。'],
    ['channel', 'en', '[approve-for-me] Channel failure; all escalation requests are rejected.'],
    ['channel', 'zh', '[approve-for-me] 通道故障，本次升权并非按拒绝处理。'],
    ['channel', 'en', '[approve-for-me] Channel failure; this escalation request is not rejected.'],
    ['args', 'zh', '工具参数并非无效 JSON：{error}'],
    ['args', 'en', 'Tool arguments are not invalid JSON: {error}'],
    ['tool', 'zh', '工具 {name} 并非失败：{error}'],
    ['tool', 'en', 'Tool {name} did not fail: {error}'],
  ];
  for (const [kind, lang, text] of cases) assert.ok(errorCopyFailures(kind, lang, text).length, `${kind}/${lang} ${text}`);
});
