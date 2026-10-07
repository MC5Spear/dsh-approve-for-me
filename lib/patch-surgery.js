/**
 * permission 行手术的共享解析内核（R57 修正窗③；复审 B1–B4 修订）。
 *
 * 原则：**真实 YAML 解析定位，文本手术只落在解析确认的行范围内**——
 *  - 块定位用解析树（eemeli/yaml 节点的 range → 行号）：presets 映射每个条目的键行、
 *    条目块的结束边界（同映射下一键的键行 / 父级键行 / 行块末尾）全部来自解析结构，
 *    **不再按缩进猜测**（修正窗③之前的「全缩进级行模型」就此废弃）。
 *  - 已知子集之外的输入一律**拒绝动作**（guard=skip、restore=抛错零落盘），绝不部分编辑：
 *      · 解析错误（含多文档 `---`、重复键、错位缩进、tab 缩进）；
 *      · 解析警告（未解析 tag 等——本包不猜自定义 tag 的语义）；
 *      · 文档任何位置的锚点 `&x` / 别名 `*x`（B2：本包的编辑器不理解引用图，删除
 *        可能给无关配置留下不可解析的悬空别名；含 `defaultPreset: &chosen auto-approve`
 *        形态——B3：带锚点/别名的默认值不做半清理，整体拒绝）；
 *      · 顶层数组或 permission 行子树内的 flow 风格集合（`{...}`/`[...]` 与兄弟条目
 *        共行，行级手术会误伤同行内容）；
 *      · 行形状出格（`config`/`presets` 不是映射）。
 *  - 父路径限定（B1）：只有 **config.presets 映射内的条目**才是档位。`config` 下的
 *    其他键（`extra:` 映射、`text: |` 块标量……）及其全部子孙行都是用户内容，
 *    一律保全——块标量正文里的 `auto-approve:` 字样是字符串数据，不是档位。
 *  - 标量语义一律取**解析值**比较（B4：`'auto-approve''#custom: value'` 是合法的
 *    单引号双写转义、解析值含引号与井号，不是基线/本包档名；`"auto-approve"` 与
 *    裸值同判——r62-R1 的宿主双引号 name 形态由此免费覆盖）。
 *
 * 为什么有运行时依赖 `yaml`：本内核是 preset-guard（宿主进程内 disposer）与
 * permission-preset（CLI）的共享定位层。依赖经动态 `import('yaml')` 惰性加载——
 * 解析器不可用时按「拒绝动作」降级（不猜结构），模块加载本身零依赖（静态 import
 * 只有 node:* 与包内相对路径）。修正窗③之前的「零 npm 依赖也能手术」承诺收缩为：
 * init-row/apply/revert 仍完全零依赖；guard/restore 在解析器缺席的环境中保守拒绝。
 *
 * @module dsh-approve-for-me/lib/patch-surgery
 */

/** 本包注入的预设 id（残留清理的目标条目）。 */
export const PRESET_ID = 'auto-approve';
/** 宿主三标准档 id（基线判定的档 id 宇宙）。 */
export const STANDARD_IDS = ['read-only', 'workspace-write', 'danger-full-access'];
/** permission 覆盖行 name 的基线**语义值**（permission 行的服务包名；按解析值比较）。 */
export const BASELINE_NAME_VALUE = '@deepseek-ai/dsh-permission-presets';
/** 三标准档基线子键的**语义值**（与 dsh-base 的同名行逐字一致；子键集合与取值都
 * 必须恰好相等——多键/少键/改值/档内注释都是用户修改，不得代删）。 */
export const BASELINE_TIER_VALUES = {
  'read-only': { sandbox: 'read-only', approval: 'ask' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
};

/** 解析器模块的缓存 Promise（含「加载失败」这一结果，失败不重试）。 */
let yamlApiPromise;

/**
 * 取 YAML 解析器 API（`parseDocument` 等）。
 * @param {object | null | undefined} explicit - 显式注入（测试/探针用）：传 `null`
 *   强制模拟「解析器不可用」的降级环境；传模块对象（CJS exports 或 ESM namespace）则直接采用。
 * @returns {Promise<object | null>} 解析器 API；不可用时为 null（调用方按拒绝动作处理）。
 */
export async function loadYamlApi(explicit) {
  if (explicit !== undefined) {
    return explicit === null ? null : pickApi(explicit);
  }
  yamlApiPromise ??= import('yaml').then(pickApi).catch(() => null);
  return yamlApiPromise;
}

/** 从 CJS exports / ESM namespace 里挑出带 `parseDocument` 的那个对象。 */
function pickApi(module) {
  const api = typeof module?.parseDocument === 'function' ? module : module?.default;
  return typeof api?.parseDocument === 'function' ? api : null;
}

/** 拒绝动作的结果。reason 见文件头「已知子集之外」清单。 */
const refuse = (reason, detail) => ({ status: 'refuse', reason, detail });

/**
 * 解析 profile patch 全文并定位 permission 覆盖行（两个手术入口共享的单一定位层）。
 *
 * @param {object} deps
 * @param {string} deps.text - patch 全文（BOM 已剥；行号按该文本的 `\n` 计）。
 * @param {object} deps.yaml - 解析器 API（`loadYamlApi` 的结果，调用方保证非 null）。
 * @returns {object}
 *   - `{ status: 'no-row' }`：文档里没有 id=permission 的行（幂等：无需动作）。
 *   - `{ status: 'refuse', reason, detail }`：已知子集之外——调用方必须拒绝动作。
 *   - `{ status: 'ok', rowStart, rowEnd, tiers, defaultPreset, foreignRanges, foreignLabels }`：
 *     行号均为 `[开始, 结束)` 的行区间（行 0 起）：
 *       · `rowStart/rowEnd`＝行块整 extent（含行头 `- ` 所在行）；
 *       · `tiers`＝presets 内条目 `{id, keyLine, end, ours, baseline}`（ours＝本包条目，
 *         子键不校验——整块随贡献移除；baseline＝标准档子键恰为基线语义值）；
 *       · `defaultPreset`＝`{line, end, value}`（value＝解析标量值；非字符串标量也在，
 *         由 foreign 标注）或 null；
 *       · `foreignRanges/foreignLabels`＝用户内容行区间与可读标注（行属性/config 键/
 *         未知档/非基线标准档/档外注释…）——guard 依它保留行，restore 依它拒绝代删。
 */
export function analyzePermissionRow({ text, yaml }) {
  let doc;
  try {
    doc = yaml.parseDocument(text);
  } catch (error) {
    return refuse('parse-errors', String(error?.message ?? error));
  }
  if (doc.errors?.length > 0) {
    return refuse('parse-errors', doc.errors.map((e) => e.message).join('；'));
  }
  if (doc.warnings?.length > 0) {
    return refuse('doc-warnings', doc.warnings.map((e) => e.message).join('；'));
  }
  const root = doc.contents;
  if (root === null || root === undefined || root.constructor?.name !== 'YAMLSeq') {
    return { status: 'no-row' };
  }
  // 锚点/别名：全文档扫描（B2——引用方可能在任何其他行里）。
  const anchors = { count: 0 };
  scanTree(root, anchors, { wholeDoc: true });
  if (anchors.count > 0) {
    return refuse('anchor-alias', `文档内出现 ${anchors.count} 处锚点/别名`);
  }
  // 找 id=permission 的行（键序不限——不靠「id 必须是首键」的文本形态）。先找行、后判
  // flow：空数组占位 `[]` 也是 flow 序列，但它没有行＝无需动作，不能误报拒绝。
  let rowIndex = -1;
  let rowNode = null;
  for (let index = 0; index < root.items.length; index += 1) {
    const item = root.items[index];
    if (item?.constructor?.name !== 'YAMLMap') continue;
    const idPair = item.items.find((pair) => pair.key?.value === 'id');
    if (idPair && idPair.value?.constructor?.name === 'Scalar' && idPair.value.value === 'permission') {
      rowIndex = index;
      rowNode = item;
      break;
    }
  }
  if (rowNode === null) return { status: 'no-row' };
  // 行定位：顶层数组本身是 flow（`[...]`）时条目共行，行级手术必然误伤。
  if (root.flow === true) return refuse('flow-style', '顶层数组是 flow 风格');
  // 行子树内的 flow 集合：与行内其他内容共行，行级手术无法隔离。
  const inRow = { count: 0 };
  scanTree(rowNode, inRow, { wholeDoc: false, flow: true });
  if (inRow.count > 0) return refuse('flow-style', 'permission 行子树内出现 flow 风格集合');

  // 行号换算：offset → 行号（按 \n 位置建表；CRLF 下行号与 split('\n')/split(/\r?\n/) 一致）。
  const lines = text.split('\n');
  const lineStarts = [0];
  for (let offset = 0; offset < text.length; offset += 1) {
    if (text[offset] === '\n') lineStarts.push(offset + 1);
  }
  const lineOf = (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (lineStarts[mid] > offset) high = mid - 1;
      else low = mid;
    }
    return low;
  };

  // 结构边界：行/ config / presets 三层映射的键行集合 + 行块末尾。任一节点对的
  // extent＝[自身键行, 下一个更晚出现的边界)——YAML 块结构的嵌套保证这个区间恰好
  // 覆盖该键的全部子孙行（更深层的子键行不在边界集合里）。
  const rowStart = lineOf(rowNode.range[0]);
  const nextItem = root.items[rowIndex + 1];
  const rowEnd = nextItem === undefined ? lines.length : lineOf(nextItem.range[0]);
  const boundarySet = new Set([rowEnd]);
  const configNode = rowNode.items.find((pair) => pair.key?.value === 'config')?.value ?? null;
  const presetsNode = configNode?.items?.find((pair) => pair.key?.value === 'presets')?.value ?? null;
  for (const pair of rowNode.items) boundarySet.add(lineOf(pair.key.range[0]));
  if (configNode?.items) for (const pair of configNode.items) boundarySet.add(lineOf(pair.key.range[0]));
  if (presetsNode?.items) for (const pair of presetsNode.items) boundarySet.add(lineOf(pair.key.range[0]));
  const boundaries = [...boundarySet].sort((a, b) => a - b);
  const extentEnd = (keyLine) => boundaries.find((line) => line > keyLine) ?? rowEnd;

  const tiers = [];
  const foreignRanges = [];
  const foreignLabels = [];
  let defaultPreset = null;
  const markForeign = (label, keyLine) => {
    foreignLabels.push(label);
    foreignRanges.push([keyLine, extentEnd(keyLine)]);
  };

  for (const pair of rowNode.items) {
    const key = pair.key?.value;
    const keyLine = lineOf(pair.key.range[0]);
    if (key === 'id') continue;
    if (key === 'name') {
      const value = pair.value;
      if (value?.constructor?.name === 'Scalar' && typeof value.value === 'string') {
        if (value.value !== BASELINE_NAME_VALUE) markForeign(`行属性.name=${value.value}`, keyLine);
      } else {
        markForeign('行属性.name（非字符串标量）', keyLine);
      }
      continue;
    }
    if (key !== 'config') {
      markForeign(`行属性.${key}`, keyLine);
      continue;
    }
    if (configNode === null || configNode.constructor?.name !== 'YAMLMap') {
      return refuse('row-shape', 'config 的值不是映射');
    }
    for (const configPair of configNode.items) {
      const configKey = configPair.key?.value;
      const configLine = lineOf(configPair.key.range[0]);
      if (configKey === 'presets') {
        if (presetsNode === null) continue; // `presets:` 空值＝无档，无贡献。
        if (presetsNode.constructor?.name !== 'YAMLMap') {
          return refuse('row-shape', 'presets 的值不是映射');
        }
        for (const tierPair of presetsNode.items) {
          const id = tierPair.key?.value;
          const tierLine = lineOf(tierPair.key.range[0]);
          if (id === PRESET_ID) {
            // 本包条目：子键不校验（任意形态都整块随贡献移除——extent 覆盖键行到
            // 下一结构边界的全部行，flow 子值/嵌套内容都在其中）。
            tiers.push({ id, keyLine: tierLine, end: extentEnd(tierLine), ours: true, baseline: false });
            continue;
          }
          const expected = BASELINE_TIER_VALUES[id];
          if (expected === undefined) {
            markForeign(`presets.${String(id)}`, tierLine);
            tiers.push({ id, keyLine: tierLine, end: extentEnd(tierLine), ours: false, baseline: false });
            continue;
          }
          let baseline = true;
          const tierValue = tierPair.value;
          if (tierValue?.constructor?.name !== 'YAMLMap') {
            baseline = false; // 标量/序列取值的「标准档」＝用户改写。
          } else {
            const seen = new Set();
            for (const child of tierValue.items) {
              const childKey = child.key?.value;
              const childValue = child.value;
              seen.add(childKey);
              if (expected[childKey] === undefined
                || childValue?.constructor?.name !== 'Scalar'
                || childValue.value !== expected[childKey]) baseline = false;
            }
            for (const expectedKey of Object.keys(expected)) {
              if (!seen.has(expectedKey)) baseline = false;
            }
          }
          tiers.push({ id, keyLine: tierLine, end: extentEnd(tierLine), ours: false, baseline });
          if (!baseline) markForeign(`presets.${String(id)}（非基线形态）`, tierLine);
        }
        continue;
      }
      if (configKey === 'defaultPreset') {
        const value = configPair.value;
        if (value?.constructor?.name === 'Scalar') {
          defaultPreset = { line: configLine, end: extentEnd(configLine), value: value.value };
          // null/数字/布尔取值＝四档宇宙外（宿主写路径只产字符串；空值是手工形态）。
          if (typeof value.value !== 'string') markForeign(`defaultPreset=${String(value.value)}`, configLine);
        } else {
          defaultPreset = { line: configLine, end: extentEnd(configLine), value: undefined };
          markForeign('defaultPreset（非标量）', configLine);
        }
        continue;
      }
      // B1：config 下其他键（含块标量正文里的同名文本）＝用户数据，整体保全。
      markForeign(`config.${String(configKey)}`, configLine);
    }
  }

  // 注释行归属（B1 后的收尾）：空行无信息；注释挂在某个档 extent 内→随该档处置
  //（本包档：随块移除；标准档：判非基线——与子键校验同口径），否则＝宇宙外内容。
  for (let line = rowStart; line < rowEnd; line += 1) {
    const lineText = lines[line];
    if (lineText.trim() === '' || !/^\s*#/u.test(lineText)) continue;
    const owner = tiers.find((tier) => tier.keyLine <= line && line < tier.end);
    if (owner === undefined) {
      markForeign(`注释行（${lineText.trim()}）`, line);
      continue;
    }
    if (owner.ours || !owner.baseline) continue;
    owner.baseline = false;
    markForeign(`presets.${String(owner.id)}（档内注释）`, owner.keyLine);
  }

  return { status: 'ok', rowStart, rowEnd, tiers, defaultPreset, foreignRanges, foreignLabels };
}

/**
 * 深扫节点树：数锚点/别名（wholeDoc 模式）或 flow 集合（flow 模式）。
 * Pair 节点没有 range，按 key/value 两个子节点递归；Alias 是叶子。
 * @param {object} node - 当前节点。
 * @param {{count: number}} counters - 命中计数。
 * @param {{wholeDoc?: boolean, flow?: boolean}} mode - 扫描目标。
 * @returns {void}
 */
function scanTree(node, counters, mode) {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (mode.wholeDoc === true) {
    if (typeof node.anchor === 'string' && node.anchor !== '') counters.count += 1;
    if (node.constructor?.name === 'Alias') {
      counters.count += 1;
      return;
    }
  }
  if (mode.flow === true && node.flow === true) counters.count += 1;
  if (Array.isArray(node.items)) {
    for (const item of node.items) {
      if (item !== null && typeof item === 'object' && 'key' in item && 'value' in item) {
        scanTree(item.key, counters, mode);
        scanTree(item.value, counters, mode);
      } else {
        scanTree(item, counters, mode);
      }
    }
  }
}
