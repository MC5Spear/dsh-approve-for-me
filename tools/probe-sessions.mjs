/**
 * dsh 会话日志的只读探针。
 *
 * 两种模式，都直接读真实的会话日志容器（`session.jsonl.zstd` 与 `session.vN.jsonl.zstd`
 * 都认，每会话取当前代＝最高代）：
 *   node tools/probe-sessions.mjs <needle> [maxLinesPerSession]
 *       打印包含 <needle> 的 JSONL 行
 *   node tools/probe-sessions.mjs --events [typeFilter]
 *       统计每种事件 `type` 的出现次数，各附一行样本（v4 事件包裹与一行多事件数组都归一）
 *
 * 目标 home：优先 `DSH_HOME` 环境变量，未设置时回落 `~/.dsh`；
 * 实际使用的 home 打印在输出首行，不静默转向。
 * @module tools/probe-sessions
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { listSessionLogs, parseSessionEvents, readSessionLog } from './session-log.mjs';

const DSH_HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? homedir(), '.dsh');
const logs = listSessionLogs(join(DSH_HOME, 'sessions'));
const args = process.argv.slice(2);
console.log(`home=${DSH_HOME}`);

if (args[0] === '--events') {
  const filter = args[1];
  const census = new Map();
  for (const { file } of logs) {
    let parsed;
    try {
      parsed = parseSessionEvents(readSessionLog(file));
    } catch {
      continue;
    }
    for (const event of parsed.events) {
      const entry = census.get(event.type) ?? { count: 0, sample: '' };
      entry.count += 1;
      if (entry.sample.length === 0) entry.sample = JSON.stringify(event.data).slice(0, 300);
      census.set(event.type, entry);
    }
  }
  const rows = [...census.entries()]
    .filter(([type]) => filter === undefined || type.includes(filter))
    .sort((a, b) => b[1].count - a[1].count);
  for (const [type, entry] of rows) {
    console.log(`${String(entry.count).padStart(6)}  ${type}`);
    console.log(`        ${entry.sample}`);
  }
  console.log(`--- ${logs.length} sessions, ${rows.length} event types ---`);
} else {
  const needle = args[0] ?? 'approval/asked';
  const perSession = Number(args[1] ?? 4);
  let hits = 0;
  for (const { workspace, session, file } of logs) {
    let text;
    try {
      text = readSessionLog(file);
    } catch (error) {
      console.error(`skip ${session}: ${error.message}`);
      continue;
    }
    const lines = text.split('\n').filter((line) => line.includes(needle));
    if (lines.length === 0) continue;
    hits += lines.length;
    console.log(`=== ${workspace}/${session} (${lines.length} matches) ===`);
    for (const line of lines.slice(0, perSession)) console.log(line.slice(0, 400));
  }
  console.log(`--- ${logs.length} sessions scanned, ${hits} matches for "${needle}" ---`);
}
