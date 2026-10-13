/**
 * 探针：工具目录的**可见性规则**——宿主侧的行插件能不能读到别的行注册的工具？
 *
 * 为什么需要它：设置页要列出"部署里所有工具"，而设置页与会话无关；这条承重假设成立与否
 * 决定了"无会话读工具目录"是否可能。
 * 动态插件的 `tools` 是受限门面（`dsh-cordis-host-runner/lib/index.js:582-583` 把两个方法
 * 钉死在沙箱自己的 scope 上），所以**动态探针证明不了宿主侧插件的可见性**。
 *
 * 本探针在**离线但真实**的宿主结构上回答三个问题：
 *   1. 不传 scope 的 `schemas()`——也就是"全局视图"——能不能看到别的行注册的工具？
 *   2. 一个 scope（行）里注册的工具，从别的 scope 能不能看到？
 *   3. 同一进程里两个不同的作用域上下文，是不是同一份注册表（服务单例）？
 *
 * 用法：node --import ./tools/_host-hooks.mjs tools/probe-tool-visibility.mjs
 */
import { Context } from '@deepseek-ai/cordis';
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope';
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools';

/** `defineTool` 要求 `output` 同时带 `schema` 与 `render`。 */
const output = {
  schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
  render: () => [{ type: 'text', text: 'ok' }],
};

/**
 * 造一个最小工具定义。
 * @param {string} name - 工具名。
 * @param {boolean} escalation - 是否声明单次提权参数（审批请求的判定键）。
 * @returns {object} `defineTool` 的产物。
 */
function tool(name, escalation) {
  const parameters = { command: { type: 'string', required: true } };
  if (escalation) {
    // 本探测的 DSL 里 `required` 只能为 `true` 或缺省（写 `false` 会被 defineTool 拒：
    // "parameters.X.required must be true when present"），可选参数就不写这个键。
    parameters.sandbox_permissions = { type: 'string', enum: ['workspace-write', 'danger-full-access'] };
    parameters.justification = { type: 'string' };
  }
  return defineTool({
    name,
    description: `${name} probe tool`,
    parameters,
    output,
    execute() { return { ok: true }; },
  });
}

/** 假 `systemPrompt`：只实现 `ToolRuntime` 构造时真正调用到的成员。 */
function fakeSystemPrompt() {
  const sections = [];
  return {
    sections,
    tools(provider) { sections.push(provider); return () => { sections.pop(); }; },
    section(entry) { sections.push(entry); return () => { sections.pop(); }; },
    getSectionOrder() { return 100; },
  };
}

const context = new Context();
context.provide('systemPrompt', fakeSystemPrompt());

/** 根（无 scope）视角：模拟"插件自身上下文"。 */
const rootTools = new ToolRuntime(context, {});

/** 两个不同的 scope：模拟"两个层的插件行"。 */
const planeA = createScope(context, { plane: 'host' });
const planeB = createScope(context, { plane: 'preset' });

const names = (schemas) => schemas.map((entry) => entry.name).sort();
const hasEscalation = (schemas) => schemas
  .filter((entry) => {
    const properties = entry.parameters?.properties;
    return properties !== undefined && Object.prototype.hasOwnProperty.call(properties, 'sandbox_permissions');
  })
  .map((entry) => entry.name)
  .sort();

// 行 1 挂在宿主侧：注册一个带提权参数的工具。
const disposerHost = context.tools.register(tool('probe_host_cmd', true));
// 行 2 挂在预设层：注册一个不带提权参数的工具。
const disposerPreset = planeB.ctx.tools.register(tool('probe_preset_cmd', false));

console.log('--- 读数 ---');
console.log(`scopeOf(context)        : ${String(scopeOf(context))}`);
console.log(`scopeOf(planeA.ctx)     : ${scopeOf(planeA.ctx) === undefined ? 'undefined' : 'object'}`);
console.log(`scopeOf(planeB.ctx)     : ${scopeOf(planeB.ctx) === undefined ? 'undefined' : 'object'}`);

const rootView = names(context.tools.schemas());
console.log(`schemas() 无参          : ${JSON.stringify(rootView)}`);
const aView = names(context.tools.schemas(scopeOf(planeA.ctx)));
console.log(`schemas(planeA key)     : ${JSON.stringify(aView)}`);
const bView = names(context.tools.schemas(scopeOf(planeB.ctx)));
console.log(`schemas(planeB key)     : ${JSON.stringify(bView)}`);
console.log(`无参里的提权工具        : ${JSON.stringify(hasEscalation(context.tools.schemas()))}`);

// 问题 3：同一进程里，另一个作用域上下文拿到的是不是同一份注册表？
const second = new Context();
second.provide('systemPrompt', fakeSystemPrompt());
let singleton;
try {
  const runtime2 = new ToolRuntime(second, {});
  singleton = names(runtime2.schemas());
} catch (error) {
  singleton = `构造失败：${String(error?.message).slice(0, 90)}`;
}
console.log(`第二个 Context 的读数   : ${JSON.stringify(singleton)}`);

// 问题 4（决定"无会话读工具目录"要不要依赖活 agent）：模拟工具包的行挂在 **agent 的 scope** 上，
// 看无参全剧视图与其它 scope 能否看到它。工具包在真机上是 profile/预设的行，
// 而 agent 加入预设时会父到预设的 standing scope，因此这一问等价于
// "预设/会话作用域注册的工具，全局视图读不读得到"。
const agentScope = createScope(context, { agent: 'session-probe-1' }, { parent: scopeOf(planeB.ctx) });
const disposerAgent = agentScope.ctx.tools.register(tool('probe_agent_cmd', true));
const agentView = names(context.tools.schemas(scopeOf(agentScope.ctx)));
const rootViewAfter = names(context.tools.schemas());
const presetViewAfter = names(context.tools.schemas(scopeOf(planeB.ctx)));
console.log('');
console.log(`agent scope 内注册后，schemas(agent key)  : ${JSON.stringify(agentView)}`);
console.log(`agent scope 内注册后，schemas() 无参      : ${JSON.stringify(rootViewAfter)}`);
console.log(`agent scope 内注册后，schemas(预设 key)   : ${JSON.stringify(presetViewAfter)}`);

// 结论判定：这三条决定"无会话读工具目录"是否可行（核销依据）。
const globalSeesRowTools = rootView.includes('probe_host_cmd');
const scopeIsolation = !bView.includes('probe_host_cmd') && !rootView.includes('probe_preset_cmd');
const agentToolsStayInScope = !rootViewAfter.includes('probe_agent_cmd');
const presetSeesAgentTools = presetViewAfter.includes('probe_agent_cmd');
console.log('');
console.log('--- 判定 ---');
console.log(`① 无参 schemas() 能看到别的行注册的全局工具 : ${globalSeesRowTools ? '能' : '不能'}`);
console.log(`② 预设层注册的工具对全局视图不可见       : ${!rootView.includes('probe_preset_cmd') ? '是（有隔离）' : '否（全局可见）'}`);
console.log(`③ 跨 Context 共享同一注册表               : ${Array.isArray(singleton) && singleton.includes('probe_host_cmd') ? '是' : '否'}`);
console.log(`④ agent scope 注册的工具对全局视图不可见   : ${agentToolsStayInScope ? '是（必须按 scope 读）' : '否'}`);
console.log(`⑤ 父 scope（预设）能看到子 scope（agent）的工具 : ${presetSeesAgentTools ? '能（沿 scope 链解析）' : '不能'}`);

disposerAgent();
disposerHost();
disposerPreset();
planeA.dispose();
planeB.dispose();
agentScope.dispose();
