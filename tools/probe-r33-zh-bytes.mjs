/**
 * zh 注入归属字节核对。
 *
 * 用法：node tools/probe-r33-zh-bytes.mjs <session.v4.jsonl.zstd> <审计 injectBytes>
 *
 * 判据（全部写进报告档并打印，任一不满足退出 1）：
 *  1) 会话日志存在 `source.kind='plugin:approve-for-me'` 的注入行（agent/inbox/spliced 与折叠 user/message）；
 *  2) 注入文本与 `allowText(fields,'zh')` 逐字节相等（head/工具/命令/理由/tail 模板结构核验）；
 *  3) 同 fields 的 en 模板与之不等（语言方向证明：不是 en 文本在凑数）；
 *  4) 注入文本 UTF-8 字节数＝审计行 `injectBytes`（无截断直存）；
 *  5) 该会话存在 turn/end（注入后本轮完成）。
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSessionLog } from './session-log.mjs';
import { allowText } from '../lib/gate.js';
import { outputDir } from './local-config.mjs';

const file = process.argv[2];
const auditBytes = Number(process.argv[3] ?? '0');
// 报告落点：显式传参 > 配置的 outputDir > 当前目录。
const out = process.argv[4] ?? join((await outputDir()) ?? '.', 'r33-zh-bytes.txt');
if (file === undefined) {
  console.error('用法：node tools/probe-r33-zh-bytes.mjs <session.v4.jsonl.zstd> <injectBytes> [out]');
  process.exit(2);
}

/** 递归收集一行 JSON 里含锚短语的全部字符串值（不假定 v4 行的字段名）。 */
function collectTexts(value, anchor, into) {
  if (typeof value === 'string') {
    if (value.includes(anchor)) into.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectTexts(item, anchor, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) collectTexts(value[key], anchor, into);
  }
}

const text = readSessionLog(file);
const rows = text.split('\n').filter((line) => line.length > 0);
const report = [`session log: ${file}`, `rows: ${rows.length}`, ''];

let turnEnds = 0;
const injected = [];
for (const line of rows) {
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    continue;
  }
  const kind = row?.type ?? row?.kind ?? row?.event ?? '?';
  if (String(kind).startsWith('turn/end') || String(kind).endsWith('/turn/end')) turnEnds += 1;
  if (JSON.stringify(row).includes('plugin:approve-for-me')) {
    const bodies = [];
    collectTexts(row, '已自动放行', bodies);
    if (bodies.length > 0) injected.push({ kind, body: bodies[bodies.length - 1] });
  }
}

report.push(`plugin-source rows with zh allow text: ${injected.length}`);
report.push(`turn/end rows: ${turnEnds}`, '');

const failures = [];
if (injected.length === 0) failures.push('未找到 plugin:approve-for-me 的 zh 放行注入行');
if (turnEnds === 0) failures.push('会话无 turn/end（注入后本轮未完成）');

const template = allowText({ tool: '§T§', command: '§C§', reason: '§R§' }, 'zh');
const parts = template.split('\n');
for (const { kind, body } of injected) {
  const lines = body.split('\n');
  const tool = lines[1]?.startsWith(parts[1].split('§T§')[0]) ? lines[1].slice(parts[1].split('§T§')[0].length) : undefined;
  const command = lines[2]?.startsWith(parts[2].split('§C§')[0]) ? lines[2].slice(parts[2].split('§C§')[0].length) : undefined;
  const reason = lines[3]?.startsWith(parts[3].split('§R§')[0]) ? lines[3].slice(parts[3].split('§R§')[0].length) : undefined;
  const expected = allowText({ tool, command, reason }, 'zh');
  const expectedEn = allowText({ tool, command, reason }, 'en');
  const bytes = Buffer.byteLength(body, 'utf8');
  const equal = body === expected;
  const differsFromEn = body !== expectedEn;
  if (!equal) failures.push(`${kind}: 注入文本与 zh 模板逐字节不等`);
  if (!differsFromEn) failures.push(`${kind}: 注入文本与 en 模板相等（语言方向存疑）`);
  if (auditBytes > 0 && bytes !== auditBytes) failures.push(`${kind}: 字节数 ${bytes} ≠ 审计 injectBytes ${auditBytes}`);
  report.push(`--- row kind=${kind} bytes=${bytes} ===zhTemplate:${equal} !==enTemplate:${differsFromEn}`);
  report.push(...lines.map((line) => `  | ${line}`));
  report.push(`  tool=${JSON.stringify(tool)}`);
  report.push(`  command=${JSON.stringify(command)}`);
  report.push(`  reason=${JSON.stringify(reason)}`);
  report.push('');
}

report.push(failures.length === 0 ? 'RESULT: PASS' : `RESULT: FAIL\n${failures.map((f) => `- ${f}`).join('\n')}`);
writeFileSync(out, report.join('\n'), 'utf8');
console.log(report.join('\n'));
process.exit(failures.length === 0 ? 0 : 1);
