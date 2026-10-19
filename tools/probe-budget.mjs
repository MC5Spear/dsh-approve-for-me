/**
 * dsh-approve-for-me — 审查输出预算探针：采集 `max_tokens` × 档位对正文/思考 token 的影响。
 *
 * 目的：证实「审查请求带 `maxTokens` 小强制上限 + 高档位」是否会让正文为空。
 * 做法：对 DeepSeek 的 OpenAI 兼容接口发同一条极短审查提示，只改 `max_tokens` 与思考档位，
 * 记录 `finish_reason`、正文长度、思考长度与用量。不打印任何凭据。
 *
 * 用法：node tools/probe-budget.mjs [--model deepseek-flash] [--max 512,2048,none] [--effort max,low]
 * 退出码：0 = 至少一组组合验证通过（含部分失败）；2 = 无凭据或全部组合失败（未验证）。
 */
import { readCredentialRef, credentialsFile } from './credentials.mjs';

const BASE_URL = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/u, '');
const TIMEOUT_MS = 180000;

/**
 * 解析命令行参数。
 * @returns {{model: string, maxes: (number|undefined)[], efforts: string[]}} 选项。
 */
function options() {
  const argv = process.argv.slice(2);
  const read = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
  };
  return {
    model: read('--model', 'deepseek-flash'),
    maxes: read('--max', '512,2048,none')
      .split(',')
      .map((value) => (value.trim() === 'none' ? undefined : Number(value.trim()))),
    efforts: read('--effort', 'max,low').split(',').map((value) => value.trim()),
  };
}

/** 与 `lib/prompt.js` 输出契约同形的最小审查提示：只要求一行 JSON。 */
const SYSTEM =
  'You are a security reviewer for sandbox escalations. Investigate only when needed. ' +
  'Final message must be strict JSON: {"risk_level":"low|medium|high|critical","user_authorization":"unknown|low|medium|high","outcome":"allow|deny","rationale":"..."}';
const USER = 'Action: pwsh runs `node tools/probe-budget.mjs` in the workspace. Escalation target: danger-full-access.';

/**
 * 跑一次组合。
 * @param {string} apiKey - 凭据值。
 * @param {{model: string, maxTokens: number|undefined, effort: string}} config - 组合。
 * @returns {Promise<object>} 观测结果。
 */
async function runOnce(apiKey, config) {
  const body = {
    model: config.model,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: USER },
    ],
    temperature: 0,
    stream: true,
    ...(config.maxTokens === undefined ? {} : { max_tokens: config.maxTokens }),
    ...(config.effort.length === 0 ? {} : { reasoning_effort: config.effort }),
  };
  const started = Date.now();
  let response;
  try {
    response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, note: `${error.name}: ${error.message}` };
  }
  if (!response.ok) {
    return { ok: false, note: `HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 200)}` };
  }
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let reasoning = '';
  let finish = '';
  let usage;
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      const choice = parsed?.choices?.[0];
      if (choice?.finish_reason !== undefined && choice.finish_reason !== null) finish = choice.finish_reason;
      text += choice?.delta?.content ?? '';
      reasoning += choice?.delta?.reasoning_content ?? choice?.delta?.reasoning ?? '';
      if (parsed?.usage !== undefined && parsed.usage !== null) usage = parsed.usage;
    }
  }
  return {
    ok: true,
    finish,
    textBytes: Buffer.byteLength(text, 'utf8'),
    reasoningBytes: Buffer.byteLength(reasoning, 'utf8'),
    textHead: text.slice(0, 160).replaceAll('\n', ' '),
    usage,
    ms: Date.now() - started,
  };
}

const opts = options();
const credential = readCredentialRef(credentialsFile(), 'DEEPSEEK_API_KEY');
if (credential.ok !== true) {
  process.stdout.write(`RESULT: SKIP — 未验证：${credential.reason}\n`);
  process.exit(2);
}

let anyOk = false;
for (const effort of opts.efforts) {
  for (const maxTokens of opts.maxes) {
    const result = await runOnce(credential.value, { model: opts.model, maxTokens, effort });
    const label = `model=${opts.model} effort=${effort} max_tokens=${maxTokens ?? 'unset'}`;
    if (result.ok !== true) {
      process.stdout.write(`[probe] ${label} → 失败：${result.note}\n`);
      continue;
    }
    anyOk = true;
    process.stdout.write(
      `[probe] ${label} → finish=${result.finish} text=${result.textBytes}B reasoning=${result.reasoningBytes}B ms=${result.ms} usage=${JSON.stringify(result.usage)}\n`,
    );
    process.stdout.write(`[probe]   head=${result.textHead}\n`);
  }
}

process.stdout.write(anyOk ? 'RESULT: PASS — 预算组合已采集\n' : 'RESULT: SKIP — 未验证：全部组合失败\n');
process.exit(anyOk ? 0 : 2);
