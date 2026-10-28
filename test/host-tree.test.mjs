import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 宿主解析树的锚点守卫：`tools/_host-resolve.mjs` 的锚点指向其他宿主版本时，
 * 套件其余用例不会变红——本守卫钉住的就是这个缺口。
 * 本用例断言：宿主解析钩子生效时（npm test 带 `--import ./tools/_host-hooks.mjs`），
 * `@deepseek-ai/dsh-llm` 解析出的实体版本必须与本包 `package.json` 的 peer 钉版一致——
 * 锚点树与 peer 钉版不符即红；离线跑（无钩子）时解析到仓库自带 `node_modules` 的
 * 实体，实体版本与 peer 钉版不一致同样会红。
 */

/** 从解析出的实体 URL 定位包根，读取其 package.json，返回 version 字段与解析 URL。 */
function resolvedPackageVersion(specifier) {
  const resolved = import.meta.resolve(specifier);
  const marker = /(?:^|[\\/])node_modules[\\/]@deepseek-ai[\\/]dsh-llm[\\/]/u.exec(resolved);
  assert.notEqual(marker, null, `解析结果不在 node_modules/@deepseek-ai/dsh-llm 下：${resolved}`);
  return {
    resolved,
    version: JSON.parse(readFileSync(new URL(`${resolved.slice(0, marker.index + marker[0].length)}package.json`), 'utf8')).version,
  };
}

test('守卫：dsh-llm 宿主解析版本与 package.json peer 钉版一致（锚点指向其他版本即红）', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const pinned = pkg.peerDependencies['@deepseek-ai/dsh-llm'];
  const { resolved, version } = resolvedPackageVersion('@deepseek-ai/dsh-llm');
  assert.equal(version, pinned, `锚点树或本地 node_modules 的 dsh-llm=${version}，与本包 peer 钉版 ${pinned} 不一致（解析自 ${resolved}）`);
});

test('守卫：dsh-typert-protocol 同口径（与 dsh-llm 同树同版）', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const pinned = pkg.peerDependencies['@deepseek-ai/dsh-typert-protocol'];
  const resolved = import.meta.resolve('@deepseek-ai/dsh-typert-protocol');
  const marker = /(?:^|[\\/])node_modules[\\/]@deepseek-ai[\\/]dsh-typert-protocol[\\/]/u.exec(resolved);
  assert.notEqual(marker, null, `解析结果不在 node_modules/@deepseek-ai/dsh-typert-protocol 下：${resolved}`);
  const version = JSON.parse(readFileSync(new URL(`${resolved.slice(0, marker.index + marker[0].length)}package.json`), 'utf8')).version;
  assert.equal(version, pinned, `解析实体 ${version} 与 peer 钉版 ${pinned} 不一致（解析自 ${resolved}）`);
  // 同树断言：两个宿主包必须解析自同一棵 node_modules（同一条锚点树），防止混树解析。
  const llm = resolvedPackageVersion('@deepseek-ai/dsh-llm');
  const prefixOf = (url, pkgName) => {
    const m = new RegExp(`(?:^|[\\\\/])node_modules[\\\\/]@deepseek-ai[\\\\/]${pkgName}[\\\\/]`, 'u').exec(url);
    return url.slice(0, m.index);
  };
  assert.equal(prefixOf(resolved, 'dsh-typert-protocol'), prefixOf(llm.resolved, 'dsh-llm'), 'dsh-llm 与 dsh-typert-protocol 解析自不同 node_modules 树（混树）');
});
