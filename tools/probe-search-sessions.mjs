/**
 * 一次性取证脚本：在会话日志里全文检索一个片段，定位是哪次会话/哪一步产生的。
 *
 * 认两种会话文件命名（`session.jsonl.zstd` 与 `session.v<N>.jsonl.zstd`）。
 * 用法：node tools/probe-search-sessions.mjs <片段> [--context 200]
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readSessionLog } from './session-log.mjs';

const needle = process.argv[2];
if (needle === undefined || needle.length === 0) {
  console.error('usage: node tools/probe-search-sessions.mjs <needle>');
  process.exit(2);
}
const ctxIndex = process.argv.indexOf('--context');
const ctx = ctxIndex >= 0 ? Number(process.argv[ctxIndex + 1]) : 160;
const root = join(homedir(), '.dsh', 'sessions');

/** 只认 session.jsonl.zstd 与 session.v<N>.jsonl.zstd 两种命名，其余文件忽略。 */
function sessionFiles(dir) {
  return readdirSync(dir)
    .filter((name) => name === 'session.jsonl.zstd' || /^session\.v\d+\.jsonl\.zstd$/u.test(name))
    .map((name) => join(dir, name));
}

const hits = [];
for (const ws of readdirSync(root)) {
  const wsDir = join(root, ws);
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
    } catch {
      continue;
    }
    let index = text.indexOf(needle);
    let count = 0;
    const samples = [];
    while (index >= 0 && count < 3) {
      samples.push(text.slice(Math.max(0, index - ctx), index + needle.length + ctx).replace(/\s+/gu, ' '));
      count += 1;
      index = text.indexOf(needle, index + needle.length);
    }
    if (count === 0) continue;
    let total = 0;
    let cursor = text.indexOf(needle);
    while (cursor >= 0) {
      total += 1;
      cursor = text.indexOf(needle, cursor + needle.length);
    }
    hits.push({ session, mtime: statSync(file).mtime, total, samples, bytes: text.length });
  }
}

hits.sort((left, right) => right.mtime - left.mtime);
console.log(`needle: ${JSON.stringify(needle)}  sessions with hits: ${hits.length}\n`);
for (const hit of hits.slice(0, 12)) {
  console.log(`--- ${hit.session}  ${hit.mtime.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })}  hits=${hit.total}  bytes=${hit.bytes}`);
  for (const sample of hit.samples) console.log(`    ${sample.slice(0, 400)}`);
}
