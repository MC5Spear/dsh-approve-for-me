/**
 * 预设残留防护（R57 / 设计 §28.3-2；盲审修订）。
 *
 * 为什么要防：宿主设置界面把「默认预设」选择持久化到 profile patch 的 permission 行 config
 * 覆盖，且写回路以**当时生效的活动配置**为基（dsh-config-editor lib/index.js:77-79 的
 * raw＝entry.options.config；dsh-settings lib/index.js:508-534 的 strip(raw)）——写出的覆盖行
 * 自带**当时生效的全部 presets**（装着本包时＝四档）。卸载后两重后果：
 *  - 覆盖的 defaultPreset 指向已删的 auto-approve → PP 构造器抛 unknown preset
 *    （dsh-permission-presets lib/index.js:178-181）→ 整行装载失败 → 全部会话不可用；
 *  - 即便默认档已切回标准档（或从未选过本包档为默认），被拖入的 auto-approve 条目仍在
 *    覆盖里滞留——卸载后下拉仍显示本包档名（盲审反例：默认 workspace-write/read-only
 *    时四档残留、组合仍四档）。
 *
 * 手术原则（贡献级清理）：只删**本包的贡献**，保全用户的有效选择与自定义——
 *  1. 删覆盖行 presets 里的 `auto-approve:` 条目块（若有）；
 *  2. 删指向 auto-approve 的 defaultPreset 行（若有；悬空源）；
 *  3. 行去留按编辑后的形态判定：presets 被删空，或「无 defaultPreset 且 config 键只剩
 *     presets、条目全为三标准档」→ 整行删除＝恢复继承（dsh-base 三档）；用户仍保留有效
 *     默认档或自定义条目时只做条目级清理、保留行（等价于「本包从未存在时宿主会写出的形态」）。
 *
 * 为什么是文件手术而不是设置服务：SettingsForms 的写回路 next＝strip(raw) 恒含当时的档表，
 * 等值清除分支（dsh-config-editor lib/index.js:99-104）不会触发——API 路径清不掉 presets 残值；
 * 文件手术必要且充分，且不依赖服务销毁顺序。
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
/** 本包注入的预设 id（残留清理的目标条目）。 */
const PRESET_ID = 'auto-approve';
/** 宿主三标准档（整行删除判定用：剩下的条目必须是这些才视为「无用户自定义」）。 */
const STANDARD_IDS = ['read-only', 'workspace-write', 'danger-full-access'];
/** profile patch 文件名（profile 层覆盖的载体）。 */
const PATCH_FILE = 'cordis.patch.yml';

/**
 * 纯判定（单测对象）：是否需要手术。
 * @param {unknown} bundles - profile manifest 的 `dsh.profile.bundles` 值。
 * @param {boolean} residuePresent - 覆盖行是否含本包贡献（auto-approve 条目或悬空默认档）。
 * @returns {boolean} 仅当「数组有效且不含本包」且「覆盖含本包贡献」时为 true。
 */
export function shouldResetResidue(bundles, residuePresent) {
  if (!Array.isArray(bundles)) return false;
  if (bundles.includes(PACKAGE_NAME)) return false;
  return residuePresent === true;
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
 * 分析 permission 覆盖行块（锚点纪律与 lib/permission-preset.js 同源：不解析 YAML、不猜结构）。
 * @param {string[]} block - 行块（从 `- id: permission` 到下一个顶层行之前）。
 * @returns {{ ourEntry: number, entryEnd: number, danglingDefault: number, presetIds: string[], defaultLine: number }}
 *   ourEntry/danglingDefault 为块内行号（缺席为 -1）；entryEnd 为条目块结束行号（不含）；
 *   presetIds 为 6 空格缩进的裸键名清单（defaultLine 为任意取值的 defaultPreset 行号）；
 *   带值 4/6 空格行不在此汇总——宇宙外探测见 guardDefaultPreset 的 hasForeign（再审查 N1）。
 */
function analyzeRow(block) {
  const ourEntry = block.findIndex((line) => new RegExp(`^ {6}${PRESET_ID}:\\s*$`, 'u').test(line));
  let entryEnd = -1;
  if (ourEntry !== -1) {
    entryEnd = ourEntry + 1;
    // 条目块＝条目行＋其 8 空格及以上缩进的子键行（6 空格兄弟键 / 4 空格 config 键 / 行尾都会
    // 停）；与 revertPreset 的 {8,} 同款，更深续行不遗留孤儿（再审查 N2）。
    while (entryEnd < block.length && /^ {8,}\S/u.test(block[entryEnd])) entryEnd += 1;
  }
  const danglingDefault = block.findIndex((line) => new RegExp(`^ {4}defaultPreset:\\s*['"]?${PRESET_ID}['"]?\\s*$`, 'u').test(line));
  const defaultLine = block.findIndex((line) => /^ {4}defaultPreset:\s*\S/u.test(line));
  const presetIds = [];
  for (const line of block) {
    const match = /^ {6}([A-Za-z0-9_-]+):\s*$/u.exec(line);
    if (match) presetIds.push(match[1]);
  }
  return { ourEntry, entryEnd, danglingDefault, presetIds, defaultLine };
}

/**
 * 执行防护（disposer 内调用；每一步失败都降级为「跳过」，绝不抛出）。
 * 动作见文件头「手术原则」。原子写：同目录临时文件 + rename；UTF-8 无 BOM（原文件带 BOM 则保留）。
 * @param {{ profileDir?: string }} deps `profileDir` 来自 `ctx.get('profileContext')?.dir`。
 * @returns {Promise<{ action: 'reset' | 'skip', reason: string }>} 结果说明（供审计/测试断言）：
 *   reset/removed-user-override＝整行删除（恢复继承）；reset/removed-tier-entry＝条目级清理（保留行）。
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
  const start = lines.findIndex((line) => /^- id: permission\s*$/u.test(line));
  if (start === -1) return { action: 'skip', reason: 'not-required' };
  let end = lines.findIndex((line, index) => index > start && /^- /u.test(line));
  if (end === -1) end = lines.length;
  const block = lines.slice(start, end);
  const info = analyzeRow(block);
  if (!shouldResetResidue(manifest.bundles, info.ourEntry !== -1 || info.danglingDefault !== -1)) {
    return { action: 'skip', reason: 'not-required' };
  }
  try {
    // 编辑后形态（相对行号空间）：先移除条目块与悬空默认行，再判定行去留。
    const drop = new Set();
    for (let index = info.ourEntry; index !== -1 && index < info.entryEnd; index += 1) drop.add(index);
    if (info.danglingDefault !== -1) drop.add(info.danglingDefault);
    const kept = block.filter((_, index) => !drop.has(index));
    const keptInfo = analyzeRow(kept);
    const keptIds = keptInfo.presetIds;
    const hasDefault = keptInfo.defaultLine !== -1;
    // 宇宙外内容探测（再审查 N1）：configKeys 只收无值键，带值 4 空格行（如手工写的
    // `extraKnob: true`）对它不可见——在此拦下：4 空格行只认 `presets:` 键与 defaultPreset
    // 行；6 空格行只认三标准档裸键（本包条目已在上面移除）。出现任何其他形态＝用户自定义
    // 内容，保留行不代删（restore-inherit 对同形态拒绝代删，guard 同口径）。
    const hasForeign = kept.some((line) => {
      if (/^ {4}\S/u.test(line)) {
        // `presets:` 行用正则判定（\s* 容忍 CRLF/尾随空白）——严格串比较会让 CRLF 文件
        // 恒判宇宙外、整行删除永不触发（再审查 r59-N1）；defaultPreset 行正则本就容 \r。
        return !/^ {4}presets:\s*$/u.test(line) && !/^ {4}defaultPreset:\s*\S/u.test(line);
      }
      if (/^ {6}\S/u.test(line)) {
        const tier = /^ {6}([A-Za-z0-9_-]+):\s*$/u.exec(line);
        return !tier || !STANDARD_IDS.includes(tier[1]);
      }
      return false;
    });
    // 行删除条件（均以「无宇宙外内容」为前提）：presets 删空（空 map 会让 PP 构造器按无匹配
    // 档抛错）；或「无默认档（悬空行已移除＝用户没有仍有效的默认选择）且条目全为三标准档」
    // ＝纯设置拖入形态，整行删除＝恢复继承层。
    const deleteRow = !hasForeign
      && (keptIds.length === 0
        || (!hasDefault && keptIds.every((id) => STANDARD_IDS.includes(id))));
    let next;
    let reason;
    if (deleteRow) {
      next = [...lines.slice(0, start), ...lines.slice(end)];
      reason = 'removed-user-override';
    } else {
      next = [...lines];
      next.splice(start, end - start, ...kept);
      reason = 'removed-tier-entry';
    }
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
    return { action: 'reset', reason };
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
      reason: `预设残留防护：${result.action}（${result.reason}）`,
    });
  }
  return result;
}
