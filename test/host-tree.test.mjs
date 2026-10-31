import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadAdmission, admits } from '../tools/host-admission.mjs';

/**
 * 宿主解析树的锚点守卫（design §10.4）：`tools/_host-resolve.mjs` 的锚点指向其他
 * 宿主版本时，套件其余用例不会变红——本守卫钉住的就是这个缺口。宿主解析钩子
 * 生效时（`npm test` 带 `--import ./tools/_host-hooks.mjs`）断言三件事：
 *
 * 1. `dsh-llm` 解析实体版本 ∈ package.json 声明的准入集合；
 * 2. `dsh-typert-protocol` 解析实体版本与 `dsh-llm` 相同——两包须来自同一目标 RC；
 * 3. 两包解析自同一棵 node_modules（树前缀比较，防混树解析）。
 *
 * 声明本身的归一失败同样判红（准入声明不可解析时守卫没有可依据的集合）。
 * 环境变量 `DSAFM_EXPECT_HOST` 提供可选期望版本：提供时期望须 ∈ 准入集合，且两枚
 * 实体必须等于期望——CI 矩阵行与逐 RC 装置由此把「装错版本」直接判红，不靠人工
 * 比对日志辨认是否重复测了同一 RC。
 */

/** 期望版本的环境变量名（design §10.4，名称属实现裁量）。 */
const EXPECT_ENV = 'DSAFM_EXPECT_HOST';

/** 从解析出的实体 URL 定位包根，读取其 package.json，返回 version 字段与解析 URL。 */
function resolvedPackageVersion(specifier) {
  const resolved = import.meta.resolve(specifier);
  const marker = new RegExp(`(?:^|[\\\\/])node_modules[\\\\/]@deepseek-ai[\\\\/]${specifier.split('/').at(-1)}[\\\\/]`, 'u').exec(resolved);
  assert.notEqual(marker, null, `解析结果不在 node_modules/@deepseek-ai/${specifier.split('/').at(-1)} 下：${resolved}`);
  return {
    resolved,
    version: JSON.parse(readFileSync(new URL(`${resolved.slice(0, marker.index + marker[0].length)}package.json`), 'utf8')).version,
  };
}

/** 两枚宿主包解析 URL 的 node_modules 树前缀（截到包目录之前），用于同树断言。 */
function treePrefix(url, pkgName) {
  const m = new RegExp(`(?:^|[\\\\/])node_modules[\\\\/]@deepseek-ai[\\\\/]${pkgName}[\\\\/]`, 'u').exec(url);
  return url.slice(0, m.index);
}

test('守卫：宿主解析实体构成合法准入环境（∈ 准入集合、两包同版、同树；锚点指向其他版本即红）', () => {
  const admission = loadAdmission();
  assert.ok(admission.ok, `准入声明不可解析，守卫无从判定：${admission.ok ? '' : admission.errors.join('；')}`);
  const { members } = admission;

  const llm = resolvedPackageVersion('@deepseek-ai/dsh-llm');
  assert.ok(
    admits(members, llm.version),
    `dsh-llm 实体 ${llm.version} 不在准入集合 [${members.join('、')}] 内（解析自 ${llm.resolved}）`,
  );

  const typert = resolvedPackageVersion('@deepseek-ai/dsh-typert-protocol');
  assert.equal(
    typert.version,
    llm.version,
    `两枚宿主包实体异版：dsh-llm=${llm.version}、dsh-typert-protocol=${typert.version}（须来自同一目标 RC）`,
  );

  assert.equal(
    treePrefix(typert.resolved, 'dsh-typert-protocol'),
    treePrefix(llm.resolved, 'dsh-llm'),
    'dsh-llm 与 dsh-typert-protocol 解析自不同 node_modules 树（混树）',
  );

  // 期望版本（可选）：注入时期望本身须在集合内，实体等值断言收紧集合成员断言。
  const expected = process.env[EXPECT_ENV];
  if (expected !== undefined && expected !== '') {
    assert.ok(
      admits(members, expected),
      `${EXPECT_ENV}=${expected} 不在准入集合 [${members.join('、')}] 内：期望值本身写错`,
    );
    assert.equal(llm.version, expected, `dsh-llm 实体 ${llm.version} ≠ 期望版本 ${expected}（锚点树装错版本）`);
    assert.equal(typert.version, expected, `dsh-typert-protocol 实体 ${typert.version} ≠ 期望版本 ${expected}（锚点树装错版本）`);
  }
});
