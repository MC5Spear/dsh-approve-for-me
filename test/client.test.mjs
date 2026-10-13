import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFileSync } from 'node:fs';

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
    // options.mutateRejects=true 模拟拒绝（快照不变化——recovery 已把宿主状态回读对齐）。
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
 * 渲染设置卡片并展开：折叠头点一次，副作用用 tick 推进。
 * @param {Function} component - 卡片组件。
 * @param {object} props - 属性。
 * @returns {Promise<object>} 展开后的元素树。
 */
async function expandCard(component, props) {
  // 表单恒渲染，无折叠可展开：保留原有渲染/时钟节奏，仅去掉折叠头点击。
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
  // 会话视图（设计 §8.5）：`list` 座位按 priority 再 order 升序，20 排在 chat(0)/trajectory(10) 之后；
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
  // 21 个字段（FIELDS 17 行 + 预设/模型/映射/跟随 4 个结构化字段）都必须有常驻说明 `hint.<path>` 与展开帮助 `help.<path>`。
  for (const path of ['trigger.presets', 'trigger.unknown', 'trigger.auditEverySkip', 'reviewer.model', 'reviewer.byParentModel', 'reviewer.followParent', 'language.ui', 'language.agent', 'reviewer.timeoutMs', 'reviewer.maxTokens', 'ui.humanCardDuringReview', 'human.timeoutMs', 'human.timeoutFrom', 'mode', 'allowEscalationTo', 'unknownSubject', 'fallback', 'ui.inject', 'ui.injectMaxBytes', 'tools', 'denyPatterns']) {
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
  // 覆盖组文案（官方词表）：「已覆盖」「恢复默认」与数字非法提示，中英成对。
  for (const key of ['card.override', 'card.resetField', 'card.invalidNumber']) {
    assert.ok(dicts.zh[key], `缺中文 ${key}`);
    assert.ok(dicts.en[key], `缺英文 ${key}`);
  }
  // 退役键零命中（字典侧）——分区标题、全局重置、当前生效值、已保存横幅。
  for (const key of ['card.resetAll', 'card.resolved', 'card.saved', 'card.invalid', 'card.section.trigger', 'card.section.model', 'card.section.advanced']) {
    assert.equal(dicts.zh[key], undefined, `退役键不应再存在：${key}`);
    assert.equal(dicts.en[key], undefined, `英文退役键不应再存在：${key}`);
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
  assert.equal(serialized.includes('dsafm_head'), false, '折叠头已移除，不应再有 dsafm_head');
  assert.equal(serialized.includes('dsafm_card'), false, '折叠外壳已移除，不应再有 dsafm_card');
  // 退役键在渲染树里零命中（删除重置按钮/分区标题/生效值行后这些断言把关）。
  assert.equal(serialized.includes('card.resetAll'), false, '不应再有「重置全部覆盖」');
  assert.equal(serialized.includes('card.section.'), false, '不应再有分区标题');
  assert.equal(serialized.includes('card.resolved'), false, '不应再有「当前生效值」灰字行');
  // 字段竖排：自绘字段一个 dsafm_field 壳（17＝21 字段－4 个官方数字字段），数字字段走官方组件标记；
  // 覆盖字段有「已覆盖」＋「恢复默认」。
  const fields = findAllByClass(form, 'dsafm_field');
  assert.equal(fields.length, 17, `自绘字段壳数量应＝17，实际 ${fields.length}`);
  const markers = findAllNodes(form, (node) => node.type === primitivesStub.SettingsValueField);
  assert.equal(markers.length, 4, '数字字段应走官方 SettingsValueField（timeoutMs/maxTokens/human.timeoutMs/injectMaxBytes）');
  assert.equal(fields.length + markers.length, 21, '字段总数应＝21');
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

test('跟随主模型复选框行内落在标签行右端，不单独占一行', () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    snapshot: {
      status: 'ready',
      value: { reviewer: { followParent: true } },
      base: {},
      user: {},
      revision: 1,
      writable: true,
    },
  });
  client.apply(env.ctx);
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const form = render(card.component, { t: (key) => key, scope: env.scope });
  const fields = findAllByClass(form, 'dsafm_field');
  const field = fields.find((node) => JSON.stringify(node).includes('card.field.followParent'));
  assert.ok(field, '跟随主模型字段应在场');
  // 勾在标签行（.dsafm_f_head → .dsafm_inlinecheck）内，且全字段唯一一个复选框——不孤悬在标签下方。
  const head = findAllByClass(field, 'dsafm_f_head')[0];
  assert.ok(head, '字段应有标签行');
  const inline = findAllByClass(field, 'dsafm_inlinecheck');
  assert.equal(inline.length, 1, '行内控件槽应恰好一个');
  const checkbox = findAllNodes(field, (node) => node.type === 'input' && node.props?.type === 'checkbox');
  assert.equal(checkbox.length, 1, '字段内只应有一个复选框');
  assert.equal(checkbox[0].props.id, 'approve-for-me-ctl-reviewer-followParent');
  assert.ok(JSON.stringify(head).includes('approve-for-me-ctl-reviewer-followParent'), '复选框必须在标签行内');
  assert.equal(checkbox[0].props.checked, true, '勾选态就是生效值');
  assert.equal(typeof checkbox[0].props.onChange, 'function', '勾选仍走暂存通道');
  // 勾选只暂存：onChange 后保存按钮才解除置灰（启用条件同上，不因行内化回退成选中即写）。
});

test('帮助点击展开：aria-expanded/aria-controls 成对，文本进入 DOM', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx();
  client.apply(env.ctx);
  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const props = { t: (key) => key, scope: env.scope };
  const first = render(card.component, props);
  // 每个自绘字段壳都有一个帮助按钮：aria-expanded=false + aria-controls 指向展开区 id。
  const buttons = findAllByClass(first, 'dsafm_helpbtn');
  assert.equal(buttons.length, 17, `自绘字段的帮助按钮应 17 个（21 字段－4 个官方数字字段），实际 ${buttons.length}`);
  const iconNodes = findAllNodes(first, (node) => node.type === primitivesStub.IconInfoOutlineRegular);
  assert.equal(iconNodes.length, 17, '帮助按钮图标统一用官方 IconInfoOutlineRegular');
  assert.equal(JSON.stringify(first).includes('Tooltip'), false, '设置界面不应再用 Tooltip');
  for (const button of buttons) {
    assert.equal(button.props['aria-expanded'], false, '初始未展开');
    assert.ok(button.props['aria-controls'], '帮助按钮必须带 aria-controls');
    assert.ok(button.props['aria-label'], '帮助按钮必须带 aria-label');
  }
  // 点击 mode 字段的帮助：重渲染后 aria-expanded=true，帮助文本进入 DOM。
  const modeButton = buttons.find((button) => button.props['aria-controls'] === 'approve-for-me-help-mode');
  assert.ok(modeButton, 'mode 字段的帮助按钮应在场');
  modeButton.props.onClick();
  hookIndex = 0;
  const open = render(card.component, props);
  const openButtons = findAllByClass(open, 'dsafm_helpbtn');
  const reopened = openButtons.find((button) => button.props['aria-controls'] === 'approve-for-me-help-mode');
  assert.equal(reopened.props['aria-expanded'], true, '点击后应 aria-expanded=true');
  const regions = findAllByClass(open, 'dsafm_helpregion');
  assert.equal(regions.length, 1, '只展开被点击的字段');
  assert.equal(regions[0].props.id, 'approve-for-me-help-mode');
  assert.match(JSON.stringify(regions[0].props.children), /help\.mode/, '帮助文本应进入 DOM');
  // 再点一次收起。
  reopened.props.onClick();
  hookIndex = 0;
  const closed = render(card.component, props);
  assert.equal(findAllByClass(closed, 'dsafm_helpregion').length, 0, '再次点击应收起');
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
            preset: 'auto-approve', active: true, preset: 'auto-approve', sessionModel: null, globalDefault: 'zai/glm-5.3', byParentModel: {}, effective: 'zai/glm-5.3', layer: 'global' } };
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
  // 标题/描述键已随折叠头一并退役：中英两侧都不得再出现（退役名即幻觉源）。
  assert.equal('card.title' in dicts.zh, false);
  assert.equal('card.title' in dicts.en, false);
  assert.equal('card.description' in dicts.zh, false);
  assert.equal('card.description' in dicts.en, false);
  assert.equal('card.summary.presets' in dicts.zh, false);
  assert.equal('card.summary.presets' in dicts.en, false);

  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const tree = render(card.component, { t: (key) => key, scope: env.scope, rpcCall: env.rpcCall });
  const flat = JSON.stringify(tree);
  assert.equal(flat.includes('dsafm_head_meta'), false, '折叠头元信息块已移除');
  assert.equal(flat.includes('dsafm_title'), false, '卡片自带标题已移除');
  assert.equal(flat.includes('dsafm_desc'), false, '卡片自带描述已移除');
});

test('默认审查模型行：模型与档位两个下拉，换模型只暂存、保存才写 scope', async () => {
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
  assert.ok(effortSelect, '未渲染档位下拉');
  assert.deepEqual(effortSelect.props.children.map((option) => option.props.value), ['', 'low', 'high']);
  assert.equal(effortSelect.props.children[0].props.children, 'effort.default', '首项应当是跟随模型默认');
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

test('按主模型映射：键为纯 id 时展示全引用，增删行只暂存、保存写入键仍是纯 id', async () => {
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
  assert.equal(findByClass(tree, 'dsafm_map_parent').props.value, 'deepseek/deepseek-chat', '纯 id 键应当拼上 provider 展示');

  // 字段壳：标签行（labelgroup）＋全宽表（map 容器即控件本体，id 挂在容器上）。
  assert.ok(findByClass(tree, 'dsafm_map'), '映射表缺自己的容器');
  assert.equal(findByClass(tree, 'dsafm_map').props.id, 'approve-for-me-ctl-reviewer-byParentModel', '控件 id 应挂在表容器上');
  assert.ok(findAllByClass(tree, 'dsafm_f_label').some((node) => node.props.children === 'card.field.byParentModel'), '字段应有标签行');
  const head = findByClass(tree, 'dsafm_map_head');
  assert.ok(head, '缺表头行');
  assert.deepEqual(
    head.props.children.map((cell) => cell.props.children),
    ['card.map.col.parent', 'card.map.col.reviewer', 'card.map.col.effort', 'card.map.col.action'],
  );
  const mapRow = findAllByClass(tree, 'dsafm_map_row')[0];
  assert.equal(findByClass(mapRow, 'dsafm_map_parent').props.title, 'deepseek/deepseek-chat', '主模型下拉的 title 应当是完整引用');
  assert.equal(findByClass(mapRow, 'dsafm_model').props.title, 'zai/glm-5.3', '审查模型下拉的 title 应当是当前值');
  assert.equal(findByClass(mapRow, 'dsafm_effort').props.title, 'low', '档位下拉的 title 应当是当前档位');
  assert.match(String(findByClass(mapRow, 'dsafm_map_del').props.className), /dsafm_button/, '删除按钮沿用 dsafm_button');
  assert.match(String(findByClass(tree, 'dsafm_map_add').props.className), /dsafm_button/, '添加一行沿用 dsafm_button');

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

  // 删掉现存行再保存：写入只剩空映射是「有改动」，键归一化发生在保存计划。
  findAllByClass(removed, 'dsafm_map_del')[0].props.onClick();
  hookIndex = 0;
  const emptied = render(card.component, props);
  const save = findByClass(emptied, 'dsafm_save');
  assert.equal(save.props.disabled, false, '删掉现存行是有效改动');
  save.props.onClick();
  await tick();
  const mapped = env.writes.filter((op) => op.path.join('.') === 'reviewer.byParentModel');
  assert.ok(mapped.length >= 1, '未写入映射表');
  assert.deepEqual(mapped[mapped.length - 1].value, {}, '删除全部行应写入空映射');
});

test('接管工具名单：label 走字典键 field.tools，help.tools 中英同步（requirements §5.4）', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx();
  client.apply(env.ctx);
  const dicts = env.dictionaries[0].dicts;
  assert.equal(dicts.zh['help.tools'], '留空 = 对所有工具生效；填了则只接管名单内工具的审批请求，其余工具仍走原有人工审批。');
  assert.match(dicts.en['help.tools'], /Tools taken over \(one per line\)/);
  // 字段标签进字典：zh 保留现名，en 有对译；两语言必须同键同在。
  assert.equal(dicts.zh['field.tools'], '接管工具名单（每行一个）');
  assert.equal(dicts.en['field.tools'], 'Managed tools (one per line)');

  const card = env.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  const tree = await expandCard(card.component, { t: (key) => key, scope: env.scope, rpcCall: env.rpcCall });
  const serialized = JSON.stringify(tree);
  assert.match(serialized, /field\.tools/, '无 locale.bind 时行标签渲染字典键（与 help 键同口径）');
  assert.doesNotMatch(serialized, /工具白名单/);
  assert.doesNotMatch(serialized, /接管工具名单（每行一个）/, '标签文本不得再硬编码在渲染树里');
  // 用真字典取词渲染时，标签是 zh 现名（行为差异断言，不是存在性）。
  const treeZh = await expandCard(card.component, { t: (key) => dicts.zh[key] ?? key, scope: env.scope, rpcCall: env.rpcCall });
  assert.match(JSON.stringify(treeZh), /接管工具名单（每行一个）/);
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
  assert.equal(zh.t('field.tools'), '接管工具名单（每行一个）');
  assert.equal(en.t('field.tools'), 'Managed tools (one per line)');
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
  const dropdown = env.registrations.find((entry) => entry.options.name === 'conversation.input.left');
  const props = { t: (key) => key, ...dropdown.options.inject() };
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
  assert.ok(ids.includes('__effort__'), '缺「跟随模型默认」档位项');
  assert.ok(ids.includes('__effort__:low') && ids.includes('__effort__:high'), '缺模型支持的档位项');
  assert.match(JSON.stringify(menu.props.anchor.props.children), /zai\/glm-5\.3 · low/, '触发器应显示模型与档位');

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
  const dropdown = env.registrations.find((entry) => entry.options.name === 'conversation.input.left');
  const props = { t: (key) => key, ...dropdown.options.inject() };
  render(dropdown.component, props);
  await tick();
  await tick();
  hookIndex = 0;
  const tree = render(dropdown.component, props);
  const menu = findNode(tree, primitivesStub.Menu);
  const ids = menu.props.items.filter((item) => typeof item.id === 'string').map((item) => item.id);
  assert.equal(ids.includes('__effort__'), false, '无模型时不应出现档位段');
  assert.match(JSON.stringify(menu.props.anchor), /composer\.followGlobalShort/, '未配置时触发器应当显示跟随全局');
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
  assert.equal(seat.props.title, 'composer.pendingSession', '改为说明「会话开始后生效」');
  assert.match(JSON.stringify(seat.props.children), /composer\.pendingSession/);
  // 不再出现「会话未激活，请先发一条消息」这类阻止性提示。
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

test('按主模型映射：多斜杠输入取末段为键，暂存后由保存写入（design §6.2）', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    snapshot: {
      status: 'ready',
      value: { reviewer: { byParentModel: {} } },
      base: {},
      user: {},
      revision: 1,
      writable: true,
    },
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/modelCatalog') {
        return { ok: true, value: { providers: [{ id: 'deepseek', models: [{ id: 'deepseek-chat' }] }] } };
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
  const added = render(card.component, props);
  const parentSelect = findAllByClass(added, 'dsafm_map_parent')[0];
  parentSelect.props.onChange({ target: { value: 'a/b/c' } });
  await tick();
  assert.equal(env.writes.length, 0, '输入只暂存，不应写库');
  hookIndex = 0;
  const staged = render(card.component, props);
  const save = findByClass(staged, 'dsafm_save');
  assert.equal(save.props.disabled, false, '有改动后保存应可点');
  save.props.onClick();
  await tick();
  const mapped = env.writes.filter((op) => op.path.join('.') === 'reviewer.byParentModel');
  assert.ok(mapped.length >= 1, '未写入映射表');
  assert.deepEqual(Object.keys(mapped[mapped.length - 1].value), ['c'], '多斜杠输入应当只取末段作键');
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
  // 与 client.js 的 FIELDS 对齐：字段路径 → 选项集合（bool 是 true/false）。
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

test('composer 下拉：权限预设一变就立即重拉（design §7.3，不再等轮询）', async () => {
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
          return { ok: true, value: { entries: [{ callId: 'call_1', state: 'denied', reason: '删除系统目录', startedAt: clock, deadlineAt: clock + 90_000, deadlineKind: 'human', updatedAt: clock }] } };
        }
        return { ok: true, value: {} };
      },
    });
    client.apply(env.ctx);
    const detail = env.registrations.find((entry) => entry.options.name === 'conversation.approval.detail');
    // `t` 用真实中文模板（带 `{reason}` 占位符），否则状态行里的原因替换不会发生。
    const t = (key) =>
      ({
        'cardstate.denied': '自动审批拒绝；原因：{reason}',
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
    assert.match(text, /自动审批拒绝/, '缺少「自动审批拒绝」状态行');
    assert.match(text, /删除系统目录/, '状态行必须带拒绝原因');
    assert.match(text, /剩余 1 分 30 秒后自动拒绝/, '缺少倒计时（90 秒 → 分秒格式）');
    assert.match(text, /rm -rf \/tmp\/x/, '接管 seat 后必须自己渲染关联命令');
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

test('审批卡片状态条：审查中显示审查时限，无时限时说明不会自动拒绝', async () => {
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
    assert.match(text, /countdown\.unlimited/, '审查无时限时应说明没有自动拒绝时限');
  } finally {
    Date.now = realNow;
  }
});

test('审批卡片状态条：非审查状态的 null 截止不渲染任何无时限等待文案（design §7.4）', async () => {
  resetHooks();
  const client = loadClient();
  // 人工零时限立即结算：理论上不该出现该状态；万一出现（denied/timeout + null 截止），
  // 也不得显示「无时限等待」——只显示状态与原因（design §7.4）。
  const env = makeCtx({
    currentSession: 's1',
    call: async () => ({ ok: true, value: { entries: [{ callId: 'call_1', state: 'denied', reason: '风险高', startedAt: 1, deadlineAt: null, deadlineKind: null, updatedAt: 1 }] } }),
  });
  client.apply(env.ctx);
  const detail = env.registrations.find((entry) => entry.options.name === 'conversation.approval.detail');
  const t = (key) => ({ 'cardstate.denied': '自动审批拒绝；原因：{reason}', 'countdown.unlimited': '审查不限时', 'countdown.none': '无自动拒绝时限，将一直等待你的决定' })[key] ?? key;
  const props = { callId: 'call_1', t, useChat: () => 'rm x', ...detail.options.inject() };
  render(detail.component, props);
  await tick();
  hookIndex = 0;
  const text = JSON.stringify(render(detail.component, props));
  assert.match(text, /自动审批拒绝/);
  assert.match(text, /风险高/);
  assert.ok(!text.includes('审查不限时'), '非审查状态的 null 截止不得显示无上限文案');
  assert.ok(!text.includes('无自动拒绝时限'), '已移除的 countdown.none 文案不得出现');
  assert.ok(!text.includes(' · '), '没有倒计时时不得残留时间分隔段');
});

/** 审查视图用的字典映射：返回真实模板，等式与文案才能断言替换结果。 */
const REVIEW_TEXT = {
  'view.needSession': '请先打开一个会话',
  'view.empty': '本会话还没有自动审批记录',
  'view.count': '共 {n} 条',
  'view.readFailed': '记录读取失败或不完整，列表可能缺少条目',
  'decision.allow': '放行（allow）',
  'decision.allowed-once': '放行（allowed-once）',
  'decision.deny': '拒绝（deny）',
  'decision.rejected': '拒绝（rejected）',
  'time.total': '工具总计 {x} = 执行 {y} + 审批 {z}',
  'time.approvalOnly': '审批 {z}',
  'time.unmatched': '未匹配到工具行',
  'time.queue': '排队 {n}',
  'time.review': '审查 {n}',
  'time.human': '人工 {n}',
  'detail.decision': '审查判定',
  'detail.source': '结算来源',
  'detail.stage': '环节',
  'detail.origin': '归属',
  'detail.escalation': '升权目标',
  'detail.preset': '接管预设',
  'detail.model': '模型',
  'detail.effort': '档位',
  'detail.layer': '解析层级',
  'detail.attempts': '尝试次数',
  'detail.tokens': '思维链 token',
  'detail.risk': '风险',
  'detail.auth': '授权',
  'detail.fieldsDefaulted': '解析补全',
  'detail.degraded': '降级标记',
  'detail.configTag': '配置标识',
  'detail.policyTag': '策略标识',
  'detail.evidence': '上下文证据',
  'detail.probes': '只读取证',
  'detail.reason': '理由',
  'detail.prompt': '提示词',
  'detail.input': '输入',
  'detail.reasoning': '思维链',
  'detail.output': '输出',
  'detail.notCaptured': '未采集（capture 档为 summary）',
  'detail.truncated': '已截断',
  'source.llm': '审查（llm）',
  'source.human': '人工（human）',
  'source.timeout': '超时（timeout）',
  'source.rule': '规则（rule）',
  'source.gateway': '通道关闭（gateway）',
  'source.signal': '取消（signal）',
  'source.error': '异常（error）',
  'stage.queue': '排队（queue）',
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
/** 详情：A 有 humanWaitMs 与两段全文（input/reasoning 缺）；B 只有 humanWaitMs；C 全段缺失且 stage=queue。 */
const TRACE_DETAILS = {
  apA: { ...TRACE_ROWS[0], humanWaitMs: 400, prompt: 'PROMPT-A', output: 'OUTPUT-A', layer: 'session', attempts: 1, tokens: 32, preset: 'auto-approve', configTag: 'a1b2c3d4e5f6', policyTag: 'zh:missing' },
  apB: { ...TRACE_ROWS[1], humanWaitMs: 0, layer: 'session', attempts: 1 },
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
  // A 行：主判定＝结算 outcome（人工推翻审查放行）→ 拒绝（rejected）为主、放行（allow）为次级徽标。
  assert.match(listText, /拒绝（rejected）/, 'outcome 是主判定');
  assert.match(listText, /放行（allow）/, '审查判定为次级徽标（两者可分辨，design §8.5）');
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
  assert.ok(!allowText.includes('未匹配到工具行'), '匹配上时不应再显示未标注');
  // A：input/reasoning 与 evidence/probes 四段缺（capture=summary）。
  assert.equal((allowText.match(/未采集（capture 档为 summary）/g) ?? []).length, 4, '四段缺各显示一次未采集说明');
  assert.match(allowText, /PROMPT-A/);
  assert.match(allowText, /OUTPUT-A/);
  // 详情元信息：结算来源/环节/层级/尝试次数/标识在场（§8.2 详情补充字段）。
  assert.match(allowText, /结算来源: 人工（human）/);
  assert.match(allowText, /解析层级: session/);
  assert.match(allowText, /尝试次数: 1/);
  assert.match(allowText, /接管预设: auto-approve/);
  assert.match(allowText, /配置标识: a1b2c3d4e5f6/);
  assert.match(allowText, /策略标识: zh:missing/);
  assert.match(allowText, /归属: 主会话（main）/);
  assert.match(allowText, /升权目标: danger-full-access/);

  // 收起 A、点开 C（只有结算）：全部分段缺失显示 —，不按 0 计（design §8.5）。
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
  assert.match(cText, /降级标记: queue-overflow/);
  assert.match(cText, /审查未执行：queue-overflow/, '理由段携带固定前缀原文');
  assert.ok(!cText.includes('工具总计'), '匹配不上时不得显示等式');
  assert.match(cText, /未匹配到工具行/, '匹配不上时必须标注，不猜 X');
  assert.match(cText, /审批 0 ms/, '无在场分段时 Z=0（求和口径）');
  // C 六段全文/取证缺（理由段在场）。
  assert.equal((cText.match(/未采集（capture 档为 summary）/g) ?? []).length, 6, '六段缺各显示一次未采集说明');
});

test('审查视图：readFailed=true 时显示读取降级提示，不伪装成「没有记录」（design §8.3）', async () => {
  resetHooks();
  const client = loadClient();
  const env = makeCtx({
    currentSession: 's1',
    call: async (endpoint) => {
      if (endpoint === 'approveForMe/traceRecords') return { ok: true, value: { records: [], readFailed: true } };
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
  // 折叠头已移除（下拉基元自带 aria-expanded，不在此断言）。
  assert.equal(flat.includes('dsafm_head'), false, '折叠头已移除，不应再有 dsafm_head');
  assert.equal(flat.includes('dsafm_card'), false, '折叠外壳已移除，不应再有 dsafm_card');
  // 分区标题退役；唯一保存按钮首屏在场且初始置灰；全局重置不再渲染。
  assert.equal(flat.includes('card.section.'), false, '分区标题已退役');
  assert.notEqual(flat.indexOf('card.save'), -1, '保存控件应首屏在场');
  assert.equal(flat.includes('card.resetAll'), false, '重置控件已删除');
  assert.equal(findByClass(form, 'dsafm_save').props.disabled, true, '初始无改动时保存置灰');
  // summary 分支已删：即便宿主传入 view:'summary' 也渲完整表单，不出现一行摘要键。
  hookIndex = 0;
  const asSummary = render(card.component, { ...props, view: 'summary' });
  const flatSummary = JSON.stringify(asSummary);
  assert.equal(flatSummary.indexOf('card.summary.presets'), -1, 'summary 分支已删除，不应引用 card.summary.presets');
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
  // 三个覆盖字段都显示覆盖状态：自绘字段（fallback/mode）有「已覆盖＋恢复默认」按钮，
  // 数字字段（reviewer.timeoutMs）的覆盖组在官方 SettingsValueField 内部（props 传 overridden/resetLabel）。
  const resetButtons = findAllByClass(tree, 'dsafm_reset');
  assert.equal(resetButtons.length, 2, `自绘覆盖字段应各有恢复默认，实际 ${resetButtons.length}`);
  const numberMarker = findAllNodes(tree, (node) => node.type === primitivesStub.SettingsValueField)
    .find((node) => node.props.id === 'approve-for-me-ctl-reviewer-timeoutMs');
  assert.ok(numberMarker, 'reviewer.timeoutMs 应走官方数字字段');
  assert.equal(numberMarker.props.overridden, true, '官方组件应收到 overridden=true');
  assert.equal(numberMarker.props.resetLabel, 'card.resetField', '官方组件应收到恢复默认文案');
  assert.equal(numberMarker.props.text, '95000', '官方组件的显示文本就是生效值');
  // 覆盖标记计数：胶囊 Tag 恰好 2 个（自绘覆盖字段），官方组件收到 overridden=true 的恰好 1 个。
  const tags = findAllNodes(tree, (node) => node.type === primitivesStub.Tag && node.props.children === 'card.override');
  assert.equal(tags.length, 2, '已覆盖胶囊应恰好 2 个（fallback/mode）');
  const overriddenMarkers = findAllNodes(tree, (node) => node.type === primitivesStub.SettingsValueField && node.props.overridden === true);
  assert.equal(overriddenMarkers.length, 1, '官方数字字段里只有 timeoutMs 被覆盖');

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
  assert.equal(JSON.stringify(stagedField).includes('card.override'), false, '暂存 clear 后不再显示已覆盖');
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
  // 草稿为 0 → 无上限风险提醒固定渲染在审查时限字段的秒数读数行内（design §7.2），
  // 可见性不依赖帮助区；只描述风险不改写输入（0 仍可保存）。人工时限字段的 0 是「立即拒绝」，不显示。
  const warnZero = secSpan(zero, 'approve-for-me-sec-reviewer-timeoutMs', 'dsafm_sec_warn');
  assert.ok(warnZero, '草稿为 0 时无上限提醒必须在场');
  assert.match(String(warnZero.props.children), /无限停/u);
  assert.equal(secSpan(zero, 'approve-for-me-sec-human-timeoutMs', 'dsafm_sec_warn'), undefined, '人工时限的 0 不显示该提醒');
  // en 档单位 s（同一暂存文本，读数跟随语言）。
  const enProps = { t: (key) => dicts.en[key] ?? key, scope: env.scope, ...card.options.inject() };
  hookIndex = 0;
  const enTree = render(card.component, enProps);
  assert.equal(secSpan(enTree, 'approve-for-me-sec-reviewer-timeoutMs', 'dsafm_sec_resolved').props.children, 'Effective: 300 s', 'en 档生效值读数单位 s');
  assert.equal(secSpan(enTree, 'approve-for-me-sec-reviewer-timeoutMs', 'dsafm_sec_draft').props.children, 'Draft: 0 s', 'en 档草稿读数单位 s');
  // 中英成对：en 档提醒文本同样在场。
  const warnEn = secSpan(enTree, 'approve-for-me-sec-reviewer-timeoutMs', 'dsafm_sec_warn');
  assert.ok(warnEn && /forever/u.test(String(warnEn.props.children)), 'en 档无上限提醒在场');
});

test('生效值为 0 即显示无上限提醒（保存读回语义）；草稿改回非零不撤销提醒', async () => {
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
  const warn = findAllByClass(line, 'dsafm_sec_warn')[0];
  assert.ok(warn, '生效值为 0 即显示提醒（保存读回仍可见）');
  assert.match(String(warn.props.children), /不会自动恢复时限/u);
  // 草稿分支互补：生效值仍为 0、草稿键入非零 → 提醒必须仍在场（设计 §7.2「草稿为 0 或生效值为 0」）。
  const marker = findAllNodes(tree, (node) => node.type === primitivesStub.SettingsValueField)
    .find((node) => node.props.id === 'approve-for-me-ctl-reviewer-timeoutMs');
  marker.props.onEdit('120000');
  await tick();
  hookIndex = 0;
  const typed = render(card.component, props);
  const typedLine = findAllNodes(typed, (node) => node.props?.id === 'approve-for-me-sec-reviewer-timeoutMs')[0];
  assert.equal(findAllByClass(typedLine, 'dsafm_sec_draft')[0].props.children, '草稿：120 秒', '草稿读数随键入换算');
  assert.ok(findAllByClass(typedLine, 'dsafm_sec_warn')[0], '生效值为 0 时草稿非零不撤销提醒');
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
  // 恢复默认：控件显示组合层默认值 90000，草稿读数按该文本换算，生效值读数仍是快照生效值。
  marker.props.onReset();
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
  assert.equal(SOURCE.includes('重置全部覆盖'), false, '源码不应再含「重置全部覆盖」');
  assert.equal(SOURCE.includes('当前生效值'), false, '源码不应再含「当前生效值」');
  assert.equal(SOURCE.includes('QuestionIcon'), false, '自造问号图标应删除');
  assert.equal(SOURCE.includes('Tooltip'), false, '悬停 Tooltip 应退役（帮助改点击内联展开）');
  assert.equal(SOURCE.includes('dsafm_row'), false, '横排行容器类应退役');
  assert.equal(SOURCE.includes('dsafm_section'), false, '分区标题类应退役');
  assert.equal(SOURCE.includes('dsafm_divider'), false, '分区线类应退役');
  assert.equal(SOURCE.includes('dsafm_actions'), false, '旧操作区类应退役');
  // 交付 CSS 串对 0.1.7 令牌表不存在的别名零命中（含官方笔误 bg-layer-4）。
  for (const token of ['--dsw-alias-state-warning-primary', '--dsw-alias-label-error', '--dsw-alias-bg-layer-4']) {
    assert.equal(SOURCE.includes(token), false, `失效令牌零命中：${token}`);
  }
  // 笔误修正：警示色用现行别名 state-warn-primary。
  assert.ok(SOURCE.includes('--dsw-alias-state-warn-primary'), '警示色应使用现行别名');
  // 卡片外壳退役（源码侧）：.dsafm_form 不再声明 border/radius/底色。
  const formRule = /\.dsafm_form\{[^}]*\}/u.exec(SOURCE)?.[0] ?? '';
  assert.ok(formRule.length > 0, '应有 .dsafm_form 规则');
  assert.equal(/border(?!-top)/u.test(formRule), false, '.dsafm_form 不应再带边框');
  assert.equal(formRule.includes('border-radius'), false, '.dsafm_form 不应再带圆角');
  assert.equal(formRule.includes('background'), false, '.dsafm_form 不应再带成片底色');
  // 官方规格落点：34px 输入、24×24 帮助按钮、保存按钮实心与置灰透明度。
  assert.ok(SOURCE.includes('height:34px'), '输入应取官方 34px 规格');
  assert.ok(SOURCE.includes('width:24px;height:24px'), '帮助按钮应为 24×24 命中区');
  assert.ok(SOURCE.includes('.dsafm_save:disabled{opacity:.4'), '保存置灰应为官方 opacity .4');
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
