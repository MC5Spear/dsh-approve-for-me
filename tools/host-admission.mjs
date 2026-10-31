/**
 * 宿主准入声明的共享归一模块（design §10.4）。
 *
 * 准入集合只允许「|| 连接的精确版本」这一种声明形态：engines.dsh 与两条宿主 peer
 * 三处各自归一后必须是同一集合。守卫（test/host-tree.test.mjs）、文档检查器
 * （tools/check-docs.mjs）与 CI 矩阵生成（.github/workflows/ci.yml）都从本模块取
 * 集合，不在各自实现里重写解析。宿主侧的加载准入由 dsh-app-boot 执行（design §1.3.1），
 * 本模块只做声明归一与判定，不接触实体解析。
 *
 * CLI：`node tools/host-admission.mjs --list` 输出准入集合成员（空格分隔），供 CI
 * 动态矩阵取值；声明不可解析或三处不一致时打印错误并以非零退出，不输出缺省清单。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 三处声明位置：engines.dsh 与两条宿主 peer，报错时用位置名定位。 */
export const ADMISSION_SOURCES = [
  { key: 'engines.dsh', read: (pkg) => pkg?.engines?.dsh },
  { key: 'peerDependencies.@deepseek-ai/dsh-llm', read: (pkg) => pkg?.peerDependencies?.['@deepseek-ai/dsh-llm'] },
  { key: 'peerDependencies.@deepseek-ai/dsh-typert-protocol', read: (pkg) => pkg?.peerDependencies?.['@deepseek-ai/dsh-typert-protocol'] },
];

/**
 * 严格 semver 精确形：`X.Y.Z` 或 `X.Y.Z-预发布`。无前导 v、无操作符与范围、
 * 无构建元数据段；数字标识符（主三段与预发布段内的纯数字段）不得带前导零，
 * 含字母或连字符的标识符不受前导零限制（与 semver 字面规则一致）。
 */
const NUMERIC = '(?:0|[1-9]\\d*)';
const PRERELEASE_SEGMENT = `(?:${NUMERIC}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`;
const EXACT_VERSION = new RegExp(`^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}(?:-${PRERELEASE_SEGMENT}(?:\\.${PRERELEASE_SEGMENT})*)?$`, 'u');

/**
 * 归一处声明。
 * @param {unknown} value 声明原文（须为字符串）。
 * @param {string} label 声明位置名，用于报错。
 * @returns {{ok: true, versions: string[]}} 去重后的版本清单（保持出现顺序）；
 *   成员按字面量比较，不折叠大小写。
 * @returns {{ok: false, error: string}} 声明缺席或含非法段。
 */
export function normalizeDeclaration(value, label) {
  if (typeof value !== 'string') return { ok: false, error: `${label} 未声明任何版本` };
  const seen = new Set();
  for (const raw of value.split('||')) {
    const segment = raw.trim();
    if (!EXACT_VERSION.test(segment)) {
      return { ok: false, error: `${label} 含非精确版本段「${segment}」：准入声明只能用 || 连接的精确版本` };
    }
    seen.add(segment);
  }
  return { ok: true, versions: [...seen] };
}

/**
 * 从 package.json 读准入集合：三处声明逐一归一后必须相等（不取并集——并集会
 * 遮蔽声明间的不一致）。
 * @param {object} pkg 已解析的 package.json。
 * @returns {{ok: true, members: string[]}} 三处一致的集合成员（排序后，便于报错与矩阵稳定）。
 * @returns {{ok: false, errors: string[]}} 任一处归一失败或三处不一致。
 */
export function admissionFromPackage(pkg) {
  const sets = [];
  for (const source of ADMISSION_SOURCES) {
    const result = normalizeDeclaration(source.read(pkg), source.key);
    if (!result.ok) return { ok: false, errors: [result.error] };
    sets.push({ key: source.key, versions: result.versions });
  }
  const errors = [];
  for (let i = 1; i < sets.length; i += 1) {
    const a = sets[0];
    const b = sets[i];
    const onlyInA = a.versions.filter((v) => !b.versions.includes(v));
    const onlyInB = b.versions.filter((v) => !a.versions.includes(v));
    if (onlyInA.length > 0 || onlyInB.length > 0) {
      const diff = [...onlyInA.map((v) => `仅 ${a.key} 有 ${v}`), ...onlyInB.map((v) => `仅 ${b.key} 有 ${v}`)].join('、');
      errors.push(`${a.key} 与 ${b.key} 归一后的准入集合不一致：${diff}`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, members: [...new Set(sets[0].versions)].sort() };
}

/**
 * 读仓库根 package.json 并解析准入集合。
 * @param {string} [root] 仓库根目录；默认本文件所在仓库根。
 * @returns 同 {@link admissionFromPackage}。
 */
export function loadAdmission(root) {
  const base = root ?? new URL('..', import.meta.url);
  const pkg = JSON.parse(readFileSync(new URL('package.json', base), 'utf8'));
  return admissionFromPackage(pkg);
}

/**
 * 导出兼容线主版本（design §9.3）：集合成员须全形如 `X.Y.Z-rc.N` 且主三段一致。
 * @param {string[]} members 准入集合成员。
 * @returns {{ok: true, line: string}} 线主版本（如 `0.2.1`）。
 * @returns {{ok: false, error: string}} 不是单一 RC 线（混线、混通道或缺预发布段）。
 */
export function deriveLine(members) {
  const shapes = members.map((m) => /^(\d+\.\d+\.\d+)-rc\.(0|[1-9]\d*)$/u.exec(m));
  if (shapes.some((s) => s === null)) {
    return { ok: false, error: `准入集合不是单一 RC 线：${members.join('、')}` };
  }
  const lines = new Set(shapes.map((s) => s[1]));
  if (lines.size !== 1) {
    return { ok: false, error: `准入集合不是单一 RC 线：${members.join('、')}` };
  }
  return { ok: true, line: [...lines][0] };
}

/**
 * 精确枚举声明的匹配判定：版本是否被集合准入。枚举集合在宿主
 * （includePrerelease:true）与 npm 默认两种 semver 语义下都只按字面成员匹配，
 * 因此成员等值即是判定，不需要引入范围解析。
 * @param {string[]} members 准入集合成员。
 * @param {string} version 待判定的候选版本。
 * @returns {boolean}
 */
export function admits(members, version) {
  return members.includes(version);
}

// ── CLI：CI 矩阵取值入口 ───────────────────────────────────────────
if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = loadAdmission();
  if (!result.ok) {
    console.error(result.errors.join('\n'));
    process.exit(1);
  }
  if (process.argv.includes('--list')) {
    console.log(result.members.join(' '));
  } else if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result));
  } else {
    console.log(`准入集合：${result.members.join(' ')}`);
  }
}
