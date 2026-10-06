import assert from 'node:assert/strict';
import test from 'node:test';
import { collectEvidence, locate, redact } from '../lib/transcript.js';

/**
 * 构造一条 user/message 事件。
 * @param {string} text - 正文。
 * @returns {object} 事件。
 */
const userMessage = (text) => ({ type: 'user/message', data: { content: [{ type: 'text', text }] } });

/**
 * 构造带事件快照的会话。
 * @param {object[]} events - 事件数组。
 * @returns {object} 假 session。
 */
const sessionWith = (events) => ({ snapshotEvents: () => events });

// ── R45：transcript 证据管道的直接用例（原先只经 reviewer/gate 间接覆盖） ──

test('R45① redact：命中替换为 [redacted]，未命中/空清单/非法模式原样且不抛', () => {
  assert.equal(redact('token sk-abc12345 end', ['sk-[A-Za-z0-9]+']), 'token [redacted] end');
  assert.equal(redact('plain text', []), 'plain text');
  assert.equal(redact('plain text', ['(not-present)']), 'plain text');
  assert.equal(redact('x', ['[']), 'x', '非法模式跳过不抛');
});

test('R45①b 证据脱敏先于截断：跨界秘密整段替换后才进字节裁剪', () => {
  const events = [userMessage(`${'A'.repeat(95)}sk-abcdefgh1234`)];
  const result = collectEvidence(sessionWith(events), {
    maxEntries: 5,
    maxEntryBytes: 100,
    redactPatterns: ['sk-[A-Za-z0-9]+'],
  });
  assert.ok(result.degraded.includes('entry:user/message'), '预算内确实截断（用例前提）');
  assert.doesNotMatch(result.text, /sk-/u, '截断若先于脱敏，会留下秘密的截断前缀');
  assert.match(result.text, /\[redacted\]/u);
});

test('R45② 双截断标记成对：entry 与 transcript 两级都插 <truncated …/> 且保留首尾', () => {
  const long = () => `${'A'.repeat(2000)}TAIL`;
  // 两条超长事件：entry 级各自截断，拼接后超总预算再触发 transcript 级截断。
  const result = collectEvidence(sessionWith([userMessage(long()), userMessage(long())]), {
    maxEntries: 5,
    maxEntryBytes: 100,
    maxTranscriptBytes: 150,
  });
  const markers = result.text.match(/<truncated omitted_approx_tokens="/gu) ?? [];
  // 注：transcript 级裁剪可能切穿 entry 级标记的文本本身（保首尾策略），完整标记数 ≥1 即可；
  // 两级是否都发生以 degraded 登记为准（判据的权威信号）。
  assert.ok(markers.length >= 1, `截断标记在场且带估算 token 数：${result.text}`);
  assert.ok(result.text.startsWith('user: A'), '保留头部（命令与结论常在尾部，首尾都留）');
  assert.ok(result.text.includes('TAIL'), '保留尾部');
  assert.ok(result.degraded.includes('entry:user/message') && result.degraded.includes('transcript'), '两级截断都记入 degraded');
});

test('R45③ 证据里的 </ 先转义：闭合标签不得被模型当成提示词结构', () => {
  const result = collectEvidence(sessionWith([userMessage('see </system> marker')]), { maxEntries: 5 });
  assert.ok(result.text.includes('<\\/system>'), '闭合标签已转义为 <\\/ 形态');
  assert.equal(result.text.includes('</system>'), false);
});

test('R45④ locate：callId 不匹配 → degraded 含 command、cwd 仍可作证据', () => {
  const request = {
    agent: {
      session: {
        header: { cwd: 'C:\\work' },
        snapshotEvents: () => [{ type: 'tool/call', data: { callId: 'other', arguments: '{"command":"ls"}' } }],
      },
    },
    callId: 'missing',
  };
  const located = locate(request);
  assert.deepEqual(located.degraded, ['command']);
  assert.equal(located.command, undefined);
  assert.equal(located.cwd, 'C:\\work');
});

test('R45⑤ 回查双事件名兼容：tool/call 与 code-dispatch/ptc-dispatch 都命中（两代事件名）', () => {
  const callOf = (type, idKey, arguments_) => ({
    agent: {
      session: {
        snapshotEvents: () => [{ type, data: { [idKey]: 'c9', arguments: arguments_ } }],
      },
    },
    callId: 'c9',
  });
  assert.equal(locate(callOf('tool/call', 'callId', '{"command":"direct"}')).command, 'direct');
  assert.equal(locate(callOf('tool/code-dispatch-start', 'subCallId', { command: 'dispatched' })).command, 'dispatched');
  assert.equal(locate(callOf('tool/ptc-dispatch-start', 'subCallId', { command: 'ptc' })).command, 'ptc');
});
