#!/usr/bin/env node
/**
 * 公开文档静态检查器（design「测试与事实同步」「分发与验证安排」）。
 *
 * 事实全部取自真实实现：Config schema 树（.dict/.meta/.list 逐字段取 type/enum/min/max/
 * volatile）、normalizeConfig 默认值、读取路径边界集（NAT_BOUND_FIELDS）、
 * DEFAULT_REDACT_PATTERNS（lib/policy.js）、trace-store 导出常量、client.js FIELDS 与
 * 专用控件/兼容映射行、package.json 与 lock 根互核。不维护第二份 expected 默认表。
 *
 * 三种模式：
 *   node tools/check-docs.mjs              仓库静态检查（文档枚举 + 链接 + 用户参考表 + 版本身份）
 *   node tools/check-docs.mjs --package D  只读核一个已解包的包目录
 *   node tools/check-docs.mjs --pack       npm pack --ignore-scripts 到本次唯一临时目录并核真实包
 * 无网络、无实例、无模型；发现缺陷退出非零；工具/沙箱缺失记「未执行」退 2、npm 构建失败退 1。
 * @module dsh-approve-for-me/check-docs
 */
import { readFileSync, existsSync, readdirSync, statSync, rmSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { Config, normalizeConfig } from '../lib/config.js';
import { DEFAULT_REDACT_PATTERNS } from '../lib/policy.js';
import { LINE_CAP_FACTOR, DEFAULT_MAX_RECORDS, DEFAULT_MAX_SESSIONS } from '../lib/trace-store.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 公共文档枚举 ────────────────────────────────────────────────────────────

/** 根级公开文档白名单：只认已知公开首页/参与指南/变更记录，不枚举未知用户文件。 */
const ROOT_PUBLIC_DOCS = ['README.md', 'README.en.md', 'CONTRIBUTING.md', 'CHANGELOG.md'];
/** 目录级排除：内部区、依赖区与工具测试区；LICENSES 是法律文本整族豁免。docs 内只认 .md。 */
const DIR_SKIP = new Set(['.git', '.local', 'node_modules', 'scratch', 'test', 'tools', '.github', 'LICENSES']);

/**
 * 枚举公开文档：根级白名单 + docs 目录全部 .md。直接走文件系统（含未暂存新文件），
 * 不用 git ls-files——git 只列跟踪文件，会漏掉尚未提交的新文档。
 * @param {string} root 仓库根（或包根）。
 * @returns {string[]} 绝对路径列表。
 */
export function collectPublicDocs(root) {
  const out = [];
  for (const name of ROOT_PUBLIC_DOCS) {
    const full = path.join(root, name);
    if (existsSync(full)) out.push(full);
  }
  const docsDir = path.join(root, 'docs');
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (!DIR_SKIP.has(name)) walk(full);
      } else if (/\.md$/i.test(name)) out.push(full);
    }
  };
  if (existsSync(docsDir)) walk(docsDir);
  return out;
}

// ── 链接抽取与核验 ──────────────────────────────────────────────────────────

/** 去掉围栏代码块与行内代码，避免示例代码里的链接/标题形态被当成真链接/真标题。 */
export function stripCode(text) {
  return text.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '').replace(/`[^`\n]*`/g, '');
}

/** GFM 标题 slug：小写 → 去非字母数字（unicode）与连字符外字符 → 空格转连字符。保留 CJK。 */export function headingSlug(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

/**
 * 收集一个文档的可用 fragment：ATX 标题、Setext 标题（=== / --- 下划线）与显式
 * `<a id/name>` 锚点。围栏代码块内的伪标题不算。
 */
export function collectFragments(text) {
  const bare = text.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '');
  const frags = new Set();
  const lines = bare.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const atx = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (atx) {
      frags.add(headingSlug(atx[2]));
      continue;
    }
    // Setext：文本行的下一行是纯 === 或 ---。空行/标题/表格行后的 --- 是分隔线，不是 Setext。
    const underline = /^\s*(=+|-+)\s*$/.exec(lines[i]);
    const prev = i > 0 ? lines[i - 1].trim() : '';
    if (underline && prev !== '' && !/^[#>|]/.test(prev) && !/^\s*(=+|-+)\s*$/.test(lines[i - 1])) {
      frags.add(headingSlug(prev));
    }
  }
  for (const m of bare.matchAll(/<a\s[^>]*\b(?:id|name)\s*=\s*["']([^"']+)["'][^>]*>/gi)) frags.add(m[1]);
  return frags;
}

const isExternal = (target) => /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith('//');

/** 解码一段链接文本；解码失败返回 null（调用方按问题报告，不崩溃）。 */
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * 抽取 Markdown 链接：内联（含尖括号包裹目标与 %20 编码）、引用式（含定义与用法）。
 * @param {string} text 正文（已去代码块）。
 * @returns {{raw: string, target: string, line: number}[]}
 */
export function extractLinks(text) {
  const links = [];
  const lineOf = (index) => text.slice(0, index).split('\n').length;
  const defs = new Map();
  for (const m of text.matchAll(/^ {0,3}\[([^\]]+)\]:\s*(\S+)(?:\s+"[^"]*")?\s*$/gm)) defs.set(m[1].toLowerCase(), m[2]);
  for (const m of text.matchAll(/\[([^\]]*)\]\(\s*<([^>]*)>|\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = m[2] ?? m[4];
    links.push({ raw: m[0], target, line: lineOf(m.index) });
  }
  for (const m of text.matchAll(/\[([^\]]*)\]\[([^\]]+)\]/g)) {
    const target = defs.get(m[2].toLowerCase());
    if (target) links.push({ raw: m[0], target, line: lineOf(m.index) });
  }
  for (const m of text.matchAll(/(^|[^\\])\[([^\]\n]+)\](?!\()/g)) {
    const target = defs.get(m[2].toLowerCase());
    if (target) links.push({ raw: m[0], target, line: lineOf(m.index) });
  }
  return links;
}

/** 解析链接目标：分离 fragment、解码编码。解码失败以 decodeError 标记。 */
function splitTarget(target) {
  const hashIndex = target.indexOf('#');
  const filePart = hashIndex === -1 ? target : target.slice(0, hashIndex);
  const fragPart = hashIndex === -1 ? '' : target.slice(hashIndex + 1);
  const frag = safeDecode(fragPart);
  const file = filePart && !isExternal(filePart) ? safeDecode(filePart) : '';
  const decodeError = (fragPart !== '' && frag === null) || (filePart !== '' && !isExternal(filePart) && file === null);
  return { file: file ?? '', frag: frag ?? '', external: isExternal(target), decodeError };
}

/**
 * 核验一组文档的相对文件链接与 fragment。相对链接不得逃出 root（不读授权目录外的文件）。
 * @param {string} root 根目录（相对链接的基准与 containment 边界）。
 * @param {string[]} docs 文档绝对路径。
 * @returns {{file: string, line: number, raw: string, problem: string}[]}
 */
export function checkDocLinks(root, docs) {
  const issues = [];
  for (const doc of docs) {
    const rel = path.relative(root, doc).replaceAll('\\', '/');
    const text = readFileSync(doc, 'utf8');
    const ownFrags = collectFragments(text);
    for (const link of extractLinks(stripCode(text))) {
      const { file, frag, external, decodeError } = splitTarget(link.target);
      if (decodeError) {
        issues.push({ file: rel, line: link.line, raw: link.raw, problem: `链接编码无法解码：${link.target}` });
        continue;
      }
      if (external) continue; // 外部链接未核实就记未核实，不在本检查器职责内
      if (!file && frag) {
        if (!ownFrags.has(frag)) issues.push({ file: rel, line: link.line, raw: link.raw, problem: `本文档不存在片段锚点 #${frag}` });
        continue;
      }
      const resolved = path.resolve(path.dirname(doc), file);
      const relInside = path.relative(root, resolved);
      if (relInside.startsWith('..') || path.isAbsolute(relInside)) {
        issues.push({ file: rel, line: link.line, raw: link.raw, problem: `相对链接逃出检查根目录：${file}` });
        continue;
      }
      if (!existsSync(resolved)) {
        issues.push({ file: rel, line: link.line, raw: link.raw, problem: `相对链接目标不存在：${file}` });
        continue;
      }
      if (frag && /\.md$/i.test(resolved)) {
        const targetFrags = collectFragments(readFileSync(resolved, 'utf8'));
        if (!targetFrags.has(frag)) {
          issues.push({ file: rel, line: link.line, raw: link.raw, problem: `目标文档 ${file} 不存在片段锚点 #${frag}` });
        }
      }
    }
  }
  return issues;
}

// ── 配置事实（真实 schema 树派生，不建第二份表） ────────────────────────────

/** 设置页专用控件（client.js FIELDS 之外的独立渲染控件，见 FIELDS 头注）。 */
export const DEDICATED_CONTROLS = ['trigger.presets', 'reviewer.model', 'reviewer.parentModelRules'];

/**
 * 兼容映射行：`reviewer.byParentModel` 在设置页映射控件内确可编辑（client 保存写旧字典）；
 * 以 client.js 中存在真实写路径为依据，不当作无控件字段。
 */
export function compatMappingEditable(clientSource) {
  return /byParentModel/.test(clientSource) ? ['reviewer.byParentModel'] : [];
}

/** 从 client.js 源文本解析 FIELDS 的字段路径（浏览器模块不可 import，只读源码抽路径）。 */
export function parseClientFields(clientSource) {
  const paths = [];
  for (const m of clientSource.matchAll(/\{\s*section:\s*"[^"]+",\s*path:\s*\[((?:"[^"]*"\s*,?\s*)+)\]/g)) {
    const parts = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    paths.push(parts.join('.'));
  }
  return paths;
}

/** 存储机制事实（真实导出常量，不手写数值）。 */
export function traceStoreFacts() {
  return { lineCapFactor: LINE_CAP_FACTOR, defaultMaxRecords: DEFAULT_MAX_RECORDS, defaultMaxSessions: DEFAULT_MAX_SESSIONS };
}

/** 从源文本抽 `const NAME = Object.freeze([...])` 的 [group, key] 对集（读取路径边界集）。 */
function parseBoundSet(configSource, constName) {
  const m = new RegExp(`const ${constName} = Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)`, 'm').exec(configSource);
  if (!m) throw new Error(`lib/config.js 中未找到 ${constName}（读取路径边界集是检查事实源，缺失即实现漂移）`);
  return new Set([...m[1].matchAll(/\[\s*'([^']+)'\s*,\s*'([^']+)'\s*\]/g)].map((x) => `${x[1]}.${x[2]}`));
}

/** schema 叶子：type 来自 schema 节点本身；union 全 const → 枚举；数组/字典按 inner 细分。 */
function schemaLeafInfo(node) {
  if (node.type === 'object') return { kind: 'object', children: node.dict ?? {} };
  if (node.type === 'union') {
    const list = node.list ?? [];
    if (list.length > 0 && list.every((x) => x.type === 'const')) {
      return { kind: 'enum', values: list.map((x) => x.value) };
    }
    return { kind: 'union' };
  }
  if (node.type === 'array') return { kind: node.inner?.type === 'object' ? 'array-object' : 'array-string' };
  if (node.type === 'dict') return { kind: 'dict' };
  return { kind: node.type }; // boolean / string / number / any
}

/**
 * 派生配置字段事实：沿 Config schema 树逐叶子取 type/enum/min/max/volatile/default。
 * 范围档：T＝schema max 2147483647（进 setTimeout 域毫秒）；N+S＝schema 自然数但读取路径
 * 另限安全整数（NAT_BOUND_FIELDS）；N＝自然数无显式上界；小步长数值＝schema min/max 区间。
 * 生效档：volatile 字段保存/热更新后后续请求生效（A＝页面可编辑含兼容映射行，B＝无控件），
 * 其余重载（C）。类型是自然类型词（boolean/string/integer…），N/S/T 只是范围档记号。
 * @returns {{fields: Map<string, object>}}
 */
export function configFieldFacts() {
  const configSource = readFileSync(path.join(REPO_ROOT, 'lib', 'config.js'), 'utf8');
  const clientSource = readFileSync(path.join(REPO_ROOT, 'client.js'), 'utf8');
  const natBound = parseBoundSet(configSource, 'NAT_BOUND_FIELDS');
  const defaults = normalizeConfig({});
  const pageSet = new Set([...parseClientFields(clientSource), ...DEDICATED_CONTROLS, ...compatMappingEditable(clientSource)]);

  const fields = new Map();
  const walk = (node, prefix) => {
    for (const [key, sub] of Object.entries(node.dict ?? {})) {
      const fieldPath = prefix ? `${prefix}.${key}` : key;
      const leaf = schemaLeafInfo(sub);
      if (leaf.kind === 'object') {
        walk(sub, fieldPath);
        continue;
      }
      const meta = sub.meta ?? {};
      const value = fieldPath.split('.').reduce((acc, k) => acc?.[k], defaults);
      let boundClass = '';
      let numericRange = null;
      if (leaf.kind === 'number') {
        if (meta.max === 2147483647) boundClass = 'T';
        else if (natBound.has(fieldPath)) boundClass = 'N+S';
        else if (meta.step !== undefined && meta.step < 1) numericRange = [meta.min ?? -Infinity, meta.max ?? Infinity];
        else boundClass = 'N';
      }
      let unit = '';
      if (fieldPath.endsWith('Ms')) unit = 'ms';
      else if (/Bytes$/.test(key)) unit = 'bytes';
      const volatile = meta.volatile === true;
      fields.set(fieldPath, {
        path: fieldPath,
        schemaType: leaf.kind,
        default: value,
        defaultJson: JSON.stringify(value),
        enumValues: leaf.kind === 'enum' ? leaf.values : undefined,
        boundClass,
        numericRange,
        unit,
        page: pageSet.has(fieldPath),
        volatile,
        effective: volatile ? (pageSet.has(fieldPath) ? 'A' : 'B') : 'C',
      });
    }
  };
  walk(Config, '');
  return { fields };
}

// ── 用户参考逐字段表检查 ────────────────────────────────────────────────────

/** 八列的列头同义词组（兼容同义标题；八组各须恰好命中一次）。 */
const COLUMN_SYNONYMS = [
  ['field', ['字段', '键名', '键', 'field', 'key']],
  ['type', ['类型', 'type']],
  ['default', ['默认值', '默认', 'default']],
  ['range', ['取值范围', '合法范围', '范围', 'range']],
  ['unit', ['单位', 'unit']],
  ['zero', ['零值或空值', '零值/空值', '零空', 'zero or empty', 'zero/empty']],
  ['page', ['设置页', '页面入口', '入口', 'page']],
  ['effective', ['生效方式', '生效时机', '生效', 'effective', 'editing and effect']],
];

/** 图例必须定义的记号全集（用户作者定稿：N/S/T 范围档与 A/B/C 生效档）。 */
export const LEGEND_REQUIRED = ['N', 'S', 'T', 'A', 'B', 'C'];

/** schema 类型词的同义写法（类型列写自然类型词，不强制图例记号）。 */
const TYPE_WORDS = {
  boolean: ['boolean', 'bool', '布尔'],
  string: ['string', '字符串'],
  number: ['number', 'integer', 'int', '数字', '数值', '整数'],
  enum: ['enum', '枚举', 'string', '字符串'],
  'array-string': ['array', '数组', 'string[]', '清单', '列表'],
  'array-object': ['array', '数组', 'object[]', '清单', '列表'],
  dict: ['dict', '字典', 'object', '对象', 'map'],
  union: ['union', '联合', 'string | object', 'string 或 modelchoice', 'string or modelchoice', 'modelchoice'],
};

/** 解析表格行（管道分隔，去首尾空管道段）。 */
function parseTableRow(line) {
  if (!/^\s*\|/.test(line) || !/\|\s*$/.test(line)) return null;
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

/** 在文档中找字段表：表头行命中八组同义词 → 映射列号。 */
function findFieldTable(text) {
  const lines = text.split('\n');
  const tables = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const cells = parseTableRow(lines[i]);
    if (cells === null) {
      if (current) {
        tables.push(current);
        current = null;
      }
      continue;
    }
    if (!current) {
      const mapping = new Map();
      for (const [group, synonyms] of COLUMN_SYNONYMS) {
        const idx = cells.findIndex((cell) => {
          const low = cell.toLowerCase();
          return synonyms.some((syn) => low.includes(syn.toLowerCase()));
        });
        if (idx !== -1) mapping.set(group, idx);
      }
      if (mapping.size === COLUMN_SYNONYMS.length) {
        current = { headerLine: i + 1, mapping, rows: [] };
      }
      continue;
    }
    if (/^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i])) continue;
    current.rows.push({ line: i + 1, cells });
  }
  if (current) tables.push(current);
  return tables;
}

/**
 * 图例记号（N/S/T 范围档、A/B/C 生效档）：扫描给定前文的定义行，兼容
 * `N：`、`` `N`: ``、`**N**：`、`- **A：页面保存。**` 等排版。图例允许出现在全页前文
 * （如生效定义在第3节、范围代号在第5节开头），不限表格紧邻行。
 */
export function parseLegend(text) {
  const letters = new Set();
  for (const m of text.matchAll(/(?:^|[^\p{L}\p{N}])([A-Z])(?:`|\*\*)?\s*[:：=＝]\s*\S/gu)) letters.add(m[1]);
  return letters;
}

const codeSpans = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

/** 单元格中的独立图例记号（字母两侧非字母数字才算独立 token）。 */
const legendTokensIn = (cell) => [...cell.matchAll(/(?:^|[^A-Za-z0-9])([A-Z])(?![A-Za-z0-9])/g)].map((m) => m[1]);

/** 独立数字 token（防止「10–2147483647」里的 0 被 includes 误认）。 */
const hasNumber = (cell, num) => new RegExp(`(^|[^0-9])${num}(?![0-9])`).test(cell);

/** 抽围栏代码块内容（redaction 默认规则清单以此形态落页，不是行内 code span）。 */
function fencedBlocks(text) {
  return [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
}

/** 同页脱敏默认规则核验：锚点 `redaction-defaults` 在场，且某代码块逐行覆盖全部内置模式。 */
function checkRedactionDefaults(name, line, text, issues) {
  if (!collectFragments(text).has('redaction-defaults')) {
    issues.push({ file: name, line, problem: '缺少片段锚点 redaction-defaults（脱敏默认规则的引用目标）' });
  }
  let covered = new Set();
  for (const block of fencedBlocks(text)) {
    const blockCovered = new Set();
    for (const raw of block.split('\n')) {
      const idx = DEFAULT_REDACT_PATTERNS.indexOf(raw.trim());
      if (idx !== -1) blockCovered.add(idx);
    }
    if (blockCovered.size > covered.size) covered = blockCovered;
  }
  if (covered.size !== DEFAULT_REDACT_PATTERNS.length) {
    issues.push({
      file: name,
      line,
      problem: `代码块应逐行覆盖 ${DEFAULT_REDACT_PATTERNS.length} 条内置脱敏规则，实际命中 ${covered.size} 条`,
    });
  }
}

/**
 * 核对两语用户参考的逐字段表。
 * @param {string} root 仓库根。
 * @param {Map<string, object>} facts configFieldFacts() 的字段表。
 * @returns {{file: string, line: number, problem: string}[]}
 */
export function checkReferenceTables(root, facts) {
  const issues = [];
  for (const name of ['docs/user-reference.md', 'docs/user-reference.en.md']) {
    const full = path.join(root, name);
    if (!existsSync(full)) {
      issues.push({ file: name, line: 0, problem: '用户参考文件缺失：两语用户参考是随包公开资料，缺失即失败；从源码仓库或交付源码恢复后重查' });
      continue;
    }
    const text = readFileSync(full, 'utf8');
    const tables = findFieldTable(text);
    if (tables.length === 0) {
      issues.push({ file: name, line: 0, problem: '未找到八列字段表（字段/类型/默认/范围/单位/零值或空值/设置页/生效）' });
      continue;
    }
    // 图例取全页前文（首个字段表之前的全部正文），覆盖「生效定义在第3节、范围代号在第5节」的布局。
    const legend = parseLegend(text.split('\n').slice(0, tables[0].headerLine - 1).join('\n'));
    for (const letter of LEGEND_REQUIRED) {
      if (!legend.has(letter)) issues.push({ file: name, line: 0, problem: `正文缺少记号 ${letter} 的图例定义（N/S/T 范围档、A/B/C 生效档须在表前定义）` });
    }
    const seen = new Map();
    for (const table of tables) {
      for (const row of table.rows) {
        const get = (group) => row.cells[table.mapping.get(group)] ?? '';
        const key = codeSpans(get('field'))[0];
        if (!key) continue; // 非字段数据行（分组小节行等）不计
        if (seen.has(key)) {
          issues.push({ file: name, line: row.line, problem: `字段 ${key} 重复出现（首见于第 ${seen.get(key)} 行）` });
          continue;
        }
        seen.set(key, row.line);
        const fact = facts.get(key);
        if (!fact) {
          issues.push({ file: name, line: row.line, problem: `字段 ${key} 不是实现中的配置键` });
          continue;
        }
        // 类型列：自然类型词与 schema 类型一致（integer/number 同属数值；不强制图例记号）。
        const typeCell = get('type').toLowerCase();
        const typeWords = TYPE_WORDS[fact.schemaType] ?? [String(fact.schemaType)];
        if (!typeWords.some((word) => typeCell.replace(/`/gu, '').trim() === word.toLowerCase())) {
          issues.push({ file: name, line: row.line, problem: `${key} 类型列应为 ${typeWords.join('/')}，实际：${get('type') || '（空）'}` });
        }
        // 生效列：记号必须与真实生效方式一致（A=页面保存后；B=宿主热更新且无控件；C=重载）。
        const effCell = get('effective');
        const effTokens = legendTokensIn(effCell);
        if (!effTokens.includes(fact.effective) && !(fact.path === 'language.ui' && /(下一次|next)\s*(渲染|render)/i.test(effCell))) {
          issues.push({ file: name, line: row.line, problem: `${key} 生效列记号应为 ${fact.effective}，实际记号 ${effTokens.join('') || '（无）'}` });
        }
        if (fact.effective !== 'A' && effTokens.includes('A')) {
          issues.push({ file: name, line: row.line, problem: `${key} 无设置页保存路径，生效列不应使用 A` });
        }
        // 默认列：JSON 字面量逐字匹配；redactPatterns 引用同页六条默认规则。
        const defaultCell = get('default');
        if (key === 'context.redactPatterns') {
          const marker = codeSpans(defaultCell)[0] ?? '';
          if (!/^(`)?(六类默认规则|six default rules|six built-in rules)(`)?$/.test(defaultCell) && !/^(六类默认规则|six default rules|six built-in rules)$/.test(marker)) {
            issues.push({ file: name, line: row.line, problem: `redactPatterns 默认列应为「六类默认规则/six default rules」引用，实际：${defaultCell || '（空）'}` });
          }
          checkRedactionDefaults(name, row.line, text, issues);
        } else if (codeSpans(defaultCell)[0] !== fact.defaultJson) {
          issues.push({ file: name, line: row.line, problem: `${key} 默认值应为 ${fact.defaultJson}，实际写的是 ${defaultCell || '（空）'}` });
        }
        // 范围列（N/S/T 是范围档记号，不是类型代号）：
        // 枚举＝` / ` 分隔的允许值集合恰好相等（可带反引号）；T＝独立 0 与 2147483647 或独立 T 记号；
        // N+S＝独立 0 与 9007199254740991、独立 S 记号或「schema N；运行 S」式组合；
        // N＝非负（不得写具体上界）；小步长数值＝schema min/max 独立端点。
        const rangeCell = get('range');
        const rangeTokens = legendTokensIn(rangeCell);
        if (fact.schemaType === 'enum') {
          const tokens = rangeCell.split('/').map((t) => t.trim().replace(/^`|`$/g, '')).filter((t) => t !== '');
          const got = [...new Set(tokens)].sort().join('\u0000');
          const want = [...fact.enumValues].sort().join('\u0000');
          if (got !== want) {
            issues.push({ file: name, line: row.line, problem: `${key} 范围列允许值集合应为 ${JSON.stringify(fact.enumValues)}（/ 分隔恰好相等，不允许缺失或额外值）` });
          }
        } else if (fact.boundClass === 'T') {
          if (!((hasNumber(rangeCell, 0) && rangeCell.includes('2147483647')) || rangeTokens.includes('T'))) {
            issues.push({ file: name, line: row.line, problem: `${key} 范围列应写明 0–2147483647（或图例 T 记号）` });
          }
        } else if (fact.boundClass === 'N+S') {
          if (!((hasNumber(rangeCell, 0) && rangeCell.includes('9007199254740991')) || (rangeTokens.includes('S') && rangeTokens.includes('N')))) {
            issues.push({ file: name, line: row.line, problem: `${key} 范围列应写明 0–9007199254740991（或 schema N＋运行 S 记号）` });
          }
        } else if (fact.boundClass === 'N') {
          if (rangeCell.includes('2147483647') || rangeCell.includes('9007199254740991')) {
            issues.push({ file: name, line: row.line, problem: `${key} schema 无显式上界，范围列不应出现具体上界` });
          }
          if (!/(^|[^A-Za-z0-9])N(?![A-Za-z0-9])|非负|non-negative|≥\s*0/.test(rangeCell)) {
            issues.push({ file: name, line: row.line, problem: `${key} 范围列应说明非负（N）` });
          }
        } else if (fact.numericRange) {
          const [lo, hi] = fact.numericRange;
          if (!(hasNumber(rangeCell, lo) && hasNumber(rangeCell, hi))) {
            issues.push({ file: name, line: row.line, problem: `${key} 范围列应写明 ${lo}–${hi}` });
          }
        }
        // 单位列：毫秒/字节字段必有单位字样。
        const unitCell = get('unit');
        if (fact.unit === 'ms' && !/(ms|毫秒)/i.test(unitCell)) {
          issues.push({ file: name, line: row.line, problem: `${key} 单位列应为 ms/毫秒` });
        }
        if (fact.unit === 'bytes' && !/(B|字节|byte)/i.test(unitCell)) {
          issues.push({ file: name, line: row.line, problem: `${key} 单位列应为 B/字节` });
        }
        // 零值或空值列：每字段必须在场非空（0 不能统一成无限，语义靠人工）。
        if (!get('zero') || get('zero') === '—') {
          issues.push({ file: name, line: row.line, problem: `${key} 零值或空值列为空` });
        }
        // 设置页列：可编辑字段写是（兼容映射行也是页面可编辑），非页面字段写否。
        const pageCell = get('page');
        if (fact.page && !/(是|✓|yes|true|兼容|compat|legacy)/i.test(pageCell)) {
          issues.push({ file: name, line: row.line, problem: `${key} 在设置页可编辑，设置页列应为「是」（或兼容行）` });
        }
        if (!fact.page && !/(否|无|—|-|no|false)/i.test(pageCell)) {
          issues.push({ file: name, line: row.line, problem: `${key} 不在设置页，设置页列应为「否」` });
        }
      }
    }
    for (const key of facts.keys()) {
      if (!seen.has(key)) issues.push({ file: name, line: 0, problem: `字段表缺少字段 ${key}` });
    }
    // 存储机制事实（真实导出常量）：轮转倍数（自然语义：四倍/four times 或数字式）与
    // 会话文件数上限必须在正文出现；倍数取自真实 LINE_CAP_FACTOR，写错倍数（如五倍）因
    // 无正确形式命中而报错。
    const trace = traceStoreFacts();
    const zhNums = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
    const enNums = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
    const f = trace.lineCapFactor;
    const zhWord = f < zhNums.length ? `${zhNums[f]}倍` : null;
    const enWord = f < enNums.length ? `${enNums[f]} times` : null;
    const capForms = [zhWord, enWord, `${trace.defaultMaxRecords}\\s*[×x*]\\s*${f}`, `[×x*]\\s*${f}\\b`, `${f}\\s*倍`, `\\b${f}\\s*[×x*]`].filter(Boolean);
    if (!new RegExp(capForms.join('|')).test(text)) {
      issues.push({ file: name, line: 0, problem: `正文应以自然语义说明单文件行数上限＝窗口的 ${zhWord ?? `${f} 倍`}（来自 trace-store 真实常量）` });
    }
    const sessionCap = new RegExp(`(会话文件|session file)[^\\n]{0,120}${trace.defaultMaxSessions}|${trace.defaultMaxSessions}[^\\n]{0,120}(会话文件|session file)`, 'i');
    if (!sessionCap.test(text)) {
      issues.push({ file: name, line: 0, problem: `正文应说明会话文件数上限 ${trace.defaultMaxSessions}（来自 trace-store 真实常量）` });
    }
  }
  return issues;
}

// ── 版本身份互核 ────────────────────────────────────────────────────────────

/** 键排序的稳定序列化（lock/包元数据与仓库声明比较用；内容相同、键序不同不算不一致）。 */
const stable = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? `{${Object.keys(value)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
        .join(',')}}`
    : JSON.stringify(value);

/**
 * 版本身份互核：version 的 +dsh. 后缀 == engines.dsh == 两枚宿主 peer；lock 根一致
 * （version 及在场元数据字段独立比）；两语首页分别写出完整版本串与独立宿主串；
 * 公开文档（CHANGELOG 历史按职责豁免）不残留其他 +dsh. 版本串或与 dsh 连写的错误宿主串。
 * @param {string} root
 * @param {object} [opts] skipLock：包目录无 lock 时跳过。
 * @returns {{file: string, line: number, problem: string}[]}
 */
export function checkVersionIdentity(root, opts = {}) {
  const issues = [];
  const pkgPath = path.join(root, 'package.json');
  if (!existsSync(pkgPath)) return [{ file: 'package.json', line: 0, problem: 'package.json 不存在' }];
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const versionMatch = /^(\d+\.\d+\.\d+)\+dsh\.(.+)$/.exec(pkg.version);
  if (!versionMatch) {
    issues.push({ file: 'package.json', line: 0, problem: `version 缺少 +dsh.<宿主> 后缀：${pkg.version}` });
    return issues;
  }
  const host = versionMatch[2];
  if (pkg.engines?.dsh !== host) {
    issues.push({ file: 'package.json', line: 0, problem: `engines.dsh (${pkg.engines?.dsh}) 与 version 后缀宿主 (${host}) 不一致` });
  }
  for (const name of ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-typert-protocol']) {
    if (pkg.peerDependencies?.[name] !== host) {
      issues.push({ file: 'package.json', line: 0, problem: `peerDependencies.${name} (${pkg.peerDependencies?.[name]}) 与宿主 ${host} 不一致` });
    }
  }
  if (!opts.skipLock) {
    const lockPath = path.join(root, 'package-lock.json');
    if (!existsSync(lockPath)) {
      issues.push({ file: 'package-lock.json', line: 0, problem: 'package-lock.json 不存在' });
    } else {
      const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
      // 两处版本分别比较，不能合并后让任一声明遮蔽另一处。
      const lockRoot = lock.packages?.[''] ?? {};
      for (const [label, value] of [['顶层', lock.version], ['packages[""]', lockRoot.version]]) {
        if (value !== pkg.version) issues.push({ file: 'package-lock.json', line: 0, problem: `lock 根 version ${label} (${value}) != ${pkg.version}` });
      }
      if (lock.name !== undefined && lock.name !== pkg.name) issues.push({ file: 'package-lock.json', line: 0, problem: 'lock 顶层 name 与 package.json 不一致' });
      for (const key of ['name', 'license', 'engines', 'dependencies', 'peerDependencies']) {
        if (stable(lockRoot[key]) !== stable(pkg[key])) {
          issues.push({ file: 'package-lock.json', line: 0, problem: `lock 根 ${key} 与 package.json 不一致` });
        }
      }
    }
  }
  for (const name of ['README.md', 'README.en.md']) {
    const full = path.join(root, name);
    if (!existsSync(full)) {
      issues.push({ file: name, line: 0, problem: '两语首页之一缺失：README 是随包公开资料，缺失即失败；从源码仓库或交付源码恢复后重查' });
      continue;
    }
    const text = readFileSync(full, 'utf8');
    if (!text.includes(pkg.version)) issues.push({ file: name, line: 0, problem: `首页缺少当前完整版本串 ${pkg.version}` });
    // 宿主串必须独立在场：去掉完整版本串后仍要能找到宿主版本（反引号内的宿主字面量同样算），
    // 防止只写包版本而宿主身份错误。
    const withoutVersion = text.split(pkg.version).join('');
    if (!withoutVersion.includes(host)) {
      issues.push({ file: name, line: 0, problem: `首页缺少独立的宿主版本串 ${host}（不能只由完整包版本串隐含）` });
    }
  }
  for (const doc of collectPublicDocs(root)) {
    const rel = path.relative(root, doc).replaceAll('\\', '/');
    if (rel === 'CHANGELOG.md') continue;
    // 当前身份常用行内代码；只去围栏示例，保留代码字面量中的版本。
    const rawText = readFileSync(doc, 'utf8').replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/gu, '').replace(/`/gu, '');
    // 配套的宿主—adapt分支对应关系是维护信息，不是当前安装身份声明。
    const text = rawText.replace(/(?:宿主|host)\s+(\d+\.\d+\.\d+-rc\.\d+)\s*(?:对应|corresponds to)\s+adapt\/dsh-\1/giu, '（宿主与分支对应关系）');
    for (const m of text.matchAll(/\d+\.\d+\.\d+\+dsh\.[0-9A-Za-z.+*-]+/g)) {
      if (m[0] !== pkg.version) issues.push({ file: rel, line: 0, problem: `文档中出现非当前包版本串 ${m[0]}` });
    }
    // 与 dsh 连写的宿主身份声明（如「dsh.0.2.1-rc.1」「宿主 0.2.0-rc.2」）不得偏离当前宿主。
    // 无预发布限定段的写法（如「DSH 0.2.1 起」）是底线/引入版本陈述，不是当前身份声明，不比。
    const hostShape = host.includes('-') ? '\\d+\\.\\d+\\.\\d+-rc\\.\\d+' : '\\d+\\.\\d+\\.\\d+';
    const hostRe = new RegExp(`(?:dsh\\.|dsh\\s|宿主\\s*|host\\s*)(${hostShape})`, 'gi');
    for (const m of text.matchAll(hostRe)) {
      if (m[1] !== host) issues.push({ file: rel, line: 0, problem: `文档中宿主身份 ${m[1]} 与当前宿主 ${host} 不一致（${m[0]}）` });
    }
  }
  return issues;
}

// ── 包内容检查（--package / --pack） ─────────────────────────────────────────

/** 包内必须在场的文件（真实 files 白名单 + 检查器要求随包在场的公开资料；LICENSES 目录须含具体许可文件）。 */
export const PACKAGE_REQUIRED = [
  'lib/index.js',
  'client.js',
  'typert.host.js',
  'cordis.patch.yml',
  'assets/tenant-policy.md',
  'assets/tenant-policy.zh.md',
  'README.md',
  'README.en.md',
  'CONTRIBUTING.md',
  'CHANGELOG.md',
  'LICENSE',
  'NOTICE',
  'LICENSES/',
  'docs/user-reference.md',
  'docs/user-reference.en.md',
  'docs/documentation-principles.md',
  'docs/verification.md',
  'docs/requirements.md',
  'docs/design.md',
];
/** 包内不得出现的内部目录。 */
const PACKAGE_FORBIDDEN_DIRS = ['node_modules', '.local', 'test', 'tools', '.github', 'scratch'];
/** 与仓库逐字节比（换行归一）的事实源模块：包检查的事实必须与源码独立一致。 */
const PACKAGE_MIRROR_FILES = ['lib/config.js', 'lib/policy.js', 'lib/trace-store.js'];

const normalizeEol = (text) => text.replaceAll('\r\n', '\n');

/** 递归列目录下全部文件（docs 随包核验用；不限扩展名，整目录带齐）。 */
function listFilesDeep(dir, prefix = '') {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFilesDeep(full, prefix ? `${prefix}/${name}` : name));
    else out.push(prefix ? `${prefix}/${name}` : name);
  }
  return out;
}

/**
 * 核对解包后的包目录：必在场文件、元数据独立比、事实源模块镜像、无内部目录/凭据形态、
 * 整个 docs（不限扩展名）带齐、包内文档相对链接与 fragment 有效、包内版本身份。
 * @param {string} pkgDir 解包出的 package 目录。
 * @param {string} repoRoot 仓库根（元数据与镜像的独立比较基准）。
 * @returns {{file: string, line: number, problem: string}[]}
 */
export function checkPackageContents(pkgDir, repoRoot) {
  const issues = [];
  for (const rel of PACKAGE_REQUIRED) {
    if (rel.endsWith('/')) {
      const entries = listFilesDeep(path.join(pkgDir, rel));
      if (entries.length === 0) issues.push({ file: rel, line: 0, problem: '包内目录为空或缺失（应含具体许可文件）' });
    } else if (!existsSync(path.join(pkgDir, rel))) {
      issues.push({ file: rel, line: 0, problem: '包内缺少必在场文件' });
    }
  }
  for (const name of PACKAGE_FORBIDDEN_DIRS) {
    if (existsSync(path.join(pkgDir, name))) issues.push({ file: name, line: 0, problem: '包内出现内部目录' });
  }
  const pkgMetaPath = path.join(pkgDir, 'package.json');
  if (existsSync(pkgMetaPath)) {
    const meta = JSON.parse(readFileSync(pkgMetaPath, 'utf8'));
    const repo = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    for (const key of ['name', 'version', 'description', 'license', 'main', 'engines', 'peerDependencies', 'dependencies', 'exports']) {
      if (stable(meta[key]) !== stable(repo[key])) {
        issues.push({ file: 'package.json', line: 0, problem: `包元数据字段 ${key} 与仓库声明不一致` });
      }
    }
    for (const entry of meta.files ?? []) {
      if (!existsSync(path.join(pkgDir, entry))) issues.push({ file: entry, line: 0, problem: 'files 白名单项在包内不存在' });
    }
  } else {
    issues.push({ file: 'package.json', line: 0, problem: '包内缺少 package.json' });
  }
  for (const rel of PACKAGE_MIRROR_FILES) {
    const inPkg = path.join(pkgDir, rel);
    const inRepo = path.join(repoRoot, rel);
    if (!existsSync(inPkg)) {
      issues.push({ file: rel, line: 0, problem: '包内缺少事实源模块（镜像比对）' });
      continue;
    }
    if (!existsSync(inRepo)) continue; // 仓库侧缺失是实现漂移，不归包检查报
    if (normalizeEol(readFileSync(inPkg, 'utf8')) !== normalizeEol(readFileSync(inRepo, 'utf8'))) {
      issues.push({ file: rel, line: 0, problem: '包内文件与仓库源码不一致（换行归一后比较）' });
    }
  }
  // 整个 docs 带齐（不限扩展名）。
  for (const rel of listFilesDeep(path.join(repoRoot, 'docs'))) {
    if (!existsSync(path.join(pkgDir, 'docs', rel))) {
      issues.push({ file: `docs/${rel.replaceAll('\\', '/')}`, line: 0, problem: 'docs 目录文件未随包分发' });
    }
  }
  // 凭据形态扫描（文档层；lib/ 与 assets/ 的规则源文本豁免）。
  const scanDir = (dir, prefix) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(full).isDirectory()) {
        scanDir(full, rel);
        continue;
      }
      if (!/\.md$/i.test(name) && name !== 'package.json') continue;
      if (rel.startsWith('lib/') || rel.startsWith('assets/')) continue;
      if (/sk-[A-Za-z0-9_-]{20,}/.test(readFileSync(full, 'utf8'))) {
        issues.push({ file: rel, line: 0, problem: '包内文档出现凭据形态（sk- 长 token）' });
      }
    }
  };
  scanDir(pkgDir, '');
  issues.push(...checkDocLinks(pkgDir, collectPublicDocs(pkgDir)));
  // 包内用户表必须与源码派生事实一致；文件在场和事实源镜像不能替代此检查。
  issues.push(...checkReferenceTables(pkgDir, configFieldFacts().fields));
  issues.push(...checkVersionIdentity(pkgDir, { skipLock: true }));
  return issues;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

/**
 * 真实打包检查：mkdtemp 本次唯一临时目录 → npm pack --ignore-scripts → 解包 → 检查 → 只清理自己。
 * spawn 层失败（工具/沙箱缺失）记 notExecuted（退出码 2）；npm/tar 实际执行但失败按构建失败报（退出码 1）。
 */
export function runPackCheck(repoRoot) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsafm-docs-pack-'));
  try {
    // 不经 cmd/shell 包装（受限环境下包装层可能拒绝派生），直接用当前 node 运行 npm-cli.js。
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const packRun = existsSync(npmCli)
      ? spawnSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--pack-destination', tmp], { cwd: repoRoot, encoding: 'utf8' })
      : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--ignore-scripts', '--pack-destination', tmp], { cwd: repoRoot, shell: true, encoding: 'utf8' });
    if (packRun.error) {
      return { notExecuted: `npm 无法启动（${packRun.error.code ?? ''} ${packRun.error.message}）`, issues: [] };
    }
    if (packRun.status !== 0) {
      return {
        notExecuted: undefined,
        issues: [{ file: '(npm pack)', line: 0, problem: `npm pack --ignore-scripts 构建失败（exit ${packRun.status}）：${(packRun.stderr || '').slice(0, 400)}` }],
      };
    }
    const tgz = readdirSync(tmp).find((name) => name.endsWith('.tgz'));
    if (!tgz) {
      return { notExecuted: undefined, issues: [{ file: '(npm pack)', line: 0, problem: 'npm pack 未产出 tgz' }] };
    }
    const tarRun = spawnSync('tar', ['-xzf', path.join(tmp, tgz), '-C', tmp], { encoding: 'utf8' });
    if (tarRun.error) {
      return { notExecuted: `tar 无法启动（${tarRun.error.code ?? ''} ${tarRun.error.message}）`, issues: [] };
    }
    if (tarRun.status !== 0) {
      return {
        notExecuted: undefined,
        issues: [{ file: '(tar)', line: 0, problem: `tar 解包失败（exit ${tarRun.status}）：${(tarRun.stderr || '').slice(0, 400)}` }],
      };
    }
    return { notExecuted: undefined, issues: checkPackageContents(path.join(tmp, 'package'), repoRoot) };
  } finally {
    rmSync(tmp, { recursive: true, force: true }); // 只清理本次 mkdtemp 的自有目录
  }
}

const printIssues = (issues) => {
  for (const issue of issues) console.error(`✗ ${issue.file}${issue.line ? `:${issue.line}` : ''} — ${issue.problem}`);
};

export function main(argv) {
  const args = argv.slice(2);
  // 参数校验：--pack 与 --package 互斥；未知参数拒绝。
  const hasPack = args.includes('--pack');
  const packageIndex = args.indexOf('--package');
  if (hasPack && packageIndex !== -1) {
    console.error('--pack 与 --package 互斥');
    return 2;
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--package') {
      if (i + 1 >= args.length) {
        console.error('--package 需要一个目录参数');
        return 2;
      }
      i++;
      continue;
    }
    if (args[i] !== '--pack') {
      console.error(`未知参数：${args[i]}`);
      return 2;
    }
  }
  const root = REPO_ROOT;
  if (hasPack) {
    const { notExecuted, issues } = runPackCheck(root);
    if (notExecuted) {
      console.error(`[未执行] ${notExecuted}`);
      return 2;
    }
    printIssues(issues);
    console.error(issues.length === 0 ? '包检查通过（真实 npm pack --ignore-scripts）' : `包检查发现 ${issues.length} 个问题`);
    return issues.length === 0 ? 0 : 1;
  }
  if (packageIndex !== -1) {
    const dir = args[packageIndex + 1];
    if (!existsSync(path.resolve(dir))) {
      console.error('--package 需要一个存在的解包目录');
      return 2;
    }
    const issues = checkPackageContents(path.resolve(dir), root);
    printIssues(issues);
    console.error(issues.length === 0 ? '包目录检查通过' : `包目录检查发现 ${issues.length} 个问题`);
    return issues.length === 0 ? 0 : 1;
  }
  const docs = collectPublicDocs(root);
  const issues = [...checkDocLinks(root, docs), ...checkReferenceTables(root, configFieldFacts().fields), ...checkVersionIdentity(root)];
  printIssues(issues);
  console.error(issues.length === 0 ? `静态文档检查通过（${docs.length} 个公开文档）` : `静态文档检查发现 ${issues.length} 个问题`);
  return issues.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv));
}
