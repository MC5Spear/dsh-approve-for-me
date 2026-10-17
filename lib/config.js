/**
 * dsh-approve-for-me — 宿主行 Config（行 id `approve-for-me`，即设置命名空间）。
 *
 * 字段与默认值即 design §6.1；本模块只声明 schema，不读也不写宿主状态。
 * 卡片可编辑字段与 `mode` 标注 `.volatile()`：设置页读写只落在 volatile 路径，
 * 其余字段（enabled/concurrency/breaker/audit/context 与 trace 体积上限）走普通配置变更（重挂载生效）。
 * 默认值的设计意图写在每个字段的注释里：默认配置应当「正常部署下不拦截日常操作，但危险动作一律不放行」。
 * @module dsh-approve-for-me/config
 */
import z from '@deepseek-ai/schemastery';
import { DEFAULT_REDACT_PATTERNS } from './policy.js';

/** 缺省接管工具名单；空数组 = 对所有工具的审批生效（与 codex 一致）。 */
export const DEFAULT_TOOLS = Object.freeze([]);

/**
 * 审查时限的 schema 默认值（毫秒）。唯一权威源：gate 装配期计时器在配置读不到时取此值，
 * index 启动审计行的缺省显示同源引用——两处不再各自硬编码，避免漂移。
 */
export const REVIEWER_TIMEOUT_DEFAULT_MS = 90000;

/** 审查模型选择：字符串 `provider/model`（旧写法）或 `{ model, effort }` 对象。 */
export const ModelChoiceSchema = z.union([
  z.string(),
  z.object({ model: z.string().default(''), effort: z.string().default('') }),
]);

/**
 * 父模型映射规则（design §6.2）：匹配条件与目标引用分属不同字段，不共用同一种字符串。
 * 条件的 `provider` 空值（null）＝任意 provider，非空字符串＝指定 provider；`model` 始终是
 * 完整纯模型 id，从不按斜杠切分。选择的 `model` 是目标模型引用（按首斜杠解析），
 * `effort` 空串＝自动选择。跨数组项的重复条件校验由合并层承载（见 `validateParentModelRules`）。
 */
export const ParentModelRuleSchema = z.object({
  parent: z
    .object({
      provider: z.union([z.string(), z.const(null)]).default(null),
      model: z.string().default(''),
    })
    .default({}),
  choice: z
    .object({
      model: z.string().default(''),
      effort: z.string().default(''),
    })
    .default({}),
});

/**
 * 归一规则条件的 provider：空值（null／undefined／空白串）统一为 null（任意 provider），
 * 非空字符串去首尾空白后返回。
 * @param {unknown} value - 条件里的 provider 字段。
 * @returns {string | null | undefined} 归一结果；非字符串非空值的非法类型返回 `undefined`。
 */
export function normalizeRuleProvider(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return undefined;
}

/**
 * 父模型映射规则的匹配条件键：provider 归一（空值为 null、非空去首尾空白）与 model 去首尾空白后组键（design §6.2）。
 * 装载校验、读取校验与运行时检测按本键判重；设置页行级防线在 client 侧另行实现，比较口径与本键一致。
 * @param {string | null} provider - 条件 provider（空值在此归一为 null；非法类型按调用方的前置校验拒绝）。
 * @param {string} model - 条件完整纯模型 id。
 * @returns {string} 条件键。
 */
export function parentModelRuleKey(provider, model) {
  return JSON.stringify([normalizeRuleProvider(provider) ?? null, typeof model === 'string' ? model.trim() : model]);
}

export const Config = z.object({
  /** 总开关；关闭时不注册应答者，行为与未安装一致。 */
  enabled: z.boolean().default(true),
  /** `rules` = 规则强制检查 + LLM 审查；`off` = 不接管（volatile：请求期生效）。 */
  mode: z.union([z.const('rules'), z.const('off')]).default('rules').volatile(),
  /** 接管工具名单；空数组 = 对所有工具生效。不在名单内的审批原样交给下一个应答者。 */
  tools: z.array(z.string()).default([...DEFAULT_TOOLS]).volatile(),
  /** 允许自动放行的最宽升权目标；默认不因模式上限拦截（宽度排序见 design §2.1，默认值见 requirements §5.3）。 */
  allowEscalationTo: z
    .union([z.const('workspace-write'), z.const('danger-full-access')])
    .default('danger-full-access')
    .volatile(),
  /** 规则强制拒绝清单；命中即拒绝，LLM 与人工都不能推翻。留空＝不启用规则强制检查；
   *  出厂参考清单全文＝`DEFAULT_DENY_PATTERNS`（`lib/policy.js`，README 载其节选，需要时以代码内清单为准）。 */
  denyPatterns: z.array(z.string()).default([]).volatile(),
  /** `callId` 回查不到命令时：`reject` 直接拒绝，`review` 带降级标记继续审查。 */
  unknownSubject: z.union([z.const('reject'), z.const('review')]).default('reject').volatile(),
  /** 审查未放行时的处置：`reject` 直接拒绝；`ask` 交人工。 */
  fallback: z.union([z.const('reject'), z.const('ask')]).default('reject').volatile(),
  /** 权限预设触发（design §2.1）：命中任一预设才接管审批。 */
  trigger: z
    .object({
      /** 预设名；默认对应插件随包提供的「自动审批」预设。 */
      presets: z.array(z.string()).default(['auto-approve']).volatile(),
      /** 预设不可判定（服务缺失 / 投影未注册 / 无权限事件）时的处置。 */
      unknown: z.union([z.const('skip'), z.const('review')]).default('skip').volatile(),
      /**
       * 委派子会话（design §2.2 按身份识别：带 `parentSession` 且 `delegationDepth` 不小于 1，
       * 分叉会话不算）是否纳入接管：
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
      /** 全局级·默认审查模型：`provider/model` 或 `{ model, effort }`；空 = 未设置（未设置时按 5.1 零值语义使用执行助手当前模型）。 */
      model: ModelChoiceSchema.default('').volatile(),
      /** 父模型映射（design §6.2）：结构化规则清单，每条含匹配条件（provider 作用范围＋完整纯模型 id）与选择；重复条件装载即拒。 */
      parentModelRules: z.array(ParentModelRuleSchema).default([]).volatile(),
      /** 旧字典仅作兼容输入（design §6.2 兼容链）：未被编辑不自动重写或迁移。 */
      byParentModel: z.dict(ModelChoiceSchema).default({}).volatile(),
      /**
       * 审查超时；涵盖装配（读取配置、解析审查模型、回查本次操作）与等待审查结论的全过程
       * （requirements §4.2）：装配消耗同一份预算、不补回，`0` = 立即超时（按超时拒绝、不开始尝试）。
       * 毫秒字段统一上限 2147483647（setTimeout 的 32 位符号整数域，requirements §4.2）：超限＝加载失败（报错可见），
       * 不静默钳制——钳制违背「配置意图与行为一致」；human.timeoutMs / concurrency.queueTimeoutMs / breaker.cooldownMs 同此上限。
       */
      timeoutMs: z.natural().max(2147483647).default(REVIEWER_TIMEOUT_DEFAULT_MS).volatile(),
      /**
       * 审查请求的输出上限；`0` = 不向模型传输出上限，由模型／供应商默认值决定，不表示无限输出（design §3.6）。
       * 思考型模型先吃掉推理预算：小上限会让正文必为空，2048 一档在 `effort=max` 下余量也很小。
       * 非 0 值才随请求传递；缺省 0 时宿主按模型自己的 `defaultMaxTokens` 材料化。
       */
      maxTokens: z.natural().default(0).volatile(),
      /**
       * 审查采样温度（0–2 的有限数）。非有限数双层拒绝：schema 层退化步长 `Number.MIN_VALUE`
       * ＋读取路径 `normalizeConfig` 的有限性检查。区间比较（>、<）对 NaN 恒为假，NaN 靠整除校验拦截：
       * 一切有限双精度数都是 2^-1074 的整数倍，对退化步长取模恰为 0——该步长不排除任何有限值，
       * 只拒非有限数（取模为 NaN）；步长是纯数值元数据，随客户端设置通道的 schema 往返保留。
       * 读取检查保留的原因：volatile 写路径原地更新引用、不过 schema 校验，是程序化写入的最后一层。
       * Config 全树仍禁 `transform`：回调在第二次序列化时丢失，重组后校验任何值都抛
       * `callback is not a function`，`decode()` 返回 undefined、表单整片全空。
       */
      temperature: z.number().min(0).max(2).step(Number.MIN_VALUE).default(0).volatile(),
      /** 工具轮次上限；超限后追加一条「请直接给出结论」的 user 消息再请求一次。 */
      maxToolSteps: z.natural().default(4).volatile(),
      /** 单次只读工具调用的超时；超时按「无证据」处理，不影响结论方向；0 = 立即超时（该次调用立即按超时返回失败说明）；上限 2147483647。 */
      toolTimeoutMs: z.natural().max(2147483647).default(5000).volatile(),
    })
    .default({}),
  human: z
    .object({
      /** 人工响应时限；仅在 `fallback: 'ask'` 时生效，0 = 立即拒绝；上限 2147483647。 */
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
      /** 全局排队上限（跨会话合计；同一会话的请求另行相互串行）。 */
      queueMax: z.natural().default(8),
      /** 排队等待上限；超时按 `fallback` 处理；上限 2147483647。 */
      queueTimeoutMs: z.natural().max(2147483647).default(30000),
    })
    .default({}),
  breaker: z
    .object({
      /** 连续拒绝达到该值即打开冷却。 */
      consecutiveDenials: z.natural().default(3),
      /** 滑动窗口大小。 */
      windowSize: z.natural().default(50),
      /** 滑动窗口内拒绝达到该值即打开冷却。 */
      windowDenials: z.natural().default(10),
      /** 冷却持续时长；上限 2147483647。 */
      cooldownMs: z.natural().max(2147483647).default(600000),
    })
    .default({}),
  audit: z
    .object({
      enabled: z.boolean().default(true),
      /** 额外写 `phase=prompt` 行（含提示词全文，已脱敏：reason 落笔前统一过 `context.redactPatterns`）。 */
      includePrompt: z.boolean().default(false),
      /** 额外写 `phase=raw` 行（含模型原始输出，已脱敏：同上）。 */
      includeRaw: z.boolean().default(false),
      maxLineBytes: z.natural().default(4096),
    })
    .default({}),
  /** 会话页呈现（design §4.4）：注入范围与长度上限。 */
  ui: z
    .object({
      /** `all` = 放行与拒绝都注入；`reject` = 仅拒绝注入；`off` = 都不注入。 */
      inject: z.union([z.const('all'), z.const('reject'), z.const('off')]).default('all').volatile(),
      /** 单条注入文本的字节上限，超出截断并留痕。 */
      injectMaxBytes: z.natural().default(2048).volatile(),
      /**
       * 轨迹集成（design §8.5）：自有视图、每轮对照、近似行与采集档（只做插件自有呈现；
       * 体积上限走普通配置变更）。
       */
      trace: z
        .object({
          /** 注册插件自有视图（会话视图 + 每轮对照块）。 */
          ownView: z.boolean().default(true).volatile(),
          /** 审查视图里的每轮耗时对照块（`工具总计 X = 执行 Y + 审批 Z`，design §8.5）。 */
          turnSummary: z.boolean().default(true).volatile(),
          /** 记录表近似行（一行「上下文」，与注入行重复，默认关）。 */
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
       * 审查期间是否就把原生人工卡片弹出来（requirements §4.1）。
       * `true` = 卡片在审查期间可见、用户可抢先决定；`false` = 只在审查未放行且 `fallback='ask'` 时才弹出。
       */
      humanCardDuringReview: z.boolean().default(true).volatile(),
    })
    .default({}),
  /**
   * 中英双语（design §7.5）：两块独立开关。`ui` 管插件自有界面文案
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

/** 需要逐组合并默认值的嵌套分节；标量字段直接覆盖。`language` 属于逐组合并分节（部分传入也要输出完整分节）。 */
const NESTED_GROUPS = ['trigger', 'reviewer', 'human', 'context', 'concurrency', 'breaker', 'audit', 'language', 'ui'];

/** 默认值快照；只算一次。 */
let defaults;

/**
 * volatile 引用判定：schemastery 把 `.volatile()` 字段解析为稳定引用对象
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
 * 规则清单的装载阶段显式校验（design §6.2 拒绝落点）：跨数组项唯一性不构成声明式 schema 节点，
 * 校验由合并层承载——装载路径与 volatile 读取路径共用本校验，非法条件与重复条件都按装载失败
 * 报错（错误可见，与温度非有限数同型）。
 * @param {unknown} rules - 合并解包后的 `reviewer.parentModelRules`。
 * @returns {void} 非法即抛错。
 */
function validateParentModelRules(rules) {
  if (rules === undefined || rules === null) return;
  if (!Array.isArray(rules)) {
    throw new Error('approve-for-me: reviewer.parentModelRules 必须是规则数组');
  }
  /** 条件键 → 首次出现的序号；同一条件第二次出现即拒绝，不按清单顺序选赢家。 */
  const seen = new Map();
  for (const [index, rule] of rules.entries()) {
    const parent = rule?.parent;
    if (parent === null || typeof parent !== 'object' || Array.isArray(parent)) {
      throw new Error(`approve-for-me: reviewer.parentModelRules[${index}].parent 必须是对象`);
    }
    if (typeof parent.model !== 'string' || parent.model.trim().length === 0) {
      throw new Error(
        `approve-for-me: reviewer.parentModelRules[${index}].parent.model 必须是非空字符串（完整纯模型 id，不按斜杠切分）`,
      );
    }
    const provider = normalizeRuleProvider(parent.provider);
    if (provider === undefined) {
      throw new Error(
        `approve-for-me: reviewer.parentModelRules[${index}].parent.provider 必须是字符串或 null（null = 任意 provider）`,
      );
    }
    const key = parentModelRuleKey(provider, parent.model);
    if (seen.has(key)) {
      throw new Error(
        `approve-for-me: reviewer.parentModelRules 存在重复匹配条件（第 ${seen.get(key) + 1} 项与第 ${index + 1} 项：` +
          `provider=${provider === null ? '任意' : provider}、model=${parent.model.trim()}），重复条件是可见配置错误`,
      );
    }
    seen.set(key, index);
  }
}

/** 读取路径复查毫秒上限的字段清单（schema 声明同集：五个带 2147483647 上限的毫秒字段）。 */
const MS_BOUND_FIELDS = Object.freeze([
  ['reviewer', 'timeoutMs'],
  ['reviewer', 'toolTimeoutMs'],
  ['human', 'timeoutMs'],
  ['concurrency', 'queueTimeoutMs'],
  ['breaker', 'cooldownMs'],
]);

/**
 * 把任意配置补齐为完整生效值。
 * 0.1.7 起 `Config` 带 volatile 字段：defaults 与传入值两侧都可能含 volatile 引用，
 * 合并后统一深度解包（design §6.1）；缺省分节照旧补齐，保证下游拿到完整结构。
 * 输出契约：输入允许部分分节；输出保证 `NESTED_GROUPS` 全部分节完整——直接调用方无须依赖「先过 schema」前提。
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
  // 装载路径拒绝：schema 的 min/max 对 NaN 比较恒为假，挡不住非有限数；Config 全树禁 `transform`
  // （回调不随序列化往返，design §6.1）。非有限数在读取路径同样可见拒绝——超限与非有限数都按加载失败
  // 处理，报错可见（requirements §4.2／§5.2）。
  if (!Number.isFinite(out.reviewer.temperature)) {
    throw new Error('approve-for-me: reviewer.temperature 必须是有限数（0–2）');
  }
  // 毫秒字段读取路径复查（requirements §4.2）：volatile 字段由宿主原地更新引用、不过 schema 校验，
  // 其余毫秒字段一并同查——与温度有限性同一层防线，0–2147483647 的整数在读取时再核一次，
  // 超限按加载失败处理、报错可见，不静默钳制。
  for (const [group, key] of MS_BOUND_FIELDS) {
    const ms = out[group][key];
    if (!Number.isSafeInteger(ms) || ms < 0 || ms > 2147483647) {
      throw new Error(`approve-for-me: ${group}.${key} 必须是 0–2147483647 的整数毫秒值`);
    }
  }
  // 规则清单同口径：装载与 volatile 读取共用一次校验，重复条件与非法条件都让本次读取失败（design §6.2）。
  validateParentModelRules(out.reviewer.parentModelRules);
  return out;
}
