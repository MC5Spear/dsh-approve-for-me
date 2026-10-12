/**
 * R58 并发审查的取证上下文隔离（判据①–④；判据⑤＝既有并发/取消/冷却回归全绿）。
 *
 * 路线一：真实 `apply` 接线（官方消息构造器＋替身流＋真实文件系统）复现交错——
 * A 暂停、B 进入完成、A 恢复；断言以实际送审消息（含回喂的工具结果文本）判定，不以调用计数判定。
 * 路线二：`tools.run` 上下文参数直测（R43 的 invoke 注入点驱动真实超时）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 审查记录目录钉到临时目录：不落真 home，也不触发沙箱对工作区外路径的拒写。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'afm-iso-home-'));
import { apply } from '../lib/index.js';
import { createReadonlyTools } from '../lib/readonly-tools.js';
import { redact } from '../lib/transcript.js';

/** 造一对各有 target.txt 的目录（内容可区分；路径归一为正斜杠，便于在消息 JSON 里字面匹配）。 */
function makePair() {
  const base = mkdtempSync(join(tmpdir(), 'afm-iso-')).replace(/\\/g, '/');
  const a = `${base}/a`;
  const b = `${base}/b`;
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  writeFileSync(`${a}/target.txt`, 'A_TARGET_ACTUAL');
  writeFileSync(`${b}/target.txt`, 'B_OTHER_TARGET');
  return { a, b };
}

/** 真实 apply 接线（同生产装配：BlockAssembler 与消息构造器都来自宿主包）。 */
function wired({ stream, config = {} }) {
  const handlers = new Map();
  const injections = [];
  const options = [];
  const services = { permissionPresets: { current: () => 'auto-approve' }, sessions: { list: () => [] } };
  const ctx = {
    effect: (f) => { f(); return () => {}; },
    on: (e, f) => { handlers.set(e, f); return () => {}; },
    get: (n) => services[n],
    llm: {
      listProviders: () => [{ id: 'syn' }],
      resolveModelInfo: async () => ({}),
      stream: (o) => { options.push(o); return stream(o); },
    },
  };
  const cfg = {
    reviewer: { model: 'syn/model', timeoutMs: 10000, toolTimeoutMs: 5000, maxToolSteps: 2 },
    ui: { humanCardDuringReview: false, trace: { capture: 'off' } },
    audit: { enabled: false },
    ...config,
  };
  apply(ctx, cfg);
  return { request: handlers.get('approval/request'), injections, cfg, handlers, options };
}

/** 一次 write 升权审批请求（事件里带本次参数对象）。 */
function req(sessionId, cwd, callId, args, inject) {
  return {
    agent: {
      session: {
        id: sessionId,
        header: { cwd },
        snapshotEvents: () => [
          { type: 'user/message', data: { content: [{ type: 'text', text: 'Please perform only the specific safe task in my current workspace.' }] } },
          { type: 'tool/ptc-dispatch-start', data: { subCallId: callId, name: 'write', arguments: args } },
        ],
      },
      inject: (m) => inject.push(m),
    },
    toolName: 'write',
    callId,
    reason: 'escalate sandbox to danger-full-access: explicit sandbox retry',
  };
}

/** 两轮替身流：第一轮（无工具结果）吐 read_file 调用，第二轮记录完整消息并吐 allow 结论文本。 */
function twoRoundStream({ beforeYield, observations, label }) {
  return (options) => (async function* () {
    const payload = JSON.stringify(options.messages);
    if (!payload.includes('ToolResultMessage') && !options.messages.some((m) => m?.role === 'tool')) {
      await beforeYield?.(payload, options);
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'read', name: 'read_file', arguments: JSON.stringify({ path: 'target.txt' }) } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    } else {
      observations[label(payload, options)] = payload;
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ outcome: 'allow', risk_level: 'low', user_authorization: 'medium', rationale: 'checked target' }) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  })();
}

const ARGS = { command: 'Set-Content target.txt', sandbox_permissions: 'danger-full-access' };

test('R58① A 暂停、B 完成、A 恢复：A 只读 A 目录、B 只读 B 目录', async () => {
  const { a, b } = makePair();
  const observations = {};
  let releaseA;
  const release = new Promise((r) => { releaseA = r; });
  let aStarted;
  const started = new Promise((r) => { aStarted = r; });
  const w = wired({
    stream: twoRoundStream({
      beforeYield: async (payload) => {
        if (payload.includes(`"cwd":"${a}"`) || payload.includes(a)) {
          aStarted();
          await release;
        }
      },
      observations,
      label: (payload) => (payload.includes(a) ? 'A' : 'B'),
    }),
  });
  const pA = w.request(req('iso-A', a, 'call-A', ARGS, w.injections), () => new Promise(() => {}));
  await started;
  const pB = w.request(req('iso-B', b, 'call-B', ARGS, w.injections), () => new Promise(() => {}));
  await pB;
  releaseA();
  await pA;
  assert.ok(observations.A?.includes('A_TARGET_ACTUAL'), 'A 的取证应读到 A 目录内容');
  assert.ok(!observations.A?.includes('B_OTHER_TARGET'), 'A 的取证不得读到 B 目录内容');
  assert.ok(observations.B?.includes('B_OTHER_TARGET'), 'B 的取证应读到 B 目录内容');
  assert.ok(!observations.B?.includes('A_TARGET_ACTUAL'), 'B 的取证不得读到 A 目录内容');
});

test('R58② 反向交错：B 暂停、A 完成、B 恢复同样各读各目录', async () => {
  const { a, b } = makePair();
  const observations = {};
  let releaseB;
  const release = new Promise((r) => { releaseB = r; });
  let bStarted;
  const started = new Promise((r) => { bStarted = r; });
  const w = wired({
    stream: twoRoundStream({
      beforeYield: async (payload) => {
        if (payload.includes(`"cwd":"${b}"`) || payload.includes(b)) {
          bStarted();
          await release;
        }
      },
      observations,
      label: (payload) => (payload.includes(b) ? 'B' : 'A'),
    }),
  });
  const pA = w.request(req('iso-A2', a, 'call-A2', ARGS, w.injections), () => new Promise(() => {}));
  const pB = w.request(req('iso-B2', b, 'call-B2', ARGS, w.injections), () => new Promise(() => {}));
  await bStarted;
  await pA;
  releaseB();
  await pB;
  assert.ok(observations.B?.includes('B_OTHER_TARGET') && !observations.B?.includes('A_TARGET_ACTUAL'));
  assert.ok(observations.A?.includes('A_TARGET_ACTUAL') && !observations.A?.includes('B_OTHER_TARGET'));
});

test('R58② 同会话后到请求排队：跨会话插队不改在飞与排队任务的取证目录', async () => {
  const { a, b } = makePair();
  const observations = {};
  const order = [];
  let releaseS;
  const release = new Promise((r) => { releaseS = r; });
  let sStarted;
  const started = new Promise((r) => { sStarted = r; });
  const w = wired({
    stream: (options) => (async function* () {
      const payload = JSON.stringify(options.messages);
      const hasToolResult = payload.includes('ToolResultMessage') || options.messages.some((m) => m?.role === 'tool');
      if (payload.includes(a)) {
        const round = order.filter((x) => x.startsWith('s-obs')).length;
        if (!hasToolResult) {
          if (round === 0) { order.push('s-start'); sStarted(); await release; }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'read', name: 'read_file', arguments: JSON.stringify({ path: 'target.txt' }) } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
        } else {
          observations[`s-${round}`] = payload;
          order.push(`s-obs-${round}`);
          yield { type: 'text-delta', index: 0, text: JSON.stringify({ outcome: 'allow', risk_level: 'low', user_authorization: 'medium', rationale: 'checked' }) };
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      } else if (payload.includes(b)) {
        order.push('c-run');
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ outcome: 'allow', risk_level: 'low', user_authorization: 'medium', rationale: 'checked' }) };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    })(),
  });
  const p1 = w.request(req('iso-S', a, 'call-S1', ARGS, w.injections), () => new Promise(() => {}));
  await started;
  const p2 = w.request(req('iso-S', a, 'call-S2', ARGS, w.injections), () => new Promise(() => {}));
  const pC = w.request(req('iso-C', b, 'call-C', ARGS, w.injections), () => new Promise(() => {}));
  await pC;
  releaseS();
  await p1;
  await p2;
  assert.equal(order.indexOf('c-run') > order.indexOf('s-start'), true, '跨会话插队请求在在飞任务暂停期间完成');
  assert.ok(order.indexOf('s-obs-0') < order.indexOf('s-obs-1'), '同会话串行：第二个请求在第一个结算后才进入审查');
  for (const obs of Object.values(observations)) {
    assert.ok(obs.includes('A_TARGET_ACTUAL') && !obs.includes('B_OTHER_TARGET'), '同会话两个请求的取证都只读本会话目录');
  }
});

test('R58③④ 热改不串扰：在飞任务按进入时快照，下一请求按新值', async () => {
  const { a, b } = makePair();
  writeFileSync(`${a}/both.txt`, 'AAA=LEAK_AAA BBB=LEAK_BBB');
  writeFileSync(`${b}/both.txt`, 'AAA=LEAK_AAA BBB=LEAK_BBB');
  const observations = {};
  let releaseA;
  const release = new Promise((r) => { releaseA = r; });
  let aStarted;
  const started = new Promise((r) => { aStarted = r; });
  // A 快照：en 文案＋遮 AAA；热改后（B 起）：zh 文案＋遮 BBB。
  // 双方首轮都同时发起读文件与未知工具调用：一次观察同时覆盖脱敏与语言两断言（A、B 各自可失败）。
  const w = wired({
    config: { language: { agent: 'en' }, context: { redactPatterns: ['AAA=[^ ]+'] } },
    stream: (options) => (async function* () {
      const payload = JSON.stringify(options.messages);
      const hasToolResult = payload.includes('ToolResultMessage') || options.messages.some((m) => m?.role === 'tool');
      if (!hasToolResult) {
        if (payload.includes(a)) {
          aStarted();
          await release;
        }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'read', name: 'read_file', arguments: JSON.stringify({ path: 'both.txt' }) } };
        yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'read2', name: 'no_such_tool', arguments: '{}' } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        observations[payload.includes(a) ? 'A' : 'B'] = payload;
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ outcome: 'allow', risk_level: 'low', user_authorization: 'medium', rationale: 'checked' }) };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    })(),
  });
  const pA = w.request(req('iso-L', a, 'call-L', ARGS, w.injections), () => new Promise(() => {}));
  await started;
  // 热改：语言 en→zh、脱敏清单换成 BBB（原地改＋发 volatile 事件——生产里宿主对 volatile 字段
  // 原地更新后即发此事件，settingsRevision 递增使模型解析缓存失效；不发事件时 resolver 按旧 revision 命中缓存）。
  w.cfg.language.agent = 'zh';
  w.cfg.context.redactPatterns = ['BBB=[^ ]+'];
  w.handlers.get('loader/volatile-update')?.();
  const pB = w.request(req('iso-M', b, 'call-M', ARGS, w.injections), () => new Promise(() => {}));
  await pB;
  releaseA();
  await pA;
  // A 按旧快照：AAA 被遮、BBB 可见；结果文案按 en（A 侧语言断言可失败：A 也发起了未知工具调用）。
  assert.ok(observations.A.includes('[redacted]') && !observations.A.includes('LEAK_AAA'), 'A 快照按旧清单遮蔽 AAA');
  assert.ok(observations.A.includes('LEAK_BBB'), 'A 快照不受热改后的清单影响（BBB 仍可见）');
  assert.ok(observations.A.includes('Unknown tool') && !observations.A.includes('未知工具'), 'A 快照的模型侧文案不受热改后的语言影响');
  // B 按新快照：BBB 被遮、AAA 可见；未知工具文案为中文（zh 档）。
  assert.ok(observations.B.includes('[redacted]') && !observations.B.includes('LEAK_BBB'), 'B 按热改后的新清单遮蔽 BBB');
  assert.ok(observations.B.includes('LEAK_AAA'), 'B 不受旧清单影响（AAA 仍可见）');
  assert.ok(observations.B.includes('未知工具') && !observations.B.includes('Unknown tool'), 'B 的模型侧文案按热改后的新语言');
});

test('R58③ 超时隔离（直测，双向）：上下文超时压过实例值（小压大不拖住、大压小不误杀）', async () => {
  // 方向一：实例大超时 60000，上下文小超时 30 → 必须按上下文掐断。
  const small = createReadonlyTools({
    rootDir: process.cwd(),
    timeoutMs: 60000,
    invoke: () => new Promise((resolvePromise) => setTimeout(() => resolvePromise({ text: 'late', isError: false, denied: false }), 400)),
  });
  const t0 = Date.now();
  const fast = await small.run('read_file', {}, undefined, { rootDir: process.cwd(), lang: 'en', toolTimeoutMs: 30, redactPatterns: [] });
  assert.equal(fast.isError, true, '上下文小超时生效（不被实例大超时拖住）');
  assert.ok(Date.now() - t0 < 350, `按上下文超时结算（实测 ${Date.now() - t0}ms）`);
  // 方向二：实例小超时 30（会掐死 200ms 任务），上下文大超时 5000 → 必须按上下文放行到底。
  const big = createReadonlyTools({
    rootDir: process.cwd(),
    timeoutMs: 30,
    invoke: () => new Promise((resolvePromise) => setTimeout(() => resolvePromise({ text: 'slow-ok', isError: false, denied: false }), 200)),
  });
  const slow = await big.run('read_file', {}, undefined, { rootDir: process.cwd(), lang: 'en', toolTimeoutMs: 5000, redactPatterns: [] });
  assert.equal(slow.isError, false, '上下文大超时压过实例小超时（在飞任务不被误杀）');
  assert.equal(slow.text, 'slow-ok');
});

test('R58⑤ 回查目录缺失：动作证据标注 degraded=cwd，工具按本次 process.cwd() 快照解析', async () => {
  const observations = {};
  const w = wired({
    config: { language: { agent: 'zh' } },
    stream: (options) => (async function* () {
      const payload = JSON.stringify(options.messages);
      const hasToolResult = payload.includes('ToolResultMessage') || options.messages.some((m) => m?.role === 'tool');
      if (!hasToolResult) {
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'read', name: 'read_file', arguments: JSON.stringify({ path: 'package.json' }) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        observations.round2 = payload;
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ outcome: 'allow', risk_level: 'low', user_authorization: 'medium', rationale: 'checked' }) };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    })(),
  });
  // 会话头不带 cwd：locate 记 degraded=cwd；工具基准目录按本次快照回退 process.cwd()。
  // 用独立临时目录＋自有 package.json 把「请求期进程目录」与「装载期实例基线（仓库根）」区分开：
  // 去掉 `?? process.cwd()` 回退时，contextOf 对 undefined 回落实例基线＝仓库根 → 读到仓库 package.json → 断言红。
  const cw = mkdtempSync(join(tmpdir(), 'afm-iso-cwd-'));
  writeFileSync(join(cw, 'package.json'), '{"marker":"CWD_SNAPSHOT_PROOF"}');
  const prev = process.cwd();
  process.chdir(cw);
  try {
    const request = {
      agent: {
        session: {
          id: 'iso-cwd',
          header: {},
          snapshotEvents: () => [
            { type: 'user/message', data: { content: [{ type: 'text', text: 'Please perform only the specific safe task in my current workspace.' }] } },
            { type: 'tool/ptc-dispatch-start', data: { subCallId: 'call-C', name: 'write', arguments: ARGS } },
          ],
        },
        inject: (m) => w.injections.push(m),
      },
      toolName: 'write',
      callId: 'call-C',
      reason: 'escalate sandbox to danger-full-access: explicit sandbox retry',
    };
    await w.request(request, () => new Promise(() => {}));
  } finally {
    process.chdir(prev);
  }
  const actionText = w.options[0].messages[1].content[0].text;
  assert.ok(actionText.includes('degraded=cwd') && actionText.includes('工作目录未知'), '动作证据标注目录缺失');
  assert.ok(observations.round2.includes('CWD_SNAPSHOT_PROOF'), '相对路径按本次 process.cwd() 快照解析（读到请求期临时目录的 package.json）');
  assert.ok(!observations.round2.includes('dsh-approve-for-me'), '不落装载期实例基线（仓库根），也不冒充会话目录');
  assert.ok(!observations.round2.includes('D:/synthetic'), '不得把进程目录冒充为会话目录');
});

test('R58③ 脱敏快照持值拷贝：宿主原地改数组不穿透在飞任务', async () => {
  const { a } = makePair();
  writeFileSync(`${a}/both.txt`, 'AAA=LEAK_AAA BBB=LEAK_BBB');
  const observations = {};
  let releaseA;
  const release = new Promise((r) => { releaseA = r; });
  let aStarted;
  const started = new Promise((r) => { aStarted = r; });
  const w = wired({
    config: { language: { agent: 'en' }, context: { redactPatterns: ['AAA=[^ ]+'] } },
    stream: (options) => (async function* () {
      const payload = JSON.stringify(options.messages);
      const hasToolResult = payload.includes('ToolResultMessage') || options.messages.some((m) => m?.role === 'tool');
      if (!hasToolResult) {
        if (payload.includes(a)) {
          aStarted();
          await release;
        }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'read', name: 'read_file', arguments: JSON.stringify({ path: 'both.txt' }) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        observations.A = payload;
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ outcome: 'allow', risk_level: 'low', user_authorization: 'medium', rationale: 'checked' }) };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    })(),
  });
  const pA = w.request(req('iso-N', a, 'call-N', ARGS, w.injections), () => new Promise(() => {}));
  await started;
  // 宿主不走字段替换，直接对清单数组原地 push 新模式（不发 volatile 事件）：
  // 快照若持引用（而非值拷贝），在飞 A 的后续工具结果会按追加后的清单遮蔽 BBB → 断言红。
  w.cfg.context.redactPatterns.push('BBB=[^ ]+');
  releaseA();
  await pA;
  assert.ok(observations.A.includes('[redacted]') && !observations.A.includes('LEAK_AAA'), 'A 快照按进入时清单遮蔽 AAA');
  assert.ok(observations.A.includes('LEAK_BBB'), '原地追加的脱敏模式不穿透在飞任务（BBB 仍可见）');
});

test('R58③ 语言隔离（直测）：run 的上下文语言优先于实例状态', async () => {
  const tools = createReadonlyTools({ rootDir: process.cwd() });
  tools.setLang('zh');
  const en = await tools.run('no_such_tool', {}, undefined, { rootDir: process.cwd(), lang: 'en', toolTimeoutMs: 0, redactPatterns: [] });
  assert.match(en.text, /Unknown tool/u);
  const zh = await tools.run('no_such_tool', {}, undefined, { rootDir: process.cwd(), lang: 'zh', toolTimeoutMs: 0, redactPatterns: [] });
  assert.match(zh.text, /未知工具/u);
});

test('R58③ 超时隔离（直测，真实超时）：上下文小超时生效，实例大超时不拖住', async () => {
  const tools = createReadonlyTools({
    rootDir: process.cwd(),
    timeoutMs: 60000,
    invoke: () => new Promise((resolvePromise) => setTimeout(() => resolvePromise({ text: 'late', isError: false, denied: false }), 400)),
  });
  const t0 = Date.now();
  const out = await tools.run('read_file', {}, undefined, { rootDir: process.cwd(), lang: 'en', toolTimeoutMs: 30, redactPatterns: [] });
  const ms = Date.now() - t0;
  assert.equal(out.isError, true, '按上下文超时回喂错误结果');
  assert.ok(ms < 350, `超时应按上下文 30ms 结束（实测 ${ms}ms）`);
});

test('R58③ 超时隔离（直测）：未传上下文时回落实例状态（既有直测路径不变）', async () => {
  const tools = createReadonlyTools({
    rootDir: process.cwd(),
    timeoutMs: 30,
    invoke: () => new Promise((resolvePromise) => setTimeout(() => resolvePromise({ text: 'late', isError: false, denied: false }), 400)),
  });
  const t0 = Date.now();
  const out = await tools.run('read_file', {});
  const ms = Date.now() - t0;
  assert.equal(out.isError, true);
  assert.ok(ms < 350, `实例超时仍生效（实测 ${ms}ms）`);
});

test('R58③ 脱敏隔离（直测）：上下文清单优先于实例清单', async () => {
  // 生产装配给 readonly-tools 注入的就是 transcript 的 redact；直测同款（缺省注入是恒等函数）。
  const tools = createReadonlyTools({
    rootDir: process.cwd(),
    redactPatterns: ['AAA=[^ ]+'],
    redact: (text, patterns) => redact(text, patterns),
    invoke: async () => ({ text: 'AAA=1 BBB=2', isError: false, denied: false }),
  });
  const out = await tools.run('read_file', {}, undefined, { rootDir: process.cwd(), lang: 'en', toolTimeoutMs: 0, redactPatterns: ['BBB=[^ ]+'] });
  assert.ok(out.text.includes('AAA=1') && !out.text.includes('BBB=2'), '按上下文清单遮 BBB、放 AAA');
});

test('R58③ 基准目录隔离（直测）：相对路径按上下文基准解析', async () => {
  const { a, b } = makePair();
  const tools = createReadonlyTools({ rootDir: a });
  tools.setRoot(b);
  const out = await tools.run('read_file', { path: 'target.txt' }, undefined, { rootDir: a, lang: 'en', toolTimeoutMs: 0, redactPatterns: [] });
  assert.equal(out.isError, false);
  assert.ok(out.text.includes('A_TARGET_ACTUAL'), '按上下文基准目录读到 A 内容');
});
