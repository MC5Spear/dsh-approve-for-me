/**
 * 取证脚本：全量扫描会话目录（`session.jsonl.zstd` 与 `session.vN.jsonl.zstd` 都认，
 * 每会话取当前代＝最高代），把「有 approval/asked 的会话」与「插件 reviews 目录里的行数」
 * 逐项核对，并按审批时间分类，判断空记录是「早于记录功能启用」还是「记录没落上」。
 *
 * 记录功能启用时间不是本工具可以替用户假设的事实：需要按时间分类时用
 * `--trace-epoch <ISO8601>` 显式给出（例如该部署里 `reviews/` 目录最早一行的落盘时间）；
 * 未给出时不做「早于启用」豁免，缺口一律报 MISSING(no epoch)。
 * 用法：node tools/probe-approval-coverage.mjs [--trace-epoch 2026-09-11T20:15:00+08:00]
 * 目标 home：优先 `DSH_HOME` 环境变量，未设置时回落 `~/.dsh`；
 * 实际使用的 home 打印在输出首行，不静默转向。
 * @module tools/probe-approval-coverage
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { currentSessionLog, parseSessionEvents, readSessionLog } from './session-log.mjs';

/**
 * 对一个 home 统计审批覆盖。
 * @param {object} options - 选项。
 * @param {string} options.home - DSH home 绝对路径。
 * @param {number} [options.epochMs] - 记录功能启用时刻（毫秒）；缺省时不做早于启用豁免。
 * @returns {Promise<{rows: Array<object>, sessions: number, missing: number}>} 每个含审批会话一行与缺口汇总。
 */
export async function approvalCoverage({ home, epochMs }) {
  const sessionsRoot = join(home, 'sessions');
  const reviewsRoot = join(home, 'approve-for-me', 'reviews');
  const rows = [];
  if (!existsSync(sessionsRoot)) return { rows, sessions: 0, missing: 0 };
  for (const ws of readdirSync(sessionsRoot)) {
    const wsDir = join(sessionsRoot, ws);
    if (!statSync(wsDir).isDirectory()) continue;
    for (const session of readdirSync(wsDir)) {
      const dir = join(wsDir, session);
      if (!statSync(dir).isDirectory()) continue;
      const current = currentSessionLog(dir);
      if (current === undefined) continue;
      const { file } = current;
      let text;
      try {
        text = readSessionLog(file);
      } catch (error) {
        rows.push({ session, file, error: String(error.message) });
        continue;
      }
      const asked = [];
      for (const event of parseSessionEvents(text).events) {
        if (event.type === 'approval/asked') asked.push({ time: event.time ?? 0, ...event.data });
      }
      if (asked.length === 0) continue;
      const id = session.replace(/^session-/u, '');
      const recordFile = join(reviewsRoot, `${id}.jsonl`);
      const records = existsSync(recordFile)
        ? readFileSync(recordFile, 'utf8').split('\n').filter((line) => line.trim().length > 0).length
        : 0;
      const times = asked.map((item) => (Number.isFinite(item.time) ? item.time : 0));
      rows.push({
        session: id,
        file: file.split(/[\\/]/u).pop(),
        asked: asked.length,
        records,
        firstAsked: Math.min(...times),
        lastAsked: Math.max(...times),
        preEpoch: epochMs !== undefined && times.every((time) => time < epochMs),
        sample: asked.map((item) => `${item.toolName}/${item.callId ?? '-'}`).slice(0, 3),
      });
    }
  }
  rows.sort((a, b) => (a.firstAsked ?? 0) - (b.firstAsked ?? 0));
  const missing = rows.filter((row) => row.error === undefined && row.records < row.asked && row.preEpoch !== true);
  return { rows, sessions: rows.length, missing: missing.length };
}

/**
 * 命令行入口（可直接调用便于测试）。
 * @param {string[]} args - 可选 `--trace-epoch <ISO8601>`。
 * @param {object} [env] - 环境变量（默认 `process.env`）。
 * @returns {Promise<{code: number, out: string[]}>} 退出码与输出行。
 */
export async function cli(args, env = process.env) {
  const epochIndex = args.indexOf('--trace-epoch');
  let epochMs;
  if (epochIndex !== -1) {
    const raw = args[epochIndex + 1];
    epochMs = raw === undefined ? Number.NaN : Date.parse(raw);
    if (!Number.isFinite(epochMs)) {
      return { code: 2, out: ['usage: probe-approval-coverage.mjs [--trace-epoch <ISO8601>]（--trace-epoch 需要一个可解析的 ISO8601 时刻）'] };
    }
  }
  const home = env.DSH_HOME ?? join(homedir(), '.dsh');
  const fmt = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const out = [`home=${home}`, 'approvals that predate the record capability are expected to be empty.\n'];
  const { rows, missing } = await approvalCoverage({ home, epochMs });
  out.push('session                                  asked rec  first approval        last approval         verdict');
  let errors = 0;
  for (const row of rows) {
    if (row.error !== undefined) {
      errors += 1;
      out.push(`${row.session}  ERROR ${row.error}`);
      continue;
    }
    const verdict =
      row.records >= row.asked ? 'ok' : row.preEpoch ? 'pre-epoch(expect empty)' : epochMs === undefined ? 'MISSING(no epoch)' : 'MISSING';
    out.push(
      `${row.session}  ${String(row.asked).padStart(5)} ${String(row.records).padStart(3)}  ${fmt(row.firstAsked)}  ${fmt(row.lastAsked)}  ${verdict}`,
    );
  }
  out.push(`\ntotal sessions with approvals: ${rows.length}; not-covered: ${missing}`);
  for (const row of rows.filter((item) => item.error === undefined && item.records < item.asked && item.preEpoch !== true)) {
    out.push(`  ${row.session} asked=${row.asked} records=${row.records} :: ${row.sample.join(' | ')}`);
  }
  return { code: errors > 0 ? 1 : 0, out };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { code, out } = await cli(process.argv.slice(2));
  for (const line of out) console.log(line);
  process.exitCode = code;
}
