/**
 * dsh-approve-for-me — 对运行中的 dsh web 实例做只读 RPC 探针。
 *
 * 用途：验证真实部署实例上插件的 Typert 端点是否可用、返回形状是否符合 design §7.1 的接口表。
 * 认证：读实例的启动 token 文件（服务托管方落盘的 `?token=` 行），先换一次 cookie 再调 `/api`。
 * 本探针不写任何状态（只调 getState / modelEfforts / modelCatalog / pendingState / presetCatalog）。
 *
 * 目标解析（安全操作约定，见 tools/local-config.mjs 头注）：显式 `--url/--token-file`
 * 只认传参值；省略时取本机配置的具名默认实例，具名默认不存在才用匿名环境变量回退
 * （`DSAFM_INSTANCE_URL`/`DSAFM_TOKEN_FILE` **不会**覆盖已配置的具名默认）。连接前
 * 会先在 stderr 打一行非敏感目标标识——核对不是预期实例就立即停止，不要带目标标识
 * 以外的动作继续。
 *
 * 用法（--url/--token-file 省略时取本机配置的默认实例，见 tools/local-config.example.mjs）：
 *   node tools/probe-rpc.mjs [--url http://127.0.0.1:PORT] [--token-file <token文件>] [--session <id>]
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { instance, missingNotice, targetLine } from './local-config.mjs';

/**
 * 从 argv 解析选项（纯函数，测试可用假目标直接覆盖显式/缺省组合）。
 * @param {string[]} argv - 参数表。
 * @param {{url?: string, tokenFile?: string} | undefined} target - 本机配置解析出的目标。
 * @returns {{url: string, tokenFile: string, session: string}} 选项。
 */
export function optionsFrom(argv, target) {
  const read = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
  };
  return {
    url: read('--url', target?.url ?? ''),
    tokenFile: read('--token-file', target?.tokenFile ?? ''),
    session: read('--session', ''),
  };
}

/**
 * 解析命令行参数；--url/--token-file 省略时回落 local-config 默认实例，--session 无默认。
 * @returns {Promise<{url: string, tokenFile: string, session: string}>} 选项。
 */
async function options() {
  return optionsFrom(process.argv.slice(2), await instance());
}

/**
 * 从 token 文件（内容为 `?token=` 行）中提取启动 token。
 * @param {string} file - token 文件路径。
 * @returns {string} token。
 */
function launchToken(file) {
  const text = readFileSync(file, 'utf8');
  const match = /token=([A-Za-z0-9_-]+)/u.exec(text);
  if (match === null) throw new Error(`token 文件里没有 token=：${file}`);
  return match[1];
}

/**
 * 建会话：用 token 换 cookie，返回可复用的请求函数。传输经 `fetchImpl` 注入，
 * 测试用假传输覆盖，不连接任何在用实例。
 * @param {string} base - 实例完整 URL（如 `http://127.0.0.1:PORT`）。
 * @param {string} token - 启动 token。
 * @param {typeof fetch} [fetchImpl] - 传输实现，默认全局 fetch。
 * @returns {Promise<(endpoint: string, args: object) => Promise<object>>} RPC 调用器。
 */
export async function connect(base, token, fetchImpl = fetch) {
  const first = await fetchImpl(`${base}/?token=${token}`, { redirect: 'manual' });
  if (first.status !== 303) throw new Error(`token 换 cookie 失败：HTTP ${first.status}`);
  const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0];
  if (cookie.length === 0) throw new Error('登录响应没有 set-cookie');
  const home = await fetchImpl(`${base}/`, { headers: { cookie } });
  if (home.status !== 200) throw new Error(`首页打开失败：HTTP ${home.status}`);
  return async (endpoint, args) => {
    const rpcId = globalThis.crypto.randomUUID();
    const response = await fetchImpl(`${base}/api/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${endpoint} 传输失败：HTTP ${response.status} ${text.slice(0, 200)}`);
    const full = JSON.parse(text);
    if (full.rpcId !== rpcId) throw new Error(`${endpoint} rpcId 不匹配`);
    return full.result;
  };
}

async function main() {
  const opts = await options();
  if (opts.url === '' || opts.tokenFile === '') {
    console.log(missingNotice('instance', 'RPC 探针需要一个可达的实例与启动 token 文件'));
    return;
  }
  // 连接前核对非敏感目标标识：目标不是预期的自建实例就立即停止。
  console.error(targetLine(opts));
  const token = launchToken(opts.tokenFile);
  const call = await connect(opts.url, token);
  console.log(`实例：${opts.url}（token 来自 ${opts.tokenFile}）`);

  /**
   * 端点应答的形状是 `{ ok: true, value }` 或 `{ ok: false, error }`（连接层的 server-response 信封）。
   * @param {{ok: boolean, value?: object, error?: object}} response - 应答。
   * @returns {object} `value`；失败时抛错，避免把 undefined 当成生效值。
   */
  const unwrap = (response) => {
    if (response?.ok !== true) throw new Error(`端点失败：${JSON.stringify(response?.error ?? response)}`);
    return response.value;
  };

  const catalog = unwrap(await call('approveForMe/modelCatalog', {}));
  console.log('modelCatalog:', JSON.stringify(catalog).slice(0, 400));

  const state = unwrap(await call('approveForMe/getState', { sessionId: opts.session }));
  console.log('getState:', JSON.stringify(state));

  // 两个只读端点：卡片状态表（无在飞审批时为空）与权限预设目录（供接管预设多选）。
  const presets = unwrap(await call('approveForMe/presetCatalog', {}));
  console.log('presetCatalog:', JSON.stringify(presets));
  const pending = unwrap(await call('approveForMe/pendingState', { sessionId: opts.session }));
  console.log('pendingState:', JSON.stringify(pending));

  const provider = String(state?.effective ?? '').split('/')[0];
  const model = String(state?.effective ?? '').split('/').slice(1).join('/');
  if (provider.length > 0 && model.length > 0) {
    const efforts = unwrap(await call('approveForMe/modelEfforts', { provider, model }));
    console.log(`modelEfforts(${provider}/${model}):`, JSON.stringify(efforts));
  }
}

// 直接运行才执行 main（被测试 import 时不连接任何实例）。
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
