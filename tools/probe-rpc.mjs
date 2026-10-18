/**
 * dsh-approve-for-me — 对运行中的 dsh web 实例做只读 RPC 探针。
 *
 * 用途：验证真实部署实例上插件的 Typert 端点是否可用、返回形状是否符合 design §7.1 的接口表。
 * 认证：读实例的启动 token 文件（服务托管方落盘的 `?token=` 行），先换一次 cookie 再调 `/api`。
 * 本探针不写任何状态（只调 getState / modelEfforts / modelCatalog / pendingState / presetCatalog）。
 *
 * 用法（--url/--token-file 省略时取本机配置的默认实例，见 tools/local-config.example.mjs）：
 *   node tools/probe-rpc.mjs [--url http://127.0.0.1:PORT] [--token-file <token文件>] [--session <id>]
 */
import { readFileSync } from 'node:fs';
import { instance, missingNotice } from './local-config.mjs';

/**
 * 解析命令行参数。
 * @returns {Promise<{url: string, tokenFile: string, session: string}>} 选项。
 */
async function options() {
  const argv = process.argv.slice(2);
  const read = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
  };
  const target = await instance();
  return {
    url: read('--url', target?.url ?? ''),
    tokenFile: read('--token-file', target?.tokenFile ?? ''),
    session: read('--session', ''),
  };
}

/**
 * 从 token 文件里取出 URL 行。
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
 * 建会话：用 token 换 cookie，返回可复用的请求函数。
 * @param {string} base - 实例完整 URL（如 `http://127.0.0.1:PORT`）。
 * @param {string} token - 启动 token。
 * @returns {Promise<(endpoint: string, args: object) => Promise<object>>} RPC 调用器。
 */
async function connect(base, token) {
  const first = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
  if (first.status !== 303) throw new Error(`token 换 cookie 失败：HTTP ${first.status}`);
  const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0];
  if (cookie.length === 0) throw new Error('登录响应没有 set-cookie');
  const home = await fetch(`${base}/`, { headers: { cookie } });
  if (home.status !== 200) throw new Error(`首页打开失败：HTTP ${home.status}`);
  return async (endpoint, args) => {
    const rpcId = globalThis.crypto.randomUUID();
    const response = await fetch(`${base}/api/${endpoint}`, {
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

/**
 * 主流程。
 * @returns {Promise<void>} 无返回。
 */
async function main() {
  const opts = await options();
  if (opts.url === '' || opts.tokenFile === '') {
    console.log(missingNotice('instance', 'RPC 探针需要一个可达的实例与启动 token 文件'));
    return;
  }
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

await main();
