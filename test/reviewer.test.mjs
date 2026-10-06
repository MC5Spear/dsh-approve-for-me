import assert from 'node:assert/strict';
import test from 'node:test';
import { createReviewer, finishDegraded, finishTag, parseAssessment, retryableOutcome, REVIEW_MAX_ATTEMPTS } from '../lib/reviewer.js';
import { REVIEW_SUPERSEDED, REVIEW_TIMEOUT_ABORT_MESSAGE } from '../lib/gate.js';

/**
 * 假组装器：模拟 `BlockAssembler` 的对外行为，含 `finish` / `usage` 访问器（设计「截断与空输出的判定（宿主 FinishReason 是唯一判据）」）。
 * `finish` 由本次流的最后一个 `{type:'finish', reason}` 决定，与宿主一致。
 */
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

/** 假消息构造器：保留审查循环真正关心的字段。 */
const messages = {
  createUserMessage: (input) => ({ role: 'user', content: input.content, source: input.source }),
  createAssistantMessage: (input) => ({ role: 'assistant', content: input.content, source: { kind: 'model', ...input.source } }),
  createToolResultMessage: (input) => ({
    role: 'tool-result',
    callId: input.callId,
    content: input.content,
    isError: input.isError,
  }),
};

const prompt = {
  buildSystem: () => 'SYSTEM',
  buildUserTexts: (input) => ({ evidenceText: `EV:${input.evidence}`, actionText: 'ACTION' }),
};

/** 文本块。 */
const text = (value) => ({ type: 'text', text: value });
/** 工具调用块。 */
const call = (id, name, args) => ({ type: 'tool-call', id, name, arguments: args });

/**
 * 构造一次审查调用的全部依赖。
 * @param {Array<{blocks: object[], finish?: object, usage?: object, throws?: string}>} turns - 每次 `llm.stream`
 *   返回的块序列（可选流末原因与用量）；`throws` 让该次流一开始迭代就抛错（R47 网络错替身）。
 * @param {object} [options] - 覆盖项：工具实现、配置、onReview 回调。
 * @returns {{review: Function, requests: object[], audits: object[], toolRuns: object[]}} 测试句柄。
 */
function harness(turns, options = {}) {
  const requests = [];
  const audits = [];
  const toolRuns = [];
  let index = 0;
  const llm = {
    stream(request) {
      // 快照消息数组：审查循环会继续向同一数组追加，测试要看到当时的形状。
      requests.push({ ...request, messages: [...request.messages] });
      const turn = turns[Math.min(index, turns.length - 1)];
      index += 1;
      if (turn.throws !== undefined) {
        // 流迭代中途抛错的最小替身：首块前即抛（与真实网络错在 for await 处被捕获同路径）。
        return (async function* generate() {
          throw new Error(turn.throws);
        })();
      }
      return (async function* generate() {
        for (const block of turn.blocks) yield { type: 'block', index: 0, block };
        if (turn.usage !== undefined) yield { type: 'usage', usage: turn.usage };
        yield { type: 'finish', reason: turn.finish ?? { kind: 'stop' } };
      })();
    },
  };
  const tools = {
    schemas: [{ name: 'read_file' }],
    run: async (name, args) => {
      toolRuns.push({ name, args });
      if (options.toolThrows === true) throw new Error('tool exploded');
      return { text: `result:${name}`, isError: false };
    },
  };
  const reviewer = createReviewer({
    llm,
    blocks: { BlockAssembler: FakeAssembler },
    messages,
    tools,
    prompt,
    audit: (fields) => audits.push(fields),
    ...(options.onReview === undefined ? {} : { onReview: options.onReview }),
  });
  const cfg = {
    reviewer: { maxTokens: 512, temperature: 0, maxToolSteps: 4, reasoningEffort: 'low', timeoutMs: 1000 },
    audit: { includePrompt: false, includeRaw: false },
    resolution: { provider: 'deepseek-official', model: 'deepseek-v4-flash', layer: 'user', effort: 'low' },
    ...options.cfg,
  };
  return {
    requests,
    audits,
    toolRuns,
    review: (reviewOpts) => reviewer.review(
      { toolName: 'pwsh', reason: 'escalate sandbox to danger-full-access: x' },
      { command: 'npm i' },
      { fields: {}, evidence: 'E' },
      cfg,
      { id: 'r1', signal: new AbortController().signal, ...reviewOpts },
    ),
  };
}

test('parseAssessment：整段 JSON', () => {
  const verdict = parseAssessment('{"risk_level":"medium","user_authorization":"high","outcome":"allow","rationale":"scoped"}');
  assert.deepEqual(
    { decision: verdict.decision, risk: verdict.risk, authorization: verdict.authorization, reason: verdict.reason },
    { decision: 'allow', risk: 'medium', authorization: 'high', reason: 'scoped' },
  );
});

test('parseAssessment：散文包裹与缺省填充', () => {
  const wrapped = parseAssessment('Here is my answer:\n{"outcome":"deny","risk_level":"critical"}\nThanks.');
  assert.equal(wrapped.decision, 'deny');
  assert.equal(wrapped.risk, 'critical');
  assert.equal(wrapped.authorization, 'unknown');
  assert.match(wrapped.reason, /No rationale/);

  const allowWithoutRisk = parseAssessment('{"outcome":"allow"}');
  assert.equal(allowWithoutRisk.risk, 'low');

  const denyWithoutRisk = parseAssessment('{"outcome":"deny"}');
  assert.equal(denyWithoutRisk.risk, 'high');
});

test('parseAssessment：空 payload / 畸形 JSON / 非法 outcome 一律 error', () => {
  assert.deepEqual(pick(parseAssessment('')), { decision: 'error', reason: 'empty payload' });
  assert.deepEqual(pick(parseAssessment('   ')), { decision: 'error', reason: 'empty payload' });
  assert.deepEqual(pick(parseAssessment('{"outcome": "allow"')), { decision: 'error', reason: 'not valid JSON' });
  assert.equal(parseAssessment('{"outcome":"maybe"}').decision, 'error');
  assert.equal(parseAssessment('{"risk_level":"low"}').decision, 'error');
});

test('parseAssessment：缺省填充记为 fieldsDefaulted，与审计行截断无关（设计「两处需要额外说明的取值」）', () => {
  assert.equal(parseAssessment('{"outcome":"allow","risk_level":"low","user_authorization":"high"}').fieldsDefaulted, false);
  assert.equal(parseAssessment('{"outcome":"allow"}').fieldsDefaulted, true);
  assert.equal(parseAssessment('').fieldsDefaulted, false);
});

/** 只取断言关心的两个字段。 */
function pick(verdict) {
  return { decision: verdict.decision, reason: verdict.reason };
}

test('review：一轮工具调用后回喂并解析最终 JSON', async () => {
  const h = harness([
    { blocks: [text('let me check'), call('c1', 'read_file', '{"path":"a.txt"}')] },
    { blocks: [text('{"outcome":"allow","risk_level":"low","user_authorization":"medium","rationale":"ok"}')] },
  ]);
  const verdict = await h.review();
  assert.equal(verdict.decision, 'allow');
  assert.equal(verdict.risk, 'low');
  assert.equal(verdict.toolCalls, 1);
  assert.deepEqual(h.toolRuns, [{ name: 'read_file', args: { path: 'a.txt' } }]);

  // I5/I6：第一次请求带工具与两条 user 消息；第二次追加 assistant(tool_calls) + tool result。
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0].messages.length, 2);
  assert.equal(h.requests[0].tools.length, 1);
  const second = h.requests[1].messages;
  assert.equal(second.length, 4);
  assert.equal(second[2].role, 'assistant');
  assert.equal(second[2].content[1].type, 'tool-call');
  assert.equal(second[3].role, 'tool-result');
  assert.equal(second[3].callId, 'c1');
  assert.equal(second[3].isError, false);
});

test('review：多个工具调用逐个配对，非法 JSON 参数仍回喂 isError（I7）', async () => {
  const h = harness(
    [
      { blocks: [call('c1', 'read_file', '{"path":"a"}'), call('c2', 'grep', 'not-json')] },
      { blocks: [text('{"outcome":"deny","rationale":"nope"}')] },
    ],
    // 回喂文案断言按 zh 档写（zh 字节与字典化前一致）：显式声明语言，不依赖回落方向。
    { cfg: { language: { agent: 'zh' } } },
  );
  const verdict = await h.review();
  assert.equal(verdict.decision, 'deny');
  assert.equal(verdict.toolCalls, 2);
  const results = h.requests[1].messages.filter((message) => message.role === 'tool-result');
  assert.deepEqual(results.map((message) => message.callId), ['c1', 'c2']);
  assert.equal(results[1].isError, true);
  assert.match(results[1].content[0].text, /不是合法 JSON/);
});

test('review：工具抛错视为无证据，循环继续', async () => {
  const h = harness(
    [
      { blocks: [call('c1', 'read_file', '{"path":"a"}')] },
      { blocks: [text('{"outcome":"allow","rationale":"continued"}')] },
    ],
    { toolThrows: true },
  );
  const verdict = await h.review();
  assert.equal(verdict.decision, 'allow');
  const result = h.requests[1].messages.find((message) => message.role === 'tool-result');
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /tool exploded/);
});

test('review：回喂错误文本按 language.agent 切换——参数非法与工具失败两路径（G2/N2 两语言行为差异）', async () => {
  // 一轮内两条回喂路径同时触发：c1 参数合法但工具抛错（execFailed）、c2 参数非合法 JSON（argsJsonInvalid）。
  const turns = [
    { blocks: [call('c1', 'read_file', '{"path":"a"}'), call('c2', 'grep', 'not-json')] },
    { blocks: [text('{"outcome":"deny","rationale":"nope"}')] },
  ];
  const resultsOf = async (language) => {
    const h = harness(turns, { toolThrows: true, cfg: { language } });
    await h.review();
    return h.requests[1].messages.filter((message) => message.role === 'tool-result');
  };

  // zh 档：整句字节核对（模板前缀＋被透传的错误消息）。
  const zh = await resultsOf({ agent: 'zh' });
  assert.equal(zh[0].isError, true);
  assert.equal(zh[0].content[0].text, '工具 read_file 失败：tool exploded');
  assert.equal(zh[1].isError, true);
  assert.match(zh[1].content[0].text, /^工具参数不是合法 JSON：/u, 'zh 档参数非法回喂须为中文整句');

  // en 档：同一轮输入下回喂为对应英文整句，且不含 zh 档短语。
  const en = await resultsOf({ agent: 'en' });
  assert.equal(en[0].isError, true);
  assert.equal(en[0].content[0].text, 'Tool read_file failed: tool exploded');
  assert.equal(en[1].isError, true);
  assert.match(en[1].content[0].text, /^Tool arguments are not valid JSON: /u, 'en 档参数非法回喂须为英文整句');
  for (const message of en) {
    assert.doesNotMatch(message.content[0].text, /不是合法 JSON/u, 'en 档不得残留 zh 档短语');
    assert.doesNotMatch(message.content[0].text, /失败：/u, 'en 档不得残留 zh 档模板');
  }
  assert.doesNotMatch(zh[0].content[0].text, /failed:/u, 'zh 档不得残留 en 档模板');
  // 变红判据：若回喂退回硬编码 zh（N2 修正前形态），en 档整句等值断言与两条
  // doesNotMatch 双红；若 cfg.language.agent 不再驱动回喂语言（两档同文），zh[0]/en[0]
  // 的整句断言其一必红（两档文本不可能同时等于两种模板）。
});

test('review：工具轮次超限后追加「请直接给出结论」且不再带工具（R28 缺省 en，zh 档可切）', async () => {
  const turns = [
    { blocks: [call('c1', 'read_file', '{"path":"a"}')] },
    { blocks: [call('c2', 'read_file', '{"path":"b"}')] },
    { blocks: [text('{"outcome":"deny","rationale":"budget"}')] },
  ];
  // 未配置 language 时 Agent 提示回落 en（＝schema 默认档；回落谓词单源 agentLangOf，R32-3）。
  const h = harness(turns, { cfg: { reviewer: { maxTokens: 512, temperature: 0, maxToolSteps: 2, reasoningEffort: 'low', timeoutMs: 1000 } } });
  const verdict = await h.review();
  assert.equal(verdict.decision, 'deny');
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests[2].tools, undefined);
  const last = h.requests[2].messages[h.requests[2].messages.length - 1];
  assert.match(last.content[0].text, /The tool round budget is exhausted/u, '缺省档应为英文轮次用尽指令');

  // zh 档：同一 harness 换 language.agent 后指令变中文（行为差异断言，非存在性）。
  const hz = harness(turns, { cfg: { language: { agent: 'zh' }, reviewer: { maxTokens: 512, temperature: 0, maxToolSteps: 2, reasoningEffort: 'low', timeoutMs: 1000 } } });
  await hz.review();
  const lastZh = hz.requests[2].messages[hz.requests[2].messages.length - 1];
  assert.match(lastZh.content[0].text, /工具轮次已用完/u, 'zh 档应为中文轮次用尽指令');
  assert.doesNotMatch(lastZh.content[0].text, /The tool round budget is exhausted/u, 'zh 档不得残留英文指令');
});

test('review：无模型可用时不发起请求，返回 error 并记录 degraded=all', async () => {
  const h = harness([{ blocks: [text('{}')] }], {
    cfg: { resolution: { layer: 'unavailable', effort: 'none', degraded: 'all' } },
  });
  const verdict = await h.review();
  assert.equal(verdict.decision, 'error');
  assert.equal(h.requests.length, 0);
  assert.equal(verdict.fields.degraded, 'all');
});

test('review：Verdict.fields 是审计字段的唯一投影（N16）', async () => {
  const h = harness([
    {
      blocks: [text('{"outcome":"allow","risk_level":"low","user_authorization":"high","rationale":"fine"}')],
      usage: { outputTokens: 12, reasoningTokens: 34 },
    },
  ]);
  const verdict = await h.review();
  assert.deepEqual(verdict.fields, {
    risk: 'low',
    auth: 'high',
    tools: 0,
    degraded: 'none',
    layer: 'user',
    model: 'deepseek-official/deepseek-v4-flash',
    effort: 'low',
    finish: 'stop',
    reasoningTokens: 34,
    fieldsDefaulted: false,
    reason: 'fine',
  });
  const reviewLine = h.audits.find((entry) => entry.phase === 'review');
  assert.equal(reviewLine.risk, 'low');
  assert.equal(reviewLine.degraded, 'none');
  assert.equal(reviewLine.finish, 'stop');
  assert.equal(reviewLine.reasoningTokens, 34);
});

test('review：截断的 JSON 仍判 error（既有行为保留）', async () => {
  const h = harness([
    { blocks: [text('{"outcome":"allow","rationale":"trunca')], finish: { kind: 'max-tokens' } },
  ]);
  const verdict = await h.review();
  assert.equal(verdict.decision, 'error');
  assert.equal(verdict.reason, 'output truncated');
  assert.equal(verdict.fields.degraded, 'output-truncated');
});

test('review：max-tokens 截断时即使正文是合法 JSON 也不采信（设计「截断与空输出的判定（宿主 FinishReason 是唯一判据）」）', async () => {
  const h = harness([
    {
      blocks: [text('{"outcome":"allow","risk_level":"low","user_authorization":"high","rationale":"truncated but parses"}')],
      finish: { kind: 'max-tokens' },
      usage: { reasoningTokens: 512 },
    },
  ]);
  const verdict = await h.review();
  assert.equal(verdict.decision, 'error');
  assert.equal(verdict.reason, 'output truncated');
  assert.equal(verdict.fields.degraded, 'output-truncated');
  assert.equal(verdict.fields.finish, 'max-tokens');
  assert.equal(verdict.fields.reasoningTokens, 512);
  const reviewLine = h.audits.find((entry) => entry.phase === 'review');
  assert.equal(reviewLine.decision, 'error');
});

test('review：空响应（EMPTY_RESPONSE）记 degraded=output-empty 并 fail-closed（设计「截断与空输出的判定（宿主 FinishReason 是唯一判据）」）', async () => {
  const h = harness([
    { blocks: [], finish: { kind: 'error', failure: { code: 'EMPTY_RESPONSE', message: 'no content' } } },
  ]);
  const verdict = await h.review();
  // R47：EMPTY_RESPONSE 属可重试类——同款失败重试一次后仍失败，reason 带尝试进度。
  assert.equal(h.requests.length, 2);
  assert.equal(verdict.decision, 'error');
  assert.equal(verdict.reason, 'attempt 2/2: empty payload');
  assert.equal(verdict.fields.degraded, 'output-empty');
  assert.equal(verdict.fields.finish, 'error:EMPTY_RESPONSE');
  // 流收尾路径的 raw 行每请求一次（重试不翻倍），finish 落最终尝试的观测。
  assert.equal(h.audits.filter((row) => row.phase === 'raw').length, 1);
});

test('review：普通 stop 但模型没给正文时记为空 payload（无 finish 降级标记）', async () => {
  const h = harness([{ blocks: [] }]);
  const verdict = await h.review();
  // R47：空输出（finish 正常收尾、无文本块）同样整建重试一次；替身重复同款轮次，仍空。
  assert.equal(h.requests.length, 2);
  assert.equal(verdict.decision, 'error');
  assert.equal(verdict.reason, 'attempt 2/2: empty payload');
  assert.equal(verdict.fields.degraded, 'none');
});

test('finishTag / finishDegraded：宿主 FinishReason 的收敛规则', () => {
  assert.equal(finishTag({ kind: 'max-tokens' }), 'max-tokens');
  assert.equal(finishTag({ kind: 'error', failure: { code: 'EMPTY_RESPONSE' } }), 'error:EMPTY_RESPONSE');
  assert.equal(finishTag('stop'), 'stop');
  assert.equal(finishTag(undefined), undefined);
  assert.equal(finishDegraded({ kind: 'max-tokens' }), 'output-truncated');
  assert.equal(finishDegraded({ kind: 'error', failure: { code: 'EMPTY_RESPONSE' } }), 'output-empty');
  assert.equal(finishDegraded({ kind: 'error', failure: { code: 'CONTENT_FILTER' } }), undefined);
  assert.equal(finishDegraded({ kind: 'stop' }), undefined);
  assert.equal(finishDegraded(undefined), undefined);
});

test('review：maxTokens=0 时不向宿主传该字段（设计「输出预算：默认不设上限（与 codex 同构）」）', async () => {
  const h = harness(
    [{ blocks: [text('{"outcome":"allow"}')] }],
    { cfg: { reviewer: { maxTokens: 0, temperature: 0, maxToolSteps: 4, timeoutMs: 1000 } } },
  );
  await h.review();
  assert.equal('maxTokens' in h.requests[0], false);
});

test('review：maxTokens>0 时原样传给宿主（显式覆盖仍可用）', async () => {
  const h = harness(
    [{ blocks: [text('{"outcome":"allow"}')] }],
    { cfg: { reviewer: { maxTokens: 4096, temperature: 0, maxToolSteps: 4, timeoutMs: 1000 } } },
  );
  await h.review();
  assert.equal(h.requests[0].maxTokens, 4096);
});

// ── R39/R44：迟到结论观测与流中途抛错 ────────────────────────────────────

test('R39 迟到结论观测：signal 已中止 → finish 行 late=yes；正常完成 → late=no', async () => {
  // gate 的抢先结算路径（人工先答/人工超时/取消）都先 abort 审查信号——signal 状态是「迟到」的权威标记。
  const aborted = new AbortController();
  aborted.abort();
  const lateHarness = harness([{ blocks: [text('{"outcome":"allow","risk_level":"low","user_authorization":"high","rationale":"too late"}')] }]);
  await lateHarness.review({ signal: aborted.signal });
  const lateLine = lateHarness.audits.find((row) => row.phase === 'review');
  assert.equal(lateLine.late, 'yes', '已中止信号下完成的结论标 late=yes');

  const onTime = harness([{ blocks: [text('{"outcome":"allow","risk_level":"low","user_authorization":"high","rationale":"on time"}')] }]);
  await onTime.review();
  const onTimeLine = onTime.audits.find((row) => row.phase === 'review');
  assert.equal(onTimeLine.late, 'no');
});

test('R44③ 审查流中途抛错：error 结算 + finish 审计照写，不外抛', async () => {
  const audits = [];
  const reviewer = createReviewer({
    llm: {
      stream() {
        // 真流：先出一块，迭代中途 throw（创建期同步抛错已有用例，本例补流迭代中途）。
        return (async function* generate() {
          yield { type: 'block', index: 0, block: text('partial') };
          await Promise.resolve();
          throw new Error('stream exploded mid-way');
        })();
      },
    },
    blocks: { BlockAssembler: FakeAssembler },
    messages,
    tools: { schemas: [], run: async () => ({ text: 'x', isError: false }) },
    prompt,
    audit: (fields) => audits.push(fields),
  });
  const verdict = await reviewer.review(
    { toolName: 'pwsh', reason: 'escalate sandbox to danger-full-access: x' },
    { command: 'npm i' },
    { fields: {}, evidence: 'E' },
    {
      reviewer: { maxTokens: 512, temperature: 0, maxToolSteps: 4, reasoningEffort: 'low', timeoutMs: 1000 },
      audit: { includePrompt: false, includeRaw: false },
      resolution: { provider: 'deepseek-official', model: 'deepseek-v4-flash', layer: 'user', effort: 'low' },
    },
    { id: 'r-mid', signal: new AbortController().signal },
  );
  assert.equal(verdict.decision, 'error');
  assert.match(verdict.reason, /stream exploded mid-way/);
  assert.ok(audits.some((row) => row.phase === 'review' && row.decision === 'error'), 'finish 审计行必须照写');
});

// ── R47：审查调用的有限重试 ────────────────────────────────────────────────

test('retryableOutcome：可重试类分类表（R47 单一谓词直测）', () => {
  // 流抛错（网络/供应商异常）→ 可重试。
  assert.equal(retryableOutcome(undefined, new Error('network reset')), true);
  // finish.kind='error'（宿主收敛的供应商侧失败码，含 INVALID_REQUEST、EMPTY_RESPONSE）→ 可重试。
  assert.equal(retryableOutcome({ kind: 'error', failure: { code: 'INVALID_REQUEST' } }), true);
  assert.equal(retryableOutcome({ kind: 'error', failure: { code: 'EMPTY_RESPONSE' } }), true);
  // 空输出（finish 正常收尾、无文本块且非截断）→ 可重试。
  assert.equal(retryableOutcome({ kind: 'stop' }, undefined, true), true);
  assert.equal(retryableOutcome(undefined, undefined, true), true);
  // max-tokens 截断（同参数必然复现）→ 不重试，即使同时报告空正文。
  assert.equal(retryableOutcome({ kind: 'max-tokens' }), false);
  assert.equal(retryableOutcome({ kind: 'max-tokens' }, undefined, true), false);
  // 有正文的正常收尾与其余结局 → 不重试。
  assert.equal(retryableOutcome({ kind: 'stop' }), false);
  assert.equal(retryableOutcome({ kind: 'tool-calls' }), false);
  assert.equal(retryableOutcome(undefined, undefined), false);
  assert.equal(REVIEW_MAX_ATTEMPTS, 2, '首次＋1 次重试（具名常量）');
});

test('R47① 首败次成：网络错后整建重试成功，判定取第二次，工具计数跨尝试累计', async () => {
  const h = harness([
    // 尝试 1：先回喂一轮工具，再在第二轮流上抛网络错——留下「残缺消息序列」的诱饵。
    { blocks: [call('c1', 'read_file', '{"path":"a"}')] },
    { throws: 'network reset' },
    // 尝试 2：干净通过。
    { blocks: [text('{"outcome":"allow","risk_level":"low","user_authorization":"medium","rationale":"second try"}')] },
  ]);
  const verdict = await h.review();
  assert.equal(verdict.decision, 'allow');
  assert.equal(verdict.reason, 'second try', '重试成功的判定不带尝试前缀');
  assert.equal(h.requests.length, 3);
  // 整建重试：第三次请求的消息序列从两条 user 重建（不带尝试 1 的 assistant/tool-result 残迹）。
  assert.equal(h.requests[2].messages.length, 2);
  assert.deepEqual(h.requests[2].messages.map((message) => message.role), ['user', 'user']);
  // 工具轮次计数跨尝试累计（tools 字段口径不变）。
  assert.equal(verdict.toolCalls, 1);
  assert.equal(verdict.fields.tools, 1);
});

test('R47② 连败至上限：两次尝试后 error，reason 与审计 review 行都带尝试进度', async () => {
  const h = harness([{ throws: 'provider 500' }]);
  const verdict = await h.review();
  assert.equal(verdict.decision, 'error');
  assert.equal(h.requests.length, 2, 'REVIEW_MAX_ATTEMPTS=2：首次＋一次重试，不得无限重试');
  assert.equal(verdict.reason, 'attempt 2/2: provider 500');
  const reviewLine = h.audits.find((row) => row.phase === 'review');
  assert.equal(reviewLine.reason, 'attempt 2/2: provider 500');
  // prompt 行每请求一次（整建重试送出的是同一 system/输入）；流迭代抛错的尝试不产 raw 行
  // （单尝试抛错的既有口径），重试不使审计行翻倍。
  assert.equal(h.audits.filter((row) => row.phase === 'prompt').length, 1);
  assert.equal(h.audits.filter((row) => row.phase === 'raw').length, 0);
  assert.equal(h.audits.filter((row) => row.phase === 'review').length, 1);
});

test('R47③ 预算权威：signal 已中止（gate 计时器先到/请求取消）不再开始下一次尝试', async () => {
  const aborted = new AbortController();
  // 用 gate 计时器的真实 reason 形状（§23.3 决定 2 的超时标记）。
  aborted.abort(new Error(REVIEW_TIMEOUT_ABORT_MESSAGE));
  // 第二轮次本可成功：预算已耗尽时不许再烧——超时结算由 gate 计时器裁决（R10 优先于重试）。
  const h = harness([
    { throws: 'first failure' },
    { blocks: [text('{"outcome":"allow","risk_level":"low","user_authorization":"high","rationale":"too late"}')] },
  ]);
  const verdict = await h.review({ signal: aborted.signal });
  assert.equal(h.requests.length, 1, '中止信号下不得开始第二次尝试');
  assert.equal(verdict.decision, 'error');
  assert.equal(verdict.reason, 'first failure', '未发生重试，不带尝试前缀');
  assert.equal(verdict.superseded, undefined, '审查计时器的中止计入熔断（§23.3 决定 2）');
  const reviewLine = h.audits.find((row) => row.phase === 'review');
  assert.equal(reviewLine.late, 'yes');
  assert.equal(reviewLine.degraded, 'none');
});

test('R47④ 不可重试类零重试：max-tokens 截断与 layer=unavailable', async () => {
  const truncated = harness([
    { blocks: [text('{"outcome":"allow"')], finish: { kind: 'max-tokens' } },
  ]);
  const truncatedVerdict = await truncated.review();
  assert.equal(truncated.requests.length, 1, '截断同参数必然复现，零重试');
  assert.equal(truncatedVerdict.reason, 'output truncated');

  const unavailable = harness([{ blocks: [text('{}')] }], {
    cfg: { resolution: { layer: 'unavailable', effort: 'none', degraded: 'all' } },
  });
  await unavailable.review();
  assert.equal(unavailable.requests.length, 0, '模型解析失败零重试（既有用例的 R47 视角复读）');
});

test('R47 留痕：失败尝试的 finish 摘要只在 capture=full 档进 trace details，记录按请求一份', async () => {
  const full = [];
  // full 档：先 EMPTY_RESPONSE（finish 摘要），再网络错（error 摘要），最终仍网络错。
  const fullHarness = harness(
    [
      { blocks: [], finish: { kind: 'error', failure: { code: 'EMPTY_RESPONSE', message: 'no content' } } },
      { throws: 'gateway unreachable' },
    ],
    {
      onReview: (entry) => full.push(entry),
      cfg: { ui: { trace: { capture: 'full' } } },
    },
  );
  const verdict = await fullHarness.review();
  assert.equal(verdict.decision, 'error');
  assert.equal(verdict.reason, 'attempt 2/2: gateway unreachable');
  assert.equal(full.length, 1, 'trace 记录按请求一份，不因重试翻倍');
  // attempts 只记中间失败尝试（最终尝试的结局由 review 行自述：reason 前缀＋finish）。
  assert.deepEqual(full[0].attempts, [
    { finish: 'error:EMPTY_RESPONSE' },
  ], '失败尝试的摘要按失败顺序落 details.attempts');

  // 非 full 档：不收集失败尝试摘要（off/summary 下这些字段不落盘，提前拼是白做功）。
  const summary = [];
  const summaryHarness = harness([{ throws: 'x' }], { onReview: (entry) => summary.push(entry) });
  await summaryHarness.review();
  assert.equal(summary.length, 1);
  assert.equal(summary[0].attempts, undefined);
});

// ── R48 计数口径：abort 型 error 的 superseded 分类（实现审查 r46 P2-1 修正） ──

test('R48 分类：gate 他路先结算的中止（REVIEW_SUPERSEDED 标记/宿主取消 reason）→ verdict 带 superseded', async () => {
  // 场景一：gate 的标记 reason（人工先答/卡片关闭/人工超时竞速获胜/回调抛错路径）。
  const marked = new AbortController();
  marked.abort(REVIEW_SUPERSEDED);
  const markedHarness = harness([
    { throws: 'AbortError: This operation was aborted' },
    { blocks: [text('{"outcome":"allow","risk_level":"low","user_authorization":"high","rationale":"bait"}')] },
  ]);
  const markedVerdict = await markedHarness.review({ signal: marked.signal });
  assert.equal(markedHarness.requests.length, 1, '中止不重试');
  assert.equal(markedVerdict.decision, 'error');
  assert.equal(markedVerdict.superseded, true, '他路先结算的中止不是通道故障，index 层据此跳过熔断计数');
  assert.match(markedVerdict.reason, /aborted（gate 他路先结算，非通道故障）/u);
  const markedLine = markedHarness.audits.find((row) => row.phase === 'review');
  assert.equal(markedLine.degraded, 'superseded', '跳过原因必须落审计（review 行 degraded）');
  assert.equal(markedLine.late, 'yes');

  // 场景二：宿主取消——request.signal 先中止（merged signal 带宿主自己的取消 reason，不是超时标记）。
  const cancelled = new AbortController();
  cancelled.abort(new Error('tool cancelled by user'));
  const cancelledHarness = harness([{ throws: 'stream torn down' }]);
  const cancelledVerdict = await cancelledHarness.review({ signal: cancelled.signal });
  assert.equal(cancelledVerdict.superseded, true, '宿主取消引发的 abort 型 error 同样不计熔断');
  assert.match(cancelledVerdict.reason, /aborted（gate 他路先结算，非通道故障）：stream torn down/u);
});

test('R48 分类：审查计时器的中止（reason＝REVIEW_TIMEOUT_ABORT_MESSAGE）→ 无 superseded，照旧计数', async () => {
  const timer = new AbortController();
  timer.abort(new Error(REVIEW_TIMEOUT_ABORT_MESSAGE));
  const h = harness([
    { throws: 'stream torn down' },
    { blocks: [text('{"outcome":"allow","risk_level":"low","user_authorization":"high","rationale":"bait"}')] },
  ]);
  const verdict = await h.review({ signal: timer.signal });
  assert.equal(h.requests.length, 1);
  assert.equal(verdict.decision, 'error');
  assert.equal(verdict.superseded, undefined, '慢通道也是不可信通道：超时中止计入熔断（§23.3 决定 2）');
  assert.equal(verdict.reason, 'stream torn down');
  const reviewLine = h.audits.find((row) => row.phase === 'review');
  assert.equal(reviewLine.degraded, 'none');
});

// ── r46 P3-2/P3-3：full 档留痕的归属与条目内容 ──

test('R47 full 档：跨尝试的思维链拼界带 attempt 分隔行（r46 P3-2）', async () => {
  const entries = [];
  const h = harness(
    [
      {
        blocks: [{ type: 'reasoning', text: 'R1' }],
        finish: { kind: 'error', failure: { code: 'PROVIDER_500', message: 'x' } },
      },
      {
        blocks: [{ type: 'reasoning', text: 'R2' }, text('{"outcome":"deny","risk_level":"high","rationale":"second"}')],
      },
    ],
    { onReview: (entry) => entries.push(entry), cfg: { ui: { trace: { capture: 'full' } } } },
  );
  const verdict = await h.review();
  assert.equal(verdict.decision, 'deny', '重试成功的判定照常取第二次');
  assert.equal(entries[0].reasoning, 'R1\n[attempt 2]\nR2', '两段思维链必须可按行归属到具体尝试');
});

test('R47 full 档：空输出可重试的失败尝试条目自带 error 字段，不落缺信息条目（r46 P3-3）', async () => {
  const entries = [];
  const h = harness(
    [
      { blocks: [], finish: { kind: 'stop' } },
      { blocks: [text('{"outcome":"deny","risk_level":"high","rationale":"done"}')] },
    ],
    { onReview: (entry) => entries.push(entry), cfg: { ui: { trace: { capture: 'full' } } } },
  );
  const verdict = await h.review();
  assert.equal(verdict.decision, 'deny');
  assert.deepEqual(entries[0].attempts, [{ finish: 'stop', error: 'empty payload' }], '条目必须自带可观测内容');
});
