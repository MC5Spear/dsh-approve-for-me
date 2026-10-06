/**
 * 默认预设悬空防护（R57 / 设计 §28.3-2）。
 *
 * 为什么要防：宿主设置界面把「默认预设＝auto-approve」持久化到 profile patch 的 permission 行
 * config 覆盖（且该覆盖自带当时生效的全部非易变键——含本包注入的四档 presets，dsh-settings
 * lib/index.js:508-534 的 strip(raw) 以活动配置为基）。本包卸载后：覆盖行仍指向 auto-approve →
 * permission 行构造器抛 unknown preset（dsh-permission-presets lib/index.js:178-181）→ 整行装载
 * 失败 → 每个会话查权限投影都抛错＝全部会话不可用；即便行侥幸装载，四档重述也作为覆盖残留在
 * 用户层滞留。
 *
 * 为什么是文件手术而不是设置服务：SettingsForms 的写回路 next＝strip(raw) 恒含四档 presets，
 * 等值清除分支（dsh-config-editor lib/index.js:99-104）不会触发——API 路径清不掉 presets 残值；
 * 且 defaultPreset=auto-approve 只可能源自 profile 覆盖行（无覆盖时易变值回落推断默认），删除
 * 整个覆盖行＝恢复继承层（dsh-base 三档），**必要且充分**，且不依赖服务销毁顺序。
 *
 * 判定（设计 §28.3-2）：宿主 removeBundle/停用＝先把包名从 profile manifest 的
 * `dsh.profile.bundles` 数组落盘、再触发 reload 卸载本插件——disposer 里看到「数组已不含本包」
 * ＝本包正被移除/停用，才动作；普通关停、升级、热重载时数组仍含本包，一律不动。
 *
 * 失败语义：best-effort——本模块任何异常由调用方（disposer）兜住，绝不阻断卸载/停用；
 * profileContext 缺席、manifest 不可读、锚点不命中等一切降级路径都表现为「跳过」。
 *
 * @module dsh-approve-for-me/lib/preset-guard
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 本包名（profile manifest 数组里的键）。 */
const PACKAGE_NAME = 'dsh-approve-for-me';
/** 本包注入的预设 id（悬空判定的目标值）。 */
const PRESET_ID = 'auto-approve';
/** profile patch 文件名（profile 层覆盖的载体）。 */
const PATCH_FILE = 'cordis.patch.yml';

/**
 * 纯判定（单测对象）：是否需要复位。
 * @param {unknown} bundles - profile manifest 的 `dsh.profile.bundles` 值。
 * @param {boolean} overridePointsAtOurs - profile 覆盖行的 defaultPreset 是否指向本包预设。
 * @returns {boolean} 仅当「数组有效且不含本包」且「覆盖指向本包预设」时为 true。
 */
export function shouldResetDefaultPreset(bundles, overridePointsAtOurs) {
  if (!Array.isArray(bundles)) return false;
  if (bundles.includes(PACKAGE_NAME)) return false;
  return overridePointsAtOurs === true;
}

/**
 * 读取 profile manifest 的 `dsh.profile.bundles` 数组。
 * @param {string} profileDir - profile 目录（`ctx.get('profileContext').dir`）。
 * @returns {{ ok: true, bundles: unknown } | { ok: false, reason: string }}
 *   manifest 缺失/损坏/键缺失都按「不可判定」返回（调用方跳过，不猜）。
 */
function readBundles(profileDir) {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
    if (manifest === null || typeof manifest !== 'object') return { ok: false, reason: 'manifest-not-object' };
    return { ok: true, bundles: manifest.dsh?.profile?.bundles };
  } catch {
    return { ok: false, reason: 'manifest-unreadable' };
  }
}

/**
 * 定位 patch 内 permission 覆盖行的行号区间与悬空判定。
 * 锚点纪律与 lib/permission-preset.js 同源：不解析 YAML、不猜结构；找不到锚点＝跳过（覆盖行
 * 不存在＝无悬空源，正是常态——只有经设置界面选过本包预设为默认才会写出行）。
 * @param {string[]} lines - patch 全文行。
 * @returns {{ ok: true, dangling: boolean, start: number, endExclusive: number } | { ok: false, reason: string }}
 */
function locateOverride(lines) {
  const start = lines.findIndex((line) => /^- id: permission\s*$/u.test(line));
  if (start === -1) return { ok: true, dangling: false, start: -1, endExclusive: -1 };
  let end = lines.findIndex((line, index) => index > start && /^- /u.test(line));
  if (end === -1) end = lines.length;
  const block = lines.slice(start, end);
  // 行覆盖（非 insert）；引号与裸名两种形态都认（与 permission-preset 的 defaultPreset 手术同款正则）。
  const dangling = block.some((line) => /^\s+defaultPreset:\s*['"]?auto-approve['"]?\s*$/u.test(line));
  return { ok: true, dangling, start, endExclusive: end };
}

/**
 * 执行防护（disposer 内调用；每一步失败都降级为「跳过」，绝不抛出）。
 * 动作＝删除 profile patch 中 defaultPreset 指向 auto-approve 的 permission 覆盖行**整行**
 * （该行的 presets 等非易变键是设置写回路从当时生效配置拖入的残值；整行删除＝恢复继承层
 * ＝dsh-base 三档，零残留）。原子写：同目录临时文件 + rename；UTF-8 无 BOM（原文件带 BOM 则保留）。
 * @param {{ profileDir?: string }} deps `profileDir` 来自 `ctx.get('profileContext')?.dir`。
 * @returns {Promise<{ action: 'reset' | 'skip', reason: string }>} 结果说明（供审计/测试断言）。
 */
export async function guardDefaultPreset({ profileDir } = {}) {
  if (typeof profileDir !== 'string' || profileDir === '') return { action: 'skip', reason: 'no-profile' };
  const manifest = readBundles(profileDir);
  if (!manifest.ok) return { action: 'skip', reason: manifest.reason };
  let text;
  try {
    text = readFileSync(join(profileDir, PATCH_FILE), 'utf8');
  } catch {
    return { action: 'skip', reason: 'patch-unreadable' };
  }
  const bom = text.startsWith('﻿') ? '﻿' : '';
  const lines = text.slice(bom.length).split('\n');
  const located = locateOverride(lines);
  if (!located.ok) return { action: 'skip', reason: located.reason };
  if (!shouldResetDefaultPreset(manifest.bundles, located.dangling)) {
    return { action: 'skip', reason: 'not-required' };
  }
  try {
    const next = [...lines.slice(0, located.start), ...lines.slice(located.endExclusive)];
    // 被删行是文档唯一条目时，剩余＝纯注释＝YAML null——宿主 parsePatchList 要求顶层数组
    // （dsh-app-boot lib/index.js:3566 "must be a top-level YAML array"），补回 `[]` 占位。
    // 已有 `[]` 行（占位未随宿主写路径坍缩＝手工损坏文件）不重复补，避免双序列文档非法。
    const hasEntry = next.some((line) => /^- /u.test(line));
    const hasPlaceholder = next.some((line) => /^\[\]\s*$/u.test(line));
    if (!hasEntry && !hasPlaceholder) next.push('[]');
    // 与 permission-preset.js 同款原子写：同目录临时文件 + rename。
    const temp = join(profileDir, `${PATCH_FILE}.dsafm-guard.tmp`);
    writeFileSync(temp, bom + next.join('\n'), 'utf8');
    renameSync(temp, join(profileDir, PATCH_FILE));
    return { action: 'reset', reason: 'removed-user-override' };
  } catch (error) {
    return { action: 'skip', reason: `patch-write-failed: ${String(error)}` };
  }
}

/**
 * disposer 接线（`ctx.effect` 的清理回调体）：现取 profileContext，结果为 `reset` 或失败性
 * `skip` 时落一行审计（良性跳过静默——关停/升级/重载是常态）。
 * @param {{ ctx: object, audit: (fields: object) => void }} deps
 * @returns {Promise<{ action: string, reason: string }>} guardDefaultPreset 的结果（或取服务失败的说明）。
 */
export async function guardOnDisposal({ ctx, audit }) {
  let profileDir;
  try {
    profileDir = ctx.get?.('profileContext')?.dir;
  } catch {
    profileDir = undefined;
  }
  const result = await guardDefaultPreset({ profileDir });
  // 审计口径（设计 §28.3-2）：复位与失败性 skip（写失败／manifest 或 patch 不可读）落一行；
  // 良性跳过（关停/升级/重载＝not-required、非 profile 环境＝no-profile）静默。
  if (result.action === 'reset' || /failed|unreadable/u.test(result.reason)) {
    audit({
      phase: 'screen',
      action: 'skip',
      source: result.action === 'reset' ? 'guard' : 'error',
      reason: `默认预设悬空防护：${result.action}（${result.reason}）`,
    });
  }
  return result;
}
