/**
 * 一次性取证脚本：按会话目录名反查审核记录。
 *
 * 用法：node tools/probe-find-session.mjs <片段> [...]
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const fragments = process.argv.slice(2);
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const root = join(home, 'sessions');
const reviews = join(home, 'approve-for-me', 'reviews');

for (const ws of readdirSync(root)) {
  const wsDir = join(root, ws);
  if (!statSync(wsDir).isDirectory()) continue;
  for (const name of readdirSync(wsDir)) {
    if (!fragments.some((fragment) => name.includes(fragment))) continue;
    const dir = join(wsDir, name);
    if (!statSync(dir).isDirectory()) continue;
    const id = name.replace(/^session-/u, '');
    const file = join(reviews, `${id}.jsonl`);
    const rows = existsSync(file)
      ? readFileSync(file, 'utf8').split('\n').filter((line) => line.trim().length > 0)
      : [];
    console.log(`${name}  (workspace ${ws})`);
    console.log(`  reviews file: ${existsSync(file) ? `${rows.length} row(s)` : 'MISSING'}`);
    for (const row of rows) {
      const value = JSON.parse(row);
      console.log(
        `    ${new Date(value.startedAt).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })} ${value.toolName} ${value.decision} reviewMs=${value.reviewMs} callId=${value.callId}`,
      );
    }
  }
}
