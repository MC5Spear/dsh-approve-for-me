import assert from 'node:assert/strict';
import test from 'node:test';
import { AUDIT_VERSION } from '../lib/audit.js';
import { rmTree } from './helpers/rm-tree.mjs';

/**
 * 宿主接线冒烟测试。
 *
 * `lib/index.js` 导入 `@deepseek-ai/*`，只有宿主解析环境能加载它；离线跑 `node --test test/`
 * 时导入失败，本文件整体跳过。需要实跑时：
 *   node --import ./tools/_host-hooks.mjs --test test/index.test.mjs
 *
 * **只吞「宿主包解析不到」这一种失败**：语法错误、模块内部抛错、被依赖的相对文件缺失都必须让本文件红着，
 * 否则会变成「跳过＝通过」的假绿（`npm run check` 另行接住 `lib/**` 的语法）。
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
    // 实现不触碰设置服务（行 id 即命名空间，读写全在 profile patch 通道）。
    // 陷阱 Proxy：任何属性访问即失败——「实现还在调用 ctx.settings」会让测试变红而不是静默通过。
    settings: new Proxy({}, {
      get() {
        throw new Error('实现不得访问 ctx.settings（设置读写走宿主行 Config + volatile 引用）');
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
    header: { parentSession: 'root-1', isSeeded: false, delegationDepth: 1, origin: 'subagent' },
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
  // inject 声明：设置服务不在依赖内；漏一个都是加载期直接失败（见 CONTRIBUTING 改动纪律）。
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
    // 启动行版本号与审计版本常量同源（design §8.1；期望值从 lib/audit.js 导入，不盯字面量——
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

test('mode=off 冷启动仍注册应答器；enabled=false 才装载期不注册（design §2.1）', async (t) => {
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
    assert.equal(
      env.listeners.some((entry) => entry.event === 'approval/request'),
      true,
      'mode 是 volatile：off 冷启动也注册应答器，跳过在请求期判定——只在装载期判断会让热切 off 再切回的实例拿不回应答器',
    );
    const startup = written.join('');
    assert.match(startup, /answerer registered/, '启动行注册态说明与实际注册态一致');
    assert.match(startup, /mode=off /, '行内 mode 字段表达档位');

    // enabled=false（非 volatile）维持装载期不注册（等同未安装）。
    const writtenDisabled = [];
    process.stderr.write = (chunk) => {
      writtenDisabled.push(String(chunk));
      return true;
    };
    const envDisabled = makeCtx({ enabled: false, mode: 'rules' });
    host.apply(envDisabled.ctx, { enabled: false, mode: 'rules' });
    assert.equal(envDisabled.listeners.some((entry) => entry.event === 'approval/request'), false);
    assert.match(writtenDisabled.join(''), /disabled by configuration/);
  } finally {
    process.stderr.write = original;
  }
});

// ── 子代理覆盖的接线断言（requirements §2.2／design §2.2）──────────────────

test('接线：rules 模式挂 session/created 监听且装载补扫翻可覆盖子会话', async (t) => {
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
  assert.ok(created, 'rules 模式未注册 session/created 监听');
  assert.equal(wiring.appendCalls.length, 1, '装载补扫没有翻活表里的可覆盖委派子会话');
  assert.equal(wiring.appendCalls[0].type, 'approval/policy');
  assert.deepEqual(wiring.appendCalls[0].data, { policy: 'ask' });

  // 监听器对后续创建的委派子会话同样生效（通过监听入口直调）。
  const second = subagentServices();
  assert.doesNotThrow(() => created.handler(second.child));
  assert.equal(second.appendCalls.length, 1, 'session/created 监听没有翻新委派子会话');
});

test('接线：off 冷启动同样挂监听——off 期不翻策略，热切回 rules 后新建委派会话恢复追加', async (t) => {
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
    const wiringOff = subagentServices();
    const config = { mode: 'off' };
    const envOff = makeCtx(config, wiringOff.services);
    host.apply(envOff.ctx, config);
    const created = envOff.listeners.find((entry) => entry.event === 'session/created');
    assert.ok(created, 'off 冷启动也注册 session/created 监听（design §2.2：注册一次、事件时点判 mode）');
    assert.equal(wiringOff.appendCalls.length, 0, 'off 期间装载补扫不翻任何子会话');
    // off 期间创建的委派子会话：监听入口直调不翻（保持宿主钉死的 never）。
    const offPeriodChild = subagentServices();
    assert.doesNotThrow(() => created.handler(offPeriodChild.child));
    assert.equal(offPeriodChild.appendCalls.length, 0, 'off 期间创建的委派子会话不翻');
    assert.ok(
      written.join('').includes('mode=off 期间不翻'),
      'off 期跳过要留可见审计行',
    );
    // 热切回 rules（volatile 引用更新）：新建委派子会话恢复追加。
    config.mode = 'rules';
    const afterRules = subagentServices();
    assert.doesNotThrow(() => created.handler(afterRules.child));
    assert.equal(afterRules.appendCalls.length, 1, '热切回 rules 后 session/created 恢复翻新委派子会话');
    // 热切换不是装载边界：不重跑补扫，off 期间创建的子会话不被补翻。
    assert.equal(offPeriodChild.appendCalls.length, 0, 'mode 热切换不重跑装载补扫（off 期子会话保持 never）');
  } finally {
    process.stderr.write = original;
  }
});

test('接线：分叉会话按主会话对待——补扫与 session/created 都不翻策略', async (t) => {
  const host = await loadHost();
  if (host === undefined) {
    t.skip('宿主包不可解析（离线环境）');
    return;
  }
  const appendCalls = [];
  const fork = {
    id: 'fork-1',
    // 宿主 session/fork 的内存新建形态：只带 parentSession 与 isSeeded，无 delegationDepth。
    header: { parentSession: 'root-1', isSeeded: true },
    snapshotEvents: () => [{ type: 'approval/policy', data: { policy: 'never', source: 'delegation' } }],
    append: (type, data) => { appendCalls.push({ type, data }); },
  };
  const services = {
    sessions: {
      list: () => [
        { id: 'root-1', header: {}, snapshotEvents: () => [{ type: 'permission/preset', data: { preset: 'auto-approve' } }] },
        fork,
      ],
    },
    permissionPresets: { current: (session) => (session.id === 'root-1' ? 'auto-approve' : undefined) },
  };
  const env = makeCtx({ mode: 'rules' }, services);
  host.apply(env.ctx, { mode: 'rules' });
  // 装载补扫：根会话在表且预设命中，但分叉不是委派子会话，不得翻策略。
  assert.equal(appendCalls.length, 0, '分叉会话被补扫翻策略（误当委派子会话）');
  const created = env.listeners.find((entry) => entry.event === 'session/created');
  assert.doesNotThrow(() => created.handler(fork));
  assert.equal(appendCalls.length, 0, 'session/created 对分叉会话不得追加审批策略');
});

test('接线：监听器回退吞掉 append 异常，不外抛（双保险的外层）', async (t) => {
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

test('静态扫描：lib/subagents.js 不触碰 ctx（依赖全部注入）', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../lib/subagents.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bctx\./, 'subagents.js 出现 ctx 直接访问：覆盖判定依赖必须经 deps 注入');
  assert.doesNotMatch(source, /\bpermissionPresets\.set\b/, '禁止整预设写入（会改写委派沙箱）');
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
  assert.equal(nested.reviewer.maxTokens, 0, '默认 0 = 不把 maxTokens 放进审查请求（design §3.6）');
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

// ── index 层逃逸注入文本的两语言行为断言（design §4.4）──────────────────────

/**
 * 构造一次「应答者逃逸异常」请求：`request.agent.session.id` 的 getter 抛错。
 * gate.js 在 `try` 之外读取该字段（`const sessionId = request?.agent?.session?.id`），
 * 异常因此绕过 gate 的 try 承接层（gate.js 头注不变量 I2「永不抛出」的承接范围）、直达 index.js 应答者最外层 catch——即逃逸通知路径
 * （通道故障模板＋`gate.escape.reason` 原因段，design §4.4）。
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

test('逃逸通知走通道故障模板并按 language.agent 切换：zh 中文整句、en 英文整句（两语言行为差异；design §4.4）', async (t) => {
  const host = await loadHost();
  if (host === undefined) {
    t.skip('宿主包不可解析（离线环境）');
    return;
  }
  // zh 档：首行与关键字按字节核对（口径同 requirements §5.4），fail-closed 为 rejected；
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
  // 变红判据：若逃逸注入退回硬编码 zh，en 档首行等值断言与
  // doesNotMatch 双红；若 language.agent 不再驱动注入语言（两档同文），两首行断言其一必红；
  // 若逃逸通知退回专用拒绝正文（缺通道故障要素），两首行断言双红。
});

test('退役静态扫描：源码零补丁框架/旧档位键/旧宿主 API 残留（design §10.2 判据）', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');

  /**
   * 对一份源码跑禁词扫描（注释也算：残留即违规）。
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
  assert.deepEqual(offenders, [], `退役残留必须为零（design §10.2）：\n${offenders.join('\n')}`);
});

// ── 装配层接线：逃逸出口脱敏＋热改现设（requirements §5.2／design §8.1）──────

test('逃逸分支注入文本过脱敏：error 里的秘密被遮蔽后才注入', async (t) => {
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

test('装配接线：rt.review 按请求构造工具上下文快照并随任务传入（静态扫描），审计读取器并入脱敏清单', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  // 反例先行：扫描对退回 setter 接线必须命中（防恒真）——rt.review 内不得出现四个 setter 调用。
  assert.ok(!/tools\.set(Root|Lang|ToolTimeoutMs|RedactPatterns)\??\(/u.test(source), 'rt.review 不得经共享 setter 现设（并发下会改写在飞任务，design §6.1）');
  // 上下文在进入调度器之前按本请求快照构造（rootDir/lang/超时/清单四字段齐）。
  const at = (token) => source.indexOf(token);
  assert.ok(at('const toolContext = {') >= 0, '请求绑定的工具上下文必须构造');
  assert.ok(at('const toolContext = {') < at('scheduler.run('), '快照须在进入调度器之前完成');
  assert.ok(/rootDir:\s*located\?\.cwd/u.test(source) && /lang:\s*agentLang/u.test(source), '上下文含基准目录与文案语言');
  assert.ok(/toolTimeoutMs:\s*cfg\.reviewer\.toolTimeoutMs/u.test(source) && /redactPatterns:\s*\[\.\.\.cfg\.context\.redactPatterns\]/u.test(source), '上下文含单工具超时与脱敏清单（清单持值拷贝，防原地改数组穿透）');
  // 门面把上下文经 run 第 4 参显式传入，并以 opts.tools 交给审查循环。
  assert.ok(source.includes('tools.run(toolName, toolArgs, signal, toolContext)'), '工具执行必须携带请求上下文');
  assert.ok(source.includes('tools: taskTools'), '审查循环必须使用请求绑定门面');
  // 审计读取器并入 context.redactPatterns——全部 reason 出口在 createAudit 层统一覆盖。
  assert.ok(/redactPatterns:\s*current\(\)\?\.context\?\.redactPatterns/u.test(source), '审计读取器必须并入 context.redactPatterns');
  // 装配期超时计数接线（design §5.3）：rt 契约提供 countTimeout，直连真 scheduler.record('error')。
  assert.ok(/countTimeout:\s*\(\)\s*=>\s*scheduler\.record\('error'\)/u.test(source), '装配期超时须与真实超时同一路径计数');
  // 启动审计行缺省显示与 schema 默认同源（REVIEWER_TIMEOUT_DEFAULT_MS 单一来源）。
  assert.ok(/reviewTimeout=\$\{cfg\?\.reviewer\?\.timeoutMs \?\? REVIEWER_TIMEOUT_DEFAULT_MS\}/u.test(source), '启动行缺省时限取导出常量，不硬编码');
});

// ── 冷却计数接线（真 seam；requirements §4.4／design §5.3）─────────────────
// apply 注册真应答者 → 真 gate → 真 reviewer（llm.stream 替身）→ 真 scheduler → record。
// 本文件真接线用例共用这套装配：流替身可切「延迟后抛 provider 500」（有机故障，重试一次后 error）
// 或「挂起到 signal 中止」（中止型，模拟宿主流对 abort 的传播）。

/**
 * 装配一套完整接线的插件环境（真 gate/reviewer/scheduler，仅 llm 与服务为替身）。
 * `DSH_HOME` 指到临时目录：审查记录 JSONL 不落真 home。
 * @param {{behavior?: {delay?: number, hang?: boolean, errorText?: string}, resolveDelayMs?: number, config?: object}} [options] - 覆盖项。
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
  // 模型目录延迟测试缝（真接线反例）：resolveModelInfo 延迟把等待注入装配阶段，
  // 人工 request 起算的预算从请求进入就开始消耗。
  if (options.resolveDelayMs !== undefined) {
    const originalResolve = env.ctx.llm.resolveModelInfo.bind(env.ctx.llm);
    env.ctx.llm.resolveModelInfo = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, options.resolveDelayMs));
      return originalResolve(...args);
    };
  }
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
    throw new Error(state.behavior.errorText ?? 'provider 500');
  })();
  host.apply(env.ctx, config);
  const answerer = env.listeners.find((entry) => entry.event === 'approval/request').handler;
  const makeRequest = (callId, signal) => ({
    agent: {
      // 会话事件里带与 callId 配对的 tool/call：screen 的 unknownSubject 分支需要回查到命令，
      // 否则按 unknownSubject 拒绝（degraded=command），到不了审查接线。
      session: {
        id: 's-true-wiring',
        // 会话头 cwd 用真实绝对路径（design §3.1 合法目录判定：非绝对路径按缺失折叠）。
        header: { cwd: process.cwd() },
        snapshotEvents: () => [
          { type: 'tool/call', data: { callId, arguments: '{"command":"Set-Content -Path state-check.txt -Value ok"}' } },
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

test('真接线：宿主 inject 抛错经生产 rt.inject 上抛，decide 行并入 inject-fail（design §4.4／§8.2）', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), 'afm-inject-fail-'));
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
    // 审查 error（provider 500）→ decide 行 rejected；注入通道故障模板发往宿主 inject——
    // 宿主 inject 抛错必须上抛留痕，不得被生产包装吞掉（否则 inject-fail 标记不可达）。
    const request = wired.makeRequest('c-inject-fail');
    let hostInjectCalls = 0;
    request.agent.inject = () => {
      hostInjectCalls += 1;
      throw new Error('host inject boom');
    };
    const outcome = await wired.answerer(request, () => new Promise(() => {}));
    assert.equal(outcome, 'rejected');
    assert.equal(hostInjectCalls, 1, '注入文本确实发往宿主 inject（用例前提）');
    const decide = written.find((line) => line.includes('phase=decide'));
    assert.ok(decide, '必须有 decide 行');
    assert.match(decide, /inject=yes/u, 'decide 行记录注入已发生');
    assert.match(decide, /inject-fail/u, '宿主 inject 异常必须留痕为 inject-fail 降级标记');
  } finally {
    process.stderr.write = original;
    process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('真接线：逃逸 × 宿主 inject 抛错 → rejected＋结算在场，error 行留 inject-fail（三调用点同口径）', async (t) => {
  const { mkdtempSync, rmSync, readFileSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), 'afm-escape-inject-'));
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
    // 逃逸触发：session getter 抛错（gate 的 try 之前的语句，直达 index 应答者 catch）；
    // 同场宿主 inject 再抛——第二异常不得逃出 catch（否则无结算、无审计、不返回 rejected）。
    let hostInjectCalls = 0;
    const request = {
      get agent() {
        return {
          get session() { throw new Error('session id boom'); },
          inject: () => {
            hostInjectCalls += 1;
            throw new Error('host inject boom');
          },
        };
      },
      toolName: 'pwsh',
      callId: 'c-escape-inject',
      reason: 'escalate sandbox to danger-full-access: x',
    };
    const outcome = await wired.answerer(request, () => new Promise(() => {}));
    assert.equal(outcome, 'rejected', '逃逸注入抛错时仍须 fail-closed 返回 rejected');
    assert.equal(hostInjectCalls, 1, '逃逸通知确实发往宿主 inject（用例前提）');
    const errorLine = written.find((line) => line.includes('phase=error'));
    assert.ok(errorLine, '逃逸路径必须有 error 审计行');
    assert.match(errorLine, /应答者逃逸异常/u);
    assert.match(errorLine, /inject-fail/u, '逃逸注入的失败留痕 degraded=inject-fail');
    // 结算记录在场（design §8.4）：会话取不到按缺省会话 '-' 归档（落盘异步，等待与既有
    // 逃逸结算用例同款；目录遍历不作文件名假设）。
    await new Promise((resolve) => setTimeout(resolve, 150));
    const reviewDir = join(home, 'approve-for-me', 'reviews');
    const rows = readdirSync(reviewDir).flatMap((file) =>
      readFileSync(join(reviewDir, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
    const settles = rows.filter((row) => row.kind === 'settle');
    assert.equal(settles.length, 1, '逃逸×宿主 inject 抛错仍恰落一条结算记录');
    assert.equal(settles[0].sessionId, '-');
    assert.equal(settles[0].outcome, 'rejected');
    assert.match(settles[0].reason ?? '', /应答者逃逸异常/u);
  } finally {
    process.stderr.write = original;
    process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('真接线：有机 error ×3 打开冷却，第 4 个请求零流调用并注入通道故障＋breaker-open', async (t) => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), 'afm-breaker-open-'));
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
    rmTree(home);
  }
});

test('真接线：分叉会话人工通道在场——fallback=ask 审查失败后转人工', async (t) => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), 'afm-fork-'));
  process.env.DSH_HOME = home;
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    // 两种分叉形态各一套装配：内存新建（delegationDepth 缺席，主用例）与持久化回读（depth 0）。
    for (const forkHeader of [
      { cwd: process.cwd(), parentSession: 's-root', isSeeded: true },
      { cwd: process.cwd(), parentSession: 's-root', isSeeded: true, delegationDepth: 0 },
    ]) {
      const wired = await wiredEnv({
        config: {
          fallback: 'ask',
          human: { timeoutMs: 60000, timeoutFrom: 'handoff' },
        },
      });
      if (wired === undefined) {
        t.skip('宿主包不可解析（离线环境）');
        return;
      }
      const base = wired.makeRequest('cf1');
      const request = {
        ...base,
        agent: { ...base.agent, session: { ...base.agent.session, header: forkHeader } },
      };
      // 审计断言逐形态独立成立：先清掉上一形态（装配行）的累积写出。
      written.length = 0;
      // 人工替身：记录调用，延迟 30ms 按「用户点了拒绝」结算——等审查流先收束，
      // 走「确实交人工」的 handoff 路径（立即结算会走抢答路径，同样不写 handoff 行）。
      // 若退回仅按 parentSession 判委派，分叉会被误判无头、next() 不会被调用——本断言须红。
      let nextCalls = 0;
      const outcome = await wired.answerer(request, () => {
        nextCalls += 1;
        return new Promise((resolve) => setTimeout(() => resolve('rejected'), 30));
      });
      assert.equal(nextCalls, 1, `分叉会话须恰好消费一次人工通道（gate.js 头注不变量 I1：next() 至多一次）：${JSON.stringify(forkHeader)}`);
      assert.equal(outcome, 'rejected');
      assert.match(written.join(''), /phase=handoff/u, '交人工须留 handoff 审计行');
      assert.match(written.join(''), /phase=decide[^\n]*source=human[^\n]*decision=rejected/u, '人工拒绝按 source=human 结算');
    }
  } finally {
    process.stderr.write = original;
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmTree(home);
  }
});

test('真接线 I1（gate.js 头注不变量：next() 至多一次）：resolver 模型目录延迟 100ms × 人工预算 20ms（request 起算、关卡）→ 按人工超时拒绝', async (t) => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), 'afm-i1-'));
  process.env.DSH_HOME = home;
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    const wired = await wiredEnv({
      resolveDelayMs: 100,
      config: {
        fallback: 'ask',
        human: { timeoutMs: 20, timeoutFrom: 'request' },
        ui: { humanCardDuringReview: false, inject: 'all', injectMaxBytes: 2048 },
      },
    });
    if (wired === undefined) {
      t.skip('宿主包不可解析（离线环境）');
      return;
    }
    let nextCalls = 0;
    const next = () => {
      nextCalls += 1;
      return new Promise(() => {});
    };
    const outcome = await wired.answerer(wired.makeRequest('c-i1'), next);
    assert.equal(outcome, 'rejected');
    assert.equal(nextCalls, 0, '关卡模式＋预算耗尽：不调人工 next');
    const injectedText = wired.env.injected.at(-1).content[0].text;
    assert.match(injectedText, /超时环节：人工未在时限内响应 20 ms/u, '注入超时文案环节为人工');
    assert.ok(wired.state.streamCalls >= 1, '审查照常执行（预算耗尽不吞审查）');
  } finally {
    process.stderr.write = original;
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmTree(home);
  }
});

test('真接线：请求取消引发的中止 ×3 带 superseded 不计数，第 4 个请求照常完整审查', async (t) => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), 'afm-cancel-superseded-'));
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
    rmTree(home);
  }
});

test('真接线：同 (sessionId, callId) 双投递各自执行完整审查，完成后再次到达不复用结果（design §5.1）', async (t) => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), 'afm-double-delivery-'));
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
    rmTree(home);
  }
});

test('真接线：装载→停用/卸载全程不解析、不改写用户 YAML——副本逐字节不变，无备用清理（design §9.2）', async (t) => {
  const { mkdirSync, mkdtempSync, readFileSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const host = await loadHost();
  if (host === undefined) {
    t.skip('宿主包不可解析（离线环境）');
    return;
  }
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), 'afm-yaml-untouched-'));
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
    // 1) mode=off 早退形态：不注册任何 effect。
    const offEnv = guardCtx({ profileContext: { dir: profileDir } });
    host.apply(offEnv.ctx, { mode: 'off' });
    assert.equal(offEnv.disposers.length, 0, 'mode=off 早退不注册 effect');
    // 2) 正常形态同样不注册 effect（不随接线改写配置）。
    const env = guardCtx({ profileContext: { dir: profileDir }, sessions: { list: () => [] }, permissionPresets: {} });
    host.apply(env.ctx, { mode: 'rules', enabled: true });
    assert.equal(env.disposers.length, 0, '正常接线不注册任何配置改写 effect');
    // 3) 执行全部 disposer＝卸载时点：用户 YAML 逐字节不变。
    for (const dispose of env.disposers) await dispose();
    for (const dispose of offEnv.disposers) await dispose();
    const after = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8');
    assert.equal(after, yamlText, '装卸全程用户 YAML 逐字节不变（不解析、不改写、不提供备用清理）');
    assert.doesNotMatch(written.join(''), /预设残留防护/u, '不得出现备用清理的审计动作');
  } finally {
    process.stderr.write = original;
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmTree(home);
  }
});

// ── 配置不可读的逃逸出口与同一对象再派发（真接线） ──────────────────────────

test('§4.1 配置不可读时逃逸出口自含：不外抛、恰一条结算记录、审计行照写、通知走通道故障模板（en 回退）', async (t) => {
  const { mkdtempSync, readFileSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const host = await loadHost();
  if (host === undefined) {
    t.skip('宿主包不可解析（离线环境）');
    return;
  }
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), 'afm-config-unreadable-'));
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
    rmTree(home);
  }
});

test('§4.1 在飞审查期间配置变不可读：审查记录仍落盘（redactText 回退默认清单，不整条丢失）', async (t) => {
  const { mkdtempSync, readFileSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const host = await loadHost();
  if (host === undefined) {
    t.skip('宿主包不可解析（离线环境）');
    return;
  }
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), 'afm-redact-mid-'));
  process.env.DSH_HOME = home;
  try {
    // 流替身延迟 150ms 后抛带密钥样式的 provider 500：审查照常产出 error 判定；延迟期间把生效配置
    // 变不可读（volatile 旁路写 NaN）——redactText 的读取必须防抛并回退**随包默认清单**（不只是
    // 记录存活：默认清单命中的秘密串在记录里必须已遮蔽），审查记录不得整条丢失。
    const secret = 'sk-AbCdEf123456';
    const wired = await wiredEnv({ behavior: { delay: 150, errorText: `provider 500 ${secret}` } });
    if (wired === undefined) {
      t.skip('宿主包不可解析（离线环境）');
      return;
    }
    const promise = wired.answerer(wired.makeRequest('c1'), () => new Promise(() => {}));
    // 轮询确认审查已发起（流已被调用）再突变配置——比固定延时更能根除慢机偶红。
    for (let i = 0; i < 100 && wired.state.streamCalls < 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    wired.config.reviewer = { ...wired.config.reviewer, temperature: Number.NaN };
    assert.equal(await promise, 'rejected');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const dir = join(home, 'approve-for-me', 'reviews');
    const raw = readdirSync(dir).map((file) => readFileSync(join(dir, file), 'utf8')).join('\n');
    const rows = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(rows.some((row) => row.kind === 'review'), '审查记录必须照常落盘（不因配置不可读整条丢失）');
    assert.ok(rows.some((row) => row.kind === 'settle'), '结算记录照常落盘');
    assert.ok(!raw.includes(secret), '回退默认清单生效：记录里不得出现原始秘密串');
    assert.ok(raw.includes('[redacted]'), '默认清单命中的秘密串必须已遮蔽');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmTree(home);
  }
});

test('§4.2 同一性守卫（真接线）：在飞期间信号被第三方改写 → 收尾不覆盖新值', async (t) => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const host = await loadHost();
  if (host === undefined) {
    t.skip('宿主包不可解析（离线环境）');
    return;
  }
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), 'afm-guard-unit-'));
  process.env.DSH_HOME = home;
  try {
    // 流替身延迟 150ms 后抛 provider 500：结算前有明确的在飞窗口。
    const wired = await wiredEnv({ behavior: { delay: 150 } });
    if (wired === undefined) {
      t.skip('宿主包不可解析（离线环境）');
      return;
    }
    const controller = new AbortController();
    const req = wired.makeRequest('c1', controller.signal);
    const promise = wired.answerer(req, () => new Promise(() => {}));
    // 轮询确认审查已发起（流已被调用）再改写信号——比固定延时更能根除慢机偶红。
    for (let i = 0; i < 100 && wired.state.streamCalls < 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // 审查在飞时，后续到达的审批或宿主改写了请求对象的信号（真实 withdraw 的守卫用例）。
    const sentinel = new AbortController().signal;
    req.signal = sentinel;
    assert.equal(await promise, 'rejected');
    assert.equal(req.signal, sentinel, '收尾恢复跳过：不把第三方写入的信号覆盖回旧值（守卫在真 withdraw 上）');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmTree(home);
  }
});

test('§4.1 逃逸出口的结算记录（getter 触发逃逸）：结算记录照常落盘，会话按缺省会话 - 归档', async (t) => {
  const { mkdtempSync, readFileSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const host = await loadHost();
  if (host === undefined) {
    t.skip('宿主包不可解析（离线环境）');
    return;
  }
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), 'afm-escape-record-'));
  process.env.DSH_HOME = home;
  try {
    // session.id 的 getter 抛错触发逃逸：背景读取防抛后，结算记录不得丢失，
    // 会话 id 按缺省会话 '-'（与 rt.review 的约定一致）归档。
    const config = { mode: 'rules', language: { agent: 'zh' } };
    const env = makeCtx(config);
    env.injected = [];
    host.apply(env.ctx, config);
    const answerer = env.listeners.find((entry) => entry.event === 'approval/request').handler;
    const outcome = await answerer(escapeRequest(env.injected), async () => 'ask');
    assert.equal(outcome, 'rejected');
    assert.equal(env.injected.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const dir = join(home, 'approve-for-me', 'reviews');
    const rows = readdirSync(dir).flatMap((file) =>
      readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
    const settles = rows.filter((row) => row.kind === 'settle');
    assert.equal(settles.length, 1, 'getter 触发逃逸也恰落一条结算记录');
    assert.equal(settles[0].sessionId, '-', '会话 id 取不到时按缺省会话 - 归档');
    assert.equal(settles[0].outcome, 'rejected');
    assert.equal(settles[0].source, 'error');
    assert.match(settles[0].reason, /应答者逃逸异常/u);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmTree(home);
  }
});

test('§5.1/§4.2 同一请求对象再派发：收尾恢复原始信号，再次到达按新请求处理（完整审查）', async (t) => {
  const { mkdtempSync, readFileSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const host = await loadHost();
  if (host === undefined) {
    t.skip('宿主包不可解析（离线环境）');
    return;
  }
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), 'afm-redispatch-'));
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
    // 判据补全：两次到达各落一条结算记录（再次到达不是复用首次的记录）。
    await new Promise((resolve) => setTimeout(resolve, 150));
    const dir = join(home, 'approve-for-me', 'reviews');
    const rows = readdirSync(dir).flatMap((file) =>
      readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
    const settles = rows.filter((row) => row.kind === 'settle');
    assert.equal(settles.length, 2, '两次到达各落一条结算记录');
    assert.equal(settles[0].outcome, 'rejected');
    assert.equal(settles[1].outcome, 'rejected');
    assert.equal(settles[1].source, 'llm', '第二条按完整审查的结论结算（非 signal 取消）');
    assert.notEqual(settles[0].approvalId, settles[1].approvalId, '两次到达是两个审批实例');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmTree(home);
  }
});
