/**
 * 本机配置加载器——公开范围与「本机侧」之间**唯一**的通道。
 *
 * 宿主安装树、实例 URL、启动 token 文件、浏览器与探针目录通过环境变量或
 * `.local/config.mjs` 提供；配置文件不由本公开仓跟踪。公开脚本与用例经本模块
 * 读取配置，不在代码中写入具体机器路径或实例坐标。
 *
 * **解析顺序（逐字段）**：
 *   1. 环境变量（最高优先，便于 CI 与一次性覆盖）
 *   2. `.local/config.mjs` 配置文件
 *   3. 文档化跳过——返回 undefined，**不抛错、不内置任何回退机器事实**
 *
 * **实例目标的解析优先序**（`instance()`／`resolveInstance()`；安全操作的关键，
 * 只设匿名环境变量并不等于「覆盖默认实例」）：
 *   1. 显式指名（`instance('名字')`，工具侧 `--url/--token-file` 显式传参同层）
 *      ——只认该名，找不到即 undefined，不回落任何默认。
 *   2. 未指名时取 `defaultInstance`（`DSAFM_INSTANCE` > 配置文件）指向的**具名**实例；
 *      配置里声明过该具名实例时，匿名环境实例不参与。
 *   3. 具名默认不存在（未配置/未声明）时，才用匿名回退
 *      `DSAFM_INSTANCE_URL`／`DSAFM_TOKEN_FILE`（CI 一次性实例的用法）。
 *   即：想把探针指向别的实例，要么显式传参/指名，要么改 `defaultInstance`；
 *   只设 `DSAFM_INSTANCE_URL` 在已有具名默认时**不起作用**（这是既有约定，
 *   不经兼容核对不做静默变更）。连接前请核对 `targetLine()` 打印的目标标识。
 *
 * 调用方拿到 undefined 时应当「跳过该用例/探针并打印一行说明」（见 missingNotice），
 * 而不是失败：公开克隆者没有本机环境，跳过是预期形态，不是错误。
 *
 * 环境变量：`DSAFM_HOST_MODULES`、`DSAFM_BROWSER_PATH`、`DSAFM_OUTPUT_DIR`、
 * `DSAFM_INSTANCE_URL`、`DSAFM_TOKEN_FILE`、`DSAFM_INSTANCE`，以及按实例名的
 * `DSAFM_<实例名大写>_URL` / `DSAFM_<实例名大写>_TOKEN_FILE`。
 */
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本机配置文件的绝对路径（相对本模块定位，因此与 cwd 无关）。 */
export const CONFIG_PATH = fileURLToPath(new URL('../.local/config.mjs', import.meta.url));

/** 加载结果缓存（含「加载失败」这一结果，避免每次调用都重试）。 */
let cache;

/** 是否正在加载。 */
let loading = false;

/**
 * 加载进行中时给**重入**调用方的应答：字段全空，带 `provisional` 标记。
 *
 * 为什么需要：本模块要动态 import 配置文件，而该 import 会经过 Node 的解析钩子链；
 * 解析钩子（见 tools/_host-resolve.mjs）可能回头问本模块要锚点——直接递归会栈溢出
 * （实测 `RangeError: Maximum call stack size exceeded`）。加载中一律按「暂无配置」
 * 应答，让钩子退回它自己的通用候选，从而打破环。
 */
const PROVISIONAL = Object.freeze({
  provisional: true,
  loaded: false,
  hostModules: undefined,
  browserPath: undefined,
  outputDir: undefined,
  defaultInstance: 'default',
  instances: {},
  fallbackInstance: undefined,
});

/**
 * 取环境变量值；空串按「未设置」处理。
 * @param {string} name - 环境变量名。
 * @returns {string|undefined} 值。
 */
function env(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** 取配置对象里的字符串字段；空串按「未声明」处理。 */
function str(source, key) {
  const value = source[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * 加载并归一化本机配置。
 *
 * 配置文件缺失、损坏、或形状不对时**一律降级为「无配置」**并打印一次告警——
 * 静默按无配置处理会让探针跑出看似成功实则取错值的读数，那是更坏的失败。
 * @returns {Promise<object>} 归一化后的配置（字段可能为 undefined）。
 */
export async function loadLocalConfig() {
  if (cache !== undefined) return cache;
  if (loading) return PROVISIONAL;
  loading = true;
  try {
    return await readConfig();
  } finally {
    loading = false;
  }
}

/**
 * 真正读一次配置文件并归一化。
 * @returns {Promise<object>} 归一化后的配置。
 */
async function readConfig() {
  let file = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      const module = await import(new URL('../.local/config.mjs', import.meta.url).href);
      const loaded = module.default ?? module.config ?? {};
      if (loaded === null || typeof loaded !== 'object') throw new TypeError('默认导出不是对象');
      file = loaded;
    } catch (error) {
      process.emitWarning(`[dsafm] 本机配置文件读取失败，按「无配置」处理：${error.message}`);
      file = {};
    }
  }

  const instances = {};
  const declared = file.instances !== null && typeof file.instances === 'object' ? file.instances : {};
  for (const [name, entry] of Object.entries(declared)) {
    if (entry === null || typeof entry !== 'object') continue;
    const upper = name.toUpperCase().replace(/[^A-Z0-9]+/gu, '_');
    const url = env(`DSAFM_${upper}_URL`) ?? str(entry, 'url');
    const tokenFile = env(`DSAFM_${upper}_TOKEN_FILE`) ?? str(entry, 'tokenFile');
    if (url === undefined && tokenFile === undefined) continue;
    instances[name] = { url, tokenFile };
  }

  cache = {
    hostModules: env('DSAFM_HOST_MODULES') ?? str(file, 'hostModules'),
    browserPath: env('DSAFM_BROWSER_PATH') ?? str(file, 'browserPath'),
    outputDir: env('DSAFM_OUTPUT_DIR') ?? str(file, 'outputDir'),
    defaultInstance: env('DSAFM_INSTANCE') ?? str(file, 'defaultInstance') ?? 'default',
    instances,
    /**
     * 全局回退实例：环境变量 `DSAFM_INSTANCE_URL` / `DSAFM_TOKEN_FILE` 声明的匿名实例。
     * 只在按名取不到时使用，便于 CI 注入「一次性实例」而不必改配置文件。
     */
    fallbackInstance: (() => {
      const url = env('DSAFM_INSTANCE_URL');
      const tokenFile = env('DSAFM_TOKEN_FILE');
      return url === undefined && tokenFile === undefined ? undefined : { url, tokenFile };
    })(),
    /** 配置文件是否读到内容（读坏时 file 归空、同为 false；读坏本身由装载处一次性告警区分）。 */
    loaded: Object.keys(file).length > 0,
  };
  return cache;
}

/**
 * 宿主 `node_modules` 锚点树（离线校验与宿主接线用例用）。
 * @returns {Promise<string|undefined>} 目录绝对路径。
 */
export async function hostModules() {
  return (await loadLocalConfig()).hostModules;
}

/**
 * 浏览器可执行文件路径（真实页面探针用）。
 * @returns {Promise<string|undefined>} 可执行文件绝对路径。
 */
export async function browserPath() {
  return (await loadLocalConfig()).browserPath;
}

/**
 * 探针输出目录。
 * @returns {Promise<string|undefined>} 目录路径。
 */
export async function outputDir() {
  return (await loadLocalConfig()).outputDir;
}

/**
 * 实例目标解析（纯函数，测试用假配置直接覆盖优先序矩阵）。
 *
 * 优先序见模块头注：显式指名只认该名；未指名先取具名默认实例（匿名环境实例
 * **不覆盖**已声明的具名默认）；具名默认不存在才用匿名回退。
 * @param {object} config - `loadLocalConfig()` 归一化后的配置（测试可传假配置）。
 * @param {string} [name] - 实例名；省略时按默认实例与匿名回退解析。
 * @returns {{url: string|undefined, tokenFile: string|undefined}|undefined} 接入信息。
 */
export function resolveInstance(config, name) {
  const wanted = name ?? config.defaultInstance;
  if (config.instances[wanted] !== undefined) return config.instances[wanted];
  if (name === undefined && config.fallbackInstance !== undefined) return config.fallbackInstance;
  return undefined;
}

/**
 * 连接前的非敏感目标标识行（每次连接前核对，无法确认即停止）。
 *
 * 只含实例 URL 与 token 文件**名**（不含目录、不含 token 内容）——足够核对目标，
 * 又不把机器路径或凭据带进日志/报告。
 * @param {{url?: string, tokenFile?: string} | undefined} entry - 接入信息。
 * @returns {string} 一行标识。
 */
export function targetLine(entry) {
  const url = typeof entry?.url === 'string' && entry.url.length > 0 ? entry.url : '-';
  const tokenFile = typeof entry?.tokenFile === 'string' && entry.tokenFile.length > 0
    ? basename(entry.tokenFile)
    : '-';
  return `[dsafm] 连接目标 url=${url} tokenFile=${tokenFile}`;
}

/**
 * 取实例的接入信息。
 *
 * 优先序与安全说明见模块头注与 `resolveInstance()`；这里只做装载与委托。
 * @param {string} [name] - 实例名；省略时按默认实例与匿名回退解析。
 * @returns {Promise<{url: string|undefined, tokenFile: string|undefined}|undefined>} 接入信息。
 */
export async function instance(name) {
  const config = await loadLocalConfig();
  return resolveInstance(config, name);
}

/**
 * 统一的「无配置即跳过」说明文案。
 *
 * 公开克隆者按此知道该设哪个环境变量、该看哪个示例文件；本机跑的时候这行只在
 * 真的没配时出现。**跳过原因必须打印**——静默跳过会被当成「跑过了」。
 * @param {string} field - 缺哪个字段（如 `hostModules`）。
 * @param {string} hint - 进一步提示（如「该用例需要宿主包解析锚点」）。
 * @returns {string} 一行说明。
 */
export function missingNotice(field, hint) {
  return `[dsafm] 未配置 ${field}${hint === undefined ? '' : `（${hint}）`}：`
    + `设对应 DSAFM_* 环境变量，或在不由本公开仓跟踪的本机配置里声明——形状见 tools/local-config.example.mjs。按文档化跳过。`;
}
