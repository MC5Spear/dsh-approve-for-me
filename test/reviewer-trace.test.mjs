import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewer } from '../lib/reviewer.js';

/**
 * 审查记录接线测试（design §8.2/§8.3）。
 *
 * 覆盖两层：`lib/reviewer.js` 的 onReview 契约（成功路径的字段一致性、采集档开关、fire-and-forget），
 * 以及 `lib/index.js` 的端到端接线（gate 补的审批上下文 → reviewer → onReview → JSONL 落盘、
 * 配置签名变化重建实例不丢数据）。后者依赖宿主包，离线环境按 `index.test.mjs` 的惯例整体跳过。
 */

/** 假组装器：只模拟审查循环真正消费的行为（blocks/finish/usage）。 */
class FakeAssembler {
  constructor() {
    this.blocks_ = [];
    this.finish_ = { kind: 'stop' };
    this.usage_ = undefined;
  }

  push(chunk) {
    if (chunk?.type === 'finish') {
      this.finish_ = chunk.reason;
      return;
    }
    if (chunk?.type === 'usage') {
      this.usage_ = chunk.usage;
      return;
    }
    if (chunk?.block !== undefined) this.blocks_.push(chunk.block);
  }

  blocks() {
    return [...this.blocks_];
  }

  get finish() {
    return this.finish_;
  }

  get usage() {
    return this.usage_;
  }
}

const messages = {
  createUserMessage: (input) => ({ role: 'user', content: input.content, source: input.source }),
  createAssistantMessage: (input) => ({ role: 'assistant', content: input.content, source: { kind: 'model', ...input.source } }),
  createToolResultMessage: (input) => ({ role: 'tool-result', callId: input.callId, content: input.content, isError: input.isError }),
};

const prompt = {
  buildSystem: () => 'SYSTEM',
  buildUserTexts: (input) => ({ evidenceText: `EV:${input.evidence}`, actionText: 'ACTION' }),
};

const text = (value) => ({ type: 'text', text: value });
const reasoning = (value) => ({ type: 'reasoning', text: value });
const toolCall = (id, name, args) => ({ type: 'tool-call', id, name, arguments: args });

/**
 * 构造一次审查调用的全部依赖，并收集 onReview 收到的 entry。
 * @param {Array<{blocks: object[], usage?: object}>} turns - 每次 `llm.stream` 的块序列。
 * @param {object} [options] - 覆盖项：`onReview`（在收集之后再抛错可测 fire-and-forget）、`cfg`。
 * @returns {{entries: object[], review: (optsOverrides?: object) => Promise<object>}} 测试句柄。
 */
function harness(turns, options = {}) {
  const entries = [];
  let index = 0;
  const llm = {
    stream() {
      const turn = turns[Math.min(index, turns.length - 1)];
      index += 1;
      return (async function* generate() {
        for (const block of turn.blocks) yield { type: 'block', index: 0, block };
        if (turn.usage !== undefined) yield { type: 'usage', usage: turn.usage };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
  const reviewer = createReviewer({
    llm,
    blocks: { BlockAssembler: FakeAssembler },
    messages,
    tools: { schemas: [], run: async () => ({ text: 'tool-output', isError: false }) },
    prompt,
    audit: () => {},
    onReview: (entry) => {
      entries.push(entry);
      options.onReview?.(entry);
    },
  });
  const cfg = {
    reviewer: { maxTokens: 0, temperature: 0, maxToolSteps: 4, timeoutMs: 1000 },
    audit: {},
    resolution: { provider: 'p1', model: 'm1', layer: 'user', effort: 'low' },
    ...options.cfg,
  };
  return {
    entries,
    review: (optsOverrides = {}) =>
      reviewer.review(
        { toolName: 'pwsh', reason: 'escalate sandbox to danger-full-access: x' },
        { command: 'npm i', description: 'install deps', arguments: { command: 'npm i' } },
        { fields: {}, evidence: 'E' },
        cfg,
        { id: 'r1', signal: new AbortController().signal, ...optsOverrides },
      ),
  };
}

test('onReview：成功审查后恰好调用一次，判定相关字段与 Verdict 一致', async () => {
  const h = harness([
    {
      blocks: [text('{"outcome":"allow","risk_level":"low","user_authorization":"medium","rationale":"ok"}')],
      usage: { reasoningTokens: 7 },
    },
  ]);
  const verdict = await h.review({ trace: { sessionId: 'session-t1', callId: 'call-9', toolName: 'pwsh', approvalId: 'ap-1', origin: 'main', escalation: 'rules', preset: 'auto-approve' }, queueMs: 4 });
  assert.equal(h.entries.length, 1, '一次审查恰好一条记录');
  const entry = h.entries[0];
  assert.equal(entry.kind, 'review');
  assert.equal(entry.approvalId, 'ap-1');
  assert.equal(entry.decision, 'allow');
  assert.equal(entry.decision, verdict.decision);
  assert.equal(entry.reason, 'ok');
  assert.equal(entry.reason, verdict.reason);
  assert.equal(entry.model, 'p1/m1');
  assert.equal(entry.model, verdict.fields.model);
  assert.equal(entry.effort, 'low');
  assert.equal(entry.effort, verdict.fields.effort);
  assert.equal(entry.tokens, 7);
  // gate 经 opts.trace 补进来的审批上下文必须原样透传到记录。
  assert.equal(entry.sessionId, 'session-t1');
  assert.equal(entry.callId, 'call-9');
  assert.equal(entry.toolName, 'pwsh');
  assert.equal(entry.origin, 'main');
  assert.equal(entry.escalation, 'rules');
  assert.equal(entry.preset, 'auto-approve');
  assert.equal(entry.queueMs, 4, '排队等待时长经 opts.queueMs 进记录');
  assert.equal(Number.isFinite(entry.startedAt), true);
  assert.equal(Number.isFinite(entry.endedAt), true);
  assert.equal(entry.reviewMs >= 0, true);
  // §8.2 摘要取证字段：attempts、subject/evidence/probes、配置与策略标识。
  assert.equal(entry.attempts, 1, '成功路径流过一次模型');
  assert.match(entry.subject, /npm i/, 'subject 取命令文本');
  assert.equal(entry.evidence, 'E', 'evidence 取送审证据原文（pre.evidence）');
  assert.equal(entry.probes, undefined, '无工具轮时 probes 缺失');
  assert.equal(entry.tools, 0);
  // §8.2 fieldsDefaulted 生产侧口径：解析完整（risk/auth/rationale 都在场）→ 空串＝无补全。
  assert.equal(entry.fieldsDefaulted, '', '无字段缺失时 fieldsDefaulted 为空串');
  assert.match(entry.configTag, /^[0-9a-f]{12}$/, 'configTag 是稳定串摘要的前 12 位十六进制');
  assert.match(entry.policyTag, /^(zh|en):(missing|[0-9a-f]{12})$/, 'policyTag 带语言与策略文件摘要');
  assert.equal(verdict.queueMs, 4, 'queueMs 随判定返回给 gate 结算');
});

test('onReview：subject/reason 超出 maxEntryBytes 时首尾保留并置 truncated', async () => {
  const h = harness(
    [
      {
        blocks: [text('{"outcome":"deny","rationale":"' + 'x'.repeat(4096) + '"}')],
      },
    ],
    { cfg: { context: { maxEntryBytes: 64 } } },
  );
  await h.review();
  const entry = h.entries[0];
  assert.equal(entry.truncated, true, '任一摘要字段被裁剪即置 truncated');
  // JSON 只有 outcome＋rationale：risk/auth 缺失按 outcome 回退 → 清单按序逗号拼接（§8.2）。
  assert.equal(entry.fieldsDefaulted, 'risk,auth', '缺失字段的清单值按序拼接');
  assert.ok(entry.reason.includes('<truncated bytes='), '截断标记在场');
  assert.ok(entry.reason.startsWith('x') && entry.reason.endsWith('x'), '首尾保留');
  assert.ok(Buffer.byteLength(entry.reason, 'utf8') <= 64 + 96, '裁剪后不显著超出预算（标记本身占字节）');
});

test('onReview：redactText 先于裁剪套用（脱敏后不再出现敏感串）', async () => {
  const seen = [];
  const redacted = [];
  const entries = [];
  const turns = [{ blocks: [text('{"outcome":"deny","rationale":"leak SECRET now"}')] }];
  let index = 0;
  const llm = { stream() { const turn = turns[Math.min(index, turns.length - 1)]; index += 1; return (async function* gen() { for (const b of turn.blocks) yield { type: 'block', index: 0, block: b }; yield { type: 'finish', reason: { kind: 'stop' } }; })(); } };
  const reviewer = createReviewer({
    llm,
    blocks: { BlockAssembler: FakeAssembler },
    messages,
    tools: { schemas: [], run: async () => ({ text: 'x', isError: false }) },
    prompt,
    audit: () => {},
    redactText: (text) => { seen.push(text); return text.replaceAll('SECRET', '***'); },
    onReview: (entry) => entries.push(entry),
  });
  await reviewer.review(
    { toolName: 'pwsh', reason: 'escalate sandbox: x' },
    { command: 'run SECRET cmd' },
    { fields: {}, evidence: 'E SECRET' },
    { reviewer: { maxTokens: 0, temperature: 0, maxToolSteps: 4, timeoutMs: 1000 }, audit: {}, resolution: { provider: 'p1', model: 'm1', layer: 'user', effort: 'low' } },
    { id: 'r1', signal: new AbortController().signal },
  );
  assert.ok(seen.some((text) => text.includes('SECRET')), '脱敏函数见到原文');
  const entry = entries[0];
  assert.ok(!entry.reason.includes('SECRET'), 'reason 已脱敏');
  assert.ok(!entry.subject.includes('SECRET'), 'subject 已脱敏');
  assert.ok(!entry.evidence.includes('SECRET'), 'evidence 已脱敏');
  redacted.push(entry);
});

test('onReview：capture=off 时不收集 prompt/input/reasoning/output 全文（避免白做功）', async () => {
  const h = harness(
    [{ blocks: [reasoning('secret-chain'), text('{"outcome":"deny","rationale":"nope"}')] }],
    { cfg: { ui: { trace: { capture: 'off' } } } },
  );
  const verdict = await h.review();
  assert.equal(verdict.decision, 'deny');
  assert.equal(h.entries.length, 1);
  const entry = h.entries[0];
  assert.equal(entry.prompt, undefined);
  assert.equal(entry.input, undefined);
  assert.equal(entry.reasoning, undefined);
  assert.equal(entry.output, undefined);
  // 摘要字段与判定不受采集档影响。
  assert.equal(entry.decision, 'deny');
  assert.equal(entry.model, 'p1/m1');
});

test('onReview：capture=full 时收集提示词、送审命令、思维链（跨轮累加）与最终正文', async () => {
  const h = harness(
    [
      { blocks: [reasoning('chain-a'), toolCall('c1', 'read_file', '{"path":"a"}')] },
      { blocks: [reasoning('chain-b'), text('{"outcome":"deny","rationale":"nope"}')] },
    ],
    { cfg: { ui: { trace: { capture: 'full' } } } },
  );
  const verdict = await h.review();
  assert.equal(verdict.decision, 'deny');
  const entry = h.entries[0];
  // 提示词与 phase=prompt 审计行同一份拼接口径：系统词 + 证据 + 动作。
  assert.match(entry.prompt, /SYSTEM/);
  assert.match(entry.prompt, /EV:E/);
  assert.match(entry.prompt, /ACTION/);
  assert.equal(entry.input, 'npm i');
  assert.equal(entry.reasoning, 'chain-achain-b', '带工具轮的思维链要跨轮累加');
  assert.equal(entry.output, '{"outcome":"deny","rationale":"nope"}');
});

test('onReview：回调抛错时 review() 仍正常返回判定（fire-and-forget，不外抛）', async () => {
  let calls = 0;
  const h = harness(
    [{ blocks: [text('{"outcome":"allow","risk_level":"low","rationale":"fine"}')] }],
    {
      onReview: () => {
        calls += 1;
        throw new Error('record channel exploded');
      },
    },
  );
  const verdict = await h.review();
  assert.equal(calls, 1);
  assert.equal(verdict.decision, 'allow');
  assert.equal(verdict.fields.reason, 'fine');
});

/**
 * 宿主接线冒烟：只有宿主解析环境能加载 `lib/index.js`；离线时与 `index.test.mjs` 同样跳过。
 * @returns {Promise<object | undefined>} 模块；宿主包不可解析时为 `undefined`。
 */
async function loadHost() {
  try {
    return await import('../lib/index.js');
  } catch (error) {
    const message = String(error?.message ?? error);
    const hostPackageMissing = error?.code === 'ERR_MODULE_NOT_FOUND' && message.includes('@deepseek-ai/');
    if (hostPackageMissing) return undefined;
    throw error;
  }
}

/**
 * 轮询等待 JSONL 落足期望行数：record 是 fire-and-forget，写盘发生在应答者返回之后。
 * @param {string} path - JSONL 文件路径。
 * @param {number} expect - 期望行数。
 * @param {number} [timeoutMs] - 超时。
 * @returns {Promise<object[]>} 解析后的记录行。
 */
async function waitForLines(path, expect, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const raw = await readFile(path, 'utf8');
      const lines = raw.split('\n').filter((line) => line.trim().length > 0);
      if (lines.length >= expect) return lines.map((line) => JSON.parse(line));
    } catch {
      // 文件还没建出来 / 还没写完：继续等。
    }
    if (Date.now() > deadline) throw new Error(`等待 ${path} 落盘 ${expect} 行超时`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('index 接线：record 收到 sessionId/callId/toolName，配置签名变化重建后同一 JSONL 不丢数据', async (t) => {
  const host = await loadHost();
  if (host === undefined) {
    t.skip('宿主包不可解析（离线环境）');
    return;
  }
  const tmp = await mkdtemp(join(tmpdir(), 'afm-trace-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = tmp; // reviews 目录取 $DSH_HOME/approve-for-me/reviews，借此注入临时目录。
  // 0.1.7 读通道：配置＝apply 的第二参数；current() 每次现算 normalizeConfig，
  // 「热改」＝原地改这个对象（真机上是宿主对 volatile 引用的原地更新，取值效果相同）。
  const config = { mode: 'rules', reviewer: { model: 'deepseek-official/probe-model' } };
  let callId = 'call-1';
  const listeners = [];
  const session = {
    id: 'session-trace-wire',
    header: { cwd: tmp },
    snapshotEvents: () => [
      // 折叠 permission/preset 命中默认 trigger.presets=['auto-approve']，接管本次审批。
      { type: 'permission/preset', data: { preset: 'auto-approve' } },
      // 回查 callId 对应的命令，让规则检查走到 LLM 审查。
      { type: 'tool/call', data: { callId, name: 'pwsh', arguments: JSON.stringify({ command: 'npm i' }) } },
    ],
  };
  const ctx = {
    on: (event, handler, prepend) => {
      listeners.push({ event, handler, prepend });
      return () => {};
    },
    llm: {
      listProviders: () => [{ id: 'deepseek-official' }],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }] } }),
      // 同步抛错即可：reviewer 内部兜成 decision=error，finish 仍会落一条记录，不需要真流。
      stream: () => {
        throw new Error('stream exploded');
      },
    },
  };
  try {
    host.apply(ctx, config);
    const answerer = listeners.find((entry) => entry.event === 'approval/request').handler;
    assert.ok(answerer, '未注册 approval/request 应答者');
    const request = () => ({
      agent: { session, inject: () => {} },
      callId,
      toolName: 'pwsh',
      reason: 'escalate sandbox to danger-full-access: run npm i',
    });
    const next = () => new Promise(() => {});

    assert.equal(await answerer(request(), next), 'rejected');
    const file = join(tmp, 'approve-for-me', 'reviews', 'trace-wire.jsonl');
    // 每审批恰两条：审查记录先落（reviewer 汇合点），结算记录随后（gate 按 fallback 结算）。
    const first = await waitForLines(file, 2);
    assert.equal(first.length, 2);
    assert.equal(first[0].kind, 'review');
    assert.equal(first[0].sessionId, 'trace-wire', 'record 收到 sessionId（存储侧按文件键归一化）');
    assert.equal(first[0].callId, 'call-1', 'callId 来自审批请求的 request.callId（gate.js 补入）');
    assert.equal(first[0].toolName, 'pwsh', 'toolName 来自审批请求的 request.toolName（gate.js 补入）');
    assert.equal(first[0].decision, 'error');
    assert.equal(first[0].model, 'deepseek-official/probe-model');
    assert.equal(first[0].effort, 'low');
    assert.equal(first[0].origin, 'main');
    assert.equal(first[0].preset, 'auto-approve', '接管命中的权限预设名（事件折叠回退）');
    assert.equal(first[0].attempts, 2, '同步抛错属可重试错误类：整建重试一次后仍失败（尝试次数 2）');
    assert.match(first[0].configTag, /^[0-9a-f]{12}$/);
    assert.equal(Number.isFinite(first[0].startedAt), true);
    assert.equal(Number.isFinite(first[0].reviewMs), true);
    assert.equal(first[0].prompt, undefined, 'capture=summary（默认档）不落详情全文');
    assert.equal(first[1].kind, 'settle');
    assert.equal(first[1].outcome, 'rejected');
    assert.equal(first[1].source, 'llm', '模型侧错误按 llm 来源结算');
    // §8.4 settle 行端到端落盘（gate→onSettle→trace-store）：摘要字段带脱敏后的理由与命令主题、
    // 跨度两端在场；非超时结算不带 stage。
    assert.match(first[1].reason, /stream exploded/, '结算理由来自审查判定的 reason 摘要');
    assert.equal(first[1].subject, 'npm i', 'subject 是脱敏后的命令主题');
    assert.equal(Number.isFinite(first[1].endedAt), true);
    assert.equal(first[1].stage, undefined, '非超时结算不带 stage');
    assert.equal(first[0].fieldsDefaulted, '', '模型没产出判定：解析未发生，fieldsDefaulted 为空串');
    assert.equal(first[1].approvalId, first[0].approvalId, '两类记录经 approvalId 关联');
    assert.equal(first[1].callId, 'call-1');
    assert.equal(first[1].origin, 'main');
    assert.equal(first[1].preset, 'auto-approve');
    assert.notEqual(first[1].reviewId, first[0].reviewId, 'kind 进键：两行主键不同');
    assert.ok(first[1].reviewId.endsWith(`:settle:${first[1].approvalId}`), '结算行主键＝四段键的 settle 段');

    // 改配置签名（maxBytes 变化）→ 重建存储实例；事实源是 JSONL，同一文件继续追加、旧数据不丢。
    // 0.1.7：直接原地改 config 对象——current() 现算即读到新签名，无需任何设置服务回调。
    config.ui = { trace: { maxBytes: 512 } };
    callId = 'call-2';
    assert.equal(await answerer(request(), next), 'rejected');
    const both = await waitForLines(file, 4);
    assert.equal(both.length, 4, '两次审批各两条记录都落在同一会话的 JSONL 里');
    assert.equal(both[0].callId, 'call-1', '重建前的记录仍在（数据不丢）');
    assert.equal(both[2].kind, 'review');
    assert.equal(both[2].callId, 'call-2');
    assert.equal(both[3].kind, 'settle');
    assert.equal(both[3].callId, 'call-2');
    assert.equal(both[2].sessionId, 'trace-wire');
    assert.notEqual(both[0].reviewId, both[2].reviewId);
    assert.notEqual(both[0].approvalId, both[2].approvalId, '两次审批是不同审批实例');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});
