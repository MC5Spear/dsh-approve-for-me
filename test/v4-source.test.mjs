/**
 * 回归测试：注入消息的源形状必须通过宿主会话格式 v4 的真准入校验。
 *
 * 0.1.7 会话格式 v4 退役了 v3 的插件源包装：`agent.inject()` 若用旧包装构造消息，
 * `session.append` 的行准入抛 `format v4 message requires a producer-owned source kind`，
 * 当轮中断、会话卡死。本文件用宿主锚点树导出的真校验器 `assertV4RowAdmission`
 * （经 `tools/_host-resolve.mjs` 锚定）守住 `lib/source.js` 的形状：
 * 生产与测试共用 `injectionMessage` 工厂，测试校验的就是生产构造的那份消息。
 *
 * 能失败性：反例用例断言 v3 形状仍被同一校验器拒绝——校验器若变成空转，
 * 反例先红；把 `lib/source.js` 改回旧形状，正向用例即红。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_MESSAGE_SOURCE, injectionMessage } from '../lib/source.js';

/**
 * 懒加载宿主锚点树导出的真校验器（经 `tools/_host-resolve.mjs` / `_host-hooks.mjs`
 * 锚定；锚点树版本由 `test/host-tree.test.mjs` 的守卫钉住，不在此写死版本号）。
 *
 * 离线跑 `node --test test/` 时宿主包解析不到——与 `index.test.mjs` 同一纪律：只吞
 * 「宿主包解析不到」这一种失败并整体跳过（跳过不等于通过），语法错等其余失败照常红。
 * @returns {Promise<object | undefined>} 校验器模块；宿主包不可解析时为 `undefined`。
 */
async function loadAdmission() {
  try {
    return await import('@deepseek-ai/dsh-session-format-v3-to-v4');
  } catch (error) {
    const message = String(error?.message ?? error);
    const hostPackageMissing = error?.code === 'ERR_MODULE_NOT_FOUND' && message.includes('@deepseek-ai/');
    if (hostPackageMissing) return undefined;
    throw error;
  }
}

/** 构造一条 `agent.inject` 落盘形态的 `agent/inbox/spliced` 物理行。 */
function splicedRow(message) {
  return {
    type: 'agent/inbox/spliced',
    seq: 7,
    time: 1790325715190,
    data: { target: 'next-step', start: 0, inserted: [message] },
  };
}

test('注入消息通过 v4 行准入（agent/inbox/spliced，宿主真实落盘形态）', async (t) => {
  const admission = await loadAdmission();
  if (admission === undefined) {
    t.skip('宿主校验器包不可解析（离线环境）');
    return;
  }
  assert.doesNotThrow(() => admission.assertV4RowAdmission(splicedRow(injectionMessage('已自动放行一项操作。'))));
});

test('同形状通过 user/message 行准入（直写消息路径）', async (t) => {
  const admission = await loadAdmission();
  if (admission === undefined) {
    t.skip('宿主校验器包不可解析（离线环境）');
    return;
  }
  const row = { type: 'user/message', seq: 8, time: 1790325715190, data: injectionMessage('x') };
  assert.doesNotThrow(() => admission.assertV4RowAdmission(row));
});

test('源形状是 plugin:approve-for-me 且不含 plugin 字段（迁移器 rewritePluginSource 的规范映射）', () => {
  assert.deepEqual(PLUGIN_MESSAGE_SOURCE, { kind: 'plugin:approve-for-me' });
});

test('反例：v3 退役的插件源包装被同一校验器拒绝（证明校验器在岗、本测试能失败）', async (t) => {
  const admission = await loadAdmission();
  if (admission === undefined) {
    t.skip('宿主校验器包不可解析（离线环境）');
    return;
  }
  const retired = { ...injectionMessage('x'), source: { kind: 'plugin', plugin: 'approve-for-me' } };
  assert.throws(() => admission.assertV4RowAdmission(splicedRow(retired)), /producer-owned source kind/u);
});

test('静态守卫：lib/*.js 不得重新出现 v3 退役源字面量（覆盖全部构造点，含审查对话）', () => {
  const libDir = join(import.meta.dirname, '..', 'lib');
  const files = readdirSync(libDir).filter((name) => name.endsWith('.js'));
  assert.ok(files.includes('source.js') && files.includes('index.js') && files.includes('reviewer.js'), 'lib 文件清单异常，静态守卫可能漏扫');
  for (const name of files) {
    const text = readFileSync(join(libDir, name), 'utf8');
    assert.doesNotMatch(text, /kind:\s*['"]plugin['"]\s*[,}]/u, `${name} 重新引入了 v3 退役的源形状`);
  }
});
