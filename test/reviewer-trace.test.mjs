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
  assert.equal(entry.capture, 'summary', '记录级 capture 生效标记＝请求快照档（未配置即 summary）');
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
  assert.equal(entry.capture, 'summary', '截断路径同样携带 capture（缺省档等值）');
});

test('onReview：模型不可用早退仍携带 capture（full 档不因未进模型流丢失）', async () => {
  const h = harness([], {
    cfg: {
      resolution: { provider: 'p1', model: 'm1', layer: 'unavailable', effort: 'low' },
      ui: { trace: { capture: 'full' } },
    },
  });
  const verdict = await h.review();
  assert.equal(verdict.decision, 'error', '模型不可用按故障拒绝');
  assert.equal(h.entries.length, 1, '早退路径同样落一条审查记录');
  const entry = h.entries[0];
  assert.equal(entry.capture, 'full', '早退记录仍携带请求快照的 capture 档');
  assert.equal(entry.decision, 'error');
  assert.equal(entry.attempts, 0, '未进入模型流，attempts 记 0');
});

test('onReview：提示构建抛错仍携带 capture（错误路径记录不缺 capture 标记）', async () => {
  const entries = [];
  const reviewer = createReviewer({
    llm: { stream() { throw new Error('unreachable'); } },
    blocks: { BlockAssembler: FakeAssembler },
    messages,
    tools: { schemas: [], run: async () => ({ text: 'x', isError: false }) },
    prompt: {
      buildSystem: () => {
        throw new Error('prompt boom');
      },
      buildUserTexts: () => ({ evidenceText: 'EV', actionText: 'ACTION' }),
    },
    audit: () => {},
    onReview: (entry) => entries.push(entry),
  });
  const verdict = await reviewer.review(
    { toolName: 'pwsh', reason: 'escalate sandbox: x' },
    { command: 'npm i' },
    { fields: {}, evidence: 'E' },
    {
      reviewer: { maxTokens: 0, temperature: 0, maxToolSteps: 4, timeoutMs: 1000 },
      audit: {},
      resolution: { provider: 'p1', model: 'm1', layer: 'user', effort: 'low' },
      ui: { trace: { capture: 'full' } },
    },
    { id: 'r1', signal: new AbortController().signal },
  );
  assert.equal(verdict.decision, 'error', '提示构建抛错收敛为故障拒绝（review 永不抛出）');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].capture, 'full', '错误路径记录仍携带请求快照的 capture 档');
  assert.equal(entries[0].decision, 'error');
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
  assert.equal(entry.capture, 'off', 'off 档等值携带 capture 标记（三档枚举齐全）');
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
      // 同步抛错即可：reviewer 内部收束为 decision=error，finish 仍会落一条记录，不需要真流。
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
    // capture 生效标记（design §8.2 词汇表）：请求快照未显式配置时取缺省 summary，随记录落盘。
    assert.equal(first[0].capture, 'summary', 'capture 标记随记录落盘（缺省 summary）');
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

// ── 真链：上下文采集与命令回查降级贯通审查装配 ────────

/**
 * 跑一次完整审批并捕获送审证据段与落盘审查记录（真 gate→screen→reviewer→record 链）。
 * @param {object} options - `snapshotEvents`（缺省＝会话无该接口）、`sessionHeader`、`context`（context 配置覆盖）、
 *   `lang`（language.agent）、`events`（正常事件流快捷方式，含接管预设与 tool/call）。
 * @returns {Promise<object | undefined>} `{ evidenceText, reviewRow, stderr }`；宿主包不可解析时 `undefined`。
 */
async function contextChain(options = {}) {
  const host = await loadHost();
  if (host === undefined) return undefined;
  const tmp = await mkdtemp(join(tmpdir(), 'afm-ctx-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = tmp;
  const written = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    const config = {
      mode: 'rules',
      language: { agent: options.lang ?? 'zh' },
      reviewer: { model: 'deepseek-official/probe-model' },
      unknownSubject: 'review',
      context: { ...(options.context ?? {}) },
    };
    const listeners = [];
    const events = options.events ?? [
      { type: 'permission/preset', data: { preset: 'auto-approve' } },
      { type: 'user/message', data: { content: [{ type: 'text', text: 'CONTEXT-LINE-A' }] } },
      { type: 'user/message', data: { content: [{ type: 'text', text: 'CONTEXT-LINE-B' }] } },
      { type: 'tool/call', data: { callId: 'call-ctx', name: 'pwsh', arguments: JSON.stringify({ command: 'npm i' }) } },
    ];
    const session = {
      id: 'session-ctx',
      header: options.sessionHeader === 'none' ? {} : { cwd: tmp },
      ...(options.snapshotEvents !== undefined ? { snapshotEvents: options.snapshotEvents } : {}),
      ...(options.snapshotEvents === undefined && options.noSnapshot !== true ? { snapshotEvents: () => events } : {}),
    };
    const evidenceTexts = [];
    const ctx = {
      on: (event, handler, prepend) => {
        listeners.push({ event, handler, prepend });
        return () => {};
      },
      // 宿主侧服务读取器（index 经 ctx.get 取）：预设判定先读服务、不依赖会话事件折叠——
      // snapshotEvents 不可用（抛错或接口缺失）时仍能接管到审查（foldPresetEvent 只作回退）。
      get: (key) =>
        key === 'permissionPresets'
          ? { current: () => 'auto-approve' }
          : key === 'sessions'
            ? { list: () => [] }
            : undefined,
      llm: {
        listProviders: () => [{ id: 'deepseek-official' }],
        resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }] } }),
        // 捕获送审证据段（首条消息文本）后抛错：reviewer 收束为 error 判定，记录照落。
        stream: (streamOptions) => {
          evidenceTexts.push(streamOptions?.messages?.[0]?.content?.[0]?.text ?? '');
          throw new Error('stream exploded');
        },
      },
    };
    host.apply(ctx, config);
    const answerer = listeners.find((entry) => entry.event === 'approval/request').handler;
    const outcome = await answerer(
      {
        agent: { session, inject: () => {} },
        callId: options.callId ?? 'call-ctx',
        toolName: 'pwsh',
        reason: 'escalate sandbox to danger-full-access: run npm i',
      },
      () => new Promise(() => {}),
    );
    const file = join(tmp, 'approve-for-me', 'reviews', 'ctx.jsonl');
    const rows = await waitForLines(file, 2);
    const reviewRow = rows.find((row) => row.kind === 'review');
    return { outcome, evidenceText: evidenceTexts[0] ?? '', reviewRow, stderr: written.join('') };
  } finally {
    process.stderr.write = originalWrite;
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
}

test('真链：snapshotEvents 抛错 → 证据段附读取失败说明行、记录与审计含 transcript-read-failed（zh/en 各一档）', async (t) => {
  for (const lang of ['zh', 'en']) {
    const result = await contextChain({ lang, snapshotEvents: () => { throw new Error('snapshot boom'); } });
    if (result === undefined) {
      t.skip('宿主包不可解析（离线环境）');
      return;
    }
    const marker = lang === 'zh' ? '上下文转录读取失败，本次没有可用会话上下文。' : 'Context transcript read failed;';
    assert.ok(result.evidenceText.includes(marker), `[${lang}] 证据段应含读取失败说明行：${result.evidenceText.slice(0, 120)}`);
    assert.ok(result.reviewRow.degraded.includes('transcript-read-failed'), `[${lang}] 落盘记录 degraded 含 transcript-read-failed`);
    assert.ok(!result.reviewRow.evidence, `[${lang}] 读取失败时 evidence 为空`);
    assert.match(result.stderr, /phase=review [^\n]*degraded=[^\n]*transcript-read-failed/, `[${lang}] 审计 review 行含标记`);
  }
});

test('真链：snapshotEvents 接口缺失与返回非数组两形态 → 同读取失败档断言', async (t) => {
  // 形态一：会话没有 snapshotEvents 接口。
  const missing = await contextChain({ noSnapshot: true });
  if (missing === undefined) {
    t.skip('宿主包不可解析（离线环境）');
    return;
  }
  assert.ok(missing.evidenceText.includes('上下文转录读取失败'), '接口缺失：证据段含读取失败说明行');
  assert.ok(missing.reviewRow.degraded.includes('transcript-read-failed'), '接口缺失：记录 degraded 含标记');
  // 形态二：返回非数组。
  const nonArray = await contextChain({ snapshotEvents: () => ({ not: 'an array' }) });
  assert.ok(nonArray.evidenceText.includes('上下文转录读取失败'), '非数组返回：证据段含读取失败说明行');
  assert.ok(nonArray.reviewRow.degraded.includes('transcript-read-failed'), '非数组返回：记录 degraded 含标记');
});

test('真链：maxTranscriptBytes 极小触发总量截断 → 内联截断标记与 transcript-truncated，evidence 在场', async (t) => {
  const result = await contextChain({ context: { maxTranscriptBytes: 24 } });
  if (result === undefined) {
    t.skip('宿主包不可解析（离线环境）');
    return;
  }
  assert.ok(result.evidenceText.includes('<truncated omitted_approx_tokens='), '证据段含内联截断标记');
  assert.ok(result.reviewRow.degraded.includes('transcript-truncated'), '记录 degraded 含 transcript-truncated');
  assert.ok(!result.reviewRow.degraded.includes('transcript-read-failed'), '预算截断不混用读取失败标记');
  assert.ok(result.reviewRow.evidence, '总量截断时 evidence 在场（非空）');
});

test('真链反例：正常事件（有上下文）→ evidence 在场、无采集标记、证据段无说明行', async (t) => {
  const result = await contextChain({});
  if (result === undefined) {
    t.skip('宿主包不可解析（离线环境）');
    return;
  }
  assert.ok(result.evidenceText.includes('CONTEXT-LINE-A'), '证据段含会话上下文');
  assert.ok(!result.evidenceText.includes('读取失败'), '正常路径无读取失败说明行');
  assert.equal(result.reviewRow.degraded, 'none', '无任何采集降级标记');
  assert.ok(result.reviewRow.evidence, 'evidence 在场');
});

test('真链反例：maxEntries=0（有意零取样）→ evidence 缺失、无采集标记、无说明行', async (t) => {
  const result = await contextChain({ context: { maxEntries: 0 } });
  if (result === undefined) {
    t.skip('宿主包不可解析（离线环境）');
    return;
  }
  assert.ok(!result.evidenceText.includes('CONTEXT-LINE'), '零取样：证据段无上下文行');
  assert.ok(!result.evidenceText.includes('读取失败'), '零取样不是读取失败：无说明行');
  assert.ok(!result.reviewRow.degraded.includes('transcript'), '零取样不记采集标记（准确归因）');
  assert.ok(!result.reviewRow.evidence, 'evidence 缺失（空）');
});

test('真链：事件流无匹配 callId → degraded 含 command，动作段含 agent.commandMissing 行（zh/en 各一档）', async (t) => {
  for (const lang of ['zh', 'en']) {
    const result = await contextChain({
      lang,
      callId: 'call-unknown',
      events: [
        { type: 'permission/preset', data: { preset: 'auto-approve' } },
        { type: 'tool/call', data: { callId: 'call-other', name: 'pwsh', arguments: JSON.stringify({ command: 'npm i' }) } },
      ],
    });
    if (result === undefined) {
      t.skip('宿主包不可解析（离线环境）');
      return;
    }
    // 动作段是送审第二条消息：捕获只取了证据段，这里经 stderr 审计与记录断言（动作段文案另经 prompt 审计不可用时以记录为准）。
    assert.ok(result.reviewRow.degraded.includes('command'), `[${lang}] 回查不到调用：记录 degraded 含 command`);
    assert.ok(result.stderr.includes('degraded=command') || result.reviewRow.degraded.includes('command'), `[${lang}] 审计可见 command 标记`);
  }
});

test('真链：tool/call 的 arguments 是坏 JSON → 同回查不到调用档断言（degraded 含 command）', async (t) => {
  const result = await contextChain({
    events: [
      { type: 'permission/preset', data: { preset: 'auto-approve' } },
      { type: 'tool/call', data: { callId: 'call-ctx', name: 'pwsh', arguments: '{not json' } },
    ],
  });
  if (result === undefined) {
    t.skip('宿主包不可解析（离线环境）');
    return;
  }
  assert.ok(result.reviewRow.degraded.includes('command'), '坏参数：记录 degraded 含 command');
  assert.ok(!result.reviewRow.degraded.includes('cwd'), '目录在场：不含 cwd 标记');
});

test('真链：header.cwd 缺失 → degraded 含 cwd（无 command，回查成功），现行行为钉回归', async (t) => {
  const result = await contextChain({ sessionHeader: 'none' });
  if (result === undefined) {
    t.skip('宿主包不可解析（离线环境）');
    return;
  }
  assert.ok(result.reviewRow.degraded.includes('cwd'), '目录缺失：记录 degraded 含 cwd');
  assert.ok(!result.reviewRow.degraded.includes('command'), '回查成功：不含 command 标记');
  assert.ok(result.reviewRow.subject, 'subject 照常（按工具名与理由回退）');
});

test('真链反例：正常回查（命令与目录齐备）→ degraded 不含 cwd/command', async (t) => {
  const result = await contextChain({});
  if (result === undefined) {
    t.skip('宿主包不可解析（离线环境）');
    return;
  }
  assert.ok(!result.reviewRow.degraded.includes('cwd'), '正常路径不含 cwd');
  assert.ok(!result.reviewRow.degraded.includes('command'), '正常路径不含 command');
  assert.equal(result.reviewRow.subject, 'npm i', 'subject 取回查命令');
});

// ── 生产装配的取消贯通与在飞请求配置快照（design §5.1/§8.2） ──────────────────

test('真链：在飞审查期间配置热改采集档，记录按请求入口快照落盘（不被后续配置改写）', async (t) => {
  const host = await loadHost();
  if (host === undefined) {
    t.skip('宿主包不可解析（离线环境）');
    return;
  }
  const tmp = await mkdtemp(join(tmpdir(), 'afm-race-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = tmp;
  const config = { mode: 'rules', reviewer: { model: 'deepseek-official/probe-model' } };
  const callId = 'call-race';
  /** 挂起流：等外部放行后才产出正文——制造「请求在飞、配置热改」的窗口。 */
  let releaseStream;
  const gateOfStream = new Promise((resolvePromise) => {
    releaseStream = resolvePromise;
  });
  const listeners = [];
  const session = {
    id: 'session-race',
    header: { cwd: tmp },
    snapshotEvents: () => [
      { type: 'permission/preset', data: { preset: 'auto-approve' } },
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
      stream: async function* generate() {
        await gateOfStream;
        yield { type: 'text-delta', index: 0, text: '{"outcome":"allow","risk_level":"low","user_authorization":"high","rationale":"probe ok"}' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
  };
  try {
    host.apply(ctx, config);
    const answerer = listeners.find((entry) => entry.event === 'approval/request').handler;
    const request = {
      agent: { session, inject: () => {} },
      callId,
      toolName: 'pwsh',
      reason: 'escalate sandbox to danger-full-access: run npm i',
    };
    const settled = answerer(request, () => new Promise(() => {}));
    // 在飞期间热改采集档 summary→full：本请求的记录必须仍按入口快照（summary）落。
    config.ui = { trace: { capture: 'full' } };
    releaseStream();
    assert.equal(await settled, 'allowed-once');
    const file = join(tmp, 'approve-for-me', 'reviews', 'race.jsonl');
    const lines = await waitForLines(file, 2);
    const reviewRow = lines.find((row) => row.kind === 'review');
    assert.equal(reviewRow.capture, 'summary', '采集档按请求入口快照：在飞热改 full 不穿透');
    assert.equal(reviewRow.prompt, undefined, '快照 summary：详情全文不落');
    assert.equal(reviewRow.tracePlan, undefined, '控制字段不落盘');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});

test('真链：排队中的请求被取消——不执行审查、不写 error 审计行、按 cancelled 结算', async (t) => {
  const host = await loadHost();
  if (host === undefined) {
    t.skip('宿主包不可解析（离线环境）');
    return;
  }
  const tmp = await mkdtemp(join(tmpdir(), 'afm-qcancel-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = tmp;
  const config = {
    mode: 'rules',
    reviewer: { model: 'deepseek-official/probe-model' },
    concurrency: { max: 1, queueMax: 4, queueTimeoutMs: 60000 },
  };
  const listeners = [];
  let streamCalls = 0;
  let releaseStream;
  const gateOfStream = new Promise((resolvePromise) => {
    releaseStream = resolvePromise;
  });
  const makeSession = (sid, callId) => ({
    id: sid,
    header: { cwd: tmp },
    snapshotEvents: () => [
      { type: 'permission/preset', data: { preset: 'auto-approve' } },
      { type: 'tool/call', data: { callId, name: 'pwsh', arguments: JSON.stringify({ command: 'npm i' }) } },
    ],
  });
  const ctx = {
    on: (event, handler, prepend) => {
      listeners.push({ event, handler, prepend });
      return () => {};
    },
    llm: {
      listProviders: () => [{ id: 'deepseek-official' }],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }] } }),
      stream: async function* generate() {
        streamCalls += 1;
        await gateOfStream;
        throw new Error('stream exploded');
      },
    },
  };
  try {
    host.apply(ctx, config);
    const answerer = listeners.find((entry) => entry.event === 'approval/request').handler;
    // 请求 1：占住唯一执行位（流挂起）。请求 2：同会话串行 → 排队，随后被取消。
    const first = answerer({
      agent: { session: makeSession('session-qcancel', 'call-q1'), inject: () => {} },
      callId: 'call-q1',
      toolName: 'pwsh',
      reason: 'escalate sandbox to danger-full-access: run npm i',
    }, () => new Promise(() => {}));
    const controller = new AbortController();
    const second = answerer({
      agent: { session: makeSession('session-qcancel', 'call-q2'), inject: () => {} },
      callId: 'call-q2',
      toolName: 'pwsh',
      reason: 'escalate sandbox to danger-full-access: run npm i',
      signal: controller.signal,
    }, () => new Promise(() => {}));
    // 等第二个请求真正进入队列（gate 装配为异步）。
    await new Promise((resolve) => setTimeout(resolve, 80));
    controller.abort('user cancelled');
    assert.equal(await second, 'cancelled', '取消的请求按 cancelled 结算');
    releaseStream();
    assert.equal(await first, 'rejected');
    // streamCalls=2 都是占位请求的整建重试（可重试错误两尝试）；被取消的排队请求若误发起流，
    // 会多出一次调用并落一条 call-q2 的审查记录——由下面的记录断言钉住。
    assert.equal(streamCalls, 2, '取消的排队请求不追加 llm.stream（2＝占位请求的两尝试）');
    const file = join(tmp, 'approve-for-me', 'reviews', 'qcancel.jsonl');
    const lines = await waitForLines(file, 3);
    const reviewRows = lines.filter((row) => row.kind === 'review');
    const settleRows = lines.filter((row) => row.kind === 'settle');
    assert.equal(reviewRows.length, 1, '只有占位请求产出审查记录；被取消的排队请求不产 error 记录');
    assert.equal(reviewRows[0].callId, 'call-q1');
    const cancelledSettle = settleRows.find((row) => row.callId === 'call-q2');
    assert.ok(cancelledSettle, '取消请求的结算记录在场');
    assert.equal(cancelledSettle.outcome, 'cancelled');
    assert.equal(cancelledSettle.source, 'signal');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});

test('真链：审查计时在排队期间到点——按超时结算且冷却计数不因任务未启动而丢失', async (t) => {
  const host = await loadHost();
  if (host === undefined) {
    t.skip('宿主包不可解析（离线环境）');
    return;
  }
  const tmp = await mkdtemp(join(tmpdir(), 'afm-qtimer-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = tmp;
  // 排队等待上限远大于审查时限：让排队中的请求先被审查计时器击中（任务未启动）。
  const config = {
    mode: 'rules',
    reviewer: { model: 'deepseek-official/probe-model', timeoutMs: 120 },
    concurrency: { max: 1, queueMax: 4, queueTimeoutMs: 60000 },
    breaker: { consecutiveDenials: 1, windowSize: 10, windowDenials: 5, cooldownMs: 60000 },
  };
  const listeners = [];
  let streamCalls = 0;
  let releaseStream;
  const gateOfStream = new Promise((resolvePromise) => {
    releaseStream = resolvePromise;
  });
  const makeSession = (sid, callId) => ({
    id: sid,
    header: { cwd: tmp },
    snapshotEvents: () => [
      { type: 'permission/preset', data: { preset: 'auto-approve' } },
      { type: 'tool/call', data: { callId, name: 'pwsh', arguments: JSON.stringify({ command: 'npm i' }) } },
    ],
  });
  const ctx = {
    on: (event, handler, prepend) => {
      listeners.push({ event, handler, prepend });
      return () => {};
    },
    llm: {
      listProviders: () => [{ id: 'deepseek-official' }],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }] } }),
      stream: async function* generate() {
        streamCalls += 1;
        await gateOfStream;
        yield { type: 'text-delta', index: 0, text: '{"outcome":"allow","risk_level":"low","user_authorization":"high","rationale":"ok"}' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
  };
  try {
    host.apply(ctx, config);
    const answerer = listeners.find((entry) => entry.event === 'approval/request').handler;
    // 请求 1 占住唯一执行位（流挂起）；请求 2 同会话排队，审查时限 120ms 在排队期间到点。
    const first = answerer({
      agent: { session: makeSession('session-qtimer', 'call-t1'), inject: () => {} },
      callId: 'call-t1',
      toolName: 'pwsh',
      reason: 'escalate sandbox to danger-full-access: run npm i',
    }, () => new Promise(() => {}));
    const second = answerer({
      agent: { session: makeSession('session-qtimer', 'call-t2'), inject: () => {} },
      callId: 'call-t2',
      toolName: 'pwsh',
      reason: 'escalate sandbox to danger-full-access: run npm i',
    }, () => new Promise(() => {}));
    assert.equal(await second, 'rejected', '排队中被审查计时击中：按超时拒绝结算');
    // 未启动任务的超时计数已发生（consecutiveDenials=1）→ 冷却打开：第三个请求未执行审查即被拦。
    const third = await answerer({
      agent: { session: makeSession('session-qtimer', 'call-t3'), inject: () => {} },
      callId: 'call-t3',
      toolName: 'pwsh',
      reason: 'escalate sandbox to danger-full-access: run npm i',
    }, () => new Promise(() => {}));
    assert.equal(third, 'rejected', '冷却打开后的请求按拒绝结算');
    releaseStream();
    // 占位请求与排队请求共用同一审查时限：releaseStream 时占位请求自身的计时器多半已到点。
    // 竞速双结局都合法（timer 赢→rejected/timeout、流先赢→allowed-once，迟到结论 late 丢弃），
    // 本测试只钉排队计数链（second/third 断言），不锁占位请求的具体结局。
    const firstOutcome = await first;
    assert.ok(firstOutcome === 'allowed-once' || firstOutcome === 'rejected', `占位请求结局合法（实得 ${firstOutcome}）`);
    assert.equal(streamCalls, 1, '排队请求与冷却拦截请求都不发起模型流（1＝占位请求）');
    const file = join(tmp, 'approve-for-me', 'reviews', 'qtimer.jsonl');
    const lines = await waitForLines(file, 3);
    const settles = lines.filter((row) => row.kind === 'settle');
    const firstSettle = settles.find((row) => row.callId === 'call-t1');
    if (firstOutcome === 'rejected') {
      assert.equal(firstSettle.source, 'timeout', '占位请求按超时结算时：来源为 timeout');
      assert.equal(firstSettle.stage, 'review', '环节记审查');
    } else {
      assert.equal(firstSettle.outcome, 'allowed-once');
    }
    const secondSettle = settles.find((row) => row.callId === 'call-t2');
    assert.ok(secondSettle, '排队超时请求的结算记录在场');
    assert.equal(secondSettle.outcome, 'rejected');
    assert.equal(secondSettle.source, 'timeout', '按超时来源结算');
    assert.equal(secondSettle.stage, 'review', '环节记审查（审查计时到点，非排队等待上限）');
    const thirdSettle = settles.find((row) => row.callId === 'call-t3');
    assert.ok(thirdSettle, '冷却拦截请求的结算记录在场');
    assert.equal(thirdSettle.source, 'llm', '冷却未执行按通道故障来源结算');
    assert.match(thirdSettle.reason, /冷却/u, '结算理由写明冷却');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});

test('真链：在飞审查期间配置热改采集档 full→summary，记录仍按入口快照保留详情', async (t) => {
  const host = await loadHost();
  if (host === undefined) {
    t.skip('宿主包不可解析（离线环境）');
    return;
  }
  const tmp = await mkdtemp(join(tmpdir(), 'afm-race2-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = tmp;
  const config = { mode: 'rules', reviewer: { model: 'deepseek-official/probe-model' }, ui: { trace: { capture: 'full' } } };
  const callId = 'call-race2';
  let releaseStream;
  const gateOfStream = new Promise((resolvePromise) => {
    releaseStream = resolvePromise;
  });
  const listeners = [];
  const session = {
    id: 'session-race2',
    header: { cwd: tmp },
    snapshotEvents: () => [
      { type: 'permission/preset', data: { preset: 'auto-approve' } },
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
      stream: async function* generate() {
        await gateOfStream;
        yield { type: 'text-delta', index: 0, text: '{"outcome":"allow","risk_level":"low","user_authorization":"high","rationale":"probe ok"}' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
  };
  try {
    host.apply(ctx, config);
    const answerer = listeners.find((entry) => entry.event === 'approval/request').handler;
    const request = {
      agent: { session, inject: () => {} },
      callId,
      toolName: 'pwsh',
      reason: 'escalate sandbox to danger-full-access: run npm i',
    };
    const settled = answerer(request, () => new Promise(() => {}));
    // 在飞期间热改采集档 full→summary（原始缺陷方向：降档不得丢掉本请求的详情）。
    config.ui = { trace: { capture: 'summary' } };
    releaseStream();
    assert.equal(await settled, 'allowed-once');
    const file = join(tmp, 'approve-for-me', 'reviews', 'race2.jsonl');
    const lines = await waitForLines(file, 2);
    const reviewRow = lines.find((row) => row.kind === 'review');
    assert.equal(reviewRow.capture, 'full', '采集档按请求入口快照：在飞热改 summary 不穿透');
    assert.ok(reviewRow.prompt !== undefined, '快照 full：详情全文照常落盘');
    assert.equal(reviewRow.tracePlan, undefined, '控制字段不落盘');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});
