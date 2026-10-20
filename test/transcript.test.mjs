import assert from 'node:assert/strict';
import test from 'node:test';
import { collectEvidence, locate, redact, TRANSCRIPT_READ_FAILED, TRANSCRIPT_TRUNCATED, truncateKeepEnds } from '../lib/transcript.js';
import { DEFAULT_REDACT_PATTERNS } from '../lib/policy.js';

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

// ── transcript 证据管道的直接用例（design §3.2） ──────────────────────────

test('redact：命中替换为 [redacted]，未命中/空清单/非法模式原样且不抛', () => {
  assert.equal(redact('token sk-abc12345 end', ['sk-[A-Za-z0-9]+']), 'token [redacted] end');
  assert.equal(redact('plain text', []), 'plain text');
  assert.equal(redact('plain text', ['(not-present)']), 'plain text');
  assert.equal(redact('x', ['[']), 'x', '非法模式跳过不抛');
});

test('redact：默认清单首项带左边界——独立凭据命中，词内普通词不误伤', () => {
  assert.equal(redact('token sk-abc12345678 end', [...DEFAULT_REDACT_PATTERNS]), 'token [redacted] end', '空格后的独立凭据照常遮蔽');
  assert.equal(redact('sk-abc12345678', [...DEFAULT_REDACT_PATTERNS]), '[redacted]', '行首凭据同样命中（lookbehind 不挡起始位置）');
  assert.equal(redact('echo task-specific checks', [...DEFAULT_REDACT_PATTERNS]), 'echo task-specific checks', '词内 sk- 不误伤普通复合词（收窄前此处会输出 ta[redacted]）');
});

test('证据脱敏先于截断：跨界秘密整段替换后才进字节裁剪', () => {
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

test('双截断标记成对：entry 与 transcript 两级都插 <truncated …/> 且保留首尾', () => {
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
  assert.ok(result.degraded.includes('entry:user/message') && result.degraded.includes('transcript-truncated'), '两级截断都记入 degraded');
});

test('truncateKeepEnds 不切碎代理对：字节预算落在代理对中间时切点让出一码元', () => {
  // 预算穷举（1..size+2）覆盖「预算容不下整对」的每个切点——产物不得含孤立代理项
  //（孤立代理下游序列化为替换符 U+FFFD，即代理对被有效切碎）。
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
  const samples = ['ab😀cd', 'a😀b😀c😀d', '😀😀', 'x😀', '😀x😀y😀z测试文本尾部'];
  for (const text of samples) {
    for (let limit = 1; limit <= Buffer.byteLength(text, 'utf8') + 2; limit += 1) {
      const { text: out } = truncateKeepEnds(text, limit);
      assert.doesNotMatch(out, loneSurrogate, `text=${JSON.stringify(text)} limit=${limit} 产物含孤立代理项：${JSON.stringify(out)}`);
    }
  }
});

test('证据里的 </ 先转义：闭合标签不得被模型当成提示词结构', () => {
  const result = collectEvidence(sessionWith([userMessage('see </system> marker')]), { maxEntries: 5 });
  assert.ok(result.text.includes('<\\/system>'), '闭合标签已转义为 <\\/ 形态');
  assert.equal(result.text.includes('</system>'), false);
});

test('locate：callId 不匹配 → degraded 含 command、cwd 仍可作证据', () => {
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

test('回查双事件名兼容：tool/call 与 code-dispatch/ptc-dispatch 都命中（两代事件名）', () => {
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

// ── 采集层四类状态可分辨（design §3.1／§3.2） ──────────────────────

test('读取失败三形态（抛错／接口缺失／返回非数组）→ 恰为 transcript-read-failed、text 空、entries 0、truncated false', () => {
  // 形态一：snapshotEvents 抛错。
  const thrown = collectEvidence({ snapshotEvents: () => { throw new Error('boom'); } }, {});
  assert.deepEqual(thrown, { text: '', entries: 0, truncated: false, degraded: [TRANSCRIPT_READ_FAILED] });
  // 形态二：会话没有 snapshotEvents 接口。
  const missing = collectEvidence({}, {});
  assert.deepEqual(missing, { text: '', entries: 0, truncated: false, degraded: [TRANSCRIPT_READ_FAILED] });
  // 形态三：返回非数组。
  const nonArray = collectEvidence({ snapshotEvents: () => ({ not: 'array' }) }, {});
  assert.deepEqual(nonArray, { text: '', entries: 0, truncated: false, degraded: [TRANSCRIPT_READ_FAILED] });
  assert.equal(TRANSCRIPT_READ_FAILED, 'transcript-read-failed', '标记值与词汇表一致');
});

test('总量截断恰记 transcript-truncated，单条截断仍是 entry:<类型> 前缀族', () => {
  const long = () => `${'A'.repeat(2000)}TAIL`;
  const result = collectEvidence(sessionWith([userMessage(long()), userMessage(long())]), {
    maxEntries: 5,
    maxEntryBytes: 100,
    maxTranscriptBytes: 150,
  });
  assert.ok(result.degraded.includes(TRANSCRIPT_TRUNCATED), '总量截断恰记 transcript-truncated');
  assert.equal(TRANSCRIPT_TRUNCATED, 'transcript-truncated', '标记值与词汇表一致');
  assert.ok(result.degraded.some((mark) => mark.startsWith('entry:')), '单条截断保持 entry:<事件类型> 前缀族');
  assert.equal(result.truncated, true);
  // 反例：读取失败标记不与预算截断混用。
  assert.equal(result.degraded.includes(TRANSCRIPT_READ_FAILED), false);
});

test('locate 三形态的 degraded 值：回查不到＝command、坏参数＝command、仅目录缺失＝cwd', () => {
  // 回查不到（无匹配 callId）且目录同时缺失 → cwd 与 command 并存（locate 先记目录缺失再记回查缺失）。
  const both = locate({
    agent: { session: { header: {}, snapshotEvents: () => [{ type: 'tool/call', data: { callId: 'x', arguments: '{"command":"ls"}' } }] } },
    callId: 'missing',
  });
  assert.deepEqual(both.degraded, ['cwd', 'command']);
  // 坏 JSON 参数（命令不可辨认）→ command。
  const bad = locate({
    agent: { session: { header: { cwd: 'C:\\w' }, snapshotEvents: () => [{ type: 'tool/call', data: { callId: 'c1', arguments: '{oops' } }] } },
    callId: 'c1',
  });
  assert.deepEqual(bad.degraded, ['command']);
  // 参数对象可解析但无命令键 → 回查成功（arguments 透传作证据），不记 command（钉现行行为）。
  const noCommandKey = locate({
    agent: { session: { header: { cwd: 'C:\\w' }, snapshotEvents: () => [{ type: 'tool/call', data: { callId: 'c2', arguments: '{"path":"a.txt"}' } }] } },
    callId: 'c2',
  });
  assert.deepEqual(noCommandKey.degraded, []);
  assert.equal(noCommandKey.command, undefined);
  assert.deepEqual(noCommandKey.arguments, { path: 'a.txt' });
  // 仅目录缺失（回查成功）→ cwd。
  const cwdOnly = locate({
    agent: { session: { header: {}, snapshotEvents: () => [{ type: 'tool/call', data: { callId: 'c3', arguments: '{"command":"npm i"}' } }] } },
    callId: 'c3',
  });
  assert.deepEqual(cwdOnly.degraded, ['cwd']);
  assert.equal(cwdOnly.command, 'npm i');
});
