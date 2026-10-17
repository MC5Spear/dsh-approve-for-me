/**
 * 一次性取证脚本：把「会话日志里有审批事件」与「审查记录 JSONL 里有行」逐项核对，找出空记录会话。
 *
 * 不是产品代码，也不进测试；只用来回答「为什么有的会话审查记录是空的」。
 * 用法：node tools/probe-review-coverage.mjs
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readSessionLog } from './session-log.mjs';

const home = join(homedir(), '.dsh');
const sessionsRoot = join(home, 'sessions');
const reviewsRoot = join(home, 'approve-for-me', 'reviews');

/** 枚举 workspace/session 目录。 */
function walk(root) {
  const out = [];
  for (const ws of readdirSync(root)) {
    const wsDir = join(root, ws);
    if (!statSync(wsDir).isDirectory()) continue;
    for (const session of readdirSync(wsDir)) {
      const dir = join(wsDir, session);
      if (!statSync(dir).isDirectory()) continue;
      const file = join(dir, 'session.jsonl.zstd');
      if (existsSync(file)) out.push({ workspace: ws, session, dir, file });
    }
  }
  return out;
}

const rows = [];
for (const entry of walk(sessionsRoot)) {
  let text;
  try {
    text = readSessionLog(entry.file);
  } catch (error) {
    rows.push({ ...entry, error: String(error.message) });
    continue;
  }
  const asked = [];
  const decided = [];
  let lines = 0;
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    lines += 1;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      const type = item?.type ?? item?.event?.type;
      const data = item?.data ?? item?.event?.data;
      if (type === 'approval/asked') asked.push({ seq: item.seq, ...data });
      if (type === 'approval/decided') decided.push({ seq: item.seq, ...data });
    }
  }
  const id = entry.session.replace(/^session-/, '');
  const file = join(reviewsRoot, `${id}.jsonl`);
  const recordLines = existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').filter((line) => line.trim().length > 0).length
    : 0;
  const mtime = statSync(entry.file).mtime;
  rows.push({
    session: id,
    workspace: entry.workspace,
    mtime,
    lines,
    asked: asked.length,
    decided: decided.length,
    records: recordLines,
    mismatch: asked.length > 0 && recordLines < asked.length,
    askedIds: asked.map((a) => `${a.id}/${a.toolName}/${a.callId ?? '-'}`).slice(0, 6),
  });
}

rows.sort((a, b) => (a.mtime < b.mtime ? -1 : 1));
console.log('session                                 asked decided records  verdict');
for (const row of rows) {
  if (row.error !== undefined) {
    console.log(`${row.session}  ERROR ${row.error}`);
    continue;
  }
  const verdict =
    row.asked === 0 ? 'no-approval' : row.records >= row.asked ? 'ok' : `MISSING ${row.asked - row.records}`;
  console.log(
    `${row.session}  ${String(row.asked).padStart(5)} ${String(row.decided).padStart(7)} ${String(row.records).padStart(7)}  ${verdict}`,
  );
}
console.log('\n--- 有空缺的会话明细 ---');
for (const row of rows.filter((item) => item.mismatch === true)) {
  console.log(`${row.session} asked=${row.asked} records=${row.records} :: ${row.askedIds.join(' | ')}`);
}
