import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFileSync } from 'node:fs';
import { DEFAULT_RATIONALE } from '../lib/reviewer.js';

/** 文件级收尾：清掉最后一个用例留下的轮询定时器，否则测试进程不退出。 */
after(() => {
  cleanupEffects();
});

/** 客户端半是加载器脚本（无 import/export），用 `new Function` 在受控 window 下求值。 */
const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

/** 最小 react 替身：调用顺序稳定的 useState，支持跨次渲染读回更新。 */
let hookStates = [];
/** ref 槽：与 `hookStates` 平行，跨渲染持久。 */
let hookRefs = [];
let hookIndex = 0;
/** 副作用清理函数：替身同步执行副作用，返回值（清理函数）收在这里，文件结束时统一执行。 */
let effectCleanups = [];
const reactStub = {
  useState: (initial) => {
    const index = hookIndex;
    hookIndex += 1;
    if (!(index in hookStates)) hookStates[index] = typeof initial === 'function' ? initial() : initial;
    const setValue = (value) => {
      hookStates[index] = typeof value === 'function' ? value(hookStates[index]) : value;
    };
    return [hookStates[index], setValue];
  },
  useEffect: (fn) => {
    // 替身同步执行副作用：异步 setState 由用例用 tick 推进后重新渲染读取。
    // 清理函数必须收集起来：组件里的轮询定时器否则会一直挂着，测试进程不退出。
    const cleanup = fn();
    if (typeof cleanup === 'function') effectCleanups.push(cleanup);
  },
  useRef: (initial) => {
    // ref 必须跨渲染持久（与 useState 同理）：每次渲染都新建对象会让"签名守卫"这类写法失效，
    // 测出来的行为与真实 React 不符。
    const index = hookIndex;
    hookIndex += 1;
    if (!(index in hookRefs)) hookRefs[index] = { current: initial };
    return hookRefs[index];
  },
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useId: () => 'id',
  Fragment: Symbol('Fragment'),
};

/**
 * 执行并清空已收集的副作用清理函数。
 * @returns {void}
 */
function cleanupEffects() {
  for (const cleanup of effectCleanups.splice(0)) cleanup();
}

/**
 * 重置钩子存储；每个用例开头调用，避免用例间状态串味。
 * @returns {void}
 */
function resetHooks() {
  cleanupEffects();
  hookStates = [];
  hookRefs = [];
  hookIndex = 0;
}

/**
 * 渲染一个组件；每次渲染前重置钩子游标。
 * @param {Function} component - 组件。
 * @param {object} props - 属性。
 * @returns {object | null} 元素树。
 */
function render(component, props) {
  hookIndex = 0;
  return component(props);
}

/** 最小 jsx-runtime 替身：返回可断言的普通对象树。 */
const jsxStub = {
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props }),
  Fragment: reactStub.Fragment,
};

/** 最小 primitives 替身：图标、菜单与官方字段组件都渲染成可查找的标记。 */
const primitivesStub = {
  Menu: function Menu(props) {
    return { type: 'Menu', props };
  },
  // 设置界面的三个基元——官方数字字段、胶囊 Tag、信息图标（requirements §6.1／design §7.2）。
  SettingsValueField: function SettingsValueField(props) {
    return { type: 'SettingsValueField', props };
  },
  Tag: function Tag(props) {
    return { type: 'Tag', props };
  },
  IconInfoOutlineRegular: function IconInfoOutlineRegular(props) {
    return { type: 'IconInfoOutlineRegular', props };
  },
  // 分置醒目提示行的警告图标（design §7.2.0；size=12 与说明按钮同规格）。
  IconWarningOutlineRegular: function IconWarningOutlineRegular(props) {
    return { type: 'IconWarningOutlineRegular', props };
  },
};

/**
 * 求值 client.js 并取回 factory 产物。
 * @returns {object} 模块导出（`apply` / `inject`）。
 */
function loadClient() {
  let definition;
  const sandbox = { __ModuleLoader__: { load: (value) => { definition = value; } } };
  // eslint-disable-next-line no-new-func
  new Function('window', SOURCE)(sandbox);
  return definition.factory((name) => {
    if (name === 'react') return reactStub;
    if (name === 'react/jsx-runtime') return jsxStub;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub;
    throw new Error(`client.js 只能 require 模块表里的包，收到：${name}`);
  });
}

/**
 * 深度优先查找第一个指定 type 的节点。
 * @param {unknown} node - 元素树根。
 * @param {string} type - 目标 type。
 * @returns {object | undefined} 节点。
 */
function findNode(node, type) {
  if (node === null || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findNode(child, type);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (node.type === type) return node;
  return findNode(node.props?.children, type);
}

/**
 * 构造客户端上下文替身。
 * @param {object} [options] - 选项。
 * @returns {object} 上下文与可观测记录。
 */
function makeCtx(options = {}) {
  const registrations = [];
  const injected = [];
  const dictionaries = [];
  const formGets = [];
  const servedWatches = [];
  const writes = [];
  const snapshot = options.snapshot ?? { status: 'ready', value: {}, base: {}, user: {}, revision: 1, writable: true };
  const scope = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    // 0.1.7 ConfigFormController 语义：宿主拒绝时解为 false 而不抛错。
    // options.mutateRejects=true 模拟拒绝（快照不变化——recovery 已把宿主状态回读一致）。
    mutate: async (ops) => {
      if (options.mutateRejects === true) return false;
      for (const op of ops) {
        writes.push(op);
        // 让快照跟着写入变化：组件读的是快照，写入后不更新就看不出「已生效」的效果。
        const keys = Array.isArray(op.path) ? op.path : [op.path];
        let cursor = snapshot.value;
        for (const key of keys.slice(0, -1)) {
          if (typeof cursor[key] !== 'object' || cursor[key] === null) cursor[key] = {};
          cursor = cursor[key];
        }
        if (keys.length > 0) {
          if (op.op === 'unset') delete cursor[keys[keys.length - 1]];
          else cursor[keys[keys.length - 1]] = op.value;
        }
      }
      return true;
    },
  };
  /**
   * 模拟网关调用：载荷是单一 `args` 对象。
   * @param {string} channel - 通道。
   * @param {string} endpoint - 端点。
   * @param {object} payload - 载荷。
   * @returns {Promise<object>} 应答。
   */
  const rpc = async (channel, endpoint, payload) => {
    if (options.call !== undefined) return options.call(endpoint, payload?.args, payload);
    if (options.probeOk === false) throw new Error('no host bridge');
    return { ok: true, value: { state: 'unknown', terminal: true } };
  };
  const ctx = {
    effect: (fn) => {
      fn();
      return () => {};
    },
    locale: {
      register: (ns, dicts) => {
        dictionaries.push({ ns, dicts });
        return () => {};
      },
    },
    slots: {
      inject: (key, callback) => {
        injected.push(key);
        callback();
        return () => {};
      },
      register: (slotOptions, component) => {
        registrations.push({ options: slotOptions, component });
        return () => {};
      },
    },
    connection: {
      rpc: {
        call: (channel, endpoint, payload) => rpc(channel, endpoint, payload),
      },
    },
    // 0.1.7 configForms 服务：get(entryId) 返回控制器；whileServed(namespaces, register)
    // 在任一命名空间被服务时即 register(servedSet) 一次。默认模拟「已服务」立即注册；
    // options.unserved=true 模拟宿主未服务本命名空间（不调 register——卡片不应挂载）。
    configForms: {
      get: (entryId) => {
        formGets.push(entryId);
        return scope;
      },
      whileServed: (namespaces, register) => {
        servedWatches.push([...namespaces]);
        if (options.unserved === true) return () => {};
        const off = register(new Set(namespaces));
        return () => {
          if (typeof off === 'function') off();
        };
      },
    },
    sessions: {
      list: {
        getSnapshot: () => ({ current: options.currentSession ?? '' }),
        subscribe: () => () => {},
      },
    },
  };
  return { ctx, registrations, injected, dictionaries, formGets, servedWatches, scope, writes, rpcCall: (endpoint, args) => rpc('/api', endpoint, { args }) };
}

/** 等一次微任务与探针 promise。 */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * 深度优先收集全部满足谓词的节点。
 * @param {unknown} node - 元素树根。
 * @param {(entry: object) => boolean} predicate - 判定。
 * @returns {object[]} 命中节点。
 */
function findAllNodes(node, predicate) {
  const hits = [];
  const visit = (current) => {
    if (current === null || typeof current !== 'object') return;
    if (Array.isArray(current)) {
      for (const child of current) visit(child);
      return;
    }
    if (predicate(current)) hits.push(current);
    visit(current.props?.children);
  };
  visit(node);
  return hits;
}

/**
 * 按 class 名查找全部节点。
 * @param {unknown} node - 元素树根。
 * @param {string} className - class 名。
 * @returns {object[]} 命中节点。
 */
function findAllByClass(node, className) {
  return findAllNodes(node, (entry) => String(entry.props?.className ?? '').split(' ').includes(className));
}

/**
 * 按 class 名查找第一个节点。
 * @param {unknown} node - 元素树根。
 * @param {string} className - class 名。
 * @returns {object | undefined} 节点。
 */
function findByClass(node, className) {
  return findAllByClass(node, className)[0];
}

/**
 * 把元素树里的文本拼成一段（忽略属性与空节点），用于断言两段触发器的合并文本。
 * @param {unknown} node - 元素树根或子树。
 * @returns {string} 拼接后的文本。
 */
function flatText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flatText).join('');
  if (node.props && node.props.children !== undefined) return flatText(node.props.children);
  return '';
}

/**
 * 渲染设置卡片并展开：折叠头点一次，副作用用 tick 推进。
 * @param {Function} component - 卡片组件。
 * @param {object} props - 属性。
 * @returns {Promise<object>} 展开后的元素树。
 */
async function expandCard(component, props) {
  // 表单恒渲染，无折叠步骤：两次渲染＋tick 维持与时钟相关的副作用节奏。
  render(component, props);
  await tick();
  hookIndex = 0;
  render(component, props);
  await tick();
  await tick();
  hookIndex = 0;
  return render(component, props);
}

test('client.js 只 require 模块表里的包名', () => {
  const client = loadClient();
  assert.deepEqual(client.inject, ["slots", "locale", "connection", "configForms", "sessions"]);
  assert.equal(typeof client.apply, 'function');
});

test('注册四个挂点：设置卡片、composer 下拉、审批卡片状态条（后者抢 seat）、会话视图', async () => {
  const client = loadClient();
  const env = makeCtx();
  client.apply(env.ctx);
  await tick();
  assert.deepEqual(env.dictionaries.map((entry) => entry.ns), ['approve-for-me']);
  const names = env.registrations.map((entry) => entry.options.name);
  assert.deepEqual(names, ['plugins.bundle.config', 'conversation.input.left', 'conversation.approval.detail', 'conversation.view']);
  assert.equal(env.injected.length, 4);
  // 设置表单走 keyed 槽（落点唯一）：键 = 包名；控制器以行 id（不是槽位键）获取，不注册 `plugins.row.config`。
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  assert.equal(card.options.key, 'dsh-approve-for-me');
  assert.deepEqual(env.servedWatches, [['approve-for-me']], 'whileServed 应只看守本命名空间');
  assert.equal(env.injected[0], 'plugins.bundle.config');
  // `conversation.approval.detail` 是 `single`：既有占用者（`ApprovalCommand`）priority 为 0，
  // 只有负数才能成为 `entriesOfSlot[0]`。
  const detail = env.registrations.find((entry) => entry.options.name === 'conversation.approval.detail');
  assert.equal(typeof detail.options.priority, 'number');
  assert.ok(detail.options.priority < 0, `priority 必须是负数，实际 ${detail.options.priority}`);
  // 该 seat 的 owner props 只有 `callId`，标准 props 里要用 `useChat` 自己渲染命令。
  assert.equal(typeof detail.component, 'function');
  // 会话视图（design §8.5）：`list` 座位按 priority 再 order 升序，20 排在 chat(0)/trajectory(10) 之后；
  // label 是 thunk（宿主 resolveSlotLabel 会调用它），注册时机早于字典也会安全退回键名。
  const view = env.registrations.find((entry) => entry.options.name === 'conversation.view');
  assert.equal(view.options.id, 'approve-for-me');
  assert.equal(view.options.order, 20);
  assert.equal(view.options.priority, undefined, 'list 座位不需要抢 seat，不写 priority');
  assert.equal(typeof view.options.label, 'function');
  assert.equal(view.options.label(), 'view.review', 'label 走字典键（无 locale.bind 时退回键名）');
  assert.equal(typeof view.component, 'function');
});

test('中英字典齐备：每个字段都有 help 与 hint 键，覆盖组文案成对', async () => {
  const client = loadClient();
  const env = makeCtx();
  client.apply(env.ctx);
  const dicts = env.dictionaries[0].dicts;
  const keys = Object.keys(dicts.zh).filter((key) => key.startsWith('help.'));
  assert.ok(keys.length >= 15, `help 键太少：${keys.length}`);
  for (const key of keys) {
    assert.equal(typeof dicts.en[key], 'string', `英文缺 ${key}`);
    assert.ok(dicts.en[key].length > 0, `英文 ${key} 为空`);
  }
  // 20 个字段（FIELDS 17 行 + 预设/模型/映射 3 个结构化字段）都必须有常驻说明 `hint.<path>` 与展开帮助 `help.<path>`。
  for (const path of ['trigger.presets', 'trigger.unknown', 'trigger.auditEverySkip', 'reviewer.model', 'reviewer.parentModelRules', 'language.ui', 'language.agent', 'reviewer.timeoutMs', 'reviewer.maxTokens', 'ui.humanCardDuringReview', 'human.timeoutMs', 'human.timeoutFrom', 'mode', 'allowEscalationTo', 'unknownSubject', 'fallback', 'ui.inject', 'ui.injectMaxBytes', 'tools', 'denyPatterns']) {
    assert.ok(dicts.zh[`help.${path}`], `缺中文 help 键 help.${path}`);
    assert.ok(dicts.en[`help.${path}`], `缺英文 help 键 help.${path}`);
    assert.ok(dicts.zh[`hint.${path}`], `缺中文 hint 键 hint.${path}`);
    assert.ok(dicts.en[`hint.${path}`], `缺英文 hint 键 hint.${path}`);
    assert.notEqual(dicts.zh[`hint.${path}`], dicts.zh[`help.${path}`], `hint.${path} 不应照抄 help 全文`);
  }
  // 反向：不该存在 `card.help.*` 这类错前缀键。
  for (const key of Object.keys(dicts.zh)) {
    assert.equal(key.startsWith('card.help.'), false, `前缀写错的 help 键：${key}`);
  }
  // 覆盖组文案（官方词表）：「已单独设置」「恢复默认」与数字非法提示，中英成对。
  for (const key of ['card.override', 'card.resetField', 'card.invalidNumber']) {
    assert.ok(dicts.zh[key], `缺中文 ${key}`);
    assert.ok(dicts.en[key], `缺英文 ${key}`);
  }
  // 退役键零命中（字典侧）——分区标题、全局重置、当前生效值、已保存横幅。
  for (const key of ['card.resetAll', 'card.resolved', 'card.saved', 'card.invalid', 'card.section.trigger', 'card.section.model', 'card.section.advanced']) {
    assert.equal(dicts.zh[key], undefined, `退役键不得存在：${key}`);
    assert.equal(dicts.en[key], undefined, `英文退役键不得存在：${key}`);
  }
});

test('设置卡数据源：configForms 以行 id 取控制器，whileServed 管理挂载生命周期', () => {
  const client = loadClient();
  const env = makeCtx();
  client.apply(env.ctx);
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  // 注入槽是 thunk：渲染器解析条目时才求值，故测试显式调用一次。
  const injectedProps = card.options.inject();
  assert.deepEqual(env.formGets, ['approve-for-me'], '控制器以行 id（命名空间）获取，不是槽位键');
  assert.equal(injectedProps.scope, env.scope, '注入的 scope 是 configForms.get 的返回值');
  assert.equal(typeof injectedProps.rpcCall, 'function');
});

test('宿主未服务命名空间时不挂设置卡（whileServed 管理生命周期），其余挂点不受影响', async () => {
  const client = loadClient();
  const env = makeCtx({ unserved: true });
  client.apply(env.ctx);
  await tick();
  const names = env.registrations.map((entry) => entry.options.name);
  assert.equal(names.includes('plugins.bundle.config'), false, '未服务时不应注册设置表单');
  assert.deepEqual(env.formGets, [], '未服务时不应请求控制器');
  for (const name of ['conversation.input.left', 'conversation.approval.detail', 'conversation.view']) {
    assert.ok(names.includes(name), `其余挂点应在场：${name}`);
  }
});

test('设置表单首屏：字段竖排、覆盖组在场、保存置灰、无退役键', () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    snapshot: {
      status: 'ready',
      value: { fallback: 'ask', reviewer: { model: 'deepseek-official/deepseek-v4-pro' } },
      base: { fallback: 'reject' },
      user: { fallback: 'ask' },
      revision: 2,
      writable: true,
    },
  });
  client.apply(env.ctx);
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const form = render(card.component, { t: (key) => key, scope: env.scope });
  const serialized = JSON.stringify(form);
  // 无折叠：一次渲染即字段与保存控件全在场。
  assert.equal(serialized.includes('dsafm_head'), false, '渲染树无折叠头类 dsafm_head');
  assert.equal(serialized.includes('dsafm_card'), false, '渲染树无折叠外壳类 dsafm_card');
  // 退役键在渲染树里零命中（重置按钮/分区标题/生效值行的防回潮断言）。
  assert.equal(serialized.includes('card.resetAll'), false, '不得出现「重置全部覆盖」');
  assert.equal(serialized.includes('card.section.'), false, '不得出现分区标题');
  assert.equal(serialized.includes('card.resolved'), false, '不得出现「当前生效值」灰字行');
  // 字段竖排：20 个字段各一个 dsafm_field 壳；数字字段的输入仍走官方组件（外套标签行外置的外壳）；
  // 覆盖字段有「已单独设置」＋「恢复默认」。
  const fields = findAllByClass(form, 'dsafm_field');
  assert.equal(fields.length, 20, `字段壳数量应＝20（design §7.2），实际 ${fields.length}`);
  const markers = findAllNodes(form, (node) => node.type === primitivesStub.SettingsValueField);
  assert.equal(markers.length, 4, '数字字段应走官方 SettingsValueField（timeoutMs/maxTokens/human.timeoutMs/injectMaxBytes）');
  const overridden = fields.filter((field) => JSON.stringify(field).includes('card.override'));
  assert.equal(overridden.length, 1, '只有 user 层带键的 fallback 字段显示覆盖组');
  const fallbackField = overridden[0];
  assert.match(JSON.stringify(fallbackField), /card\.resetField/, '覆盖组必须带「恢复默认」');
  const fallbackSelect = findAllByClass(fallbackField, 'dsafm_input').find((node) => node.type === 'select');
  assert.equal(fallbackSelect?.props.value, 'ask', '控件值就是生效值');
  // 保存按钮启用条件（requirements §6.1）：无改动时保存禁用（变异验证：删掉 disabled 条件本断言变红）。
  const save = findByClass(form, 'dsafm_save');
  assert.ok(save, '底部应有唯一保存按钮');
  assert.equal(save.props.disabled, true, '无改动时保存应 disabled');
  assert.equal(findAllByClass(form, 'dsafm_save').length, 1, '只有一个保存按钮');
  assert.match(save.props.children, /card\.save/);
  assert.doesNotMatch(serialized, /card\.readonly/);
});

test('设置页分置提示（§7.2.0）：global 渲染在表单顶部，rule 挂对应映射行附近', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    snapshot: {
      status: 'ready',
      value: {
        reviewer: {
          model: 'zai/gone-1',
          parentModelRules: [{ parent: { provider: null, model: 'glm-5.3' }, choice: { model: 'zai/gone-2', effort: '' } }],
        },
      },
      base: {},
      user: {},
      revision: 1,
      writable: true,
    },
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/modelCatalog') {
        return { ok: true, value: { providers: [{ id: 'zai', models: [{ id: 'glm-5.3' }] }] } };
      }
      if (endpoint === 'approveForMe/modelEfforts') return { ok: true, value: { efforts: [], defaultEffort: '' } };
      if (endpoint === 'approveForMe/getState') {
        // 空会话求值：global 与 rule 条目不依赖会话（design §7.2.0）；session 条目不应在设置页渲染。
        return {
          ok: true,
          value: {
            found: false,
            sessionModel: null,
            sessionEffort: '',
            globalDefault: 'zai/gone-1',
            globalEffort: '',
            modelIssues: [
              { scope: 'global', ruleProvider: null, ruleModel: '', configured: 'zai/gone-1', reason: '模型不在目录', effectiveLayer: 'unavailable', effectiveModel: '' },
              { scope: 'rule', ruleProvider: null, ruleModel: 'glm-5.3', configured: 'zai/gone-2', reason: 'provider 不存在', effectiveLayer: 'global', effectiveModel: 'zai/gone-1' },
              { scope: 'session', ruleProvider: null, ruleModel: '', configured: 'zai/x', reason: 'r', effectiveLayer: 'follow-parent', effectiveModel: '' },
            ],
            effective: 'zai/gone-1',
            effectiveEffort: '',
            layer: 'global',
            preset: 'auto-approve',
            active: true,
            trace: {},
          },
        };
      }
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const dicts = env.dictionaries[0].dicts;
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const props = { t: (key) => dicts.zh[key] ?? key, scope: env.scope, rpcCall: env.rpcCall };
  const tree = await expandCard(card.component, props);
  const warns = findAllByClass(tree, 'dsafm_warnline');
  assert.equal(warns.length, 2, '设置页只消费 global 与 rule 两类条目（session 不在此渲染）');
  // global 在表单顶部：位于第一个字段（接管预设）之前（design §7.2.0 位置表）。
  const form = findByClass(tree, 'dsafm_form');
  const topLevel = form.props.children.filter(Boolean);
  assert.equal(topLevel[0].props.className, 'dsafm_warnline', '表单顶层第一个节点应是 global 提示');
  const globalText = JSON.stringify(topLevel[0]);
  assert.match(globalText, /默认审查模型不可用/, 'global 提示用 warn.modelIssue.global 文案');
  assert.match(globalText, /模型不在目录/, '提示正文包含不可用原因');
  assert.match(globalText, /当前生效：无可用审查模型（unavailable）。/, '不可用键空串时以 warn.modelIssue.layer 层含义独立成句承接（§7.2.0/§8.5.1）');
  assert.doesNotMatch(globalText, /（unavailable）：/, '层含义句后不得拼「层含义：」悬空冒号');
  assert.doesNotMatch(globalText, /实际使用/, 'effectiveModel 为空串时省略「实际使用」句（design §7.2.0）');
  assert.equal(topLevel[1].props.className, 'dsafm_field', '提示之后的顶层节点应是字段（接管预设）');
  // 提示行视觉：官方 IconWarningOutlineRegular（12px）；文字/图标分主题取色（浅色深琥珀、深色 warn-label，design §7.2.0；背景由样式令牌承担）。
  const warnIcons = findAllNodes(topLevel[0], (node) => node.type === primitivesStub.IconWarningOutlineRegular);
  assert.equal(warnIcons.length, 1, '提示行应带一个警告图标');
  assert.equal(warnIcons[0].props.size, 12, '警告图标规格 size=12');
  // rule 提示挂对应映射行附近（按 ruleProvider/ruleModel 配对），生效结果＝「层含义：引用」。
  const mapField = findAllByClass(tree, 'dsafm_field').find((field) => JSON.stringify(field).includes('按执行助手的模型选择审查模型'));
  assert.ok(mapField, '映射字段应在场');
  const ruleWarns = findAllByClass(mapField, 'dsafm_warnline');
  assert.equal(ruleWarns.length, 1, 'rule 提示应恰好一条并挂在映射字段内');
  const ruleText = JSON.stringify(ruleWarns[0]);
  assert.match(ruleText, /provider 不存在/, 'rule 提示包含原因');
  assert.match(ruleText, /全局默认（global）：zai\/gone-1/, '有生效引用时按「层含义：引用」呈现');
  // 有值路径拼接回归锚点：层文案与全角冒号直接相接，整句无空白（窄容器断行不改变文本内容）。
  assert.match(ruleText, /实际使用：全局默认（global）：zai\/gone-1。/, '「实际使用：层含义：引用」整句直连，无空格');
  assert.doesNotMatch(ruleText, /（global）\s+：/, '层文案与全角冒号之间不得夹空白');
  // en 档同型拼接：半角冒号＋后随空格（空格只在冒号后），冒号前无空白。
  const enProps = { t: (key) => dicts.en[key] ?? key, scope: env.scope, ...card.options.inject() };
  render(card.component, enProps);
  await tick();
  hookIndex = 0;
  render(card.component, enProps);
  await tick();
  await tick();
  hookIndex = 0;
  const enTree = render(card.component, enProps);
  const enMapField = findAllByClass(enTree, 'dsafm_field').find((field) => JSON.stringify(field).includes(dicts.en['card.field.parentModelRules']));
  const enRuleWarn = enMapField === undefined ? undefined : findAllByClass(enMapField, 'dsafm_warnline')[0];
  assert.ok(enRuleWarn, 'en 档 rule 提示在场');
  const enRuleText = JSON.stringify(enRuleWarn);
  assert.match(enRuleText, /Currently using: Global default \(global\): zai\/gone-1\./, 'en 档「Currently using: 层含义: 引用」空格只在冒号后');
  assert.doesNotMatch(enRuleText, /\(global\)\s+:/, 'en 档层文案与冒号之间不得夹空白');
});

test('设置页空全局默认提示（§7.2.0）：globalUnset 键渲染在表单顶部，空串省略「实际使用」句', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    snapshot: {
      status: 'ready',
      value: { reviewer: { parentModelRules: [] } },
      base: {},
      user: {},
      revision: 1,
      writable: true,
    },
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/modelCatalog') return { ok: true, value: { providers: [{ id: 'zai', models: [{ id: 'glm-5.3' }] }] } };
      if (endpoint === 'approveForMe/modelEfforts') return { ok: true, value: { efforts: [], defaultEffort: '' } };
      if (endpoint === 'approveForMe/getState') {
        // reviewer.model 为空（零值语义生效）：宿主追加空全局默认条目；设置页无会话求值，effectiveModel 空串。
        return {
          ok: true,
          value: {
            found: false,
            sessionModel: null,
            sessionEffort: '',
            globalDefault: '',
            globalEffort: '',
            modelIssues: [
              { scope: 'global', ruleProvider: null, ruleModel: '', configured: '', reason: '全局默认审查模型未设置', effectiveLayer: 'follow-parent', effectiveModel: '' },
            ],
            effective: '',
            effectiveEffort: '',
            layer: 'follow-parent',
            preset: 'auto-approve',
            active: true,
            trace: {},
          },
        };
      }
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const dicts = env.dictionaries[0].dicts;
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const props = { t: (key) => dicts.zh[key] ?? key, scope: env.scope, rpcCall: env.rpcCall };
  const tree = await expandCard(card.component, props);
  const warns = findAllByClass(tree, 'dsafm_warnline');
  assert.equal(warns.length, 1, '空全局默认条目应渲染一条顶部提示');
  const form = findByClass(tree, 'dsafm_form');
  const topLevel = form.props.children.filter(Boolean);
  assert.equal(topLevel[0].props.className, 'dsafm_warnline', '空默认提示与不可用提示同位：表单顶部、第一个字段之前');
  const text = JSON.stringify(topLevel[0]);
  assert.match(text, /默认审查模型未设置/, '用 warn.modelIssue.globalUnset 文案（按 configured 空串选键）');
  assert.match(text, /独立发起审查调用/, '文案说明独立发起审查调用');
  assert.match(text, /「使用相同模型」，不是由执行助手自己审批/, '文案区分「使用相同模型」与自审');
  assert.doesNotMatch(text, /不可用|故障/, '状态语义：空默认提示不含「不可用」「故障」措辞（design §7.2.0）');
  assert.doesNotMatch(text, /实际使用/, 'effectiveModel 为空串时省略「实际使用」句');
  assert.doesNotMatch(text, /全局默认未设置，使用执行助手当前模型（follow-parent）/u, '空默认键不补层含义句——首句已承载层含义（design §7.2.0）');
  assert.equal(findAllNodes(topLevel[0], (node) => node.type === primitivesStub.IconWarningOutlineRegular).length, 1, '沿用同款警告图标');
});

test('设置页空全局默认提示（§7.2.0）：旧宿主无 modelIssues 字段时不渲染提示', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    snapshot: {
      status: 'ready',
      value: { reviewer: {} },
      base: {},
      user: {},
      revision: 1,
      writable: true,
    },
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/modelCatalog') return { ok: true, value: { providers: [] } };
      if (endpoint === 'approveForMe/getState') {
        // 旧宿主：状态里没有 modelIssues 字段——不渲染任何提示，不影响表单本身。
        return { ok: true, value: { found: false, sessionModel: null, globalDefault: '', effective: '', layer: 'follow-parent' } };
      }
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const props = { t: (key) => key, scope: env.scope, rpcCall: env.rpcCall };
  const tree = await expandCard(card.component, props);
  assert.equal(findAllByClass(tree, 'dsafm_warnline').length, 0, '旧宿主无字段时不应渲染提示行');
  assert.equal(findAllByClass(tree, 'dsafm_field').length, 20, '表单本体不受影响（20 字段）');
});

test('说明入口（§10.2）：20 个字段全覆盖，图标＋可见文字，aria 成对，键盘 Enter/Space 可达', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx();
  client.apply(env.ctx);
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const props = { t: (key) => key, scope: env.scope };
  const first = render(card.component, props);
  // 20 字段全覆盖：全部经字段外壳标签行的说明入口（design §7.2.1）。
  const buttons = findAllByClass(first, 'dsafm_helpbtn');
  assert.equal(buttons.length, 20, `说明按钮应 20 个（全部经字段外壳标签行），实际 ${buttons.length}`);
  // 按钮挂在标签行的 dsafm_labelgroup 内（与标签同组，数字字段不平铺在字段下方）。
  const groupedButtons = findAllByClass(first, 'dsafm_labelgroup').reduce(
    (sum, group) => sum + findAllByClass(group, 'dsafm_helpbtn').length,
    0,
  );
  assert.equal(groupedButtons, buttons.length, `说明按钮应全部位于 dsafm_labelgroup 内，实际 ${groupedButtons}/${buttons.length}`);
  const iconNodes = findAllNodes(first, (node) => node.type === primitivesStub.IconInfoOutlineRegular);
  assert.equal(iconNodes.length, 20, '说明按钮图标统一用官方 IconInfoOutlineRegular（size=12）');
  assert.equal(JSON.stringify(first).includes('Tooltip'), false, '设置界面不用 Tooltip');
  for (const button of buttons) {
    assert.equal(button.props['aria-expanded'], false, '初始未展开');
    assert.ok(button.props['aria-controls'], '说明按钮必须带 aria-controls');
    assert.ok(button.props['aria-label'], '说明按钮必须带 aria-label（无障碍名含字段名与状态）');
    assert.equal(typeof button.props.onKeyDown, 'function', '键盘路径必须可达（Enter/Space，design §7.2.1）');
    // 可见文字与图标同置按钮内（help.expand/collapse），非纯图标按钮。
    const textSpan = (button.props.children ?? []).find((child) => child?.props?.className === 'dsafm_helpbtn_text');
    assert.ok(textSpan, '说明按钮必须带可见文字 span');
    assert.match(String(textSpan.props.children), /^help\.(expand|collapse)$/);
  }
  // 无障碍名格式「字段名：说明」：字段名与文案间的分隔符由文案语言决定（CJK 全角冒号／半角冒号加空格）。
  const modeButton = buttons.find((button) => button.props['aria-controls'] === 'approve-for-me-help-mode');
  assert.ok(modeButton, 'mode 字段的说明按钮应在场');
  assert.match(modeButton.props['aria-label'], /^field\.mode[:：]\s*help\.expand$/);
  // 点击展开：aria-expanded=true，展开区 role=region 且无障碍名与按钮一致，文本进入 DOM。
  modeButton.props.onClick();
  hookIndex = 0;
  const open = render(card.component, props);
  const openButtons = findAllByClass(open, 'dsafm_helpbtn');
  const reopened = openButtons.find((button) => button.props['aria-controls'] === 'approve-for-me-help-mode');
  assert.equal(reopened.props['aria-expanded'], true, '点击后应 aria-expanded=true');
  assert.match(reopened.props['aria-label'], /^field\.mode[:：]\s*help\.collapse$/);
  assert.match(String((reopened.props.children ?? []).find((child) => child?.props?.className === 'dsafm_helpbtn_text').props.children), /^help\.collapse$/);
  const regions = findAllByClass(open, 'dsafm_helpregion');
  assert.equal(regions.length, 1, '只展开被点击的字段');
  assert.equal(regions[0].props.id, 'approve-for-me-help-mode');
  assert.equal(regions[0].props.role, 'region');
  assert.match(String(regions[0].props['aria-label']), /^field\.mode[:：]\s*help\.collapse$/);
  assert.match(JSON.stringify(regions[0].props.children), /help\.mode/, '说明文本应进入 DOM');
  // 键盘路径与点击等价：Space 键 preventDefault 后同一开合动作（不触发滚动/双击）。
  reopened.props.onKeyDown({ key: ' ', preventDefault: () => {} });
  hookIndex = 0;
  const closed = render(card.component, props);
  assert.equal(findAllByClass(closed, 'dsafm_helpregion').length, 0, 'Space 应收起展开区');
  const closedButton = findAllByClass(closed, 'dsafm_helpbtn').find((button) => button.props['aria-controls'] === 'approve-for-me-help-mode');
  closedButton.props.onKeyDown({ key: 'Enter', preventDefault: () => {} });
  hookIndex = 0;
  assert.equal(findAllByClass(render(card.component, props), 'dsafm_helpregion').length, 1, 'Enter 应再次展开');
});

test('说明入口（§10.2）：开合不改动草稿、保存计划与常驻提示（纯展示状态）', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    snapshot: {
      status: 'ready',
      value: { fallback: 'ask', reviewer: { timeoutMs: 0 } },
      base: { fallback: 'reject', reviewer: { timeoutMs: 60000 } },
      user: { fallback: 'ask' },
      revision: 2,
      writable: true,
    },
  });
  client.apply(env.ctx);
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const props = { t: (key) => key, scope: env.scope };
  const first = render(card.component, props);
  const saveBefore = findByClass(first, 'dsafm_save').props.disabled;
  // 退役键零残留：warn.noLimit 属退役渲染分支的键，任何状态下都不得出现。
  assert.equal(findAllByClass(first, 'dsafm_sec_warn').length, 0, 'timeoutMs=0 无常驻风险提醒（退役分支）');
  const marker = 'approve-for-me-help-mode';
  const buttonBefore = findAllByClass(first, 'dsafm_helpbtn').find((node) => node.props['aria-controls'] === marker);
  // 连续开合数次（不同字段、含数字字段标签旁说明按钮）。
  buttonBefore.props.onClick();
  hookIndex = 0;
  const mid = render(card.component, props);
  const humanButton = findAllByClass(mid, 'dsafm_helpbtn').find((node) => node.props['aria-controls'] === 'approve-for-me-help-human-timeoutMs');
  assert.ok(humanButton, '数字字段的标签旁说明按钮应在场');
  humanButton.props.onClick();
  hookIndex = 0;
  const mid2 = render(card.component, props);
  const again = findAllByClass(mid2, 'dsafm_helpbtn').find((node) => node.props['aria-controls'] === marker);
  again.props.onClick();
  hookIndex = 0;
  const after = render(card.component, props);
  // 保存按钮启停状态不变（无暂存变更）、无残留展开区、快照零写入；常驻提醒不被开合挤掉。
  assert.equal(findByClass(after, 'dsafm_save').props.disabled, saveBefore, '开合说明不得触碰保存计划');
  assert.equal(env.writes.length, 0, '开合说明不得写库');
  assert.equal(findAllByClass(after, 'dsafm_helpregion').length, 1, '其他字段的展开区保持不动');
  assert.equal(findAllByClass(after, 'dsafm_sec_warn').length, 0, '开合说明不得带出退役提醒');
});

test('非 loopback（不可写）时卡片显示只读提示', () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({ snapshot: { status: 'ready', value: {}, base: {}, user: {}, revision: 1, writable: false } });
  client.apply(env.ctx);
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const expanded = render(card.component, { t: (key) => key, scope: env.scope });
  assert.match(JSON.stringify(expanded), /card\.readonly/);
});

test('composer 下拉：缺会话 id 不渲染，有 id 且 RPC 可用时渲染 Menu', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/getState') {
        return { ok: true, value: { found: true,
            active: true,
            preset: 'auto-approve', sessionModel: null, globalDefault: 'zai/glm-5.3', byParentModel: {}, effective: 'zai/glm-5.3', layer: 'global' } };
      }
      if (endpoint === 'approveForMe/modelCatalog') {
        return { ok: true, value: { providers: [{ id: 'zai', models: [{ id: 'glm-5.3' }] }] } };
      }
      return { ok: false, error: 'unknown endpoint' };
    },
  });
  client.apply(env.ctx);
  const dropdown = env.registrations.find((entry) => entry.options.name === 'conversation.input.left');
  assert.equal(render(dropdown.component, { t: (key) => key, sessionIdOf: () => '' }), null);

  const props = { t: (key) => key, ...dropdown.options.inject() };
  assert.equal(props.sessionIdOf(), '', '未选中会话时应当读不到 id');
  render(dropdown.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const tree = render(dropdown.component, props);
  assert.ok(findNode(tree, primitivesStub.Menu) === undefined, '无会话时不渲染菜单');
});

test('composer 下拉：有当前会话时渲染 Menu 并可清除本会话选择', async () => {
  resetHooks();
  const client = loadClient();
  const calls = [];
  const env = makeCtx({
    currentSession: 's1',
    call: async (endpoint, args) => {
      calls.push([endpoint, args]);
      if (endpoint === 'approveForMe/getState') {
        return { ok: true, value: { found: true, active: true, preset: 'auto-approve', sessionModel: null, globalDefault: 'zai/glm-5.3', byParentModel: {}, effective: 'zai/glm-5.3', layer: 'global' } };
      }
      if (endpoint === 'approveForMe/modelCatalog') {
        return { ok: true, value: { providers: [{ id: 'zai', models: [{ id: 'glm-5.3' }] }] } };
      }
      return { ok: true, value: { ok: true } };
    },
  });
  client.apply(env.ctx);
  const dropdown = env.registrations.find((entry) => entry.options.name === 'conversation.input.left');
  const props = { t: (key) => key, ...dropdown.options.inject() };
  assert.equal(props.sessionIdOf(), 's1');
  render(dropdown.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const tree = render(dropdown.component, props);
  const menu = findNode(tree, primitivesStub.Menu);
  assert.ok(menu, '未渲染 Menu');
  assert.equal(menu.props.items[0].id, '__follow_global__');
  assert.ok(JSON.stringify(menu.props.anchor).includes('zai/glm-5.3'), '触发按钮未显示生效值');

  menu.props.onSelect('__follow_global__');
  await tick();
  assert.ok(
    calls.some(([endpoint, args]) => endpoint === 'approveForMe/setSessionModel' && args.model === null),
    '清除选择应当写 model=null',
  );
});

test('设置表单不自带标题块：插件名与描述由宿主详情页渲染', () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx();
  client.apply(env.ctx);
  const dicts = env.dictionaries[0].dicts;
  // 标题/描述键属退役折叠头分支：中英两侧都不得出现（退役名即幻觉源）。
  assert.equal('card.title' in dicts.zh, false);
  assert.equal('card.title' in dicts.en, false);
  assert.equal('card.description' in dicts.zh, false);
  assert.equal('card.description' in dicts.en, false);
  assert.equal('card.summary.presets' in dicts.zh, false);
  assert.equal('card.summary.presets' in dicts.en, false);

  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const tree = render(card.component, { t: (key) => key, scope: env.scope, rpcCall: env.rpcCall });
  const flat = JSON.stringify(tree);
  assert.equal(flat.includes('dsafm_head_meta'), false, '渲染树无折叠头元信息块');
  assert.equal(flat.includes('dsafm_title'), false, '渲染树无卡片自带标题');
  assert.equal(flat.includes('dsafm_desc'), false, '渲染树无卡片自带描述');
});

test('默认审查模型行：模型与推理强度两个下拉，换模型只暂存、保存才写 scope', async () => {
  resetHooks();
  const client = loadClient();
  const calls = [];
  const env = makeCtx({
    snapshot: {
      status: 'ready',
      value: { reviewer: { model: { model: 'zai/glm-5.3', effort: 'low' } } },
      base: {},
      user: {},
      revision: 1,
      writable: true,
    },
    call: async (endpoint, args) => {
      calls.push([endpoint, args]);
      if (endpoint === 'approveForMe/modelCatalog') {
        return { ok: true, value: { providers: [{ id: 'zai', models: [{ id: 'glm-5.3' }, { id: 'glm-4.6' }] }] } };
      }
      if (endpoint === 'approveForMe/modelEfforts') {
        return { ok: true, value: { efforts: args.model === 'glm-4.6' ? [{ id: 'high' }] : [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low' } };
      }
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const props = { t: (key) => key, scope: env.scope, rpcCall: env.rpcCall };
  const tree = await expandCard(card.component, props);

  const modelSelect = findByClass(tree, 'dsafm_model');
  assert.ok(modelSelect, '未渲染模型下拉');
  assert.equal(modelSelect.props.value, 'zai/glm-5.3');
  const effortSelect = findByClass(tree, 'dsafm_effort');
  assert.ok(effortSelect, '未渲染推理强度下拉');
  assert.deepEqual(effortSelect.props.children.map((option) => option.props.value), ['', 'low', 'high']);
  assert.equal(effortSelect.props.children[0].props.children, 'effort.default', '首项应当是自动选择');
  assert.ok(
    calls.some(([endpoint, args]) => endpoint === 'approveForMe/modelEfforts' && args.model === 'glm-5.3'),
    '未按当前模型请求档位',
  );
  // 无改动时保存置灰（启用条件见首屏用例）。
  assert.equal(findByClass(tree, 'dsafm_save').props.disabled, true, '无改动时保存应 disabled');

  // 换到只支持 high 的模型：原档位 low 不受支持，暂存清空档位，但尚未写库。
  modelSelect.props.onChange({ target: { value: 'zai/glm-4.6' } });
  await tick();
  await tick();
  hookIndex = 0;
  const next = render(card.component, props);
  assert.ok(
    calls.some(([endpoint, args]) => endpoint === 'approveForMe/modelEfforts' && args.model === 'glm-4.6'),
    '换模型后未请求新模型的档位',
  );
  assert.equal(findByClass(next, 'dsafm_model').props.value, 'zai/glm-4.6', '暂存值应立即显示在控件里');
  assert.equal(env.writes.length, 0, '选择即暂存，不应写库');
  const save = findByClass(next, 'dsafm_save');
  assert.equal(save.props.disabled, false, '有改动后保存应可点');
  save.props.onClick();
  await tick();
  const written = env.writes.filter((op) => op.path.join('.') === 'reviewer.model').map((op) => op.value);
  assert.deepEqual(written[written.length - 1], { model: 'zai/glm-4.6', effort: '' }, '保存应一次写入模型选择');
});

test('映射表（design §7.2）：旧字典纯 id 键呈现为「任意 provider」行，回显纯 id；增删行只暂存', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    snapshot: {
      status: 'ready',
      value: { reviewer: { byParentModel: { 'deepseek-chat': { model: 'zai/glm-5.3', effort: 'low' } } } },
      base: {},
      user: {},
      revision: 1,
      writable: true,
    },
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/modelCatalog') {
        return { ok: true, value: { providers: [{ id: 'deepseek', models: [{ id: 'deepseek-chat' }] }, { id: 'zai', models: [{ id: 'glm-5.3' }] }] } };
      }
      if (endpoint === 'approveForMe/modelEfforts') return { ok: true, value: { efforts: [{ id: 'low' }], defaultEffort: 'low' } };
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const props = { t: (key) => key, scope: env.scope, rpcCall: env.rpcCall };
  const tree = await expandCard(card.component, props);
  assert.equal(findAllByClass(tree, 'dsafm_map_row').length, 1, '应当渲染一行映射');

  // 字段壳：标签行（labelgroup）＋全宽表（map 容器即控件本体，id 挂在容器上）。
  assert.ok(findByClass(tree, 'dsafm_map'), '映射表缺自己的容器');
  assert.equal(findByClass(tree, 'dsafm_map').props.id, 'approve-for-me-ctl-reviewer-parentModelRules', '控件 id 应挂在表容器上');
  assert.ok(findAllByClass(tree, 'dsafm_f_label').some((node) => node.props.children === 'card.field.parentModelRules'), '字段应有标签行');
  const head = findByClass(tree, 'dsafm_map_head');
  assert.ok(head, '缺表头行');
  assert.deepEqual(
    head.props.children.map((cell) => cell.props.children),
    ['card.map.col.scope', 'card.map.col.parent', 'card.map.col.reviewer', 'card.map.col.effort', 'card.map.col.action'],
    '五列表头（design §7.2）',
  );
  const mapRow = findAllByClass(tree, 'dsafm_map_row')[0];
  // 旧字典纯 id 键＝「任意 provider＋该 id」的规则行：作用范围回显纯 id，不猜目录首 provider（design §10.2）。
  const scopeSelect = findByClass(mapRow, 'dsafm_map_scope_mode');
  assert.equal(scopeSelect.props.value, 'any', '纯 id 旧键的作用范围应是任意 provider');
  assert.equal(findByClass(mapRow, 'dsafm_map_parent').props.value, 'deepseek-chat', '任意 provider 行的回显应是纯模型 id');
  assert.equal(findByClass(mapRow, 'dsafm_map_parent').props.title, 'deepseek-chat', '执行助手模型下拉的 title 应当是纯 id');
  assert.equal(findByClass(mapRow, 'dsafm_model').props.title, 'zai/glm-5.3', '审查模型下拉的 title 应当是当前值');
  assert.equal(findByClass(mapRow, 'dsafm_effort').props.title, 'low', '档位下拉的 title 应当是当前档位');
  assert.match(String(findByClass(mapRow, 'dsafm_map_del').props.className), /dsafm_button/, '删除按钮沿用 dsafm_button');
  assert.match(String(findByClass(tree, 'dsafm_map_add').props.className), /dsafm_button/, '添加一行沿用 dsafm_button');
  // 层叠顺序约束：.dsafm_map_add 的边框/底色/内边距规则必须排在 .dsafm_button 之后，
  // 同为单类选择器时靠后者胜出——排在前面会被 .dsafm_button 的 border:none/background:none/padding:0
  // 覆盖回纯文本形态。
  {
    const cssAt = SOURCE.indexOf('const CSS = [');
    const cssEnd = SOURCE.indexOf('].join("")', cssAt);
    const rules = new Function(`return ${SOURCE.slice(cssAt + 'const CSS = '.length, cssEnd + 1)}`)().join('\n');
    const addButton = rules.indexOf('.dsafm_button{');
    const addMap = rules.indexOf('.dsafm_map_add{');
    assert.ok(addButton !== -1 && addMap !== -1, '两条规则都应在 CSS 串中');
    assert.ok(addMap > addButton, '空态按钮规则必须排在 .dsafm_button 之后（层叠顺序）');
    assert.match(rules.slice(addMap, addMap + 200), /border:\.5px solid/, '空态按钮应带边框形态');
  }
  // 任意 provider 列的选项按纯 id 去重并附 provider 信息（design §7.2）。
  const optionTexts = findByClass(mapRow, 'dsafm_map_parent').props.children.filter(Boolean).map((option) => option.props.children);
  assert.ok(optionTexts.some((text) => String(text).startsWith('deepseek-chat (deepseek)')), `选项应附 provider 信息，实际 ${JSON.stringify(optionTexts)}`);

  // 增删行都只是暂存：操作后行数变化、写计数不变。
  findByClass(tree, 'dsafm_map_add').props.onClick();
  hookIndex = 0;
  const added = render(card.component, props);
  assert.equal(findAllByClass(added, 'dsafm_map_row').length, 2, '添加一行后应当有两行');
  assert.equal(env.writes.length, 0, '添加行不应写库');

  findAllByClass(added, 'dsafm_map_del')[1].props.onClick();
  await tick();
  hookIndex = 0;
  const removed = render(card.component, props);
  assert.equal(findAllByClass(removed, 'dsafm_map_row').length, 1, '删除后应当回到一行');
  // 添加又删除＝回到与快照同值：保存计划应跳过同值条目，保存仍置灰。
  assert.equal(findByClass(removed, 'dsafm_save').props.disabled, true, '回到原值后应视为无改动');

  // 删掉现存行再保存：旧字典只减不增（design §7.2）——写入空字典；规则清单与种子同值不写该路径。
  findAllByClass(removed, 'dsafm_map_del')[0].props.onClick();
  hookIndex = 0;
  const emptied = render(card.component, props);
  const save = findByClass(emptied, 'dsafm_save');
  assert.equal(save.props.disabled, false, '删掉现存行是有效改动');
  save.props.onClick();
  await tick();
  const mapped = env.writes.filter((op) => op.path.join('.') === 'reviewer.byParentModel');
  assert.ok(mapped.length >= 1, '未写入旧字典路径');
  assert.deepEqual(mapped[mapped.length - 1].value, {}, '删除全部行应写入空字典');
  assert.equal(env.writes.some((op) => op.path.join('.') === 'reviewer.parentModelRules'), false, '规则清单与种子同值（[]）不应写入');
});

test('接管工具名单：label 走字典键 field.tools，help.tools 中英同步（requirements §5.4）', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx();
  client.apply(env.ctx);
  const dicts = env.dictionaries[0].dicts;
  assert.equal(dicts.zh['help.tools'], '纳入自动审批的工具名单，每行一个工具名。空清单覆盖所有工具的升权审批；填写后只处理名单内工具的升权请求，其余工具保持宿主原流程。');
  assert.match(dicts.en['help.tools'], /Tools under auto-approval, one name per line/u);
  // 字段标签进字典：zh 保留现名，en 有对译；两语言必须同键同在。
  assert.equal(dicts.zh['field.tools'], '纳入自动审批的工具');
  assert.equal(dicts.en['field.tools'], 'Tools under auto-approval');

  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const tree = await expandCard(card.component, { t: (key) => key, scope: env.scope, rpcCall: env.rpcCall });
  const serialized = JSON.stringify(tree);
  assert.match(serialized, /field\.tools/, '无 locale.bind 时行标签渲染字典键（与 help 键同口径）');
  assert.doesNotMatch(serialized, /工具白名单/);
  assert.doesNotMatch(serialized, /纳入自动审批的工具/, '标签文本不得硬编码在渲染树里');
  // 用真字典取词渲染时，标签是 zh 现名（行为差异断言，不是存在性）。
  const treeZh = await expandCard(card.component, { t: (key) => dicts.zh[key] ?? key, scope: env.scope, rpcCall: env.rpcCall });
  assert.match(JSON.stringify(treeZh), /纳入自动审批的工具/);
});

test('用户文案三档：auto 沿用宿主绑定，zh/en 直查字典且互不相同，非法值回落 auto', async () => {
  resetHooks();
  const client = loadClient();
  const base = { status: 'ready', value: {}, base: {}, user: {}, revision: 1, writable: true };
  const make = (ui) => {
    const env = makeCtx({ snapshot: { ...base, value: ui === undefined ? {} : { language: { ui } } } });
    client.apply(env.ctx);
    const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
    return { t: card.options.inject().useNsT((key) => `host:${key}`), env };
  };

  // auto（缺省）：宿主绑定原样透传——强制机制没有劫持 auto 档。
  const auto = make(undefined);
  assert.equal(auto.t('field.tools'), 'host:field.tools');

  // zh 强制：直查 zh 字典；en 强制：同一键给英文（两档互不相同＝行为差异，不是存在性）。
  const zh = make('zh');
  const en = make('en');
  assert.equal(zh.t('field.tools'), '纳入自动审批的工具');
  assert.equal(en.t('field.tools'), 'Tools under auto-approval');
  assert.notEqual(zh.t('field.tools'), en.t('field.tools'));
  assert.equal(zh.t('card.save'), '保存');
  assert.equal(en.t('card.save'), 'Save');

  // 非法档位回落 auto（不抛、不落另一语言）。
  const bad = make('fr');
  assert.equal(bad.t('field.tools'), 'host:field.tools');

  // 强制档缺键抛错：不静默回退、不落键名。
  assert.throws(() => zh.t('no.such.key'), /missing "no\.such\.key" in "zh"/u);
  assert.throws(() => en.t('no.such.key'), /missing "no\.such\.key" in "en"/u);
});

test('composer 下拉：两段式菜单，档位项来自 modelEfforts', async () => {
  resetHooks();
  const client = loadClient();
  const calls = [];
  const env = makeCtx({
    currentSession: 's1',
    call: async (endpoint, args) => {
      calls.push([endpoint, args]);
      if (endpoint === 'approveForMe/getState') {
        return {
          ok: true,
          value: {
            found: true,
            active: true,
            preset: 'auto-approve',
            sessionModel: null,
            sessionEffort: '',
            globalDefault: 'zai/glm-5.3',
            globalEffort: 'low',
            byParentModel: {},
            effective: 'zai/glm-5.3',
            effectiveEffort: 'low',
            layer: 'global',
          },
        };
      }
      if (endpoint === 'approveForMe/modelCatalog') {
        return { ok: true, value: { providers: [{ id: 'zai', models: [{ id: 'glm-5.3' }] }] } };
      }
      if (endpoint === 'approveForMe/modelEfforts') {
        return { ok: true, value: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low' } };
      }
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const dicts = env.dictionaries[0].dicts;
  const dropdown = env.registrations.find((entry) => entry.options.name === 'conversation.input.left');
  const props = { t: (key) => dicts.zh[key] ?? key, ...dropdown.options.inject() };
  // 两轮：先等 getState 到货，再等档位表到货。
  render(dropdown.component, props);
  await tick();
  render(dropdown.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const tree = render(dropdown.component, props);
  const menu = findNode(tree, primitivesStub.Menu);
  assert.ok(menu, '未渲染 Menu');
  const ids = menu.props.items.filter((item) => typeof item.id === 'string').map((item) => item.id);
  assert.ok(ids.includes('__effort__'), '缺「自动选择」推理强度项');
  assert.ok(ids.includes('__effort__:low') && ids.includes('__effort__:high'), '缺模型支持的档位项');
  // 触发器为两段结构（design §7.3.2）：两段文本直接相连与单段写法逐字相同；档位段不参与省略。
  const anchor = menu.props.anchor;
  assert.equal(flatText(anchor), '审查模型：zai/glm-5.3 · low', '两段相连应等于单段写法');
  const modelSpan = findByClass(anchor, 'dsafm_seat_model');
  const effortSpan = findByClass(anchor, 'dsafm_seat_effort');
  assert.ok(modelSpan, '缺模型段');
  assert.ok(effortSpan, '缺档位段');
  assert.equal(flatText(modelSpan), '审查模型：zai/glm-5.3');
  assert.equal(flatText(effortSpan), ' · low');
  assert.match(String(anchor.props['aria-label']), /^审查模型：zai\/glm-5\.3 · low；/, '无障碍名应含完整当前选择与中文分隔符');

  menu.props.onSelect('__effort__:high');
  await tick();
  const written = calls.find(([endpoint]) => endpoint === 'approveForMe/setSessionModel');
  assert.deepEqual(written[1], { sessionId: 's1', model: 'zai/glm-5.3', effort: 'high' });
});

test('composer 下拉：没有生效模型时档位段不出现', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    currentSession: 's1',
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/getState') {
        return {
          ok: true,
          value: {
            found: true,
            active: true,
            preset: 'auto-approve',
            sessionModel: null,
            sessionEffort: '',
            globalDefault: '',
            globalEffort: '',
            byParentModel: {},
            effective: '',
            effectiveEffort: '',
            layer: 'unavailable',
          },
        };
      }
      if (endpoint === 'approveForMe/modelCatalog') {
        return { ok: true, value: { providers: [{ id: 'zai', models: [{ id: 'glm-5.3' }] }] } };
      }
      return { ok: true, value: { efforts: [{ id: 'low' }] } };
    },
  });
  client.apply(env.ctx);
  const dicts = env.dictionaries[0].dicts;
  const dropdown = env.registrations.find((entry) => entry.options.name === 'conversation.input.left');
  const props = { t: (key) => dicts.zh[key] ?? key, ...dropdown.options.inject() };
  render(dropdown.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const tree = render(dropdown.component, props);
  const menu = findNode(tree, primitivesStub.Menu);
  const ids = menu.props.items.filter((item) => typeof item.id === 'string').map((item) => item.id);
  assert.equal(ids.includes('__effort__'), false, '无模型时不应出现档位段');
  // 无生效模型的形态（design §7.3.2）：只有模型段一段，文本为跟随全局；无障碍名以该文本开头。
  assert.equal(flatText(menu.props.anchor), '跟随全局', '未配置时触发器应当显示跟随全局');
  assert.equal(findByClass(menu.props.anchor, 'dsafm_seat_model') !== undefined, true, '无模型时仍有模型段');
  assert.equal(findByClass(menu.props.anchor, 'dsafm_seat_effort'), undefined, '无生效模型时不渲染档位段');
  assert.match(String(menu.props.anchor.props['aria-label']), /^跟随全局；/, '无模型时无障碍名以跟随全局与中文分隔符开头');
});

test('composer 下拉：未指定档位显示自动选择；英文界面用半角分隔符（design §7.3.2）', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    currentSession: 's1',
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/getState') {
        return {
          ok: true,
          value: { found: true, active: true, preset: 'auto-approve', sessionModel: null, sessionEffort: '', globalDefault: 'zai/glm-5.3', globalEffort: '', byParentModel: {}, effective: 'zai/glm-5.3', effectiveEffort: '', layer: 'global' },
        };
      }
      if (endpoint === 'approveForMe/modelCatalog') return { ok: true, value: { providers: [{ id: 'zai', models: [{ id: 'glm-5.3' }] }] } };
      if (endpoint === 'approveForMe/modelEfforts') return { ok: true, value: { efforts: [{ id: 'low' }], defaultEffort: 'low' } };
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const dicts = env.dictionaries[0].dicts;
  const dropdown = env.registrations.find((entry) => entry.options.name === 'conversation.input.left');
  const props = { t: (key) => dicts.en[key] ?? key, ...dropdown.options.inject() };
  render(dropdown.component, props);
  await tick();
  render(dropdown.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const tree = render(dropdown.component, props);
  const menu = findNode(tree, primitivesStub.Menu);
  const anchor = menu.props.anchor;
  assert.equal(flatText(anchor), 'Reviewer model：zai/glm-5.3 · Automatic', '未指定档位显示自动选择的英文定稿');
  assert.equal(flatText(findByClass(anchor, 'dsafm_seat_effort')), ' · Automatic');
  assert.match(String(anchor.props['aria-label']), /^Reviewer model：zai\/glm-5\.3 · Automatic; /, '英文界面无障碍名用半角分号加空格');
  assert.ok(!String(anchor.props['aria-label']).includes('；'), '英文界面无障碍名不得出现中文分隔符');
});

test('composer 下拉：宿主不提供档位时不渲染档位段（design §7.3.2）', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    currentSession: 's1',
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/getState') {
        // effectiveEffort 缺失（旧宿主或求值失败）：档位不可知，不补造取值。
        return {
          ok: true,
          value: { found: true, active: true, preset: 'auto-approve', sessionModel: null, sessionEffort: '', globalDefault: 'zai/glm-5.3', byParentModel: {}, effective: 'zai/glm-5.3', layer: 'global' },
        };
      }
      if (endpoint === 'approveForMe/modelCatalog') return { ok: true, value: { providers: [{ id: 'zai', models: [{ id: 'glm-5.3' }] }] } };
      if (endpoint === 'approveForMe/modelEfforts') return { ok: true, value: { efforts: [{ id: 'low' }], defaultEffort: 'low' } };
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const dicts = env.dictionaries[0].dicts;
  const dropdown = env.registrations.find((entry) => entry.options.name === 'conversation.input.left');
  const props = { t: (key) => dicts.zh[key] ?? key, ...dropdown.options.inject() };
  render(dropdown.component, props);
  await tick();
  render(dropdown.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const tree = render(dropdown.component, props);
  const menu = findNode(tree, primitivesStub.Menu);
  const anchor = menu.props.anchor;
  assert.equal(flatText(anchor), '审查模型：zai/glm-5.3', '档位不可知时只显示模型段');
  assert.equal(findByClass(anchor, 'dsafm_seat_effort'), undefined, '档位不可知时不渲染档位段');
  assert.match(String(anchor.props['aria-label']), /^审查模型：zai\/glm-5\.3；/, '无障碍名只含模型段与分隔符');
});

test('composer 下拉：宿主里没有该会话时仍可写（会话开始前即可设置，requirements §6.2）', async () => {
  resetHooks();
  const client = loadClient();
  const calls = [];
  const env = makeCtx({
    currentSession: 's1',
    call: async (endpoint, args) => {
      calls.push([endpoint, args]);
      if (endpoint === 'approveForMe/getState') {
        return {
          ok: true,
          value: {
            found: false,
            active: true,
            preset: 'auto-approve',
            sessionModel: null,
            sessionEffort: '',
            globalDefault: 'zai/glm-5.3',
            globalEffort: 'low',
            byParentModel: {},
            effective: 'zai/glm-5.3',
            effectiveEffort: 'low',
            layer: 'unavailable',
          },
        };
      }
      if (endpoint === 'approveForMe/modelCatalog') {
        return { ok: true, value: { providers: [{ id: 'zai', models: [{ id: 'glm-5.3' }] }] } };
      }
      return { ok: true, value: { efforts: [{ id: 'low' }] } };
    },
  });
  client.apply(env.ctx);
  const dropdown = env.registrations.find((entry) => entry.options.name === 'conversation.input.left');
  const props = { t: (key) => key, ...dropdown.options.inject() };
  render(dropdown.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const tree = render(dropdown.component, props);
  const menu = findNode(tree, primitivesStub.Menu);
  const seat = menu.props.anchor;
  assert.equal(seat.props.disabled, false, '会话未激活不得禁用控件');
  assert.equal(seat.props.title, 'composer.pendingSession', '说明「会话开始后生效」');
  assert.match(JSON.stringify(seat.props.children), /composer\.pendingSession/);
  // 不出现「会话未激活，请先发一条消息」这类阻止性提示。
  assert.doesNotMatch(JSON.stringify(seat.props), /composer\.inactive/);

  // 且确实能写入：写会话级选择时不因 found=false 而拒绝。
  menu.props.onSelect('zai/glm-5.3');
  await tick();
  assert.ok(
    calls.some(([endpoint, args]) => endpoint === 'approveForMe/setSessionModel' && args.sessionId === 's1' && args.model === 'zai/glm-5.3'),
    'found=false 时也必须发出 setSessionModel',
  );
});

test('composer 下拉：非接管预设（active=false）时不渲染控件（design §7.3）', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    currentSession: 's1',
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/getState') {
        return {
          ok: true,
          value: {
            found: true,
            active: false,
            preset: 'workspace-write',
            sessionModel: null,
            sessionEffort: '',
            globalDefault: 'zai/glm-5.3',
            globalEffort: 'low',
            byParentModel: {},
            effective: 'zai/glm-5.3',
            effectiveEffort: 'low',
            layer: 'global',
          },
        };
      }
      if (endpoint === 'approveForMe/modelCatalog') {
        return { ok: true, value: { providers: [{ id: 'zai', models: [{ id: 'glm-5.3' }] }] } };
      }
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const dropdown = env.registrations.find((entry) => entry.options.name === 'conversation.input.left');
  const props = { t: (key) => key, ...dropdown.options.inject() };
  render(dropdown.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const tree = render(dropdown.component, props);
  assert.equal(findNode(tree, primitivesStub.Menu), undefined, '非接管预设下不得渲染下拉');
});

test('composer 下拉：写入失败时触发器出现 dsafm_badge 错误徽标（design §7.3）', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    currentSession: 's1',
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/getState') {
        return {
          ok: true,
          value: {
            found: true,
            active: true,
            preset: 'auto-approve',
            sessionModel: null,
            sessionEffort: '',
            globalDefault: 'zai/glm-5.3',
            globalEffort: 'low',
            byParentModel: {},
            effective: 'zai/glm-5.3',
            effectiveEffort: 'low',
            layer: 'global',
          },
        };
      }
      if (endpoint === 'approveForMe/modelCatalog') {
        return { ok: true, value: { providers: [{ id: 'zai', models: [{ id: 'glm-5.3' }] }] } };
      }
      if (endpoint === 'approveForMe/setSessionModel') {
        return { ok: false, error: '会话级选择写入失败：本地存储不可写。' };
      }
      return { ok: true, value: { efforts: [{ id: 'low' }] } };
    },
  });
  client.apply(env.ctx);
  const dropdown = env.registrations.find((entry) => entry.options.name === 'conversation.input.left');
  const props = { t: (key) => key, ...dropdown.options.inject() };
  render(dropdown.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const first = findNode(render(dropdown.component, props), primitivesStub.Menu);
  // 选一个模型：写入必然失败。
  first.props.onSelect('zai/glm-5.3');
  await tick();
  await tick();
  await tick();
  hookIndex = 0;
  const after = findNode(render(dropdown.component, props), primitivesStub.Menu);
  const seat = after.props.anchor;
  assert.match(String(seat.props.title), /composer\.failed/, '悬停标题应当显示失败');
  assert.match(String(seat.props.title), /本地存储不可写/, '悬停标题应当带上宿主给的原因');
  assert.match(JSON.stringify(seat.props.children), /dsafm_badge/, '触发器上应当出现错误徽标');
  assert.match(JSON.stringify(seat.props.children), /composer\.failed/, '徽标文案用 composer.failed');
});

test('composer 分置提示（§7.2.0）：session 条目渲染在选择控件附近，空串省略「实际使用」句', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    currentSession: 's1',
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/getState') {
        return {
          ok: true,
          value: {
            found: true,
            active: true,
            preset: 'auto-approve',
            sessionModel: 'zai/gone-9',
            sessionEffort: '',
            globalDefault: '',
            globalEffort: '',
            modelIssues: [
              { scope: 'session', ruleProvider: null, ruleModel: '', configured: 'zai/gone-9', reason: 'provider 不存在', effectiveLayer: 'follow-parent', effectiveModel: '' },
            ],
            effective: '',
            effectiveEffort: '',
            layer: 'follow-parent',
          },
        };
      }
      if (endpoint === 'approveForMe/modelCatalog') {
        return { ok: true, value: { providers: [{ id: 'zai', models: [{ id: 'glm-5.3' }] }] } };
      }
      return { ok: true, value: { efforts: [{ id: 'low' }] } };
    },
  });
  client.apply(env.ctx);
  const dicts = env.dictionaries[0].dicts;
  const dropdown = env.registrations.find((entry) => entry.options.name === 'conversation.input.left');
  const props = { t: (key) => dicts.zh[key] ?? key, ...dropdown.options.inject() };
  render(dropdown.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const tree = render(dropdown.component, props);
  // 会话提示挂在选择控件附近：座位包裹层内＝Menu＋提示行（design §7.2.0/§7.3.1）。
  const wrap = findByClass(tree, 'dsafm_seatwrap');
  assert.ok(wrap, '有 session 条目时应有座位包裹层');
  const menu = findNode(wrap, primitivesStub.Menu);
  assert.ok(menu, '包裹层内应仍有 Menu');
  const warns = findAllByClass(wrap, 'dsafm_warnline');
  assert.equal(warns.length, 1, '应渲染一条 session 提示');
  const text = JSON.stringify(warns[0]);
  assert.match(text, /本会话选择的审查模型不可用/, '用 warn.modelIssue.session 文案');
  assert.match(text, /provider 不存在/, '正文包含原因');
  assert.match(text, /当前生效：全局默认未设置，使用执行助手当前模型（follow-parent）。/, '不可用键空串时以 warn.modelIssue.layer 层含义独立成句承接（§7.2.0/§8.5.1）');
  assert.doesNotMatch(text, /（follow-parent）：/, '层含义句后不得拼「层含义：」悬空冒号');
  assert.doesNotMatch(text, /实际使用/, 'effectiveModel 为空串时省略「实际使用」句（design §7.2.0）');
  assert.equal(findAllNodes(wrap, (node) => node.type === primitivesStub.IconWarningOutlineRegular).length, 1, '提示行带警告图标');
});

test('composer 分置提示（§7.2.0）：无 modelIssues 字段（旧宿主）或求值失败时不渲染', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    currentSession: 's1',
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/getState') {
        // 旧宿主：状态里没有 modelIssues 字段。
        return {
          ok: true,
          value: {
            found: true,
            active: true,
            preset: 'auto-approve',
            sessionModel: null,
            sessionEffort: '',
            globalDefault: 'zai/glm-5.3',
            globalEffort: 'low',
            byParentModel: {},
            effective: 'zai/glm-5.3',
            effectiveEffort: 'low',
            layer: 'global',
          },
        };
      }
      if (endpoint === 'approveForMe/modelCatalog') {
        return { ok: true, value: { providers: [{ id: 'zai', models: [{ id: 'glm-5.3' }] }] } };
      }
      return { ok: true, value: { efforts: [{ id: 'low' }] } };
    },
  });
  client.apply(env.ctx);
  const dropdown = env.registrations.find((entry) => entry.options.name === 'conversation.input.left');
  const props = { t: (key) => key, ...dropdown.options.inject() };
  render(dropdown.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const tree = render(dropdown.component, props);
  assert.equal(findByClass(tree, 'dsafm_seatwrap'), undefined, '旧宿主无字段时不渲染包裹层');
  assert.equal(findAllByClass(tree, 'dsafm_warnline').length, 0, '不应渲染任何提示行');
});

test('composer 空全局默认提示（§7.2.0）：会话未选择且全局默认为空，effectiveModel 有值时展示', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    currentSession: 's1',
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/getState') {
        // 会话未单独选择审查模型（sessionModel 空）＋全局默认为空：空默认条目的
        // effectiveModel 填会话执行助手当前模型（design §7.2.0），随「实际使用」句展示。
        return {
          ok: true,
          value: {
            found: true,
            active: true,
            preset: 'auto-approve',
            sessionModel: null,
            sessionEffort: '',
            globalDefault: '',
            globalEffort: '',
            modelIssues: [
              { scope: 'global', ruleProvider: null, ruleModel: '', configured: '', reason: '全局默认审查模型未设置', effectiveLayer: 'follow-parent', effectiveModel: 'zai/glm-5.3' },
            ],
            effective: 'zai/glm-5.3',
            effectiveEffort: '',
            layer: 'follow-parent',
          },
        };
      }
      if (endpoint === 'approveForMe/modelCatalog') {
        return { ok: true, value: { providers: [{ id: 'zai', models: [{ id: 'glm-5.3' }] }] } };
      }
      return { ok: true, value: { efforts: [{ id: 'low' }] } };
    },
  });
  client.apply(env.ctx);
  const dicts = env.dictionaries[0].dicts;
  const dropdown = env.registrations.find((entry) => entry.options.name === 'conversation.input.left');
  const props = { t: (key) => dicts.zh[key] ?? key, ...dropdown.options.inject() };
  render(dropdown.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const tree = render(dropdown.component, props);
  const wrap = findByClass(tree, 'dsafm_seatwrap');
  assert.ok(wrap, '空默认条目也应渲染座位包裹层');
  assert.ok(findNode(wrap, primitivesStub.Menu), '包裹层内应仍有 Menu');
  const warns = findAllByClass(wrap, 'dsafm_warnline');
  assert.equal(warns.length, 1, '控件附近至多一条（design §7.2.0）');
  const text = JSON.stringify(warns[0]);
  assert.match(text, /本会话未单独选择审查模型/, '用 warn.modelIssue.followParent 文案');
  assert.match(text, /按未设置的全局默认跟随执行助手的当前模型/, '文案说明跟随语义');
  assert.match(text, /「使用相同模型」，不是由执行助手自己审批/, '文案区分「使用相同模型」与自审');
  assert.match(text, /实际使用：全局默认未设置，使用执行助手当前模型（follow-parent）：zai\/glm-5\.3/, '有生效引用时按「实际使用：层含义：引用」呈现');
  assert.doesNotMatch(text, /不可用|故障/, '状态语义：不含「不可用」「故障」措辞');
});

test('composer 空全局默认提示（§7.2.0）：effectiveModel 空串时省略「实际使用」句', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    currentSession: 's1',
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/getState') {
        return {
          ok: true,
          value: {
            found: true,
            active: true,
            preset: 'auto-approve',
            sessionModel: null,
            sessionEffort: '',
            globalDefault: '',
            globalEffort: '',
            modelIssues: [
              { scope: 'global', ruleProvider: null, ruleModel: '', configured: '', reason: '全局默认审查模型未设置', effectiveLayer: 'follow-parent', effectiveModel: '' },
            ],
            effective: '',
            effectiveEffort: '',
            layer: 'follow-parent',
          },
        };
      }
      if (endpoint === 'approveForMe/modelCatalog') {
        return { ok: true, value: { providers: [{ id: 'zai', models: [{ id: 'glm-5.3' }] }] } };
      }
      return { ok: true, value: { efforts: [{ id: 'low' }] } };
    },
  });
  client.apply(env.ctx);
  const dicts = env.dictionaries[0].dicts;
  const dropdown = env.registrations.find((entry) => entry.options.name === 'conversation.input.left');
  const props = { t: (key) => dicts.zh[key] ?? key, ...dropdown.options.inject() };
  render(dropdown.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const tree = render(dropdown.component, props);
  const wrap = findByClass(tree, 'dsafm_seatwrap');
  assert.ok(wrap, '空默认条目应渲染座位包裹层');
  const warns = findAllByClass(wrap, 'dsafm_warnline');
  assert.equal(warns.length, 1, '控件附近至多一条');
  const text = JSON.stringify(warns[0]);
  assert.match(text, /本会话未单独选择审查模型/, '用 warn.modelIssue.followParent 文案');
  assert.doesNotMatch(text, /实际使用/, 'effectiveModel 为空串时省略「实际使用」句');
  assert.doesNotMatch(text, /全局默认未设置，使用执行助手当前模型（follow-parent）/u, '空默认键不补层含义句——首句已承载层含义（design §7.2.0）');
});

test('composer 空全局默认提示（§7.2.0）：被有效映射截住（shadowed）时用 globalUnsetShadowed 键渲染', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    currentSession: 's1',
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/getState') {
        // 空全局默认条目的 effectiveLayer＝parent-map（解析被有效映射截住，未落到零值语义）→
        // 控件用 globalUnsetShadowed 键：不声称当前跟随，实际生效按真实解析呈现（design §7.3.1）。
        return {
          ok: true,
          value: {
            found: true,
            active: true,
            preset: 'auto-approve',
            sessionModel: null,
            sessionEffort: '',
            globalDefault: '',
            globalEffort: '',
            modelIssues: [
              { scope: 'global', ruleProvider: null, ruleModel: '', configured: '', reason: '全局默认审查模型未设置', effectiveLayer: 'parent-map', effectiveModel: 'zai/glm-5.3' },
            ],
            effective: 'zai/glm-5.3',
            effectiveEffort: '',
            layer: 'parent-map',
          },
        };
      }
      if (endpoint === 'approveForMe/modelCatalog') {
        return { ok: true, value: { providers: [{ id: 'zai', models: [{ id: 'glm-5.3' }] }] } };
      }
      return { ok: true, value: { efforts: [{ id: 'low' }] } };
    },
  });
  client.apply(env.ctx);
  const dicts = env.dictionaries[0].dicts;
  const dropdown = env.registrations.find((entry) => entry.options.name === 'conversation.input.left');
  const props = { t: (key) => dicts.zh[key] ?? key, ...dropdown.options.inject() };
  render(dropdown.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const tree = render(dropdown.component, props);
  const wrap = findByClass(tree, 'dsafm_seatwrap');
  assert.ok(wrap, 'shadowed 条目应渲染座位包裹层');
  const warns = findAllByClass(wrap, 'dsafm_warnline');
  assert.equal(warns.length, 1, '控件附近至多一条');
  const text = JSON.stringify(warns[0]);
  assert.match(text, /默认审查模型未设置：仅当解析落到全局默认层时/, '用 warn.modelIssue.globalUnsetShadowed 文案（条件从句）');
  assert.match(text, /实际使用：按执行助手的模型映射（parent-map）：zai\/glm-5\.3/, 'shadowed 变体带「实际使用：层含义：引用」尾句（design §7.2.2 定稿表）');
  assert.doesNotMatch(text, /按未设置的全局默认跟随/u, '被映射截住不得声称当前跟随（design §10.2 巡检判据）');
  assert.doesNotMatch(text, /本会话未单独选择审查模型/, '不得误用 followParent 键文案');
});

test('composer 提示互斥（§7.2.0）：会话已选择且不可用时只渲染 session 条目，不另渲染空默认行', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    currentSession: 's1',
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/getState') {
        // 两条同时在数据通道里（宿主按 reviewer.model 为空照发 global 空默认条目）：
        // 会话已单独选择且不可用 → 控件附近只渲染 session 条目，跟随状态由其回退结果承载。
        return {
          ok: true,
          value: {
            found: true,
            active: true,
            preset: 'auto-approve',
            sessionModel: 'zai/gone-9',
            sessionEffort: '',
            globalDefault: '',
            globalEffort: '',
            modelIssues: [
              { scope: 'global', ruleProvider: null, ruleModel: '', configured: '', reason: '全局默认审查模型未设置', effectiveLayer: 'follow-parent', effectiveModel: 'zai/glm-5.3' },
              { scope: 'session', ruleProvider: null, ruleModel: '', configured: 'zai/gone-9', reason: 'provider 不存在', effectiveLayer: 'follow-parent', effectiveModel: 'zai/glm-5.3' },
            ],
            effective: 'zai/glm-5.3',
            effectiveEffort: '',
            layer: 'follow-parent',
          },
        };
      }
      if (endpoint === 'approveForMe/modelCatalog') {
        return { ok: true, value: { providers: [{ id: 'zai', models: [{ id: 'glm-5.3' }] }] } };
      }
      return { ok: true, value: { efforts: [{ id: 'low' }] } };
    },
  });
  client.apply(env.ctx);
  const dicts = env.dictionaries[0].dicts;
  const dropdown = env.registrations.find((entry) => entry.options.name === 'conversation.input.left');
  const props = { t: (key) => dicts.zh[key] ?? key, ...dropdown.options.inject() };
  render(dropdown.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const tree = render(dropdown.component, props);
  const wrap = findByClass(tree, 'dsafm_seatwrap');
  assert.ok(wrap, '有提示时应渲染座位包裹层');
  const warns = findAllByClass(wrap, 'dsafm_warnline');
  assert.equal(warns.length, 1, '互斥：控件附近至多一条（design §7.2.0）');
  const text = JSON.stringify(warns[0]);
  assert.match(text, /本会话选择的审查模型不可用/, '渲染的是 session 不可用条目');
  assert.match(text, /实际使用：全局默认未设置，使用执行助手当前模型（follow-parent）：zai\/glm-5\.3/, '跟随状态由该条目的回退结果承载');
  assert.doesNotMatch(text, /本会话未单独选择审查模型/, '不得另渲染空全局默认行（warn.modelIssue.followParent）');
});

test('结构化规则行：目录选择全 id 往返不变形，两种作用范围回显口径不同（design §6.2/§7.2）', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    snapshot: {
      status: 'ready',
      value: { reviewer: {} },
      base: {},
      user: {},
      revision: 1,
      writable: true,
    },
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/modelCatalog') {
        return { ok: true, value: { providers: [{ id: 'deepseek', models: [{ id: 'deepseek-chat' }] }, { id: 'zai', models: [{ id: 'glm-5.3' }] }] } };
      }
      if (endpoint === 'approveForMe/modelEfforts') return { ok: true, value: { efforts: [{ id: 'low' }], defaultEffort: 'low' } };
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const props = { t: (key) => key, scope: env.scope, rpcCall: env.rpcCall };
  const tree = await expandCard(card.component, props);
  findByClass(tree, 'dsafm_map_add').props.onClick();
  hookIndex = 0;
  let current = render(card.component, props);
  let row = findAllByClass(current, 'dsafm_map_row')[0];
  assert.equal(findByClass(row, 'dsafm_map_scope_mode').props.value, 'any', '新行默认任意 provider');

  // 切到「指定 provider」：行内出现 provider 选择，默认取目录首个 provider。
  findByClass(row, 'dsafm_map_scope_mode').props.onChange({ target: { value: 'named' } });
  await tick();
  hookIndex = 0;
  current = render(card.component, props);
  row = findAllByClass(current, 'dsafm_map_row')[0];
  const providerSelect = findByClass(row, 'dsafm_map_provider');
  assert.ok(providerSelect, '指定 provider 时应有 provider 选择');
  assert.equal(providerSelect.props.value, 'deepseek', 'provider 默认取目录首个');
  assert.deepEqual(providerSelect.props.children.filter(Boolean).map((option) => option.props.children), ['card.map.placeholder.provider', 'deepseek', 'zai', 'card.map.custom']);

  // 执行助手模型下拉只列该 provider 的模型；选项值＝provider 与 id 的拼接，选择查回纯 id，不切斜杠。
  const agentSelect = findByClass(row, 'dsafm_map_parent');
  assert.deepEqual(agentSelect.props.children.filter(Boolean).map((option) => option.props.value), ['', 'deepseek/deepseek-chat', '__custom__']);
  agentSelect.props.onChange({ target: { value: 'deepseek/deepseek-chat' } });
  await tick();
  hookIndex = 0;
  current = render(card.component, props);
  row = findAllByClass(current, 'dsafm_map_row')[0];
  assert.equal(findByClass(row, 'dsafm_map_parent').props.value, 'deepseek/deepseek-chat', '指定 provider 的回显是拼接值（design §6.2）');

  // 审查模型与档位。
  findByClass(row, 'dsafm_model').props.onChange({ target: { value: 'zai/glm-5.3' } });
  await tick();
  hookIndex = 0;
  current = render(card.component, props);
  row = findAllByClass(current, 'dsafm_map_row')[0];
  assert.equal(env.writes.length, 0, '编辑只暂存，不应写库');
  let save = findByClass(current, 'dsafm_save');
  assert.equal(save.props.disabled, false, '有改动后保存应可点');
  save.props.onClick();
  await tick();
  let rulesOps = env.writes.filter((op) => op.path.join('.') === 'reviewer.parentModelRules');
  assert.equal(env.writes.some((op) => op.path.join('.') === 'reviewer.byParentModel'), false, '旧字典无内容不应写旧字典路径');
  assert.deepEqual(
    rulesOps[rulesOps.length - 1].value,
    [{ parent: { provider: 'deepseek', model: 'deepseek-chat' }, choice: { model: 'zai/glm-5.3', effort: '' } }],
    '保存写入结构化规则，id 全程不变形（不切斜杠、不剥前缀；档位原为空则保持空）',
  );

  // 作用范围切回任意：回显变纯 id，保存写 provider=null 的规则。
  findByClass(row, 'dsafm_map_scope_mode').props.onChange({ target: { value: 'any' } });
  await tick();
  hookIndex = 0;
  current = render(card.component, props);
  row = findAllByClass(current, 'dsafm_map_row')[0];
  assert.equal(findByClass(row, 'dsafm_map_provider'), undefined, '任意 provider 时不应有 provider 选择');
  assert.equal(findByClass(row, 'dsafm_map_parent').props.value, 'deepseek-chat', '任意 provider 的回显是纯 id（design §6.2）');
  save = findByClass(current, 'dsafm_save');
  save.props.onClick();
  await tick();
  rulesOps = env.writes.filter((op) => op.path.join('.') === 'reviewer.parentModelRules');
  assert.deepEqual(
    rulesOps[rulesOps.length - 1].value,
    [{ parent: { provider: null, model: 'deepseek-chat' }, choice: { model: 'zai/glm-5.3', effort: '' } }],
    '切回任意 provider 保存应写 provider:null',
  );
});

test('映射行重复条件：行级错误并阻止保存，含旧字典行同条件（design §7.2）', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    snapshot: {
      status: 'ready',
      value: {
        fallback: 'ask',
        reviewer: {
          byParentModel: {
            'deepseek-chat': { model: 'zai/glm-5.3', effort: 'low' },
            'deepseek/deepseek-chat': { model: 'zai/glm-5.3', effort: '' },
          },
        },
      },
      base: {},
      user: { fallback: 'ask' },
      revision: 1,
      writable: true,
    },
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/modelCatalog') {
        return { ok: true, value: { providers: [{ id: 'deepseek', models: [{ id: 'deepseek-chat' }] }, { id: 'zai', models: [{ id: 'glm-5.3' }] }] } };
      }
      if (endpoint === 'approveForMe/modelEfforts') return { ok: true, value: { efforts: [{ id: 'low' }], defaultEffort: 'low' } };
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const props = { t: (key) => key, scope: env.scope, rpcCall: env.rpcCall };
  const tree = await expandCard(card.component, props);
  // 纯 id 旧键行与待确认含斜杠旧键行按兼容读取条件同条件（任意＋去首斜杠 id）→ 两行都报重复。
  const wraps = findAllByClass(tree, 'dsafm_map_rowwrap');
  assert.equal(wraps.length, 2, '两行（legacy＋pending）');
  assert.equal(findAllByClass(tree, 'dsafm_map_dup').length, 2, '两行都应有行级重复错误');
  // 快照自带重复：即便只改其他字段，保存也应被阻止（错误在场却可保存会自相矛盾）。
  const fallbackSelect = findAllByClass(tree, 'dsafm_input').find((node) => node.type === 'select' && node.props.value === 'ask');
  fallbackSelect.props.onChange({ target: { value: 'reject' } });
  await tick();
  hookIndex = 0;
  let current = render(card.component, props);
  assert.equal(findByClass(current, 'dsafm_save').props.disabled, true, '重复条件在场时保存应禁用');
  assert.equal(env.writes.length, 0, '不应写库');

  // 手输同一纯 id 到新行也构成重复；换条件后错误消失、恢复可保存。
  hookIndex = 0;
  current = render(card.component, props);
  const add = findByClass(current, 'dsafm_map_add');
  add.props.onClick();
  hookIndex = 0;
  current = render(card.component, props);
  let newRow = findAllByClass(current, 'dsafm_map_row')[2];
  findByClass(newRow, 'dsafm_map_parent').props.onChange({ target: { value: '__custom__' } });
  await tick();
  hookIndex = 0;
  current = render(card.component, props);
  newRow = findAllByClass(current, 'dsafm_map_row')[2];
  const customInput = findAllByClass(newRow, 'dsafm_input').find((node) => node.type === 'input');
  customInput.props.onChange({ target: { value: 'deepseek-chat' } });
  await tick();
  hookIndex = 0;
  current = render(card.component, props);
  assert.equal(findAllByClass(current, 'dsafm_map_dup').length, 3, '手输同 id 的行与两行旧键都报重复');
  assert.equal(findByClass(current, 'dsafm_save').props.disabled, true, '重复条件应阻止保存');
  const rows3 = findAllByClass(current, 'dsafm_map_row');
  const typed = findAllByClass(rows3[2], 'dsafm_input').find((node) => node.type === 'input');
  typed.props.onChange({ target: { value: 'glm-5.3' } });
  await tick();
  hookIndex = 0;
  current = render(card.component, props);
  assert.equal(findAllByClass(current, 'dsafm_map_dup').length, 2, '换条件后新行不再重复（旧表自带的重复仍在）');
});

test('映射行重复条件同口径 trim：空白前后缀条件判重复并禁存（不待入库后被宿主防线拒绝）', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    snapshot: {
      status: 'ready',
      value: {
        reviewer: {
          parentModelRules: [{ parent: { provider: null, model: 'deepseek-chat' }, choice: { model: 'zai/glm-5.3', effort: '' } }],
        },
      },
      base: {},
      user: {},
      revision: 1,
      writable: true,
    },
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/modelCatalog') {
        return { ok: true, value: { providers: [{ id: 'deepseek', models: [{ id: 'deepseek-chat' }] }, { id: 'zai', models: [{ id: 'glm-5.3' }] }] } };
      }
      if (endpoint === 'approveForMe/modelEfforts') return { ok: true, value: { efforts: [{ id: 'low' }], defaultEffort: 'low' } };
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const props = { t: (key) => key, scope: env.scope, rpcCall: env.rpcCall };
  const tree = await expandCard(card.component, props);
  assert.equal(findAllByClass(tree, 'dsafm_map_dup').length, 0, '单行条件不报重复');

  // 新行手输带空白前后缀的同 id：比较键与持久化同口径（键化前 trim），行级即判重复。
  hookIndex = 0;
  let current = render(card.component, props);
  findByClass(current, 'dsafm_map_add').props.onClick();
  hookIndex = 0;
  current = render(card.component, props);
  let newRow = findAllByClass(current, 'dsafm_map_row')[1];
  findByClass(newRow, 'dsafm_map_parent').props.onChange({ target: { value: '__custom__' } });
  await tick();
  hookIndex = 0;
  current = render(card.component, props);
  newRow = findAllByClass(current, 'dsafm_map_row')[1];
  const customInput = findAllByClass(newRow, 'dsafm_input').find((node) => node.type === 'input');
  customInput.props.onChange({ target: { value: ' deepseek-chat ' } });
  await tick();
  hookIndex = 0;
  current = render(card.component, props);
  assert.equal(findAllByClass(current, 'dsafm_map_dup').length, 2, '「chat」与「 chat」两行都应报行级重复错误');
  assert.equal(findByClass(current, 'dsafm_save').props.disabled, true, '重复条件应阻止保存');
  assert.equal(env.writes.length, 0, '禁存：不写库（避免入库成重复规则后 normalizeConfig 读取抛错）');
});

test('映射行重复条件 provider 侧空白：快照两行「foo」与「 foo 」即报行级重复并禁存', async () => {
  resetHooks();
  const client = loadClient();
  // 快照直构（不走真实 normalizeConfig——重复对会在读取层即被拦截，到不了行级防线断言）。
  const env = makeCtx({
    snapshot: {
      status: 'ready',
      value: {
        reviewer: {
          parentModelRules: [
            { parent: { provider: 'foo', model: 'deepseek-chat' }, choice: { model: 'zai/glm-5.3', effort: '' } },
            { parent: { provider: ' foo ', model: 'deepseek-chat' }, choice: { model: 'zai/glm-5.3', effort: '' } },
          ],
        },
      },
      base: {},
      user: {},
      revision: 1,
      writable: true,
    },
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/modelCatalog') {
        return { ok: true, value: { providers: [{ id: 'deepseek', models: [{ id: 'deepseek-chat' }] }, { id: 'zai', models: [{ id: 'glm-5.3' }] }] } };
      }
      if (endpoint === 'approveForMe/modelEfforts') return { ok: true, value: { efforts: [{ id: 'low' }], defaultEffort: 'low' } };
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const props = { t: (key) => key, scope: env.scope, rpcCall: env.rpcCall };
  const tree = await expandCard(card.component, props);
  assert.equal(findAllByClass(tree, 'dsafm_map_dup').length, 2, 'provider 去空白行与首尾空白行都应报行级重复');
  assert.equal(findByClass(tree, 'dsafm_save').props.disabled, true, '重复条件应阻止保存');
});

test('待确认含斜杠旧键：确认「指定 provider」转为命名规则，旧键从字典移除（design §7.2）', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    snapshot: {
      status: 'ready',
      value: { reviewer: { byParentModel: { 'deepseek/deepseek-chat': { model: 'zai/glm-5.3', effort: 'low' } } } },
      base: {},
      user: {},
      revision: 1,
      writable: true,
    },
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/modelCatalog') {
        return { ok: true, value: { providers: [{ id: 'deepseek', models: [{ id: 'deepseek-chat' }] }, { id: 'zai', models: [{ id: 'glm-5.3' }] }] } };
      }
      if (endpoint === 'approveForMe/modelEfforts') return { ok: true, value: { efforts: [{ id: 'low' }], defaultEffort: 'low' } };
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const dicts = env.dictionaries[0].dicts;
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const props = { t: (key) => dicts.zh[key] ?? key, scope: env.scope, rpcCall: env.rpcCall };
  const tree = await expandCard(card.component, props);
  const row = findAllByClass(tree, 'dsafm_map_row')[0];
  // 待确认行的形态：确认下拉＋只读的键回显＋不可编辑的审查模型与档位＋保留说明。
  const confirm = findByClass(row, 'dsafm_map_confirm');
  assert.ok(confirm, '待确认行应有确认下拉');
  assert.deepEqual(
    confirm.props.children.map((option) => option.props.value),
    ['', 'any', 'named'],
  );
  assert.match(String(confirm.props.children[1].props.children), /任意 provider，模型 id 为 deepseek\/deepseek-chat/, '「任意」选项应展示整键为 id');
  assert.match(String(confirm.props.children[2].props.children), /指定 provider deepseek，模型 id 为 deepseek-chat/, '「指定」选项应展示 provider 与 id');
  const keyEcho = findAllByClass(row, 'dsafm_input').find((node) => node.type === 'input');
  assert.equal(keyEcho.props.value, 'deepseek/deepseek-chat', '确认前原值保留展示');
  assert.equal(keyEcho.props.disabled, true, '确认前键不可编辑');
  assert.equal(findByClass(row, 'dsafm_model').props.disabled, true, '确认前审查模型不可编辑');
  assert.equal(findByClass(row, 'dsafm_effort').props.disabled, true, '确认前档位不可编辑');
  assert.ok(findAllByClass(tree, 'dsafm_map_pending').length >= 1, '应有确认前按兼容规则读取的说明');

  // 确认为「指定 provider」：转为命名规则行；保存写规则清单、旧字典同步清键。
  confirm.props.onChange({ target: { value: 'named' } });
  await tick();
  hookIndex = 0;
  const confirmed = render(card.component, props);
  const confirmedRow = findAllByClass(confirmed, 'dsafm_map_row')[0];
  assert.equal(findByClass(confirmedRow, 'dsafm_map_scope_mode').props.value, 'named', '确认后是命名规则行');
  assert.equal(findByClass(confirmedRow, 'dsafm_map_parent').props.value, 'deepseek/deepseek-chat', '确认后回显拼接值');
  assert.equal(findByClass(confirmedRow, 'dsafm_model').props.disabled, false, '确认后审查模型恢复可编辑');
  const save = findByClass(confirmed, 'dsafm_save');
  assert.equal(save.props.disabled, false, '确认即是有效改动');
  save.props.onClick();
  await tick();
  const rulesOps = env.writes.filter((op) => op.path.join('.') === 'reviewer.parentModelRules');
  assert.deepEqual(
    rulesOps[rulesOps.length - 1].value,
    [{ parent: { provider: 'deepseek', model: 'deepseek-chat' }, choice: { model: 'zai/glm-5.3', effort: 'low' } }],
    '确认「指定 provider」应写入命名规则',
  );
  const legacyOps = env.writes.filter((op) => op.path.join('.') === 'reviewer.byParentModel');
  assert.deepEqual(legacyOps[legacyOps.length - 1].value, {}, '旧键确认后应从字典移除（只减不增）');
});

test('待确认含斜杠旧键：确认「任意 provider」按整键为完整纯 id 入规则（design §7.2）', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    snapshot: {
      status: 'ready',
      value: { reviewer: { byParentModel: { 'deepseek/deepseek-chat': { model: 'zai/glm-5.3', effort: '' } } } },
      base: {},
      user: {},
      revision: 1,
      writable: true,
    },
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/modelCatalog') {
        return { ok: true, value: { providers: [{ id: 'zai', models: [{ id: 'glm-5.3' }] }] } };
      }
      if (endpoint === 'approveForMe/modelEfforts') return { ok: true, value: { efforts: [{ id: 'low' }], defaultEffort: 'low' } };
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const props = { t: (key) => key, scope: env.scope, rpcCall: env.rpcCall };
  const tree = await expandCard(card.component, props);
  findByClass(findAllByClass(tree, 'dsafm_map_row')[0], 'dsafm_map_confirm').props.onChange({ target: { value: 'any' } });
  await tick();
  hookIndex = 0;
  const confirmed = render(card.component, props);
  const confirmedRow = findAllByClass(confirmed, 'dsafm_map_row')[0];
  assert.equal(findByClass(confirmedRow, 'dsafm_map_scope_mode').props.value, 'any', '确认「任意」后是通用规则行');
  // 整键就是完整纯模型 id：目录没有该 id，走保留选项回显，原样不变形。
  assert.equal(findByClass(confirmedRow, 'dsafm_map_parent').props.value, 'deepseek/deepseek-chat', '整键作为纯 id 原样回显');
  const save = findByClass(confirmed, 'dsafm_save');
  save.props.onClick();
  await tick();
  const rulesOps = env.writes.filter((op) => op.path.join('.') === 'reviewer.parentModelRules');
  assert.deepEqual(
    rulesOps[rulesOps.length - 1].value,
    [{ parent: { provider: null, model: 'deepseek/deepseek-chat' }, choice: { model: 'zai/glm-5.3', effort: '' } }],
    '确认「任意 provider」应按整键写通用规则',
  );
});

test('编辑旧字典纯 id 行＝转为结构化行：保存写规则并从字典移除原键（design §7.2）', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    snapshot: {
      status: 'ready',
      value: { reviewer: { model: 'zai/glm-5.3', byParentModel: { 'deepseek-chat': { model: 'zai/glm-5.3', effort: 'low' } } } },
      base: {},
      user: {},
      revision: 1,
      writable: true,
    },
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/modelCatalog') {
        return { ok: true, value: { providers: [{ id: 'deepseek', models: [{ id: 'deepseek-chat' }] }, { id: 'zai', models: [{ id: 'glm-5.3' }, { id: 'glm-5.3-air' }] }] } };
      }
      if (endpoint === 'approveForMe/modelEfforts') return { ok: true, value: { efforts: [{ id: 'low' }], defaultEffort: 'low' } };
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const props = { t: (key) => key, scope: env.scope, rpcCall: env.rpcCall };
  const tree = await expandCard(card.component, props);
  // 只改审查模型：旧键行的条件不动，保存也不得把旧值迁移成新结构（写规则行＝原条件）。
  findByClass(findAllByClass(tree, 'dsafm_map_row')[0], 'dsafm_model').props.onChange({ target: { value: 'zai/glm-5.3-air' } });
  await tick();
  hookIndex = 0;
  const edited = render(card.component, props);
  const save = findByClass(edited, 'dsafm_save');
  assert.equal(save.props.disabled, false, '编辑旧键行是有效改动');
  save.props.onClick();
  await tick();
  const rulesOps = env.writes.filter((op) => op.path.join('.') === 'reviewer.parentModelRules');
  assert.deepEqual(
    rulesOps[rulesOps.length - 1].value,
    [{ parent: { provider: null, model: 'deepseek-chat' }, choice: { model: 'zai/glm-5.3-air', effort: 'low' } }],
    '编辑后的旧键行按原条件（任意＋纯 id）写入规则清单',
  );
  const legacyOps = env.writes.filter((op) => op.path.join('.') === 'reviewer.byParentModel');
  assert.deepEqual(legacyOps[legacyOps.length - 1].value, {}, '被编辑的旧键应从字典移除');
  // 改其他字段（默认审查模型）不触碰映射两路路径。
  hookIndex = 0;
  const after = render(card.component, props);
  const modelSelect = findAllByClass(after, 'dsafm_model').find((node) => node.props.id === 'approve-for-me-ctl-reviewer-model');
  modelSelect.props.onChange({ target: { value: 'zai/glm-5.3-air' } });
  await tick();
  hookIndex = 0;
  const staged = render(card.component, props);
  const countBefore = env.writes.length;
  findByClass(staged, 'dsafm_save').props.onClick();
  await tick();
  const mapWrites = env.writes.slice(countBefore).filter((op) => op.path[0] === 'reviewer' && (op.path[1] === 'parentModelRules' || op.path[1] === 'byParentModel'));
  assert.equal(mapWrites.length, 0, '映射表无改动时不应写映射路径');
});

test('映射表保存失败保留草稿；目录不可读时行值保留、provider 走手输（design §7.2）', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    snapshot: {
      status: 'ready',
      value: { reviewer: { byParentModel: { 'deepseek-chat': { model: 'zai/glm-5.3', effort: '' } } } },
      base: {},
      user: {},
      revision: 1,
      writable: true,
    },
    mutateRejects: true,
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/modelCatalog') return { ok: false };
      if (endpoint === 'approveForMe/modelEfforts') return { ok: true, value: { efforts: [], defaultEffort: '' } };
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const props = { t: (key) => key, scope: env.scope, rpcCall: env.rpcCall };
  const tree = await expandCard(card.component, props);
  // 目录不可读：任意 provider 行保留原值并附保留选项（不因缺目录丢数据）。
  const row = findAllByClass(tree, 'dsafm_map_row')[0];
  assert.equal(findByClass(row, 'dsafm_map_parent').props.value, 'deepseek-chat', '目录不可读时回显仍是纯 id');
  // 切指定 provider：目录不可读时 provider 控件退化为手输。
  findByClass(row, 'dsafm_map_scope_mode').props.onChange({ target: { value: 'named' } });
  await tick();
  hookIndex = 0;
  let current = render(card.component, props);
  let currentRow = findAllByClass(current, 'dsafm_map_row')[0];
  const providerInput = findAllByClass(currentRow, 'dsafm_map_provider').find((node) => node.type === 'input');
  assert.ok(providerInput, '目录不可读时 provider 应为文本输入');
  providerInput.props.onChange({ target: { value: 'deepseek' } });
  await tick();
  hookIndex = 0;
  current = render(card.component, props);
  currentRow = findAllByClass(current, 'dsafm_map_row')[0];
  // 目录缺项：模型 id 走「自定义…」手输，完整纯 id 原样入行；指定 provider 的回显是拼接值。
  const agentSelect = findByClass(currentRow, 'dsafm_map_parent');
  assert.equal(agentSelect.props.value, 'deepseek/deepseek-chat', '目录不可读时指定 provider 行的值仍按拼接口径保留');
  agentSelect.props.onChange({ target: { value: '__custom__' } });
  await tick();
  hookIndex = 0;
  current = render(card.component, props);
  currentRow = findAllByClass(current, 'dsafm_map_row')[0];
  const typed = findAllByClass(currentRow, 'dsafm_input').find((node) => node.type === 'input' && node.props.placeholder === 'card.map.placeholder.parent');
  typed.props.onChange({ target: { value: 'deepseek-chat' } });
  await tick();
  hookIndex = 0;
  current = render(card.component, props);
  // 保存被宿主拒绝：显示失败、暂存保留（行仍在、可再次保存）。
  const save = findByClass(current, 'dsafm_save');
  assert.equal(save.props.disabled, false, '有改动后保存应可点');
  save.props.onClick();
  await tick();
  hookIndex = 0;
  const failed = render(card.component, props);
  assert.match(JSON.stringify(failed), /card\.failed/, '保存失败应显示失败提示');
  const failedRow = findAllByClass(failed, 'dsafm_map_row')[0];
  assert.equal(findByClass(failedRow, 'dsafm_map_scope_mode').props.value, 'named', '失败后暂存保留（仍是指定 provider）');
  const failedSave = findByClass(failed, 'dsafm_save');
  assert.equal(failedSave.props.disabled, false, '暂存仍在，保存应仍可点');
});

test('接管预设：多选下拉的选项来自宿主目录，勾选暂存、保存写 trigger.presets（requirements §6.1）', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    snapshot: {
      status: 'ready',
      value: { trigger: { presets: ['auto-approve'], unknown: 'skip' } },
      base: {},
      user: {},
      revision: 1,
      writable: true,
    },
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/presetCatalog') {
        return {
          ok: true,
          value: {
            presets: [
              { id: 'auto-approve', label: '自动审批', description: '由审查模型决定', isDefault: true },
              { id: 'workspace-write', label: 'workspace-write', description: '', isDefault: false },
            ],
            configured: ['auto-approve'],
          },
        };
      }
      if (endpoint === 'approveForMe/modelCatalog') return { ok: true, value: { providers: [] } };
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const props = { t: (key) => key, scope: env.scope, rpcCall: env.rpcCall };
  const tree = await expandCard(card.component, props);

  // 触发器是按钮而不是文本框：文案用宿主给的展示名，并标出默认预设；id 挂在触发器上（label 关联）。
  const trigger = findByClass(tree, 'dsafm_picker');
  assert.ok(trigger, '未渲染多选触发器');
  assert.equal(trigger.props.id, 'approve-for-me-ctl-trigger-presets', '字段外壳的控件 id 应挂在触发器上');
  assert.match(JSON.stringify(trigger.props.children), /自动审批/);
  assert.doesNotMatch(JSON.stringify(trigger.props.children), /dsafm_map_parent/, '不应退化成文本输入');
  // 预设无缺失时补救指引行不得出现（指引服务于缺失态，不是常驻文案——requirements §6.1／design §9.2）。
  assert.doesNotMatch(JSON.stringify(tree), /card\.presets\.missing\.remedy/, 'missing 为空时指引行不应渲染');
  assert.equal(findByClass(tree, 'dsafm_save').props.disabled, true, '无改动时保存应 disabled');

  // 展开面板：每个预设一行复选框，默认预设带标记。
  trigger.props.onClick();
  hookIndex = 0;
  const open = render(card.component, props);
  const options = findAllByClass(open, 'dsafm_option');
  assert.equal(options.length, 2, '选项数应等于目录条目数');
  assert.match(JSON.stringify(open), /card\.presets\.default/, '默认预设应带标记');
  // 取消勾选 → 只暂存空数组（合法配置：临时停用接管），并出现内联提示；保存才落库。
  findByClass(open, 'dsafm_check').props.onChange();
  await tick();
  assert.equal(env.writes.length, 0, '勾选只暂存，不应写库');
  hookIndex = 0;
  const after = render(card.component, props);
  assert.match(JSON.stringify(findByClass(after, 'dsafm_warn')), /card\.presets\.none/, '空数组应有内联提示');
  const save = findByClass(after, 'dsafm_save');
  assert.equal(save.props.disabled, false, '有改动后保存应可点');
  save.props.onClick();
  await tick();
  const written = env.writes.filter((op) => op.path.join('.') === 'trigger.presets');
  assert.deepEqual(written[0].value, [], '保存应写入空数组');
  assert.equal(written[0].op, 'set');
});

test('接管预设：目录不可用时提示改用 settings.yaml，并把未知 id 列出来', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    snapshot: {
      status: 'ready',
      value: { trigger: { presets: ['ghost'] } },
      base: {},
      user: {},
      revision: 1,
      writable: true,
    },
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/presetCatalog') return { ok: true, value: { presets: [], configured: ['ghost'] } };
      if (endpoint === 'approveForMe/modelCatalog') return { ok: true, value: { providers: [] } };
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const tree = await expandCard(card.component, { t: (key) => key, scope: env.scope, rpcCall: env.rpcCall });
  const text = JSON.stringify(tree);
  assert.match(text, /card\.presets\.unavailable/);
  assert.match(text, /card\.presets\.missing/);
  assert.match(text, /ghost/);
  // 缺失态附补救指引（requirements §6.1／design §9.2）——missing 行与指引行成对出现，指引不出现即红。
  assert.match(text, /card\.presets\.missing\.remedy/, '缺失态必须渲染补救指引行');
});

test('设置项文案：每个 select/bool 字段的选项都有中文标签键（requirements §6.1）', async () => {
  const client = loadClient();
  const env = makeCtx();
  client.apply(env.ctx);
  const dicts = env.dictionaries[0].dicts;
  // 与 client.js 的 FIELDS 逐项对应：字段路径 → 选项集合（bool 是 true/false）。
  const expected = {
    'trigger.unknown': ['skip', 'review'],
    'human.timeoutFrom': ['request', 'handoff'],
    mode: ['rules', 'off'],
    allowEscalationTo: ['workspace-write', 'danger-full-access'],
    unknownSubject: ['reject', 'review'],
    fallback: ['reject', 'ask'],
    'ui.inject': ['all', 'reject', 'off'],
  };
  for (const [path, options] of Object.entries(expected)) {
    for (const option of options) {
      const key = `option.${path}.${option}`;
      assert.ok(dicts.zh[key], `缺中文标签 ${key}`);
      assert.ok(dicts.en[key], `缺英文标签 ${key}`);
    }
  }
  for (const key of ['card.bool.on', 'card.bool.off', 'card.value.unset', 'card.presets.label', 'card.presets.none']) {
    assert.ok(dicts.zh[key] && dicts.en[key], `缺键 ${key}`);
  }
});

test('composer 下拉：旧宿主没有 active 字段时照常渲染（混合部署容错）', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    currentSession: 's1',
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/getState') {
        // 旧宿主的应答：没有 preset/active（client 比 host 新的部署形态）。
        return { ok: true, value: { found: true, sessionModel: null, sessionEffort: '', globalDefault: 'zai/glm-5.3', globalEffort: 'low', byParentModel: {}, effective: 'zai/glm-5.3', effectiveEffort: 'low', layer: 'global' } };
      }
      if (endpoint === 'approveForMe/modelCatalog') {
        return { ok: true, value: { providers: [{ id: 'zai', models: [{ id: 'glm-5.3' }] }] } };
      }
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const dropdown = env.registrations.find((entry) => entry.options.name === 'conversation.input.left');
  const props = { t: (key) => key, ...dropdown.options.inject() };
  render(dropdown.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const tree = render(dropdown.component, props);
  assert.ok(findNode(tree, primitivesStub.Menu), '缺 active 字段时不应隐藏控件');
});

test('composer 下拉：权限预设一变就立即重拉（design §7.3，不等轮询）', async () => {
  resetHooks();
  const client = loadClient();
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const timers = [];
  globalThis.setInterval = (fn, ms) => {
    const entry = { fn, ms, cleared: false };
    timers.push(entry);
    return entry;
  };
  globalThis.clearInterval = (entry) => {
    if (entry !== undefined) entry.cleared = true;
  };
  try {
    let active = true;
    let preset = 'auto-approve';
    const projection = { get currentValue() { return preset; }, options: [] };
    const env = makeCtx({
      currentSession: 's1',
      call: async (endpoint) => {
        if (endpoint === 'approveForMe/getState') {
          return {
            ok: true,
            value: {
              found: true,
              active,
              preset,
              sessionModel: null,
              sessionEffort: '',
              globalDefault: 'zai/glm-5.3',
              globalEffort: 'low',
              byParentModel: {},
              effective: 'zai/glm-5.3',
              effectiveEffort: 'low',
              layer: 'global',
              trace: { capture: 'summary', ownView: true, turnSummary: true },
            },
          };
        }
        if (endpoint === 'approveForMe/modelCatalog') return { ok: true, value: { providers: [{ id: 'zai', models: [{ id: 'glm-5.3' }] }] } };
        return { ok: true, value: {} };
      },
    });
    client.apply(env.ctx);
    const dropdown = env.registrations.find((entry) => entry.options.name === 'conversation.input.left');
    const props = { t: (key) => key, useProjection: (key) => (key === 'permissions' ? projection : undefined), ...dropdown.options.inject() };
    render(dropdown.component, props);
    await tick();
    await tick();
    hookIndex = 0;
    assert.ok(findNode(render(dropdown.component, props), primitivesStub.Menu), '接管时应显示控件');

    // 宿主把预设切走：投影的 currentValue 变化，组件随之重拉 → 立刻隐藏，无需推进任何定时器。
    preset = 'workspace-write';
    active = false;
    hookIndex = 0;
    render(dropdown.component, props);
    await tick();
    await tick();
    hookIndex = 0;
    assert.equal(findNode(render(dropdown.component, props), primitivesStub.Menu), undefined, '预设变化后应立刻隐藏控件');

    // 回退轮询仍然存在（10 s），且能被清理。
    const poll = timers.find((entry) => entry.ms === 10000);
    assert.ok(poll, '应保留 10 s 回退轮询');
    cleanupEffects();
    assert.equal(poll.cleared, true, '清理副作用时应清掉回退轮询');
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
});

test('composer 下拉：同值刷新不重渲染（避免自激与空转）', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    currentSession: 's1',
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/getState') {
        return {
          ok: true,
          value: {
            found: true,
            active: true,
            preset: 'auto-approve',
            sessionModel: null,
            sessionEffort: '',
            globalDefault: 'zai/glm-5.3',
            globalEffort: 'low',
            byParentModel: {},
            effective: 'zai/glm-5.3',
            effectiveEffort: 'low',
            layer: 'global',
            trace: { capture: 'summary', ownView: true, turnSummary: true },
          },
        };
      }
      if (endpoint === 'approveForMe/modelCatalog') return { ok: true, value: { providers: [{ id: 'zai', models: [{ id: 'glm-5.3' }] }] } };
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const dropdown = env.registrations.find((entry) => entry.options.name === 'conversation.input.left');
  const projection = { currentValue: 'auto-approve', options: [] };
  const props = { t: (key) => key, useProjection: (key) => (key === 'permissions' ? projection : undefined), ...dropdown.options.inject() };
  render(dropdown.component, props);
  await tick();
  await tick();
  // 状态对象留在钩子状态里：同值重渲染必须**保持同一个对象引用**（没有 setState 就没有重渲染）。
  const stateOf = () => hookStates.find((value) => value !== null && typeof value === 'object' && 'effective' in value);
  const before = stateOf();
  assert.ok(before, '未拿到 getState 的状态对象');
  hookIndex = 0;
  render(dropdown.component, props);
  await tick();
  await tick();
  assert.equal(stateOf(), before, '同值刷新不应替换状态对象');
});

test('审批卡片状态条：显示状态行与倒计时，并自己渲染关联命令', async () => {
  resetHooks();
  let clock = 1_700_000_000_000;
  const realNow = Date.now;
  Date.now = () => clock;
  try {
    const client = loadClient();
    const env = makeCtx({
      currentSession: 's1',
      call: async (endpoint) => {
        if (endpoint === 'approveForMe/pendingState') {
          return { ok: true, value: { entries: [{ callId: 'call_1', state: 'waiting-human', cause: 'deny', reason: '删除系统目录', startedAt: clock, deadlineAt: clock + 90_000, deadlineKind: 'human', updatedAt: clock }] } };
        }
        return { ok: true, value: {} };
      },
    });
    client.apply(env.ctx);
    const detail = env.registrations.find((entry) => entry.options.name === 'conversation.approval.detail');
    // `t` 用真实中文模板（带 `{reason}` 占位符），否则状态行里的原因替换不会发生。
    const t = (key) =>
      ({
        'cardstate.waiting': '等待你决定',
        'cardstate.waiting.deny': '自动审查结论为拒绝：{reason}',
        'cardstate.waiting.timeout': '自动审查超时，未取得有效结论',
        'cardstate.waiting.error': '自动审查未取得有效结论：{reason}',
        'countdown.seconds': '剩余 {n} 秒后自动拒绝',
        'countdown.minutes': '剩余 {m} 分 {s} 秒后自动拒绝',
        'cardstate.reviewing': '正在自动审批',
      })[key] ?? key;
    const props = {
      callId: 'call_1',
      t,
      useChat: () => 'rm -rf /tmp/x',
      ...detail.options.inject(),
    };
    render(detail.component, props);
    await tick();
    hookIndex = 0;
    const tree = render(detail.component, props);
    const text = JSON.stringify(tree);
    assert.match(text, /等待你决定/, '缺少「等待你决定」状态行');
    assert.match(text, /自动审查结论为拒绝：删除系统目录/, '原因子句必须点明自动审查结论并带理由');
    assert.match(text, /剩余 1 分 30 秒后自动拒绝/, '缺少倒计时（90 秒 → 分秒格式，按人工截止时间分派）');
    assert.match(text, /rm -rf \/tmp\/x/, '接管 seat 后必须自己渲染关联命令');
  } finally {
    Date.now = realNow;
  }
});

test('审批卡片状态条：协议回落理由按界面语言改写，zh 卡片无英文行', async () => {
  resetHooks();
  const clock = 1_700_000_000_000;
  const realNow = Date.now;
  Date.now = () => clock;
  try {
    const client = loadClient();
    const env = makeCtx({
      currentSession: 's1',
      call: async (endpoint) => {
        if (endpoint === 'approveForMe/pendingState') {
          return { ok: true, value: { entries: [{ callId: 'call_1', state: 'waiting-human', cause: 'deny', reason: DEFAULT_RATIONALE, startedAt: clock, deadlineAt: clock + 90_000, deadlineKind: 'human', updatedAt: clock }] } };
        }
        return { ok: true, value: {} };
      },
    });
    client.apply(env.ctx);
    const detail = env.registrations.find((entry) => entry.options.name === 'conversation.approval.detail');
    const t = (key) =>
      ({
        'cardstate.waiting': '等待你决定',
        'cardstate.waiting.deny': '自动审查结论为拒绝：{reason}',
        'cardstate.waiting.timeout': '自动审查超时，未取得有效结论',
        'cardstate.waiting.error': '自动审查未取得有效结论：{reason}',
        'countdown.seconds': '剩余 {n} 秒后自动拒绝',
        'countdown.minutes': '剩余 {m} 分 {s} 秒后自动拒绝',
        'cardstate.reviewing': '正在自动审批',
        'view.reasonDefaulted': '审查器未提供理由',
      })[key] ?? key;
    const props = { callId: 'call_1', t, useChat: () => 'rm -rf /tmp/x', ...detail.options.inject() };
    render(detail.component, props);
    await tick();
    hookIndex = 0;
    const text = JSON.stringify(render(detail.component, props));
    assert.match(text, /自动审查结论为拒绝：审查器未提供理由/, '协议回落理由在 zh 卡片按界面语言改写');
    assert.ok(!text.includes(DEFAULT_RATIONALE), 'zh 卡片不得出现英文回落行');
  } finally {
    Date.now = realNow;
  }
});

test('审批卡片状态条：没有状态数据时只渲染命令（非接管预设观感不变）', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    currentSession: 's1',
    call: async () => ({ ok: true, value: { entries: [] } }),
  });
  client.apply(env.ctx);
  const detail = env.registrations.find((entry) => entry.options.name === 'conversation.approval.detail');
  const props = { callId: 'call_1', t: (key) => key, useChat: () => 'ls -la', ...detail.options.inject() };
  render(detail.component, props);
  await tick();
  hookIndex = 0;
  const tree = render(detail.component, props);
  assert.equal(tree, 'ls -la', '无状态时应原样渲染命令文本');
});

test('审批卡片状态条：取不到会话 id 时不轮询，仅渲染命令', async () => {
  resetHooks();
  const calls = [];
  const client = loadClient();
  const env = makeCtx({
    currentSession: '',
    call: async (endpoint) => {
      calls.push(endpoint);
      return { ok: true, value: { entries: [] } };
    },
  });
  client.apply(env.ctx);
  const detail = env.registrations.find((entry) => entry.options.name === 'conversation.approval.detail');
  const props = { callId: 'call_1', t: (key) => key, useChat: () => 'echo hi', ...detail.options.inject() };
  render(detail.component, props);
  await tick();
  assert.equal(calls.includes('approveForMe/pendingState'), false, '没有会话 id 就不该发请求');
});

test('审批卡片状态条：审查中显示审查时限倒计时；截止缺失的回退防御不渲染无时限文案（退役文案防回潮）', async () => {
  resetHooks();
  let clock = 1_700_000_000_000;
  const realNow = Date.now;
  Date.now = () => clock;
  try {
    const client = loadClient();
    const env = makeCtx({
      currentSession: 's1',
      call: async () => ({ ok: true, value: { entries: [{ callId: 'call_1', state: 'reviewing', reason: '', startedAt: clock, deadlineAt: null, deadlineKind: null, updatedAt: clock }] } }),
    });
    client.apply(env.ctx);
    const detail = env.registrations.find((entry) => entry.options.name === 'conversation.approval.detail');
    const props = { callId: 'call_1', t: (key) => key, useChat: () => 'echo hi', ...detail.options.inject() };
    render(detail.component, props);
    await tick();
    hookIndex = 0;
    const text = JSON.stringify(render(detail.component, props));
    assert.match(text, /cardstate\.reviewing/);
    // 审查截止缺失（回退防御形态）：不渲染无时限文案（退役分支），也不渲染倒计时。
    assert.ok(!text.includes('countdown.unlimited'), '退役文案 countdown.unlimited 不得出现');
    assert.ok(!text.includes('countdown.review'), '缺失截止不得渲染倒计时');
  } finally {
    Date.now = realNow;
  }
});

test('审批卡片状态条：非审查状态的 null 截止不渲染任何无时限等待文案（design §7.4）', async () => {
  resetHooks();
  const client = loadClient();
  // 人工零时限立即结算：理论上不该出现该状态；万一出现（waiting-human + null 截止），
  // 也不得显示「无时限等待」——只显示状态与原因（design §7.4）。
  const env = makeCtx({
    currentSession: 's1',
    call: async () => ({ ok: true, value: { entries: [{ callId: 'call_1', state: 'waiting-human', cause: 'error', reason: '风险高', startedAt: 1, deadlineAt: null, deadlineKind: null, updatedAt: 1 }] } }),
  });
  client.apply(env.ctx);
  const detail = env.registrations.find((entry) => entry.options.name === 'conversation.approval.detail');
  const t = (key) => ({ 'cardstate.waiting': '等待你决定', 'cardstate.waiting.error': '自动审查未取得有效结论：{reason}', 'cardstate.waiting.deny': '自动审查结论为拒绝：{reason}', 'cardcause.other': '其他通道故障（{v}）', 'countdown.unlimited': '审查无时限', 'countdown.none': '无自动拒绝时限，将一直等待你的决定' })[key] ?? key;
  const props = { callId: 'call_1', t, useChat: () => 'rm x', ...detail.options.inject() };
  render(detail.component, props);
  await tick();
  hookIndex = 0;
  const text = JSON.stringify(render(detail.component, props));
  assert.match(text, /等待你决定/);
  // 未命中类别清单的原因按「其他通道故障（原文）」显示（design §7.4.1）。
  assert.match(text, /其他通道故障（风险高）/);
  assert.ok(!text.includes('审查无时限'), '非审查状态的 null 截止不得显示无上限文案');
  assert.ok(!text.includes('无自动拒绝时限'), '退役文案 countdown.none 不得出现');
  assert.ok(!text.includes('后自动拒绝'), '没有倒计时时不得渲染自动拒绝倒计时文案');
  assert.ok(!text.includes('dsafm_state_time'), '没有倒计时时不得残留时间槽位');
});

/** 审查视图用的字典映射：返回真实模板，等式与文案才能断言替换结果。 */
const REVIEW_TEXT = {
  'view.needSession': '请先打开一个会话',
  'view.empty': '本会话还没有自动审批记录',
  'view.count': '共 {n} 条',
  'view.readFailed': '记录读取失败或不完整，列表可能缺少条目',
  'view.retention': '记录跟随产生它的会话；每会话回读最近一个窗口（默认 200 条，随 ui.trace.maxRecords 可配置），磁盘最多保留 50 个会话文件（固定上限），超限删除最旧；减少采集不删除已有记录。',
  'list.outcome': '最终审批：{v}',
  'list.decision': '模型结论：{v}',
  'view.noOutcome': '未记录最终审批结果',
  'view.reasonDefaulted': '审查器未提供理由',
  'decision.allow': '放行（allow）',
  'decision.allowed-once': '放行（allowed-once）',
  'decision.deny': '拒绝（deny）',
  'decision.rejected': '拒绝（rejected）',
  'decision.error': '失败（error）',
  'time.total': '工具总计 {x} = 执行 {y} + 审批 {z}',
  'time.approvalOnly': '审批 {z}',
  'time.unmatched': '未匹配到工具行',
  'time.queue': '排队 {n}',
  'time.review': '审查 {n}',
  'time.human': '人工 {n}',
  'detail.outcome': '最终审批结果',
  'detail.decision': '模型结论',
  'detail.source': '决定方式',
  'detail.stage': '环节',
  'detail.origin': '归属',
  'detail.escalation': '升权目标',
  'detail.preset': '接管预设',
  'detail.model': '模型',
  'detail.effort': '推理强度',
  'detail.layer': '模型选择来源',
  'detail.attempts': '尝试次数',
  'detail.tokens': '推理 token 用量',
  'detail.risk': '风险',
  'detail.auth': '授权',
  'detail.fieldsDefaulted': '自动补全的字段',
  'detail.degraded': '缺失或异常情况',
  'detail.tools': '取证工具调用',
  'detail.configTag': '配置标识',
  'detail.policyTag': '策略标识',
  'detail.evidence': '上下文证据',
  'detail.probes': '只读取证',
  'detail.reason': '理由',
  'detail.prompt': '提示词',
  'detail.input': '输入',
  'detail.reasoning': '模型返回的推理文本',
  'detail.output': '输出',
  'detail.truncated': '已截断',
  'absent.noContext': '未取上下文',
  'absent.noProbes': '未调用取证工具',
  'absent.modelNotProvided': '模型未提供',
  'absent.notFullCapture': '未开启全文采集',
  'absent.unknown': '本次未记录此项',
  'layer.session': '会话选择（session）',
  'layer.parent-map': '按执行助手的模型映射（parent-map）',
  'layer.global': '全局默认（global）',
  'layer.follow-parent': '全局默认未设置，使用执行助手当前模型（follow-parent）',
  'layer.unavailable': '无可用审查模型（unavailable）',
  'fieldsDefaulted.risk': '风险分级（risk）',
  'fieldsDefaulted.auth': '授权分级（auth）',
  'fieldsDefaulted.reason': '理由（reason）',
  'degraded.command': '无法辨认本次操作（command）',
  'degraded.cwd': '会话目录缺失（cwd）',
  'degraded.transcript': '上下文读取失败或截断（transcript）',
  'degraded.transcript-read-failed': '上下文读取失败（transcript-read-failed）',
  'degraded.transcript-truncated': '上下文截断（transcript-truncated）',
  'degraded.entry': '单条证据截断（entry:…）',
  'degraded.all': '审查模型解析无可用结果（all）',
  'degraded.output-truncated': '输出截断（output-truncated）',
  'degraded.output-empty': '空输出（output-empty）',
  'degraded.superseded': '已被其他路径先结算（superseded）',
  'degraded.queue-overflow': '队列已满（queue-overflow）',
  'degraded.queue-timeout': '排队超时（queue-timeout）',
  'degraded.breaker-open': '冷却中未执行（breaker-open）',
  'degraded.inject-fail': '通知失败（inject-fail）',
  'cardcause.modelUnavailable': '审查模型不可用（model unavailable）',
  'cardcause.outputInvalid': '输出无有效结论（{v}）',
  'cardcause.other': '其他通道故障（{v}）',
  'cardcause.timeout': '审查超时（review timeout）',
  'enum.unknown': '{v}（含义未知）',
  'source.llm': '审查（llm）',
  'source.human': '人工（human）',
  'source.timeout': '超时（timeout）',
  'source.rule': '规则（rule）',
  'source.hard': '硬性拦截（hard）',
  'source.gateway': '通道关闭（gateway）',
  'source.signal': '取消（signal）',
  'source.error': '异常（error）',
  'stage.queue': '排队（queue）',
  'stage.assembly': '装配（assembly）',
  'stage.review': '审查（review）',
  'stage.human': '人工（human）',
  'origin.main': '主会话（main）',
  'origin.subagent': '子代理（subagent）',
};
const reviewT = (key) => REVIEW_TEXT[key] ?? key;

/**
 * 三条合并行（§8.2/§8.5）：A 审查+结算齐全（人工推翻审查：decision≠outcome）；B 审查+结算齐全（审查拒绝）；
 * C 只有结算（队列已满，未执行审查——decision/model 等模型侧字段缺失）。
 */
const TRACE_ROWS = [
  { approvalId: 'apA', callId: 'call_A', toolName: 'pwsh', origin: 'main', escalation: 'danger-full-access', startedAt: 1_700_000_000_000, endedAt: 1_700_000_002_100, queueMs: 100, reviewMs: 2000, humanWaitMs: null, decision: 'allow', outcome: 'rejected', source: 'human', model: 'zai/glm-5.3', effort: 'low', risk: 'low', auth: 'high', reason: '命令安全', subject: 'npm i', truncated: false },
  { approvalId: 'apB', callId: 'call_B', toolName: 'edit', origin: 'main', escalation: null, startedAt: 1_700_000_010_000, endedAt: 1_700_000_010_500, queueMs: 0, reviewMs: 500, humanWaitMs: null, decision: 'deny', outcome: 'rejected', source: 'llm', model: 'zai/glm-5.3', effort: 'low', risk: 'high', auth: 'low', reason: '改动敏感文件', subject: 'edit x.ts', truncated: false },
  { approvalId: 'apC', callId: 'call_C', toolName: 'pwsh', origin: 'subagent', escalation: null, startedAt: 1_700_000_020_000, endedAt: 1_700_000_020_010, queueMs: null, reviewMs: null, humanWaitMs: null, decision: null, outcome: 'rejected', source: 'llm', model: null, effort: null, risk: null, auth: null, reason: '审查未执行：queue-overflow', subject: 'npm run build', truncated: false },
];
/** 详情：A 有 humanWaitMs 与两段全文（input/reasoning 缺，tools=0 证实未调用取证工具）；B 摘要档且审查已执行（全文段均缺，capture 标记证实 summary）；C 全段缺失且 stage=queue（审查未执行）。 */
const TRACE_DETAILS = {
  apA: { ...TRACE_ROWS[0], humanWaitMs: 400, prompt: 'PROMPT-A', output: 'OUTPUT-A', layer: 'session', attempts: 1, tokens: 32, tools: 0, preset: 'auto-approve', configTag: 'a1b2c3d4e5f6', policyTag: 'zh:missing' },
  apB: { ...TRACE_ROWS[1], humanWaitMs: 0, layer: 'session', attempts: 1, capture: 'summary' },
  apC: { ...TRACE_ROWS[2], stage: 'queue', degraded: 'queue-overflow' },
};
/** 记录表快照：call_A 有结算工具行（X=5000ms），call_B 故意没有。 */
const TRAJECTORY_SNAPSHOT = {
  eventNodes: [
    { kind: 'user', seq: 1, time: 1_700_000_000_000, content: [] },
    { kind: 'tool-result', callId: 'call_A', callTime: 1_700_000_001_000, time: 1_700_000_006_000, subCalls: [] },
    { kind: 'tool-result', callId: 'call_root', callTime: 1_700_000_009_000, time: 1_700_000_012_000, subCalls: [
      { kind: 'tool-result', callId: 'call_ptc', callTime: 1_700_000_009_500, time: 1_700_000_011_000, subCalls: [] },
    ] },
  ],
};

test('审查视图：空会话只显示提示，空列表显示空文案', async () => {
  resetHooks();
  const client = loadClient();
  // 空会话：sessions 快照 current 为空 → 不渲染内容。
  const emptySession = makeCtx({ currentSession: '' });
  client.apply(emptySession.ctx);
  const view = emptySession.registrations.find((entry) => entry.options.name === 'conversation.view');
  const emptyTree = render(view.component, { t: reviewT, ...view.options.inject() });
  assert.match(JSON.stringify(emptyTree), /请先打开一个会话/);

  // 空列表。
  resetHooks();
  const env = makeCtx({
    currentSession: 's1',
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/traceRecords') return { ok: true, value: { records: [], readFailed: false } };
      if (endpoint === 'approveForMe/getState') return { ok: true, value: { trace: { capture: 'summary', ownView: true, turnSummary: true } } };
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const view2 = env.registrations.find((entry) => entry.options.name === 'conversation.view');
  const props = { t: reviewT, ...view2.options.inject() };
  render(view2.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const tree = render(view2.component, props);
  assert.match(JSON.stringify(tree), /本会话还没有自动审批记录/);
  assert.match(JSON.stringify(tree), /共 0 条/);
});

test('审查视图：协议回落理由按界面语言改写，zh 详情无英文行', async () => {
  resetHooks();
  const client = loadClient();
  // 记录与详情的 reason 都是协议回落值（审查器未给理由时的存储形态，直接取 lib 常量锁同步）。
  const row = { approvalId: 'apD', callId: 'call_D', toolName: 'pwsh', origin: 'main', escalation: null, startedAt: 1_700_000_030_000, endedAt: 1_700_000_030_500, queueMs: 0, reviewMs: 500, humanWaitMs: null, decision: 'deny', outcome: 'rejected', source: 'llm', model: 'zai/glm-5.3', effort: 'low', risk: 'high', auth: 'low', reason: DEFAULT_RATIONALE, subject: 'npm run dev', truncated: false };
  const env = makeCtx({
    currentSession: 's1',
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/traceRecords') return { ok: true, value: { records: [row], readFailed: false } };
      if (endpoint === 'approveForMe/traceRecord') return { ok: true, value: { record: { ...row, layer: 'session', attempts: 1, capture: 'summary' } } };
      if (endpoint === 'approveForMe/getState') return { ok: true, value: { trace: { capture: 'summary', ownView: true, turnSummary: true } } };
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const view = env.registrations.find((entry) => entry.options.name === 'conversation.view');
  const props = { t: reviewT, useTrajectory: (selector) => selector(TRAJECTORY_SNAPSHOT), ...view.options.inject() };
  render(view.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const listTree = render(view.component, props);
  const head = findAllByClass(listTree, 'dsafm_review_head')[0];
  head.props.onClick();
  hookIndex = 0;
  render(view.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const text = JSON.stringify(render(view.component, props));
  assert.ok(text.includes('审查器未提供理由'), '协议回落理由在 zh 记录详情按界面语言改写');
  assert.ok(!text.includes(DEFAULT_RATIONALE), 'zh 记录详情不得出现英文回落行');
});

test('审查视图：合并行主判定为 outcome、判定与结算并存可分辨，Z 只累加在场分段；详情按 approvalId 拉', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    currentSession: 's1',
    call: async (endpoint, args) => {
      if (endpoint === 'approveForMe/traceRecords') return { ok: true, value: { records: TRACE_ROWS, readFailed: false } };
      if (endpoint === 'approveForMe/traceRecord') return { ok: true, value: { record: TRACE_DETAILS[args?.approvalId] ?? null } };
      if (endpoint === 'approveForMe/getState') return { ok: true, value: { trace: { capture: 'summary', ownView: true, turnSummary: true } } };
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const view = env.registrations.find((entry) => entry.options.name === 'conversation.view');
  const props = { t: reviewT, useTrajectory: (selector) => selector(TRAJECTORY_SNAPSHOT), ...view.options.inject() };
  render(view.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const listTree = render(view.component, props);
  const listText = JSON.stringify(listTree);
  // 新在前（C 在上）；共 3 条；subject 摘要在场。
  assert.match(listText, /npm run build/, 'subject 摘要进列表行');
  assert.match(listText, /共 3 条/);
  // A 行：主位＝最终审批（人工推翻审查放行）→「最终审批：拒绝（rejected）」，次级并列「模型结论：放行（allow）」
  // （方向相反才并列，design §8.5.1）；B 行 decision=deny 与 outcome=rejected 同向 → 不并列次级标注。
  assert.match(listText, /最终审批：拒绝（rejected）/, 'outcome 进主位并带前缀（design §8.5.1）');
  assert.match(listText, /模型结论：放行（allow）/, '方向相反时模型结论为次级并列标注');
  assert.equal((listText.match(/模型结论：/g) ?? []).length, 1, '同向行（deny→rejected）不得重复并列次级标注');
  assert.ok(!listText.includes('未记录最终审批结果'), '有 outcome 的行不得出现旧格式回退标注');
  // C 行（只有结算）：Z 无任何在场分段 → 0ms 由在场分段求和得出。
  assert.match(listText, /npm run build/);
  assert.match(listText, /审批 0 ms/, '无在场分段时 Z=0（求和口径）');

  // 点开 A（匹配上，humanWaitMs 只在详情里）：X=5000ms，Z=100+2000+400=2500ms，Y=2500ms。
  const heads = findAllByClass(listTree, 'dsafm_review_head');
  const headA = heads.find((entry) => JSON.stringify(entry).includes('"pwsh"') && JSON.stringify(entry).includes('npm i'));
  assert.ok(headA, '应找到 pwsh 行');
  headA.props.onClick();
  hookIndex = 0;
  render(view.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const allowText = JSON.stringify(render(view.component, props));
  assert.match(allowText, /工具总计 5\.0 s = 执行 2\.5 s \+ 审批 2\.5 s/);
  assert.ok(!allowText.includes('未匹配到工具行'), '匹配上时不显示未标注');
  // A：全文段在场（prompt/output 有值）证实全文采集，反证不成立（degraded 无 transcript、tools 在场为 0），
  // 四段缺按 §8.5.1 分派链各归其类：evidence→未取上下文、probes→未调用取证工具、
  // reasoning→模型未提供、input→本次未记录此项。
  assert.equal((allowText.match(/未取上下文/g) ?? []).length, 1, 'evidence 缺失 → 未取上下文');
  assert.equal((allowText.match(/未调用取证工具/g) ?? []).length, 1, 'probes 缺失且 tools 在场为 0 → 未调用取证工具');
  assert.equal((allowText.match(/模型未提供/g) ?? []).length, 1, 'reasoning 缺失（全文采集下）→ 模型未提供');
  assert.equal((allowText.match(/本次未记录此项/g) ?? []).length, 1, 'input 缺失（全文采集下）→ 本次未记录此项');
  assert.ok(!allowText.includes('未开启全文采集'), '全文段在场时不得误报未开启全文采集');
  assert.match(allowText, /PROMPT-A/);
  assert.match(allowText, /OUTPUT-A/);
  // 详情元信息：最终审批结果/决定方式/模型选择来源/尝试次数/标识在场（§8.5.1 详情字段定稿名）。
  assert.match(allowText, /最终审批结果: 拒绝（rejected）/);
  assert.match(allowText, /模型结论: 放行（allow）/);
  assert.match(allowText, /决定方式: 人工（human）/);
  assert.match(allowText, /模型选择来源: 会话选择（session）/);
  assert.match(allowText, /尝试次数: 1/);
  assert.match(allowText, /取证工具调用: 0/, '详情 tools 计数行在场（design §8.5.1），0 正常显示');
  assert.match(allowText, /接管预设: auto-approve/);
  assert.match(allowText, /配置标识: a1b2c3d4e5f6/);
  assert.match(allowText, /策略标识: zh:missing/);
  assert.match(allowText, /归属: 主会话（main）/);
  assert.match(allowText, /升权目标: danger-full-access/);

  // 收起 A、点开 B（摘要档且审查已执行：全文段均不在场、decision 在场）：第三级判「未开启全文采集」。
  const headsB = findAllByClass(render(view.component, props), 'dsafm_review_head');
  const headB = headsB.find((entry) => JSON.stringify(entry).includes('edit x.ts'));
  headB.props.onClick();
  hookIndex = 0;
  render(view.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const bText = JSON.stringify(render(view.component, props));
  // B 六段缺（capture=summary 且审查已执行 → 证实未开启全文采集，design §8.5.1 分派链第三级）：
  // prompt/input/reasoning/output 四段 → 未开启全文采集；该级两条可确认说明不生效，
  // evidence/probes → 本次未记录此项（层级归位）。
  assert.equal((bText.match(/未开启全文采集/g) ?? []).length, 4, '摘要档已审查记录的四个全文段缺失各显示一次未开启全文采集');
  assert.equal((bText.match(/本次未记录此项/g) ?? []).length, 2, '全文段均不在场时 evidence/probes 归统一缺省，不误报可确认文案');
  assert.ok(!bText.includes('未取上下文'), '全文未采集时 evidence 缺失不得归「未取上下文」');
  assert.ok(!bText.includes('未调用取证工具'), '全文未采集时 probes 缺失不得归「未调用取证工具」');
  assert.ok(!bText.includes('模型未提供'), '全文未采集时 reasoning 缺失不得归为模型未提供');

  // 收起 B、点开 C（只有结算、审查未执行：decision 缺失）：全部分段缺失显示 —，不按 0 计（design §8.5）。
  const headsC = findAllByClass(render(view.component, props), 'dsafm_review_head');
  const headC = headsC.find((entry) => JSON.stringify(entry).includes('npm run build'));
  headC.props.onClick();
  hookIndex = 0;
  render(view.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const cText = JSON.stringify(render(view.component, props));
  assert.match(cText, /排队 — · 审查 — · 人工 —/, '缺失段显示 —，不按 0 计');
  assert.match(cText, /环节: 排队（queue）/);
  assert.match(cText, /缺失或异常情况: 队列已满（queue-overflow）/);
  // 记录视图按显示类别呈现（design §7.4.1）：固定前缀不在界面显示，记录原值仍在存储层。
  assert.match(cText, /队列已满（queue-overflow）/, '理由段按显示类别呈现');
  assert.ok(!cText.includes('审查未执行：'), '固定前缀不得显示在界面文案中');
  assert.ok(!cText.includes('工具总计'), '匹配不上时不得显示等式');
  assert.match(cText, /未匹配到工具行/, '匹配不上时必须标注，不猜 X');
  assert.match(cText, /审批 0 ms/, '无在场分段时 Z=0（求和口径）');
  // C（queue-overflow 结算、decision 缺失＝审查未执行）：全文段缺失不构成「未开启」的证据，
  // 六个缺段全部归统一缺省（design §8.5.1 第三级以 decision 在场为前提）。
  assert.equal((cText.match(/本次未记录此项/g) ?? []).length, 6, '审查未执行记录的全部缺段归「本次未记录此项」');
  assert.ok(!cText.includes('未开启全文采集'), '审查未执行的记录不得归因未开启全文采集');
  assert.ok(!cText.includes('未取上下文'), '审查未执行的记录不得归因未取上下文');
  assert.ok(!cText.includes('最终审批结果: null'), 'C 行 decision 缺失时模型结论段不渲染');
});

test('审查视图：装配环节超时结算行——环节标签渲染为装配（assembly）（design §8.5.1）', async () => {
  resetHooks();
  const client = loadClient();
  const row = { approvalId: 'apD', callId: 'call_D', toolName: 'pwsh', origin: 'main', escalation: 'danger-full-access', startedAt: 1_700_000_030_000, endedAt: 1_700_000_030_020, queueMs: null, reviewMs: null, humanWaitMs: null, decision: null, outcome: 'rejected', source: 'timeout', model: null, effort: null, risk: null, auth: null, reason: '装配超时：配置读取、审查模型解析或操作回查未在时限内完成', subject: 'npm i', truncated: false };
  const env = makeCtx({
    currentSession: 's1',
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/traceRecords') return { ok: true, value: { records: [row], readFailed: false } };
      if (endpoint === 'approveForMe/traceRecord') return { ok: true, value: { record: { ...row, stage: 'assembly' } } };
      if (endpoint === 'approveForMe/getState') return { ok: true, value: { trace: { capture: 'summary', ownView: true, turnSummary: true } } };
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const view = env.registrations.find((entry) => entry.options.name === 'conversation.view');
  const props = { t: reviewT, useTrajectory: (selector) => selector({ eventNodes: [] }), ...view.options.inject() };
  render(view.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const heads = findAllByClass(render(view.component, props), 'dsafm_review_head');
  assert.equal(heads.length, 1, '恰一条记录');
  heads[0].props.onClick();
  hookIndex = 0;
  render(view.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const text = JSON.stringify(render(view.component, props));
  assert.match(text, /环节: 装配（assembly）/, 'stage=assembly 渲染定稿环节标签');
  assert.match(text, /装配超时/, '理由段携带装配超时原因');
});

test('审查视图：readFailed=true 时显示读取降级提示，详情缺段一律按一级缺省归「本次未记录此项」（design §8.3/§8.5.1）', async () => {
  resetHooks();
  const client = loadClient();
  // A 详情：全文段在场（prompt/output 有值）且无反证，若走常规分派链，evidence/probes 应归可确认专键；
  // 读取降级在场时按 §8.5.1 一级规则统一缺省，不冒充可确认原因。
  const rows = [TRACE_ROWS[0]];
  const detail = { ...TRACE_DETAILS.apA };
  const env = makeCtx({
    currentSession: 's1',
    call: async (endpoint, args) => {
      if (endpoint === 'approveForMe/traceRecords') return { ok: true, value: { records: rows, readFailed: true } };
      if (endpoint === 'approveForMe/traceRecord') return { ok: true, value: { record: args?.approvalId === 'apA' ? detail : null } };
      if (endpoint === 'approveForMe/getState') return { ok: true, value: { trace: { capture: 'summary', ownView: true, turnSummary: true } } };
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const view = env.registrations.find((entry) => entry.options.name === 'conversation.view');
  const props = { t: reviewT, ...view.options.inject() };
  render(view.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const text = JSON.stringify(render(view.component, props));
  assert.match(text, /记录读取失败或不完整，列表可能缺少条目/);
  // 保留范围说明常驻（§10.2）：读取降级不吞掉它。
  assert.match(text, /记录跟随产生它的会话/, '读取降级时保留范围说明仍在场');
  // 点开详情：读取降级的一级分派覆盖常规链——四个缺段全部「本次未记录此项」。
  findAllByClass(render(view.component, props), 'dsafm_review_head')[0].props.onClick();
  hookIndex = 0;
  render(view.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const detailText = JSON.stringify(render(view.component, props));
  assert.equal((detailText.match(/本次未记录此项/g) ?? []).length, 4, '读取降级在场时全部缺段归统一缺省（evidence/probes/reasoning/input）');
  assert.ok(!detailText.includes('未取上下文'), '读取降级时 evidence 缺失不得归「未取上下文」');
  assert.ok(!detailText.includes('未调用取证工具'), '读取降级时 probes 缺失不得归「未调用取证工具」');
  assert.ok(!detailText.includes('模型未提供'), '读取降级时 reasoning 缺失不得归「模型未提供」');
});

test('审查视图 §10.2：tools 大于 0 反证「未调用取证工具」，probes 缺失归统一缺省', async () => {
  resetHooks();
  const client = loadClient();
  // 全文采集证实（prompt/output 在场）、evidence 在场、probes 缺失且 tools=2：已记录计数证伪「未调用」。
  const rows = [{ ...TRACE_ROWS[0], approvalId: 'apT', callId: 'call_T', decision: 'deny', outcome: 'rejected', source: 'llm' }];
  const detail = { ...rows[0], humanWaitMs: 0, prompt: 'PROMPT-T', output: 'OUTPUT-T', evidence: 'EV-T', tools: 2 };
  const env = makeCtx({
    currentSession: 's1',
    call: async (endpoint, args) => {
      if (endpoint === 'approveForMe/traceRecords') return { ok: true, value: { records: rows, readFailed: false } };
      if (endpoint === 'approveForMe/traceRecord') return { ok: true, value: { record: args?.approvalId === 'apT' ? detail : null } };
      if (endpoint === 'approveForMe/getState') return { ok: true, value: { trace: { capture: 'full', ownView: true, turnSummary: true } } };
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const view = env.registrations.find((entry) => entry.options.name === 'conversation.view');
  const props = { t: reviewT, ...view.options.inject() };
  render(view.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  findAllByClass(render(view.component, props), 'dsafm_review_head')[0].props.onClick();
  hookIndex = 0;
  render(view.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const text = JSON.stringify(render(view.component, props));
  // probes 缺失但计数为 2：不得声称「未调用取证工具」；缺段与 input 同归统一缺省（design §8.5.1 反证）。
  assert.ok(!text.includes('未调用取证工具'), 'tools=2 证伪「未调用」，probes 缺失不得归「未调用取证工具」');
  assert.equal((text.match(/本次未记录此项/g) ?? []).length, 2, 'probes 与 input 两段缺失归统一缺省');
  assert.match(text, /取证工具调用: 2/, '详情 tools 计数行在场，矛盾对用户可见');
});

test('审查视图 §10.2：degraded 含 transcript 反证「未取上下文」，evidence 缺失归统一缺省', async () => {
  resetHooks();
  const client = loadClient();
  // 全文采集证实（prompt/output 在场）、probes 在场、evidence 缺失且 degraded 多值含 transcript：
  // 采集环节读取失败由 degraded 段承载，不显示「未取上下文」（design §8.5.1 反证）。
  const rows = [{ ...TRACE_ROWS[0], approvalId: 'apE', callId: 'call_E', decision: 'deny', outcome: 'rejected', source: 'llm' }];
  const detail = { ...rows[0], humanWaitMs: 0, prompt: 'PROMPT-E', output: 'OUTPUT-E', probes: 'grep: ok', degraded: 'cwd,transcript' };
  const env = makeCtx({
    currentSession: 's1',
    call: async (endpoint, args) => {
      if (endpoint === 'approveForMe/traceRecords') return { ok: true, value: { records: rows, readFailed: false } };
      if (endpoint === 'approveForMe/traceRecord') return { ok: true, value: { record: args?.approvalId === 'apE' ? detail : null } };
      if (endpoint === 'approveForMe/getState') return { ok: true, value: { trace: { capture: 'full', ownView: true, turnSummary: true } } };
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const view = env.registrations.find((entry) => entry.options.name === 'conversation.view');
  const props = { t: reviewT, ...view.options.inject() };
  render(view.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  findAllByClass(render(view.component, props), 'dsafm_review_head')[0].props.onClick();
  hookIndex = 0;
  render(view.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const text = JSON.stringify(render(view.component, props));
  assert.ok(!text.includes('未取上下文'), 'degraded 含 transcript 时 evidence 缺失不得归「未取上下文」');
  assert.equal((text.match(/本次未记录此项/g) ?? []).length, 2, 'evidence 与 input 两段缺失归统一缺省');
  assert.match(text, /缺失或异常情况: 会话目录缺失（cwd）、上下文读取失败或截断（transcript）/, '读取失败原因由 degraded 段承载');
});

test('审查视图 §10.2：degraded 含 transcript-read-failed 反证「未取上下文」，文案按专属键', async () => {
  resetHooks();
  const client = loadClient();
  // 读取失败与总量截断各自成键：渲染链（store→bridge→视图）按各自键取词，
  // 反证语义保持——不显示「未取上下文」，具体原因由 degraded 段承载。
  const rows = [{ ...TRACE_ROWS[0], approvalId: 'apR', callId: 'call_R', decision: 'deny', outcome: 'rejected', source: 'llm' }];
  const detail = { ...rows[0], humanWaitMs: 0, prompt: 'PROMPT-R', output: 'OUTPUT-R', probes: 'grep: ok', degraded: 'transcript-read-failed' };
  const env = makeCtx({
    currentSession: 's1',
    call: async (endpoint, args) => {
      if (endpoint === 'approveForMe/traceRecords') return { ok: true, value: { records: rows, readFailed: false } };
      if (endpoint === 'approveForMe/traceRecord') return { ok: true, value: { record: args?.approvalId === 'apR' ? detail : null } };
      if (endpoint === 'approveForMe/getState') return { ok: true, value: { trace: { capture: 'full', ownView: true, turnSummary: true } } };
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const view = env.registrations.find((entry) => entry.options.name === 'conversation.view');
  const props = { t: reviewT, ...view.options.inject() };
  render(view.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  findAllByClass(render(view.component, props), 'dsafm_review_head')[0].props.onClick();
  hookIndex = 0;
  render(view.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const text = JSON.stringify(render(view.component, props));
  assert.ok(!text.includes('未取上下文'), 'degraded 含 transcript-read-failed 时 evidence 缺失不得归「未取上下文」');
  assert.equal((text.match(/本次未记录此项/g) ?? []).length, 2, 'evidence 与 input 两段缺失归统一缺省');
  assert.match(text, /缺失或异常情况: 上下文读取失败（transcript-read-failed）/, '该标记按专属键取词（不用读取失败/截断两义合并的文案）');
  assert.ok(!text.includes('上下文读取失败或截断'), '不得回落读取失败/截断两义合并的文案');
});

test('审查视图 §10.2：output 缺失且 decision=error 归「模型未提供」，无 transcript 反证时不误报（design §8.5.1）', async () => {
  resetHooks();
  const client = loadClient();
  // 全文档记录：prompt 在场证实全文采集（二级分派前提）；decision=error、output 缺失（结算为故障类，
  // 正文未产生）、reasoning 在场——「模型未提供」只可能出自 output 分支（absentKeyOf 二级分派），
  // 不落入统一缺省；degraded 无 transcript（无反证）、tools 无（计数缺失，无从反证）。
  const rows = [{ ...TRACE_ROWS[0], approvalId: 'apO', callId: 'call_O', decision: 'error', outcome: 'rejected', source: 'llm' }];
  const detail = { ...rows[0], humanWaitMs: 0, prompt: 'PROMPT-O', reasoning: 'REASON-O', evidence: 'EV-O', probes: 'PROB-O' };
  const env = makeCtx({
    currentSession: 's1',
    call: async (endpoint, args) => {
      if (endpoint === 'approveForMe/traceRecords') return { ok: true, value: { records: rows, readFailed: false } };
      if (endpoint === 'approveForMe/traceRecord') return { ok: true, value: { record: args?.approvalId === 'apO' ? detail : null } };
      if (endpoint === 'approveForMe/getState') return { ok: true, value: { trace: { capture: 'full', ownView: true, turnSummary: true } } };
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const view = env.registrations.find((entry) => entry.options.name === 'conversation.view');
  const props = { t: reviewT, ...view.options.inject() };
  render(view.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  findAllByClass(render(view.component, props), 'dsafm_review_head')[0].props.onClick();
  hookIndex = 0;
  render(view.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const text = JSON.stringify(render(view.component, props));
  assert.match(text, /PROMPT-O/, '全文段在场（全文采集证实）');
  assert.match(text, /REASON-O/, 'reasoning 在场，排除 reasoning 分支出文案');
  assert.match(text, /模型结论: 失败（error）/, 'decision=error 的模型结论照常渲染');
  // reasoning 在场时唯一一次「模型未提供」只能来自 output 缺失＋decision=error 分支（design §8.5.1）。
  assert.equal((text.match(/模型未提供/g) ?? []).length, 1, 'output 缺失且 decision=error → 模型未提供（§8.5.1 二级分派）');
  assert.equal((text.match(/本次未记录此项/g) ?? []).length, 1, 'input 缺失（全文采集下无反证）→ 本次未记录此项');
  assert.ok(!text.includes('未开启全文采集'), '全文采集证实时 output 缺失不得归「未开启全文采集」');
});

test('审查视图：capture 生效标记三分派——旧记录缺失与 capture=full 全文缺失归统一缺省（design §8.5.1）', async () => {
  resetHooks();
  const client = loadClient();
  // 旧记录（无 capture 字段）与 capture=full 但全文段缺失（模型不可用早退、提示构建抛错）：
  // 「全文段均不在场」不构成「未开启」的证据，全部缺段归「本次未记录此项」（不冒充可确认原因）。
  const rows = [
    { ...TRACE_ROWS[1], approvalId: 'apL', callId: 'call_L', subject: 'legacy edit' },
    { ...TRACE_ROWS[1], approvalId: 'apF', callId: 'call_F', subject: 'full lost edit' },
  ];
  const details = {
    apL: { ...TRACE_ROWS[1], approvalId: 'apL', humanWaitMs: 0, layer: 'session', attempts: 1 },
    apF: { ...TRACE_ROWS[1], approvalId: 'apF', humanWaitMs: 0, layer: 'session', attempts: 2, capture: 'full' },
  };
  const env = makeCtx({
    currentSession: 's1',
    call: async (endpoint, args) => {
      if (endpoint === 'approveForMe/traceRecords') return { ok: true, value: { records: rows, readFailed: false } };
      if (endpoint === 'approveForMe/traceRecord') return { ok: true, value: { record: details[args?.approvalId] ?? null } };
      if (endpoint === 'approveForMe/getState') return { ok: true, value: { trace: { capture: 'summary', ownView: true, turnSummary: true } } };
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const view = env.registrations.find((entry) => entry.options.name === 'conversation.view');
  const props = { t: reviewT, ...view.options.inject() };
  render(view.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  // 点开旧记录：capture 缺失 → 无法确认采集档，六个缺段全部统一缺省。
  const heads = findAllByClass(render(view.component, props), 'dsafm_review_head');
  heads.find((entry) => JSON.stringify(entry).includes('legacy edit')).props.onClick();
  hookIndex = 0;
  render(view.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const legacyText = JSON.stringify(render(view.component, props));
  assert.equal((legacyText.match(/本次未记录此项/g) ?? []).length, 6, 'capture 缺失（旧记录）的全部缺段归统一缺省');
  assert.ok(!legacyText.includes('未开启全文采集'), '无 capture 标记不得判「未开启全文采集」');
  assert.ok(!legacyText.includes('未取上下文'), '旧记录 evidence 缺失不得归「未取上下文」');

  // 切到 capture=full 但全文段缺失：全文未形成（早退/抛错），同样不构成「未开启」的证据。
  hookIndex = 0;
  const heads2 = findAllByClass(render(view.component, props), 'dsafm_review_head');
  heads2.find((entry) => JSON.stringify(entry).includes('full lost edit')).props.onClick();
  hookIndex = 0;
  render(view.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const fullText = JSON.stringify(render(view.component, props));
  assert.equal((fullText.match(/本次未记录此项/g) ?? []).length, 6, 'capture=full 全文段缺失的全部缺段归统一缺省');
  assert.ok(!fullText.includes('未开启全文采集'), 'capture=full 时全文缺失不得误报「未开启全文采集」');
});

test('审查视图：旧格式行（无 outcome）主位＝模型结论并附「未记录最终审批结果」，详情同样说明缺失（design §8.5）', async () => {
  resetHooks();
  const client = loadClient();
  // 旧格式：只有审查行（decision=allow），没有结算行（outcome 缺失）——不冒充最终批准。
  const rows = [{ ...TRACE_ROWS[0], approvalId: 'apD', callId: 'call_D', outcome: undefined }];
  const detail = { ...TRACE_DETAILS.apA, approvalId: 'apD' };
  const env = makeCtx({
    currentSession: 's1',
    call: async (endpoint, args) => {
      if (endpoint === 'approveForMe/traceRecords') return { ok: true, value: { records: rows, readFailed: false } };
      if (endpoint === 'approveForMe/traceRecord') return { ok: true, value: { record: args?.approvalId === 'apD' ? detail : null } };
      if (endpoint === 'approveForMe/getState') return { ok: true, value: { trace: { capture: 'summary', ownView: true, turnSummary: true } } };
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const view = env.registrations.find((entry) => entry.options.name === 'conversation.view');
  const props = { t: reviewT, ...view.options.inject() };
  render(view.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const listText = JSON.stringify(render(view.component, props));
  assert.match(listText, /模型结论：放行（allow）/, '无 outcome 时主位回退为模型结论（design §8.5）');
  assert.match(listText, /未记录最终审批结果/, '行内附「未记录最终审批结果」说明，不冒充最终批准');
  assert.ok(!listText.includes('最终审批：'), '无 outcome 的行不得出现「最终审批：」主位标注');
  // 点开详情：结果缺失同样说明（detail.outcome 行显式标注缺失，而非静默跳过）。
  findAllByClass(render(view.component, props), 'dsafm_review_head')[0].props.onClick();
  hookIndex = 0;
  render(view.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const detailText = JSON.stringify(render(view.component, props));
  assert.match(detailText, /最终审批结果: 未记录最终审批结果/, '详情同样说明结果缺失（design §8.5）');
  assert.match(detailText, /模型结论: 放行（allow）/);
});

test('审查视图 §10.2：enum 探测式取词、多值顿号连接、entry 前缀族、degraded=none 不列段', async () => {
  resetHooks();
  const client = loadClient();
  const rows = [{ ...TRACE_ROWS[0], approvalId: 'apX', decision: 'deny', outcome: 'rejected' }];
  const details = {
    apX: {
      ...rows[0],
      humanWaitMs: 0,
      layer: 'made-up-layer',
      fieldsDefaulted: 'risk,auth',
      degraded: 'queue-overflow,entry:tool-call',
      evidence: 'EV',
    },
  };
  const env = makeCtx({
    currentSession: 's1',
    call: async (endpoint, args) => {
      if (endpoint === 'approveForMe/traceRecords') return { ok: true, value: { records: rows, readFailed: false } };
      if (endpoint === 'approveForMe/traceRecord') return { ok: true, value: { record: details[args?.approvalId] ?? null } };
      if (endpoint === 'approveForMe/getState') return { ok: true, value: { trace: { capture: 'summary', ownView: true, turnSummary: true } } };
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const view = env.registrations.find((entry) => entry.options.name === 'conversation.view');
  const props = { t: reviewT, ...view.options.inject() };
  render(view.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  findAllByClass(render(view.component, props), 'dsafm_review_head')[0].props.onClick();
  hookIndex = 0;
  render(view.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const text = JSON.stringify(render(view.component, props));
  // enum 探测（§10.2）：字典没有 layer.made-up-layer → 不抛错，按 enum.unknown 展示原值。
  assert.match(text, /模型选择来源: made-up-layer（含义未知）/, '未知枚举按「原值（含义未知）」展示');
  // fieldsDefaulted 多值：逐项映射后以顿号连接。
  assert.match(text, /自动补全的字段: 风险分级（risk）、授权分级（auth）/);
  // degraded 多值：逐项映射＋entry 前缀族按 degraded.entry 映射并保留完整原值。
  assert.match(text, /缺失或异常情况: 队列已满（queue-overflow）、单条证据截断（entry:tool-call）/);
});

test('审查视图 §10.2：degraded=none 表示无标记，不渲染该段', async () => {
  resetHooks();
  const client = loadClient();
  const rows = [{ ...TRACE_ROWS[0], approvalId: 'apN' }];
  const detail = { ...rows[0], humanWaitMs: 0, degraded: 'none' };
  const env = makeCtx({
    currentSession: 's1',
    call: async (endpoint, args) => {
      if (endpoint === 'approveForMe/traceRecords') return { ok: true, value: { records: rows, readFailed: false } };
      if (endpoint === 'approveForMe/traceRecord') return { ok: true, value: { record: args?.approvalId === 'apN' ? detail : null } };
      if (endpoint === 'approveForMe/getState') return { ok: true, value: { trace: { capture: 'summary', ownView: true, turnSummary: true } } };
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const view = env.registrations.find((entry) => entry.options.name === 'conversation.view');
  const props = { t: reviewT, ...view.options.inject() };
  render(view.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  findAllByClass(render(view.component, props), 'dsafm_review_head')[0].props.onClick();
  hookIndex = 0;
  render(view.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const text = JSON.stringify(render(view.component, props));
  assert.ok(!text.includes('缺失或异常情况'), 'degraded=none（无标记语义，design §8.2）不渲染该 meta 段');
  assert.ok(!text.includes('none（含义未知）'), 'none 不得按未知枚举展示');
});

test('审批卡片状态条 §10.2：三类原因子句与 deny 空理由省略冒号', async () => {
  resetHooks();
  const client = loadClient();
  const dict = {
    'cardstate.waiting': '等待你决定',
    'cardstate.waiting.deny': '自动审查结论为拒绝：{reason}',
    'cardstate.waiting.timeout': '自动审查超时，未取得有效结论',
    'cardstate.waiting.error': '自动审查未取得有效结论：{reason}',
    'cardcause.other': '其他通道故障（{v}）',
  };
  const renderEntry = async (entry) => {
    resetHooks();
    const env = makeCtx({ currentSession: 's1', call: async () => ({ ok: true, value: { entries: [entry] } }) });
    client.apply(env.ctx);
    const detail = env.registrations.find((item) => item.options.name === 'conversation.approval.detail');
    const t = (key) => dict[key] ?? key;
    const props = { callId: 'call_1', t, useChat: () => 'x', ...detail.options.inject() };
    render(detail.component, props);
    await tick();
    hookIndex = 0;
    return JSON.stringify(render(detail.component, props));
  };
  // deny 且理由为空：省略冒号与理由（design §7.4）。
  const denyEmpty = await renderEntry({ callId: 'call_1', state: 'waiting-human', cause: 'deny', reason: '', startedAt: 1, deadlineAt: null, deadlineKind: null, updatedAt: 1 });
  assert.match(denyEmpty, /等待你决定 · 自动审查结论为拒绝/, 'deny 空理由时省略冒号与理由');
  // timeout：固定文案，不带理由位。
  const timeout = await renderEntry({ callId: 'call_1', state: 'waiting-human', cause: 'timeout', reason: 'ignored', startedAt: 1, deadlineAt: null, deadlineKind: null, updatedAt: 1 });
  assert.match(timeout, /等待你决定 · 自动审查超时，未取得有效结论/);
  // 客户端防御（§10.2）：cause 缺失按 error 展示，未命中类别清单的原因按「其他通道故障（原文）」。
  const noCause = await renderEntry({ callId: 'call_1', state: 'waiting-human', reason: 'boom', startedAt: 1, deadlineAt: null, deadlineKind: null, updatedAt: 1 });
  assert.match(noCause, /等待你决定 · 自动审查未取得有效结论：其他通道故障（boom）/, 'cause 缺失时回退 error 文案并套显示类别');
  assert.ok(!noCause.includes('undefined'));
});

test('审批卡片状态条 §7.4：倒计时按状态锚定，deadlineKind 与状态矛盾（归一化错误）不得使两类时限互串', async () => {
  resetHooks();
  const client = loadClient();
  const dict = {
    'cardstate.reviewing': '正在自动审批',
    'cardstate.waiting': '等待你决定',
    'cardstate.waiting.deny': '自动审查结论为拒绝：{reason}',
    'cardstate.waiting.error': '自动审查未取得有效结论：{reason}',
    'countdown.seconds': '{n}s 后自动拒绝',
    'countdown.minutes': '{m}m {s}s 后自动拒绝',
    'countdown.review': '审查时限剩余 {n}s',
    'countdown.unlimited': '审查无时限',
  };
  const realNow = Date.now;
  const renderEntry = async (entry) => {
    resetHooks();
    const env = makeCtx({ currentSession: 's1', call: async () => ({ ok: true, value: { entries: [entry] } }) });
    client.apply(env.ctx);
    const detail = env.registrations.find((item) => item.options.name === 'conversation.approval.detail');
    const t = (key) => dict[key] ?? key;
    const props = { callId: 'call_1', t, useChat: () => 'x', ...detail.options.inject() };
    render(detail.component, props);
    await tick();
    hookIndex = 0;
    return JSON.stringify(render(detail.component, props));
  };
  try {
    Date.now = () => 1_000_000;
    // 矛盾组合一：交人工却标 review 截止 → 按状态取人工语义（自动拒绝倒计时），不得串显审查时限。
    const swappedKind = await renderEntry({ callId: 'call_1', state: 'waiting-human', cause: 'error', reason: 'r', startedAt: 1, deadlineAt: 1_090_000, deadlineKind: 'review', updatedAt: 1 });
    assert.match(swappedKind, /后自动拒绝/, 'waiting-human 一律按人工截止渲染自动拒绝倒计时');
    assert.ok(!swappedKind.includes('审查时限'), 'deadlineKind 与状态矛盾时不得串显审查时限文案');
    // 矛盾组合二：审查中却标 human 截止 → 按状态取审查语义（审查时限），不得串显自动拒绝。
    const swappedKind2 = await renderEntry({ callId: 'call_1', state: 'reviewing', reason: null, startedAt: 1, deadlineAt: 1_090_000, deadlineKind: 'human', updatedAt: 1 });
    assert.match(swappedKind2, /审查时限剩余/, 'reviewing 一律按审查截止渲染审查时限');
    assert.ok(!swappedKind2.includes('后自动拒绝'), 'deadlineKind 与状态矛盾时不得串显自动拒绝倒计时');
    // 常规组合仍按各自语义：reviewing + review + null 截止 → 回退防御（无倒计时、无退役的无时限文案）。
    const noDeadline = await renderEntry({ callId: 'call_1', state: 'reviewing', reason: null, startedAt: 1, deadlineAt: null, deadlineKind: 'review', updatedAt: 1 });
    assert.ok(!noDeadline.includes('审查无时限'), '退役文案 countdown.unlimited 不得出现');
    assert.ok(!noDeadline.includes('审查时限剩余'), '缺失截止不得渲染倒计时');
  } finally {
    Date.now = realNow;
  }
});

test('字典定稿（§10.2）：中英同键成对，关键文案取定稿值', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx();
  client.apply(env.ctx);
  const { zh, en } = env.dictionaries[0].dicts;
  const zhKeys = Object.keys(zh).sort();
  const enKeys = Object.keys(en).sort();
  assert.deepEqual(zhKeys, enKeys, '中英字典必须同键成对（§10.2 名称表）');
  // 状态机与原因（§7.4）。
  assert.equal(zh['cardstate.reviewing'], '正在自动审批');
  assert.equal(zh['cardstate.waiting'], '等待你决定');
  assert.equal(zh['cardstate.waiting.deny'], '自动审查结论为拒绝：{reason}');
  assert.equal(zh['cardstate.waiting.timeout'], '自动审查超时，未取得有效结论');
  // 退役键零残留（design §7.5）：countdown.unlimited 与 warn.noLimit 属退役分支的键，不得在册。
  assert.equal(zh['countdown.unlimited'], undefined);
  assert.equal(en['countdown.unlimited'], undefined);
  assert.equal(zh['warn.noLimit'], undefined);
  assert.equal(en['warn.noLimit'], undefined);
  // 时限零值 hint 定稿（§7.2.2）。
  assert.equal(zh['hint.reviewer.timeoutMs'], '自动审查的等待上限（毫秒）；0 立即超时。');
  assert.equal(en['hint.reviewer.timeoutMs'], 'Auto-review wait limit (ms); 0 times out immediately.');
  // 列表双标注主槽与回退（§8.5.1）。
  assert.equal(zh['list.outcome'], '最终审批：{v}');
  assert.equal(zh['list.decision'], '模型结论：{v}');
  assert.equal(zh['view.noOutcome'], '未记录最终审批结果');
  // 说明入口（§7.2.1）。
  assert.equal(zh['help.expand'], '说明');
  assert.equal(zh['help.collapse'], '收起说明');
  assert.equal(en['help.expand'], 'Details');
  assert.equal(en['help.collapse'], 'Hide details');
  // 术语定稿抽查（§7.2.2）：执行助手模型/推理强度/自动选择/已单独设置。
  assert.equal(zh['card.map.parent'], '执行助手模型');
  assert.equal(zh['card.map.col.effort'], '推理强度');
  assert.equal(zh['effort.default'], '自动选择');
  assert.equal(en['effort.default'], 'Automatic');
  assert.equal(zh['card.override'], '已单独设置');
  assert.equal(en['card.override'], 'Set individually');
  // 缺段五键与枚举回退（§8.5.1）。
  for (const key of ['absent.noContext', 'absent.noProbes', 'absent.modelNotProvided', 'absent.notFullCapture', 'absent.unknown']) {
    assert.ok(zh[key], `缺段键应在场：${key}`);
    assert.ok(en[key], `缺段键中英成对：${key}`);
  }
  assert.equal(zh['enum.unknown'], '{v}（含义未知）');
  assert.equal(en['enum.unknown'], '{v} (unknown meaning)');
  // 详情段定稿名（§8.5.1）与保留范围（§8.5）。
  assert.equal(zh['detail.outcome'], '最终审批结果');
  assert.equal(zh['detail.decision'], '模型结论');
  assert.equal(zh['detail.source'], '决定方式');
  assert.equal(zh['detail.effort'], '推理强度');
  assert.equal(zh['detail.layer'], '模型选择来源');
  assert.equal(zh['detail.tokens'], '推理 token 用量');
  assert.ok(zh['view.retention'].length > 0, '保留范围文案应在场');

  // 全表逐键断言：期望值逐键转抄自设计定稿表——§7.2.2（字段名称与选项文案／常驻短句／
  // 展开说明／预设多选提示）、§7.3.1（会话控件）、§7.4（状态行）、§8.5.1（详情字段名／列表双标注／
  // 缺段说明／枚举文案）。中英两列都是权威：字典与设计表任何一侧漂移，这里变红。
  const DESIGN_FINAL = [
    // —— §7.2.2 字段名称与选项文案表 ——
    ['card.presets.label', '启用自动审批的权限预设', "Presets that enable auto-approval"],
    ['option.trigger.unknown.skip', '保持宿主原审批流程', "Keep the host approval flow"],
    ['option.trigger.unknown.review', '继续自动审查', "Continue with automatic review"],
    ['field.trigger.auditEverySkip', '逐条记录预设不匹配的审批', "Log every preset-mismatch skip"],
    ['field.trigger.unknown', '无法识别权限预设时', "When the preset cannot be identified"],
    ['card.field.defaultModel', '默认审查模型', "Default reviewer model"],
    ['card.field.parentModelRules', '按执行助手的模型选择审查模型', "Reviewer model by the agent's model"],
    ['card.map.col.scope', '作用范围', "Scope"],
    ['card.map.col.parent', '执行助手模型', "Agent's model"],
    ['card.map.parent', '执行助手模型', "Agent's model"],
    ['card.map.col.reviewer', '审查模型', "Reviewer model"],
    ['card.map.col.effort', '推理强度', "Effort"],
    ['card.map.placeholder.parent', '执行助手模型 id', "Agent model id"],
    ['card.map.placeholder.provider', 'provider id', "Provider id"],
    ['card.map.duplicate', '匹配条件重复：同一作用范围与执行助手模型只能有一条规则。', "Duplicate match condition: one rule per scope and agent model."],
    ['card.map.legacy.title', '旧键含斜杠，请确认原意。', "This legacy key contains a slash; confirm its original meaning."],
    ['option.legacy.any', '任意 provider，模型 id 为 {id}', "Any provider, model id {id}"],
    ['option.legacy.named', '指定 provider {provider}，模型 id 为 {id}', "Provider {provider}, model id {id}"],
    ['card.map.legacy.pending', '确认前按兼容规则读取，原值保留。', "Until confirmed, the key keeps its value and is read per the compatibility rules."],
    ['option.scope.any', '任意 provider', "Any provider"],
    ['option.scope.named', '指定 provider', "Specific provider"],
    ['warn.modelIssue.global', '默认审查模型不可用：{reason}。实际使用：{effective}。', "The default reviewer model is unavailable: {reason}. Currently using: {effective}."],
    ['warn.modelIssue.rule', '此规则选择的审查模型不可用：{reason}。实际使用：{effective}。', "The reviewer model picked by this rule is unavailable: {reason}. Currently using: {effective}."],
    ['warn.modelIssue.session', '本会话选择的审查模型不可用：{reason}。实际使用：{effective}。', "This session's reviewer model is unavailable: {reason}. Currently using: {effective}."],
    ['warn.modelIssue.globalUnset', '默认审查模型未设置：仅当解析实际落到全局默认层（无有效会话选择且无有效映射）时，审查跟随执行助手的当前模型，独立发起审查调用——是「使用相同模型」，不是由执行助手自己审批。', "The default reviewer model is not set: only when resolution actually falls through to the global default (no effective session choice and no effective rule) do reviews follow the agent's current model as an independent call — the same model, never the agent approving itself."],
    ['warn.modelIssue.followParent', '本会话未单独选择审查模型，按未设置的全局默认跟随执行助手的当前模型：独立发起审查调用——是「使用相同模型」，不是由执行助手自己审批。实际使用：{effective}。', "This session has no reviewer of its own and the global default is unset, so reviews follow the agent's current model as an independent call — the same model, never the agent approving itself. Currently using: {effective}."],
    ['warn.modelIssue.globalUnsetShadowed', '默认审查模型未设置：仅当解析落到全局默认层时，审查才跟随执行助手的当前模型并独立发起审查调用。实际使用：{effective}。', "The default reviewer model is not set: reviews follow the agent's current model, as an independent call, only when resolution falls through to the global default. Currently using: {effective}."],
    ['warn.modelIssue.layer', '当前生效：{layer}。', "Currently effective: {layer}."],
    ['field.language.ui', '插件界面语言', "Plugin UI language"],
    ['field.language.agent', '发送给模型的文本语言', "Language of model-facing texts"],
    ['field.reviewer.timeoutMs', '自动审查等待上限（毫秒）', "Auto-review wait limit (ms)"],
    ['field.reviewer.maxTokens', '审查输出上限（token）', "Review output cap (tokens)"],
    ['field.ui.humanCardDuringReview', '审查期间显示人工审批卡片', "Human card during review"],
    ['field.human.timeoutMs', '人工作答等待上限（毫秒）', "Human-answer wait limit (ms)"],
    ['field.human.timeoutFrom', '人工作答等待起算点', "Human timer starts"],
    ['field.allowEscalationTo', '可自动批准的最高权限', "Highest auto-approvable permission"],
    ['field.unknownSubject', '无法识别本次操作时', "When the action cannot be identified"],
    ['option.unknownSubject.reject', '直接拒绝', "Reject"],
    ['option.unknownSubject.review', '带缺失说明继续审查', "Keep reviewing with missing-action notes"],
    ['field.fallback', '自动审查未允许时', "When the review does not approve"],
    ['option.fallback.ask', '交给人工决定', "Ask the human"],
    ['field.ui.inject', '给执行助手的审批通知', "Approval notices to the agent"],
    ['option.ui.inject.all', '允许、拒绝、超时和故障', "Allow, deny, timeout and failures"],
    ['option.ui.inject.reject', '仅拒绝、超时和故障', "Deny, timeout and failures only"],
    ['option.ui.inject.off', '不发送', "Send none"],
    ['field.ui.injectMaxBytes', '通知长度上限（字节）', "Notice length cap (bytes)"],
    ['field.tools', '纳入自动审批的工具', "Tools under auto-approval"],
    ['field.denyPatterns', '文本拒绝规则（每行一条正则表达式）', "Text deny rules (one regex per line)"],
    ['card.override', '已单独设置', "Set individually"],
    ['effort.default', '自动选择', "Automatic"],
    // —— §7.2.2 常驻短句表 ——
    ['hint.trigger.presets', '会话使用清单内权限预设时，由本插件接管升权审批。', "Sessions on a listed permission preset hand escalations to this plugin."],
    ['hint.trigger.unknown', '读不到会话权限预设时的处置。', "What happens when the session preset cannot be read."],
    ['hint.trigger.auditEverySkip', '因预设不匹配跳过的审批是否逐条记录。', "Whether approvals skipped for a preset mismatch are each logged."],
    ['hint.reviewer.model', '全局默认的审查模型与推理强度；未设置时使用执行助手的当前模型。', "Global default reviewer model and effort; unset means the agent's current model."],
    ['hint.reviewer.parentModelRules', '按执行助手模型匹配的规则表：命中时先于全局默认，会话选择更优先。', "Rules matching the agent's model; a hit beats the global default, a session choice beats both."],
    ['hint.language.ui', '插件界面文案的语言。', "Language of the plugin's UI copy."],
    ['hint.language.agent', '发给审查模型的文本与给执行助手的通知，两者使用的语言。', "Language shared by the texts sent to the reviewer and the notices sent to the agent."],
    ['hint.reviewer.timeoutMs', '自动审查的等待上限（毫秒）；0 立即超时。', "Auto-review wait limit (ms); 0 times out immediately."],
    ['hint.reviewer.maxTokens', '审查输出的 token 上限；0 不向模型传输出上限，仍受供应商默认限制。', "Review output cap in tokens; 0 sends no cap to the model, provider defaults still apply."],
    ['hint.ui.humanCardDuringReview', '审查期间是否提前显示人工审批卡片。', "Whether the human card appears early during review."],
    ['hint.human.timeoutMs', '人工作答的等待上限（毫秒）；0 立即拒绝。', "Human-answer wait limit (ms); 0 rejects immediately."],
    ['hint.human.timeoutFrom', '人工作答从何时开始计时：审批请求发出时，或交人工时。', "Where the human-answer timing starts: at the approval request, or at the handoff."],
    ['hint.mode', '总开关；关闭后插件完全不接管。', "Master switch; off means no take-over at all."],
    ['hint.allowEscalationTo', '插件可自动授予的最高权限档；更高的升权不会被自动批准。', "The highest permission tier auto-approval may grant; wider escalations are never auto-approved."],
    ['hint.unknownSubject', '无法辨认本次实际操作时的处置。', "What happens when the action cannot be identified."],
    ['hint.fallback', '自动审查未允许时的处置。', "What happens when the review does not approve."],
    ['hint.ui.inject', '发给执行助手的审批通知范围。', "Which approval notices reach the agent."],
    ['hint.ui.injectMaxBytes', '单条通知的字节上限；0 不裁剪。', "Byte cap per notice; 0 does not trim."],
    ['hint.tools', '纳入自动审批的工具，每行一个；空清单覆盖全部工具。', "Tools under auto-approval, one per line; empty covers all."],
    ['hint.denyPatterns', '每行一条正则表达式；命中即直接拒绝，模型与人工都不能推翻。', "One regex per line; a hit rejects outright, beyond model or human."],
    // —— §7.2.2 展开说明表 ——
    ['help.trigger.presets', '会话使用清单内权限预设时，插件按接管规则处理升权审批；其他预设保持宿主原审批流程。清单为空时，任何已知预设都不接管；无法识别的预设按「无法识别权限预设时」的设置处置。选择接管范围不等于授予任意权限。', 'Sessions on a listed preset hand escalation approvals to this plugin; other presets keep the host flow. An empty list takes over no known preset; unidentifiable presets follow "When the preset cannot be identified". Choosing the take-over range grants no extra permissions.'],
    ['help.trigger.unknown', '读不到会话权限预设时的处置。保持宿主原审批流程＝不接管；继续自动审查＝视为命中接管范围。可能原因包括服务缺失、读取失败或没有可用预设信息。', 'What to do when the session preset cannot be read: keep the host flow means no take-over; continue means treat it as covered. Causes include a missing service, a read failure, or no preset information.'],
    ['help.trigger.auditEverySkip', '开启后，每次因预设不匹配而跳过的审批都逐条记录；关闭时同一会话同一原因只记录一条。只改变跳过记录的数量，不影响接管与审批本身，也不表示所有审批都被审查。', 'On: every preset-mismatch skip is logged; off: one line per session and reason. This only changes the number of skip lines, never the take-over itself, and does not imply every approval is reviewed.'],
    ['help.reviewer.model', '全局默认的审查模型与推理强度。模型引用形如 provider/model；推理强度留空表示自动选择：模型支持 `low` 就使用 `low`，否则不指定、由模型默认值决定，不承诺所有模型都支持或采用相同强度。解析顺序为会话选择 → 按执行助手的模型映射 → 全局默认；全局默认未设置时使用执行助手的当前模型——插件仍独立发起一次审查调用，是「使用相同模型」，不是由执行助手自己审批。', 'Global default reviewer model and effort. The reference reads provider/model; an empty effort is automatic: use `low` when the model supports it, otherwise let the model default decide — no promise that every model supports it or matches the same intensity. Resolution: session choice, by the agent\'s model, global default; an unset default reviews on the agent\'s current model — an independent call, the same model, never the agent approving itself.'],
    ['help.reviewer.parentModelRules', '按执行助手的模型选择审查模型：每条规则含作用范围（任意 provider，或指定 provider 下的完整模型 id）与审查模型、推理强度。会话选择更优先；命中时先于全局默认；未命中按其余层解析。同一作用范围与执行助手模型只能有一条规则，重复的行不能保存。旧字典继续参与匹配：纯模型 id 键按任意 provider 读取；含斜杠的旧键会在表中请求确认原意，确认前按原值读取，不自动改写。', "Picks the reviewer by the model the acting agent uses: each rule carries a scope (any provider, or a specific one) plus the agent's full model id, mapped to a reviewer model and effort. A session choice outranks a hit; a hit outranks the global default; misses fall through to the remaining layers. One rule per scope and agent model — duplicates cannot be saved. The legacy dictionary still matches: plain-id keys read as any-provider; slash-containing keys ask you to confirm their meaning, are read as-is until confirmed, and are never rewritten automatically."],
    ['help.reviewer.timeoutMs', '自动审查的等待上限（毫秒），涵盖装配与等待本次审查结论的全过程，内部重试不另计时。超时按拒绝处理并说明发生环节，不是危险判定。0 立即超时；需要较长等待时设较大的值。', "Auto-review wait limit (ms), covering assembly and the whole wait for this review's conclusion; internal retries get no fresh budget. A timeout rejects with its stage named — not a danger verdict. 0 times out immediately; set a larger value for longer waits."],
    ['help.reviewer.maxTokens', 'token 是模型计量文本的单位。审查输出上限（token）。0 表示不向模型传输出上限，由模型或供应商默认值决定。推理模型可能先把额度用于推理：上限过小可能导致没有有效结论（正文为空，按审查故障处理）；具体数值因模型与推理强度而异，不以个别模型的测量结果作通用保证。', 'A token is the unit models use to measure text. Review output cap (tokens). 0 sends no cap, leaving the model or provider default. Reasoning models may spend the budget on reasoning first: too small a cap can leave no usable conclusion (empty body, treated as a review failure); the threshold varies by model and effort, so no single measurement is a general promise.'],
    ['help.human.timeoutMs', '人工作答等待上限（毫秒），仅在「自动审查未允许时＝交给人工决定」时使用。0 表示立即拒绝，不是无限等待。到点按拒绝结算，原因写明人工作答超时。', 'Human-answer wait limit (ms), used only when the fallback is Ask. 0 rejects immediately, not an endless wait. Expiry settles as a rejection citing the human timeout.'],
    ['help.human.timeoutFrom', '人工作答计时的起点：从审批请求起算＝交人工只使用剩余时间；从交人工起算＝交人工时重新开始计时。', 'Where the human timer starts: from the approval request (the handoff only gets the remainder), or from the handoff itself.'],
    ['help.allowEscalationTo', '可自动批准的最高权限，只限制可送审或允许的升权范围；范围内仍须通过规则检查与模型审查，不等于自动批准全部操作。完全访问（默认）＝最宽；工作区内修改＝超出工作区写入的升权不放行。', "The widest permission auto-approval may grant. It bounds what may be reviewed or allowed; everything in range still passes the rule checks and the review — it is not a blanket approval. Full access (default) is widest; workspace write rejects wider escalations."],
    ['help.unknownSubject', '无法辨认本次实际操作（如回查不到命令或参数）时的处置。直接拒绝＝不调用模型、立即拒绝；带缺失说明继续审查＝携带已取得的参数与上下文继续审查，缺失明确标记，不把缺失当作安全。', 'When the actual action cannot be identified (say, no command or arguments could be recovered): reject refuses at once without the model; keep reviewing submits what was recovered with explicit missing-action marks — missing never counts as safe.'],
    ['help.fallback', '自动审查未允许（拒绝、超时或故障）时的处置。直接拒绝＝按拒绝结算；通知按「给执行助手的审批通知」的设置发送，选择「不发送」时不发任何通知。交给人工决定＝显示人工审批卡片等待你作答，人工作答等待上限到点按拒绝结算。委派子代理没有人工通道：未允许一律拒绝；分叉会话按主会话对待，人工通道在场。', "What happens when the review does not approve (deny, timeout or failure): reject settles as a rejection; notices follow the \"Approval notices to the agent\" setting — send none sends nothing. Ask shows the human card until you answer or the human limit rejects. Delegated subagents have no human channel — not allowed always means rejected; forked sessions are treated as main sessions and keep the human channel."],
    ['help.ui.humanCardDuringReview', '开启时，自动审查进行中即显示人工审批卡片：你可以在审批未完成时抢先作答，人工结果优先；已完成的结果不能由迟到点击推翻。关闭时，仅在确实交给人工后显示卡片。', 'On: the human card shows while the review runs — you may answer first and the human answer wins; a settled result cannot be overturned by a late click. Off: the card appears only once the request is truly handed over.'],
    ['help.ui.inject', '发给执行助手（发起工具操作的 Agent）的审批通知范围：允许、拒绝、超时和故障＝四类都发送；仅拒绝、超时和故障＝允许不发送；选择「不发送」＝一条都不发送。审查记录视图的显示不受本开关影响。', 'Which approval notices reach the acting agent: allow, deny, timeout and failures sends all four; deny, timeout and failures skips allow notices; send none sends no notices. The review-log view is unaffected by this switch.'],
    ['help.ui.injectMaxBytes', '发给执行助手的单条通知的字节上限，超出截断并附截断标记；0 不裁剪。限制对象只是通知，审查记录按会话独立保留，与该上限无关。', 'Byte cap for one notice to the agent; longer text is trimmed with a marker, 0 does not trim. Only notices are capped — review records are kept per session and ignore this limit.'],
    ['help.tools', '纳入自动审批的工具名单，每行一个工具名。空清单覆盖所有工具的升权审批；填写后只处理名单内工具的升权请求，其余工具保持宿主原流程。', "Tools under auto-approval, one name per line. Empty covers every tool's escalations; once filled, only listed tools are handled and the rest keep the host flow."],
    ['help.denyPatterns', '文本拒绝规则，每行一条正则表达式（正则表达式是文本匹配规则，不是完整命令语义分析）。匹配对象是受支持深度内的全部字符串参数值，不只命令字段；包含危险词的说明文本也可能命中。普通正则默认忽略大小写；写成 /source/flags 形式时按所填标志匹配，未写标志时与普通正则一样忽略大小写。命中即直接拒绝：不调用模型、不交人工，模型和人工都不能推翻。空清单只关闭这层文本匹配，可自动批准的最高权限、无法识别操作等其他检查不受影响；不可编译的行跳过，不构成有效保护。', 'Text deny rules, one regex per line (a regex is a text-matching rule, not command semantics). Every string argument within the supported depth is matched, not just the command; harmless prose containing a dangerous word can hit too. Plain patterns are case-insensitive by default; in /source/flags form the given flags apply, and with no flags given it stays case-insensitive like a plain pattern. A hit rejects outright — no model, no human, no override. An empty list disables only this text check; the escalation ceiling and unknown-action handling stay. Uncompilable lines are skipped and protect nothing.'],
    ['help.language.ui', '插件界面文案的语言：跟随宿主界面（auto）或强制中文／英文。保存后下一次渲染生效，不改变发送给模型的文本语言。', "Language of the plugin's own UI copy: follow the host (auto) or force zh/en. Takes effect on the next render and never touches model-facing texts."],
    ['help.language.agent', '发给模型的全部文本的语言（系统提示、策略、工具说明、轮次指引）与给执行助手的通知语言。默认英文。判定与授权规则不随语言改变；与插件界面语言互不影响。', 'Language of every model-facing text (system prompt, policy, tool descriptions, round instructions) and of the notices to the agent. Defaults to English. Rules and authorization never change with the language; the plugin UI language is independent.'],
    ['help.mode', '总开关：规则检查＋LLM 审查＝正常接管；完全不接管＝等同未安装，宿主审批流程不受影响。', 'Master switch: rule check plus LLM review takes over as configured; off behaves as if uninstalled, leaving host approvals untouched.'],
    // —— §7.2.2 预设多选提示表 ——
    ['card.presets.none', '清单为空时，已知预设都不会接管审批；无法识别的预设按「无法识别权限预设时」的设置处置。', 'With an empty list no known preset is taken over; presets that cannot be identified follow "When the preset cannot be identified".'],
    ['card.presets.missing.remedy', '该预设不在宿主当前预设表中。可依次检查：插件是否已停用、宿主版本是否兼容、预设是否为自定义。重新启用插件或重启宿主可能恢复，不保证一定恢复；插件已卸载且配置仍选择该预设时，可改选标准权限档。插件不解析、不改写用户 YAML，不建议手工清理。', "The preset is absent from the host's current table. Check in turn: a disabled plugin, an incompatible host version, or a custom preset. Re-enabling or restarting may restore it, with no guarantee; if the plugin is uninstalled while the config still selects it, pick a standard tier. The plugin never parses or rewrites user YAML, and manual cleanup is not recommended."],
    ['card.presets.unavailable', '读不到预设目录。可能原因：服务缺失、读取失败或没有可用预设信息；可确认权限预设服务可用后重试。', 'The preset catalog is unavailable. Possible causes: a missing service, a read failure, or no preset information; check the permission preset service and retry.'],
    // —— §7.3.1 会话控件表 ——
    ['composer.label', '审查模型', "Reviewer model"],
    ['composer.section.effort', '推理强度', "Effort"],
    ['composer.title', '本会话的审查模型；独立于执行助手调用，点开可只给这个会话指定', "This session's reviewer model — called independently of the agent; pick one to override it for this session only"],
    ['composer.followGlobal', '跟随全局（清除本会话选择）', "Follow global (clear this session)"],
    // —— §7.4 状态行文案表 ——
    ['cardstate.reviewing', '正在自动审批', "Auto-reviewing"],
    ['cardstate.waiting', '等待你决定', "Waiting for your decision"],
    ['cardstate.waiting.deny', '自动审查结论为拒绝：{reason}', "The review concluded deny: {reason}"],
    ['cardstate.waiting.timeout', '自动审查超时，未取得有效结论', "The review timed out without a conclusion"],
    ['cardstate.waiting.error', '自动审查未取得有效结论：{reason}', "The review failed without a conclusion: {reason}"],
    // —— §8.5.1 详情字段名表 ——
    ['detail.outcome', '最终审批结果', "Final approval"],
    ['detail.decision', '模型结论', "Model conclusion"],
    ['detail.source', '决定方式', "Decided by"],
    ['detail.effort', '推理强度', "Effort"],
    ['detail.layer', '模型选择来源', "Model selection source"],
    ['detail.fieldsDefaulted', '自动补全的字段', "Auto-filled fields"],
    ['detail.degraded', '缺失或异常情况', "Missing or degraded conditions"],
    ['detail.tools', '取证工具调用', "Evidence-tool calls"],
    ['detail.tokens', '推理 token 用量', "Reasoning tokens"],
    ['detail.reasoning', '模型返回的推理文本', "Model-returned reasoning"],
    // —— §8.5.1 列表双标注与旧记录表 ——
    ['list.outcome', '最终审批：{v}', "Final approval: {v}"],
    ['list.decision', '模型结论：{v}', "Model conclusion: {v}"],
    ['view.noOutcome', '未记录最终审批结果', "No final outcome recorded"],
    ['view.reasonDefaulted', '审查器未提供理由', "No rationale provided by the reviewer."],
    ['view.retention', '记录跟随产生它的会话；每会话回读最近一个窗口（默认 200 条，随 ui.trace.maxRecords 可配置），磁盘最多保留 50 个会话文件（固定上限），超限删除最旧；减少采集不删除已有记录。', 'Records follow the session that produced them. Each session reads back the most recent window (200 entries by default, configurable via ui.trace.maxRecords); at most 50 session files are kept on disk (a fixed cap), the oldest deleted first. Reducing capture never deletes existing records.'],
    // —— §8.5.1 缺段说明表 ——
    ['absent.noContext', '未取上下文', "No context collected"],
    ['absent.noProbes', '未调用取证工具', "No evidence tools called"],
    ['absent.modelNotProvided', '模型未提供', "Not provided by the model"],
    ['absent.notFullCapture', '未开启全文采集', "Full-text capture was off"],
    ['absent.unknown', '本次未记录此项', "Not recorded for this approval"],
    // —— §8.5.1 枚举文案表 ——
    ['layer.session', '会话选择（session）', "Session choice (session)"],
    ['layer.parent-map', '按执行助手的模型映射（parent-map）', "By the agent's model (parent-map)"],
    ['layer.global', '全局默认（global）', "Global default (global)"],
    ['layer.follow-parent', '全局默认未设置，使用执行助手当前模型（follow-parent）', "Global default unset; using the agent's current model (follow-parent)"],
    ['layer.unavailable', '无可用审查模型（unavailable）', "No usable reviewer model (unavailable)"],
    ['fieldsDefaulted.risk', '风险分级（risk）', "Risk level (risk)"],
    ['fieldsDefaulted.auth', '授权分级（auth）', "Authorization level (auth)"],
    ['fieldsDefaulted.reason', '理由（reason）', "Rationale (reason)"],
    ['degraded.command', '无法辨认本次操作（command）', "Action cannot be identified (command)"],
    ['degraded.cwd', '会话目录缺失（cwd）', "Working directory missing (cwd)"],
    ['degraded.transcript', '上下文读取失败或截断（transcript）', "Context read failure or truncation (transcript)"],
    ['degraded.transcript-read-failed', '上下文读取失败（transcript-read-failed）', "Context read failure (transcript-read-failed)"],
    ['degraded.transcript-truncated', '上下文截断（transcript-truncated）', "Context truncated (transcript-truncated)"],
    ['degraded.entry', '单条证据截断（entry:…）', "Single evidence entry truncated (entry:…)"],
    ['degraded.all', '审查模型解析无可用结果（all）', "No usable reviewer model (all)"],
    ['degraded.output-truncated', '输出截断（output-truncated）', "Output truncated (output-truncated)"],
    ['degraded.output-empty', '空输出（output-empty）', "Empty output (output-empty)"],
    ['degraded.superseded', '已被其他路径先结算（superseded）', "Settled first by another path (superseded)"],
    ['degraded.queue-overflow', '队列已满（queue-overflow）', "Queue full (queue-overflow)"],
    ['degraded.queue-timeout', '排队超时（queue-timeout）', "Queue wait timeout (queue-timeout)"],
    ['degraded.breaker-open', '冷却中未执行（breaker-open）', "Skipped during cooldown (breaker-open)"],
    ['degraded.inject-fail', '通知失败（inject-fail）', "Notice delivery failure (inject-fail)"],
    ['cardcause.modelUnavailable', '审查模型不可用（model unavailable）', "Reviewer model unavailable (model unavailable)"],
    ['cardcause.outputInvalid', '输出无有效结论（{v}）', "No valid conclusion in the output ({v})"],
    ['cardcause.other', '其他通道故障（{v}）', "Other channel failure ({v})"],
    ['cardcause.timeout', '审查超时（review timeout）', "Review timed out (review timeout)"],
    ['enum.unknown', '{v}（含义未知）', "{v} (unknown meaning)"],
  ];
  for (const [key, zhText, enText] of DESIGN_FINAL) {
    assert.equal(zh[key], zhText, `${key} 的中文应等于设计定稿（转抄自 docs/design.md 对应表）`);
    assert.equal(en[key], enText, `${key} 的英文应等于设计定稿（转抄自 docs/design.md 对应表）`);
  }
});

test('审查视图：详情匹配 PTC 子调用行；truncated 标注已截断；拿不到 useTrajectory 时只显示 Z', async () => {
  resetHooks();
  const client = loadClient();
  const rows = [{ ...TRACE_ROWS[0], approvalId: 'apP', callId: 'call_ptc', truncated: true, queueMs: 100, reviewMs: 100, decision: null, outcome: 'rejected', source: 'llm', reason: '危险写入', subject: null }];
  const detail = { ...rows[0], humanWaitMs: 0, prompt: 'P2' };
  const env = makeCtx({
    currentSession: 's1',
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/traceRecords') return { ok: true, value: { records: rows, readFailed: false } };
      if (endpoint === 'approveForMe/traceRecord') return { ok: true, value: { record: detail } };
      if (endpoint === 'approveForMe/getState') return { ok: true, value: { trace: { capture: 'full', ownView: true, turnSummary: true } } };
      return { ok: true, value: {} };
    },
  });
  client.apply(env.ctx);
  const view = env.registrations.find((entry) => entry.options.name === 'conversation.view');
  const propsSub = { t: reviewT, useTrajectory: (selector) => selector(TRAJECTORY_SNAPSHOT), ...view.options.inject() };
  render(view.component, propsSub);
  await tick();
  await tick();
  hookIndex = 0;
  findAllByClass(render(view.component, propsSub), 'dsafm_review_head')[0].props.onClick();
  hookIndex = 0;
  render(view.component, propsSub);
  await tick();
  await tick();
  hookIndex = 0;
  const subText = JSON.stringify(render(view.component, propsSub));
  // 匹配的是 subCalls 里的结算子调用（callTime→time = 1500ms），Z = 100 + 100 + 0 = 200ms，Y = 1300ms。
  assert.match(subText, /工具总计 1\.5 s = 执行 1\.3 s \+ 审批 200 ms/);
  assert.match(subText, /已截断/, 'truncated=true 时标注已截断');

  // 没有 useTrajectory（旧宿主）：只显示 Z，不猜 X，也不崩。
  resetHooks();
  const env2 = makeCtx({
    currentSession: 's1',
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/traceRecords') return { ok: true, value: { records: rows } };
      if (endpoint === 'approveForMe/traceRecord') return { ok: true, value: { record: detail } };
      if (endpoint === 'approveForMe/getState') return { ok: true, value: { trace: { capture: 'full', ownView: true, turnSummary: true } } };
      return { ok: true, value: {} };
    },
  });
  client.apply(env2.ctx);
  const view2 = env2.registrations.find((entry) => entry.options.name === 'conversation.view');
  const props2 = { t: reviewT, ...view2.options.inject() };
  render(view2.component, props2);
  await tick();
  await tick();
  hookIndex = 0;
  findAllByClass(render(view2.component, props2), 'dsafm_review_head')[0].props.onClick();
  hookIndex = 0;
  render(view2.component, props2);
  await tick();
  await tick();
  hookIndex = 0;
  const text2 = JSON.stringify(render(view2.component, props2));
  assert.match(text2, /审批 200 ms/);
  assert.match(text2, /未匹配到工具/);
});

test('设置表单恒渲染：无折叠头、无分区标题，字段与唯一保存首屏在场', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    snapshot: {
      status: 'ready',
      value: { trigger: { presets: ['auto-approve', 'read-only'] } },
      base: {},
      user: {},
      revision: 1,
      writable: true,
    },
  });
  client.apply(env.ctx);
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const props = { t: (key) => key, scope: env.scope, ...card.options.inject() };
  // 不传 view（bundle 槽的现实形态）：容器是 div.dsafm_form，进入即完整表单。
  const form = render(card.component, props);
  const root = findNode(form, 'div');
  assert.equal(root.props.className, 'dsafm_form', '容器应为 div.dsafm_form');
  const flat = JSON.stringify(form);
  // 无折叠头（下拉基元自带 aria-expanded，不在此断言）。
  assert.equal(flat.includes('dsafm_head'), false, '渲染树无折叠头类 dsafm_head');
  assert.equal(flat.includes('dsafm_card'), false, '渲染树无折叠外壳类 dsafm_card');
  // 设置表单不渲染分区标题；唯一保存按钮首屏在场且初始置灰；全局重置不渲染。
  assert.equal(flat.includes('card.section.'), false, '不得出现分区标题');
  assert.notEqual(flat.indexOf('card.save'), -1, '保存控件应首屏在场');
  assert.equal(flat.includes('card.resetAll'), false, '不得出现重置控件');
  assert.equal(findByClass(form, 'dsafm_save').props.disabled, true, '初始无改动时保存置灰');
  // 无 summary 分支：即便宿主传入 view:'summary' 也渲完整表单，不出现一行摘要键。
  hookIndex = 0;
  const asSummary = render(card.component, { ...props, view: 'summary' });
  const flatSummary = JSON.stringify(asSummary);
  assert.equal(flatSummary.indexOf('card.summary.presets'), -1, '不得引用 card.summary.presets');
  assert.notEqual(flatSummary.indexOf('card.save'), -1, 'view:summary 同样渲完整表单');
});

test('写入被宿主拒绝（mutate 解析 false）时显示失败、保留暂存，不报已保存', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({ mutateRejects: true });
  client.apply(env.ctx);
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const props = { t: (key) => key, scope: env.scope, ...card.options.inject() };
  const expanded = await expandCard(card.component, props);
  // 改一个枚举字段（mode）并保存：控制器返回 false → 失败相位 + 错误文案，暂存保留。
  const modeSelect = findAllByClass(expanded, 'dsafm_input').find((node) => node.props.id === 'approve-for-me-ctl-mode');
  assert.ok(modeSelect, '应渲染 mode 字段控件');
  assert.equal(modeSelect.props.value, '', '初始未设置');
  modeSelect.props.onChange({ target: { value: 'rules' } });
  hookIndex = 0;
  const withDraft = render(card.component, props);
  const saveButton = findByClass(withDraft, 'dsafm_save');
  assert.ok(saveButton, '应渲染保存按钮');
  assert.equal(saveButton.props.disabled, false, '有改动时保存可点');
  await saveButton.props.onClick();
  await tick();
  hookIndex = 0;
  const afterTree = render(card.component, props);
  const after = JSON.stringify(afterTree);
  assert.match(after, /card\.failed/, '应显示失败文案');
  assert.equal(after.includes('card.saved'), false, '不应显示已保存');
  assert.equal(env.writes.length, 0, '快照不应被假写入');
  // 失败保留暂存——控件仍显示暂存值，保存仍视为有改动。
  assert.equal(findAllByClass(afterTree, 'dsafm_input').find((node) => node.props.id === 'approve-for-me-ctl-mode').props.value, 'rules', '失败后暂存值应保留');
  assert.equal(findByClass(afterTree, 'dsafm_save').props.disabled, false, '失败后保存仍可重试');
  assert.match(String(findByClass(afterTree, 'dsafm_failed').props.children), /card\.failed/, '失败文案用现行错误别名容器');
});

test('恢复默认：只暂存回退值、保存才落 unset', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    snapshot: {
      status: 'ready',
      value: { fallback: 'ask', mode: 'off', reviewer: { timeoutMs: 95000 } },
      base: { fallback: 'reject', reviewer: { timeoutMs: 60000 } },
      user: { fallback: 'ask', mode: 'off', reviewer: { timeoutMs: 95000 } },
      revision: 3,
      writable: true,
    },
  });
  client.apply(env.ctx);
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const props = { t: (key) => key, scope: env.scope, ...card.options.inject() };
  const tree = await expandCard(card.component, props);
  // 三个覆盖字段都显示覆盖状态：自绘覆盖组（fallback/mode/reviewer.timeoutMs）各有
  // 「已单独设置＋恢复默认」；数字字段的输入仍走官方组件（标签行外置）。
  const resetButtons = findAllByClass(tree, 'dsafm_reset');
  assert.equal(resetButtons.length, 3, `自绘覆盖字段应各有恢复默认，实际 ${resetButtons.length}`);
  const numberMarker = findAllNodes(tree, (node) => node.type === primitivesStub.SettingsValueField)
    .find((node) => node.props.id === 'approve-for-me-ctl-reviewer-timeoutMs');
  assert.ok(numberMarker, 'reviewer.timeoutMs 应走官方数字字段');
  assert.equal(numberMarker.props.overridden, undefined, '官方组件不收 overridden（覆盖组由外壳自绘）');
  assert.equal(numberMarker.props.resetLabel, undefined, '官方组件不收 resetLabel');
  assert.equal(numberMarker.props.onReset, undefined, '官方组件不收 onReset（恢复默认走外壳按钮）');
  assert.equal(numberMarker.props.label, undefined, '官方组件不收 label（标签行由外壳承载）');
  assert.equal(numberMarker.props.text, '95000', '官方组件的显示文本就是生效值');
  // 覆盖标记计数：胶囊 Tag 恰好 3 个（自绘覆盖组含数字字段），官方组件不收覆盖组 props。
  const tags = findAllNodes(tree, (node) => node.type === primitivesStub.Tag && node.props.children === 'card.override');
  assert.equal(tags.length, 3, '已单独设置胶囊应恰好 3 个（fallback/mode/reviewer.timeoutMs）');
  const overriddenMarkers = findAllNodes(tree, (node) => node.type === primitivesStub.SettingsValueField && node.props.overridden === true);
  assert.equal(overriddenMarkers.length, 0, '官方数字字段不带覆盖状态');

  // 点 fallback 的「恢复默认」：控件立即显示组合层默认值 reject，但没写库。
  const fields = findAllByClass(tree, 'dsafm_field');
  const fallbackField = fields.find((field) => JSON.stringify(field).includes('"approve-for-me-ctl-fallback"'));
  assert.ok(fallbackField, 'fallback 字段壳应在场');
  const fallbackReset = findByClass(fallbackField, 'dsafm_reset');
  fallbackReset.props.onClick();
  await tick();
  hookIndex = 0;
  const staged = render(card.component, props);
  const stagedField = findAllByClass(staged, 'dsafm_field').find((field) => JSON.stringify(field).includes('"approve-for-me-ctl-fallback"'));
  const stagedSelect = findAllByClass(stagedField, 'dsafm_input').find((node) => node.type === 'select');
  assert.equal(stagedSelect.props.value, 'reject', '恢复默认后控件应立即显示组合层默认值');
  assert.equal(JSON.stringify(stagedField).includes('card.override'), false, '暂存 clear 后不显示已单独设置');
  assert.equal(env.writes.length, 0, '恢复默认不应写库（保存才落 unset）');

  // 保存：写入 unset（用户层键消失才是真回退）。
  const save = findByClass(staged, 'dsafm_save');
  assert.equal(save.props.disabled, false, '回退是有效改动');
  save.props.onClick();
  await tick();
  const unsets = env.writes.filter((op) => op.op === 'unset' && op.path.join('.') === 'fallback');
  assert.equal(unsets.length, 1, '保存应落 unset');
});

test('保存按钮启用条件：数字字段暂存非法文本阻止保存、改回合法即恢复（requirements §6.1）', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx();
  client.apply(env.ctx);
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const props = { t: (key) => key, scope: env.scope, ...card.options.inject() };
  const tree = await expandCard(card.component, props);
  const timeoutMarker = findAllNodes(tree, (node) => node.type === primitivesStub.SettingsValueField)
    .find((node) => node.props.id === 'approve-for-me-ctl-reviewer-timeoutMs');
  assert.ok(timeoutMarker, 'reviewer.timeoutMs 应走官方数字字段');
  assert.equal(timeoutMarker.props.invalid, false, '初始无非法');
  // 暂存非数字文本：官方组件收到 invalid=true，保存被 blocked，写入零调用。
  timeoutMarker.props.onEdit('abc');
  await tick();
  hookIndex = 0;
  const invalidTree = render(card.component, props);
  const invalidMarker = findAllNodes(invalidTree, (node) => node.type === primitivesStub.SettingsValueField)
    .find((node) => node.props.id === 'approve-for-me-ctl-reviewer-timeoutMs');
  assert.equal(invalidMarker.props.invalid, true, '非法暂存应标记 invalid');
  assert.equal(invalidMarker.props.invalidLabel, 'card.invalidNumber', '非法文案走字典键');
  assert.equal(invalidMarker.props.text, 'abc', '暂存文本保留在控件里');
  assert.equal(findByClass(invalidTree, 'dsafm_save').props.disabled, true, '有非法值时保存必须置灰（requirements §6.1 保存三态）');
  assert.equal(env.writes.length, 0, '非法态不得触发任何写入');
  // 改回合法数字：invalid 消除、保存恢复可点，写入的是合法值。
  invalidMarker.props.onEdit('96000');
  await tick();
  hookIndex = 0;
  const fixedTree = render(card.component, props);
  const fixedMarker = findAllNodes(fixedTree, (node) => node.type === primitivesStub.SettingsValueField)
    .find((node) => node.props.id === 'approve-for-me-ctl-reviewer-timeoutMs');
  assert.equal(fixedMarker.props.invalid, false, '改回合法后 invalid 消除');
  assert.equal(findByClass(fixedTree, 'dsafm_save').props.disabled, false, '合法改动保存可点');
  const save = findByClass(fixedTree, 'dsafm_save');
  save.props.onClick();
  await tick();
  const setOp = env.writes.find((op) => op.op === 'set' && op.path.join('.') === 'reviewer.timeoutMs');
  assert.equal(setOp?.value, 96000, '保存应写入数字值（不是文本）');
});

test('恢复默认的无操作路径：无用户层键时 clear 不产生写入（官方语义）', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx();
  client.apply(env.ctx);
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const props = { t: (key) => key, scope: env.scope, ...card.options.inject() };
  const tree = await expandCard(card.component, props);
  // 先暂存一个改动（mode=off）：暂存写入让覆盖组出现，但用户层并没有这个键。
  const modeSelect = findAllByClass(tree, 'dsafm_input').find((node) => node.props.id === 'approve-for-me-ctl-mode');
  modeSelect.props.onChange({ target: { value: 'off' } });
  await tick();
  hookIndex = 0;
  const stagedTree = render(card.component, props);
  const stagedField = findAllByClass(stagedTree, 'dsafm_field').find((field) => JSON.stringify(field).includes('"approve-for-me-ctl-mode"'));
  const stagedReset = findByClass(stagedField, 'dsafm_reset');
  assert.ok(stagedReset, '暂存写入的字段应出现恢复默认');
  // 点「恢复默认」：用户层本无键 → clear 是无操作 → 保存回到置灰，零写入。
  stagedReset.props.onClick();
  await tick();
  hookIndex = 0;
  const noopTree = render(card.component, props);
  assert.equal(findByClass(noopTree, 'dsafm_save').props.disabled, true, 'clear 无用户键＝无有效改动，保存应置灰');
  assert.equal(env.writes.length, 0, '无操作路径不得产生写入');
  const noopSelect = findAllByClass(noopTree, 'dsafm_input').find((node) => node.props.id === 'approve-for-me-ctl-mode');
  assert.equal(noopSelect.props.value, '', '显示回到组合层默认（未设置）');
});

test('毫秒字段秒数读数：生效值常驻、草稿随输入实时换算', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    snapshot: {
      status: 'ready',
      value: { reviewer: { timeoutMs: 300000 }, human: { timeoutMs: 600000 } },
      base: { reviewer: { timeoutMs: 90000 }, human: { timeoutMs: 300000 } },
      user: { reviewer: { timeoutMs: 300000 }, human: { timeoutMs: 600000 } },
      revision: 1,
      writable: true,
    },
  });
  client.apply(env.ctx);
  const dicts = env.dictionaries[0].dicts;
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const zhProps = { t: (key) => dicts.zh[key] ?? key, scope: env.scope, ...card.options.inject() };
  /** 按读数行 id 找到该行，再在行内取指定类的 span。 */
  const secSpan = (tree, id, cls) => {
    const line = findAllNodes(tree, (node) => node.props?.id === id)[0];
    return line === undefined ? undefined : findAllByClass(line, cls)[0];
  };
  const tree = await expandCard(card.component, zhProps);
  // 两个 ms 字段的生效值读数与快照生效值一致，且初始草稿＝生效值文本（无暂存）。
  assert.equal(secSpan(tree, 'approve-for-me-sec-reviewer-timeoutMs', 'dsafm_sec_resolved').props.children, '生效：300 秒', '审查超时生效值读数 300 秒');
  assert.equal(secSpan(tree, 'approve-for-me-sec-human-timeoutMs', 'dsafm_sec_resolved').props.children, '生效：600 秒', '人工超时生效值读数 600 秒');
  assert.equal(secSpan(tree, 'approve-for-me-sec-reviewer-timeoutMs', 'dsafm_sec_draft').props.children, '草稿：300 秒', '初始草稿读数＝生效值');
  // 键入未保存，同一次输入后的渲染即出现新草稿读数，生效值读数不变（不是保存后才更新）。
  const marker = findAllNodes(tree, (node) => node.type === primitivesStub.SettingsValueField)
    .find((node) => node.props.id === 'approve-for-me-ctl-reviewer-timeoutMs');
  const afterEdit = async (text) => {
    marker.props.onEdit(text);
    await tick();
    hookIndex = 0;
    return render(card.component, zhProps);
  };
  const typed = await afterEdit('120000');
  assert.equal(secSpan(typed, 'approve-for-me-sec-reviewer-timeoutMs', 'dsafm_sec_draft').props.children, '草稿：120 秒', '键入 120000 未保存即出现 120 秒');
  assert.equal(secSpan(typed, 'approve-for-me-sec-reviewer-timeoutMs', 'dsafm_sec_resolved').props.children, '生效：300 秒', '生效值读数不随草稿变化');
  // 草稿与生效值都非 0 时，无上限风险提醒不在场。
  assert.equal(secSpan(typed, 'approve-for-me-sec-reviewer-timeoutMs', 'dsafm_sec_warn'), undefined, '非零时限不显示提醒');
  // 格式边界：整数不带小数点；非整数一位小数（1501 四舍五入到 1.5；999 到 1.0）；0 按字面显示。
  const oneFive = await afterEdit('1500');
  assert.equal(secSpan(oneFive, 'approve-for-me-sec-reviewer-timeoutMs', 'dsafm_sec_draft').props.children, '草稿：1.5 秒', '1500 → 1.5 秒');
  const odd = await afterEdit('1501');
  assert.equal(secSpan(odd, 'approve-for-me-sec-reviewer-timeoutMs', 'dsafm_sec_draft').props.children, '草稿：1.5 秒', '1501 四舍五入到 1.5 秒');
  const sub = await afterEdit('999');
  assert.equal(secSpan(sub, 'approve-for-me-sec-reviewer-timeoutMs', 'dsafm_sec_draft').props.children, '草稿：1.0 秒', '999 → 1.0 秒（非整数秒一位小数）');
  const zero = await afterEdit('0');
  assert.equal(secSpan(zero, 'approve-for-me-sec-reviewer-timeoutMs', 'dsafm_sec_draft').props.children, '草稿：0 秒', '0 按字面显示 0 秒');
  // 草稿为 0 → 零值语义是「立即超时」：退役的提醒分支不渲染，0 仍可保存。
  assert.equal(secSpan(zero, 'approve-for-me-sec-reviewer-timeoutMs', 'dsafm_sec_warn'), undefined, '退役提醒不随 0 草稿出现');
  // en 档单位 s（同一暂存文本，读数跟随语言）。
  const enProps = { t: (key) => dicts.en[key] ?? key, scope: env.scope, ...card.options.inject() };
  hookIndex = 0;
  const enTree = render(card.component, enProps);
  assert.equal(secSpan(enTree, 'approve-for-me-sec-reviewer-timeoutMs', 'dsafm_sec_resolved').props.children, 'Effective: 300 s', 'en 档生效值读数单位 s');
  assert.equal(secSpan(enTree, 'approve-for-me-sec-reviewer-timeoutMs', 'dsafm_sec_draft').props.children, 'Draft: 0 s', 'en 档草稿读数单位 s');
  assert.equal(secSpan(enTree, 'approve-for-me-sec-reviewer-timeoutMs', 'dsafm_sec_warn'), undefined, 'en 档不渲染退役提醒');
});

test('生效值为 0 不渲染退役提醒（保存读回语义）；hint 随处可见「立即超时」语义', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    snapshot: {
      status: 'ready',
      value: { reviewer: { timeoutMs: 0 }, human: { timeoutMs: 600000 } },
      base: {},
      user: {},
      revision: 1,
      writable: true,
    },
  });
  client.apply(env.ctx);
  const dicts = env.dictionaries[0].dicts;
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const props = { t: (key) => dicts.zh[key] ?? key, scope: env.scope, ...card.options.inject() };
  const tree = await expandCard(card.component, props);
  const line = findAllNodes(tree, (node) => node.props?.id === 'approve-for-me-sec-reviewer-timeoutMs')[0];
  assert.ok(line, '审查时限秒数读数行应在场');
  const resolved = findAllByClass(line, 'dsafm_sec_resolved')[0];
  assert.equal(resolved.props.children, '生效：0 秒', '生效值读数为 0 秒');
  assert.equal(findAllByClass(line, 'dsafm_sec_warn').length, 0, '生效值为 0 无退役提醒（退役分支）');
  // 零值语义进入字段 hint（design §7.2.2 定稿）。
  assert.match(dicts.zh['hint.reviewer.timeoutMs'], /0 立即超时/u);
  const marker = findAllNodes(tree, (node) => node.type === primitivesStub.SettingsValueField)
    .find((node) => node.props.id === 'approve-for-me-ctl-reviewer-timeoutMs');
  marker.props.onEdit('120000');
  await tick();
  hookIndex = 0;
  const typed = render(card.component, props);
  const typedLine = findAllNodes(typed, (node) => node.props?.id === 'approve-for-me-sec-reviewer-timeoutMs')[0];
  assert.equal(findAllByClass(typedLine, 'dsafm_sec_draft')[0].props.children, '草稿：120 秒', '草稿读数随键入换算');
  assert.equal(findAllByClass(typedLine, 'dsafm_sec_warn').length, 0, '草稿改非零后仍无退役提醒');
});

test('秒数读数占位：清空与非数字走占位、生效值读数仍在场', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    snapshot: {
      status: 'ready',
      value: { reviewer: { timeoutMs: 300000 } },
      base: { reviewer: { timeoutMs: 90000 } },
      user: { reviewer: { timeoutMs: 300000 } },
      revision: 1,
      writable: true,
    },
  });
  client.apply(env.ctx);
  const dicts = env.dictionaries[0].dicts;
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const props = { t: (key) => dicts.zh[key] ?? key, scope: env.scope, ...card.options.inject() };
  const secSpan = (tree, cls) => {
    const line = findAllNodes(tree, (node) => node.props?.id === 'approve-for-me-sec-reviewer-timeoutMs')[0];
    return line === undefined ? undefined : findAllByClass(line, cls)[0];
  };
  const tree = await expandCard(card.component, props);
  const marker = findAllNodes(tree, (node) => node.type === primitivesStub.SettingsValueField)
    .find((node) => node.props.id === 'approve-for-me-ctl-reviewer-timeoutMs');
  const afterEdit = async (text) => {
    marker.props.onEdit(text);
    await tick();
    hookIndex = 0;
    return render(card.component, props);
  };
  // 清空 → 草稿读数占位、不变色（空不是非法）、生效值读数不变。
  const cleared = await afterEdit('');
  assert.equal(secSpan(cleared, 'dsafm_sec_draft').props.children, '草稿：—', '清空后草稿读数为占位');
  assert.equal(String(secSpan(cleared, 'dsafm_sec_draft').props.className).includes('dsafm_sec_invalid'), false, '空串占位不转错误色');
  assert.equal(secSpan(cleared, 'dsafm_sec_resolved').props.children, '生效：300 秒', '清空后生效值读数不变');
  // 非数字（12x）→ 草稿占位且转错误色，生效值读数仍在场（读数自绘在官方组件之外，不随 hint 被顶掉）。
  const bad = await afterEdit('12x');
  assert.equal(secSpan(bad, 'dsafm_sec_draft').props.children, '草稿：—', '非数字草稿读数为占位');
  assert.equal(String(secSpan(bad, 'dsafm_sec_draft').props.className).includes('dsafm_sec_invalid'), true, '非数字草稿 span 转错误色');
  assert.equal(secSpan(bad, 'dsafm_sec_resolved').props.children, '生效：300 秒', '非数字期间生效值读数仍在场');
  // 同口径校验：-1 与 1.5 与 12x 一样占位（有限、≥0、整数，缺一不可）。
  const negative = await afterEdit('-1');
  assert.equal(secSpan(negative, 'dsafm_sec_draft').props.children, '草稿：—', '-1 非法（<0）→占位');
  const fraction = await afterEdit('1.5');
  assert.equal(secSpan(fraction, 'dsafm_sec_draft').props.children, '草稿：—', '1.5 非法（非整数）→占位');
});

test('秒数读数与「恢复默认」／保存：clear 后按默认值换算、保存写毫秒', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    snapshot: {
      status: 'ready',
      value: { reviewer: { timeoutMs: 300000 } },
      base: { reviewer: { timeoutMs: 90000 } },
      user: { reviewer: { timeoutMs: 300000 } },
      revision: 1,
      writable: true,
    },
  });
  client.apply(env.ctx);
  const dicts = env.dictionaries[0].dicts;
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const props = { t: (key) => dicts.zh[key] ?? key, scope: env.scope, ...card.options.inject() };
  const secSpan = (tree, cls) => {
    const line = findAllNodes(tree, (node) => node.props?.id === 'approve-for-me-sec-reviewer-timeoutMs')[0];
    return line === undefined ? undefined : findAllByClass(line, cls)[0];
  };
  const tree = await expandCard(card.component, props);
  const marker = findAllNodes(tree, (node) => node.type === primitivesStub.SettingsValueField)
    .find((node) => node.props.id === 'approve-for-me-ctl-reviewer-timeoutMs');
  // 恢复默认走外壳复位按钮（官方组件不收 onReset，design §7.2.1）：定位 reviewer.timeoutMs 字段壳触发
  // dsafm_reset 的 onClick（与 fallback 字段同款模式）；控件显示组合层默认值 90000，草稿读数按该文本换算，
  // 生效值读数仍是快照生效值。
  const timeoutField = findAllByClass(tree, 'dsafm_field').find((field) => JSON.stringify(field).includes('"approve-for-me-ctl-reviewer-timeoutMs"'));
  assert.ok(timeoutField, 'reviewer.timeoutMs 字段壳应在场');
  findByClass(timeoutField, 'dsafm_reset').props.onClick();
  await tick();
  hookIndex = 0;
  const reset = render(card.component, props);
  assert.equal(secSpan(reset, 'dsafm_sec_draft').props.children, '草稿：90 秒', 'clear 后草稿读数按默认值 90000 换算');
  assert.equal(secSpan(reset, 'dsafm_sec_resolved').props.children, '生效：300 秒', 'clear 后生效值读数仍是快照生效值');
  assert.equal(env.writes.length, 0, '恢复默认只暂存，不写库');
  // 改 120000 → 保存：写入的是毫秒 120000（不是秒数 120）；保存后生效值读数随新快照变 120 秒。
  marker.props.onEdit('120000');
  await tick();
  hookIndex = 0;
  const staged = render(card.component, props);
  assert.equal(secSpan(staged, 'dsafm_sec_draft').props.children, '草稿：120 秒', '保存前草稿读数已换算');
  const save = findByClass(staged, 'dsafm_save');
  assert.equal(save.props.disabled, false, '有效改动保存可点');
  save.props.onClick();
  await tick();
  await tick();
  hookIndex = 0;
  const saved = render(card.component, props);
  const setOp = env.writes.find((op) => op.op === 'set' && op.path.join('.') === 'reviewer.timeoutMs');
  assert.equal(setOp?.value, 120000, '保存必须写毫秒 120000（换算只在显示层，秒数不得回写）');
  assert.equal(secSpan(saved, 'dsafm_sec_resolved').props.children, '生效：120 秒', '保存后生效值读数随新快照变 120 秒');
  assert.equal(secSpan(saved, 'dsafm_sec_draft').props.children, '草稿：120 秒', '保存成功后草稿读数回落到新生效值文本');
});

test('秒数读数只属毫秒字段：恰好两行，字节／令牌字段无读数', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx();
  client.apply(env.ctx);
  const dicts = env.dictionaries[0].dicts;
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const props = { t: (key) => dicts.zh[key] ?? key, scope: env.scope, ...card.options.inject() };
  const tree = await expandCard(card.component, props);
  const secLines = findAllByClass(tree, 'dsafm_f_sec');
  assert.deepEqual(
    secLines.map((line) => line.props.id).sort(),
    ['approve-for-me-sec-human-timeoutMs', 'approve-for-me-sec-reviewer-timeoutMs'],
    '读数行恰好两个 ms 字段各一行（maxTokens／injectMaxBytes 不做换算）',
  );
  // 快照缺值时生效值读数走占位（不报错、不隐藏）。
  const resolvedSpans = findAllByClass(tree, 'dsafm_sec_resolved');
  assert.equal(resolvedSpans.length, 2, '两个 ms 字段各有生效值 span');
  for (const span of resolvedSpans) assert.equal(span.props.children, '生效：—', '快照缺值时生效值读数为占位');
});

test('中英字典整表键集奇偶：zh 与 en 键集排序后相等（requirements §5.4，秒数键入册）', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx();
  client.apply(env.ctx);
  const dicts = env.dictionaries[0].dicts;
  const zhKeys = Object.keys(dicts.zh).sort();
  const enKeys = Object.keys(dicts.en).sort();
  assert.deepEqual(zhKeys, enKeys, 'zh/en 字典键集必须一一对应（删任一侧一键即红）');
  for (const key of ['seconds.resolved', 'seconds.draft', 'seconds.unit']) {
    assert.ok(zhKeys.includes(key), `zh 侧应有键 ${key}`);
    assert.ok(typeof dicts.zh[key] === 'string' && dicts.zh[key].length > 0, `zh.${key} 应有非空文案`);
    assert.ok(typeof dicts.en[key] === 'string' && dicts.en[key].length > 0, `en.${key} 应有非空文案`);
  }
});

test('离开页面丢弃暂存：重挂载后读快照旧值、保存回到置灰', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx();
  client.apply(env.ctx);
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const props = { t: (key) => key, scope: env.scope, ...card.options.inject() };
  const tree = await expandCard(card.component, props);
  const modeSelect = findAllByClass(tree, 'dsafm_input').find((node) => node.props.id === 'approve-for-me-ctl-mode');
  modeSelect.props.onChange({ target: { value: 'rules' } });
  await tick();
  assert.equal(env.writes.length, 0, '编辑只暂存');
  // 模拟卸载重挂（离开页面再回来）：钩子存储清空＝组件状态归零，只剩快照。
  resetHooks();
  const reopened = await expandCard(card.component, props);
  const reopenedSelect = findAllByClass(reopened, 'dsafm_input').find((node) => node.props.id === 'approve-for-me-ctl-mode');
  assert.equal(reopenedSelect.props.value, '', '重开后应读快照旧值（未设置）');
  assert.equal(findByClass(reopened, 'dsafm_save').props.disabled, true, '重开后保存应回到置灰');
});

test('静态扫描：退役文案与失效令牌零命中、外壳类退役', async () => {
  const client = loadClient();
  assert.ok(client, '模块应可加载');
  // 源码零命中：全局重置、当前生效值行、问号图标（变异验证：加回任一即红）。
  assert.equal(SOURCE.includes('重置全部覆盖'), false, '源码不得含「重置全部覆盖」');
  assert.equal(SOURCE.includes('当前生效值'), false, '源码不得含「当前生效值」');
  assert.equal(SOURCE.includes('QuestionIcon'), false, '自造问号图标零命中');
  assert.equal(SOURCE.includes('Tooltip'), false, '悬停 Tooltip 零命中（帮助为点击内联展开）');
  assert.equal(SOURCE.includes('dsafm_row'), false, '横排行容器类零命中');
  assert.equal(SOURCE.includes('dsafm_section'), false, '分区标题类零命中');
  assert.equal(SOURCE.includes('dsafm_divider'), false, '分区线类零命中');
  assert.equal(SOURCE.includes('dsafm_actions'), false, '旧操作区类零命中');
  // 交付 CSS 串对 0.1.7 令牌表不存在的别名零命中（含官方笔误 bg-layer-4）。
  for (const token of ['--dsw-alias-state-warning-primary', '--dsw-alias-label-error', '--dsw-alias-bg-layer-4']) {
    assert.equal(SOURCE.includes(token), false, `失效令牌零命中：${token}`);
  }
  // 笔误修正：警示色用现行别名 state-warn-primary。
  assert.ok(SOURCE.includes('--dsw-alias-state-warn-primary'), '警示色应使用现行别名');
  // 卡片外观（源码侧）：.dsafm_form 不声明 border/radius/底色。
  const formRule = /\.dsafm_form\{[^}]*\}/u.exec(SOURCE)?.[0] ?? '';
  assert.ok(formRule.length > 0, '应有 .dsafm_form 规则');
  assert.equal(/border(?!-top)/u.test(formRule), false, '.dsafm_form 不带边框');
  assert.equal(formRule.includes('border-radius'), false, '.dsafm_form 不带圆角');
  assert.equal(formRule.includes('background'), false, '.dsafm_form 不带成片底色');
  // 官方规格落点：34px 输入、说明按钮 24×24 最小命中区（文字按钮，内容可撑大）、保存按钮实心与置灰透明度。
  assert.ok(SOURCE.includes('height:34px'), '输入应取官方 34px 规格');
  assert.ok(SOURCE.includes('min-width:24px;min-height:24px'), '说明按钮应为 24×24 最小命中区（design §7.2.1）');
  assert.ok(SOURCE.includes('.dsafm_save:disabled{opacity:.4'), '保存置灰应为官方 opacity .4');
  // 说明按钮（§10.2）：文字按钮继承字体、次级标签色，悬停/展开与聚焦可见（双主题走语义别名）。
  const helpBtnRule = /\.dsafm_helpbtn\{[^}]*\}/u.exec(SOURCE)?.[0] ?? '';
  assert.ok(helpBtnRule.length > 0, '应有 .dsafm_helpbtn 规则');
  assert.equal(/min-width:24px;min-height:24px/.test(helpBtnRule), true, '命中区 24×24');
  assert.equal(helpBtnRule.includes('color:var(--dsw-alias-label-secondary)'), true, '静息态用次级标签色');
  assert.equal(helpBtnRule.includes('font-family:inherit;font-size:12px'), true, '文字随表单字体');
  assert.ok(SOURCE.includes(".dsafm_helpbtn:hover,.dsafm_helpbtn[aria-expanded='true']{color:var(--dsw-alias-label-primary)}"), '悬停/展开转主标签色');
  assert.ok(SOURCE.includes('.dsafm_helpbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary)'), '键盘聚焦轮廓用品牌色');
  // 数字字段承载规则（design §7.2.1）：归零官方根内边距＋收起空标签行两条 numhost 规则在场；
  // 旧分隔线选择器组与 .dsafm_f_help 规则零命中；字段间分隔线回归统一 .dsafm_field + .dsafm_field。
  assert.ok(SOURCE.includes('.dsafm_numhost > div{padding:0}'), 'numhost 承载规则一：官方根内边距归零');
  assert.ok(SOURCE.includes('.dsafm_numhost > div > div:first-child{display:none}'), 'numhost 承载规则二：收起官方空标签行');
  assert.equal(SOURCE.includes('.dsafm_f_sec + div:not(.dsafm_field)'), false, '旧分隔线选择器一应零命中');
  assert.equal(SOURCE.includes('.dsafm_f_help + div:not(.dsafm_field)'), false, '旧分隔线选择器二应零命中');
  assert.equal(SOURCE.includes('dsafm_f_help'), false, '退役类 dsafm_f_help 应零命中');
  assert.ok(SOURCE.includes('.dsafm_field + .dsafm_field{border-top:.5px solid var(--dsw-alias-border-l2)}'), '字段间分隔线统一为 .dsafm_field + .dsafm_field');
  // 醒目提示行分主题取色（design §7.2.0）：浅色取插件内深琥珀 #92400e——requirements §6.5 的 ≥4.5:1 优先于
  // 宿主 warn-label 令牌取值（浅色 amber-600 #dd8629 对 warn-tertiary #fef5e7 仅 2.585:1；宿主静态令牌族
  // 无 amber-800）；深色按宿主 body[data-ds-dark-theme] 机制回 warn-label；背景两主题不动。
  const warnlineRule = /\.dsafm_warnline\{[^}]*\}/u.exec(SOURCE)?.[0] ?? '';
  assert.ok(warnlineRule.length > 0, '应有 .dsafm_warnline 规则');
  assert.equal(warnlineRule.includes('background:var(--dsw-alias-state-warn-tertiary)'), true, '行背景两主题均取 warn-tertiary');
  assert.equal(warnlineRule.includes('color:#92400e'), true, '浅色文字取深琥珀 #92400e（对 #fef5e7 约 6.6:1，requirements §6.5）');
  assert.ok(SOURCE.includes('.dsafm_warnline svg{flex:none;color:#92400e}'), '浅色图标与文字同取深琥珀');
  assert.ok(
    SOURCE.includes('body[data-ds-dark-theme] .dsafm_warnline,body[data-ds-dark-theme] .dsafm_warnline svg{color:var(--dsw-alias-state-warn-label)}'),
    '深色按宿主 data-ds-dark-theme 机制回 warn-label（design §7.2.0 分主题定稿）',
  );
  // 退役文案防回潮（§10.2 退役键零命中判据）：旧键与旧话术在源码零命中。
  for (const word of ['cardstate.timeout', 'cardstate.denied', 'detail.notCaptured', 'detail.absent', '跟随模型默认', '上面两级']) {
    assert.equal(SOURCE.includes(word), false, `退役字样零命中：${word}`);
  }
});

test('近似行：legacyRow 开启时等 uiConversation 并注册定义；缺字段按关处理', async () => {
  resetHooks();
  const client = loadClient();
  const registered = [];
  const events = { register: (definition) => { registered.push(definition); return () => {}; } };
  const zhMap = {
    'legacy.row': '【自动审批】{tool} · {decision} · 耗时 {duration}',
    'legacy.outcome.allowed-once': '放行',
  };
  const env = makeCtx({
    currentSession: 's1',
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/getState') {
        return { ok: true, value: { trace: { capture: 'summary', ownView: true, turnSummary: true, legacyRow: true } } };
      }
      return { ok: true, value: {} };
    },
  });
  env.ctx.get = (name) => (name === 'uiConversation' ? { events } : undefined);
  env.ctx.locale.bind = () => (key) => zhMap[key] ?? key;
  client.apply(env.ctx);
  await tick();
  await tick();
  assert.equal(registered.length, 1, '应注册一次定义');
  const definition = registered[0];
  assert.equal(definition.target, 'trajectory');
  assert.equal(definition.kind, 'approve-for-me-approval-row');

  // 匹配 approval/asked + approval/decided（同 id 配对），其它事件不认。
  const asked = { type: 'approval/asked', seq: 5, time: 1_000, data: { id: 'u1', toolName: 'pwsh' } };
  const decided = { type: 'approval/decided', seq: 6, time: 21_300, data: { id: 'u1', outcome: 'allowed-once' } };
  assert.deepEqual(definition.match(asked), { id: 'approval:u1', role: 'start' });
  assert.deepEqual(definition.match(decided), { id: 'approval:u1', role: 'update' });
  assert.equal(definition.match({ type: 'user/message', seq: 7, data: {} }), null);
  assert.equal(definition.match({ type: 'approval/decided', seq: 8, time: 9, data: { id: '' } }), null, '无 id 的事件不认');

  // 收尾后才成行：文案含工具名、判定与耗时；节点是 context 形状、target=trajectory。
  const midState = definition.start({}, { event: asked });
  assert.equal(definition.buildViewNode({ state: midState }), null, '只有 asked 没有 decided 时不成行');
  const state = definition.update({ state: midState }, { event: decided });
  const context = { key: 'k', kind: definition.kind, id: 'approval:u1', state, start: { event: asked, location: { kind: 'unresolved' } } };
  const node = definition.buildViewNode(context);
  assert.equal(node.target, 'trajectory');
  assert.equal(node.data.node.kind, 'context');
  assert.equal(node.anchorSeq, 5);
  assert.equal(node.data.node.source.plugin, 'dsh-approve-for-me');
  assert.equal(node.data.node.content[0].text, '【自动审批】pwsh · 放行 · 耗时 20.3 s');

  // 缺 legacyRow 字段（host 还没补上）按关处理：不注册、不轮询。
  const off = makeCtx({
    currentSession: 's1',
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/getState') return { ok: true, value: { trace: { capture: 'summary', ownView: true, turnSummary: true } } };
      return { ok: true, value: {} };
    },
  });
  const offRegistered = [];
  off.ctx.get = () => ({ events: { register: (definition2) => { offRegistered.push(definition2); return () => {}; } } });
  client.apply(off.ctx);
  await tick();
  await tick();
  assert.equal(offRegistered.length, 0, 'legacyRow 非 true 时不得注册');

  // RPC 失败也只是不注册，不抛错。
  const failing = makeCtx({ probeOk: false });
  client.apply(failing.ctx);
  await tick();
  assert.equal(registered.length, 1, '失败路径不新增注册');
});

test('审批卡片状态条 §7.4.1：原因原文映射到显示类别，前缀不显示，deny 理由按原文', async () => {
  resetHooks();
  const client = loadClient();
  const dict = {
    'cardstate.waiting': '等待你决定',
    'cardstate.waiting.deny': '自动审查结论为拒绝：{reason}',
    'cardstate.waiting.timeout': '自动审查超时，未取得有效结论',
    'cardstate.waiting.error': '自动审查未取得有效结论：{reason}',
    'cardcause.modelUnavailable': '审查模型不可用（model unavailable）',
    'cardcause.outputInvalid': '输出无有效结论（{v}）',
    'cardcause.other': '其他通道故障（{v}）',
    'cardcause.timeout': '审查超时（review timeout）',
    'degraded.queue-overflow': '队列已满（queue-overflow）',
    'degraded.breaker-open': '冷却中未执行（breaker-open）',
    'degraded.output-empty': '空输出（output-empty）',
    'degraded.output-truncated': '输出截断（output-truncated）',
  };
  const renderEntry = async (entry) => {
    resetHooks();
    const env = makeCtx({ currentSession: 's1', call: async () => ({ ok: true, value: { entries: [entry] } }) });
    client.apply(env.ctx);
    const detail = env.registrations.find((item) => item.options.name === 'conversation.approval.detail');
    const t = (key) => dict[key] ?? key;
    const props = { callId: 'call_1', t, useChat: () => 'x', ...detail.options.inject() };
    render(detail.component, props);
    await tick();
    hookIndex = 0;
    return JSON.stringify(render(detail.component, props));
  };
  const make = (cause, reason) => ({ callId: 'call_1', state: 'waiting-human', cause, reason, startedAt: 1, deadlineAt: null, deadlineKind: null, updatedAt: 1 });
  const mapped = [
    ['model unavailable', '审查模型不可用（model unavailable）'],
    ['审查未执行：queue-overflow', '队列已满（queue-overflow）'],
    ['审查未执行：breaker-open（冷却中，拒绝密集或故障密集）', '冷却中未执行（breaker-open）'],
    ['empty payload', '空输出（output-empty）'],
    ['output truncated', '输出截断（output-truncated）'],
    ['not valid JSON', '输出无有效结论（not valid JSON）'],
    ['invalid outcome: deny', '输出无有效结论（invalid outcome: deny）'],
    ['attempt 2/2: model unavailable', '审查模型不可用（model unavailable）'],
    ['boom', '其他通道故障（boom）'],
  ];
  for (const [reason, expected] of mapped) {
    const text = await renderEntry(make('error', reason));
    assert.ok(text.includes(expected), `${reason} 应显示为 ${expected}`);
    assert.ok(!text.includes('审查未执行：'), `${reason} 不应把固定前缀带进界面`);
    assert.ok(!text.includes('attempt '), `${reason} 不应把重试前缀带进界面`);
  }
  // 原值为空：省去整个括号单元，不留悬空括号。
  const emptyReason = await renderEntry(make('error', ''));
  assert.match(emptyReason, /自动审查未取得有效结论：其他通道故障/);
  assert.ok(!emptyReason.includes('其他通道故障（）'), '空原值不得渲染空括号');
  // 英文界面：同一类别用英文键值（design §7.4.1 组成规则 5）。
  resetHooks();
  const enEnv = makeCtx({ currentSession: 's1', call: async () => ({ ok: true, value: { entries: [make('error', 'model unavailable')] } }) });
  client.apply(enEnv.ctx);
  const enDetail = enEnv.registrations.find((item) => item.options.name === 'conversation.approval.detail');
  const enDict = enEnv.dictionaries[0].dicts.en;
  const enProps = { callId: 'call_1', t: (key) => enDict[key] ?? key, useChat: () => 'x', ...enDetail.options.inject() };
  render(enDetail.component, enProps);
  await tick();
  hookIndex = 0;
  const enText = JSON.stringify(render(enDetail.component, enProps));
  assert.match(enText, /Reviewer model unavailable \(model unavailable\)/, '英文界面显示英文类别单元');
  assert.ok(!enText.includes('审查模型不可用'), '英文界面不得混入中文类别名');
  // deny 的模型理由按原文显示，不套类别。
  const denyReason = await renderEntry(make('deny', 'boom'));
  assert.match(denyReason, /自动审查结论为拒绝：boom/);
  assert.ok(!denyReason.includes('其他通道故障'), 'deny 理由不得被套成通道故障');
});

test('审批卡片状态条 §5.4：强制语言档优先于宿主 t（language.ui=en 时卡片为英文）', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    currentSession: 's1',
    call: async () => ({ ok: true, value: { entries: [{ callId: 'call_1', state: 'waiting-human', cause: 'error', reason: 'model unavailable', startedAt: 1, deadlineAt: null, deadlineKind: null, updatedAt: 1 }] } }),
  });
  client.apply(env.ctx);
  const detail = env.registrations.find((item) => item.options.name === 'conversation.approval.detail');
  const dicts = env.dictionaries[0].dicts;
  const hostT = (key) => dicts.zh[key] ?? key;
  // 宿主 t 为中文（auto 行为），useNsT 走强制英文档；注入顺序保证 useNsT 覆盖槽位默认值。
  const props = { callId: 'call_1', useChat: () => 'x', ...detail.options.inject(), t: hostT, useNsT: () => (key) => dicts.en[key] ?? key };
  // 槽位必须注入 useNsT，卡片才能在强制语言档下取到插件字典；手写桩只保证本用例可判别。
  assert.equal(typeof detail.options.inject().useNsT, 'function', '审批卡片槽位应注入 useNsT');
  render(detail.component, props);
  await tick();
  hookIndex = 0;
  const text = JSON.stringify(render(detail.component, props));
  assert.match(text, /Waiting for your decision/, '强制英文档时卡片状态句为英文');
  assert.match(text, /Reviewer model unavailable \(model unavailable\)/, '强制英文档时类别为英文');
  assert.ok(!text.includes('等待你决定'), '强制英文档不得混入中文卡片文案');
});

test('审查视图 §7.4.1：记录理由先排除再归类，排除项按原文显示', async () => {
  resetHooks();
  const client = loadClient();
  const base = {
    approvalId: 'apX', callId: 'call_X', toolName: 'pwsh', origin: 'main', escalation: null,
    startedAt: 1_700_000_030_000, endedAt: 1_700_000_030_500, queueMs: 0, reviewMs: 500, humanWaitMs: null,
    model: 'zai/glm-5.3', effort: 'low', risk: 'high', auth: 'low', subject: 'npm run build', truncated: false,
  };
  const renderRow = async (row, detailExtra = {}) => {
    resetHooks();
    const detail = { ...row, ...detailExtra };
    const env = makeCtx({
      currentSession: 's1',
      call: async (endpoint) => {
        if (endpoint === 'approveForMe/traceRecords') return { ok: true, value: { records: [row], readFailed: false } };
        if (endpoint === 'approveForMe/traceRecord') return { ok: true, value: { record: detail } };
        if (endpoint === 'approveForMe/getState') return { ok: true, value: { trace: { capture: 'summary', ownView: true, turnSummary: true } } };
        return { ok: true, value: {} };
      },
    });
    client.apply(env.ctx);
    const view = env.registrations.find((entry) => entry.options.name === 'conversation.view');
    const props = { t: reviewT, ...view.options.inject() };
    render(view.component, props);
    await tick();
    await tick();
    hookIndex = 0;
    const listTree = render(view.component, props);
    const head = findAllByClass(listTree, 'dsafm_review_head')[0];
    head.props.onClick();
    hookIndex = 0;
    render(view.component, props);
    await tick();
    await tick();
    hookIndex = 0;
    return JSON.stringify(render(view.component, props));
  };
  // 通道故障行：按显示类别呈现，前缀不显示。
  const channel = await renderRow(
    { ...base, decision: 'error', outcome: 'rejected', source: 'llm', reason: 'model unavailable' },
    { degraded: 'all' },
  );
  assert.match(channel, /审查模型不可用（model unavailable）/);
  // 结算记录 source='error' 且原文为异常文本：未命中也套「其他通道故障」。
  const other = await renderRow({ ...base, decision: null, outcome: 'rejected', source: 'error', reason: 'boom' });
  assert.match(other, /其他通道故障（boom）/);
  // task-error 一类同前缀原因：剥前缀后未命中，同样套「其他通道故障」。
  const taskError = await renderRow({ ...base, decision: null, outcome: 'rejected', source: 'llm', reason: '审查未执行：task-error: exploded' });
  assert.match(taskError, /其他通道故障（task-error: exploded）/);
  assert.ok(!taskError.includes('审查未执行：'));
  // 排除项：deny 理由按原文。
  const deny = await renderRow({ ...base, decision: 'deny', outcome: 'rejected', source: 'llm', reason: 'boom' });
  assert.match(deny, /理由[\s\S]*boom/);
  assert.ok(!deny.includes('其他通道故障'), 'deny 理由不得被归类');
  // 排除项：superseded 的审查记录按原文。
  const superseded = await renderRow(
    { ...base, decision: 'error', outcome: 'rejected', source: 'llm', reason: 'boom' },
    { degraded: 'superseded' },
  );
  assert.ok(!superseded.includes('其他通道故障'), 'superseded 记录不得被归类');
  // 排除项：规则与硬性拦截的说明按原文。
  const rule = await renderRow({ ...base, decision: null, outcome: 'rejected', source: 'rule', reason: '命中规则：rm -rf' });
  assert.ok(!rule.includes('其他通道故障'), '规则理由不得被归类');
  const hard = await renderRow({ ...base, decision: null, outcome: 'rejected', source: 'hard', reason: '硬性危险指令' });
  assert.ok(!hard.includes('其他通道故障'), '硬性拦截理由不得被归类');
  // 排除项：装配环节超时按原文。
  const assembly = await renderRow({ ...base, decision: null, outcome: 'rejected', source: 'timeout', stage: 'assembly', reason: '装配超时：配置读取未完成' });
  assert.ok(!assembly.includes('其他通道故障'), '装配超时理由不得被归类');
  // 审查超时（review timeout）按类别显示。
  const reviewTimeout = await renderRow({ ...base, decision: 'error', outcome: 'rejected', source: 'timeout', stage: 'review', reason: 'review timeout' });
  assert.match(reviewTimeout, /审查超时（review timeout）/);
  // 其余通道故障类别逐项（design §7.4.1 类别清单）。
  const queueOverflow = await renderRow({ ...base, decision: null, outcome: 'rejected', source: 'llm', reason: '审查未执行：queue-overflow' }, { degraded: 'queue-overflow' });
  assert.match(queueOverflow, /队列已满（queue-overflow）/);
  assert.ok(!queueOverflow.includes('审查未执行：'), '队列已满行不得显示固定前缀');
  const queueTimeout = await renderRow({ ...base, decision: null, outcome: 'rejected', source: 'timeout', stage: 'queue', reason: '审查未执行：queue-timeout' });
  assert.match(queueTimeout, /排队超时（queue-timeout）/);
  const breaker = await renderRow({ ...base, decision: 'error', outcome: 'rejected', source: 'llm', reason: '审查未执行：breaker-open（冷却中，拒绝密集或故障密集）' }, { degraded: 'breaker-open' });
  assert.match(breaker, /冷却中未执行（breaker-open）/);
  assert.ok(!breaker.includes('breaker-open（冷却中'), '冷却行不得原样显示英文标记前后缀');
  const emptyOutput = await renderRow({ ...base, decision: 'error', outcome: 'rejected', source: 'llm', reason: 'empty payload' }, { degraded: 'output-empty' });
  assert.match(emptyOutput, /空输出（output-empty）/);
  const truncated = await renderRow({ ...base, decision: 'error', outcome: 'rejected', source: 'llm', reason: 'output truncated' }, { degraded: 'output-truncated' });
  assert.match(truncated, /输出截断（output-truncated）/);
  const notJson = await renderRow({ ...base, decision: 'error', outcome: 'rejected', source: 'llm', reason: 'not valid JSON' });
  assert.match(notJson, /输出无有效结论（not valid JSON）/);
  const invalidOutcome = await renderRow({ ...base, decision: 'error', outcome: 'rejected', source: 'llm', reason: 'invalid outcome: deny' });
  assert.match(invalidOutcome, /输出无有效结论（invalid outcome: deny）/);
  // 装配环节另两样本：装配超时与装配环节计时回调抛错均按原文。
  const assemblyZero = await renderRow({ ...base, decision: null, outcome: 'rejected', source: 'timeout', stage: 'assembly', reason: '审查时限为零，立即超时（不开始尝试）' });
  assert.match(assemblyZero, /审查时限为零，立即超时（不开始尝试）/);
  assert.ok(!assemblyZero.includes('其他通道故障'), '零时限装配理由不得被归类');
  const assemblyTimer = await renderRow({ ...base, decision: null, outcome: 'rejected', source: 'timeout', stage: 'assembly', reason: '计时回调抛错（assembly）：boom' });
  assert.match(assemblyTimer, /计时回调抛错（assembly）：boom/);
  assert.ok(!assemblyTimer.includes('其他通道故障'), '装配计时回调抛错不得被归类');
  // 排除项优先于固定标记匹配：拒绝理由即使恰为固定标记也按原文。
  const denyMarker = await renderRow({ ...base, decision: 'deny', outcome: 'rejected', source: 'llm', reason: 'model unavailable' });
  assert.match(denyMarker, /model unavailable/);
  assert.ok(!denyMarker.includes('审查模型不可用'), 'deny 理由恰为固定标记时也不得套类别');
  // 协议回落值：显示中文改写，不出现英文句。
  const defaulted = await renderRow({ ...base, decision: 'deny', outcome: 'rejected', source: 'llm', reason: DEFAULT_RATIONALE });
  assert.match(defaulted, /审查器未提供理由/);
  assert.ok(!defaulted.includes('No rationale provided by the reviewer.'));
});

test('触发器样式 §7.3.2：两段规则在场、固定宽度上限与旧类名零残留', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  assert.ok(source.includes('.dsafm_seat_model{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'), '缺模型段规则');
  assert.ok(source.includes('.dsafm_seat_effort{flex:none;white-space:nowrap}'), '缺档位段规则');
  assert.ok(source.includes('.dsafm_seat_pending{flex:0 1 auto;min-width:0;font-size:11px;color:var(--dsw-alias-state-warn-primary);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'), '待生效提示段缺收缩规则或既有属性');
  assert.ok(source.includes('.dsafm_badge{flex:none;font-size:11px;color:var(--dsw-alias-state-warn-primary);margin-left:6px}'), '失败徽标缺 flex:none、字号或间距');
  assert.ok(source.includes('.dsafm_state{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-weight:500;word-break:normal;overflow-wrap:break-word}'), '状态行缺按词换行规则');
  assert.ok(source.includes('cursor:pointer;min-width:0;max-width:100%}'), '触发器缺宽度上限');
  assert.ok(!source.includes('dsafm_seat_name'), '旧类名不得残留');
  assert.ok(!source.includes('max-width:160px'), '固定宽度上限不得残留');
  assert.ok(source.includes('.dsafm_chevron{flex:0 0 auto;color:var(--dsw-alias-label-tertiary)}'), '公共箭头规则应保持不变');
});
