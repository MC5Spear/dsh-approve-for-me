// R24 E2E 会话日志解码：打印 header、approval/policy、permission/preset、subagent 事件、工具调用概览。
// 用法：node tools/e2e-decode.mjs <会话目录或日志文件绝对路径>
import { readSessionLog } from './session-log.mjs';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const input = process.argv[2];
if (!input) {
  console.error('usage: node tools/e2e-decode.mjs <sessionDirOrFile>');
  process.exit(1);
}
let file = input;
try {
  if (statSync(input).isDirectory()) {
    const names = readdirSync(input).filter((n) => n.startsWith('session.'));
    names.sort();
    file = join(input, names[names.length - 1]);
  }
} catch {
  // 当文件处理
}
const lines = readSessionLog(file).split('\n').filter((line) => line.trim().length > 0);
console.log(`=== ${file}`);
const header = JSON.parse(lines[0]);
console.log(`header.id=${header.id} parentSession=${header.parentSession ?? '-'} delegationDepth=${header.delegationDepth ?? '-'}`);
const events = lines.slice(1).map((line) => JSON.parse(line));
for (const event of events) {
  const t = event.type;
  if (
    t === 'approval/policy' || t === 'permission/preset' || t === 'permission/knobs' ||
    t === 'subagent/descriptor' || t === 'session/end-seed'
  ) {
    console.log(`seq=${event.seq ?? '-'} ${t} ${JSON.stringify(event.data).slice(0, 240)}`);
  }
}
const toolNames = [];
for (const event of events) {
  const name = event.data?.name ?? event.data?.toolName ?? event.data?.tool?.name;
  if (typeof name === 'string' && (event.type.includes('tool') || event.type === 'assistant/message')) toolNames.push(name);
}
console.log(`(工具名序列: ${toolNames.join(' > ') || '-'}; 总事件 ${events.length})`);
console.log('尾部事件类型:', events.slice(-10).map((e) => `${e.seq ?? '?'}:${e.type}`).join(' '));
