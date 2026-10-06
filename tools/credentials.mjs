/**
 * 探针共用的凭据读取：从 `$DSH_HOME/.credentials.yaml` 的 `refs` 段取一个引用值。
 *
 * 只做单文件最小解析（段内 `KEY: value`），不引入 YAML 依赖；调用方负责不打印值。
 * @module tools/credentials
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 凭据文件路径。
 * @returns {string} `$DSH_HOME/.credentials.yaml`。
 */
export function credentialsFile() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.credentials.yaml');
}

/**
 * 读取一个引用值。
 * @param {string} file - 凭据文件路径。
 * @param {string} key - 引用名（如 `DEEPSEEK_API_KEY`）。
 * @returns {{ok: true, value: string} | {ok: false, reason: string}} 读取结果。
 */
export function readCredentialRef(file, key) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, reason: `凭据文件不可读（${error.code ?? error.message}）` };
  }
  let inRefs = false;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+$/u, '');
    if (/^refs:\s*$/u.test(line)) {
      inRefs = true;
      continue;
    }
    if (inRefs && /^\S/u.test(line)) inRefs = false;
    if (!inRefs) continue;
    const match = /^\s+([A-Za-z0-9_.\-]+)\s*:\s*(.*)$/u.exec(line);
    if (match === null || match[1] !== key) continue;
    const value = match[2].trim().replace(/^["']|["']$/gu, '');
    if (value.length === 0) return { ok: false, reason: `refs.${key} 为空` };
    return { ok: true, value };
  }
  return { ok: false, reason: `refs.${key} 不存在` };
}
