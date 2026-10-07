/**
 * 预设残留防护（R57 / 设计 §28.3-2；盲审修订；复审 N1-N3、修正窗③ B1-B4 修订）。
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
 * 手术原则（贡献级清理；修正窗③起块定位基于**真实 YAML 解析**——lib/patch-surgery.js）：
 *  只删**本包的贡献**，保全用户的有效选择与自定义——
 *  1. 删覆盖行 presets 里的 `auto-approve:` 条目块。块边界＝解析树给出的结构边界
 *     （同映射下一键的键行/父级键行/行块末尾），子键间的合法空行/注释随块整块移除
 *     （复审 N2）；**父路径限定**（B1）：只有 config.presets 映射内的条目才是档位，
 *     config 下其他键（`extra:` 映射、`text: |` 块标量正文）是用户数据，一律保全。
 *  2. 删指向 auto-approve 的 defaultPreset 行。取值按**解析标量**判定（引号/转义/行尾
 *     注释同判——复审 N3、B4；`'auto-approve''#x'` 这类转义形态的解析值不是本包档名）。
 *  3. 行去留按编辑后形态判定：presets 被删空，或「无 defaultPreset 且行内恰为已知基线
 *     形态」→ 整行删除＝恢复继承（dsh-base 三档）；否则保留行、只做条目级清理。
 *     基线判定＝解析值逐层校验：行属性只认基线 name（语义值比较——宿主序列化双引号/
 *     手工单引号同判，r62-R1）；config 键 ⊆ {presets, defaultPreset}；标准档子键必须
 *     恰为基线两条语义值——未知子键/改值/档内注释都算用户修改，保留行不代删。
 *  4. 已知子集之外（解析错误/多文档/警告/锚点·别名/flow 风格/行形状出格）＝**拒绝
 *     动作**（B2/B3：锚点引用图与本包编辑器不兼容，绝不部分编辑），按 skip 降级。
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
 * profileContext 缺席、manifest 不可读、锚点不命中等一切降级路径都表现为「跳过」；
 * 解析器不可用（依赖缺席的降级环境）与已知子集之外的拒绝同样跳过并留审计行。
 *
 * @module dsh-approve-for-me/lib/preset-guard
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzePermissionRow, INIT_ROW_MARKER, loadYamlApi, needsTopLevelPlaceholder, PRESET_ID } from './patch-surgery.js';

/** 本包名（profile manifest 数组里的键）。 */
const PACKAGE_NAME = 'dsh-approve-for-me';
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
 * 执行防护（disposer 内调用；每一步失败都降级为「跳过」，绝不抛出）。
 * 动作见文件头「手术原则」。原子写：同目录临时文件 + rename；UTF-8 无 BOM（原文件带 BOM 则保留）。
 * @param {{ profileDir?: string, yaml?: object | null }} deps `profileDir` 来自
 *   `ctx.get('profileContext')?.dir`；`yaml` 可显式注入解析器（测试/探针用，
 *   传 null 模拟解析器缺席的降级环境）。
 * @returns {Promise<{ action: 'reset' | 'skip', reason: string }>} 结果说明（供审计/测试断言）：
 *   reset/removed-user-override＝整行删除（恢复继承）；reset/removed-tier-entry＝条目级清理（保留行）。
 */
export async function guardDefaultPreset({ profileDir, yaml } = {}) {
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
  const body = text.slice(bom.length);
  // 解析器缺席＝降级环境（依赖被拆除的 CLI 场景）：保守跳过，绝不回退到猜缩进。
  const api = await loadYamlApi(yaml);
  if (api === null) return { action: 'skip', reason: 'yaml-unavailable' };
  const analysis = analyzePermissionRow({ text: body, yaml: api });
  if (analysis.status === 'no-row') return { action: 'skip', reason: 'not-required' };
  if (analysis.status === 'refuse') return { action: 'skip', reason: `patch-refused:${analysis.reason}` };
  const lines = body.split('\n');
  const ourEntry = analysis.tiers.find((tier) => tier.ours) ?? null;
  // 悬空默认＝defaultPreset 的**解析标量**指向本包档（引号/转义/行尾注释形态同判，N3/B4）。
  const danglingDefault = analysis.defaultPreset !== null && analysis.defaultPreset.value === PRESET_ID
    ? analysis.defaultPreset
    : null;
  if (!shouldResetResidue(manifest.bundles, ourEntry !== null || danglingDefault !== null)) {
    return { action: 'skip', reason: 'not-required' };
  }
  try {
    // 编辑后形态：先按解析确认的行区间移除本包条目块与悬空默认行，再判定行去留。
    const removed = new Set();
    if (ourEntry !== null) {
      for (let line = ourEntry.keyLine; line < ourEntry.end; line += 1) removed.add(line);
    }
    if (danglingDefault !== null) {
      for (let line = danglingDefault.line; line < danglingDefault.end; line += 1) removed.add(line);
    }
    // 宇宙外探测：解析模型把每一处不认识的内容（行属性/config 键/未知档/非基线标准档/
    // 档外注释）都收进区间——未被移除的区间非空 ⇒ 行内有用户内容，保留行。
    const hasForeign = analysis.foreignRanges.some(([start, end]) => {
      for (let line = start; line < end; line += 1) {
        if (!removed.has(line)) return true;
      }
      return false;
    });
    const hasDefault = analysis.defaultPreset !== null && danglingDefault === null;
    const keptTiers = analysis.tiers.filter((tier) => !tier.ours);
    // 行删除条件（均以「无宇宙外内容」为前提）：presets 被删空（空 map 会让 PP 构造器按无匹配
    // 档抛错）；或「无默认档（悬空行已移除＝用户没有仍有效的默认选择）且剩余档全为基线标准档」
    // ＝纯设置拖入形态，整行删除＝恢复继承层。
    const deleteRow = !hasForeign
      && (keptTiers.length === 0
        || (!hasDefault && keptTiers.every((tier) => tier.baseline === true)));
    let next;
    let reason;
    if (deleteRow) {
      let rowStart = analysis.rowStart;
      // r65-F3：行前若有本包 `--init-row` 的指纹注释块（逐字节全等才认），一并回收——
      // 那是本包自己的贡献；指纹块前紧邻的空行分隔同样收敛。比对按剥 \r 后的行
      // （CRLF 文件的行尾 \r 不参与指纹判定——r65 复验 N1）。
      if (rowStart >= INIT_ROW_MARKER.length
        && lines.slice(rowStart - INIT_ROW_MARKER.length, rowStart).map((line) => line.replace(/\r$/u, '')).join('\n') === INIT_ROW_MARKER.join('\n')) {
        rowStart -= INIT_ROW_MARKER.length;
        if (lines[rowStart - 1] === '') rowStart -= 1;
      }
      next = [...lines.slice(0, rowStart), ...lines.slice(analysis.rowEnd)];
      reason = 'removed-user-override';
    } else {
      const kept = lines
        .slice(analysis.rowStart, analysis.rowEnd)
        .filter((_, offset) => !removed.has(analysis.rowStart + offset));
      next = [...lines];
      next.splice(analysis.rowStart, analysis.rowEnd - analysis.rowStart, ...kept);
      reason = 'removed-tier-entry';
    }
    // r65-F2：写回前归一尾随（与 permission-preset.js 的 writeAtomic 同款）——多个尾随
    // 空行收敛，行尾统一按原文件的 EOL 风格（CRLF 文件上补的 `[]` 不再裸 LF）。
    while (next.length > 0 && next[next.length - 1].trim() === '') next.pop();
    // r65-F1：占位补回条件＝剩余有效行全为注释/空白（文档＝YAML null——宿主 parsePatchList
    // 要求顶层数组）。**顶层整体缩进**的块序列条目也算「文档有条目」，此时追加列 0 `[]`
    // 会造出「同文档双节点」的非法 YAML——旧判定只认列 0 `- ` 行，对缩进序列必误补。
    if (needsTopLevelPlaceholder(next)) next.push('[]');
    const eol = body.includes('\r\n') ? '\r\n' : '\n';
    const out = `${next.map((line) => line.replace(/\r$/u, '')).join(eol)}${eol}`;
    // 与 permission-preset.js 同款原子写：同目录临时文件 + rename。
    const temp = join(profileDir, `${PATCH_FILE}.dsafm-guard.tmp`);
    writeFileSync(temp, bom + out, 'utf8');
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
  // 审计口径（设计 §28.3-2）：复位与失败性 skip（写失败／manifest 或 patch 不可读／解析器
  // 缺席／已知子集之外的拒绝——残留未清，值得留痕追查）落一行；良性跳过（关停/升级/重载＝
  // not-required、非 profile 环境＝no-profile）静默。
  if (result.action === 'reset' || /failed|unreadable|refused|unavailable/u.test(result.reason)) {
    audit({
      phase: 'screen',
      action: 'skip',
      source: result.action === 'reset' ? 'guard' : 'error',
      reason: `预设残留防护：${result.action}（${result.reason}）`,
    });
  }
  return result;
}
