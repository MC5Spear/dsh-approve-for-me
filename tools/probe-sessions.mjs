/**
 * Read-only probe over the dsh session logs.
 *
 * Two modes, both grounded in the real `session.jsonl.zstd` container:
 *   node tools/probe-sessions.mjs <needle> [maxLinesPerSession]
 *       print JSONL lines containing <needle>
 *   node tools/probe-sessions.mjs --events [typeFilter]
 *       census of every event `type` with counts and one sample line each
 *
 * @module tools/probe-sessions
 */
import { join } from 'node:path';
import { listSessionLogs, readSessionLog } from './session-log.mjs';

const DSH_HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');
const logs = listSessionLogs(join(DSH_HOME, 'sessions'));
const args = process.argv.slice(2);

if (args[0] === '--events') {
  const filter = args[1];
  const census = new Map();
  for (const { file } of logs) {
    let text;
    try {
      text = readSessionLog(file);
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const type = row?.type ?? '(no type)';
      const entry = census.get(type) ?? { count: 0, sample: line.slice(0, 300) };
      entry.count += 1;
      census.set(type, entry);
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
