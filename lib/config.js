/**
 * dsh-approve-for-me — 宿主行 Config（行 id `approve-for-me`，0.1.7 起即设置命名空间）。
 *
 * 字段与默认值即设计「settings schema（命名空间 approve-for-me）」；本模块只声明 schema，不读也不写宿主状态。
 * 卡片可编辑字段与 `mode` 标注 `.volatile()`：设置页读写只落在 volatile 路径，
 * 其余字段（enabled/concurrency/breaker/audit/context 与 trace 体积上限）走普通配置变更（重挂载生效）。
 * 默认值的设计意图写在每个字段的注释里：默认配置应当「正常部署下不拦截日常操作，但危险动作一律不放行」。
 * @module dsh-approve-for-me/config
 */
import z from '@deepseek-ai/schemastery';
import { DEFAULT_REDACT_PATTERNS } from './policy.js';

/** 缺省接管工具名单；空数组 = 对所有工具的审批生效（与 codex 一致）。 */
export const DEFAULT_TOOLS = Object.freeze([]);

/** 审查模型选择：字符串 `provider/model`（旧写法）或 `{ model, effort }` 对象。 */
export const ModelChoiceSchema = z.union([
  z.string(),
  z.object({ model: z.string().default(''), effort: z.string().default('') }),
]);

export const Config = z.object({
  /** 总开关；关闭时不注册应答者，行为与未安装一致。 */
  enabled: z.boolean().default(true),
  /** `rules` = 规则强制检查 + LLM 审查；`off` = 不接管（volatile：请求期生效）。 */
  mode: z.union([z.const('rules'), z.const('off')]).default('rules').volatile(),
  /** 接管工具名单；空数组 = 对所有工具生效。不在名单内的审批原样交给下一个应答者。 */
  tools: z.array(z.string()).default([...DEFAULT_TOOLS]).volatile(),
  /** 允许自动放行的最宽升权目标；默认不因模式上限拦截（设计「时序与五条路径」的 4.2 决定）。 */
  allowEscalationTo: z
    .union([z.const('workspace-write'), z.const('danger-full-access')])
    .default('danger-full-access')
    .volatile(),
  /** 规则强制拒绝清单；命中即拒绝，LLM 与人工都不能推翻。留空＝不启用规则强制检查（R51）；
   *  出厂参考清单＝`DEFAULT_DENY_PATTERNS`（`lib/policy.js`，README 有全文，抄写进配置即恢复）。 */
  denyPatterns: z.array(z.string()).default([]).volatile(),
  /** `callId` 回查不到命令时：`reject` 直接拒绝，`review` 带降级标记继续审查。 */
  unknownSubject: z.union([z.const('reject'), z.const('review')]).default('reject').volatile(),
  /** 审查未放行时的处置：`reject` 直接拒绝；`ask` 交人工。 */
  fallback: z.union([z.const('reject'), z.const('ask')]).default('reject').volatile(),
  /** 权限预设触发（设计「权限预设与模式识别」）：命中任一预设才接管审批。 */
  trigger: z
    .object({
      /** 预设名；默认对应插件随包提供的「自动审批」预设。 */
      presets: z.array(z.string()).default(['auto-approve']).volatile(),
      /** 预设不可判定（服务缺失 / 投影未注册 / 无权限事件）时的处置。 */
      unknown: z.union([z.const('skip'), z.const('review')]).default('skip').volatile(),
      /**
       * 委派子会话（`header.parentSession` 存在，R24 / 设计 §20）是否纳入接管：
       * `review` = 按委派链根会话预设判定命中后接管（并把子会话审批策略翻为 ask）；
       * `skip` = 完全不介入（与现状一致：never 短路自动拒绝）。
       */
      subagents: z.union([z.const('review'), z.const('skip')]).default('review').volatile(),
      /** true 时逐次写 skip 审计行；false 时同一 (sessionId, preset) 只写一行。 */
      auditEverySkip: z.boolean().default(false).volatile(),
    })
    .default({}),
  reviewer: z
    .object({
      /** 全局级·默认审查模型：`provider/model` 或 `{ model, effort }`；空 = 未设置。 */
      model: ModelChoiceSchema.default('').volatile(),
      /** 第二层：主模型 id → 审查模型（同 ModelChoiceSchema）。 */
      byParentModel: z.dict(ModelChoiceSchema).default({}).volatile(),
      /** 最后一条规则：上面都未命中时跟随父 agent 当前模型。 */
      followParent: z.boolean().default(true).volatile(),
      /**
       * 审查超时；0 = 无审查超时（不建计时器，模型挂起则本次审批挂起）。
       * 毫秒字段统一上限 2147483647（setTimeout 的 32 位符号整数域，R37）：超限＝加载失败（报错可见），
       * 不静默钳制——钳制违背「配置意图与行为一致」；human.timeoutMs / concurrency.queueTimeoutMs / breaker.cooldownMs 同此上限。
       */
      timeoutMs: z.natural().max(2147483647).default(90000).volatile(),
      /**
       * 审查请求的输出上限；`0` = 不设上限（codex 同款，设计「输出预算：默认不设上限（与 codex 同构）」）。
       * 思考型模型先吃掉推理预算：实测 `max_tokens=512` 时正文必为空，2048 在 `effort=max` 下只剩约 700 token 余量。
       * 缺省不传该字段，宿主按模型自己的 `defaultMaxTokens` 材料化。
       */
      maxTokens: z.natural().default(0).volatile(),
      /**
       * 审查采样温度（0–2）。ISS-1 修复口径：Config 全树禁止 `transform` 节点——
       * 客户端设置通道对 schema 做 `toJSON()` → JSON → `new Schema()` 往返（可能不止一次），
       * transform 的 JS 回调在第二次序列化时丢失，重组后校验任何值都抛 `callback is not a function`，
       * `decode()` 返回 undefined、表单整片全空。R37 的非有限数拒止因此移到装载路径（normalizeConfig）。
       */
      temperature: z.number().min(0).max(2).default(0).volatile(),
      /** 工具轮次上限；超限后追加一条「请直接给出结论」的 user 消息再请求一次。 */
      maxToolSteps: z.natural().default(4).volatile(),
      /** 单次只读工具调用的超时；超时按「无证据」处理，不影响结论方向；0 = 不设超时；上限 2147483647（R37）。 */
      toolTimeoutMs: z.natural().max(2147483647).default(5000).volatile(),
    })
    .default({}),
  human: z
    .object({
      /** 人工响应时限；仅在 `fallback: 'ask'` 时生效，0 = 立即拒绝；上限 2147483647（R37）。 */
      timeoutMs: z.natural().max(2147483647).default(300000).volatile(),
      /** 计时起点：`request` 从请求进入插件起算，`handoff` 从交人工起算。 */
      timeoutFrom: z.union([z.const('request'), z.const('handoff')]).default('request').volatile(),
    })
    .default({}),
  context: z
    .object({
      /** 会话上下文总字节预算。 */
      maxTranscriptBytes: z.natural().default(24576),
      /** 单条事件字节预算。 */
      maxEntryBytes: z.natural().default(4096),
      /** 取最近多少条事件。 */
      maxEntries: z.natural().default(40),
      /** 是否把工具结果纳入上下文。 */
      includeToolResults: z.boolean().default(true),
      /** 脱敏清单；作用于提示词、工具结果与审计。 */
      redactPatterns: z.array(z.string()).default([...DEFAULT_REDACT_PATTERNS]),
    })
    .default({}),
  concurrency: z
    .object({
      /** 全局并发审查上限，保护配额与首 token 延迟。 */
      max: z.natural().default(2),
      /** 每会话排队上限。 */
      queueMax: z.natural().default(8),
      /** 排队等待上限；超时按 `fallback` 处理；上限 2147483647（R37）。 */
      queueTimeoutMs: z.natural().max(2147483647).default(30000),
    })
    .default({}),
  breaker: z
    .object({
      /** 连续拒绝达到该值即打开熔断。 */
      consecutiveDenials: z.natural().default(3),
      /** 滑动窗口大小。 */
      windowSize: z.natural().default(50),
      /** 滑动窗口内拒绝达到该值即打开熔断。 */
      windowDenials: z.natural().default(10),
      /** 熔断持续时长；上限 2147483647（R37）。 */
      cooldownMs: z.natural().max(2147483647).default(600000),
    })
    .default({}),
  audit: z
    .object({
      enabled: z.boolean().default(true),
      /** 额外写 `phase=prompt` 行（含提示词全文，已脱敏：reason 落笔前统一过 `context.redactPatterns`，R34）。 */
      includePrompt: z.boolean().default(false),
      /** 额外写 `phase=raw` 行（含模型原始输出，已脱敏：同上，R34）。 */
      includeRaw: z.boolean().default(false),
      maxLineBytes: z.natural().default(4096),
    })
    .default({}),
  /** 会话页呈现（设计「注入范围与上下文影响」）：注入范围与长度上限。 */
  ui: z
    .object({
      /** `all` = 放行与拒绝都注入；`reject` = 仅拒绝注入；`off` = 都不注入。 */
      inject: z.union([z.const('all'), z.const('reject'), z.const('off')]).default('all').volatile(),
      /** 单条注入文本的字节上限，超出截断并留痕。 */
      injectMaxBytes: z.natural().default(2048).volatile(),
      /**
       * 轨迹集成（设计 §17）：自有视图、每轮对照、近似行与采集档（0.1.7 起档位开关已退役，
       * 只做插件自有呈现；体积上限走普通配置变更）。
       */
      trace: z
        .object({
          /** 注册插件自有视图（会话视图 + 每轮对照块）。 */
          ownView: z.boolean().default(true).volatile(),
          /** 审查视图里的每轮耗时对照块（`工具总计 X = 执行 Y + 审批 Z`；设计 §17.3 决定不用 turnTail 座位）。 */
          turnSummary: z.boolean().default(true).volatile(),
          /** 记录表近似行（一行「上下文」，与注入行重复，默认关；设计审查 r25 决定①保留）。 */
          legacyRow: z.boolean().default(false).volatile(),
          /** 采集档：`off` 不采详情；`summary` 只采摘要字段；`full` 采提示词/思维链/输出全文（受上限约束）。 */
          capture: z.union([z.const('off'), z.const('summary'), z.const('full')]).default('summary').volatile(),
          /** 每会话保留的审查记录条数上限。 */
          maxRecords: z.natural().default(200),
          /** `full` 档下单字段字节上限，超出截断并置 `truncated`。 */
          maxBytes: z.natural().default(8192),
        })
        .default({}),
      /**
       * 审查期间是否就把原生人工卡片弹出来（设计「决定：审查期间是否先调用 next() 由配置决定」）。
       * `true` = 卡片在审查期间可见、用户可抢先决定；`false` = 只在审查未放行且 `fallback='ask'` 时才弹出。
       * 关闭后若 `reviewer.timeoutMs = 0`，审查挂起期间不会有任何审批 UI。
       */
      humanCardDuringReview: z.boolean().default(true).volatile(),
    })
    .default({}),
  /**
   * 中英双语（R28，设计 §21）：两块独立开关。`ui` 管插件自有界面文案
   * （`auto`＝跟随宿主界面语言〔默认〕/`zh`/`en`）；`agent` 管全部送给模型的文本
   * （`zh`/`en`，默认 `en`：en 档审查判定调用链零改动）。热生效——下一次审查与注入即用新语言。
   */
  language: z
    .object({
      /** 用户文案：插件自有 UI 的取词档。 */
      ui: z.union([z.const('auto'), z.const('zh'), z.const('en')]).default('auto').volatile(),
      /** Agent 提示：系统提示/工具说明/注入文本/轮次用尽指令的取词档。 */
      agent: z.union([z.const('zh'), z.const('en')]).default('en').volatile(),
    })
    .default({}),
});

/** 需要逐组合并默认值的嵌套分节；标量字段直接覆盖。`language` 自 R42 起入列（部分传入也要输出完整分节）。 */
const NESTED_GROUPS = ['trigger', 'reviewer', 'human', 'context', 'concurrency', 'breaker', 'audit', 'language', 'ui'];

/** 默认值快照；只算一次。 */
let defaults;

/**
 * volatile 引用判定（0.1.7）：schemastery 把 `.volatile()` 字段解析为稳定引用对象
 * （cosmokit `Volatile`：冻结的 `{ get }` + 注册在全局符号上的 write 方法）。
 * 与 cosmokit 的 `isVolatile` 同判据（`Symbol.for('cosmokit.volatile.write') in value`）——
 * 用 `Symbol.for` 注册正是为了跨 ESM/CJS 副本能认出同一个协议，本地重实现不引第三方依赖。
 * @param {unknown} value - 待判定值。
 * @returns {boolean} 是否 volatile 引用。
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');
const isVolatile = (value) => typeof value === 'object' && value !== null && VOLATILE_WRITE in value;

/**
 * 深度解包 volatile 引用：引用 → `.get()` 快照；容器递归。
 * 宿主对「仅 volatile 值变化」原地更新引用（`_commitVolatile`），因此**每次读取都重新解包**——
 * `current()` 现算即热改生效，不需要失效通知参与取值路径。
 * @param {unknown} value - 任意配置子树。
 * @returns {unknown} 解包后的纯数据。
 */
function unwrapVolatiles(value) {
  if (isVolatile(value)) return unwrapVolatiles(value.get());
  if (Array.isArray(value)) return value.map(unwrapVolatiles);
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = unwrapVolatiles(item);
    return out;
  }
  return value;
}

/**
 * 把任意配置补齐为完整生效值。
 * 0.1.7 起 `Config` 带 volatile 字段：defaults 与传入值两侧都可能含 volatile 引用，
 * 合并后统一深度解包（设计 §6.1 适配点 3）；缺省分节照旧补齐，保证下游拿到完整结构。
 * 输出契约（R42）：输入允许部分分节；输出保证 `NESTED_GROUPS` 全部分节完整——直接调用方不再依赖「先过 schema」前提。
 * @param {object | undefined} value - 组合配置入口值（volatile 字段为稳定引用）。
 * @returns {object} 补齐并解包后的配置。
 */
export function normalizeConfig(value) {
  if (defaults === undefined) defaults = Config({});
  const merged = { ...defaults, ...(value ?? {}) };
  for (const group of NESTED_GROUPS) {
    merged[group] = { ...defaults[group], ...(value?.[group] ?? {}) };
  }
  // `ui.trace` 是唯一的两层分节：浅合并会把没提到的键整段丢掉，所以单独再并一次。
  merged.ui.trace = { ...defaults.ui.trace, ...(value?.ui?.trace ?? {}) };
  const out = unwrapVolatiles(merged);
  // R37 装载路径拒止（ISS-1 移位）：schema 的 min/max 对 NaN 比较恒 false 挡不住非有限数，
  // 且 transform 已按 ISS-1 修复口径从树中移除（客户端设置通道无法序列化往返），
  // 有限性在装载时可见拒绝——保持 R37「超限＝加载失败（报错可见）」口径。
  if (!Number.isFinite(out.reviewer.temperature)) {
    throw new Error('approve-for-me: reviewer.temperature 必须是有限数（0–2）');
  }
  return out;
}
