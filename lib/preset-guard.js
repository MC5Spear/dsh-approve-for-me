/**
 * 预设残留防护（R57 / 设计 §28.3-2；盲审修订；复审 N1-N3 修订）。
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
 * 手术原则（贡献级清理；复审 N1-N3 后升级为**全缩进级覆盖**的行结构模型）：
 *  只删**本包的贡献**，保全用户的有效选择与自定义——
 *  1. 删覆盖行 presets 里的 `auto-approve:` 条目块。条目块边界＝结构边界：6 空格兄弟键、
 *     4 空格 config 键或行尾才结束；**空行与注释行跨行不断块**（复审 N2：子键间合法空行/
 *     注释不得截断条目，否则余下子键错挂上一档、切出重复键，真实 YAML.parse 直接失败）。
 *  2. 删指向 auto-approve 的 defaultPreset 行。取值按**解析标量**判定：剥引号、剥行尾注释
 *     （复审 N3：`defaultPreset: auto-approve # user comment` 语义就是 auto-approve，
 *     只认裸值的正则会漏删，先删档后仍指向已删档）。
 *  3. 行去留按编辑后形态判定：presets 被删空，或「无 defaultPreset 且行内恰为已知基线形态」
 *     → 整行删除＝恢复继承（dsh-base 三档）；否则保留行、只做条目级清理。
 *     **已知基线形态**（复审 N1）＝逐层全缩进级校验，而非只看档 id 在不在名单——
 *      - 行属性（2 空格）只允许基线 `name` 行与 `config:` 容器键（`disabled: true` 一类
 *        额外行属性＝用户内容，保全）；
 *      - config 键（4 空格）⊆ {presets, defaultPreset}；
 *      - 档位键（6 空格）必须是裸键；id ∈ 三标准档；
 *      - 标准档的子键（≥8 空格）必须**恰为基线两条形态**（sandbox/approval 且取值与
 *        dsh-base 逐字一致）——未知子键（`customKnob: true`）、改值（`approval: never`）、
 *        档内注释都算用户修改，保留行不代删（与 restore-inherit「拒绝代删」同口径）；
 *      - 错位缩进（0/1/3/5/7 空格、tab）＝非法 YAML，一律按宇宙外处理。
 *  本包条目（auto-approve 档）不做子键校验——它整块随贡献移除。
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
/** 宿主三标准档（基线判定的档 id 宇宙）。 */
const STANDARD_IDS = ['read-only', 'workspace-write', 'danger-full-access'];
/** 三标准档基线子键形态（与 dsh-base / lib/permission-preset.js 的 ROW_LINES 逐字一致；
 * 整行删除只发生在标准档内容恰为基线时——改值/加键都是用户修改，不得代删（复审 N1）。 */
const BASELINE_FORMS = {
  'read-only': ['sandbox: read-only', 'approval: ask'],
  'workspace-write': ['sandbox: workspace-write', 'approval: ask'],
  'danger-full-access': ['sandbox: danger-full-access', 'approval: never'],
};
/** 覆盖行的基线 name 行（整行删除时 2 空格行属性只允许它与 `config:` 容器键）。 */
const BASELINE_NAME = "  name: '@deepseek-ai/dsh-permission-presets'";
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
 * 解析 YAML 标量（defaultPreset 取值判定用）：剥行尾注释、剥包裹引号（复审 N3）。
 * 只需覆盖平面标量；对象/数组取值在调用方正则处不会出现。
 * @param {string} raw - 冒号后的原始文本。
 * @returns {string} 解析后的取值（未识别形态按原文返回，交由调用方按未知值处理）。
 */
function parseScalar(raw) {
  let text = raw.trim();
  const quote = text[0];
  if (quote === '\'' || quote === '"') {
    const close = text.indexOf(quote, 1);
    if (close !== -1) return text.slice(1, close);
    return text.slice(1);
  }
  const hash = /\s#/u.exec(text);
  if (hash) text = text.slice(0, hash.index);
  return text.trim();
}

/**
 * permission 覆盖行块的**全缩进级结构模型**（复审 N1-N3；锚点纪律：不整文解析 YAML，
 * 只按缩进层级与行形态建行内模型——比正则逐点匹配强的保全校验，仍零依赖）。
 *
 * 层级宇宙：2 空格＝行属性（`config:` 容器键、基线 name 行）；4 空格＝config 键
 * （`presets:`、`defaultPreset:`）；6 空格＝档位裸键；≥8 空格＝档内子键。空行无信息、
 * 跨行不断结构（N2）；注释是用户内容（档内→该档非基线，浮层→本身即宇宙外）。
 * @param {string[]} block - 行块（从 `- id: permission` 到下一个顶层行之前；block[0] 为行头）。
 * @returns {{ foreignTexts: Set<string>, tiers: Array<{id: string, keyIndex: number,
 *   children: string[], comment: boolean, baseline: boolean}>, defaultLine: {index: number, parsed: string | undefined} }}
 *   foreignTexts＝宇宙外行的原文集合（编辑后块上的非空集合 ⇒ 保留行）；tiers 含逐档基线判定
 *   （本包条目 baseline=false——它在编辑后块中幸存即异常）；defaultLine 取首个 defaultPreset 行
 *   （parsed 为解析标量；index=-1 表示缺席）。
 */
function modelBlock(block) {
  const foreignTexts = new Set();
  const tiers = [];
  let tier = null;
  let defaultLine = { index: -1, parsed: undefined };
  for (let index = 1; index < block.length; index += 1) {
    const line = block[index];
    if (line.trim() === '') continue; // 空行无信息，不截断结构（N2）。
    if (/^\s*#/u.test(line)) {
      // 注释＝用户内容：挂在档内→该档非基线；浮在行/配置层→本身即宇宙外（保守保留）。
      if (tier) tier.comment = true;
      else foreignTexts.add(line);
      continue;
    }
    // 内容匹配统一在剥掉行尾 \r 的副本上做（`.` 不匹配 \r，裸 `$` 会让 CRLF 行漏检）；
    // foreignTexts 仍存原行（hasForeign 用原文比对 kept）。
    const bare = line.replace(/\r$/u, '');
    const indent = /^ */u.exec(bare)[0].length;
    if (indent === 2) {
      // 行属性宇宙（N1）：只认 `config:` 容器键与基线 name 行（比较去行尾空白，容忍 CRLF）；
      // `disabled: true` 一律保全。
      const body = bare.slice(2).replace(/\s+$/u, '');
      if (body !== 'config:' && bare !== BASELINE_NAME) foreignTexts.add(line);
    } else if (indent === 4) {
      const def = /^ {4}defaultPreset:\s*(\S.*?)[ \t]*$/u.exec(bare);
      if (def) {
        if (defaultLine.index !== -1) foreignTexts.add(line); // 重复 defaultPreset＝非法 YAML
        else defaultLine = { index, parsed: parseScalar(def[1]) };
        tier = null;
      } else if (!/^ {4}presets:\s*$/u.test(line)) {
        // 带值 config 键等（复审 N1：`extraKnob: true` 一类）。`presets:` 键行用正则判定
        // （\s* 容忍 CRLF/尾随空白——严格串比较会让 CRLF 恒判宇宙外、整行删除永不触发，
        // 再审查 r59-N1）。
        foreignTexts.add(line);
      } else {
        tier = null;
      }
    } else if (indent === 6) {
      const key = /^ {6}([A-Za-z0-9_-]+):\s*$/u.exec(bare);
      if (key) {
        tier = { id: key[1], keyIndex: index, children: [], comment: false };
        tiers.push(tier);
      } else {
        foreignTexts.add(line); // 6 空格带值键（N1）
        tier = null;
      }
    } else if (indent >= 8) {
      if (!tier) foreignTexts.add(line); // 无宿主的悬空子键
      else tier.children.push(line);
    } else {
      foreignTexts.add(line); // 0/1/3/5/7 空格、tab 等错位行＝非法 YAML，保守保留
    }
  }
  for (const item of tiers) {
    if (item.id === PRESET_ID) {
      // 本包条目整块随贡献移除、不做子键校验；编辑后块中幸存＝异常（重复 id 等），按宇宙外。
      item.baseline = false;
      foreignTexts.add(block[item.keyIndex]);
      continue;
    }
    const forms = new Set(BASELINE_FORMS[item.id] ?? []);
    if (forms.size === 0) { // 未知档 id＝用户自定义档（N1）。
      item.baseline = false;
      foreignTexts.add(block[item.keyIndex]);
      continue;
    }
    // 基线判定（N1）：子键恰为两条基线形态（trim 后逐字），无注释、无多余内容。
    let ok = !item.comment && item.children.length === 2;
    for (const child of item.children) {
      if (!forms.delete(child.trim())) ok = false;
    }
    item.baseline = ok && forms.size === 0;
    if (!item.baseline) foreignTexts.add(block[item.keyIndex]);
  }
  return { foreignTexts, tiers, defaultLine };
}

/**
 * 本包条目块的结束行号（不含；N2：**结构边界**而非行形连续）。
 * 从条目键行起，空行、注释行（任意缩进）与 ≥8 空格子行都属条目块；第一个缩进 ≤6 的
 * 非空非注释行（6 空格兄弟档键 / 4 空格 config 键 / 更浅）终止扫描。
 * @param {string[]} block - 行块。
 * @param {number} keyIndex - 条目键行（`      auto-approve:`）的块内行号。
 * @returns {number} 条目块结束行号（不含）。
 */
function entryRangeEnd(block, keyIndex) {
  let end = keyIndex + 1;
  while (end < block.length) {
    const line = block[end];
    if (line.trim() === '' || /^\s*#/u.test(line) || /^ {8}/u.test(line)) {
      end += 1;
      continue;
    }
    break;
  }
  return end;
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
  const info = modelBlock(block);
  const ourEntry = info.tiers.find((item) => item.id === PRESET_ID);
  // 悬空默认＝defaultPreset 的**解析标量**指向本包档（引号/行尾注释形态同判，N3）。
  const danglingDefault = info.defaultLine.parsed === PRESET_ID ? info.defaultLine.index : -1;
  if (!shouldResetResidue(manifest.bundles, Boolean(ourEntry) || danglingDefault !== -1)) {
    return { action: 'skip', reason: 'not-required' };
  }
  try {
    // 编辑后形态：先移除条目块（结构边界）与悬空默认行，再对剩余块重建模型判定行去留。
    const drop = new Set();
    if (ourEntry) {
      const entryEnd = entryRangeEnd(block, ourEntry.keyIndex);
      for (let index = ourEntry.keyIndex; index < entryEnd; index += 1) drop.add(index);
    }
    if (danglingDefault !== -1) drop.add(danglingDefault);
    const kept = block.filter((_, index) => !drop.has(index));
    const keptModel = modelBlock(kept);
    const hasDefault = keptModel.defaultLine.index !== -1;
    const keptTiers = keptModel.tiers;
    // 宇宙外探测（复审 N1 全缩进级）：模型把每一层不认识的行都收进集合——行属性、config 键、
    // 未知/带值档键、非基线标准档、档内注释、错位缩进。集合非空 ⇒ 行内有用户内容，保留行。
    const foreignLines = keptModel.foreignTexts;
    const hasForeign = kept.some((line) => {
      return foreignLines.has(line);
    });
    // 行删除条件（均以「无宇宙外内容」为前提）：presets 被删空（空 map 会让 PP 构造器按无匹配
    // 档抛错）；或「无默认档（悬空行已移除＝用户没有仍有效的默认选择）且剩余档全为基线标准档」
    // ＝纯设置拖入形态，整行删除＝恢复继承层。
    const deleteRow = !hasForeign
      && (keptTiers.length === 0
        || (!hasDefault && keptTiers.every((item) => item.baseline === true)));
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
