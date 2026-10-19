/**
 * 真实调用链探针：用 DeepSeek 的 OpenAI 兼容接口跑一次完整的审查循环。
 *
 * 它把本插件的 `ctx.llm.stream` 请求映射成 `/chat/completions` 的 SSE 流，再用一个最小组装器
 * 把 delta 还原成内容块，验证 `lib/reviewer.js` 的消息序列（assistant tool_calls + role:'tool' 回喂）
 * 与解析容错在真实模型上成立。
 *
 * 用法：node tools/probe-reviewer-live.mjs
 * 退出码：0 = 通过或优雅跳过（未验证）；1 = 协议被拒或结论不可解析。
 * 任何输出都不含密钥。
 */
import { readCredentialRef, credentialsFile } from './credentials.mjs';
import { createReadonlyTools } from '../lib/readonly-tools.js';
import * as prompt from '../lib/prompt.js';
import { createReviewer } from '../lib/reviewer.js';

const BASE_URL = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/u, '');
const TIMEOUT_MS = 180000;

/**
 * 解析命令行参数；默认不设输出上限（与 lib/config.js 的 reviewer.maxTokens 缺省 0 一致）。
 * 模型与档位缺省取 deepseek-flash/max，是本探针的手动诊断缺省，非插件 schema 缺省。
 * @returns {{model: string, effort: string, maxTokens: number, maxToolSteps: number}} 选项。
 */
function options() {
  const argv = process.argv.slice(2);
  const read = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
  };
  return {
    model: read('--model', process.env.DSAFM_PROBE_MODEL ?? 'deepseek-flash'),
    effort: read('--effort', 'max'),
    maxTokens: Number(read('--max-tokens', '0')),
    maxToolSteps: Number(read('--max-tool-steps', '2')),
  };
}

const OPTIONS = options();

/**
 * 最小内容块组装器：文本按 index 累加，工具调用按 index 累加参数；
 * 另按宿主的 `BlockAssembler` 接口暴露 `finish` / `usage`（`lib/reviewer.js` 的判据来源）。
 */
class DeltaAssembler {
  constructor() {
    this.texts = new Map();
    this.calls = new Map();
    this.finishReason = { kind: 'stop' };
    this.usage = undefined;
  }

  /** @param {{index: number, delta: object, finishReason?: string, usage?: object}} chunk - 归一化增量。 */
  push(chunk) {
    if (typeof chunk.text === 'string' && chunk.text.length > 0) {
      this.texts.set(chunk.index, `${this.texts.get(chunk.index) ?? ''}${chunk.text}`);
    }
    for (const call of chunk.toolCalls ?? []) {
      const current = this.calls.get(call.index) ?? { id: '', name: '', arguments: '' };
      this.calls.set(call.index, {
        id: call.id ?? current.id,
        name: call.name ?? current.name,
        arguments: `${current.arguments}${call.arguments ?? ''}`,
      });
    }
    if (typeof chunk.finishReason === 'string') this.finishReason = mapFinishReason(chunk.finishReason);
    if (chunk.usage !== undefined) {
      this.usage = {
        outputTokens: chunk.usage.completion_tokens,
        ...(chunk.usage.completion_tokens_details?.reasoning_tokens === undefined
          ? {}
          : { reasoningTokens: chunk.usage.completion_tokens_details.reasoning_tokens }),
      };
    }
  }

  /** @returns {object[]} 组装后的块。 */
  blocks() {
    const blocks = [];
    for (const text of this.texts.values()) blocks.push({ type: 'text', text });
    for (const call of this.calls.values()) {
      blocks.push({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments });
    }
    return blocks;
  }

  /** 宿主 `BlockAssembler.finish` 的同名访问器。 */
  get finish() {
    return this.finishReason;
  }
}

/**
 * 线格式 → 宿主 FinishReason 映射。目标 kind 与宿主 `dsh-llm-deepseek` 的 `stopReason`
 * 一致（stop/tool-calls/max-tokens）；注意词汇表不同——本表按 OpenAI 词汇
 * （`stop`/`tool_calls`/`length`）读线，宿主现行实现用 anthropic 词汇。
 * @param {string} reason - 线格式 `finish_reason`。
 * @returns {{kind: string, failure?: object}} 宿主 FinishReason。
 */
function mapFinishReason(reason) {
  if (reason === 'stop') return { kind: 'stop' };
  if (reason === 'tool_calls') return { kind: 'tool-calls' };
  if (reason === 'length') return { kind: 'max-tokens' };
  return { kind: 'error', failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() } };
}

/** 假消息构造器：输入签名与 `@deepseek-ai/dsh-llm` 一致；user/assistant 输出同形，tool-result 为探针私有形状（由 toWireMessages 翻译成线格式）。 */
const messages = {
  createUserMessage: (input) => ({ role: 'user', content: input.content, source: input.source }),
  createAssistantMessage: (input) => ({ role: 'assistant', content: input.content, source: { kind: 'model', ...input.source } }),
  createToolResultMessage: (input) => ({
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: input.callId, content: input.content, isError: input.isError }],
    source: { kind: 'tool', callId: input.callId },
  }),
};

/**
 * 把审查请求的 messages 翻译成 OpenAI 兼容线格式。
 * @param {object[]} list - 本插件的消息数组。
 * @returns {object[]} 线格式消息。
 */
function toWireMessages(list) {
  const wire = [];
  for (const message of list) {
    if (message.role === 'assistant') {
      const calls = message.content.filter((block) => block.type === 'tool-call');
      const text = message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
      wire.push({
        role: 'assistant',
        content: text,
        ...(calls.length === 0 ? {} : { tool_calls: calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) }),
      });
      continue;
    }
    const results = message.content.filter((block) => block.type === 'tool-result');
    if (results.length > 0) {
      for (const block of results) {
        wire.push({ role: 'tool', tool_call_id: block.toolCallId, content: block.content.map((inner) => inner.text ?? '').join('') });
      }
      continue;
    }
    wire.push({ role: 'user', content: message.content.map((block) => block.text ?? '').join('\n') });
  }
  return wire;
}

/**
 * 发起一次流式请求并把 SSE 增量交给组装器。
 * @param {string} apiKey - 凭据值。
 * @param {object} options - 本插件的 `GenerateOptions`。
 * @param {DeltaAssembler} assembler - 组装器。
 * @returns {Promise<{ok: true} | {ok: false, message: string}>} 结果。
 */
async function streamOnce(apiKey, options, assembler) {
  let response;
  try {
    response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: options.model,
        messages: [{ role: 'system', content: options.system }, ...toWireMessages(options.messages)],
        ...(options.tools === undefined ? {} : { tools: options.tools.map((tool) => ({ type: 'function', function: tool })) }),
        // `maxTokens` 未设置（undefined）时不传该字段，与插件默认行为一致。
        ...(Number.isFinite(options.maxTokens) && options.maxTokens > 0 ? { max_tokens: options.maxTokens } : {}),
        ...(options.reasoningEffort === undefined || options.reasoningEffort === 'none' ? {} : { reasoning_effort: options.reasoningEffort }),
        temperature: options.temperature,
        stream: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, message: `${error.name}: ${error.message}` };
  }
  if (!response.ok) {
    return { ok: false, message: `HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 300)}` };
  }
  const decoder = new TextDecoder();
  let buffer = '';
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
      const delta = choice?.delta ?? {};
      assembler.push({
        index: 0,
        text: delta.content ?? '',
        toolCalls: (delta.tool_calls ?? []).map((call) => ({
          index: call.index ?? 0,
          id: call.id,
          name: call.function?.name,
          arguments: call.function?.arguments,
        })),
        ...(typeof choice?.finish_reason === 'string' ? { finishReason: choice.finish_reason } : {}),
        ...(parsed?.usage === undefined || parsed.usage === null ? {} : { usage: parsed.usage }),
      });
    }
  }
  return { ok: true };
}

const credentials = credentialsFile();
const credential = readCredentialRef(credentials, 'DEEPSEEK_API_KEY');
if (credential.ok !== true) {
  process.stdout.write(`RESULT: SKIP — 未验证：${credential.reason}\n`);
  process.exit(0);
}

const auditLines = [];
const tools = createReadonlyTools({ rootDir: process.cwd(), timeoutMs: 5000, audit: (fields) => auditLines.push(fields) });
const reviewer = createReviewer({
  llm: {
    stream(options) {
      const assembler = new DeltaAssembler();
      let result;
      const ready = (async () => {
        result = await streamOnce(credential.value, options, assembler);
      })();
      return (async function* generate() {
        await ready;
        if (result?.ok !== true) throw new Error(result?.message ?? 'stream failed');
        // 块一次给全；流末的 finish_reason 与 usage 由组装器暴露（与宿主 BlockAssembler 同形）。
        yield { type: 'blocks', blocks: assembler.blocks() };
      })();
    },
  },
  blocks: {
    // 与宿主 `BlockAssembler` 同形的桩：块来自流内容，`finish` / `usage` 暴露流末观测值
    //（`lib/reviewer.js` 的判据来源；缺了它们审查循环读不到截断原因）。
    BlockAssembler: class {
      constructor() {
        this.inner = new DeltaAssembler();
        this.current = undefined;
      }

      push(chunk) {
        if (chunk?.blocks !== undefined) {
          this.current = chunk.blocks;
          return;
        }
        this.inner.push(chunk);
      }

      blocks() {
        return this.current ?? [];
      }

      get finish() {
        return this.inner.finishReason;
      }

      get usage() {
        return this.inner.usage;
      }
    },
  },
  messages,
  tools,
  prompt,
  audit: (fields) => auditLines.push(fields),
});

const verdict = await reviewer.review(
  { toolName: 'pwsh', reason: 'escalate sandbox to danger-full-access: probe' },
  { command: 'node tools/probe-reviewer-live.mjs', cwd: process.cwd(), arguments: { command: 'node tools/probe-reviewer-live.mjs' } },
  { fields: { mode: 'danger-full-access' }, evidence: 'user: 请运行这个探针脚本检查插件行为' },
  {
    // 与生产同形：`reviewer` 分节用 `lib/config.js` 的字段名，默认 `maxTokens = 0`（不传上限）。
    reviewer: { maxTokens: OPTIONS.maxTokens, temperature: 0, maxToolSteps: OPTIONS.maxToolSteps },
    audit: { includePrompt: false, includeRaw: false },
    resolution: { provider: 'deepseek-official', model: OPTIONS.model, layer: 'user', effort: OPTIONS.effort },
  },
  { id: 'probe', signal: AbortSignal.timeout(TIMEOUT_MS) },
);

const toolLines = auditLines.filter((entry) => entry.phase === 'tool');
const reviewLine = auditLines.find((entry) => entry.phase === 'review');
process.stdout.write(`[probe] model=${OPTIONS.model} effort=${OPTIONS.effort} maxTokens=${OPTIONS.maxTokens > 0 ? OPTIONS.maxTokens : 'unset'}\n`);
process.stdout.write(`[probe] decision=${verdict.decision} risk=${verdict.risk ?? '-'} tools=${verdict.toolCalls}\n`);
process.stdout.write(`[probe] audit: finish=${reviewLine?.finish ?? '-'} reasoningTokens=${reviewLine?.reasoningTokens ?? '-'} degraded=${reviewLine?.degraded ?? '-'}\n`);
process.stdout.write(`[probe] tool audit lines=${toolLines.length}\n`);
process.stdout.write(`[probe] reason=${String(verdict.reason).slice(0, 200)}\n`);
if (verdict.decision === 'allow' || verdict.decision === 'deny') {
  process.stdout.write('RESULT: PASS — 审查循环在真实模型上完成并给出可解析结论\n');
  process.exit(0);
}
process.stdout.write(`RESULT: FAIL — 结论不可解析：${verdict.reason}\n`);
process.exit(1);
