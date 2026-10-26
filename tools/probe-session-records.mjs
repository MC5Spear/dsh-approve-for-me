/**
 * 一次性取证脚本：对指定会话，分别用「已部署的 store 直接 list()」与「原始文件行」两条路径读记录，
 * 判断空记录是「没写进去」还是「写进去了但读不出来」。
 *
 * 用法：node tools/probe-session-records.mjs <sessionId> [...]
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ids = process.argv.slice(2).map((id) => id.replace(/^session-/u, ''));
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const deployed = join(
  home,
  'profiles',
  'web',
  'node_modules',
  'dsh-approve-for-me',
  'lib',
  'trace-store.js',
);
const { createTraceStore } = await import(`file:///${deployed.replace(/\\/gu, '/')}`);
const dir = join(home, 'approve-for-me', 'reviews');

const store = createTraceStore({ dir, capture: 'full' });
for (const id of ids) {
  const file = join(dir, `${id}.jsonl`);
  const raw = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  const rows = store.list(id);
  console.log(`${id}`);
  console.log(`  file=${existsSync(file) ? `${lines.length} line(s)` : 'MISSING'}  list()=${rows.length}`);
  for (const line of lines) {
    const value = JSON.parse(line);
    console.log(`    reviewId=${value.reviewId} sessionId=${value.sessionId} decision=${value.decision}`);
  }
}
