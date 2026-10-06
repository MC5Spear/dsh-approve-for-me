/**
 * 离线协议探针：直连 DeepSeek 的 OpenAI 兼容接口，验证「assistant 的 tool_calls + role:'tool' 工具结果回喂」
 * 这一往返格式能被接受（两轮）。它只验证协议格式，不启动 dsh、不读写宿主状态。
 *
 * 用法：
 *   node tools/probe-llm-tools.mjs
 *   DSAFM_PROBE_MODEL=deepseek-chat node tools/probe-llm-tools.mjs
 *
 * 退出码：0 = 通过或优雅跳过（未验证）；1 = 协议被拒或凭据被拒。
 * 凭据只从 `$DSH_HOME/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY` 读取，任何输出都不含密钥。
 */
import { credentialsFile, readCredentialRef } from './credentials.mjs';

/** 凭据文件里使用的引用名。 */
const CREDENTIAL_REF = 'DEEPSEEK_API_KEY';
/** 默认端点与模型候选；`DEEPSEEK_BASE_URL` / `DSAFM_PROBE_MODEL` 可覆盖。 */
const BASE_URL = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/u, '');
const MODEL_CANDIDATES = process.env.DSAFM_PROBE_MODEL
  ? [process.env.DSAFM_PROBE_MODEL]
  : ['deepseek-chat', 'deepseek-v4-flash', 'deepseek-v4.1-flash-expires-on-0910'];
/** 单次请求超时。 */
const TIMEOUT_MS = 30000;

/** 探针用的只读工具定义（形状与插件一致）。 */
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file. Read-only.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
];

/**
 * 打印一行；调用方保证不传密钥。
 * @param {string} line - 输出文本。
 * @returns {void}
 */
function log(line) {
  process.stdout.write(`[probe] ${line}\n`);
}

/**
 * 结束并给出结论。
 * @param {'PASS' | 'SKIP' | 'FAIL'} verdict - 结论。
 * @param {string} detail - 说明。
 * @param {number} code - 退出码。
 * @returns {never} 直接退出进程。
 */
function finish(verdict, detail, code) {
  process.stdout.write(`RESULT: ${verdict} — ${detail}\n`);
  process.exit(code);
}

/**
 * 调用一次 `/chat/completions`。
 * @param {string} apiKey - 凭据值（不落日志）。
 * @param {object} body - 请求体。
 * @returns {Promise<{ok: true, value: object} | {ok: false, kind: 'network' | 'http' | 'auth', status?: number, message: string}>}
 *   结果。
 */
async function chat(apiKey, body) {
  let response;
  try {
    response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, kind: 'network', message: `${error.name}: ${error.message}` };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, kind: 'auth', status: response.status, message: `HTTP ${response.status}` };
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return { ok: false, kind: 'http', status: response.status, message: `HTTP ${response.status}: ${text.slice(0, 400)}` };
  }
  try {
    return { ok: true, value: await response.json() };
  } catch (error) {
    return { ok: false, kind: 'http', status: response.status, message: `响应不是 JSON：${error.message}` };
  }
}

/**
 * 执行两轮探针。
 * @param {string} apiKey - 凭据值。
 * @param {string} model - 模型 id。
 * @returns {Promise<{verdict: 'PASS' | 'SKIP' | 'FAIL', detail: string}>} 结论。
 */
async function probe(apiKey, model) {
  const messages = [
    {
      role: 'system',
      content:
        'You are a read-only reviewer. You must call the read_file tool once before answering, then answer with strict JSON.',
    },
    {
      role: 'user',
      content:
        'Check whether the file tools/probe-llm-tools.mjs exists. Call read_file once, then answer {"outcome":"allow"}.',
    },
  ];

  const first = await chat(apiKey, { model, messages, tools: TOOLS, tool_choice: 'auto', max_tokens: 512, temperature: 0 });
  if (first.ok !== true) {
    if (first.kind === 'network') return { verdict: 'SKIP', detail: `网络不可达：${first.message}` };
    if (first.kind === 'auth') return { verdict: 'FAIL', detail: `凭据被拒：${first.message}` };
    return { verdict: 'FAIL', detail: `第 1 轮请求失败：${first.message}` };
  }
  const assistant = first.value?.choices?.[0]?.message;
  const calls = assistant?.tool_calls ?? [];
  const finishReason = first.value?.choices?.[0]?.finish_reason;
  log(`round 1: model=${model} finish_reason=${finishReason ?? '-'} tool_calls=${calls.length}`);
  if (calls.length === 0) {
    return { verdict: 'FAIL', detail: '第 1 轮没有返回 tool_calls（模型或端点不支持工具调用）' };
  }
  for (const call of calls) {
    if (typeof call?.id !== 'string' || call.id.length === 0) return { verdict: 'FAIL', detail: 'tool_calls 缺少 id' };
    if (call?.function?.name !== 'read_file') return { verdict: 'FAIL', detail: `意外的工具名：${call?.function?.name}` };
  }

  // 第二轮：把 assistant 的 tool_calls 原样回喂，并为每个 call 配一条 role:'tool' 结果。
  const secondMessages = [
    ...messages,
    { role: 'assistant', content: assistant.content ?? '', tool_calls: calls },
    ...calls.map((call) => ({
      role: 'tool',
      tool_call_id: call.id,
      content: JSON.stringify({ exists: true, note: 'probe result' }),
    })),
  ];
  const second = await chat(apiKey, {
    model,
    messages: secondMessages,
    tools: TOOLS,
    max_tokens: 512,
    temperature: 0,
  });
  if (second.ok !== true) {
    if (second.kind === 'network') return { verdict: 'SKIP', detail: `网络不可达：${second.message}` };
    if (second.kind === 'auth') return { verdict: 'FAIL', detail: `凭据被拒：${second.message}` };
    return { verdict: 'FAIL', detail: `第 2 轮（tool_calls 回喂）被拒：${second.message}` };
  }
  const finalMessage = second.value?.choices?.[0]?.message;
  const content = typeof finalMessage?.content === 'string' ? finalMessage.content : '';
  log(`round 2: accepted, content_chars=${content.length} finish_reason=${second.value?.choices?.[0]?.finish_reason ?? '-'}`);
  const hasOutcome = /"outcome"\s*:\s*"(allow|deny)"/u.test(content);
  if (content.length === 0) {
    return { verdict: 'FAIL', detail: '第 2 轮返回空文本，无法确认最终结论' };
  }
  return {
    verdict: 'PASS',
    detail: `两轮 tool_calls 往返被接受；最终文本含 outcome=${hasOutcome ? 'yes' : 'no'}（文本格式不作硬性判定）`,
  };
}

const credentials = credentialsFile();
const credential = readCredentialRef(credentials, CREDENTIAL_REF);
if (credential.ok !== true) {
  finish('SKIP', `未验证：${credential.reason}（${credentials}）`, 0);
}
log(`credentials: ${CREDENTIAL_REF} 已读取（长度 ${credential.value.length}，值不输出）`);
log(`endpoint: ${BASE_URL}`);

let lastFailure = '没有可用的模型候选';
for (const model of MODEL_CANDIDATES) {
  const outcome = await probe(credential.value, model);
  log(`model ${model}: ${outcome.verdict}`);
  if (outcome.verdict === 'PASS' || outcome.verdict === 'SKIP') finish(outcome.verdict, outcome.detail, 0);
  lastFailure = `${model}: ${outcome.detail}`;
}
finish('FAIL', lastFailure, 1);
