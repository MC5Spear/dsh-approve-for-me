/**
 * 一次性取证脚本：统计「某次调用以沙箱拒绝收场，且所选会话记录里同一 callId 未出现审批请求」的次数。
 *
 * 结论边界：这只说明所选记录中没有这些调用的审批记录。审批走了别的分支、记录不全或审批请求
 * 未分发都会呈现同样的观测形态，不能据此认定该工具没有提权路径。
 * 两种拒绝都统计：①结构化标记（[sandbox: …]，可信）；②裸文本（Access is denied / EPERM，启发式，算疑似）。
 *
 * 用法：node tools/probe-denied-without-approval.mjs
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readSessionLog } from './session-log.mjs';

const root = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions');
/** 结构化标记：dsh-sandbox 的固定词汇，可信。 */
const MARKER = /\[sandbox: /u;
/** 裸文本：启发式，只作为"疑似"。 */
const RAW = /Access is denied|is denied|EPERM|spawn EPERM/u;

const byTool = new Map();
const markerByTool = new Map();
const scenes = [];

for (const ws of readdirSync(root)) {
  const wsDir = join(root, ws);
  if (!statSync(wsDir).isDirectory()) continue;
  for (const session of readdirSync(wsDir)) {
    const dir = join(wsDir, session);
    if (!statSync(dir).isDirectory()) continue;
    const files = readdirSync(dir).filter(
      (name) => name === 'session.jsonl.zstd' || /^session\.v\d+\.jsonl\.zstd$/u.test(name),
    );
    if (files.length === 0) continue;
    let text;
    try {
      text = readSessionLog(join(dir, files[0]));
    } catch {
      continue;
    }
    const approved = new Set();
    const names = new Map();
    const denied = [];
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
      if (type === 'tool/call') names.set(String(data?.callId), String(data?.name ?? '?'));
      if (type === 'approval/asked' && data?.callId !== undefined) approved.add(String(data.callId));
      if (type !== 'tool/result') continue;
      const content = data?.message?.content?.[0];
      const callId = String(content?.toolCallId ?? data?.callId ?? '');
      const out = (content?.content ?? []).map((block) => block.text ?? '').join(' ');
      // 只在**这一次调用被判为错误**时才认裸文本：否则会把文件内容、grep 命中、
      // 测试输出里出现的 "denied" 全部误判成拒绝（实测：绝大多数命中来自这个来源）。
      const failed = content?.isError === true;
      const marker = MARKER.test(out);
      const raw = failed && RAW.test(out);
      if (!marker && !raw) continue;
      denied.push({ callId, marker, raw, out: out.replace(/\s+/gu, ' ').slice(0, 110) });
    }
    for (const item of denied) {
      const tool = names.get(item.callId) ?? '?';
      const asked = approved.has(item.callId);
      // 只统计所选记录里未见审批请求的那些，逐条留给人工核对来源。
      if (asked) continue;
      const bucket = byTool.get(tool) ?? { marker: 0, raw: 0 };
      bucket[item.marker ? 'marker' : 'raw'] += 1;
      byTool.set(tool, bucket);
      if (item.marker) markerByTool.set(tool, (markerByTool.get(tool) ?? 0) + 1);
      scenes.push({ session: session.replace(/^session-/u, ''), tool, marker: item.marker, out: item.out });
    }
  }
}

console.log('所选记录中被拒且同 callId 无审批请求的调用，按工具分组：\n');
console.log('工具            结构化标记  裸文本(疑似)');
for (const [tool, bucket] of [...byTool].sort((left, right) => right[1].marker + right[1].raw - (left[1].marker + left[1].raw))) {
  console.log(`${tool.padEnd(16)}${String(bucket.marker).padStart(8)}${String(bucket.raw).padStart(12)}`);
}
console.log(`\n合计: ${scenes.length} 次；其中结构化标记 ${scenes.filter((item) => item.marker).length} 次、裸文本 ${scenes.filter((item) => !item.marker).length} 次`);
console.log('\n裸文本样本（每工具一条）：');
const seen = new Set();
for (const item of scenes) {
  if (item.marker || seen.has(item.tool)) continue;
  seen.add(item.tool);
  console.log(`- ${item.tool}  ${item.out}`);
}
