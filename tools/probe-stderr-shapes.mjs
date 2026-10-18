/**
 * 一次性取证脚本：为「有副作用但无提权参数」的工具，统计其 [stderr] 输出的首行分布，
 * 用来判断「用 [stderr] 当撞墙信号」的噪声率是否可接受。
 *
 * 用法：node tools/probe-stderr-shapes.mjs
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readSessionLog } from './session-log.mjs';

const root = join(homedir(), '.dsh', 'sessions');
/** 有副作用、且静态判定**没有**提权参数的工具 —— 这才是我们覆盖不到的集合
 *  （近似名单，随宿主版本漂移；run_code 的 PTC 控制参数带 `sandbox_permissions`、
 *  async_run 经本机宿主树核实无此工具名——均不列）。 */
const SIDE_EFFECT_UNSUPPORTED = new Set(['str_replace_editor', 'tool-bash-persistent', 'tool-pwsh-persistent']);

const shapes = new Map();
let total = 0;
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
      const tool = names.get(callId) ?? '?';
      if (!SIDE_EFFECT_UNSUPPORTED.has(tool)) continue;
      const out = (content?.content ?? []).map((block) => block.text ?? '').join(' ');
      if (!out.includes('[stderr]')) continue;
      total += 1;
      // 取 [stderr] 之后的第一行作为形状。
      const tail = out.slice(out.indexOf('[stderr]') + 8).trim();
      const firstLine = (tail.split(/\r?\n/u)[0] ?? '').trim().slice(0, 78);
      // 归并：把程序名/路径替换成占位符，露出形状。
      const shape = firstLine
        .replace(/[A-Za-z]:\\[^\s']+/gu, '<path>')
        .replace(/'[^']*'/gu, '<q>')
        .replace(/\d+/gu, '<n>');
      const key = `${tool} | ${shape}`;
      shapes.set(key, (shapes.get(key) ?? 0) + 1);
    }
  }
}

console.log(`「有副作用但无提权参数」的工具里含 [stderr] 的调用总数: ${total}\n`);
console.log('形状分布（前 20）：');
for (const [key, count] of [...shapes].sort((left, right) => right[1] - left[1]).slice(0, 20)) {
  console.log(`${String(count).padStart(5)}  ${key}`);
}
