/**
 * 一次性取证脚本：核对「同一 callId 上先出现审批请求、之后该调用仍以拒绝收场」是否存在。
 *
 * 判据：对每个 `approval/asked` 的 callId，向后找同 callId 的 `tool/result`，测其输出
 * （前 120 字符样本）含不含拒绝文本——isError 只随条目暂存，不参与判定，也不进最终打印。这直接回答
 * "审批过了还被沙箱拒"这种情形有没有。
 *
 * 用法：node tools/probe-approved-but-denied.mjs
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readSessionLog } from './session-log.mjs';

const root = join(homedir(), '.dsh', 'sessions');
const DENY_TEXT = /Access is denied|is denied|EPERM|denied under|sandboxDenial/u;
let asked = 0;
let withResult = 0;
const suspicious = [];

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
    /** callId → { asked, decided, result, tool } */
    const byCall = new Map();
    const touch = (id) => {
      const key = String(id);
      if (!byCall.has(key)) byCall.set(key, { asked: 0, decided: '', result: null, tool: '' });
      return byCall.get(key);
    };
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
      if (type === 'approval/asked') {
        const entry = touch(data?.callId);
        entry.asked += 1;
        entry.tool = String(data?.toolName ?? '');
      }
      if (type === 'approval/decided' && data?.callId !== undefined) touch(data.callId).decided = String(data?.outcome ?? '');
      if (type === 'tool/result') {
        const content = data?.message?.content?.[0];
        const callId = content?.toolCallId ?? data?.callId;
        if (callId === undefined) continue;
        const out = (content?.content ?? []).map((block) => block.text ?? '').join(' ');
        const entry = touch(callId);
        entry.result = { isError: content?.isError === true || /\[stderr\]/u.test(out), sample: out.replace(/\s+/gu, ' ').slice(0, 120) };
      }
    }
    for (const [callId, entry] of byCall) {
      if (entry.asked === 0) continue;
      asked += 1;
      if (entry.result === null) continue;
      withResult += 1;
      if (DENY_TEXT.test(entry.result.sample)) {
        suspicious.push({ session: session.replace(/^session-/u, ''), callId, tool: entry.tool, decided: entry.decided, sample: entry.result.sample });
      }
    }
  }
}

console.log(`带审批请求的 callId 总数: ${asked}`);
console.log(`其中能找到同 callId 工具结果的: ${withResult}`);
console.log(`审批过、结果里仍出现拒绝文本的: ${suspicious.length}\n`);
for (const item of suspicious.slice(0, 20)) {
  console.log(`- ${item.session}  tool=${item.tool}  decided=${item.decided}  callId=${item.callId}`);
  console.log(`    ${item.sample}`);
}
