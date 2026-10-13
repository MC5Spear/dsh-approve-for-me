import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTraceStore, reviewIdOf } from '../lib/trace-store.js';

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
 * 组装一条完整的待落盘审查记录；`overrides` 覆盖任意字段（含用 `undefined` 抹掉）。
 * @param {object} [overrides] - 覆盖项。
 * @returns {object} 记录入参。
 */
function makeEntry(overrides = {}) {
  return {
    sessionId: 's1',
    kind: 'review',
    approvalId: 'a1',
    callId: 'c1',
    toolName: 'pwsh',
    origin: 'main',
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

test('reviewIdOf 四段规则：kind 与 approvalId 进键', () => {
  assert.equal(reviewIdOf('s1', 'c1', 'review', 'a1'), 's1:c1:review:a1');
  assert.equal(reviewIdOf('s1', undefined, 'settle', 'a1'), 's1:-:settle:a1');
  assert.equal(reviewIdOf('s1', 'c1', 'review', undefined, 1700000000999), 's1:c1:review:1700000000999');
});

test('写入后 list 读回：产品字段齐、JSONL 一行一条', async (t) => {
  const dir = makeDir(t);
  const store = createTraceStore({ dir });
  assert.equal(await store.record(makeEntry()), true);
  await store.flush();

  const rows = store.list('s1');
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.reviewId, 's1:c1:review:a1');
  assert.equal(row.kind, 'review');
  assert.equal(row.approvalId, 'a1');
  assert.equal(row.decision, 'allowed-once');
  assert.equal(row.model, 'zai/glm-5.3');
  assert.equal(row.effort, 'low');
  assert.equal(row.toolName, 'pwsh');
  assert.equal(row.origin, 'main');
  assert.equal(row.startedAt, 1700000000000);
  assert.equal(row.endedAt, 1700000000213);
  assert.equal(row.queueMs, 12);
  assert.equal(row.reviewMs, 201);

  const lines = readLines(join(dir, 's1.jsonl'));
  assert.equal(lines.length, 1);
  const onDisk = JSON.parse(lines[0]);
  assert.equal(onDisk.reviewId, 's1:c1:review:a1');
});

test('重启可见性：新实例从 JSONL 重放窗口，缺失会话返回空且不建文件', async (t) => {
  const dir = makeDir(t);
  const first = createTraceStore({ dir });
  for (let i = 1; i <= 3; i += 1) await first.record(makeEntry({ approvalId: `a${i}` }));
  await first.flush();

  const second = createTraceStore({ dir });
  const rows = second.list('s1');
  assert.deepEqual(
    rows.map((row) => row.reviewId),
    ['s1:c1:review:a1', 's1:c1:review:a2', 's1:c1:review:a3'],
  );
  assert.equal(second.approval('s1', 'a2').review.decision, 'allowed-once');
  assert.deepEqual(second.list('missing'), []);
  assert.equal(second.approval('missing', 'x'), null);
  assert.equal(second.degraded('missing'), false, '文件缺失是合法的没有历史，不算降级');
  assert.deepEqual(readdirSync(dir), ['s1.jsonl']);
});

test('同一 reviewId 不重复追加；review 与 settle 各一条', async (t) => {
  const dir = makeDir(t);
  const store = createTraceStore({ dir });
  assert.equal(await store.record(makeEntry()), true);
  assert.equal(await store.record(makeEntry({ decision: 'rejected' })), false);
  await store.flush();

  const lines = readLines(join(dir, 's1.jsonl'));
  assert.equal(lines.length, 1);
  assert.equal(store.list('s1').length, 1);
  // 同一审批的结算记录：kind 不同 → reviewId 不同 → 恰一条结算。
  assert.equal(await store.record(makeEntry({ kind: 'settle', outcome: 'allowed-once', source: 'llm' })), true);
  assert.equal(await store.record(makeEntry({ kind: 'settle', outcome: 'rejected', source: 'human' })), false);
  await store.flush();
  assert.equal(readLines(join(dir, 's1.jsonl')).length, 2);
  const pair = store.approval('s1', 'a1');
  assert.equal(pair.review.kind, 'review');
  assert.equal(pair.settle.kind, 'settle');
  assert.equal(pair.settle.source, 'llm', '重复结算不覆盖首条');
  // 去重看的是 reviewId：同会话同 approvalId 但不同 callId 是两条不同审批。
  assert.equal(await store.record(makeEntry({ callId: 'c2' })), true);
  await store.flush();
  assert.equal(readLines(join(dir, 's1.jsonl')).length, 3);
});

test('键位回退：callId 缺失用 -；approvalId 缺失落 startedAt', async (t) => {
  const dir = makeDir(t);
  const store = createTraceStore({ dir });
  await store.record(makeEntry({ callId: undefined }));
  await store.record(makeEntry({ callId: undefined, approvalId: undefined, startedAt: 1700000000999, sessionId: 's2' }));
  await store.flush();

  const [withId] = store.list('s1');
  assert.equal(withId.reviewId, 's1:-:review:a1');
  assert.equal(withId.callId, undefined);

  const [noId] = store.list('s2');
  assert.equal(noId.reviewId, 's2:-:review:1700000000999');
});

test('session- 前缀归一化：两种 id 形态指向同一文件与同一 approval 查询', async (t) => {
  const dir = makeDir(t);
  const store = createTraceStore({ dir });
  await store.record(makeEntry({ sessionId: 'session-abc', approvalId: 'a7' }));
  await store.flush();

  assert.deepEqual(readdirSync(dir), ['abc.jsonl']);
  assert.equal(store.list('abc')[0].reviewId, 'abc:c1:review:a7');
  assert.equal(store.approval('session-abc', 'a7').review.decision, 'allowed-once');
});

test('capture=off/summary 只落产品字段，full 才落详情', async (t) => {
  const dir = makeDir(t);
  const entry = makeEntry({ approvalId: 'a3' });
  await createTraceStore({ dir, capture: 'off' }).record({ ...entry, sessionId: 'off' });
  const summaryStore = createTraceStore({ dir, capture: 'summary' });
  await summaryStore.record({ ...entry, sessionId: 'sum' });
  const fullStore = createTraceStore({ dir, capture: 'full' });
  await fullStore.record({ ...entry, sessionId: 'full' });
  await Promise.all([summaryStore.flush(), fullStore.flush()]);

  for (const key of ['off', 'sum']) {
    const row = createTraceStore({ dir }).approval(key, 'a3').review;
    assert.equal(row.decision, 'allowed-once', `${key} 档应保留产品字段`);
    for (const field of ['prompt', 'input', 'reasoning', 'output']) {
      assert.equal(row[field], undefined, `${key} 档不应落 ${field}`);
    }
    assert.equal(row.truncated, false);
  }
  const full = fullStore.approval('full', 'a3').review;
  assert.equal(full.prompt, 'prompt text');
  assert.equal(full.input, 'input text');
  assert.equal(full.reasoning, 'reasoning text');
  assert.equal(full.output, 'output text');
});

test('full 档超 maxBytes 截断并置 truncated，多字节字符不切成残字', async (t) => {
  const dir = makeDir(t);
  const store = createTraceStore({ dir, capture: 'full', maxBytes: 16 });
  await store.record(makeEntry({ approvalId: 'a1', output: 'x'.repeat(64), reasoning: '密'.repeat(64) }));
  await store.flush();

  const row = store.approval('s1', 'a1').review;
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
  await store.record(makeEntry({ approvalId: 'a2', output: 'keep SECRET hidden' }));
  await store.flush();

  assert.ok(seen.some((text) => text.includes('SECRET')), '脱敏函数应见到详情原文');
  assert.equal(store.approval('s1', 'a2').review.output, 'keep *** hidden');
});

test('记录自带 truncated=true 时与详情截断并入场级标记', async (t) => {
  const dir = makeDir(t);
  const store = createTraceStore({ dir, capture: 'summary' });
  await store.record(makeEntry({ truncated: true }));
  await store.flush();
  assert.equal(store.approval('s1', 'a1').review.truncated, true);
});

test('并发 20 条写：串行队列不丢行、每行可解析、顺序即调用顺序', async (t) => {
  const dir = makeDir(t);
  const store = createTraceStore({ dir });
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => store.record(makeEntry({ approvalId: `a${i + 1}` }))),
  );
  assert.equal(results.filter(Boolean).length, 20);
  await store.flush();

  const lines = readLines(join(dir, 's1.jsonl'));
  assert.equal(lines.length, 20);
  const parsed = lines.map((line) => JSON.parse(line));
  assert.deepEqual(
    parsed.map((row) => row.reviewId),
    Array.from({ length: 20 }, (_, i) => `s1:c1:review:a${i + 1}`),
  );
  assert.equal(store.list('s1').length, 20);
});

test('行数超上限（maxRecords × 4）后重写只留窗口', async (t) => {
  const dir = makeDir(t);
  const store = createTraceStore({ dir, maxRecords: 5 });
  for (let i = 1; i <= 21; i += 1) await store.record(makeEntry({ approvalId: `a${i}` }));
  await store.flush();

  const lines = readLines(join(dir, 's1.jsonl'));
  assert.equal(lines.length, 5, '重写后文件只剩窗口大小');
  const ids = lines.map((line) => JSON.parse(line).reviewId);
  assert.deepEqual(ids, ['s1:c1:review:a17', 's1:c1:review:a18', 's1:c1:review:a19', 's1:c1:review:a20', 's1:c1:review:a21']);
  assert.deepEqual(
    store.list('s1').map((row) => row.reviewId),
    ids,
  );
  // 重写后的文件对后续写入与重放都还是正常 JSONL。
  await store.record(makeEntry({ approvalId: 'a22' }));
  await store.flush();
  assert.equal(readLines(join(dir, 's1.jsonl')).length, 6);
  assert.equal(createTraceStore({ dir, maxRecords: 5 }).list('s1').length, 5);
});

test('reviews/ 文件数超 maxSessions 删最旧', async (t) => {
  const dir = makeDir(t);
  const store = createTraceStore({ dir, maxSessions: 2 });
  for (const key of ['a', 'b', 'c', 'd']) {
    await store.record(makeEntry({ sessionId: key, approvalId: 'a1' }));
    await store.flush();
  }

  assert.deepEqual(readdirSync(dir).sort(), ['c.jsonl', 'd.jsonl']);
  // 内存侧与磁盘侧同数量级口径（design §8.3）——被淘汰会话的窗口一并回收，文件已删、重放为空；
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

test('读失败：返回空列表、审计 read-failed 且 degraded 为真；末行撕裂只丢末行、审计 torn-line 且 degraded 为真', async (t) => {
  const dir = makeDir(t);
  // JSONL 路径被目录占位：读得到错误（EISDIR，非 ENOENT），走读失败降级而不是「无历史」。
  mkdirSync(join(dir, 's1.jsonl'));
  const readSink = makeSink();
  const broken = createTraceStore({ dir, onDegrade: readSink.onDegrade });
  assert.deepEqual(broken.list('s1'), []);
  assert.equal(readSink.rows.filter((row) => row.degraded === 'read-failed').length, 1);
  assert.equal(broken.degraded('s1'), true, '读失败必须可观测（design §8.3）');

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
  assert.equal(store.degraded('s2'), true, '撕裂后窗口可能不完整');
  // 撕裂行不挡后续写入：追加前先补换行自愈，新记录不粘进残行，重放也不丢；
  // 但降级标记只在整文件重写成功后解除。
  assert.equal(await store.record(makeEntry({ sessionId: 's2', approvalId: 'a3' })), true);
  await store.flush();
  assert.equal(store.list('s2').length, 2);
  assert.equal(createTraceStore({ dir }).list('s2').length, 2);
  assert.equal(store.degraded('s2'), true, '追加自愈不清降级标记');
});

test('整文件重写成功后解除读取降级（design §8.3）', async (t) => {
  const dir = makeDir(t);
  writeFileSync(
    join(dir, 's1.jsonl'),
    `${JSON.stringify({ reviewId: 's1:c1:1', decision: 'rejected' })}\n{"reviewId":"s1:c1:2","decis`,
    'utf8',
  );
  const store = createTraceStore({ dir, maxRecords: 1 });
  assert.equal(store.degraded('s1'), true);
  // 行数超 maxRecords × 4 触发整文件重写：撕裂残迹一并消掉，降级解除。
  for (let i = 1; i <= 6; i += 1) await store.record(makeEntry({ approvalId: `a${i}` }));
  await store.flush();
  assert.equal(store.degraded('s1'), false);
  assert.equal(createTraceStore({ dir }).degraded('s1'), false);
});

test('旧格式行兼容：按字段缺失判定、合成 approvalId、独立成行、不写回', async (t) => {
  const dir = makeDir(t);
  // 旧键位：三段 reviewId（第三段是审批事件序号或开始时刻），无 kind 与 approvalId。
  const legacy = { reviewId: 's1:c1:5', callId: 'c1', toolName: 'pwsh', startedAt: 1700000000500, endedAt: 1700000000700, decision: 'allowed-once' };
  writeFileSync(join(dir, 's1.jsonl'), `${JSON.stringify(legacy)}\n`, 'utf8');
  const store = createTraceStore({ dir });

  const rows = store.list('s1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].approvalId, 's1:c1:5', '合成 approvalId＝该行自身 reviewId 全文');
  assert.equal(rows[0].kind, undefined, '读取不补写 kind');

  const pair = store.approval('s1', 's1:c1:5');
  assert.equal(pair.legacy.decision, 'allowed-once');
  assert.equal(pair.review, undefined);
  assert.equal(pair.settle, undefined);

  // 新记录落盘不与旧格式行合并（不同 approvalId），也不改写旧行。
  await store.record(makeEntry({ approvalId: 'a9' }));
  await store.flush();
  assert.equal(store.list('s1').length, 2);
  const pairNew = store.approval('s1', 'a9');
  assert.equal(pairNew.review.kind, 'review');
  const disk = readLines(join(dir, 's1.jsonl')).map((line) => JSON.parse(line));
  assert.equal(disk[0].reviewId, 's1:c1:5');
  assert.equal(disk[0].approvalId, undefined, '旧格式行不写回合成键');
});

test('参数非法的 record 不落盘也不抛错', async (t) => {
  const dir = makeDir(t);
  const store = createTraceStore({ dir });
  assert.equal(await store.record({}), false);
  assert.equal(await store.record({ sessionId: '   ' }), false);
  await store.flush();
  assert.deepEqual(readdirSync(dir), []);
});

test('内存侧会话键对齐 maxSessions（design §8.3）：淘汰防「文件已删、内存残留」的重录漂移', async (t) => {
  const dir = makeDir(t);
  const store = createTraceStore({ dir, maxSessions: 2 });
  for (const key of ['a', 'b', 'c']) {
    await store.record(makeEntry({ sessionId: key, approvalId: 'a1' }));
    await store.flush();
  }
  // c 建档触发磁盘清扫删 a、内存同步淘汰 a。现在重录 a：若内存残留，行数记 2
  // → 不触发「首行清扫」→ 文件数超上限；内存已淘汰则 ensureLoaded 重读（无文件＝0 行）→ 首行 → 清扫照跑。
  await store.record(makeEntry({ sessionId: 'a', approvalId: 'a2' }));
  await store.flush();
  const files = readdirSync(dir).sort();
  assert.ok(files.length <= 2, `文件数必须 ≤ maxSessions：${files.join(',')}`);
  assert.deepEqual(files, ['a.jsonl', 'c.jsonl']);
  assert.equal(readLines(join(dir, 'a.jsonl')).length, 1, '重录只落新行，不与已删旧窗口粘连');
  assert.equal(store.list('a').length, 1);
});

test('零预算回退（设计 §11/§8.2）：maxBytes=0 与 maxRecords=0 都回默认值，不裁空也不清零窗口', async (t) => {
  const dir = makeDir(t);
  // maxBytes=0：full 档单字段按默认预算裁剪，不把详情裁成空串。
  const store = createTraceStore({ dir, capture: 'full', maxBytes: 0 });
  await store.record(makeEntry({ prompt: 'p'.repeat(4096), output: 'o'.repeat(20000) }));
  await store.flush();
  const fullRow = store.list('s1')[0];
  assert.ok(fullRow.prompt.length > 100, `零字节预算回退默认预算：prompt 未被裁空（${fullRow.prompt.length}）`);
  assert.ok(fullRow.output.length > 100 && fullRow.output.length < 20000, '超默认预算的字段按默认值裁剪');
  assert.equal(fullRow.truncated, true, '按默认预算裁剪同样置 truncated');

  // maxRecords=0：窗口与磁盘行数上限按默认值工作，不清零、不无限。
  const dir2 = makeDir(t);
  const store2 = createTraceStore({ dir: dir2, maxRecords: 0 });
  for (let index = 0; index < 205; index += 1) {
    await store2.record(makeEntry({ approvalId: `a${index}`, callId: `c${index}` }));
  }
  await store2.flush();
  const window = store2.list('s1');
  assert.ok(window.length > 150 && window.length <= 200, `零窗口回退默认窗口（实得 ${window.length}）`);
  const diskLines = readLines(join(dir2, 's1.jsonl'));
  assert.ok(diskLines.length > 150 && diskLines.length <= 200 * 4, '磁盘行数在默认窗口×4 内');
});
