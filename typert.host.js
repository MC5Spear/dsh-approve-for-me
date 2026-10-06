/**
 * dsh-approve-for-me — Typert host 清单。
 *
 * `dsh-typert-loader` 通过包的 `exports['./typert']` 找到本文件并注册进 `ctx.typert`，
 * 网关随后把 `approveForMe/getState` 等端点路由到 `ApproveForMeService`（设计「状态通道（供 composer 下拉）」、设计「接口」）。
 * schema 必须是 zod v4 实例（loader 校验 `_zod`）。
 * @module dsh-approve-for-me/typert
 */
import { z } from 'zod';

/** `getState` 参数：会话 id。 */
export const getStateArgsSchema = z.object({ sessionId: z.string() });
/** `getState` 结果：会话级当前值（含档位）、全局级两项、最终生效层级与接管判定。 */
export const getStateResultSchema = z.object({
  found: z.boolean(),
  sessionModel: z.string().nullable(),
  sessionEffort: z.string(),
  globalDefault: z.string(),
  globalEffort: z.string(),
  byParentModel: z.record(z.string(), z.unknown()),
  effective: z.string(),
  effectiveEffort: z.string(),
  layer: z.string(),
  preset: z.string().nullable(),
  active: z.boolean(),
  /** 轨迹集成（设计 §17）：自有视图开关与采集档；0.1.7 起档位开关已退役（§17.0）。 */
  trace: z.object({ capture: z.string(), ownView: z.boolean(), turnSummary: z.boolean(), legacyRow: z.boolean() }),
});

/** `modelEfforts` 结果：某模型支持的推理档位。 */
export const modelEffortsResultSchema = z.object({
  efforts: z.array(z.object({ id: z.string() })),
  defaultEffort: z.string(),
});

/** `setSessionModel` 结果；失败时 `error` 直接展示给用户。 */
export const setSessionModelResultSchema = z.object({ ok: z.boolean(), error: z.string().optional() });

/** `modelCatalog` 结果：按 provider 分组的模型清单。 */
export const modelCatalogResultSchema = z.object({
  providers: z.array(z.object({ id: z.string(), models: z.array(z.object({ id: z.string() })) })),
});

/** `pendingState` 结果：该会话在飞的自动审批状态（卡片状态条与倒计时用）。 */
export const pendingStateResultSchema = z.object({
  entries: z.array(
    z.object({
      callId: z.string(),
      state: z.string(),
      reason: z.string(),
      startedAt: z.number(),
      deadlineAt: z.number().nullable(),
      deadlineKind: z.string().nullable(),
      updatedAt: z.number(),
    }),
  ),
});

/** `presetCatalog` 结果：权限预设目录与配置回显（接管预设多选用）。 */
export const presetCatalogResultSchema = z.object({
  presets: z.array(
    z.object({ id: z.string(), label: z.string(), description: z.string(), isDefault: z.boolean() }),
  ),
  configured: z.array(z.string()),
});

/** `traceRecords` 结果：某会话的审查记录列表（只回摘要字段，全文由 `traceRecord` 按需拉）。 */
export const traceRecordsResultSchema = z.object({
  records: z.array(
    z.object({
      reviewId: z.string(),
      callId: z.string().nullable(),
      startedAt: z.number().nullable(),
      endedAt: z.number().nullable(),
      queueMs: z.number().nullable(),
      reviewMs: z.number().nullable(),
      decision: z.string().nullable(),
      model: z.string().nullable(),
      effort: z.string().nullable(),
      toolName: z.string().nullable(),
      truncated: z.boolean(),
    }),
  ),
});

/** `traceRecord` 结果：单条审查记录详情；全文字段只在写入时 `capture=full` 才存在。 */
export const traceRecordResultSchema = z.object({
  record: z
    .object({
      reviewId: z.string(),
      callId: z.string().nullable(),
      startedAt: z.number().nullable(),
      endedAt: z.number().nullable(),
      queueMs: z.number().nullable(),
      reviewMs: z.number().nullable(),
      decision: z.string().nullable(),
      model: z.string().nullable(),
      effort: z.string().nullable(),
      toolName: z.string().nullable(),
      truncated: z.boolean(),
      humanWaitMs: z.number().optional(),
      tokens: z.number().optional(),
      reviewKeySource: z.string().optional(),
      prompt: z.string().optional(),
      input: z.string().optional(),
      reasoning: z.string().optional(),
      output: z.string().optional(),
    })
    .nullable(),
});

/**
 * 组装一个端点的参数声明。
 * 网关把载荷里的 `args` 对象按 `wire` 名字逐个对字段（`assertExactArguments` 要求字段名与 `wire` 一一对应），
 * 因此这里直接列出字段，而不是再包一层 `args`。
 * @param {object[]} [fields] - 字段列表。
 * @returns {object[]} 参数声明数组。
 */
function params(fields) {
  return (fields ?? []).map(({ name, schema, optional }) => ({
    name,
    wire: name,
    source: 'json',
    ...(optional === true ? { acceptsUndefined: true } : {}),
    codec: { mode: 'strict', typeSymbol: `dsh-approve-for-me/types#${name}`, create: () => schema },
  }));
}

export const TYPERT = {
  package: 'dsh-approve-for-me',
  face: 'host',
  schemas: [],
  invocations: [
    {
      id: 'dsh-approve-for-me#approveForMe/getState',
      service: 'approveForMe',
      namespace: 'approveForMe',
      method: 'getState',
      invocation: { kind: 'direct' },
      parameters: params([{ name: 'sessionId', schema: z.string() }]),
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-approve-for-me/types#GetStateResult',
        create: () => getStateResultSchema,
      },
    },
    {
      id: 'dsh-approve-for-me#approveForMe/setSessionModel',
      service: 'approveForMe',
      namespace: 'approveForMe',
      method: 'setSessionModel',
      invocation: { kind: 'direct' },
      parameters: params([
        { name: 'sessionId', schema: z.string() },
        { name: 'model', schema: z.string().nullable() },
        { name: 'effort', schema: z.string() },
      ]),
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-approve-for-me/types#SetSessionModelResult',
        create: () => setSessionModelResultSchema,
      },
    },
    {
      id: 'dsh-approve-for-me#approveForMe/modelEfforts',
      service: 'approveForMe',
      namespace: 'approveForMe',
      method: 'modelEfforts',
      invocation: { kind: 'direct' },
      parameters: params([{ name: 'provider', schema: z.string() }, { name: 'model', schema: z.string() }]),
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-approve-for-me/types#ModelEfforts',
        create: () => modelEffortsResultSchema,
      },
    },
    {
      id: 'dsh-approve-for-me#approveForMe/modelCatalog',
      service: 'approveForMe',
      namespace: 'approveForMe',
      method: 'modelCatalog',
      invocation: { kind: 'direct' },
      parameters: params([]),
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-approve-for-me/types#ModelCatalog',
        create: () => modelCatalogResultSchema,
      },
    },
    {
      id: 'dsh-approve-for-me#approveForMe/pendingState',
      service: 'approveForMe',
      namespace: 'approveForMe',
      method: 'pendingState',
      invocation: { kind: 'direct' },
      parameters: params([{ name: 'sessionId', schema: z.string() }]),
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-approve-for-me/types#PendingState',
        create: () => pendingStateResultSchema,
      },
    },
    {
      id: 'dsh-approve-for-me#approveForMe/presetCatalog',
      service: 'approveForMe',
      namespace: 'approveForMe',
      method: 'presetCatalog',
      invocation: { kind: 'direct' },
      parameters: params([]),
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-approve-for-me/types#PresetCatalog',
        create: () => presetCatalogResultSchema,
      },
    },
    {
      id: 'dsh-approve-for-me#approveForMe/traceRecords',
      service: 'approveForMe',
      namespace: 'approveForMe',
      method: 'traceRecords',
      invocation: { kind: 'direct' },
      parameters: params([{ name: 'sessionId', schema: z.string() }]),
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-approve-for-me/types#TraceRecordsResult',
        create: () => traceRecordsResultSchema,
      },
    },
    {
      id: 'dsh-approve-for-me#approveForMe/traceRecord',
      service: 'approveForMe',
      namespace: 'approveForMe',
      method: 'traceRecord',
      invocation: { kind: 'direct' },
      parameters: params([
        { name: 'sessionId', schema: z.string() },
        { name: 'reviewId', schema: z.string() },
      ]),
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-approve-for-me/types#TraceRecordResult',
        create: () => traceRecordResultSchema,
      },
    },
  ],
  model: {
    services: [
      {
        key: 'approveForMe',
        exportName: 'ApproveForMeService',
        description:
          'Read and write the per-session reviewer model so the composer dropdown can show and change it.',
        summary: 'Automatic approval reviewer model selection.',
        tags: [],
        jsDoc:
          '/**\n * Read and write the per-session reviewer model and list selectable models.\n */',
        members: [
          {
            kind: 'method',
            name: 'getState',
            signature: '@Remote("getState") getState(args: { sessionId: string }): GetStateResult',
            summary: 'Read the effective reviewer model and its layer for one session.',
            jsDoc:
              '/**\n * Read one session reviewer model state.\n * @param args - session id.\n * @returns session value, global layers and the effective layer.\n */',
          },
          {
            kind: 'method',
            name: 'setSessionModel',
            signature: '@Remote("setSessionModel") setSessionModel(args: { sessionId: string; model: string | null; effort: string }): SetSessionModelResult',
            summary: 'Set or clear the per-session reviewer model and its reasoning effort.',
            jsDoc:
              '/**\n * Set or clear the per-session reviewer model.\n * @param args - session id, the model reference (null clears) and the effort (empty follows the model default).\n * @returns `{ ok }` or `{ ok: false, error }`.\n */',
          },
          {
            kind: 'method',
            name: 'modelEfforts',
            signature: '@Remote("modelEfforts") modelEfforts(args: { provider: string; model: string }): ModelEfforts',
            summary: 'List the reasoning efforts one model supports, for the model and effort dropdowns.',
            jsDoc:
              '/**\n * List the reasoning efforts one model supports.\n * @param args - provider id and model id.\n * @returns supported efforts and the model default effort.\n */',
          },
          {
            kind: 'method',
            name: 'modelCatalog',
            signature: '@Remote("modelCatalog") modelCatalog(args: {}): ModelCatalog',
            summary: 'List selectable reviewer models grouped by provider.',
            jsDoc:
              '/**\n * List selectable models.\n * @returns providers with their models.\n */',
          },
          {
            kind: 'method',
            name: 'pendingState',
            signature: '@Remote("pendingState") pendingState(args: { sessionId: string }): PendingState',
            summary: 'List the in-flight auto-approval states of one session, for the approval card state line.',
            jsDoc:
              '/**\n * List the in-flight auto-approval states of one session.\n * @param args - session id.\n * @returns the state entries the approval card renders.\n */',
          },
          {
            kind: 'method',
            name: 'presetCatalog',
            signature: '@Remote("presetCatalog") presetCatalog(args: {}): PresetCatalog',
            summary: 'List the deployment permission presets, for the take-over preset multi-select.',
            jsDoc:
              '/**\n * List the deployment permission presets.\n * @returns preset rows plus the ids currently configured.\n */',
          },
          {
            kind: 'method',
            name: 'traceRecords',
            signature: '@Remote("traceRecords") traceRecords(args: { sessionId: string }): TraceRecordsResult',
            summary: 'List the review records of one session as summary rows, for the review history view.',
            jsDoc:
              '/**\n * List one session review records (summary fields only).\n * @param args - session id.\n * @returns summary rows; full texts are fetched per record via traceRecord.\n */',
          },
          {
            kind: 'method',
            name: 'traceRecord',
            signature: '@Remote("traceRecord") traceRecord(args: { sessionId: string; reviewId: string }): TraceRecordResult',
            summary: 'Read one review record with its details, full texts only when captured as full.',
            jsDoc:
              '/**\n * Read one review record with details.\n * @param args - session id and the reviewId from a traceRecords row.\n * @returns the record, or null when it is outside the read-back window.\n */',
          },
        ],
        types: [
          {
            name: 'GetStateResult',
            declaration:
              'export interface GetStateResult { found: boolean; sessionModel: string | null; sessionEffort: string; globalDefault: string; globalEffort: string; byParentModel: Record<string, unknown>; effective: string; effectiveEffort: string; layer: string; preset: string | null; active: boolean; trace: { capture: string; ownView: boolean; turnSummary: boolean; legacyRow: boolean }; }',
          },
          {
            name: 'ModelEfforts',
            declaration:
              'export interface ModelEfforts { efforts: { id: string }[]; defaultEffort: string; }',
          },
          {
            name: 'SetSessionModelResult',
            declaration: 'export interface SetSessionModelResult { ok: boolean; error?: string; }',
          },
          {
            name: 'ModelCatalog',
            declaration:
              'export interface ModelCatalog { providers: { id: string; models: { id: string }[] }[]; }',
          },
          {
            name: 'PendingState',
            declaration:
              'export interface PendingState { entries: { callId: string; state: string; reason: string; startedAt: number; deadlineAt: number | null; deadlineKind: string | null; updatedAt: number; }[]; }',
          },
          {
            name: 'PresetCatalog',
            declaration:
              'export interface PresetCatalog { presets: { id: string; label: string; description: string; isDefault: boolean }[]; configured: string[]; }',
          },
          {
            name: 'TraceRecordsResult',
            declaration:
              'export interface TraceRecordsResult { records: { reviewId: string; callId: string | null; startedAt: number | null; endedAt: number | null; queueMs: number | null; reviewMs: number | null; decision: string | null; model: string | null; effort: string | null; toolName: string | null; truncated: boolean; }[]; }',
          },
          {
            name: 'TraceRecordResult',
            declaration:
              'export interface TraceRecordResult { record: { reviewId: string; callId: string | null; startedAt: number | null; endedAt: number | null; queueMs: number | null; reviewMs: number | null; decision: string | null; model: string | null; effort: string | null; toolName: string | null; truncated: boolean; humanWaitMs?: number; tokens?: number; reviewKeySource?: string; prompt?: string; input?: string; reasoning?: string; output?: string; } | null; }',
          },
        ],
      },
    ],
    events: [],
    objects: [],
  },
};

export default TYPERT;
