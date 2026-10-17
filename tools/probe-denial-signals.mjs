/**
 * 一次性取证脚本：找出「撞墙」的调用在结果里留下的**可机械判定**的痕迹，
 * 用实测数据判断哪个信号既覆盖全、又噪声低。
 *
 * 对每个 [stderr] 或 isError 的调用，统计它命中了哪些候选信号：
 *   isError / content 里含 "[stderr]" / 含 "failed to run" / 含 "Access is denied"
 *   / 含 "[sandbox: " / 该工具 schema 是否带提权参数（静态，见 escalation-capable 列表）
 *
 * 用法：node tools/probe-denial-signals.mjs
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readSessionLog } from './session-log.mjs';

const root = join(homedir(), '.dsh', 'sessions');
/** 已知带提权参数的工具（静态判定，名单由本文件维护）。 */
const ESCALATION_CAPABLE = new Set(['pwsh', 'bash', 'write', 'read', 'edit', 'glob', 'grep', 'str_replace_editor']);
const SIGS = {
  isError: (content) => content?.isError === true,
  stderr: (content, out) => out.includes('[stderr]'),
  failedToRun: (content, out) => /failed to run/u.test(out),
  deniedText: (content, out) => /Access is denied|is denied|EPERM/u.test(out),
  sandboxMarker: (content, out) => out.includes('[sandbox: '),
};

const tally = new Map();
let scenes = 0;
const unsupportedHits = [];

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
    const names = new Map();
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
      if (type !== 'tool/result') continue;
      const content = data?.message?.content?.[0];
      const callId = String(content?.toolCallId ?? data?.callId ?? '');
      const out = (content?.content ?? []).map((block) => block.text ?? '').join(' ');
      const failed = SIGS.isError(content) || SIGS.stderr(content, out);
      if (!failed) continue;
      scenes += 1;
      const tool = names.get(callId) ?? '?';
      const bucket = tally.get(tool) ?? { n: 0, stderr: 0, failedToRun: 0, denied: 0, marker: 0, capable: ESCALATION_CAPABLE.has(tool) };
      bucket.n += 1;
      if (SIGS.stderr(content, out)) bucket.stderr += 1;
      if (SIGS.failedToRun(content, out)) bucket.failedToRun += 1;
      if (SIGS.deniedText(content, out)) bucket.denied += 1;
      if (SIGS.sandboxMarker(content, out)) bucket.marker += 1;
      tally.set(tool, bucket);
      if (SIGS.failedToRun(content, out) && !bucket.capable) {
        unsupportedHits.push({ session: session.replace(/^session-/u, ''), tool, out: out.replace(/\s+/gu, ' ').slice(0, 120) });
      }
    }
  }
}

console.log(`失败调用（isError 或含 [stderr]）总数: ${scenes}\n`);
console.log('工具          失败数  [stderr] failedToRun 拒绝文本 [sandbox:  有提权参数');
for (const [tool, b] of [...tally].sort((l, r) => r[1].n - l[1].n)) {
  console.log(
    `${tool.padEnd(14)}${String(b.n).padStart(6)}${String(b.stderr).padStart(9)}${String(b.failedToRun).padStart(12)}${String(b.denied).padStart(9)}${String(b.marker).padStart(10)}   ${b.capable ? '有' : '无'}`,
  );
}
console.log(`\n「failed to run」且工具无提权参数的现场: ${unsupportedHits.length} 条`);
for (const hit of unsupportedHits.slice(0, 8)) console.log(`- ${hit.tool.padEnd(12)} ${hit.out}`);
