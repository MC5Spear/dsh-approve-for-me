/**
 * 一次性取证脚本：对每个「进程创建被拒」现场，回放该会话事件流，
 * 取**失败那一刻生效的**沙箱模式/权限预设/审批策略（而不是整会话的最后值），
 * 并报告当次调用是否携带提权参数（`sandbox_permissions`）以及携带了什么参数。
 *
 * 用法：node tools/probe-exec-denied-timeline.mjs [--max 60]
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readSessionLog } from './session-log.mjs';

const maxIndex = process.argv.indexOf('--max');
const max = maxIndex >= 0 ? Number(process.argv[maxIndex + 1]) : 60;
const root = join(homedir(), '.dsh', 'sessions');
const DENIED_RE = /Program '([^']+)' failed to run: Access is denied/gu;

const rows = [];
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
    if (!text.includes('failed to run')) continue;

    let preset;
    let mode;
    let policy;
    const calls = new Map();
    /** 按发生顺序推进的状态快照：每次失败取「当时」的值。 */
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
      const time = value.time ?? value.event?.time;
      if (type === 'permission/preset') preset = String(data?.preset ?? '-');
      if (type === 'sandbox/mode') mode = String(data?.mode ?? '-');
      if (type === 'approval/policy') policy = String(data?.policy ?? '-');
      if (type === 'tool/call') calls.set(data?.callId, { name: data?.name, args: data?.arguments });
      if (type === 'tool/result') {
        const content = data?.message?.content?.[0];
        const callId = content?.toolCallId ?? data?.callId;
        const out = (content?.content ?? []).map((block) => block.text ?? '').join(' ');
        DENIED_RE.lastIndex = 0;
        const match = DENIED_RE.exec(out);
        if (match === null) continue;
        const call = calls.get(callId);
        let args = null;
        if (typeof call?.args === 'string') {
          try {
            args = JSON.parse(call.args);
          } catch {
            args = { raw: call.args.slice(0, 80) };
          }
        }
        const keys = args === null ? [] : Object.keys(args);
        const command = String(args?.command ?? '').replace(/\s+/gu, ' ').slice(0, 110);
        rows.push({
          session: session.replace(/^session-/u, ''),
          when: Number.isFinite(time) ? time : 0,
          preset,
          mode,
          policy,
          tool: call?.name ?? '-',
          program: match[1],
          hasEscalation: keys.includes('sandbox_permissions'),
          argKeys: keys.join(','),
          command,
        });
      }
    }
  }
}

rows.sort((left, right) => left.when - right.when);
console.log(`exec-denied scenes: ${rows.length}  (mode/preset are the values in force AT the failure)\n`);
console.log('when              preset              sandbox             policy  tool        program         esc?  cmd');
for (const row of rows.slice(0, max)) {
  console.log(
    [
      new Date(row.when).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }),
      String(row.preset).padEnd(19),
      String(row.mode).padEnd(19),
      String(row.policy).padEnd(7),
      String(row.tool).padEnd(11),
      String(row.program).padEnd(15),
      row.hasEscalation ? 'YES' : 'no',
      row.command,
    ].join(' '),
  );
}
const byMode = new Map();
for (const row of rows) byMode.set(row.mode, (byMode.get(row.mode) ?? 0) + 1);
console.log('\nby sandbox mode at failure:', [...byMode].map(([key, value]) => `${key}=${value}`).join('  '));
const byTool = new Map();
for (const row of rows) byTool.set(row.tool, (byTool.get(row.tool) ?? 0) + 1);
console.log('by tool:', [...byTool].map(([key, value]) => `${key}=${value}`).join('  '));
console.log('scenes whose args carried sandbox_permissions:', rows.filter((row) => row.hasEscalation).length);
