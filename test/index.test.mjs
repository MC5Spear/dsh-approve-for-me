import assert from 'node:assert/strict';
import test from 'node:test';
import { AUDIT_VERSION } from '../lib/audit.js';

/**
 * 宿主接线冒烟测试。
 *
 * `lib/index.js` 导入 `@deepseek-ai/*`，只有宿主解析环境能加载它；离线跑 `node --test test/`
 * 时导入失败，本文件整体跳过。需要实跑时：
 *   node --import ./tools/_host-hooks.mjs --test test/index.test.mjs
 *
 * **只吞「宿主包解析不到」这一种失败**：语法错误、模块内部抛错、被依赖的相对文件缺失都必须让本文件红着，
 * 否则会变成「跳过＝通过」的假绿（`npm run check` 另行兜住 `lib/**` 的语法）。
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
 * 构造 cordis 上下文替身。
 * @param {object} [entry] - 组合配置入口值。
 * @param {object} [services] - `ctx.get` 返回的可选服务表（如 sessions / permissionPresets）。
 * @returns {object} 上下文与记录。
 */
function makeCtx(entry = {}, services = {}) {
  const listeners = [];
  const audits = [];
  const ctx = {
    effect: (fn) => {
      fn();
      return () => {};
    },
    on: (event, handler, prepend) => {
      listeners.push({ event, handler, prepend });
      return () => {};
    },
    get: (name) => services[name],
    // 0.1.7：实现不再触碰设置服务（行 id 即命名空间，读写全在 profile patch 通道）。
    // 陷阱 Proxy：任何属性访问即失败——「实现还在调用 ctx.settings」会让测试变红而不是静默通过。
    settings: new Proxy({}, {
      get() {
        throw new Error('0.1.7 起实现不得访问 ctx.settings（设置读写走宿主行 Config + volatile 引用）');
      },
    }),
    llm: {
      listProviders: () => [{ id: 'deepseek-official' }],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }] } }),
      stream: () => {
        throw new Error('本测试不应发起模型调用');
      },
    },
    logger: { warn: (value) => audits.push(value) },
  };
  return { ctx, listeners, audits, entry };
}

/**
 * 构造子代理覆盖用的假会话服务：根（auto-approve）+ 委派子（never）。
 * @param {object} [options] - appendThrows 时子的 append 抛错。
 * @returns {object} services 表与假会话。
 */
function subagentServices(options = {}) {
  const appendCalls = [];
  const child = {
    id: 'child-1',
    header: { parentSession: 'root-1' },
    snapshotEvents: () => [{ type: 'approval/policy', data: { policy: 'never', source: 'delegation' } }],
    append: options.appendThrows === true
      ? () => { throw new Error('append denied'); }
      : (type, data) => { appendCalls.push({ type, data }); },
  };
  const services = {
    sessions: { list: () => [{ id: 'root-1', header: {}, snapshotEvents: () => [{ type: 'permission/preset', data: { preset: 'auto-approve' } }] }, child] },
    permissionPresets: { current: (session) => (session.id === 'root-1' ? 'auto-approve' : undefined) },
  };
  return { services, child, appendCalls };
}

test('apply 注册 prepend 应答者并写一行启动审计', async (t) => {
  const host = await loadHost();
  if (host === undefined) {
    t.skip('宿主包不可解析（离线环境）');
    return;
  }
  // inject 声明（0.1.7）：不再依赖设置服务；漏一个都是加载期直接失败（纪律 3）。
  assert.deepEqual(host.inject, ['approval', 'llm', 'sessions']);
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    const env = makeCtx({ mode: 'rules' });
    assert.doesNotThrow(() => host.apply(env.ctx, { mode: 'rules' }));
    const listener = env.listeners.find((entry) => entry.event === 'approval/request');
    assert.ok(listener, '未注册 approval/request 应答者');
    assert.equal(listener.prepend, true);
    const startup = written.join('');
    assert.match(startup, /answerer registered/);
    // R52：启动行版本号与审计版本常量同源（期望值从 lib/audit.js 导入，不盯字面量——
    // 实现若回退为硬编码，改常量即红）。
    assert.match(startup, new RegExp(`v=${AUDIT_VERSION} phase=screen`));
  } finally {
    process.stderr.write = original;
  }
});

test('volatile 热改：apply 挂 loader/volatile-update 监听，mode 热改为 off 后请求期直接放行', async (t) => {
  const host = await loadHost();
  if (host === undefined) {
    t.skip('宿主包不可解析（离线环境）');
    return;
  }
  const services = {
    permissionPresets: { current: () => 'auto-approve' },
    sessions: { list: () => [] },
  };
  const config = { mode: 'rules' };
  const env = makeCtx(config, services);
  let streamed = 0;
  env.ctx.llm.stream = () => {
    streamed += 1;
    throw new Error('mode=off 请求期必须先于一切模型调用返回');
  };
  host.apply(env.ctx, config);
  const volatileListener = env.listeners.find((entry) => entry.event === 'loader/volatile-update');
  assert.ok(volatileListener, '未挂 loader/volatile-update 监听（volatile 热改的缓存失效通道）');
  assert.equal(typeof volatileListener.handler, 'function');

  // 热改：原地改配置对象（current() 每次现算，普通值即可模拟引用更新后的取值）。
  config.mode = 'off';
  const answerer = env.listeners.find((entry) => entry.event === 'approval/request').handler;
  let nextCalls = 0;
  const request = {
    agent: { session: { id: 's-hot-off', snapshotEvents: () => [] } },
    toolName: 'pwsh',
    callId: 'c1',
    reason: 'test',
  };
  const outcome = await answerer(request, async () => {
    nextCalls += 1;
    return 'ask';
  });
  assert.equal(outcome, 'ask', 'mode=off 时应原样交给下一个应答者');
  assert.equal(nextCalls, 1);
  assert.equal(streamed, 0, 'off 请求期不得触发模型调用');
});

test('mode=off 时不注册应答者', async (t) => {
  const host = await loadHost();
  if (host === undefined) {
    t.skip('宿主包不可解析（离线环境）');
    return;
  }
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    const env = makeCtx({ mode: 'off' });
    host.apply(env.ctx, { mode: 'off' });
    assert.equal(env.listeners.some((entry) => entry.event === 'approval/request'), false);
    assert.match(written.join(''), /disabled by configuration/);
  } finally {
    process.stderr.write = original;
  }
});

// ── R24 子代理覆盖的接线断言（实现审查 S2-1）────────────────────────────────

test('R24 接线：rules 模式挂 session/created 监听且装载补扫翻可覆盖子会话；off 模式都不挂', async (t) => {
  const host = await loadHost();
  if (host === undefined) {
    t.skip('宿主包不可解析（离线环境）');
    return;
  }
  // rules：监听 + 补扫。补扫在 apply 内同步执行——活表里的 child-1 应被翻成 ask。
  const wiring = subagentServices();
  const envOn = makeCtx({ mode: 'rules' }, wiring.services);
  host.apply(envOn.ctx, { mode: 'rules' });
  const created = envOn.listeners.find((entry) => entry.event === 'session/created');
  assert.ok(created, 'rules 模式未注册 session/created 监听（R24）');
  assert.equal(wiring.appendCalls.length, 1, '装载补扫没有翻活表里的可覆盖委派子会话');
  assert.equal(wiring.appendCalls[0].type, 'approval/policy');
  assert.deepEqual(wiring.appendCalls[0].data, { policy: 'ask' });

  // 监听器对后续创建的委派子会话同样生效（通过监听入口直调）。
  const second = subagentServices();
  assert.doesNotThrow(() => created.handler(second.child));
  assert.equal(second.appendCalls.length, 1, 'session/created 监听没有翻新委派子会话');

  // off：既无应答者也无 session/created（禁用时翻策略只会留下无人应答的 ask）。
  const wiringOff = subagentServices();
  const envOff = makeCtx({ mode: 'off' }, wiringOff.services);
  host.apply(envOff.ctx, { mode: 'off' });
  assert.equal(envOff.listeners.some((entry) => entry.event === 'session/created'), false);
  assert.equal(wiringOff.appendCalls.length, 0, 'off 模式不该发生任何翻策略');
});

test('R24 接线：监听器回退吞掉 append 异常，不外抛（双保险的外层）', async (t) => {
  const host = await loadHost();
  if (host === undefined) {
    t.skip('宿主包不可解析（离线环境）');
    return;
  }
  const wiring = subagentServices({ appendThrows: true });
  const env = makeCtx({ mode: 'rules' }, wiring.services);
  assert.doesNotThrow(() => host.apply(env.ctx, { mode: 'rules' }));
  const created = env.listeners.find((entry) => entry.event === 'session/created');
  const throwing = subagentServices({ appendThrows: true });
  assert.doesNotThrow(() => created.handler(throwing.child), '监听器外抛会回滚宿主的会话挂载');
});

test('R24 静态扫描：lib/subagents.js 不触碰 ctx（依赖全部注入，实现审查 S2-2）', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../lib/subagents.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bctx\./, 'subagents.js 出现 ctx 直接访问：覆盖判定依赖必须经 deps 注入');
  assert.doesNotMatch(source, /\bpermissionPresets\.set\b/, '禁止整预设写入（R24：会改写委派沙箱）');
  assert.match(source, /append\('approval\/policy', \{ policy: 'ask' \}\)/, '唯一写路径必须是追加 ask 事件');
});

test('normalizeConfig 补齐缺省分节，设置服务缺失时下游仍能读到完整配置', async (t) => {
  let config;
  try {
    config = await import('../lib/config.js');
  } catch {
    t.skip('宿主包不可解析（离线环境）');
    return;
  }
  const merged = config.normalizeConfig({ fallback: 'ask' });
  assert.equal(merged.fallback, 'ask');
  assert.equal(merged.reviewer.timeoutMs, 90000);
  assert.equal(merged.reviewer.maxToolSteps, 4);
  assert.equal(merged.human.timeoutMs, 300000);
  assert.equal(merged.audit.maxLineBytes, 4096);
  assert.equal(merged.context.maxEntries, 40);

  const nested = config.normalizeConfig({ reviewer: { model: 'zai/glm-5.3' } });
  assert.equal(nested.reviewer.model, 'zai/glm-5.3');
  assert.equal(nested.reviewer.maxTokens, 0, '默认 0 = 不把 maxTokens 放进审查请求（设计「输出预算：默认不设上限（与 codex 同构）」）');
  assert.equal(config.normalizeConfig({ reviewer: { maxTokens: 0 } }).reviewer.maxTokens, 0, '显式 0 必须原样保留');
  assert.equal(config.normalizeConfig({ reviewer: { maxTokens: 4096 } }).reviewer.maxTokens, 4096, '显式值必须原样保留');
});

test('normalizeConfig 深度解包 volatile 引用（要求 schemastery ≥3.18.4）', async (t) => {
  let config;
  let cosmokit;
  try {
    config = await import('../lib/config.js');
    cosmokit = await import('@deepseek-ai/cosmokit');
  } catch {
    t.skip('宿主包不可解析（离线环境）');
    return;
  }
  // 真引用：schema 解析产物里 defaults 的 volatile 字段是 Volatile 引用（schemastery resolve 包 createVolatile）。
  const raw = config.Config({});
  const ref = raw.reviewer?.timeoutMs;
  assert.equal(cosmokit.isVolatile(ref), true, 'Config({}) 的 volatile 字段应是引用（若此处失败＝锚到的 schemastery <3.18.4，查 tools/_host-resolve.mjs）');
  const merged = config.normalizeConfig(raw);
  assert.equal(merged.reviewer.timeoutMs, 90000, '引用应被解包为当前值');
  assert.equal(cosmokit.isVolatile(merged.reviewer.timeoutMs), false, '解包结果不得再是引用');

  // 手造引用（跨层）：宿主原地更新语义＝引用对象不变、取值变化——normalizeConfig 每次现算即读到新值。
  // 引用必须经 cosmokit.createVolatile 造（isVolatile 按共享符号键判定，裸 get() 对象不算引用）。
  const fakeRef = cosmokit.createVolatile('off');
  const first = config.normalizeConfig({ mode: fakeRef });
  assert.equal(first.mode, 'off', '顶层 volatile 引用应解包');
  const nestedRef = cosmokit.createVolatile(120000);
  assert.equal(config.normalizeConfig({ reviewer: { timeoutMs: nestedRef } }).reviewer.timeoutMs, 120000, '嵌套分节内的引用应解包');
});

// ── G1（r31 ⑤缺口 / N1）：index 层逃逸注入文本的两语言行为断言 ────────────────

/**
 * 构造一次「应答者逃逸异常」请求：`request.agent.session.id` 的 getter 抛错。
 * gate.js 在 `try` 之外读取该字段（`const sessionId = request?.agent?.session?.id`），
 * 异常因此穿透 I2 承接层、直达 index.js 应答者最外层 catch——即逃逸通知路径
 * （通道故障模板＋`gate.escape.reason` 原因段，设计 §4.4）。
 * （不能改 `crypto.randomUUID` 造逃逸：注入消息工厂 `createUserMessage` 内部也用它。）
 * @param {object[]} injected - 收集注入消息的数组。
 * @returns {object} 审批请求。
 */
function escapeRequest(injected) {
  const session = {};
  Object.defineProperty(session, 'id', { get() { throw new Error('session id boom'); } });
  return {
    agent: { session, inject: (message) => injected.push(message) },
    toolName: 'pwsh',
    callId: 'call_escape',
    reason: 'escalate sandbox to danger-full-access: x',
  };
}

/**
 * 走真实 `apply` 注册应答者，再触发一次逃逸异常，返回注入文本。
 * @param {{agent: string}} language - `language` 配置节。
 * @returns {Promise<{outcome: string, texts: string[]}>} 结算值与注入文本。
 */
async function runEscape(language) {
  const host = await loadHost();
  const injected = [];
  const env = makeCtx({ mode: 'rules', language });
  host.apply(env.ctx, { mode: 'rules', language });
  const answerer = env.listeners.find((entry) => entry.event === 'approval/request').handler;
  let nextCalls = 0;
  const outcome = await answerer(escapeRequest(injected), async () => {
    nextCalls += 1;
    return 'ask';
  });
  return { outcome, texts: injected.map((message) => message.content[0].text), nextCalls };
}

test('逃逸通知走通道故障模板并按 language.agent 切换：zh 中文整句、en 英文整句（G1/N1 两语言行为差异；§4.4）', async (t) => {
  const host = await loadHost();
  if (host === undefined) {
    t.skip('宿主包不可解析（离线环境）');
    return;
  }
  // zh 档：首行与关键字按字节核对（口径同 requirements R28 判据②），fail-closed 为 rejected；
  // 首行是通道故障模板头（§4.4：逃逸通知与内部异常通知同构，不另维护逃逸专用正文）。
  const zh = await runEscape({ agent: 'zh' });
  assert.equal(zh.outcome, 'rejected');
  assert.equal(zh.nextCalls, 0, '逃逸发生在 next() 之前');
  assert.equal(zh.texts.length, 1);
  assert.equal(zh.texts[0].split('\n')[0], '[approve-for-me] 自动审批通道故障，本次升权请求按拒绝处理。');
  assert.match(zh.texts[0], /原因：应答者逃逸异常：Error: session id boom/u);
  // en 档：同一逃逸异常下注入英文整句，首行字节核对，且不得含 zh 档短语。
  const en = await runEscape({ agent: 'en' });
  assert.equal(en.outcome, 'rejected');
  assert.equal(en.texts.length, 1);
  assert.equal(en.texts[0].split('\n')[0], '[approve-for-me] Automatic approval channel failure; this escalation request is treated as rejected.');
  assert.match(en.texts[0], /Reason: an exception escaped the answerer: Error: session id boom/u);
  assert.doesNotMatch(en.texts[0], /自动审批通道故障/u, 'en 档不得残留 zh 档短语');
  // 变红判据：若逃逸注入退回硬编码 zh（N1 修正前形态），en 档首行等值断言与
  // doesNotMatch 双红；若 language.agent 不再驱动注入语言（两档同文），两首行断言其一必红；
  // 若逃逸通知退回专用拒绝正文（缺通道故障要素），两首行断言双红。
});

test('退役静态扫描：源码零补丁档位/旧宿主侧残留（设计 §8.5 判据）', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');

  /**
   * 对一份源码跑禁词扫描（注释也算：实现侧注释已清理，残留即违规）。
   * @param {string} source - 源码文本。
   * @returns {string[]} 命中的禁词。
   */
  const bannedIn = (source) => [
    'patch-marker',
    'patchStatus',
    'ui.trace.mode',
    'trace.mode.',
    'settingsScope',
    'settings.plugin.item',
    'installSection',
  ].filter((token) => source.includes(token));

  // 反例先行（能失败的证明）：同样的扫描函数对含禁词的串必须命中。
  assert.ok(bannedIn('const x = settingsScope.bind({});').length > 0, '扫描函数对禁词必须命中（防恒真）');

  const targets = [
    ...readdirSync(join(root, 'lib')).map((file) => join(root, 'lib', file)),
    join(root, 'client.js'),
    join(root, 'typert.host.js'),
    ...readdirSync(join(root, 'tools')).filter((file) => file.endsWith('.mjs')).map((file) => join(root, 'tools', file)),
  ];
  const offenders = [];
  for (const file of targets) {
    const hits = bannedIn(readFileSync(file, 'utf8'));
    if (hits.length > 0) offenders.push(`${file}: ${hits.join(', ')}`);
  }
  assert.deepEqual(offenders, [], `退役残留必须为零（设计 §8.5）：\n${offenders.join('\n')}`);
});

// ── R34④/R36②：装配层接线（逃逸出口脱敏 + 热改现设） ────────────────────

test('R34④ 逃逸分支注入文本过脱敏：error 里的秘密被遮蔽后才注入', async (t) => {
  const host = await loadHost();
  if (host === undefined) {
    t.skip('宿主包不可解析（离线环境）');
    return;
  }
  const injected = [];
  const env = makeCtx({
    mode: 'rules',
    language: { agent: 'zh' },
    context: { redactPatterns: ['sk-[A-Za-z0-9]+'] },
  });
  host.apply(env.ctx, {
    mode: 'rules',
    language: { agent: 'zh' },
    context: { redactPatterns: ['sk-[A-Za-z0-9]+'] },
  });
  const answerer = env.listeners.find((entry) => entry.event === 'approval/request').handler;
  const session = {};
  Object.defineProperty(session, 'id', { get() { throw new Error('session id boom sk-abc123secret'); } });
  const outcome = await answerer(
    { agent: { session, inject: (message) => injected.push(message) }, toolName: 'pwsh', callId: 'c', reason: 'escalate sandbox to danger-full-access: x' },
    async () => 'ask',
  );
  assert.equal(outcome, 'rejected');
  assert.equal(injected.length, 1);
  const text = injected[0].content[0].text;
  assert.match(text, /\[redacted\]/u);
  assert.doesNotMatch(text, /sk-abc123secret/u, '逃逸注入不得裸带秘密');
});

test('R36②/R58 装配接线：rt.review 按请求构造工具上下文快照并随任务传入（静态扫描），审计读取器并入脱敏清单', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  // 反例先行：扫描对退回 setter 接线必须命中（防恒真）——R58 起 rt.review 内不得再出现四个 setter 调用。
  assert.ok(!/tools\.set(Root|Lang|ToolTimeoutMs|RedactPatterns)\??\(/u.test(source), 'rt.review 不得再经共享 setter 现设（R58：并发下会改写在飞任务）');
  // 上下文在进入调度器之前按本请求快照构造（rootDir/lang/超时/清单四字段齐）。
  const at = (token) => source.indexOf(token);
  assert.ok(at('const toolContext = {') >= 0, '请求绑定的工具上下文必须构造');
  assert.ok(at('const toolContext = {') < at('scheduler.run('), '快照须在进入调度器之前完成');
  assert.ok(/rootDir:\s*located\?\.cwd/u.test(source) && /lang:\s*agentLang/u.test(source), '上下文含基准目录与文案语言');
  assert.ok(/toolTimeoutMs:\s*cfg\.reviewer\.toolTimeoutMs/u.test(source) && /redactPatterns:\s*\[\.\.\.cfg\.context\.redactPatterns\]/u.test(source), '上下文含单工具超时与脱敏清单（清单持值拷贝，防原地改数组穿透）');
  // 门面把上下文经 run 第 4 参显式传入，并以 opts.tools 交给审查循环。
  assert.ok(source.includes('tools.run(toolName, toolArgs, signal, toolContext)'), '工具执行必须携带请求上下文');
  assert.ok(source.includes('tools: taskTools'), '审查循环必须使用请求绑定门面');
  // R34：审计读取器并入 context.redactPatterns——全部 reason 出口在 createAudit 层统一覆盖。
  assert.ok(/redactPatterns:\s*current\(\)\?\.context\?\.redactPatterns/u.test(source), '审计读取器必须并入 context.redactPatterns');
});

// ── R48 计数接线（真 seam，实现审查 r46 P2-1/P3-1/P3-4 修正）───────────────────
// apply 注册真应答者 → 真 gate → 真 reviewer（llm.stream 替身）→ 真 scheduler → record。
// 三个测试共用一套装配：流替身可切「延迟后抛 provider 500」（有机故障，重试一次后 error）
// 或「挂起到 signal 中止」（中止型，模拟宿主流对 abort 的传播）。

/**
 * 装配一套完整接线的插件环境（真 gate/reviewer/scheduler，仅 llm 与服务为替身）。
 * `DSH_HOME` 指到临时目录：审查记录 JSONL 不落真 home。
 * @param {{behavior?: {delay?: number, hang?: boolean}, config?: object}} [options] - 覆盖项。
 * @returns {Promise<object | undefined>} 环境句柄；宿主包不可解析时 `undefined`。
 */
async function wiredEnv(options = {}) {
  const host = await loadHost();
  if (host === undefined) return undefined;
  const config = {
    mode: 'rules',
    language: { agent: 'zh' },
    reviewer: { model: 'deepseek-official/deepseek-flash' },
    ...options.config,
  };
  const env = makeCtx(config, {
    permissionPresets: { current: () => 'auto-approve' },
    sessions: { list: () => [] },
  });
  env.injected = [];
  const state = { streamCalls: 0, behavior: { delay: 0, ...options.behavior } };
  env.ctx.llm.stream = (streamOptions) => (async function* generate() {
    state.streamCalls += 1;
    if (state.behavior.hang === true) {
      await new Promise((resolve, reject) => {
        const signal = streamOptions?.signal;
        if (signal?.aborted === true) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return;
    }
    if (Number.isFinite(state.behavior.delay) && state.behavior.delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, state.behavior.delay));
    }
    throw new Error('provider 500');
  })();
  host.apply(env.ctx, config);
  const answerer = env.listeners.find((entry) => entry.event === 'approval/request').handler;
  const makeRequest = (callId, signal) => ({
    agent: {
      // 会话事件里带与 callId 配对的 tool/call：screen 的 unknownSubject 分支需要回查到命令，
      // 否则按 unknownSubject 拒绝（degraded=command），到不了审查接线。
      session: {
        id: 's-r48-wiring',
        header: { cwd: '<仓库目录>' },
        snapshotEvents: () => [
          { type: 'tool/call', data: { callId, arguments: '{"command":"Set-Content -Path state-r48.txt -Value ok"}' } },
        ],
      },
      inject: (message) => env.injected.push(message),
    },
    toolName: 'pwsh',
    callId,
    reason: 'escalate sandbox to danger-full-access: x',
    ...(signal === undefined ? {} : { signal }),
  });
  return { host, env, state, answerer, makeRequest, config };
}

test('R48⑤ 真接线：有机 error ×3 打开冷却，第 4 个请求零流调用并注入通道故障＋breaker-open', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), 'afm-r48-a-'));
  process.env.DSH_HOME = home;
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    const wired = await wiredEnv();
    if (wired === undefined) {
      t.skip('宿主包不可解析（离线环境）');
      return;
    }
    // next＝人工通道替身：挂起不答（用户没碰卡片），让审查结论先结算。
    const next = () => new Promise(() => {});
    for (let index = 1; index <= 3; index += 1) {
      const outcome = await wired.answerer(wired.makeRequest(`c${index}`), next);
      assert.equal(outcome, 'rejected');
    }
    assert.equal(wired.state.streamCalls, 6, '每个请求整建重试两次流（REVIEW_MAX_ATTEMPTS=2）');
    const outcome = await wired.answerer(wired.makeRequest('c4'), next);
    assert.equal(outcome, 'rejected');
    assert.equal(wired.state.streamCalls, 6, '冷却打开后零 LLM 调用');
    const injectedText = wired.env.injected[3].content[0].text;
    assert.match(injectedText, /通道故障/u);
    assert.match(injectedText, /breaker-open（冷却中，拒绝密集或故障密集）/u);
    assert.match(written.join(''), /审查未执行：breaker-open（冷却中，拒绝密集或故障密集）/u);
    const attemptLines = written.join('').match(/phase=review [^\n]*reason="attempt 2\/2: provider 500"/g) ?? [];
    assert.equal(attemptLines.length, 3, '三次有机失败各留一条 attempt 2/2 的 review 审计');
  } finally {
    process.stderr.write = original;
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('R48⑤ 真接线：请求取消引发的中止 ×3 带 superseded 不计数，第 4 个请求照常完整审查', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), 'afm-r48-b-'));
  process.env.DSH_HOME = home;
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    const wired = await wiredEnv({ behavior: { hang: true } });
    if (wired === undefined) {
      t.skip('宿主包不可解析（离线环境）');
      return;
    }
    // next＝人工通道替身：挂起不答（用户没碰卡片）；取消来自 request.signal。
    const next = () => new Promise(() => {});
    for (let index = 1; index <= 3; index += 1) {
      const controller = new AbortController();
      const pending = wired.answerer(wired.makeRequest(`cx${index}`, controller.signal), next);
      setTimeout(() => controller.abort(new Error('tool cancelled')), 20);
      const outcome = await pending;
      assert.equal(outcome, 'cancelled');
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(wired.state.streamCalls, 3, '每次取消前审查流已开始且被中止');
    assert.match(written.join(''), /degraded=superseded/u, '中止型 error 的 review 行必须可见跳过原因');
    // 取消不计数：第 4 个请求仍完整审查（若被计数，3 连发已开冷却 → 零流调用）。
    wired.state.behavior = { delay: 0 };
    const outcome = await wired.answerer(wired.makeRequest('cx4'), next);
    assert.equal(outcome, 'rejected');
    assert.equal(wired.state.streamCalls, 5, '第 4 个请求照常发起审查（首次＋重试）');
    assert.doesNotMatch(written.join(''), /breaker-open/u, '健康通道不得被人工响应速度误开冷却');
  } finally {
    process.stderr.write = original;
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('GAP-01 真接线：同 (sessionId, callId) 双投递各自执行完整审查，完成后再次到达不复用结果', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), 'afm-gap01-'));
  process.env.DSH_HOME = home;
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
  try {
    // 延迟失败让第二个应答者在第一个仍在执行时到达（在飞并发窗口）。
    const wired = await wiredEnv({ behavior: { delay: 40 } });
    if (wired === undefined) {
      t.skip('宿主包不可解析（离线环境）');
      return;
    }
    // next＝人工通道替身：挂起不答（用户没碰卡片），让审查结论先结算。
    const next = () => new Promise(() => {});
    // 1) 同一调用标识双投递：各自执行完整审查（每执行含重试共 2 次流）。
    const outcomes = await Promise.all([
      wired.answerer(wired.makeRequest('dup-1'), next),
      wired.answerer(wired.makeRequest('dup-1'), next),
    ]);
    assert.deepEqual(outcomes, ['rejected', 'rejected']);
    assert.equal(
      wired.state.streamCalls,
      4,
      '双投递各自执行（2 执行 × 2 次流）；若结果复用回潮（在飞共享或 TTL 缓存），此处必红',
    );
    // 2) 两次执行都完成后，同一调用标识再次到达：不复用已完成结果，重走完整审查。
    const again = await wired.answerer(wired.makeRequest('dup-1'), next);
    assert.equal(again, 'rejected');
    assert.equal(wired.state.streamCalls, 6, '完成后再次到达不读缓存，第 3 次完整执行（＋2 次流）');
    // 3) 每次执行恰一条审查结论（record 口径不变）：三次 attempt 2/2 审计行。
    const attemptLines = written.join('').match(/phase=review [^\n]*reason="attempt 2\/2: provider 500"/g) ?? [];
    assert.equal(attemptLines.length, 3, '三次执行各留一条审查审计');
    assert.doesNotMatch(written.join(''), /审查未执行/u, '全程无调度失败（并发足够，队列未满、冷却未开）');
  } finally {
    process.stderr.write = original;
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('GAP-02 真接线：装载→停用/卸载全程不解析、不改写用户 YAML——副本逐字节不变，无备用清理', async (t) => {
  const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const host = await loadHost();
  if (host === undefined) {
    t.skip('宿主包不可解析（离线环境）');
    return;
  }
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), 'afm-gap02-'));
  process.env.DSH_HOME = home;
  // profile fixture：patch 带设置界面写出的 permission 覆盖行（presets＋defaultPreset: auto-approve），
  // manifest 数组不含本包（＝removeBundle 落盘后、reload 卸载中形态）。
  const profileDir = join(home, 'profiles', 'web');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-base'] } } }), 'utf8');
  const yamlText = [
    '# Your patch layer for this dsh profile.',
    '- id: permission',
    "  name: '@deepseek-ai/dsh-permission-presets'",
    '  config:',
    '    presets:',
    '      auto-approve:',
    '        sandbox: workspace-write',
    '    defaultPreset: auto-approve',
  ].join('\n') + '\n';
  writeFileSync(join(profileDir, 'cordis.patch.yml'), yamlText, 'utf8');
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
  /**
   * effect 捕获型 ctx：不立即执行 disposer，登记进数组（真实 cordis 在 dispose 时逆序执行）。
   * @param {object} [services] - ctx.get 服务表。
   * @returns {object} ctx 与 disposers。
   */
  const guardCtx = (services) => {
    const disposers = [];
    const ctx = {
      effect: (fn) => { disposers.push(fn()); return () => {}; },
      on: () => () => {},
      get: (name) => services[name],
      llm: { listProviders: () => [] },
    };
    return { ctx, disposers };
  };
  try {
    // 1) mode=off 早退形态：不注册任何 effect（防护已退役）。
    const offEnv = guardCtx({ profileContext: { dir: profileDir } });
    host.apply(offEnv.ctx, { mode: 'off' });
    assert.equal(offEnv.disposers.length, 0, 'mode=off 早退不注册 effect（默认预设悬空防护已退役）');
    // 2) 正常形态同样不注册 effect（不随接线注册配置手术）。
    const env = guardCtx({ profileContext: { dir: profileDir }, sessions: { list: () => [] }, permissionPresets: {} });
    host.apply(env.ctx, { mode: 'rules', enabled: true });
    assert.equal(env.disposers.length, 0, '正常接线不注册任何配置手术 effect');
    // 3) 执行全部 disposer＝卸载时点：用户 YAML 逐字节不变。
    for (const dispose of env.disposers) await dispose();
    for (const dispose of offEnv.disposers) await dispose();
    const after = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8');
    assert.equal(after, yamlText, '装卸全程用户 YAML 逐字节不变（不解析、不改写、不提供备用清理）');
    assert.doesNotMatch(written.join(''), /预设残留防护/u, '不得再出现备用清理的审计动作');
  } finally {
    process.stderr.write = original;
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// ── ISS-6/ISS-7：配置不可读的逃逸出口与同一对象再派发（真接线） ─────────────

test('§4.1 配置不可读时逃逸出口自含：不外抛、恰一条结算记录、审计行照写、通知走通道故障模板（en 回退）', async (t) => {
  const { mkdtempSync, readFileSync, readdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const host = await loadHost();
  if (host === undefined) {
    t.skip('宿主包不可解析（离线环境）');
    return;
  }
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), 'afm-p05b-unit-'));
  process.env.DSH_HOME = home;
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
  try {
    const wired = await wiredEnv();
    if (wired === undefined) {
      t.skip('宿主包不可解析（离线环境）');
      return;
    }
    // volatile 旁路：apply 后程序化写入 NaN（不过 schema 校验），生效配置此后每读即抛。
    wired.config.reviewer = { ...wired.config.reviewer, temperature: Number.NaN };
    const outcome = await wired.answerer(wired.makeRequest('c1'), () => new Promise(() => {}));
    assert.equal(outcome, 'rejected', '配置不可读也 fail-closed 为拒绝，不外抛');
    assert.equal(wired.state.streamCalls, 0, '配置不可读：审查未发起');
    const text = wired.env.injected[0].content[0].text;
    assert.equal(
      text.split('\n')[0],
      '[approve-for-me] Automatic approval channel failure; this escalation request is treated as rejected.',
      '配置不可读时语言回落 en（zh 配置不生效）',
    );
    assert.match(text, /Reason: reviewer internal error/u);
    assert.match(written.join(''), /审查器内部错误/u, '审计行照写');
    // 恰一条结算记录（默认采集档继续落盘；preset 字段因读取失败而缺失）。
    await new Promise((resolve) => setTimeout(resolve, 150));
    const dir = join(home, 'approve-for-me', 'reviews');
    const rows = readdirSync(dir).flatMap((file) =>
      readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
    const settles = rows.filter((row) => row.kind === 'settle');
    assert.equal(settles.length, 1, '恰一条结算记录');
    assert.equal(settles[0].outcome, 'rejected');
    assert.equal(settles[0].source, 'error');
    assert.equal(settles[0].preset, undefined, 'preset 读取失败：字段缺失');
  } finally {
    process.stderr.write = original;
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('§5.1/§4.2 同一请求对象再派发：收尾恢复原始信号，再次到达按新请求处理（完整审查）', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const host = await loadHost();
  if (host === undefined) {
    t.skip('宿主包不可解析（离线环境）');
    return;
  }
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), 'afm-p06e-unit-'));
  process.env.DSH_HOME = home;
  try {
    const wired = await wiredEnv();
    if (wired === undefined) {
      t.skip('宿主包不可解析（离线环境）');
      return;
    }
    const controller = new AbortController();
    const req = wired.makeRequest('c1', controller.signal);
    const next = () => new Promise(() => {});
    // 首次到达：provider 500 → error 判定 → rejected；结算后投影不残留。
    const first = await wired.answerer(req, next);
    assert.equal(first, 'rejected');
    assert.equal(req.signal, controller.signal, '首次结算后信号恢复为进入时的原始值（同一性，非新信号）');
    assert.equal(controller.signal.aborted, false, '原始信号未被审批过程中止');
    // 同一对象再次到达：按新请求处理——重新发起完整审查（流再次调用），而非 cancelled(signal)。
    const callsBefore = wired.state.streamCalls;
    const second = await wired.answerer(req, next);
    assert.equal(second, 'rejected', '再次到达走完整审查并按结论结算（不是 cancelled(signal)）');
    assert.ok(wired.state.streamCalls > callsBefore, '再次到达重新发起模型流');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
