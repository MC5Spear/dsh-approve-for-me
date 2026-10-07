/**
 * 开发期解析钩子：把宿主包名重新锚定到能真正读到 zod 的 node_modules。
 *
 * 插件部署到 profile 后，`@deepseek-ai/*` 与 `zod` 由共享 node_modules 提供；仓库本地
 * 没有 node_modules，因此离线校验要用本钩子换锚点：
 *   node --import ./tools/_host-hooks.mjs tools/check-typert-manifest.mjs
 *
 * **锚点从本机配置取，不硬编码**（见 tools/local-config.mjs 与 tools/local-config.example.mjs）：
 * 首选配置里的 `hostModules`；没配时退回宿主 profile 树与 npm 全局树两个通用候选。
 * 本机实测 `$DSH_HOME/profiles/node_modules` 下的目录符号链接对 Node 不可遍历
 * （`stat` 报 UNKNOWN），故按候选顺序取第一个可读的目录。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadLocalConfig } from './local-config.mjs';

/** 需要重新锚定的裸包名。 */
const HOST_PACKAGES = ['zod', '@deepseek-ai/'];

/**
 * 判断目录里能否真正读到 `zod`，以及 schemastery 是否带 volatile 生命周期。
 * `Config` 大量使用 `.volatile()`，要求 schemastery ≥ 3.18.4
 * （`Schema.prototype.volatile` 首次出现在 3.18.4 的构建产物；更早的 3.18.2 会在
 * 加载期抛 `volatile is not a function`）。锚点因此必须同时具备两者。
 * @param {string} dir - 候选 node_modules。
 * @returns {boolean} 可用时为 true。
 */
function usable(dir) {
  try {
    if (!statSync(join(dir, 'zod', 'package.json')).isFile()) return false;
    const schemasteryLib = readFileSync(join(dir, '@deepseek-ai', 'schemastery', 'lib', 'index.mjs'), 'utf8');
    return schemasteryLib.includes('Schema.prototype.volatile');
  } catch {
    return false;
  }
}

/** 锚点缓存的 Promise（含「没找到」这一结果）。 */
let anchorPromise;

/**
 * 真的算一次锚点。
 *
 * 候选顺序：本机配置的 `hostModules`（首选）→ 宿主 profile 树 → npm 全局树。
 * 全部不可读时返回 undefined——调用方退回 Node 默认解析，不做任何回退猜测。
 * @returns {Promise<{provisional: boolean, url?: string}>} 结果；配置尚在加载中时带 provisional 标记。
 */
async function computeAnchor() {
  const config = await loadLocalConfig();
  // 配置正在加载中（本模块可能在配置文件自身那一次 import 里被重入）：此刻拿到的
  // 是空配置，据此算出的锚点不可信，也不能缓存——交回 undefined，下次重算。
  if (config.provisional === true) return { provisional: true };
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const candidates = [
    config.hostModules,
    join(home, 'profiles', 'node_modules'),
    process.env.APPDATA === undefined
      ? undefined
      : join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'),
  ].filter((entry) => typeof entry === 'string' && entry.length > 0 && existsSync(entry));
  const found = candidates.find(usable);
  return { provisional: false, url: found === undefined ? undefined : pathToFileURL(join(found, '__anchor__.js')).href };
}

/**
 * 计算锚点 file URL（带缓存）。
 *
 * 注意：缓存「没找到」时必须继续返回 undefined——返回空串会被上层当成 parentURL
 * 传给 next()，Node 报 `TypeError: Invalid URL: input: ''`（无锚点时必现）。
 * @returns {Promise<string|undefined>} 锚点。
 */
function anchor() {
  if (anchorPromise !== undefined) return anchorPromise;
  anchorPromise = computeAnchor().then((result) => {
    if (result.provisional === true) {
      anchorPromise = undefined;
      return undefined;
    }
    return result.url;
  });
  return anchorPromise;
}

/**
 * 解析裸导入；只改写宿主包，其余交给 Node 默认解析。
 *
 * **先判包名再算锚点**：锚点计算会读本机配置，而读配置本身要经过解析钩子——若对每个
 * 说明符都先算锚点，读配置的那一次 import 会绕回来再要锚点，形成无限递归
 * （实测 `RangeError: Maximum call stack size exceeded`）。
 * @param {string} specifier - 导入说明符。
 * @param {object} context - 解析上下文。
 * @param {Function} next - 默认解析器。
 * @returns {Promise<object>} 解析结果。
 */
export async function resolve(specifier, context, next) {
  const isHost = HOST_PACKAGES.some((prefix) => specifier === prefix || specifier.startsWith(prefix));
  if (!isHost) return next(specifier, context);
  const parent = await anchor();
  if (parent === undefined) return next(specifier, context);
  return next(specifier, { ...context, parentURL: parent });
}
