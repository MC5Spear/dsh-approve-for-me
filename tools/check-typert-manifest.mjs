/**
 * 离线校验 `typert.host.js` 清单：复刻 `dsh-typert-loader` 的注册期字段检查，不连网、不改宿主。
 *
 * 判据单源：invocation/codec 契约住在 `tools/typert-contract.mjs`，与
 * `test/typert-manifest.test.mjs` 共用同一份——两处各自维护会在本文件一侧漂移。
 *
 * 用法：node --import ./tools/_host-hooks.mjs tools/check-typert-manifest.mjs
 * 通过打印 `PASS`；任一项失败打印缺陷并退出 1。这是本仓环境下的静态对照，
 * 不等于已证实其他安装环境的加载结果。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { checkInvocation } from './typert-contract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const failures = [];

/**
 * 记录一条缺陷。
 * @param {string} message - 缺陷描述。
 * @returns {void}
 */
function fail(message) {
  failures.push(message);
}

/**
 * 断言非空字符串。
 * @param {object} value - 承载对象。
 * @param {string} key - 键名。
 * @param {string} subject - 描述。
 * @returns {void}
 */
function requireString(value, key, subject) {
  if (typeof value?.[key] !== 'string' || value[key].length === 0) fail(`${subject} 缺少非空 ${key}`);
}

const mod = await import(pathToFileURL(join(root, 'typert.host.js')).href);
const manifest = mod.TYPERT;

if (manifest?.package !== pkg.name) fail(`TYPERT.package 必须等于包名 ${pkg.name}`);
if (manifest?.face !== 'host') fail('TYPERT.face 必须是 "host"');
if (!Array.isArray(manifest?.schemas)) fail('TYPERT.schemas 必须是数组');
if (pkg.exports?.['./typert'] === undefined) fail('package.json 缺少 exports["./typert"]');
if (pkg.exports?.['./client'] === undefined) fail('package.json 缺少 exports["./client"]');

for (const invocation of manifest?.invocations ?? []) {
  const found = checkInvocation(invocation);
  for (const [path, problems] of Object.entries(found)) {
    fail(`invocation ${invocation?.id ?? '?'} ${path}：${problems.join('；')}`);
  }
}

for (const service of manifest?.model?.services ?? []) {
  requireString(service, 'key', 'model.service');
  requireString(service, 'exportName', 'model.service');
  if (!Array.isArray(service.tags)) fail(`model.service ${service.key} 缺少 tags 数组`);
  for (const member of service.members ?? []) {
    requireString(member, 'name', `model.service ${service.key} member`);
    requireString(member, 'signature', `model.service ${service.key} member`);
    if (typeof member.kind !== 'string') fail(`model.service ${service.key} member ${member.name} 缺少 kind`);
  }
  for (const type of service.types ?? []) {
    requireString(type, 'name', `model.service ${service.key} type`);
    requireString(type, 'declaration', `model.service ${service.key} type`);
  }
}
for (const key of ['events', 'objects']) {
  if (!Array.isArray(manifest?.model?.[key])) fail(`TYPERT.model.${key} 必须是数组`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log(`PASS typert manifest (${manifest.invocations.length} invocations, package=${manifest.package})`);
