import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTraceStore } from '../lib/trace-store.js';

/**
 * 建一个测试用临时目录；用例结束自动清理。
 * @param {object} t - `node:test` 的上下文。
 * @returns {string} 目录路径。
 */
function makeDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsafm-trace-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * 组装一条完整的待落盘记录；`overrides` 覆盖任意字段（含用 `undefined` 抹掉）。
 * @param {object} [overrides] - 覆盖项。
 * @returns {object} 记录入参。
 */
function makeEntry(overrides = {}) {
  return {
    sessionId: 's1',
    callId: 'c1',
    askedSeq: 7,
    toolName: 'pwsh',
    startedAt: 1700000000000,
    endedAt: 1700000000213,
    queueMs: 12,
    reviewMs: 201,
    humanWaitMs: 0,
    decision: 'allowed-once',
    model: 'zai/glm-5.3',
    effort: 'low',
    tokens: 128,
    prompt: 'prompt text',
    input: 'input text',
    reasoning: 'reasoning text',
    output: 'output text',
    ...overrides,
  };
}

/**
 * 读 JSONL 文件的非空行。
 * @param {string} file - 文件路径。
 * @returns {string[]} 行数组。
 */
function readLines(file) {
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.length > 0);
}

/** 收集降级审计行的回调替身。 */
function makeSink() {
  const rows = [];
  return { rows, onDegrade: (fields) => rows.push(fields) };
}

test('写入后 list 读回：摘要字段齐、JSONL 一行一条', async (t) => {
  const dir = makeDir(t);
  const store = createTraceStore({ dir });
  assert.equal(await store.record(makeEntry()), true);
  await store.flush();

  const rows = store.list('s1');
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.reviewId, 's1:c1:7');
  assert.equal(row.decision, 'allowed-once');
  assert.equal(row.model, 'zai/glm-5.3');
  assert.equal(row.effort, 'low');
  assert.equal(row.toolName, 'pwsh');
  assert.equal(row.startedAt, 1700000000000);
  assert.equal(row.endedAt, 1700000000213);
  assert.equal(row.queueMs, 12);
  assert.equal(row.reviewMs, 201);

  const lines = readLines(join(dir, 's1.jsonl'));
  assert.equal(lines.length, 1);
  const onDisk = JSON.parse(lines[0]);
  assert.equal(onDisk.reviewId, 's1:c1:7');
});

test('重启可见性：新实例从 JSONL 重放窗口，缺失会话返回空且不建文件', async (t) => {
  const dir = makeDir(t);
  const first = createTraceStore({ dir });
  for (let i = 1; i <= 3; i += 1) await first.record(makeEntry({ askedSeq: i }));
  await first.flush();

  const second = createTraceStore({ dir });
  const rows = second.list('s1');
  assert.deepEqual(
    rows.map((row) => row.reviewId),
    ['s1:c1:1', 's1:c1:2', 's1:c1:3'],
  );
  assert.equal(second.get('s1', 's1:c1:2').decision, 'allowed-once');
  assert.deepEqual(second.list('missing'), []);
  assert.equal(second.get('missing', 'x'), null);
  assert.deepEqual(readdirSync(dir), ['s1.jsonl']);
});

test('同一 reviewId 不重复追加：返回 false 且文件只一行', async (t) => {
  const dir = makeDir(t);
  const store = createTraceStore({ dir });
  assert.equal(await store.record(makeEntry()), true);
  assert.equal(await store.record(makeEntry({ decision: 'rejected' })), false);
  await store.flush();

  const lines = readLines(join(dir, 's1.jsonl'));
  assert.equal(lines.length, 1);
  assert.equal(store.list('s1').length, 1);
  // 去重看的是 reviewId：同会话同 seq 但不同 callId 是两条不同审批。
  assert.equal(await store.record(makeEntry({ callId: 'c2' })), true);
  await store.flush();
  assert.equal(readLines(join(dir, 's1.jsonl')).length, 2);
});

test('reviewId 三段规则：callId 缺失用 -；askedSeq 缺失落 startedAt 并标来源', async (t) => {
  const dir = makeDir(t);
  const store = createTraceStore({ dir });
  await store.record(makeEntry({ callId: undefined }));
  await store.record(makeEntry({ callId: undefined, askedSeq: undefined, startedAt: 1700000000999, sessionId: 's2' }));
  await store.flush();

  const [withSeq, fallback] = store.list('s1');
  assert.equal(withSeq.reviewId, 's1:-:7');
  assert.equal(withSeq.reviewKeySource, 'askedSeq');
  assert.equal(withSeq.callId, undefined);

  const [noSeq] = store.list('s2');
  assert.equal(noSeq.reviewId, 's2:-:1700000000999');
  assert.equal(noSeq.reviewKeySource, 'startedAt');
});

test('session- 前缀归一化：两种 id 形态指向同一文件与同一 reviewId 首段', async (t) => {
  const dir = makeDir(t);
  const store = createTraceStore({ dir });
  await store.record(makeEntry({ sessionId: 'session-abc' }));
  await store.flush();

  assert.deepEqual(readdirSync(dir), ['abc.jsonl']);
  assert.equal(store.list('abc')[0].reviewId, 'abc:c1:7');
  assert.equal(store.get('session-abc', 'abc:c1:7').decision, 'allowed-once');
});

test('capture=off/summary 只落摘要字段，full 才落详情', async (t) => {
  const dir = makeDir(t);
  const entry = makeEntry({ askedSeq: 3 });
  await createTraceStore({ dir, capture: 'off' }).record({ ...entry, sessionId: 'off' });
  const summaryStore = createTraceStore({ dir, capture: 'summary' });
  await summaryStore.record({ ...entry, sessionId: 'sum' });
  const fullStore = createTraceStore({ dir, capture: 'full' });
  await fullStore.record({ ...entry, sessionId: 'full' });
  await Promise.all([summaryStore.flush(), fullStore.flush()]);

  for (const key of ['off', 'sum']) {
    const row = createTraceStore({ dir }).get(key, `${key}:c1:3`);
    assert.equal(row.decision, 'allowed-once', `${key} 档应保留摘要`);
    for (const field of ['prompt', 'input', 'reasoning', 'output']) {
      assert.equal(row[field], undefined, `${key} 档不应落 ${field}`);
    }
    assert.equal(row.truncated, false);
  }
  const full = fullStore.get('full', 'full:c1:3');
  assert.equal(full.prompt, 'prompt text');
  assert.equal(full.input, 'input text');
  assert.equal(full.reasoning, 'reasoning text');
  assert.equal(full.output, 'output text');
});

test('full 档超 maxBytes 截断并置 truncated，多字节字符不切成残字', async (t) => {
  const dir = makeDir(t);
  const store = createTraceStore({ dir, capture: 'full', maxBytes: 16 });
  await store.record(makeEntry({ askedSeq: 1, output: 'x'.repeat(64), reasoning: '密'.repeat(64) }));
  await store.flush();

  const row = store.get('s1', 's1:c1:1');
  assert.equal(row.truncated, true);
  assert.ok(Buffer.byteLength(row.output, 'utf8') <= 16);
  assert.ok(Buffer.byteLength(row.reasoning, 'utf8') <= 16);
  assert.ok(!row.reasoning.includes('\uFFFD'), '不应在截断边界产生替换字符');
  // 未超限的短字段原样保留。
  assert.equal(row.prompt, 'prompt text');
});

test('full 档沿用传入的脱敏函数（截断前套用）', async (t) => {
  const dir = makeDir(t);
  const seen = [];
  const store = createTraceStore({
    dir,
    capture: 'full',
    redact: (text) => {
      seen.push(text);
      return text.replaceAll('SECRET', '***');
    },
  });
  await store.record(makeEntry({ askedSeq: 2, output: 'keep SECRET hidden' }));
  await store.flush();

  assert.ok(seen.some((text) => text.includes('SECRET')), '脱敏函数应见到详情原文');
  assert.equal(store.get('s1', 's1:c1:2').output, 'keep *** hidden');
});

test('并发 20 条写：串行队列不丢行、每行可解析、顺序即调用顺序', async (t) => {
  const dir = makeDir(t);
  const store = createTraceStore({ dir });
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => store.record(makeEntry({ askedSeq: i + 1 }))),
  );
  assert.equal(results.filter(Boolean).length, 20);
  await store.flush();

  const lines = readLines(join(dir, 's1.jsonl'));
  assert.equal(lines.length, 20);
  const parsed = lines.map((line) => JSON.parse(line));
  assert.deepEqual(
    parsed.map((row) => row.reviewId),
    Array.from({ length: 20 }, (_, i) => `s1:c1:${i + 1}`),
  );
  assert.equal(store.list('s1').length, 20);
});

test('行数超上限（maxRecords × 4）后重写只留窗口', async (t) => {
  const dir = makeDir(t);
  const store = createTraceStore({ dir, maxRecords: 5 });
  for (let i = 1; i <= 21; i += 1) await store.record(makeEntry({ askedSeq: i }));
  await store.flush();

  const lines = readLines(join(dir, 's1.jsonl'));
  assert.equal(lines.length, 5, '重写后文件只剩窗口大小');
  const ids = lines.map((line) => JSON.parse(line).reviewId);
  assert.deepEqual(ids, ['s1:c1:17', 's1:c1:18', 's1:c1:19', 's1:c1:20', 's1:c1:21']);
  assert.deepEqual(
    store.list('s1').map((row) => row.reviewId),
    ids,
  );
  // 重写后的文件对后续写入与重放都还是正常 JSONL。
  await store.record(makeEntry({ askedSeq: 22 }));
  await store.flush();
  assert.equal(readLines(join(dir, 's1.jsonl')).length, 6);
  assert.equal(createTraceStore({ dir, maxRecords: 5 }).list('s1').length, 5);
});

test('reviews/ 文件数超 maxSessions 删最旧', async (t) => {
  const dir = makeDir(t);
  const store = createTraceStore({ dir, maxSessions: 2 });
  for (const key of ['a', 'b', 'c', 'd']) {
    await store.record(makeEntry({ sessionId: key, askedSeq: 1 }));
    await store.flush();
  }

  assert.deepEqual(readdirSync(dir).sort(), ['c.jsonl', 'd.jsonl']);
  // R41：内存侧与磁盘侧同数量级口径——被淘汰会话的窗口一并回收，文件已删、重放为空；
  // 留在限内的会话照常可查。
  assert.equal(store.list('a').length, 0);
  assert.equal(store.list('c').length, 1);
});

test('写失败：不抛错、返回 false、记录留在内存、审计一行 file-store-failed', async (t) => {
  const dir = makeDir(t);
  const blocked = join(dir, 'blocker');
  writeFileSync(blocked, 'not a directory', 'utf8');
  const sink = makeSink();
  const store = createTraceStore({ dir: blocked, onDegrade: sink.onDegrade });

  assert.equal(await store.record(makeEntry()), false);
  assert.equal(store.list('s1').length, 1, '写失败仍留在内存窗口');
  const write = sink.rows.find((row) => row.degraded === 'file-store-failed');
  assert.ok(write, '应审计一行写失败');
  assert.equal(write.phase, 'trace');
});

test('读失败：返回空列表并审计一行 read-failed；末行撕裂只丢末行并审计 torn-line', async (t) => {
  const dir = makeDir(t);
  // JSONL 路径被目录占位：读得到错误（EISDIR，非 ENOENT），走读失败降级而不是「无历史」。
  mkdirSync(join(dir, 's1.jsonl'));
  const readSink = makeSink();
  const broken = createTraceStore({ dir, onDegrade: readSink.onDegrade });
  assert.deepEqual(broken.list('s1'), []);
  assert.equal(readSink.rows.filter((row) => row.degraded === 'read-failed').length, 1);

  // 末行撕裂：跨进程短写被打断的残迹，跳过该行、保留前面的完整行。
  writeFileSync(
    join(dir, 's2.jsonl'),
    `${JSON.stringify({ reviewId: 's2:c1:1', decision: 'rejected' })}\n{"reviewId":"s2:c1:2","decis`,
    'utf8',
  );
  const tornSink = makeSink();
  const store = createTraceStore({ dir, onDegrade: tornSink.onDegrade });
  const rows = store.list('s2');
  assert.deepEqual(rows.map((row) => row.reviewId), ['s2:c1:1']);
  assert.equal(tornSink.rows.filter((row) => row.degraded === 'torn-line').length, 1);
  // 撕裂行不挡后续写入：追加前先补换行自愈，新记录不粘进残行，重放也不丢。
  assert.equal(await store.record(makeEntry({ sessionId: 's2', askedSeq: 3 })), true);
  await store.flush();
  assert.equal(store.list('s2').length, 2);
  assert.equal(createTraceStore({ dir }).list('s2').length, 2);
});

test('参数非法的 record 不落盘也不抛错', async (t) => {
  const dir = makeDir(t);
  const store = createTraceStore({ dir });
  assert.equal(await store.record({}), false);
  assert.equal(await store.record({ sessionId: '   ' }), false);
  await store.flush();
  assert.deepEqual(readdirSync(dir), []);
});

test('R41 内存侧会话键对齐 maxSessions：淘汰防「文件已删、内存残留」的重录漂移', async (t) => {
  const dir = makeDir(t);
  const store = createTraceStore({ dir, maxSessions: 2 });
  for (const key of ['a', 'b', 'c']) {
    await store.record(makeEntry({ sessionId: key, askedSeq: 1 }));
    await store.flush();
  }
  // c 建档触发磁盘清扫删 a、内存同步淘汰 a。现在重录 a：若内存残留（无 R41），行数记 2
  // → 不触发「首行清扫」→ 文件数超上限；内存已淘汰则 ensureLoaded 重读（无文件＝0 行）→ 首行 → 清扫照跑。
  await store.record(makeEntry({ sessionId: 'a', askedSeq: 2 }));
  await store.flush();
  const files = readdirSync(dir).sort();
  assert.ok(files.length <= 2, `文件数必须 ≤ maxSessions：${files.join(',')}`);
  assert.deepEqual(files, ['a.jsonl', 'c.jsonl']);
  assert.equal(readLines(join(dir, 'a.jsonl')).length, 1, '重录只落新行，不与已删旧窗口粘连');
  assert.equal(store.list('a').length, 1);
});
