/**
 * 一次性取证脚本：打印某会话里一次工具调用的完整现场——命令、审批事件、结果、
 * 以及该次调用前后的沙箱相关事件。
 *
 * 用法：node tools/probe-call-detail.mjs <sessionId> <callId>
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readSessionLog } from './session-log.mjs';

const [rawSession, callId] = process.argv.slice(2);
const session = (rawSession ?? '').replace(/^session-/u, '');
if (session === '' || callId === undefined) {
  console.error('usage: node tools/probe-call-detail.mjs <sessionId> <callId>');
  process.exit(2);
}
const root = join(homedir(), '.dsh', 'sessions');

let file;
for (const ws of readdirSync(root)) {
  const dir = join(root, ws, `session-${session}`);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
  for (const name of readdirSync(dir)) {
    if (name === 'session.jsonl.zstd' || /^session\.v\d+\.jsonl\.zstd$/u.test(name)) file = join(dir, name);
  }
}
if (file === undefined) {
  console.error(`session not found: ${session}`);
  process.exit(1);
}
console.log(`file: ${file}\n`);

const text = readSessionLog(file);
let seq = 0;
for (const line of text.split('\n')) {
  if (line.trim().length === 0) continue;
  seq += 1;
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    continue;
  }
  const type = value.type ?? value.event?.type;
  const data = value.data ?? value.event?.data;
  const time = value.time ?? value.event?.time;
  const stamp = Number.isFinite(time) ? new Date(time).toISOString() : '-';
  const relevant =
    (type === 'tool/call' && data?.callId === callId) ||
    (type === 'tool/result' && data?.callId === callId) ||
    (type === 'approval/asked' && data?.callId === callId) ||
    (type === 'approval/decided' && data?.callId === callId) ||
    type === 'sandbox/mode' ||
    type === 'permission/preset' ||
    type === 'approval/policy';
  if (!relevant) continue;
  console.log(`--- [${seq}] ${stamp} ${type}`);
  console.log(JSON.stringify(data, null, 2).slice(0, 2200));
  console.log('');
}
