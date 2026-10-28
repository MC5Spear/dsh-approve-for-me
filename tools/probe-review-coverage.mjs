/**
 * 取证脚本：把「会话日志里有审批事件」与「审查记录 JSONL 里有行」逐项核对，找出空记录会话。
 *
 * 会话枚举走共用读取器（`session.jsonl.zstd` 与 `session.vN.jsonl.zstd` 都认，每会话取当前代）；
 * 事件解析兼容 v4 事件包裹与一行多事件数组。
 * 用法：node tools/probe-review-coverage.mjs
 * 目标 home：优先 `DSH_HOME` 环境变量，未设置时回落 `~/.dsh`；
 * 实际使用的 home 打印在输出首行，不静默转向。
 * @module tools/probe-review-coverage
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { listSessionLogs, parseSessionEvents, readSessionLog } from './session-log.mjs';

/**
 * 对一个 home 全量核对审批事件与审查记录。
 * @param {string} home - DSH home 绝对路径。
 * @returns {Promise<Array<object>>} 每会话一行（error 行或统计行，字段见实现）。
 */
export async function reviewCoverage(home) {
  const sessionsRoot = join(home, 'sessions');
  const reviewsRoot = join(home, 'approve-for-me', 'reviews');
  const rows = [];
  for (const { workspace, session, file } of listSessionLogs(sessionsRoot)) {
    let text;
    try {
      text = readSessionLog(file);
    } catch (error) {
      rows.push({ session, workspace, error: String(error.message) });
      continue;
    }
    const asked = [];
    const decided = [];
    const { lines, events } = parseSessionEvents(text);
    for (const event of events) {
      if (event.type === 'approval/asked') asked.push({ seq: event.seq, ...event.data });
      if (event.type === 'approval/decided') decided.push({ seq: event.seq, ...event.data });
    }
    const id = session.replace(/^session-/u, '');
    const recordFile = join(reviewsRoot, `${id}.jsonl`);
    const records = existsSync(recordFile)
      ? readFileSync(recordFile, 'utf8').split('\n').filter((line) => line.trim().length > 0).length
      : 0;
    rows.push({
      session: id,
      workspace,
      file,
      lines,
      asked: asked.length,
      decided: decided.length,
      records,
      mismatch: asked.length > 0 && records < asked.length,
      askedIds: asked.map((a) => `${a.id}/${a.toolName}/${a.callId ?? '-'}`).slice(0, 6),
    });
  }
  rows.sort((a, b) => (a.file ?? '').localeCompare(b.file ?? ''));
  return rows;
}

/**
 * 命令行入口（可直接调用便于测试）。
 * @param {string[]} _args - 无位置参数。
 * @param {object} [env] - 环境变量（默认 `process.env`）。
 * @returns {Promise<{code: number, out: string[]}>} 退出码与输出行。
 */
export async function cli(_args, env = process.env) {
  const home = env.DSH_HOME ?? join(homedir(), '.dsh');
  const out = [`home=${home}`];
  const rows = await reviewCoverage(home);
  out.push('session                                 asked decided records  verdict');
  let errors = 0;
  for (const row of rows) {
    if (row.error !== undefined) {
      errors += 1;
      out.push(`${row.session}  ERROR ${row.error}`);
      continue;
    }
    const verdict =
      row.asked === 0 ? 'no-approval' : row.records >= row.asked ? 'ok' : `MISSING ${row.asked - row.records}`;
    out.push(
      `${row.session}  ${String(row.asked).padStart(5)} ${String(row.decided).padStart(7)} ${String(row.records).padStart(7)}  ${verdict}`,
    );
  }
  out.push('--- 有空缺的会话明细 ---');
  for (const row of rows.filter((item) => item.mismatch === true)) {
    out.push(`${row.session} asked=${row.asked} records=${row.records} :: ${row.askedIds.join(' | ')}`);
  }
  return { code: errors > 0 ? 1 : 0, out };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { code, out } = await cli(process.argv.slice(2));
  for (const line of out) console.log(line);
  process.exitCode = code;
}
