/**
 * dsh-approve-for-me — host 侧状态服务（供 composer 下拉）。
 *
 * 三个 RPC（design §7.1）：读会话级当前值、写/清会话级选择、列出可选模型。
 * 会话级选择存在文件载体（`lib/session-store.js`，design §6.3）：读取顺序＝文件载体 → 旧事件折叠，
 * 写入只写文件载体，不写会话日志事件。客户端不依赖会话投影：下拉状态由 `getState` 现算，
 * 写入成功后客户端本地刷新即可。
 * @module dsh-approve-for-me/bridge
 */
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { collectModelIssues, normalizeModelChoice, parentModelOf, parseModelRef, selectReviewerModel } from './model-resolver.js';
import { resolveActivation } from './mode.js';
import { sessionModelOf } from './session-model.js';

/**
 * 装饰器标记所在的原型属性名。
 * 清单（`./typert`）是主路径；清单因宿主解析问题加载失败时，网关的 SRC 回退靠这个标记认领端点。
 * 纯 JS 没有装饰器语法，故按协议格式手写标记。
 */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';

/**
 * 把服务方法名与调用方式写成网关认领用的标记。
 * @param {readonly string[]} methods - 远程方法名。
 * @returns {object} 标记对象。
 */
function descriptors(methods) {
  return Object.freeze({
    version: 1,
    methods: Object.freeze(
      methods.map((method) => Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) })),
    ),
  });
}

/**
 * 组装会话级选择读取器：文件载体优先，旧事件折叠承接（design §6.3）。
 * 条目 `model: null` 按「清除」返回，表示继续看全局层。
 * @param {{read: (id: string) => {model: string | null, effort: string} | undefined} | undefined} store - 文件载体。
 * @param {((session: object | undefined) => object | undefined) | undefined} [legacy] - 旧事件折叠；默认 `lib/session-model.js`。
 * @returns {(session: object | undefined) => object | undefined} 读取器。
 */
export function createSessionChoiceReader(store, legacy = sessionModelOf) {
  return (session) => {
    const id = typeof session?.id === 'string' && session.id.length > 0 ? session.id : undefined;
    if (id !== undefined && store !== undefined && store !== null) {
      let entry;
      try {
        entry = store.read(id);
      } catch {
        entry = undefined;
      }
      if (entry !== undefined) {
        return entry.model === null
          ? { kind: 'clear' }
          : { kind: 'set', model: entry.model, effort: entry.effort };
      }
    }
    return legacy(session);
  };
}

/**
 * `traceRecords` 合并列表行的字段（design §8.2：行的组成由 `decision` 与 `outcome` 的在场表达——
 * 有 `decision` 即有审查记录，有 `outcome` 即有结算记录）。`reviewId` 是存储内部字段，不进产品投影。
 */
const TRACE_LIST_FIELDS = Object.freeze([
  'approvalId',
  'callId',
  'toolName',
  'origin',
  'escalation',
  'startedAt',
  'endedAt',
  'queueMs',
  'reviewMs',
  'humanWaitMs',
  'decision',
  'outcome',
  'source',
  'model',
  'effort',
  'risk',
  'auth',
  'reason',
  'subject',
  'truncated',
]);

/** 详情在列表之外允许透出的字段（design §8.2）：环节与解析、取证摘要、标识与全文段。 */
const TRACE_DETAIL_EXTRA = Object.freeze([
  'stage',
  'layer',
  'attempts',
  'tools',
  'fieldsDefaulted',
  'degraded',
  'preset',
  'evidence',
  'probes',
  'configTag',
  'policyTag',
  'tokens',
  'prompt',
  'input',
  'reasoning',
  'output',
]);

/**
 * 投影一条记录的标量字段：缺失标量给安全默认（`null`、`truncated` false），未知字段不透出——
 * 网关按声明 schema 逐字段校验，多给的键没有消费方。
 * @param {object} source - 取值来源记录。
 * @param {readonly string[]} fields - 字段清单。
 * @returns {object} 投影行。
 */
function projectFields(source, fields) {
  const row = {};
  for (const field of fields) {
    const value = source?.[field];
    row[field] =
      field === 'truncated'
        ? value === true
        : typeof value === 'number' && Number.isFinite(value)
          ? value
          : typeof value === 'string'
            ? value
            : null;
  }
  return row;
}

/**
 * 把同一审批的审查记录与结算记录合并成一条列表行（design §8.2/§8.5）：
 * `startedAt` 取审查记录起点、无审查记录时取结算记录起点；`endedAt` 取结算记录终点、
 * 结算缺失时取审查记录终点（审批跨度口径）。审查侧字段（decision/model/effort/risk/auth/
 * reason/queueMs/reviewMs）取自审查记录，结算侧字段（outcome/source/humanWaitMs）取自结算
 * 记录；subject 与 truncated 先审查后结算／任一置真。旧格式行独立成行、不合并不改写。
 * @param {{review?: object, settle?: object, legacy?: object}} pair - 两类记录（或旧格式行）。
 * @returns {object} 合并列表行。
 */
function traceRowOf(pair) {
  const { review, settle, legacy } = pair;
  if (legacy !== undefined) {
    return projectFields(legacy, TRACE_LIST_FIELDS);
  }
  const row = projectFields(review ?? settle, TRACE_LIST_FIELDS);
  const overlay = (source, fields) => {
    for (const field of fields) {
      const value = source[field];
      if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) row[field] = value;
    }
  };
  // 结算侧字段（outcome/source/humanWaitMs）与审查侧字段（判定与模型观测）各归各的来源；
  // 单边存在时以在场一方为准，缺的保持 null（在场表达，design §8.2）。
  if (settle !== undefined) overlay(settle, ['outcome', 'source', 'humanWaitMs']);
  if (review !== undefined) overlay(review, ['decision', 'model', 'effort', 'risk', 'auth', 'reason', 'queueMs', 'reviewMs']);
  if (review !== undefined && settle !== undefined) {
    row.startedAt = Number.isFinite(review.startedAt) ? review.startedAt : settle.startedAt ?? null;
    row.endedAt = Number.isFinite(settle.endedAt) ? settle.endedAt : review.endedAt ?? null;
    if (typeof settle.subject === 'string' && settle.subject.length > 0 && row.subject === null) {
      row.subject = settle.subject;
    }
    row.truncated = review.truncated === true || settle.truncated === true;
  }
  return row;
}

/**
 * 投影一条审批的合并详情（design §8.2）：列表字段之外补充环节、解析层级、取证摘要与标识；
 * 全文段是否在场由写入时的 `capture` 决定（存储层已按档裁剪，这里不补造）。
 * 结算侧独有字段（outcome/source/stage/humanWaitMs/preset）从结算记录补入。
 * @param {{review?: object, settle?: object, legacy?: object}} pair - 两类记录（或旧格式行）。
 * @returns {object} 详情行。
 */
function traceDetailOf(pair) {
  const { review, settle, legacy } = pair;
  if (legacy !== undefined) {
    // 旧格式行（design §8.3）：详情补充字段按「在场才写键」投影——详情 schema 对这些字段声明
    // optional（不接受 null），旧格式行基本不带它们，全量投影会把 null 塞进 optional 字段。
    const row = projectFields(legacy, TRACE_LIST_FIELDS);
    for (const field of TRACE_DETAIL_EXTRA) {
      const present = legacy[field];
      if (typeof present === 'string' || (typeof present === 'number' && Number.isFinite(present))) {
        row[field] = present;
      }
    }
    return row;
  }
  const row = traceRowOf(pair);
  for (const field of TRACE_DETAIL_EXTRA) {
    const fromReview = review?.[field];
    if (typeof fromReview === 'string' || (typeof fromReview === 'number' && Number.isFinite(fromReview))) {
      row[field] = fromReview;
      continue;
    }
    const fromSettle = settle?.[field];
    if (typeof fromSettle === 'string' || (typeof fromSettle === 'number' && Number.isFinite(fromSettle))) {
      row[field] = fromSettle;
    }
  }
  return row;
}

/**
 * 会话级审查模型服务。
 */
export class ApproveForMeService extends TypertRemoteService {
  /**
   * @param {object} ctx - 所属 cordis 上下文（需 `sessions` 与 `llm`）。
   * @param {object} deps - 注入点。
   * @param {() => {value?: object}} deps.settingsSnapshot - 读取生效配置的分层快照。
   * @param {object} [deps.sessionStore] - 会话级选择的文件载体（`createSessionStore`，design §6.3）。
   * @param {object} [deps.pending] - 审批卡片状态表（`createPendingState`）；缺省时 `pendingState` 返回空。
   * @param {object} [deps.mode] - 预设判定器（`createMode`）；缺省时 `active` 按 `trigger.unknown` 折算。
   * @param {object} [deps.traceStore] - 审查记录存储（`createTraceStore`，design §8.3）；缺省时两个 trace 端点返回空结果。
   * @param {object} [deps.resolver] - 模型解析器（`createResolver`）；`getState` 经它的 `selectFor`
   *   与审批共用同一选择逻辑与缓存，缺省时退化为无缓存的直接选择。
   * @param {object} [deps.llm] - 宿主 `ctx.llm` 替代注入（`modelIssues` 诊断用）；缺省时取 `ctx.llm`。
   */
  constructor(ctx, deps) {
    super(ctx, 'approveForMe');
    this.ctx = ctx;
    this.deps = deps;
    this.choiceOf = createSessionChoiceReader(deps.sessionStore, sessionModelOf);
  }

  /**
   * 读当前生效配置（`trigger` 判定与预设目录都用它）。
   * @returns {object} 配置。
   */
  config() {
    return this.deps.settingsSnapshot?.()?.value ?? {};
  }

  /**
   * 读某会话的配置状态：会话级当前值、全局级默认、最终生效的层级，以及审查模型不可用诊断
   * （design §7.2.0 的 `modelIssues`，三类作用域按层级分置提示）。
   * 会话级读取顺序＝文件载体 → 旧事件折叠（design §6.3）；文件条目的 `model: null` 按清除处理。
   * 生效值与审批共用同一选择逻辑（`selectFor`／`selectReviewerModel`，design §6.2），状态与审批不各算一套。
   * @param {string} sessionId - 会话 id（网关按声明顺序注入参数）。
   * @returns {Promise<{sessionModel: string | null, globalDefault: string, modelIssues: object[],
   *   effective: string, effectiveEffort: string, layer: string}>} 状态；缺会话或读不到会话时按「未设置」
   *   返回；生效配置读取抛错（volatile 可见配置错误）时按不可用口径呈现，不向 RPC 抛错。
   */
  async getState(sessionId) {
    const session = this.sessionOf(sessionId);
    // 生效配置读取纳入 try（与下方选择计算同一防抛口径）：volatile 写入重复条件等可见配置错误
    // 会让快照读取本身抛错（current()/normalizeConfig），状态通道按「读不到配置」呈现——reviewer 与
    // trigger/trace 都用这一份降级值，不把错误抛给 RPC；审批路径仍经异常路径按拒绝结算。
    let settings;
    try {
      settings = this.deps.settingsSnapshot?.()?.value ?? {};
    } catch (error) {
      process.stderr?.write?.(
        `approve-for-me: getState 配置读取失败：${error instanceof Error ? error.message : String(error)}\n`,
      );
      settings = {};
    }
    const reviewer = settings.reviewer ?? {};
    // 非活会话（found=false）也要读到已落盘的选择，因此再按请求里的 id 查一次。
    const fallbackChoice =
      session === undefined && typeof sessionId === 'string' && sessionId.length > 0
        ? this.choiceOf({ id: sessionId })
        : undefined;
    const choice = this.choiceOf(session) ?? fallbackChoice;
    const sessionModel = choice?.kind === 'set' ? choice.model : null;
    const sessionEffort = choice?.kind === 'set' ? choice.effort ?? '' : '';
    const global = normalizeModelChoice(reviewer.model);
    const globalDefault = global?.model ?? '';
    const globalEffort = global?.effort ?? '';
    const parent = parentModelOf(session);
    const llm = this.deps.llm ?? this.ctx?.llm;

    // 生效值：与审批同一选择（含缓存）。可见配置错误（如重复条件）不让状态通道抛错——
    // 按无可用模型呈现并在 stderr 留痕，审批路径仍经异常路径按拒绝结算。
    let resolution;
    try {
      resolution =
        typeof this.deps.resolver?.selectFor === 'function'
          ? await this.deps.resolver.selectFor({ sessionChoice: choice, parent })
          : await selectReviewerModel(llm, reviewer, choice, parent);
    } catch (error) {
      process.stderr?.write?.(
        `approve-for-me: getState 模型选择失败：${error instanceof Error ? error.message : String(error)}\n`,
      );
      resolution = { layer: 'unavailable', effort: 'none', degraded: 'all' };
    }
    const effective = resolution.layer === 'unavailable' ? '' : `${resolution.provider}/${resolution.model}`;
    // `effort='none'` 是「不传档位」的内部哨兵，对外呈现为空串（与 modelEfforts 的 defaultEffort 口径一致）。
    const effectiveEffort = resolution.effort === 'none' ? '' : resolution.effort;

    // 审查模型不可用诊断（design §6.2/§7.2.0）：global 与 rule 作用域不依赖会话，设置页无会话也能取到；
    // session 作用域仅在会话请求中产生。诊断计算失败时内部已留痕并返回空表。
    const modelIssues = await collectModelIssues({ llm, reviewer, sessionChoice: choice, parent });

    // 接管判定：与 gate 的 `mode()` 共用同一实现（design §2.1）。
    // 非活会话用「未来会话的默认预设」承接，让新会话的控件在会话开始前就能显示。
    const activation = resolveActivation(
      { permissionPresets: () => this.permissionPresetsService(), trigger: settings.trigger ?? {} },
      session,
    );

    // 轨迹集成（design §8.5）：自有视图开关与采集档随 getState 下发——客户端没有读插件配置的其它通道；
    // 只做插件自有呈现，无原生记录探测。配置读取抛错时上面已降级为空对象，此处同样按空对象取档默认值。
    const trace = settings.ui?.trace ?? {};
    return {
      found: session !== undefined,
      sessionModel,
      sessionEffort,
      globalDefault,
      globalEffort,
      modelIssues,
      effective,
      effectiveEffort,
      layer: resolution.layer,
      preset: activation.preset,
      active: activation.active === true,
      trace: {
        capture: typeof trace.capture === 'string' ? trace.capture : 'summary',
        ownView: trace.ownView !== false,
        turnSummary: trace.turnSummary !== false,
        legacyRow: trace.legacyRow === true,
      },
    };
  }

  /**
   * 列出某会话在飞的自动审批状态；供审批卡片显示状态行与倒计时（design §7.4）。
   * 只含本插件接管中的请求；非接管会话返回空数组。内存态：进程重启后为空。
   * @param {string} sessionId - 会话 id。
   * @returns {{entries: object[]}} 状态条目。
   */
  pendingState(sessionId) {
    try {
      return { entries: this.deps.pending?.list?.(sessionId) ?? [] };
    } catch {
      return { entries: [] };
    }
  }

  /**
   * 列出某会话的审查与结算记录合并行（design §8.2）；供审查视图的列表。同一审批的两类记录按
   * `approvalId` 合并，旧格式行独立成行。`readFailed` 标记该会话读取是否降级：
   * 页面据此提示「列表可能不完整」。存储缺失或读失败时返回空列表，不抛错（存储内部已降级并审计）。
   * @param {string} sessionId - 会话 id。
   * @returns {{records: object[], readFailed: boolean}} 合并行数组（旧在前）与读取降级标记。
   */
  traceRecords(sessionId) {
    try {
      const store = this.deps.traceStore;
      const rows = store?.list?.(sessionId) ?? [];
      /** 按 approvalId 分组（含旧格式行的合成键）；Map 保插入序＝窗口时间序。 */
      const pairs = new Map();
      for (const row of rows) {
        const approvalId = typeof row.approvalId === 'string' && row.approvalId.length > 0 ? row.approvalId : row.reviewId;
        const pair = pairs.get(approvalId) ?? {};
        if (row.kind === 'settle') pair.settle = row;
        else if (row.kind === 'review') pair.review = row;
        else pair.legacy = row; // 旧格式行（无 kind）独立成行。
        pairs.set(approvalId, pair);
      }
      return {
        records: [...pairs.values()].map(traceRowOf),
        readFailed: store?.degraded?.(sessionId) === true,
      };
    } catch {
      // 异常回退路径同样要承认不完整（requirements §7.2）：list 意外抛错时按读取失败呈现，不伪装成「没有记录」。
      return { records: [], readFailed: true };
    }
  }

  /**
   * 按审批实例 id 取一条审批的合并详情（design §8.2/§8.3：详情按 `approvalId` 返回两类记录的合并详情，
   * 不按存储行主键单查）；提示词/输入/思维链/输出是否带全文由写入时的 `capture` 档决定。
   * @param {string} sessionId - 会话 id。
   * @param {string} approvalId - 审批实例 id（`traceRecords` 行里的 `approvalId`；旧格式行为其自身 reviewId）。
   * @returns {{record: object | null}} 详情；窗口内找不到或缺存储时 `null`。
   */
  traceRecord(sessionId, approvalId) {
    try {
      const pair = this.deps.traceStore?.approval?.(sessionId, approvalId) ?? null;
      return { record: pair === null ? null : traceDetailOf(pair) };
    } catch {
      return { record: null };
    }
  }

  /**
   * 列出权限预设目录；供设置页的「接管预设」多选（requirements §6.1）。
   * 展示名优先取宿主给的 `name`（可能与 id 相同＝部署没给标签），说明取宿主 `description`。
   * @returns {{presets: {id: string, label: string, description: string, isDefault: boolean}[], configured: string[]}} 目录与配置回显。
   */
  presetCatalog() {
    const service = this.permissionPresetsService();
    const configured = Array.isArray(this.config()?.trigger?.presets) ? this.config().trigger.presets : [];
    const rows = [];
    const seen = new Set();
    try {
      const table = service?.presets ?? {};
      for (const id of service?.names ?? []) {
        if (typeof id !== 'string' || id.length === 0) continue;
        seen.add(id);
        const spec = table[id] ?? {};
        rows.push({
          id,
          label: typeof spec.name === 'string' && spec.name.length > 0 ? spec.name : id,
          description: typeof spec.description === 'string' ? spec.description : '',
          isDefault: service?.defaultPreset === id,
        });
      }
    } catch {
      // 预设表读取异常时退化为「只有配置回显」，设置页据此提示用 settings.yaml 编辑。
    }
    return { presets: rows, configured: configured.filter((id) => typeof id === 'string' && id.length > 0) };
  }

  /**
   * 读预设服务；服务缺失时返回 `undefined`。
   * @returns {object | undefined} `permissionPresets` 服务。
   */
  permissionPresetsService() {
    try {
      return this.ctx?.get?.('permissionPresets');
    } catch {
      return undefined;
    }
  }

  /**
   * 写会话级选择；`model` 为 `null` 时写清除条目（含义「跟随全局」）。
   * 只写文件载体，不写会话日志事件（design §6.3）；写失败时本次选择不落盘并审计。
   * @param {string} sessionId - 会话 id。
   * @param {string | null} model - 目标模型引用；`null` 清除。
   * @param {string} [effort] - 该模型上的推理档位；空串 = 按模型默认（requirements §5.1）。
   * @returns {{ok: boolean, error?: string}} 结果；失败时 `error` 给客户端直接展示。
   */
  setSessionModel(sessionId, model, effort) {
    const session = this.sessionOf(sessionId);
    const target = model ?? null;
    if (target !== null && parseModelRef(target, 'x') === undefined) {
      return { ok: false, error: '模型引用不合法，应形如 provider/model' };
    }
    const key = typeof session?.id === 'string' && session.id.length > 0 ? session.id : sessionId;
    let written = false;
    try {
      written = this.deps.sessionStore?.write?.(key, target, effort ?? '') === true;
    } catch {
      written = false;
    }
    if (written) return { ok: true };
    // 写失败：选择不落盘，客户端显示错误；审批路径按「未选择」走全局层（design §6.3）。
    this.deps.audit?.({
      phase: 'screen',
      action: 'skip',
      source: 'config',
      inject: 'no',
      degraded: 'session:file-store-failed',
      reason: `会话级选择写入失败，未落盘（请求：${target ?? 'clear'}/${effort ?? ''}）`,
    });
    return { ok: false, error: '会话级选择写入失败：本地存储不可写。' };
  }

  /**
   * 列出某个模型支持的推理档位；供下拉与设置页联动。
   * @param {string} provider - provider id。
   * @param {string} model - 模型 id。
   * @returns {Promise<{efforts: {id: string}[], defaultEffort: string}>} 档位清单；读取失败时为空。
   */
  async modelEfforts(provider, model) {
    try {
      const info = await this.ctx.llm.resolveModelInfo(provider, model);
      const efforts = (info?.reasoning?.efforts ?? [])
        .filter((entry) => typeof entry?.id === 'string' && entry.id.length > 0)
        .map((entry) => ({ id: entry.id }));
      const fallback = typeof info?.reasoning?.defaultEffort === 'string' ? info.reasoning.defaultEffort : '';
      return { efforts, defaultEffort: fallback };
    } catch {
      return { efforts: [], defaultEffort: '' };
    }
  }

  /**
   * 列出可选的审查模型；供下拉分组渲染。
   * `ctx.llm.listModels(provider)` 是异步的（`dsh-llm/lib/types/index.d.ts:333`）。
   * @returns {Promise<{providers: {id: string, models: {id: string}[]}[]}>} 目录；读取失败时返回空目录。
   */
  async modelCatalog() {
    try {
      const providers = this.ctx?.llm?.listProviders?.() ?? [];
      const rows = await Promise.all(
        providers
          .filter((entry) => typeof entry?.id === 'string' && entry.id.length > 0)
          .map(async (entry) => {
            let models = [];
            try {
              models = (await this.ctx.llm.listModels(entry.id)) ?? [];
            } catch {
              models = [];
            }
            return {
              id: entry.id,
              models: models
                .filter((model) => typeof model?.id === 'string' && model.id.length > 0)
                .map((model) => ({ id: model.id })),
            };
          }),
      );
      return { providers: rows };
    } catch {
      return { providers: [] };
    }
  }

  /**
   * 按 id 取会话。
   * 客户端的会话 id 与宿主 store 的 id 可能带不同的前缀（客户端为 `session-<uuid>`），
   * 因此先直接查，再用去前缀的写法回退：与活会话列表逐个比对。
   * @param {unknown} sessionId - 会话 id。
   * @returns {object | undefined} 会话；找不到时 `undefined`。
   */
  sessionOf(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
    const store = this.ctx?.sessions;
    if (store === undefined || store === null) return undefined;
    const bare = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId;
    try {
      const direct = store.get?.(sessionId);
      if (direct !== undefined && direct !== null) return direct;
      const stripped = store.get?.(bare);
      if (stripped !== undefined && stripped !== null) return stripped;
      const all = store.list?.() ?? [];
      return all.find((entry) => {
        const id = typeof entry?.id === 'string' ? entry.id : '';
        return id === sessionId || id === bare || id.endsWith(sessionId) || sessionId.endsWith(id);
      });
    } catch {
      return undefined;
    }
  }
}

Object.defineProperty(ApproveForMeService.prototype, REMOTE_METHOD_DESCRIPTOR, {
  configurable: true,
  value: descriptors([
    'getState',
    'setSessionModel',
    'modelEfforts',
    'modelCatalog',
    'pendingState',
    'presetCatalog',
    'traceRecords',
    'traceRecord',
  ]),
});

export default ApproveForMeService;
