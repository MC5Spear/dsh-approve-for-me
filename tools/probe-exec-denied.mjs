/**
 * 一次性取证脚本：全量扫会话日志，抽出所有「进程创建被拒」的现场
 * （PowerShell 的 `Program 'x' failed to run: Access is denied`），
 * 并附上该会话的沙箱模式、权限预设、以及该调用前后是否发生过审批。
 *
 * 用法：node tools/probe-exec-denied.mjs [--max 40]
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readSessionLog } from './session-log.mjs';

const maxIndex = process.argv.indexOf('--max');
const max = maxIndex >= 0 ? Number(process.argv[maxIndex + 1]) : 40;
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
    const file = join(dir, files[0]);
    let text;
    try {
      text = readSessionLog(file);
    } catch {
      continue;
    }
    if (!text.includes('failed to run')) continue;

    /** 事件流里与该会话有关的状态；preset/mode 取该会话最后一条事件的值（非失败时刻）。 */
    let preset = '-';
    let mode = '-';
    const calls = new Map();
    const approvals = [];
    const denials = [];
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
      if (type === 'permission/preset') preset = String(data?.preset ?? '-');
      if (type === 'sandbox/mode') mode = String(data?.mode ?? '-');
      if (type === 'tool/call') calls.set(data?.callId, { name: data?.name, args: data?.arguments, time });
      if (type === 'approval/asked') approvals.push({ kind: 'asked', time, callId: data?.callId, tool: data?.toolName });
      if (type === 'approval/decided') approvals.push({ kind: 'decided', time, callId: data?.callId });
      if (type === 'tool/result') {
        const content = data?.message?.content?.[0];
        const callId = content?.toolCallId ?? data?.callId;
        const out = (content?.content ?? []).map((block) => block.text ?? '').join(' ');
        DENIED_RE.lastIndex = 0;
        const match = DENIED_RE.exec(out);
        if (match !== null) {
          denials.push({ callId, program: match[1], time, seq, out: out.replace(/\s+/gu, ' ').slice(0, 180) });
        }
      }
    }
    for (const denial of denials) {
      const call = calls.get(denial.callId);
      let command = '';
      let tool = call?.name ?? '-';
      if (typeof call?.args === 'string') {
        try {
          command = String(JSON.parse(call.args).command ?? '').slice(0, 150);
        } catch {
          command = call.args.slice(0, 150);
        }
      }
      const nearby = approvals.filter(
        (item) => Number.isFinite(item.time) && Number.isFinite(denial.time) && Math.abs(item.time - denial.time) < 120000,
      );
      rows.push({
        session,
        when: denial.time,
        preset,
        mode,
        tool,
        program: denial.program,
        command,
        approvals: nearby.length === 0 ? 'none' : nearby.map((item) => `${item.kind}@${new Date(item.time).toISOString().slice(11, 19)}`).join(','),
      });
      // 调试信息：把命令与它后面的结果成对打印。
      rows[rows.length - 1].result = denial.out;
    }
  }
}

rows.sort((left, right) => (left.when ?? 0) - (right.when ?? 0));
console.log(`sessions/files scanned: all; exec-denied scenes: ${rows.length}\n`);
for (const row of rows.slice(0, max)) {
  console.log(`--- ${new Date(row.when).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })}  ${row.session.slice(0, 40)}`);
  console.log(`    preset=${row.preset}  sandbox=${row.mode}  tool=${row.tool}  program=${row.program}  approvals+/-2min=${row.approvals}`);
  console.log(`    cmd: ${row.command}`);
  console.log(`    out: ${row.result}`);
}
