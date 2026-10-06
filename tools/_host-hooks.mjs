/**
 * 注册开发期解析钩子。`--import` 加载的模块不会自动成为 loader 钩子，必须显式注册。
 *   node --import ./tools/_host-hooks.mjs tools/check-typert-manifest.mjs
 */
import { register } from 'node:module';

register('./_host-resolve.mjs', import.meta.url);
