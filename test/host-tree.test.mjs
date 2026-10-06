import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * R49 判据⑤的锚点守卫（r53 审查 D4）：「host hooks 解析到 0.2.0 树」此前无守卫——
 * 把 `tools/_host-resolve.mjs` 的锚点改回 0.1.7 树，全套仍然全绿（审查者实测）。
 * 本用例断言：宿主解析钩子生效时（npm test 带 `--import ./tools/_host-hooks.mjs`），
 * `@deepseek-ai/dsh-llm` 解析出的实体版本必须与本包 `package.json` 的钉版一致——
 * 锚点退回 0.1.7 树（解析出 0.1.7-rc.1）即红；离线跑（无钩子）时解析到仓库自带
 * `node_modules` 的同版实体，锁文件与钉版不一致同样会红。
 */

/** 从解析出的实体 URL 提取包根下的 package.json 内容。 */
function resolvedPackageVersion(specifier) {
  const resolved = import.meta.resolve(specifier);
  const marker = /(?:^|[\\/])node_modules[\\/]@deepseek-ai[\\/]dsh-llm[\\/]/u.exec(resolved);
  assert.notEqual(marker, null, `解析结果不在 node_modules/@deepseek-ai/dsh-llm 下：${resolved}`);
  return {
    resolved,
    version: JSON.parse(readFileSync(new URL(`${resolved.slice(0, marker.index + marker[0].length)}package.json`), 'utf8')).version,
  };
}

test('R49⑤ 守卫：dsh-llm 宿主解析版本的与 package.json 钉版一致（锚点退回 0.1.7 树即红）', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const pinned = pkg.dependencies['@deepseek-ai/dsh-llm'];
  const { resolved, version } = resolvedPackageVersion('@deepseek-ai/dsh-llm');
  assert.equal(version, pinned, `锚点树或本地 node_modules 的 dsh-llm=${version}，与本包钉版 ${pinned} 不一致（解析自 ${resolved}）`);
});

test('R49⑤ 守卫：dsh-typert-protocol 同口径（与 dsh-llm 同树同版系）', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const pinned = pkg.dependencies['@deepseek-ai/dsh-typert-protocol'];
  const resolved = import.meta.resolve('@deepseek-ai/dsh-typert-protocol');
  const marker = /(?:^|[\\/])node_modules[\\/]@deepseek-ai[\\/]dsh-typert-protocol[\\/]/u.exec(resolved);
  assert.notEqual(marker, null, `解析结果不在 node_modules/@deepseek-ai/dsh-typert-protocol 下：${resolved}`);
  const version = JSON.parse(readFileSync(new URL(`${resolved.slice(0, marker.index + marker[0].length)}package.json`), 'utf8')).version;
  assert.equal(version, pinned, `解析实体 ${version} 与钉版 ${pinned} 不一致（解析自 ${resolved}）`);
  // 同树断言：两个宿主包必须解析自同一棵 node_modules（同一条锚点树），防止混树解析。
  const llm = resolvedPackageVersion('@deepseek-ai/dsh-llm');
  const prefixOf = (url, pkgName) => {
    const m = new RegExp(`(?:^|[\\\\/])node_modules[\\\\/]@deepseek-ai[\\\\/]${pkgName}[\\\\/]`, 'u').exec(url);
    return url.slice(0, m.index);
  };
  assert.equal(prefixOf(resolved, 'dsh-typert-protocol'), prefixOf(llm.resolved, 'dsh-llm'), 'dsh-llm 与 dsh-typert-protocol 解析自不同 node_modules 树（混树）');
});
