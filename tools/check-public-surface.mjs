#!/usr/bin/env node
/**
 * 公开范围边界检查器（常驻，进 CI）。
 *
 * 本检查器限定本公开仓的内容范围：机器配置、过程材料与验证产物不由本公开仓跟踪。
 * 判据三类：
 *
 *   结构  —— `.gitignore` 里有且仅有 `.local/` 这一条本机例外；没有跟踪文件落在
 *            `.local/` 下；源码不经配置加载器就直接写 `.local/` 字面。
 *   指纹  —— 全部跟踪文本文件零命中本机指纹（开发根、用户目录、宿主安装目录、
 *            实例端口、服务名、主机名……）。
 *   引用  —— 全部跟踪文本文件零命中未随仓公开的内部引用（事实登记簿指针、
 *            事实/问题编号引用形态、过程稿文件名、证据与临时区指针）。
 *
 * 用法：
 *   node tools/check-public-surface.mjs              # 全绿退出 0，有违规退出 1
 *   node tools/check-public-surface.mjs --verbose    # 打印每条违规的全部命中
 *
 * 契约：只读，不修改任何文件；无网络；不依赖除 git 之外的任何外部命令
 * （git 不可用时退化为遍历文件系统，见 trackedFiles）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（本文件位于 tools/ 下）。 */
export const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * 本机指纹。命中即违规——这些串只会出现在本机环境，公开范围出现必是漏网。
 *
 * 各类变体都要覆盖：反斜杠原形、转义形态（`D:\\P`）、正斜杠形态（`D:/P`）。
 * 典型假阴性教训：只写 `D:\P` 会漏掉 `D:/P` 与 `D:\\P`。
 */
export const FINGERPRINTS = [
  { id: 'dev-root', label: '本机开发根', re: /D:[\\/]{1,4}P(?![A-Za-z0-9])/gu },
  { id: 'user-home', label: '本机用户目录', re: /C:[\\/]{1,4}Users[\\/]{1,4}user(?![A-Za-z0-9])/giu },
  { id: 'host-install-dir', label: '本机宿主安装目录', re: /dsh-service/gu },
  { id: 'codex-checkout', label: '本机 codex 检出', re: /codex-build/gu },
  { id: 'instance-verify', label: '验证实例端口', re: /(?<!\d)38114(?!\d)/gu },
  { id: 'instance-dev', label: '开发实例端口', re: /(?<!\d)38200(?!\d)/gu },
  { id: 'service-name', label: '本机服务名', re: /(?<![A-Za-z0-9-])dsh-web(?![A-Za-z0-9-])/gu },
  { id: 'deploy-script', label: '本机部署脚本', re: /deploy-38114/gu },
  // 主机名至少含一位数字：`DESKTOP-session` 这类普通英文组合不算指纹（曾误报）。
  { id: 'hostname', label: '本机主机名', re: /DESKTOP-(?=[A-Z0-9]*\d)[A-Z0-9]{4,}/giu },
];

/**
 * 未随仓公开的内部引用。公开范围必须自包含：所依赖的事实写在文档内部，不得把读者指向
 * 仓外的东西。**代码注释一并受检**——读者读 `lib/` 或 `client.js` 时同样解不开
 * 「事实编号」「问题编号」这类标记，它们和文档里的悬空引用是同一类毛病。
 */
export const INTERNAL_REFS = [
  { id: 'ledger-md', label: '事实登记簿指针', re: /facts\.md/gu },
  { id: 'codex-facts', label: 'codex 事实档指针', re: /codex-review-facts/gu },
  { id: 'fact-id', label: '事实编号引用', re: /\bF\d{1,3}(?:-\d+)?\b/gu },
  { id: 'question-id', label: '问题编号引用', re: /\bQ\d{1,3}\b/gu },
  {
    id: 'process-doc',
    label: '过程稿文件名',
    re: /(?:impl-review|design-review|doc-review|re-review|impl-corrections|acceptance-\d|handoff-dev|upgrade-0\.1\.7-discussion|terms-project|issues\.md)/gu,
  },
  { id: 'shots', label: '截图区指针', re: /docs[\\/]shots/gu },
  { id: 'evidence', label: '证据区指针', re: /docs[\\/]evidence/gu },
  { id: 'scratch', label: '临时工作区指针', re: /\.tmp[\\/]/gu },
  { id: 'deploy-log', label: '本机部署记录', re: /deploy-38114-r\d+/gu },
];

/**
 * 豁免清单。豁免是**逐文件具名**的，不按模式——模式豁免会悄悄放大到新文件上。
 *
 * `audit` 决定该文件是否进「发布前待办」段：判据自身按设计承载禁用形态（它的规则表就是
 * 那些正则源码），**不是**泄漏，故 `audit: false`。这个区分不是洁癖：把规则表与真泄漏
 * 混在一起报，真待办会被定义性噪声淹掉。
 *
 * 临时工单 `OPENSOURCE-PREP.md` 曾在此列（它完工前合法地躺在仓里）。现已归档进
 * `.local/docs/`，**豁免随之撤销**——留着豁免只会让「有人再把它放回公开层」变成静默通过；
 * 撤掉之后，它一旦重新出现就是 60 处直接判红，而不是一段可以忽略的提示。
 */
export const EXEMPT = new Map([
  ['tools/check-public-surface.mjs', { reason: '判据自身必然承载禁用形态（规则表即正则源码）', audit: false }],
]);

/** 允许出现 `.local/` 字面的源码：配置加载器、其示例，以及判据自身（文档注释要讲这条规则）。 */
export const LOCAL_LITERAL_ALLOWED = new Set([
  'tools/local-config.mjs',
  'tools/local-config.example.mjs',
  'tools/check-public-surface.mjs',
]);

/** 按扩展名判定为源码——`.local/` 字面检查只施加在源码上（文档需要描述这条规则）。 */
const CODE_EXT = /\.(?:mjs|cjs|js|ts|mts|cts|ya?ml|ps1|sh|json)$/iu;

/** 单文件扫描上限（字节）。超过只做路径级判据，不做内容判据。 */
const MAX_SCAN_BYTES = 4 * 1024 * 1024;

/**
 * 列出应当受检的文件（仓库相对路径，正斜杠）。
 *
 * 首选 `git ls-files`——它以「公开层（git 跟踪）」为准，正是本检查器的判据对象。
 * 本机 git 可能因目录属主与当前用户不一致而拒绝工作（`dubious ownership`），
 * 故失败时退一步带 `safe.directory=*` 重试（只影响这次只读列举）。
 * 两者都不可用时遍历文件系统（排除 .git/node_modules/.tmp 与 `.local*`）。
 *
 * **用哪条路径必须报出来**：两条路径的集合不完全相同（遍历会把「未跟踪且未被忽略」
 * 的文件也算进来），读数含义随之不同。本机实测 node 里 spawn git 会被沙箱拦（EPERM），
 * 因此本地跑常常走的是遍历回退——不报出来的话，「按公开层扫」这句话就无从核查。
 * @param {string} root - 仓库根。
 * @returns {{files: string[], source: string}} 相对路径列表与枚举路径说明。
 */
export function enumerateTracked(root = ROOT) {
  const parse = (buffer) => buffer.toString('utf8').split('\0').filter((s) => s.length > 0)
    .map((s) => s.split(sep).join('/'));
  const git = (args) => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  try {
    return { files: parse(git(['ls-files', '-z'])), source: 'git ls-files（公开层）' };
  } catch {
    try {
      return { files: parse(git(['-c', 'safe.directory=*', 'ls-files', '-z'])), source: 'git ls-files -c safe.directory=*（公开层）' };
    } catch {
      return { files: walk(root).sort(), source: '文件系统遍历（git 不可用；含未跟踪但未被忽略的文件）' };
    }
  }
}

/**
 * 受检文件列表。
 * @param {string} [root] - 仓库根。
 * @returns {string[]} 相对路径列表。
 */
export function trackedFiles(root = ROOT) {
  return enumerateTracked(root).files;
}

/**
 * 遍历目录（enumerateTracked 的回退路径）。
 *
 * 跳过 `.local` **及其一切变体**（`.local.bak` 之类）：本机侧是唯一例外目录，
 * 它的临时改名不该把整片本机内容灌进受检范围——实测踩过：改名演练时检查器把
 * `.local.bak` 当成公开范围扫，报出 11k 处「违规」。
 */
function walk(root, dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if ((entry.isDirectory() && (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.local'))) || SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(root, full, out);
    else if (entry.isFile()) out.push(relative(root, full).split(sep).join('/'));
  }
  return out;
}

/** 遍历时跳过的目录名。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.tmp']);

/**
 * 读文本文件；二进制或过大时返回 undefined。
 * @param {string} full - 绝对路径。
 * @returns {string|undefined} 文本内容。
 */
function readText(full) {
  try {
    const stat = statSync(full);
    if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) return undefined;
    const buffer = readFileSync(full);
    if (buffer.includes(0)) return undefined;
    return buffer.toString('utf8');
  } catch {
    return undefined;
  }
}

/**
 * 扫描一段文本，返回命中的违规。
 *
 * 导出以便变异用例直接调用（见 test/public-surface.test.mjs）：种下指纹或内部引用，
 * 本函数必须报出来——「检查器恒绿」与「公开范围干净」是两件事，必须能区分。
 * @param {string} text - 待扫文本。
 * @param {object} [options] - 选项。
 * @param {string} [options.file] - 相对路径（写进违规记录）。
 * @param {boolean} [options.skipReferences] - 跳过内部引用判据（结构检查用）。
 * @returns {Array<{rule: string, label: string, file: string, line: number, column: number, match: string}>} 违规列表。
 */
export function scanText(text, options = {}) {
  const file = options.file ?? '<text>';
  const violations = [];
  const lines = text.split(/\r?\n/);
  const rules = [...FINGERPRINTS, ...(options.skipReferences === true ? [] : INTERNAL_REFS)];
  for (const rule of rules) {
    for (let index = 0; index < lines.length; index++) {
      const re = new RegExp(rule.re.source, rule.re.flags);
      let hit;
      while ((hit = re.exec(lines[index])) !== null) {
        violations.push({
          rule: rule.id,
          label: rule.label,
          file,
          line: index + 1,
          column: hit.index + 1,
          match: hit[0].slice(0, 60),
        });
        if (hit.index === re.lastIndex) re.lastIndex++;
      }
    }
  }
  return violations;
}

/**
 * 结构判据。与内容无关，只看仓库形状。
 * @param {string} root - 仓库根。
 * @param {string[]} files - 跟踪文件列表。
 * @returns {Array<{rule: string, label: string, file: string, line: number, column: number, match: string}>} 违规列表。
 */
export function checkStructure(root, files) {
  const violations = [];
  const push = (label, file, match) => violations.push({
    rule: 'structure', label, file, line: 0, column: 0, match,
  });

  let gitignore;
  try {
    gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
  } catch {
    gitignore = undefined;
  }
  if (gitignore === undefined) {
    push('缺少 .gitignore', '.gitignore', '');
  } else if (!gitignore.split(/\r?\n/).some((line) => line.trim() === '.local/')) {
    push('.gitignore 缺少 .local/ 这一条本机例外', '.gitignore', '');
  }

  for (const file of files) {
    if (file.startsWith('.local/')) push('跟踪文件落进本机侧', file, '');
    if (!CODE_EXT.test(file) || LOCAL_LITERAL_ALLOWED.has(file)) continue;
    const text = readText(join(root, file));
    if (text === undefined) continue;
    for (const line of text.split(/\r?\n/)) {
      if (line.includes('.local/')) {
        push('源码直接写 .local/ 字面（应经 tools/local-config.mjs 取配置）', file, line.trim().slice(0, 60));
        break;
      }
    }
  }
  return violations;
}

/**
 * 全量检查。
 * @param {string} [root] - 仓库根。
 * @returns {{files: number, scanned: number, violations: object[]}} 结果。
 */
export function runCheck(root = ROOT) {
  const { files, source } = enumerateTracked(root);
  const violations = checkStructure(root, files);
  let scanned = 0;
  for (const file of files) {
    if (EXEMPT.has(file)) continue;
    const text = readText(join(root, file));
    if (text === undefined) continue;
    scanned++;
    violations.push(...scanText(text, { file }));
  }
  return { files: files.length, scanned, source, violations };
}

/**
 * 豁免件的「发布前待办」审计。
 *
 * 豁免的本意是让判据对准**发布范围**（临时工单在完工前合法地躺在仓里，不该让整条判据变红）。
 * 但豁免有个危险副作用：**被豁免的文件只要还被 git 跟踪，就会随仓发布**——豁免于是成了
 * 一颗盖住泄漏的盖子。实测踩到过：`OPENSOURCE-PREP.md`（临时工单）被豁免，而它当时是被
 * 跟踪的，正文里带着 60 处命中、其中 12 处是本机指纹（开发根、用户目录、宿主安装目录、
 * 两个实例端口、服务名、部署脚本名）——按原实现，这些永远不会出现在任何读数里。
 *
 * 所以豁免件每次运行都要把命中数报出来，且**与主判据分开陈述**：主判据说的是「发布范围干净」，
 * 这一段说的是「发布范围之外还躺着什么」。文件已移出公开层（读不到）＝待办已清。
 * @param {string} root - 仓库根。
 * @returns {Array<{file: string, reason: string, hits: number}>} 待办列表。
 */
export function auditExempt(root = ROOT) {
  const pending = [];
  for (const [file, entry] of EXEMPT) {
    if (entry.audit !== true) continue;
    const text = readText(join(root, file));
    if (text === undefined) continue;
    const hits = scanText(text, { file }).length;
    if (hits > 0) pending.push({ file, reason: entry.reason, hits });
  }
  return pending;
}

/** CLI 入口。 */
function main() {
  const verbose = process.argv.includes('--verbose');
  const result = runCheck(ROOT);
  const pending = auditExempt(ROOT);
  const byRule = new Map();
  for (const violation of result.violations) {
    const key = `${violation.rule}\u0000${violation.label}`;
    if (!byRule.has(key)) byRule.set(key, []);
    byRule.get(key).push(violation);
  }

  console.log(`公开范围边界检查：受检文件 ${result.files} 个（扫描内容 ${result.scanned} 个），豁免 ${EXEMPT.size} 个`);
  console.log(`文件枚举：${result.source}`);
  for (const [file, entry] of EXEMPT) console.log(`  豁免：${file} —— ${entry.reason}`);
  if (result.violations.length === 0) {
    console.log('全绿：结构判据通过；本机指纹零命中；内部引用零命中。');
  } else {
    console.log(`违规 ${result.violations.length} 处，分布在 ${byRule.size} 条判据上：\n`);
    for (const [key, hits] of [...byRule].sort((a, b) => b[1].length - a[1].length)) {
      const [rule, label] = key.split('\u0000');
      console.log(`[${rule}] ${label} —— ${hits.length} 处`);
      for (const hit of verbose ? hits : hits.slice(0, 5)) {
        const where = hit.line > 0 ? `${hit.file}:${hit.line}:${hit.column}` : hit.file;
        console.log(`    ${where}  ${hit.match}`);
      }
      if (!verbose && hits.length > 5) console.log(`    …另有 ${hits.length - 5} 处（--verbose 看全）`);
    }
  }

  // 发布前待办：豁免件仍在公开层里就一定会随仓发布。这一段的读数**不参与退出码**——
  // 它说的是另一件事（发布范围之外还躺着什么），混进主判据会让「发布范围干净」这句话失焦。
  if (pending.length > 0) {
    console.log('\n⚠ 发布前待办：以下豁免件仍在公开层内，发布时会随仓一起公开——');
    for (const item of pending) {
      console.log(`  ${item.file}：${item.hits} 处命中（豁免理由：${item.reason}）`);
    }
    console.log('  处置：发布前先判断材料去留并核验所属仓；需保留的当前内容先核实已留痕，再移出本公开仓或删除，最后重跑本检查确认本段消失。');
  }
  return result.violations.length === 0 ? 0 : 1;
}

// 相对路径比较（不经 URL 拼接）：Windows 上 `file://D:/…` 会被解析成 host 段，
// 与 import.meta.url 的 `file:///D:/…` 不相等，直接跑会静默什么都不做。
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
