/**
 * TYPERT 清单一致性测试。
 *
 * 判据单源：rc.1 契约的检查函数住在 `tools/typert-contract.mjs`，本文件与
 * `tools/check-typert-manifest.mjs` 共用同一份——两处各自维护会在离线检查器一侧漂移
 * （检查器曾按 rc.6 的 `codec.schema` 字段校验，漂出 18 条假红，r33 收敛为单源）。
 * 契约依据：`dsh-typert-loader/lib/index.js:153-212`（注册期校验）与
 * `dsh-typert-registry/lib/index.js:509-518`（`create()` 返回值即 schema，须为 zod v4 实例）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TYPERT } from '../typert.host.js';
import { checkCodec, checkInvocation } from '../tools/typert-contract.mjs';

test('TYPERT 清单：顶层形状合规', () => {
  assert.equal(TYPERT.package, 'dsh-approve-for-me');
  assert.equal(TYPERT.face, 'host');
  assert.ok(Array.isArray(TYPERT.schemas), 'schemas 必须是数组');
  assert.ok(Array.isArray(TYPERT.invocations) && TYPERT.invocations.length > 0, 'invocations 必须非空');
});

test('TYPERT 清单：每条 invocation 满足 rc.1 契约（含 create() 工厂）', () => {
  const failures = {};
  for (const invocation of TYPERT.invocations) {
    const found = checkInvocation(invocation);
    if (Object.keys(found).length > 0) failures[invocation.id ?? '<无 id>'] = found;
  }
  assert.deepEqual(failures, {}, `以下端点不合规：${JSON.stringify(failures, null, 2)}`);
});

test('TYPERT 清单：端点 id 唯一且与 service/namespace/method 自洽', () => {
  const ids = TYPERT.invocations.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, 'id 必须唯一');
  for (const item of TYPERT.invocations) {
    assert.equal(item.id, `dsh-approve-for-me#${item.namespace}/${item.method}`, `${item.id} 与 namespace/method 不自洽`);
    assert.equal(item.service, item.namespace, `${item.id} 的 service 与 namespace 不一致`);
  }
});

test('TYPERT 清单：checkCodec 本身能失败（对照，防恒真）', () => {
  // 反面对照：缺 create 的 codec 必须被判不合规——正是 2026-09-24 装载失败的形状。
  const legacy = { mode: 'strict', typeSymbol: 'x#y', schema: {} };
  assert.deepEqual(checkCodec(legacy), ['create 缺失或不是函数（rc.1 要求 create() 工厂）']);
  assert.ok(checkCodec({ mode: 'strict', typeSymbol: 'x#y', create: () => ({}) }).some((item) => item.includes('_zod')));
  assert.deepEqual(checkCodec({ mode: 'strict', typeSymbol: 'x#y', create: () => ({ _zod: {} }) }), []);
  // 正面：真实清单里的 codec 逐个通过（与上一测试同源，此处示证 checkCodec 不恒真也不恒假）。
  for (const item of TYPERT.invocations) {
    assert.deepEqual(checkCodec(item.result), [], `${item.id} result 应合规`);
  }
});
