// dump tool/call + tool/result 详情（端到端诊断用）。
// 用法：node tools/e2e-tools.mjs <会话目录>
import { readSessionLog } from './session-log.mjs';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const input = process.argv[2];
let file = input;
if (statSync(input).isDirectory()) {
  const names = readdirSync(input).filter((n) => n.startsWith('session.'));
  names.sort();
  file = join(input, names[names.length - 1]);
}
const lines = readSessionLog(file).split('\n').filter((l) => l.trim());
const events = lines.slice(1).map((l) => JSON.parse(l));
for (const event of events) {
  if (event.type !== 'tool/call' && event.type !== 'tool/result') continue;
  const data = JSON.stringify(event.data);
  console.log(`seq=${event.seq} ${event.type}: ${data.slice(0, 600)}`);
}
