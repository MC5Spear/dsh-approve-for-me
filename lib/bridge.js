/**
 * dsh-approve-for-me — host 侧状态服务（供 composer 下拉）。
 *
 * 三个 RPC（设计「接口」）：读会话级当前值、写/清会话级选择、列出可选模型。
 * 会话级选择存在文件载体（`lib/session-store.js`，设计「会话级选择的文件载体」）：读取顺序＝文件载体 → 旧事件折叠，
 * 写入只写文件载体，不写会话日志事件。客户端不依赖会话投影：下拉状态由 `getState` 现算，
 * 写入成功后客户端本地刷新即可。
 * @module dsh-approve-for-me/bridge
 */
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { lookupByParentModel, normalizeModelChoice, parentModelOf, parseModelRef } from './model-resolver.js';
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
 * 组装会话级选择读取器：文件载体优先，旧事件折叠承接（设计「读取顺序与清除语义」）。
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
 * `traceRecords` 只回的摘要字段（设计 §17.2：列表按需拉单条详情，避免把全文推给客户端）。
 */
const TRACE_SUMMARY_FIELDS = Object.freeze([
  'reviewId',
  'callId',
  'startedAt',
  'endedAt',
  'queueMs',
  'reviewMs',
  'decision',
  'model',
  'effort',
  'toolName',
  'truncated',
]);

/** 详情在摘要之外允许透出的字段：分段耗时补充、`capture=full` 才存在的全文与 reviewId 来源。 */
const TRACE_DETAIL_EXTRA = Object.freeze([
  'humanWaitMs',
  'tokens',
  'reviewKeySource',
  'prompt',
  'input',
  'reasoning',
  'output',
]);

/**
 * 投影一条审查记录的摘要行：缺失标量给安全默认（字符串/数字 `null`、`truncated` false），
 * 未知字段不透出——网关按声明 schema 逐字段校验，多给的键没有消费方。
 * @param {object} record - 存储里的记录。
 * @returns {object} 摘要行。
 */
function traceSummaryOf(record) {
  const row = {};
  for (const field of TRACE_SUMMARY_FIELDS) {
    const value = record?.[field];
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
 * 投影一条审查记录的详情：摘要之外只补既有字段，全文是否在场由写入时的 `capture` 决定
 * （存储层已按档裁剪，这里不补造）。
 * @param {object} record - 存储里的记录。
 * @returns {object} 详情行。
 */
function traceDetailOf(record) {
  const row = traceSummaryOf(record);
  for (const field of TRACE_DETAIL_EXTRA) {
    const value = record?.[field];
    if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) row[field] = value;
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
   * @param {object} [deps.sessionStore] - 会话级选择的文件载体（`createSessionStore`，设计「会话级选择的文件载体」）。
   * @param {object} [deps.pending] - 审批卡片状态表（`createPendingState`）；缺省时 `pendingState` 返回空。
   * @param {object} [deps.mode] - 预设判定器（`createMode`）；缺省时 `active` 按 `trigger.unknown` 折算。
   * @param {object} [deps.traceStore] - 审查记录存储（`createTraceStore`，设计 §17.2）；缺省时两个 trace 端点返回空结果。
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
   * 读某会话的配置状态：会话级当前值、全局级两项、以及最终生效的层级。
   * 会话级读取顺序＝文件载体 → 旧事件折叠（设计「读取顺序与清除语义」）；文件条目的 `model: null` 按清除处理。
   * @param {string} sessionId - 会话 id（网关按声明顺序注入参数）。
   * @returns {{sessionModel: string | null, globalDefault: string, byParentModel: Record<string, string>, effective: string, layer: string}}
   *   状态；缺会话或读不到会话时按「未设置」返回。
   */
  getState(sessionId) {
    const session = this.sessionOf(sessionId);
    const reviewer = this.deps.settingsSnapshot?.()?.value?.reviewer ?? {};
    // 非活会话（found=false）也要读到已落盘的选择，因此再按请求里的 id 查一次。
    const fallbackChoice =
      session === undefined && typeof sessionId === 'string' && sessionId.length > 0
        ? this.choiceOf({ id: sessionId })
        : undefined;
    const choice = this.choiceOf(session) ?? fallbackChoice;
    const sessionModel = choice?.kind === 'set' ? choice.model : null;
    const sessionEffort = choice?.kind === 'set' ? choice.effort : '';
    const global = normalizeModelChoice(reviewer.model);
    const globalDefault = global?.model ?? '';
    const globalEffort = global?.effort ?? '';
    const byParentModel = reviewer.byParentModel ?? {};
    const parent = parentModelOf(session);
    const mapped = parent === undefined ? undefined : lookupByParentModel(byParentModel, parent.model);

    let effective = '';
    let effectiveEffort = '';
    let layer = 'unavailable';
    if (sessionModel !== null) {
      effective = sessionModel;
      effectiveEffort = sessionEffort;
      layer = 'session';
    } else if (mapped !== undefined) {
      effective = mapped.model;
      effectiveEffort = mapped.effort;
      layer = 'parent-map';
    } else if (globalDefault.length > 0) {
      effective = globalDefault;
      effectiveEffort = globalEffort;
      layer = 'global';
    } else if (reviewer.followParent !== false && parent !== undefined) {
      effective = `${parent.provider}/${parent.model}`;
      effectiveEffort = '';
      layer = 'follow-parent';
    }

    // 接管判定：与 gate 的 `mode()` 共用同一实现（设计「判定实现只有一份」）。
    // 非活会话用「未来会话的默认预设」承接，让新会话的控件在会话开始前就能显示（R15）。
    const activation = resolveActivation(
      { permissionPresets: () => this.permissionPresetsService(), trigger: this.config()?.trigger ?? {} },
      session,
    );

    // 轨迹集成（设计 §17）：自有视图开关与采集档随 getState 下发——客户端没有读插件配置的其它通道。
    // 0.1.7 起档位开关已退役（设计 §17.0）：只做插件自有呈现，无原生记录探测。
    const trace = this.config()?.ui?.trace ?? {};
    return {
      found: session !== undefined,
      sessionModel,
      sessionEffort,
      globalDefault,
      globalEffort,
      byParentModel,
      effective,
      effectiveEffort,
      layer,
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
   * 列出某会话在飞的自动审批状态；供审批卡片显示状态行与倒计时（设计「审批卡片内的自动审批状态条与倒计时」）。
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
   * 列出某会话的审查记录（只回摘要字段）；供审查视图的列表（设计 §17.2「读取走既有 Remote 命名空间」）。
   * 全文由 `traceRecord` 按需拉。存储缺失或读失败时返回空列表，不抛错（存储内部已降级并审计）。
   * @param {string} sessionId - 会话 id。
   * @returns {{records: object[]}} 摘要记录数组（旧在前）。
   */
  traceRecords(sessionId) {
    try {
      const rows = this.deps.traceStore?.list?.(sessionId) ?? [];
      return { records: rows.map(traceSummaryOf) };
    } catch {
      return { records: [] };
    }
  }

  /**
   * 取一条审查记录的详情；提示词/输入/思维链/输出是否带全文由写入时的 `capture` 档决定。
   * @param {string} sessionId - 会话 id。
   * @param {string} reviewId - 记录 id（`traceRecords` 行里的 `reviewId`）。
   * @returns {{record: object | null}} 详情；窗口内找不到或缺存储时 `null`。
   */
  traceRecord(sessionId, reviewId) {
    try {
      const record = this.deps.traceStore?.get?.(sessionId, reviewId) ?? null;
      return { record: record === null ? null : traceDetailOf(record) };
    } catch {
      return { record: null };
    }
  }

  /**
   * 列出权限预设目录；供设置页的「接管预设」多选（设计「接管预设：多选下拉」）。
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
   * 只写文件载体，不写会话日志事件（设计「会话级选择的文件载体」）；写失败时本次选择不落盘并审计。
   * @param {string} sessionId - 会话 id。
   * @param {string | null} model - 目标模型引用；`null` 清除。
   * @param {string} [effort] - 该模型上的推理档位；空串 = 按模型默认（设计「档位缺省语义（与 codex 同构）」）。
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
    // 写失败：选择不落盘，客户端显示错误；审批路径按「未选择」走全局层（设计「降级」）。
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
   * 因此先直接查，再用去前缀的写法与活会话列表兑底。
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
