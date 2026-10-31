import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  collectPublicDocs,
  checkDocLinks,
  extractLinks,
  collectFragments,
  configFieldFacts,
  parseClientFields,
  traceStoreFacts,
  checkReferenceTables,
  checkVersionIdentity,
  checkPackageContents,
  main,
} from '../tools/check-docs.mjs';
import { DEFAULT_REDACT_PATTERNS } from '../lib/policy.js';
import { createHash } from 'node:crypto';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const tmpRoot = () => mkdtempSync(path.join(os.tmpdir(), 'dsafm-docs-test-'));

/** 事实全部取真实实现：schema 树、读取路径边界集、client FIELDS＋专用控件＋兼容映射行、trace-store 常量。 */
const facts = configFieldFacts().fields;
const trace = traceStoreFacts();

// ── 事实派生自检（断言真实实现的已知不变量，不是自证期望表） ─────────────────

test('parseClientFields：client.js FIELDS 解析出 17 个真实字段路径（整串不拆字符）', () => {
  const clientSource = readFileSync(path.join(REPO_ROOT, 'client.js'), 'utf8');
  const paths = parseClientFields(clientSource);
  assert.equal(paths.length, 17, `FIELDS 应解析 17 项，实际 ${paths.length}`);
  for (const p of paths) assert.match(p, /^[a-zA-Z.]+$/, `字段路径应是整串点路径：${p}`);
  assert.ok(paths.includes('trigger.unknown'));
  assert.ok(paths.includes('denyPatterns'));
});

test('字段事实：schema 类型/默认值/范围档（T×5、N+S×3、温度区间）/生效档（A/B/C）/兼容映射行来自真实实现', () => {
  // 五个毫秒字段（schema max 2147483647）：T 档。
  for (const key of ['reviewer.timeoutMs', 'reviewer.toolTimeoutMs', 'human.timeoutMs', 'concurrency.queueTimeoutMs', 'breaker.cooldownMs']) {
    assert.equal(facts.get(key).boundClass, 'T', `${key} 应为 T 档`);
    assert.equal(facts.get(key).schemaType, 'number');
    assert.equal(facts.get(key).unit, 'ms');
  }
  // 读取路径另限安全整数的三个字段：N+S 档（schema 仍自然数）。
  for (const key of ['reviewer.maxTokens', 'reviewer.maxToolSteps', 'ui.injectMaxBytes']) {
    assert.equal(facts.get(key).boundClass, 'N+S', `${key} 应为 N+S 档`);
  }
  // 无显式上界的自然数：N 档；温度是 0–2 有限小数（非自然数档）。
  for (const key of ['context.maxEntries', 'ui.trace.maxRecords', 'breaker.windowSize']) {
    assert.equal(facts.get(key).boundClass, 'N', `${key} 应为 N 档`);
  }
  assert.deepEqual(facts.get('reviewer.temperature').numericRange, [0, 2]);
  assert.equal(facts.get('reviewer.temperature').boundClass, '');
  // schema 类型词。
  assert.equal(facts.get('enabled').schemaType, 'boolean');
  assert.equal(facts.get('mode').schemaType, 'enum');
  assert.deepEqual(facts.get('mode').enumValues, ['rules', 'off']);
  assert.equal(facts.get('tools').schemaType, 'array-string');
  assert.equal(facts.get('reviewer.byParentModel').schemaType, 'dict');
  assert.equal(facts.get('reviewer.model').schemaType, 'union');
  // 默认值来自 normalizeConfig 真算。
  assert.equal(facts.get('enabled').defaultJson, 'true');
  assert.equal(facts.get('mode').defaultJson, '"rules"');
  assert.equal(facts.get('tools').defaultJson, '[]');
  assert.equal(facts.get('trigger.presets').defaultJson, '["auto-approve"]');
  assert.equal(facts.get('reviewer.byParentModel').defaultJson, '{}');
  assert.equal(facts.get('ui.trace.maxRecords').defaultJson, '200');
  assert.equal(facts.get('context.redactPatterns').default.length, 6, '内置脱敏规则应为六条');
  assert.equal(facts.get('context.redactPatterns').default[0], DEFAULT_REDACT_PATTERNS[0]);
  // 生效档：A＝页面保存（volatile＋控件，含兼容映射行）；B＝宿主热更新且无控件；C＝重载。
  assert.equal(facts.get('mode').effective, 'A');
  assert.equal(facts.get('reviewer.toolTimeoutMs').effective, 'B', 'volatile 但无页面控件应为 B');
  assert.equal(facts.get('reviewer.temperature').effective, 'B');
  assert.equal(facts.get('context.maxTranscriptBytes').effective, 'C', '非 volatile 应为 C');
  assert.equal(facts.get('context.maxTranscriptBytes').page, false);
  // 兼容映射行：byParentModel 在页面映射控件内可编辑（client 真实写路径），生效 A。
  assert.equal(facts.get('reviewer.byParentModel').page, true, '兼容映射行应视为页面可编辑');
  assert.equal(facts.get('reviewer.byParentModel').effective, 'A');
  assert.equal(facts.get('reviewer.parentModelRules').page, true, '映射行是专用控件');
});

test('trace-store 常量：轮转倍数 4、窗口 200、会话文件 50 来自真实导出', () => {
  assert.equal(trace.lineCapFactor, 4);
  assert.equal(trace.defaultMaxRecords, 200);
  assert.equal(trace.defaultMaxSessions, 50);
});

// ── 用户参考表：正例由真实事实按定稿格式生成，反例逐项种错 ────────────────────

/** 生效图例（第3节式，远离字段表）与范围图例（第5节开头）；style 切换粗体/反引号等价排版。 */
const legendText = (style) => {
  const line = (letter, def) =>
    style === 'backtick' ? `- \`${letter}\`：${def}` : `- **${letter}**：${def}`;
  return [
    '## 3. 配置入口与生效时机',
    '',
    line('A', '页面保存。保存后无需重启，后续请求使用新值'),
    line('B', '宿主热更新。本包设置页没有该字段控件'),
    line('C', '宿主重载。普通配置变更需宿主重载插件后生效'),
    '',
    '## 5. 全部配置字段',
    '',
    line('N', '非负整数，配置定义没有另设数值上限'),
    line('S', '0 至 9007199254740991 的安全整数'),
    line('T', '0 至 2147483647 的整数，单位毫秒'),
    '',
  ].join('\n');
};

const typeCellOf = (fact) => {
  if (fact.schemaType === 'boolean') return 'boolean';
  if (fact.schemaType === 'enum') return 'string';
  if (fact.schemaType === 'string') return 'string';
  if (fact.schemaType === 'number') return fact.boundClass ? 'integer' : 'number';
  if (fact.schemaType === 'array-string') return 'string[]';
  if (fact.schemaType === 'array-object') return 'object[]';
  if (fact.schemaType === 'dict') return 'object';
  return 'string 或 ModelChoice';
};

const rangeCellOf = (fact, style = 'plain') => {
  const tick = (v) => (style === 'code' ? `\`${v}\`` : v);
  if (fact.schemaType === 'enum') return fact.enumValues.map(tick).join(' / ');
  if (fact.boundClass === 'T') return 'T';
  if (fact.boundClass === 'N+S') return 'schema N；运行 S';
  if (fact.boundClass === 'N') return 'N';
  if (fact.numericRange) return `[${fact.numericRange[0]},${fact.numericRange[1]}] 有限数`;
  return '—';
};

const effCellOf = (fact) => (fact.path === 'language.ui' ? 'A；下一次界面渲染' : fact.effective);

/**
 * 由真实事实生成一份完整正确的用户参考（正例基线，定稿格式）。
 * mutate 改单元格、drop 删行、redactDrop 删脱敏代码块第 n 行、style 切换等价排版。
 */
function buildReference(options = {}) {
  const isEn = options.lang === 'en';
  const header = isEn
    ? '| Field | Type | Default | Range | Unit | Zero or empty | Page | Effective |\n| --- | --- | --- | --- | --- | --- | --- | --- |'
    : '| 字段 | 类型 | 默认 | 范围 | 单位 | 零值或空值 | 设置页 | 生效 |\n| --- | --- | --- | --- | --- | --- | --- | --- |';
  const rows = [];
  for (const fact of facts.values()) {
    if (options.drop === fact.path) continue;
    let cells = [
      `\`${fact.path}\``,
      typeCellOf(fact),
      fact.path === 'context.redactPatterns' ? '六类默认规则' : `\`${fact.defaultJson}\``,
      rangeCellOf(fact, options.style === 'code-enum' ? 'code' : 'plain'),
      fact.unit === 'ms' ? 'ms' : fact.unit === 'bytes' ? 'UTF-8 字节' : '—',
      '见正文',
      fact.path === 'reviewer.byParentModel' ? '兼容行' : fact.page ? '是' : '否',
      effCellOf(fact),
    ];
    if (options.mutate) cells = options.mutate(cells, fact);
    rows.push(`| ${cells.join(' | ')} |`);
  }
  const redactLines = DEFAULT_REDACT_PATTERNS.filter((_, i) => i !== options.redactDrop);
  return [
    `# ${isEn ? 'User Reference' : '用户参考'}`,
    '',
    legendText(options.style === 'backtick' ? 'backtick' : 'bold'),
    header,
    ...rows,
    '',
    '## 记录与轮转',
    '',
    `单会话文件超过窗口${isEn ? ' four times' : '四倍'}时重写，只保留最近一个窗口。`,
    `会话文件${isEn ? ' session files at most ' : '最多 '}50${isEn ? '' : ' 个'}，固定值。`,
    '',
    '<a id="redaction-defaults"></a>',
    '',
    '```text',
    ...redactLines,
    '```',
    '',
  ].join('\n');
}

const writeReferencePair = (root, options) => {
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  writeFileSync(path.join(root, 'docs', 'user-reference.md'), buildReference(options), 'utf8');
  writeFileSync(path.join(root, 'docs', 'user-reference.en.md'), buildReference({ ...options, lang: 'en' }), 'utf8');
};

const expectIssue = (issues, substring) =>
  assert.ok(issues.some((i) => i.problem.includes(substring)), `应报「${substring}」，实际：${JSON.stringify(issues)}`);

const withPair = (options) => {
  const root = tmpRoot();
  try {
    writeReferencePair(root, options);
    return checkReferenceTables(root, facts);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test('正例：定稿格式两语表通过；等价排版（反引号图例、代码段枚举）同样通过', () => {
  assert.deepEqual(withPair(), []);
  assert.deepEqual(withPair({ style: 'backtick' }), []);
  assert.deepEqual(withPair({ style: 'code-enum' }), []);
});

test('反例：缺字段行 / 默认值错 / 类型词错（默认值保持正确）/ 生效档错植', () => {
  expectIssue(withPair({ drop: 'context.maxEntries' }), '缺少字段 context.maxEntries');
  expectIssue(
    withPair({ mutate: (c, f) => (f.path === 'reviewer.timeoutMs' ? ((c[2] = '`"90000"`'), c) : c) }),
    '默认值应为 90000',
  );
  // 默认值正确但类型词错植：integer 字段写成 string。
  expectIssue(
    withPair({ mutate: (c, f) => (f.path === 'human.timeoutMs' ? ((c[1] = 'string'), c) : c) }),
    '类型列应为',
  );
  expectIssue(
    withPair({ mutate: (c, f) => (f.path === 'enabled' ? ((c[1] = 'number'), c) : c) }),
    '类型列应为',
  );
  // 默认值正确但生效档错植：C 档字段写成 A。
  const effIssues = withPair({ mutate: (c, f) => (f.path === 'context.maxTranscriptBytes' ? ((c[7] = 'A'), c) : c) });
  expectIssue(effIssues, '生效列记号应为 C');
  expectIssue(effIssues, '不应使用 A');
});

test('反例：枚举缺值 / 枚举混入非法值 / 毫秒缺单位 / 零值列空 / language.ui 生效错档 / 兼容行入口错', () => {
  const cases = [
    [{ mutate: (c, f) => (f.path === 'mode' ? ((c[3] = 'rules'), c) : c) }, '范围列允许值集合'],
    [{ mutate: (c, f) => (f.path === 'mode' ? ((c[3] = 'rules / off / ask'), c) : c) }, '范围列允许值集合'],
    [{ mutate: (c, f) => (f.path === 'human.timeoutMs' ? ((c[4] = '—'), c) : c) }, '单位列应为 ms'],
    [{ mutate: (c, f) => (f.path === 'enabled' ? ((c[5] = ''), c) : c) }, '零值或空值列为空'],
    [{ mutate: (c, f) => (f.path === 'language.ui' ? ((c[7] = 'C'), c) : c) }, 'language.ui 生效列记号应为 A'],
    [{ mutate: (c, f) => (f.path === 'reviewer.byParentModel' ? ((c[6] = '否'), c) : c) }, '设置页列应为「是」'],
    [{ mutate: (c, f) => (f.path === 'mode' ? ((c[6] = '否'), c) : c) }, '设置页列应为「是」'],
    [{ mutate: (c, f) => (f.path === 'enabled' ? ((c[6] = '是'), c) : c) }, '设置页列应为「否」'],
    [{ redactDrop: 2 }, '逐行覆盖 6 条'],
    [{ mutate: (c, f) => (f.path === 'context.redactPatterns' ? ((c[2] = '`[]`'), c) : c) }, '六类默认规则'],
  ];
  for (const [options, keyword] of cases) expectIssue(withPair(options), keyword);
});

test('反例：范围档错值（T 写 N、数字缺独立 0 端点）/ 图例缺记号 / 轮转写错倍数 / 会话上限缺失', () => {
  expectIssue(
    withPair({ mutate: (c, f) => (f.path === 'reviewer.timeoutMs' ? ((c[3] = 'N'), c) : c) }),
    '范围列应写明 0–2147483647',
  );
  expectIssue(
    withPair({ mutate: (c, f) => (f.path === 'reviewer.timeoutMs' ? ((c[3] = '10–2147483647'), c) : c) }),
    '范围列应写明 0–2147483647',
  );
  expectIssue(
    withPair({ mutate: (c, f) => (f.path === 'reviewer.maxTokens' ? ((c[3] = 'N'), c) : c) }),
    '范围列应写明 0–9007199254740991',
  );
  // 图例缺 T 记号定义。
  const root = tmpRoot();
  try {
    writeReferencePair(root);
    for (const name of ['user-reference.md', 'user-reference.en.md']) {
      const full = path.join(root, 'docs', name);
      writeFileSync(full, readFileSync(full, 'utf8').replace('- **T**：0 至 2147483647 的整数，单位毫秒', ''), 'utf8');
    }
    expectIssue(checkReferenceTables(root, facts), 'T 的图例定义');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  // 轮转写错倍数（五倍/five times）：无正确形式命中即红。
  const root2 = tmpRoot();
  try {
    writeReferencePair(root2);
    for (const name of ['user-reference.md', 'user-reference.en.md']) {
      const full = path.join(root2, 'docs', name);
      writeFileSync(full, readFileSync(full, 'utf8').replace('四倍', '五倍').replace('four times', 'five times'), 'utf8');
    }
    expectIssue(checkReferenceTables(root2, facts), '单文件行数上限');
  } finally {
    rmSync(root2, { recursive: true, force: true });
  }
  // 会话文件上限缺失。
  const root3 = tmpRoot();
  try {
    writeReferencePair(root3);
    for (const name of ['user-reference.md', 'user-reference.en.md']) {
      const full = path.join(root3, 'docs', name);
      writeFileSync(full, readFileSync(full, 'utf8').replace(/会话文件.*/g, '').replace(/.*session files.*/g, ''), 'utf8');
    }
    expectIssue(checkReferenceTables(root3, facts), '会话文件数上限');
  } finally {
    rmSync(root3, { recursive: true, force: true });
  }
});

// ── 链接检查：相对文件、%20 编码、尖括号、显式锚点、Setext、fragment、逃逸与解码 ──

test('链接：正例（相对 / %20 / 尖括号 / 显式锚点 / Setext 标题 / 跨文件 fragment / 未暂存新文件）全过', () => {
  const root = tmpRoot();
  try {
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    writeFileSync(path.join(root, 'docs', 'target.md'), '# 目标\n\nSetext 标题\n===\n\n<a id="显式锚点"></a>\n', 'utf8');
    writeFileSync(path.join(root, 'docs', 'my file.md'), '# 文件名带空格\n', 'utf8');
    writeFileSync(path.join(root, 'docs', 'new-untracked.md'), '# 本轮新增未暂存\n', 'utf8');
    writeFileSync(
      path.join(root, 'README.md'),
      [
        '# 首页',
        '',
        '- [相对链接](docs/target.md)',
        '- [编码空格](<docs/my%20file.md>)',
        '- [尖括号包裹](<docs/my file.md>)',
        '- [显式锚点](#显式锚点) 与 [同文 Setext 片段](#setext-标题)',
        '- [跨文件片段](docs/target.md#setext-标题)',
        '- [新文件未暂存](docs/new-untracked.md)',
        '- 外部链接不核：[npm](https://www.npmjs.com/)',
        '',
        'Setext 标题',
        '===',
        '',
        '<a id="显式锚点"></a>',
        '',
        '[定义式]: docs/target.md',
        '见[定义式]与[定义式][ref]',
        '',
        '[ref]: docs/my%20file.md',
      ].join('\n'),
      'utf8',
    );
    assert.deepEqual(checkDocLinks(root, collectPublicDocs(root)), []);
    assert.ok(!collectFragments('```\n# 伪标题\n```\n').has('伪标题'), '围栏内的伪标题不应成为锚点');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('链接反例：断链 / 本文锚点缺失 / 目标锚点缺失 / 逃出根目录 / 编码损坏（报告而非崩溃）', () => {
  const root = tmpRoot();
  try {
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    writeFileSync(path.join(root, 'docs', 'target.md'), '# 目标\n', 'utf8');
    writeFileSync(
      path.join(root, 'README.md'),
      [
        '# 首页',
        '',
        '- [断链](docs/missing.md)',
        '- [本文缺锚](#不存在)',
        '- [目标缺锚](docs/target.md#不存在)',
        '- [逃逸](<../../../../etc/hosts>)',
        '- [坏编码](<docs/%E0%A4%A.md>)',
        '',
      ].join('\n'),
      'utf8',
    );
    const issues = checkDocLinks(root, collectPublicDocs(root));
    expectIssue(issues, '相对链接目标不存在');
    expectIssue(issues, '本文档不存在片段锚点');
    expectIssue(issues, '不存在片段锚点 #不存在');
    expectIssue(issues, '逃出检查根目录');
    expectIssue(issues, '编码无法解码');
    assert.equal(extractLinks('见 [a](<b c.md>) 与 [d](e%20f.md)').length, 2, '尖括号与 %20 形态都要抽出');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 版本身份互核 ─────────────────────────────────────────────────────────────

const VERSION_PKG = {
  name: 'x',
  version: '0.2.2+dsh.0.2.1-rc.2',
  license: 'MIT',
  engines: { node: '>=20', dsh: '0.2.1-rc.2' },
  peerDependencies: { '@deepseek-ai/cordis': '~4.0.4', '@deepseek-ai/dsh-llm': '0.2.1-rc.2', '@deepseek-ai/dsh-typert-protocol': '0.2.1-rc.2' },
};

/** 准入集合的枚举声明（design §1.3.1：三处同一集合的显式枚举形态）。 */
const UNION = '0.2.1-rc.1 || 0.2.1-rc.2 || 0.2.1-rc.3 || 0.2.1-rc.4 || 0.2.1-rc.5';
const VERSION_PKG_UNION = {
  ...VERSION_PKG,
  engines: { ...VERSION_PKG.engines, dsh: UNION },
  peerDependencies: { ...VERSION_PKG.peerDependencies, '@deepseek-ai/dsh-llm': UNION, '@deepseek-ai/dsh-typert-protocol': UNION },
};

/** 发布形态的包版本：线标识后缀，README 的独立标识不得后随 .数字（只是某个 rc.N 的前缀）。 */
const VERSION_PKG_RELEASE = { ...VERSION_PKG_UNION, version: '0.2.2+dsh.0.2.1-rc' };

const writeVersionFixture = (root, { pkg = VERSION_PKG, lock, readme } = {}) => {
  const identity = /\+dsh\.(.+)$/u.exec(pkg.version)?.[1] ?? null;
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
  // 兼容线标识独立在场（反引号内的字面量也算；默认随声明取集合内具体 RC）。
  const zh = readme?.zh ?? `# x\n\n版本 \`${pkg.version}\`；宿主 \`${identity ?? ''}\`。\n`;
  const en = readme?.en ?? `# x\n\nVersion \`${pkg.version}\`; host \`${identity ?? ''}\`.\n`;
  writeFileSync(path.join(root, 'README.md'), zh, 'utf8');
  writeFileSync(path.join(root, 'README.en.md'), en, 'utf8');
  const lockRoot = lock ?? {
    version: pkg.version,
    packages: { '': { name: pkg.name, version: pkg.version, license: pkg.license, engines: { dsh: pkg.engines.dsh, node: pkg.engines.node }, dependencies: pkg.dependencies, peerDependencies: pkg.peerDependencies } },
  };
  writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lockRoot), 'utf8');
};

test('版本身份：正例三处互核一致通过（lock engines 键序不同不算不一致；枚举声明与发布形态后缀同规则）', () => {
  const root = tmpRoot();
  try {
    writeVersionFixture(root);
    assert.deepEqual(checkVersionIdentity(root), []);
    writeVersionFixture(root, {
      lock: { version: VERSION_PKG.version, packages: { '': { ...VERSION_PKG, engines: { node: '>=20', dsh: '0.2.1-rc.2' } } } },
    });
    assert.deepEqual(checkVersionIdentity(root), []);
    // 枚举声明（三处同一集合）＋过渡后缀（集合内具体 RC）。
    writeVersionFixture(root, { pkg: VERSION_PKG_UNION });
    assert.deepEqual(checkVersionIdentity(root), []);
    // 枚举声明＋发布形态线标识后缀；README 独立标识不得后随 .数字。
    writeVersionFixture(root, {
      pkg: VERSION_PKG_RELEASE,
      readme: {
        zh: `# x\n\n版本 \`${VERSION_PKG_RELEASE.version}\`；兼容线 \`0.2.1-rc\`。\n`,
        en: `# x\n\nVersion \`${VERSION_PKG_RELEASE.version}\`; compat line \`0.2.1-rc\`.\n`,
      },
    });
    assert.deepEqual(checkVersionIdentity(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('版本身份反例：engines 错宿主 / peer 错版 / lock 根 version 与 name 不一致 / 首页缺独立标识 / 旧 +dsh 与错 rc 宿主身份', () => {
  const cases = [
    [(root) => writeVersionFixture(root, { pkg: { ...VERSION_PKG, engines: { ...VERSION_PKG.engines, dsh: '0.2.1-rc.1' } } }), 'engines.dsh'],
    [(root) => writeVersionFixture(root, { pkg: { ...VERSION_PKG, peerDependencies: { ...VERSION_PKG.peerDependencies, '@deepseek-ai/dsh-llm': '0.2.1-rc.1' } } }), 'dsh-llm'],
    [(root) => writeVersionFixture(root, { pkg: { ...VERSION_PKG_UNION, engines: { ...VERSION_PKG_UNION.engines, dsh: '>=0.2.1-rc.1' } } }), '含非精确版本段'],
    [(root) => writeVersionFixture(root, { pkg: { ...VERSION_PKG_UNION, engines: { ...VERSION_PKG_UNION.engines, dsh: '0.2.1-rc.1 || 0.2.2-rc.1' }, peerDependencies: { ...VERSION_PKG_UNION.peerDependencies, '@deepseek-ai/dsh-llm': '0.2.1-rc.1 || 0.2.2-rc.1', '@deepseek-ai/dsh-typert-protocol': '0.2.1-rc.1 || 0.2.2-rc.1' } } }), '不是单一 RC 线'],
    [(root) => writeVersionFixture(root, { pkg: { ...VERSION_PKG_UNION, version: '0.2.2+dsh.0.2.1-rc.6' } }), '不是合法兼容线标识'],
    [(root) => writeVersionFixture(root, { lock: { version: '0.2.1+dsh.0.2.0-rc.2', packages: { '': { version: '0.2.2+dsh.0.2.1-rc.2' } } } }), 'lock 根 version'],
    [(root) => writeVersionFixture(root, { lock: { version: VERSION_PKG.version, packages: { '': { name: 'other-name', version: VERSION_PKG.version } } } }), 'lock 根 name'],
    [(root) => writeVersionFixture(root, { lock: { version: VERSION_PKG.version, packages: { '': { ...VERSION_PKG, version: '0.0.0+dsh.0.2.1-rc.2' } } } }), 'lock 根 version packages'],
    [(root) => writeVersionFixture(root, { lock: { version: VERSION_PKG.version, packages: { '': { ...VERSION_PKG, dependencies: { wrong: '1.0.0' } } } } }), 'lock 根 dependencies'],
    [(root) => writeVersionFixture(root, { lock: { version: VERSION_PKG.version, packages: { '': { ...VERSION_PKG, peerDependencies: { ...VERSION_PKG.peerDependencies, '@deepseek-ai/dsh-llm': '0.2.1-rc.1' } } } } }), 'lock 根 peerDependencies'],
    [(root) => { writeVersionFixture(root); writeFileSync(path.join(root, 'CONTRIBUTING.md'), '当前宿主 `0.2.1-rc.1`。\n', 'utf8'); }, '宿主身份'],
    [(root) => { writeVersionFixture(root, { pkg: VERSION_PKG_UNION }); writeFileSync(path.join(root, 'CONTRIBUTING.md'), '需要 dsh 0.2.2-rc.1 或更高。\n', 'utf8'); }, '不在准入集合或兼容线标识内'],
    [(root) => { writeVersionFixture(root); writeFileSync(path.join(root, 'README.md'), '# x\n\n只有 `0.2.2+dsh.0.2.1-rc.2`，宿主不独立写。\n', 'utf8'); }, '独立兼容线标识'],
    // 发布形态后缀下，README 只出现 rc.N 字面量（线标识仅作其前缀）不算独立标识。
    [(root) => writeVersionFixture(root, {
      pkg: VERSION_PKG_RELEASE,
      readme: { zh: `# x\n\n版本 \`${VERSION_PKG_RELEASE.version}\`；宿主 \`0.2.1-rc.2\`。\n`, en: `# x\n\nVersion \`${VERSION_PKG_RELEASE.version}\`; host \`0.2.1-rc.2\`.\n` },
    }), '独立兼容线标识'],
    [(root) => { writeVersionFixture(root); writeFileSync(path.join(root, 'CONTRIBUTING.md'), '旧版本 0.2.1+dsh.0.2.0-rc.2。\n', 'utf8'); }, '非当前包版本串'],
    [(root) => { writeVersionFixture(root); writeFileSync(path.join(root, 'CONTRIBUTING.md'), '需要 dsh 0.2.1-rc.1 或更高。\n', 'utf8'); }, '宿主身份'],
  ];
  for (const [setup, keyword] of cases) {
    const root = tmpRoot();
    try {
      setup(root);
      expectIssue(checkVersionIdentity(root), keyword);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('版本身份：底线版本陈述（「DSH 0.2.1 起」无 rc 限定）不是当前身份声明，不报', () => {
  const root = tmpRoot();
  try {
    writeVersionFixture(root);
    writeFileSync(path.join(root, 'CONTRIBUTING.md'), 'DSH 0.2.1 起优先用 engines.dsh 做加载准入检查。\n宿主 `0.2.0-rc.2` 对应 `adapt/dsh-0.2.0-rc.2`。\n', 'utf8');
    assert.deepEqual(checkVersionIdentity(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 包内容检查 ───────────────────────────────────────────────────────────────

/** 造一个干净包目录：必在场文件齐、元数据=仓库声明、镜像文件=仓库源码、两语首页带当前身份。 */
function buildPackageFixture(repoRoot, { mutate } = {}) {
  const pkgDir = mkdtempSync(path.join(os.tmpdir(), 'dsafm-pkg-'));
  const repoPkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  for (const rel of ['lib', 'assets', 'docs', 'LICENSES']) mkdirSync(path.join(pkgDir, rel), { recursive: true });
  for (const rel of ['client.js', 'typert.host.js', 'cordis.patch.yml', 'LICENSE', 'NOTICE']) writeFileSync(path.join(pkgDir, rel), 'stub\n', 'utf8');
  for (const rel of ['lib/index.js', 'assets/tenant-policy.md', 'assets/tenant-policy.zh.md']) writeFileSync(path.join(pkgDir, rel), 'stub\n', 'utf8');
  for (const rel of ['lib/config.js', 'lib/policy.js', 'lib/trace-store.js']) copyFileSync(path.join(repoRoot, rel), path.join(pkgDir, rel));
  writeFileSync(path.join(pkgDir, 'LICENSES', 'Apache-2.0.txt'), 'Apache License\n', 'utf8');
  const compatibilityIdentity = /\+dsh\.(.+)$/u.exec(repoPkg.version)?.[1] ?? '';
  for (const rel of ['README.md', 'README.en.md']) {
    writeFileSync(path.join(pkgDir, rel), `# x\n\n\`${repoPkg.version}\`；兼容线 \`${compatibilityIdentity}\`；宿主 \`${repoPkg.engines.dsh}\`。\n`, 'utf8');
  }
  for (const rel of ['CONTRIBUTING.md', 'CHANGELOG.md', 'docs/documentation-principles.md', 'docs/verification.md', 'docs/requirements.md', 'docs/design.md']) {
    writeFileSync(path.join(pkgDir, rel), `# ${rel}\n`, 'utf8');
  }
  // 真实用户资料随独立包副本验证，不能用空标题假充配置表正例。
  for (const rel of ['docs/user-reference.md', 'docs/user-reference.en.md']) copyFileSync(path.join(repoRoot, rel), path.join(pkgDir, rel));
  const meta = { ...repoPkg };
  writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(meta, null, 2), 'utf8');
  mutate?.(pkgDir, meta);
  return pkgDir;
}

test('包内容：正例通过；反例（缺文件/空 LICENSES/错宿主元数据/包内断链/镜像缺文件与漂移/内部目录/凭据形态/docs 非 md 未随包）逐项报出', () => {
  const good = buildPackageFixture(REPO_ROOT);
  try {
    assert.deepEqual(checkPackageContents(good, REPO_ROOT), []);
  } finally {
    rmSync(good, { recursive: true, force: true });
  }
  const cases = [
    [(pkgDir) => rmSync(path.join(pkgDir, 'docs', 'verification.md')), '缺少必在场文件'],
    [(pkgDir) => rmSync(path.join(pkgDir, 'LICENSES', 'Apache-2.0.txt')), '包内目录为空'],
    [(pkgDir, meta) => writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ ...meta, engines: { ...meta.engines, dsh: '0.2.1-rc.1' } }), 'utf8'), 'engines'],
    [(pkgDir) => writeFileSync(path.join(pkgDir, 'README.md'), `# x\n\n[断链](docs/missing.md)\n`, 'utf8'), '相对链接目标不存在'],
    [(pkgDir) => rmSync(path.join(pkgDir, 'lib', 'trace-store.js')), '缺少事实源模块'],
    [(pkgDir) => writeFileSync(path.join(pkgDir, 'lib', 'config.js'), '// drifted\n', 'utf8'), '与仓库源码不一致'],
    [(pkgDir) => mkdirSync(path.join(pkgDir, 'tools')), '内部目录'],
    [(pkgDir) => writeFileSync(path.join(pkgDir, 'CONTRIBUTING.md'), 'token: sk-abcdefghijklmnopqrst\n', 'utf8'), '凭据形态'],
  ];
  for (const [mutate, keyword] of cases) {
    const pkgDir = buildPackageFixture(REPO_ROOT, { mutate });
    try {
      expectIssue(checkPackageContents(pkgDir, REPO_ROOT), keyword);
    } finally {
      rmSync(pkgDir, { recursive: true, force: true });
    }
  }
  // 源码比较根也必须自有：遗漏文件只写入 mkdtemp，不能覆盖真实仓库中的同名资料。
  const docsSnapshot = () => {
    const collect = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return collect(path.join(dir, entry.name), rel);
      if (entry.isSymbolicLink()) return [[rel, 'symlink']];
      return [[rel, createHash('sha256').update(readFileSync(path.join(dir, entry.name))).digest('hex')]];
    });
    return collect(path.join(REPO_ROOT, 'docs'));
  };
  const before = docsSnapshot();
  const comparisonRoot = tmpRoot();
  let pkgDir;
  try {
    for (const rel of ['lib', 'docs']) mkdirSync(path.join(comparisonRoot, rel), { recursive: true });
    for (const rel of ['package.json', 'lib/config.js', 'lib/policy.js', 'lib/trace-store.js', 'docs/user-reference.md', 'docs/user-reference.en.md']) {
      copyFileSync(path.join(REPO_ROOT, rel), path.join(comparisonRoot, rel));
    }
    pkgDir = buildPackageFixture(comparisonRoot);
    assert.deepEqual(checkPackageContents(pkgDir, comparisonRoot), [], '独立比较根初始应有效');
    writeFileSync(path.join(comparisonRoot, 'docs', 'extra.json'), '{}\n', 'utf8');
    expectIssue(checkPackageContents(pkgDir, comparisonRoot), '未随包分发');
  } finally {
    if (pkgDir) rmSync(pkgDir, { recursive: true, force: true });
    rmSync(comparisonRoot, { recursive: true, force: true });
    assert.deepEqual(docsSnapshot(), before, '反例前后真实仓库 docs 文件清单和内容哈希必须不变');
  }
});

test('包内配置表：真实资料副本的默认、类型、范围、单位、入口和生效漂移逐项检出', () => {
  const mutations = [
    [3, '`1`', '默认值'], [2, 'string[]', '类型列'], [4, 'N', '范围列'],
    [5, 's', '单位列'], [7, 'No', '设置页列'], [8, 'C', '生效列'],
  ];
  for (const name of ['docs/user-reference.md', 'docs/user-reference.en.md']) {
    for (const [column, wrongValue, keyword] of mutations) {
      const pkgDir = buildPackageFixture(REPO_ROOT);
      try {
        const file = path.join(pkgDir, name);
        const text = readFileSync(file, 'utf8');
        let changed = false;
        const mutated = text.split('\n').map((line) => {
          if (!/^\|\s*`reviewer\.timeoutMs`\s*\|/u.test(line)) return line;
          const cells = line.split('|');
          cells[column] = ` ${wrongValue} `;
          changed = true;
          return cells.join('|');
        }).join('\n');
        assert.equal(changed, true, '变异应定位真实逐字段表行');
        writeFileSync(file, mutated, 'utf8');
        expectIssue(checkPackageContents(pkgDir, REPO_ROOT), keyword);
      } finally { rmSync(pkgDir, { recursive: true, force: true }); }
    }
  }
});

test('CLI 退出码：--package 干净包 0、缺陷包 1；未知参数 2；--pack 与 --package 互斥 2；--package 缺参数 2', () => {
  const good = buildPackageFixture(REPO_ROOT);
  const bad = buildPackageFixture(REPO_ROOT, { mutate: (pkgDir) => rmSync(path.join(pkgDir, 'NOTICE')) });
  try {
    assert.equal(main(['node', 'tools/check-docs.mjs', '--package', good]), 0);
    assert.equal(main(['node', 'tools/check-docs.mjs', '--package', bad]), 1);
    assert.equal(main(['node', 'tools/check-docs.mjs', '--bogus']), 2);
    assert.equal(main(['node', 'tools/check-docs.mjs', '--pack', '--package', good]), 2);
    assert.equal(main(['node', 'tools/check-docs.mjs', '--package']), 2);
  } finally {
    rmSync(good, { recursive: true, force: true });
    rmSync(bad, { recursive: true, force: true });
  }
});
