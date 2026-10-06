import assert from 'node:assert/strict';
import test from 'node:test';
import { createAudit, escapeField, formatAuditLine } from '../lib/audit.js';

/** 捕获写入行，避免测试污染真实 stderr。 */
function collector() {
  const lines = [];
  return { lines, write: (line) => lines.push(line) };
}

test('formatAuditLine 字段顺序固定且必含 R5 要求的字段', () => {
  const { line } = formatAuditLine(
    {
      id: 'req-1',
      phase: 'decide',
      callId: 'call_00_x:code:1',
      tool: 'pwsh',
      cwd: 'C:\\work',
      mode: 'danger-full-access',
      action: 'review',
      path: 'allowed-once',
      source: 'llm',
      decision: 'allowed-once',
      inject: 'no',
      withdraw: 'ok',
      layer: 'user',
      model: 'deepseek-official/deepseek-v4-flash',
      effort: 'low',
      finish: 'stop',
      reasoningTokens: 42,
      fieldsDefaulted: false,
      risk: 'low',
      auth: 'medium',
      tools: 2,
      reviewTimeout: 90000,
      degraded: 'none',
      ms: 1234,
      reason: 'ordinary workspace write',
    },
    { now: Date.UTC(2026, 8, 10, 0, 0, 0) },
  );
  const expectedOrder = [
    'v=3', 'ts=2026-09-10T00:00:00.000Z', 'id=req-1', 'phase=decide', 'callId=call_00_x:code:1',
    'tool=pwsh', 'cwd="C:\\\\work"', 'mode=danger-full-access', 'action=review', 'path=allowed-once',
    'source=llm', 'decision=allowed-once', 'inject=no', 'withdraw=ok', 'layer=user',
    'model=deepseek-official/deepseek-v4-flash', 'effort=low', 'finish=stop', 'reasoningTokens=42',
    'fieldsDefaulted=false', 'risk=low', 'auth=medium',
    'tools=2', 'reviewTimeout=90000', 'degraded=none', 'ms=1234', 'late=no', 'truncated=false',
    'reason="ordinary workspace write"',
  ];
  let cursor = -1;
  for (const token of expectedOrder) {
    const at = line.indexOf(token, cursor + 1);
    assert.ok(at > cursor, `字段缺失或顺序错误：${token}\n${line}`);
    cursor = at;
  }
  assert.ok(line.startsWith('[approve-for-me] '));
});

test('escapeField 转义引号、反斜杠并折叠换行', () => {
  assert.equal(escapeField('a"b\\c\nd'), 'a\\"b\\\\c d');
});

test('formatAuditLine 截断超长 reason 并置 truncated=true', () => {
  const long = 'x'.repeat(300);
  const { line, truncated } = formatAuditLine({ id: 'r', phase: 'decide', reason: long }, { now: 0 });
  assert.equal(truncated, true);
  assert.match(line, /truncated=true/);
  assert.match(line, new RegExp(`reason="${'x'.repeat(200)}"`));
});

test('formatAuditLine 缺省值填 - 且 inject 默认 no', () => {
  const { line } = formatAuditLine({ id: 'r', phase: 'screen' }, { now: 0 });
  assert.match(line, /callId=-/);
  assert.match(line, /tool=-/);
  assert.match(line, /cwd="-"/);
  assert.match(line, /inject=no/);
  assert.match(line, /reviewTimeout=-/);
  assert.match(line, /degraded=none/);
  assert.match(line, /finish=-/);
  assert.match(line, /reasoningTokens=-/);
  assert.match(line, /fieldsDefaulted=false/);
  assert.match(line, /ms=-/);
});

test('formatAuditLine 渲染 finish 与 reasoningTokens（设计「单行格式」）', () => {
  const { line } = formatAuditLine(
    { id: 'r', phase: 'review', finish: 'max-tokens', reasoningTokens: 1347, fieldsDefaulted: true, degraded: 'output-truncated' },
    { now: 0 },
  );
  assert.match(line, /finish=max-tokens/);
  assert.match(line, /reasoningTokens=1347/);
  assert.match(line, /fieldsDefaulted=true/);
  assert.match(line, /degraded=output-truncated/);
});

test('createAudit 默认写 stderr 而不是 stdout', () => {
  const written = [];
  const originalErr = process.stderr.write;
  const originalOut = process.stdout.write;
  process.stderr.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  process.stdout.write = () => {
    throw new Error('审计不得写 stdout');
  };
  try {
    createAudit(() => ({ enabled: true }))({ id: 'r', phase: 'decide', decision: 'rejected' });
  } finally {
    process.stderr.write = originalErr;
    process.stdout.write = originalOut;
  }
  assert.equal(written.length, 1);
  assert.match(written[0], /^\[approve-for-me] /);
  assert.ok(written[0].endsWith('\n'));
});

test('createAudit 受 enabled / includePrompt / includeRaw 开关约束', () => {
  const { lines, write } = collector();
  const audit = createAudit(() => ({ enabled: true, includePrompt: false, includeRaw: false }), { write });
  audit({ id: 'r', phase: 'decide', decision: 'rejected' });
  audit({ id: 'r', phase: 'prompt', reason: 'full prompt' });
  audit({ id: 'r', phase: 'raw', reason: 'raw output' });
  assert.equal(lines.length, 1);

  const enabled = collector();
  createAudit(() => ({ enabled: true, includePrompt: true, includeRaw: true }), { write: enabled.write })({
    id: 'r',
    phase: 'prompt',
    reason: 'full prompt',
  });
  assert.equal(enabled.lines.length, 1);
});

test('createAudit 计算耗时并在超出行上限时留截断痕迹', () => {
  const { lines, write } = collector();
  let clock = 1000;
  const audit = createAudit(() => ({ enabled: true, maxLineBytes: 4096 }), { write, now: () => clock });
  audit({ id: 'r', phase: 'screen', action: 'review' });
  clock = 1500;
  audit({ id: 'r', phase: 'decide', decision: 'rejected' });
  assert.match(lines[0], /ms=0/);
  assert.match(lines[1], /ms=500/);

  const tight = collector();
  const shortAudit = createAudit(() => ({ enabled: true, maxLineBytes: 120 }), { write: tight.write, now: () => 0 });
  shortAudit({ id: 'r', phase: 'decide', decision: 'rejected', reason: 'y'.repeat(300) });
  assert.ok(Buffer.byteLength(tight.lines[0], 'utf8') <= 120);
  assert.match(tight.lines[0], /truncated=true/);
});

test('createAudit 在写入抛错时不影响调用方', () => {
  const audit = createAudit(() => ({ enabled: true }), {
    write: () => {
      throw new Error('stderr closed');
    },
  });
  assert.doesNotThrow(() => audit({ id: 'r', phase: 'decide', decision: 'rejected' }));
});

// ── R34：审计 reason 的先遮后截 ──────────────────────────────────────────

test('R34① 审计 reason 落笔前过 redactPatterns', () => {
  const { lines, write } = collector();
  const audit = createAudit(() => ({ enabled: true, redactPatterns: ['sk-[A-Za-z0-9]+'] }), { write, now: () => 0 });
  audit({ id: 'r1', phase: 'screen', action: 'deny', reason: 'found token sk-abc12345 in command' });
  assert.match(lines[0], /\[redacted\]/);
  assert.doesNotMatch(lines[0], /sk-abc12345/);
});

test('R34② 先遮后截次序：跨界秘密整段先遮、再进长度截断', () => {
  // 判据形态：截断点落在秘密中间——先截后遮时残留前半段（password=s3…），先遮后截时整段被替换。
  const { lines, write } = collector();
  const audit = createAudit(() => ({ enabled: true, redactPatterns: ['password=s3cretpw'] }), { write, now: () => 0 });
  audit({ id: 'r2', phase: 'screen', action: 'deny', reason: `${'A'.repeat(195)}password=s3cretpw` });
  // 遮蔽标记本身也可能被 200 字符截断切掉——判据只看泄漏面：行内不得再出现秘密的任何前缀。
  assert.doesNotMatch(lines[0], /password|s3c/u, '先遮后截：秘密整段替换后才截断');
  assert.match(lines[0], /truncated=true/);
});

test('R34③ 超行上限的压缩路径同样不漏秘密', () => {
  const { lines, write } = collector();
  const audit = createAudit(() => ({ enabled: true, maxLineBytes: 120, redactPatterns: ['s3cretpw'] }), { write, now: () => 0 });
  audit({ id: 'r3', phase: 'screen', action: 'deny', reason: `password=s3cretpw ${'x'.repeat(400)}` });
  assert.match(lines[0], /truncated=true/);
  assert.doesNotMatch(lines[0], /s3cretpw/);
});

// ── R41：startedAt 的登记口径与容量 ──────────────────────────────────────

test('R41 startedAt 只登记接管型 screen 行：skip 行不登记', () => {
  const skipped = collector();
  let clock = 0;
  const skipAudit = createAudit(() => ({ enabled: true }), { write: skipped.write, now: () => clock });
  skipAudit({ id: 'sk', phase: 'screen', action: 'skip', reason: 'not mine' });
  clock = 5000;
  skipAudit({ id: 'sk', phase: 'review', source: 'llm', decision: 'deny' });
  // skip 未登记起点 → 后续行 ms 为 `-`（无起点可算，也不会等到 decide 才回收）。
  assert.match(skipped.lines[1], /ms=-/);

  const tracked = collector();
  clock = 0;
  const trackAudit = createAudit(() => ({ enabled: true }), { write: tracked.write, now: () => clock });
  trackAudit({ id: 'tk', phase: 'screen', action: 'review' });
  clock = 120;
  trackAudit({ id: 'tk', phase: 'review', source: 'llm', decision: 'deny' });
  assert.match(tracked.lines[1], /ms=120/);
});

test('R41 startedAt 容量淘汰：超过 2000 个在途 id 后最旧起点被回收', () => {
  const { lines, write } = collector();
  let clock = 0;
  const audit = createAudit(() => ({ enabled: true }), { write, now: () => clock });
  audit({ id: 'first', phase: 'screen', action: 'review' });
  for (let index = 0; index < 2000; index += 1) audit({ id: `r${index}`, phase: 'screen', action: 'review' });
  clock = 9000;
  audit({ id: 'first', phase: 'screen', action: 'review' }); // first 已被淘汰 → 重新登记（起点=9000）
  clock = 9100;
  audit({ id: 'first', phase: 'decide', decision: 'rejected', source: 'llm' });
  // 变异对照：去掉容量淘汰 → first 起点仍是 0 → ms=9100。
  assert.match(lines.at(-1), /ms=100 late=/);
});
