import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveInstance, targetLine } from '../tools/local-config.mjs';
import { connect, optionsFrom } from '../tools/probe-rpc.mjs';

/**
 * 实例目标解析与连接前标识：
 * - 假配置覆盖 `resolveInstance` 优先序矩阵（具名默认＋匿名环境回退的全部组合）；
 * - 假传输覆盖 `connect` 的换 cookie → RPC 往返，全程不触网、不连任何在用实例；
 * - 显式 `--url/--token-file` 与缺省目标的组合经 `optionsFrom` 钉住。
 */

/** 假配置工厂：具名默认 default + 匿名回退并存（误连事故的组合形态）。 */
const fakeConfig = (overrides = {}) => ({
  defaultInstance: 'default',
  instances: { default: { url: 'http://127.0.0.1:11111', tokenFile: 'C:/somewhere/default.token.yaml' } },
  fallbackInstance: { url: 'http://127.0.0.1:22222', tokenFile: 'C:/somewhere/anon.token.yaml' },
  ...overrides,
});

test('resolveInstance：未指名时具名默认优先——匿名环境实例不覆盖已配置的具名默认', () => {
  const hit = resolveInstance(fakeConfig(), undefined);
  assert.deepEqual(hit, { url: 'http://127.0.0.1:11111', tokenFile: 'C:/somewhere/default.token.yaml' });
});

test('resolveInstance：具名默认不存在（未配置/未声明）才用匿名回退', () => {
  const hit = resolveInstance(fakeConfig({ instances: {}, defaultInstance: 'absent' }), undefined);
  assert.deepEqual(hit, { url: 'http://127.0.0.1:22222', tokenFile: 'C:/somewhere/anon.token.yaml' });
});

test('resolveInstance：显式指名只认该名，找不到即 undefined——不回落默认也不回落匿名', () => {
  assert.deepEqual(resolveInstance(fakeConfig(), 'default'), fakeConfig().instances.default);
  assert.equal(resolveInstance(fakeConfig(), 'absent'), undefined, '具名缺失必须显式失败，不静默换目标');
});

test('resolveInstance：无具名默认也无匿名回退 → undefined（文档化跳过形态）', () => {
  const empty = fakeConfig({ instances: {}, fallbackInstance: undefined });
  assert.equal(resolveInstance(empty, undefined), undefined);
});

test('targetLine：只含实例坐标与 token 文件名——目录与 token 内容都不进标识行', () => {
  const line = targetLine({ url: 'http://127.0.0.1:11111', tokenFile: 'C:/Users/someone/.dsh/t/default.token.yaml' });
  assert.match(line, /url=http:\/\/127\.0\.0\.1:11111/u);
  assert.match(line, /tokenFile=default\.token\.yaml/u);
  assert.doesNotMatch(line, /Users|C:\/|\.dsh\//u, 'token 文件只报名，不报路径');
  assert.equal(targetLine(undefined), '[dsafm] 连接目标 url=- tokenFile=-', '无目标时两字段都显式为 -');
});

test('optionsFrom：显式 --url/--token-file 覆盖配置目标；省略回落目标；无目标为空串', () => {
  const target = { url: 'http://127.0.0.1:11111', tokenFile: 'C:/t/a.yaml' };
  const explicit = optionsFrom(['--url', 'http://127.0.0.1:33333', '--token-file', 'C:/t/b.yaml'], target);
  assert.deepEqual(explicit, { url: 'http://127.0.0.1:33333', tokenFile: 'C:/t/b.yaml', session: '' });
  assert.deepEqual(optionsFrom([], target), { url: target.url, tokenFile: target.tokenFile, session: '' });
  assert.deepEqual(optionsFrom([], undefined), { url: '', tokenFile: '', session: '' }, '无目标＝空串（调用方按缺配置跳过）');
});

test('connect 假传输：换 cookie → RPC 往返全在假目标上完成，不触网', async () => {
  const seen = [];
  /** 假 fetch：记录全部请求 URL，按路径回放 303 登录 / 200 首页 / RPC 应答。 */
  const fakeFetch = async (url, init = {}) => {
    const full = String(url);
    seen.push(full);
    assert.match(full, /^http:\/\/127\.0\.0\.1:44444\//u, '假传输之外的请求都算触网（连了在用实例）');
    if (full.includes('/?token=')) {
      return { status: 303, headers: { get: () => 'sid=fake; Path=/' }, ok: false, text: async () => '' };
    }
    if (full.endsWith('/api/approveForMe/getState')) {
      const body = JSON.parse(String(init.body));
      seen.push(`rpc:${body.rpcId}`);
      return { status: 200, ok: true, text: async () => JSON.stringify({ rpcId: body.rpcId, result: { ok: true, value: { active: true } } }) };
    }
    return { status: 200, ok: true, text: async () => '' };
  };
  const call = await connect('http://127.0.0.1:44444', 'fake-token', fakeFetch);
  const result = await call('approveForMe/getState', { sessionId: 's1' });
  assert.deepEqual(result, { ok: true, value: { active: true } }, 'RPC 结果按 rpcId 配对应答');
  assert.ok(seen.some((entry) => entry.startsWith('rpc:')), 'rpcId 配对路径经过假传输');
});

test('connect 假传输：应答 rpcId 不匹配即抛错（不把错包当好结果）', async () => {
  const fakeFetch = async (url) => {
    const full = String(url);
    if (full.includes('/?token=')) return { status: 303, headers: { get: () => 'sid=x' }, ok: false, text: async () => '' };
    if (full.endsWith('/')) return { status: 200, ok: true, text: async () => '' };
    return { status: 200, ok: true, text: async () => JSON.stringify({ rpcId: 'not-matching', result: {} }) };
  };
  const call = await connect('http://127.0.0.1:44444', 't', fakeFetch);
  await assert.rejects(() => call('approveForMe/getState', {}), /rpcId/u);
});

test('import probe-rpc 不执行 main（被测试装载时不发任何请求）', async () => {
  let touches = 0;
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    touches += 1;
    throw new Error('测试装载不得触网');
  };
  try {
    const mod = await import('../tools/probe-rpc.mjs');
    assert.equal(typeof mod.connect, 'function');
    assert.equal(typeof mod.optionsFrom, 'function');
    assert.equal(touches, 0, '装载探针模块不得发起连接');
  } finally {
    globalThis.fetch = original;
  }
});
