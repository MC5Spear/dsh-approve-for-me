/**
 * 一次性取证脚本：全量扫描 `~/.dsh/sessions`（两种会话文件布局都要认），
 * 把「有 approval/asked 的会话」与「插件 reviews 目录里的行数」对齐，
 * 并按审批时间分类，判断空记录是「历史盲区」还是「记录没落上」。
 *
 * 用法：node tools/probe-approval-coverage.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readSessionLog } from './session-log.mjs';

const home = join(homedir(), '.dsh');
const sessionsRoot = join(home, 'sessions');
const reviewsRoot = join(home, 'approve-for-me', 'reviews');
/** 记录能力的起点：lib/trace-store.js 落盘时间（本仓库实测）。 */
const TRACE_EPOCH = Date.parse('2026-09-11T20:15:00+08:00');

/** 收集一个会话目录下的会话文件（v3 与旧命名都认）。 */
function sessionFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'session.jsonl.zstd' || /^session\.v\d+\.jsonl\.zstd$/u.test(name)) {
      out.push(join(dir, name));
    }
  }
  return out;
}

const rows = [];
for (const ws of readdirSync(sessionsRoot)) {
  const wsDir = join(sessionsRoot, ws);
  if (!statSync(wsDir).isDirectory()) continue;
  for (const session of readdirSync(wsDir)) {
    const dir = join(wsDir, session);
    if (!statSync(dir).isDirectory()) continue;
    const files = sessionFiles(dir);
    if (files.length === 0) continue;
    const file = files[0];
    let text;
    try {
      text = readSessionLog(file);
    } catch (error) {
      rows.push({ session, error: String(error.message) });
      continue;
    }
    const asked = [];
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const type = value.type ?? value.event?.type;
      const data = value.data ?? value.event?.data;
      if (type === 'approval/asked') asked.push({ time: value.time ?? value.event?.time ?? 0, ...data });
    }
    if (asked.length === 0) continue;
    const id = session.replace(/^session-/u, '');
    const recFile = join(reviewsRoot, `${id}.jsonl`);
    const records = existsSync(recFile)
      ? readFileSync(recFile, 'utf8').split('\n').filter((line) => line.trim().length > 0).length
      : 0;
    rows.push({
      session: id,
      file: file.split(/[\\/]/u).pop(),
      mtime: statSync(file).mtime,
      asked: asked.length,
      records,
      firstAsked: asked[0].time,
      lastAsked: asked[asked.length - 1].time,
      preEpoch: asked.every((item) => item.time < TRACE_EPOCH),
      sample: asked.map((item) => `${item.toolName}/${item.callId ?? '-'}`).slice(0, 3),
    });
  }
}

rows.sort((a, b) => a.firstAsked - b.firstAsked);
const fmt = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
console.log('approvals that predate the record capability are expected to be empty.\n');
console.log('session                                  asked rec  first approval        last approval         verdict');
for (const row of rows) {
  if (row.error !== undefined) {
    console.log(`${row.session}  ERROR ${row.error}`);
    continue;
  }
  const verdict =
    row.records >= row.asked ? 'ok' : row.preEpoch ? 'pre-epoch(expect empty)' : 'MISSING';
  console.log(
    `${row.session}  ${String(row.asked).padStart(5)} ${String(row.records).padStart(3)}  ${fmt(row.firstAsked)}  ${fmt(row.lastAsked)}  ${verdict}`,
  );
}
const missing = rows.filter((row) => row.error === undefined && row.records < row.asked && row.preEpoch !== true);
console.log(`\ntotal sessions with approvals: ${rows.length}; not-covered and post-epoch: ${missing.length}`);
for (const row of missing) {
  console.log(`  ${row.session} asked=${row.asked} records=${row.records} :: ${row.sample.join(' | ')}`);
}
