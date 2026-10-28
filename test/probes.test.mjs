/**
 * 公开诊断工具的读取与统计判据。
 *
 * 夹具用真实 Zstandard 帧构造（每批次一个独立可解码帧、拼接成容器，与持久化后端同形），
 * 覆盖：实际命中、重复消息（inbox 与正式持久化同 id）、无命中、版本化命名（session.vN）、
 * 损坏文件与错误退出、无纪元时的可见降级。探针核心以模块导入直测；
 * 命令行包装的退出码经 cli() 判定，不起子进程。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import {
  currentSessionLog,
  listSessionLogs,
  messagesOfEvent,
  parseSessionEvents,
  sessionLogFiles,
} from '../tools/session-log.mjs';
import { analyzeSessionInjections, cli as r28Cli } from '../tools/probe-r28-zh-inject.mjs';
import { cli as reviewCli, reviewCoverage } from '../tools/probe-review-coverage.mjs';
import { approvalCoverage, cli as approvalCli } from '../tools/probe-approval-coverage.mjs';

/** 把 JSONL 行按批次压成拼接帧容器写盘，返回文件路径。 */
function writeZstdLog(file, batches) {
  const chunks = batches.map((lines) => zstdCompressSync(Buffer.from(`${lines.join('\n')}\n`, 'utf8')));
  writeFileSync(file, Buffer.concat(chunks));
  return file;
}

/** 一条插件注入消息（v4 消息形状：id/role/content/source）。 */
function pluginMessage(id, text) {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text: text ?? `[approve-for-me] 已放行：hello（预览 12 字符）` }],
    source: { kind: 'plugin:approve-for-me' },
  };
}

/** 建一个含 sessions/<ws>/<session> 目录结构的临时 home。 */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsafm-probes-'));
  return home;
}

test('sessionLogFiles/currentSessionLog：版本化命名与当前代选择', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsafm-slog-'));
  try {
    writeZstdLog(join(dir, 'session.jsonl.zstd'), [['{"type":"a"}']]);
    writeZstdLog(join(dir, 'session.v4.jsonl.zstd'), [['{"type":"b"}']]);
    writeZstdLog(join(dir, 'session.v2.jsonl.zstd'), [['{"type":"c"}']]);
    writeFileSync(join(dir, 'session-notes.txt'), 'x');
    writeFileSync(join(dir, 'session.jsonl'), '{"type":"raw"}');

    const files = sessionLogFiles(dir);
    assert.deepEqual(
      files.map((entry) => entry.generation),
      [0, 2, 4],
      '按代升序，未版本化算第 0 代；原始 jsonl 与杂项文件不认',
    );
    assert.equal(currentSessionLog(dir).generation, 4, '当前代＝最高 vN');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listSessionLogs：v4 命名的会话日志照常枚举', () => {
  const home = makeHome();
  try {
    const dir = join(home, 'sessions', 'ws-a', 'session-abc');
    mkdirSync(dir, { recursive: true });
    writeZstdLog(join(dir, 'session.v4.jsonl.zstd'), [['{"type":"a"}']]);
    const logs = listSessionLogs(join(home, 'sessions'));
    assert.equal(logs.length, 1, 'v4 命名的会话日志要被枚举到');
    assert.deepEqual([logs[0].workspace, logs[0].session, logs[0].generation], ['ws-a', 'session-abc', 4]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('parseSessionEvents：平铺行、事件信封与数组行都归一，损坏行计入行数不产事件', () => {
  const text = [
    JSON.stringify({ seq: 1, time: 10, type: 'session/header', data: { id: 's' } }),
    JSON.stringify({ seq: 2, time: 20, type: 'user/message', data: pluginMessage('m1') }),
    JSON.stringify({ event: { seq: 3, time: 30, type: 'approval/asked', data: { id: 'ap1' } } }),
    JSON.stringify([
      { seq: 4, time: 40, type: 'approval/decided', data: { id: 'ap1' } },
      { seq: 5, type: 'assistant/message', data: { message: { id: 'a1', role: 'assistant' } } },
    ]),
    '{broken json',
    '',
  ].join('\n');
  const { lines, events } = parseSessionEvents(text);
  assert.equal(lines, 5, '非空行数＝5（含损坏行）');
  assert.deepEqual(
    events.map((event) => event.type),
    ['session/header', 'user/message', 'approval/asked', 'approval/decided', 'assistant/message'],
    '三种物理形态归一为事件，损坏行跳过',
  );
  assert.equal(events[2].time, 30, '信封行取 event 内字段');
  assert.equal(events[3].data.id, 'ap1', '数组行逐项归一');
});

test('messagesOfEvent：声明式消息遍历口径', () => {
  const message = pluginMessage('m1');
  assert.deepEqual(messagesOfEvent({ type: 'user/message', data: message }), [message], 'user/message 的 data 即消息');
  const assistant = { id: 'a1', role: 'assistant', content: [] };
  assert.deepEqual(messagesOfEvent({ type: 'assistant/message', data: { message: assistant } }), [assistant]);
  assert.deepEqual(messagesOfEvent({ type: 'agent/inbox/spliced', data: { inserted: [message] } }), [message]);
  assert.deepEqual(messagesOfEvent({ type: 'session/title-llm-request', data: { messages: [assistant] } }), [assistant]);
  assert.deepEqual(messagesOfEvent({ type: 'tool/call', data: {} }), [], '非消息事件为空');
});

test('analyzeSessionInjections：命中、inbox/持久化重复去重与读数口径', () => {
  const home = makeHome();
  try {
    const dir = join(home, 'sessions', 'ws', 'session-hit');
    mkdirSync(dir, { recursive: true });
    const m1 = pluginMessage('m1');
    const m2 = pluginMessage('m2', '[approve-for-me] 已拒绝：rm -rf /（命中强制拒绝）');
    writeZstdLog(join(dir, 'session.jsonl.zstd'), [
      [
        JSON.stringify({ type: 'session/header', data: {} }),
        JSON.stringify({ seq: 2, time: 20, type: 'agent/inbox/spliced', data: { inserted: [m1] } }),
      ],
      [
        JSON.stringify({ seq: 3, time: 30, type: 'user/message', data: m1 }),
        JSON.stringify({ seq: 4, time: 40, type: 'user/message', data: m2 }),
        JSON.stringify({ seq: 5, time: 50, type: 'user/message', data: { id: 'u1', role: 'user', content: [], source: { kind: 'user' } } }),
      ],
    ]);
    const { files, injected } = analyzeSessionInjections(dir);
    assert.equal(files[0].lines, 5, '行数＝JSONL 行数，不是字符数');
    assert.equal(files[0].pluginMessages, 3, '插件源消息事件数＝3（m1 两次＋m2 一次）');
    assert.equal(injected.length, 2, '同 id 的 inbox 与持久化重复去重后＝2 条');
    const viaM1 = injected.find((entry) => entry.id === 'm1');
    assert.deepEqual(viaM1.via.sort(), ['agent/inbox/spliced', 'user/message'], 'via 记录两种出现位置');
    assert.equal(viaM1.zh, true, 'zh 判定＝前缀＋汉字');
    assert.equal(injected.every((entry) => entry.kind === 'plugin:approve-for-me'), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('analyzeSessionInjections：无命中会话与损坏文件的可见降级', () => {
  const home = makeHome();
  try {
    const empty = join(home, 'sessions', 'ws', 'session-none');
    mkdirSync(empty, { recursive: true });
    writeZstdLog(join(empty, 'session.jsonl.zstd'), [[
      JSON.stringify({ seq: 1, type: 'user/message', data: { id: 'u1', role: 'user', content: [], source: { kind: 'user' } } }),
    ]]);
    const none = analyzeSessionInjections(empty);
    assert.equal(none.injected.length, 0, '无命中：injected=0 不是事件计数');

    const broken = join(home, 'sessions', 'ws', 'session-bad');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'session.jsonl.zstd'), Buffer.from('definitely not zstd'));
    const bad = analyzeSessionInjections(broken);
    assert.match(bad.files[0].error, /corrupt Zstandard session log/u, '损坏文件留下可见错误');
    assert.equal(bad.injected.length, 0);

    const usage = r28Cli([]);
    assert.equal(usage.code, 2, '用法错误退出码 2');
    const missing = r28Cli([join(home, 'sessions'), 'session-nope']);
    assert.equal(missing.code, 1, '会话缺失退出码 1');
    const errored = r28Cli([join(home, 'sessions', 'ws'), 'session-bad']);
    assert.equal(errored.code, 1, '读失败退出码 1');
    assert.ok(errored.out.some((line) => line.includes('ERROR')), '错误行可见');
    const fine = r28Cli([join(home, 'sessions', 'ws'), 'session-none']);
    assert.equal(fine.code, 0, '无命中但可读：退出码 0');
    assert.ok(fine.out.some((line) => line.includes('injected=0')), '无命中读数可见');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('reviewCoverage：审批事件对审查记录核对与 DSH_HOME 贯穿', async () => {
  const home = makeHome();
  try {
    const dir = join(home, 'sessions', 'ws', 'session-cov');
    mkdirSync(dir, { recursive: true });
    writeZstdLog(join(dir, 'session.jsonl.zstd'), [[
      JSON.stringify({ seq: 1, time: 1000, type: 'approval/asked', data: { id: 'a1', toolName: 'bash' } }),
      JSON.stringify({ event: { seq: 2, time: 2000, type: 'approval/asked', data: { id: 'a2', toolName: 'bash' } } }),
      JSON.stringify({ seq: 3, time: 3000, type: 'approval/decided', data: { id: 'a1' } }),
    ]]);
    mkdirSync(join(home, 'approve-for-me', 'reviews'), { recursive: true });
    writeFileSync(join(home, 'approve-for-me', 'reviews', 'cov.jsonl'), '{"v":1}\n');

    const rows = await reviewCoverage(home);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].asked, 2, '信封包裹的审批事件也计入');
    assert.equal(rows[0].decided, 1);
    assert.equal(rows[0].records, 1);
    assert.equal(rows[0].mismatch, true, '记录少于 asked 报缺口');

    const cli = await reviewCli([], { DSH_HOME: home });
    assert.equal(cli.out[0], `home=${home}`, '输出首行声明实际目标 home');
    assert.ok(cli.out.some((line) => line.includes('MISSING 1')), '缺口行可见');
    assert.equal(cli.code, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('approvalCoverage：纪元显式参数化与缺口判定', async () => {
  const home = makeHome();
  try {
    const dir = join(home, 'sessions', 'ws', 'session-epoch');
    mkdirSync(dir, { recursive: true });
    writeZstdLog(join(dir, 'session.v4.jsonl.zstd'), [[
      JSON.stringify({ seq: 1, time: 1000, type: 'approval/asked', data: { id: 'a1', toolName: 'bash' } }),
      JSON.stringify({ seq: 2, time: 9000, type: 'approval/asked', data: { id: 'a2', toolName: 'bash' } }),
    ]]);
    mkdirSync(join(home, 'approve-for-me', 'reviews'), { recursive: true });

    const base = await approvalCoverage({ home });
    assert.equal(base.rows.length, 1, 'v4 命名会话被扫到');
    assert.equal(base.rows[0].asked, 2);
    assert.equal(base.missing, 1, '无记录且无纪元：报缺口');

    const withEpoch = await approvalCoverage({ home, epochMs: 5000 });
    assert.equal(withEpoch.rows[0].preEpoch, false, '9000 的审批晚于纪元，不豁免');
    assert.equal(withEpoch.missing, 1);

    const allPre = await approvalCoverage({ home, epochMs: 10000 });
    assert.equal(allPre.rows[0].preEpoch, true, '全部审批早于纪元：预期为空');
    assert.equal(allPre.missing, 0);

    const badEpoch = await approvalCli(['--trace-epoch', 'not-a-date'], { DSH_HOME: home });
    assert.equal(badEpoch.code, 2, '不可解析纪元退出码 2');
    const goodEpoch = await approvalCli(['--trace-epoch', '1970-01-01T00:00:05Z'], { DSH_HOME: home });
    assert.equal(goodEpoch.code, 0);
    assert.ok(goodEpoch.out.some((line) => line.includes('MISSING(no epoch)') === false), '给出纪元后不落无纪元降级');
    assert.ok(goodEpoch.out.some((line) => line.includes('MISSING')), '晚于纪元的缺口仍可见');
    const noEpoch = await approvalCli([], { DSH_HOME: home });
    assert.ok(noEpoch.out.some((line) => line.includes('MISSING(no epoch)')), '未给纪元时可见降级标注');
    assert.equal(noEpoch.out[0], `home=${home}`, '输出首行声明实际目标 home');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
