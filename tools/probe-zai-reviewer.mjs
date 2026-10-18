/**
 * zai 审查调用链对照探针：复现 `lib/reviewer.js` 的请求形状，直连 zai 的 OpenAI 兼容端点。
 *
 * 目的：判定审计行 `reason="empty payload"`（`lib/reviewer.js` 的 `parseAssessment`）到底是
 * 模型/provider 返回空内容，还是插件侧的消息组装问题。请求形状与 reviewer 一致：
 * system + 两条 user、工具 schema 开启、maxTokens=512、temperature=0、stream=true。
 *
 * 用法：node tools/probe-zai-reviewer.mjs
 * 退出码：0 = 拿到非空内容（凭据缺失按 SKIP 也退出 0）；1 = 内容为空（复现空响应）或 HTTP ≠ 200。
 * 输出不含密钥。
 */
import { readCredentialRef, credentialsFile } from './credentials.mjs';

const BASE_URL = (process.env.ZAI_BASE_URL ?? 'https://api.z.ai/api/paas/v4').replace(/\/+$/u, '');
const MODEL = process.env.PROBE_MODEL ?? 'glm-5.3-flash';
const EFFORT = process.env.PROBE_EFFORT ?? 'max';
const TIMEOUT_MS = 60000;

/** 审查提示词的压缩版：只保留结构与工具约束，足以判断模型是否产出可解析文本。 */
const SYSTEM = [
  'You are a read-only sandbox-escalation reviewer.',
  'Decide whether the requested escalation may be allowed once.',
  'Use the provided read-only tools when they help; otherwise answer directly.',
  'Answer with one JSON object only:',
  '{"outcome":"allow"|"deny","risk_level":"low"|"medium"|"high"|"critical","user_authorization":"unknown"|"low"|"medium"|"high","rationale":"..."}',
].join('\n');

/** 最小只读工具集，形状与 `lib/readonly-tools.js` 暴露给模型的 schema 一致。 */
const TOOLS = [
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file inside the workspace.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Workspace-relative path.' } },
      required: ['path'],
    },
  },
  {
    name: 'list_dir',
    description: 'List directory entries inside the workspace.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Workspace-relative path.' } },
      required: ['path'],
    },
  },
];

const EVIDENCE = [
  'user: 尝试一下提权访问？',
  'assistant: 我这就发起一次。',
].join('\n');

const ACTION = [
  'tool: pwsh',
  'mode: workspace-write -> danger-full-access',
  'command: Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Select-Object ProcessId,CommandLine',
  'justification: 读取 node.exe 进程的完整命令行需要 WMI 访问。',
].join('\n');

/**
 * 发起一次流式请求，统计 content 与 tool_calls 增量。
 * @returns {Promise<{status: number, text: string, toolCalls: number, finish: string, error: string}>} 结果。
 */
async function probe(apiKey) {
  let response;
  try {
    response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: EVIDENCE },
          { role: 'user', content: ACTION },
        ],
        tools: TOOLS.map((tool) => ({ type: 'function', function: tool })),
        max_tokens: 512,
        temperature: 0,
        reasoning_effort: EFFORT,
        stream: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { status: 0, text: '', toolCalls: 0, finish: '-', error: `请求异常：${error?.name ?? ''} ${error?.message ?? ''}` };
  }

  if (response.status !== 200) {
    const body = await response.text().catch(() => '');
    return { status: response.status, text: '', toolCalls: 0, finish: '-', error: body.slice(0, 300) };
  }

  const raw = await response.text();
  let text = '';
  let toolCalls = 0;
  let finish = '-';
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload.length === 0 || payload === '[DONE]') continue;
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    const choice = parsed?.choices?.[0];
    if (choice === undefined) continue;
    if (typeof choice.finish_reason === 'string') finish = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string') text += delta.content;
    if (Array.isArray(delta.tool_calls)) toolCalls += delta.tool_calls.length;
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === 'string' && reasoning.length > 0) finish = `${finish}(reasoning:${reasoning.length}B)`;
  }
  return { status: response.status, text, toolCalls, finish, error: '' };
}

const credential = readCredentialRef(credentialsFile(), 'ZAI_API_KEY');
if (credential.ok !== true) {
  process.stdout.write(`RESULT: SKIP — 未验证：${credential.reason}\n`);
  process.exit(0);
}

process.stdout.write(`[probe] endpoint=${BASE_URL} model=${MODEL} effort=${EFFORT} maxTokens=512 tools=${TOOLS.length}\n`);
const result = await probe(credential.value);
process.stdout.write(`[probe] http=${result.status} finish=${result.finish} contentBytes=${result.text.length} toolCallDeltas=${result.toolCalls}\n`);
if (result.error.length > 0) process.stdout.write(`[probe] error=${result.error}\n`);
process.stdout.write(`[probe] contentHead=${JSON.stringify(result.text.slice(0, 200))}\n`);

if (result.status !== 200) {
  process.stdout.write('RESULT: FAIL — 审查请求未成功（上行为响应体片段）\n');
  process.exit(1);
}
if (result.text.trim().length === 0 && result.toolCalls === 0) {
  process.stdout.write('RESULT: FAIL — 复现空响应：模型未返回任何文本或工具调用，与审计行 reason="empty payload" 一致\n');
  process.exit(1);
}
process.stdout.write('RESULT: PASS — 模型返回了内容\n');
process.exit(0);
