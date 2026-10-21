/**
 * 边界检查器的变异用例：**种下违规必须报红**。
 *
 * 「检查器全绿」与「公开范围干净」是两件事。一个恒绿的检查器会让 CI 形同虚设，
 * 而这类失效是静默的——没有任何读数会提示你。本用例因此不去验「当前树干净」，
 * 而是逐条喂进**已知违规样本**，要求对应判据把它们抓出来；再喂进**已知合法样本**，
 * 要求它们不被误报（误报会逼着后来者放宽判据，那才是真正的失守路径）。
 *
 * 样本一律按片段拼装：本文件自己也在受检范围内，字面写出禁用形态会让它变成违规样本。
 * 规则表与样本成对增减：新增判据（如退役需求编号锚）必须同步补变异样本，
 * 「每条判据都能抓到自己的已知违规样本」会红在缺样本的判据上。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmTree } from './helpers/rm-tree.mjs';

import {
  EXEMPT,
  FINGERPRINTS,
  INTERNAL_REFS,
  auditExempt,
  checkStructure,
  runCheck,
  scanText,
} from '../tools/check-public-surface.mjs';

/** 反斜杠——拼装本机路径样本用，避免在源码里写出完整路径字面。 */
const BS = String.fromCharCode(92);
/** 片段拼接——与 BS/LOCAL_LINE 同因：避免本文件字面写出禁用形态。 */
const j = (...parts) => parts.join('');
/** 本机例外那一行（拼装，免得本文件自己被「源码直写本机侧字面」判据判红）。 */
const LOCAL_LINE = j('.', 'local/');

/** 每条判据一个已知违规样本：判据 id → 样本文本（可多行，一行一个形态）。 */
const VIOLATIONS = new Map([
  // 路径类判据的样本必须同时钉「尾分隔符形态」与「裸形态」（段符后直接行尾/标点/引号）——
  // 判据用负向前瞻而非要求尾分隔符，正是为了抓住裸形态；样本不钉住它，日后改回
  // 「要求尾分隔符」的写法不会有任何测试变红。
  ['dev-root', j('工作目录 ', 'D:', BS, 'P', BS, 'proj', '\n', '服务跑在 ', 'D:', BS, 'P', '，会话可能在别处\n', '根目录 "', 'D:', BS, BS, 'P', '" 或 "', 'D:/', 'P', '"')],
  ['user-home', j('profile 在 ', 'C:', BS, 'Users', BS, 'user', BS, '.dsh', '\n', '家目录 ', 'C:', BS, 'Users', BS, 'user')],
  ['host-install-dir', j('锚点树 ', 'dsh', '-service', BS, 'node_modules')],
  ['codex-checkout', j('行为蓝本 ', 'codex', '-build')],
  ['instance-verify', j('服务监听 127.0.0.1:', '381', '14')],
  ['instance-dev', j('开发实例 127.0.0.1:', '382', '00')],
  ['service-name', j('NSSM 服务名 ', 'dsh', '-web')],
  ['deploy-script', j('跑 tools/', 'deploy', '-', '381', '14', '.ps1')],
  ['hostname', j('主机名 DESKTOP', '-', '5MUG', 'FHQ')],
  ['ledger-md', j('事实依据引 ', 'facts', '.md', ' 的条目号')],
  ['codex-facts', j('见 ', 'codex', '-review-facts')],
  ['fact-id', j('该 seat 是 single（', 'F', '18', '）')],
  ['question-id', j('规则层 reason 见 ', 'Q', '4')],
  ['retired-req-id', j('判据见 R', '29', '；变体 R', '30', 'b 与 R', '32', '-3 也算')],
  ['process-doc', j('过程稿 ', 'impl', '-review-r55.md', ' 有记录')],
  ['shots', j('截图 ', 'docs', '/shots/38-x.png')],
  ['evidence', j('证据 ', 'docs', '/evidence/r55-x.txt')],
  ['scratch', j('工作区 ', '.', 'tmp/oss-scan.mjs')],
  ['deploy-log', j('部署记录 ', 'deploy', '-', '381', '14-r27.md')],
]);

test('变异：每条判据都能抓到自己的已知违规样本', () => {
  for (const rule of [...FINGERPRINTS, ...INTERNAL_REFS]) {
    const sample = VIOLATIONS.get(rule.id);
    assert.notEqual(sample, undefined, `判据 ${rule.id} 没有配变异样本——新判据必须带样本，否则它能否报警无人知晓`);
    const hits = scanText(sample, { file: 'sample.md' });
    const matched = hits.filter((h) => h.rule === rule.id);
    assert.ok(matched.length > 0, `判据 ${rule.id} 没抓到样本「${sample}」——检查器对该类违规失效`);
  }
});

test('变异：样本的判据覆盖完整（没有多余样本，也没有漏配样本）', () => {
  const known = new Set([...FINGERPRINTS, ...INTERNAL_REFS].map((r) => r.id));
  for (const id of VIOLATIONS.keys()) {
    assert.ok(known.has(id), `变异样本 ${id} 对应的判据已不存在——样本成了摆设，删掉它`);
  }
  assert.equal(VIOLATIONS.size, known.size, `判据数 ${known.size} 与样本数 ${VIOLATIONS.size} 不等`);
});

test('变异：路径类判据按形态计数——裸形态必须逐一命中', () => {
  // 只断「≥1 命中」钉不住裸形态：样本里常规形态（尾分隔符）总在那儿，判据若回退成
  // 「要求尾分隔符」的写法，裸形态全部漏检而套件照样绿。这里按形态精确计数把每一行
  // 形态都钉死——判据少抓一种形态（漏检）或样本多一行（计数过期）都必须红。
  const EXPECTED_FORMS = new Map([
    ['dev-root', 4], // 常规尾分隔符＋全角标点裸＋转义双反斜杠引号裸＋正斜杠引号裸
    ['user-home', 2], // 常规尾分隔符＋行尾裸
  ]);
  for (const [id, forms] of EXPECTED_FORMS) {
    const sample = VIOLATIONS.get(id);
    const hits = scanText(sample, { file: 'sample.md' }).filter((h) => h.rule === id);
    assert.equal(hits.length, forms, `判据 ${id} 应命中 ${forms} 种形态，实际 ${hits.length}——裸形态漏检或样本与计数漂移`);
  }
});

test('反例：合法形态不得误报（本机路径的邻居、小节引用、公开文档指针）', () => {
  const LEGAL = [
    j('安装到 ', 'D:', BS, 'Program Files', BS, 'node'), // 盘符相邻但目录名不是本机开发根
    j('主机 DESKTOP', '-', 'workstation'), // 有短横线但无数字，不是本机主机名形态
    j('编码 ', 'UTF', '-8', ' 与 ', 'ISO', '-8859-1'),
    j('见 §', '4.2', ' 判定口径'), // 小节引用合法；R 编号锚已退役，由变异样本钉住
    j('见 ', 'docs', '/requirements.md', ' 与 ', 'docs', '/design.md'), // 随仓公开的文档，合法
    'npm run check:public-surface',
    j('实例 URL 由配置给出，源码不写端口'),
  ];
  for (const sample of LEGAL) {
    const hits = scanText(sample, { file: 'legal.md' });
    assert.deepEqual(hits, [], `合法样本被误报：${sample} → ${JSON.stringify(hits)}（误报会逼着后来者放宽判据）`);
  }
});

test('变异：违规记录带得出文件、行号与列号（供人定位，而不是只报一个总数）', () => {
  const text = ['第一行正常', j('第二行有 ', 'F', '33', ' 标记'), '第三行正常'].join('\n');
  const hits = scanText(text, { file: 'locate.md' }).filter((h) => h.rule === 'fact-id');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2, '行号错位——报告指向的行不是真正违规的那一行');
  assert.equal(hits[0].file, 'locate.md');
  assert.ok(hits[0].column > 0, '列号缺失');
});

test('结构变异：`.gitignore` 少了本机例外那一条，结构判据必须报红', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsafm-surface-'));
  try {
    writeFileSync(join(root, '.gitignore'), `node_modules/\n`, 'utf8');
    const bad = checkStructure(root, []);
    assert.ok(
      bad.some((v) => v.label.includes(LOCAL_LINE)),
      '`.gitignore` 缺本机例外行时结构判据没红——本机例外失守不会被发现',
    );

    // 正向对照：补上那一条之后必须转绿，否则上面的红是恒红的假警报。
    writeFileSync(join(root, '.gitignore'), `${LOCAL_LINE}\nnode_modules/\n`, 'utf8');
    const good = checkStructure(root, []);
    assert.equal(good.length, 0, `补上例外行后仍有结构违规：${JSON.stringify(good)}`);
  } finally {
    rmTree(root);
  }
});

test('结构变异：源码直接写本机侧字面必须报红，配置加载器与判据自身豁免', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsafm-surface-'));
  try {
    writeFileSync(join(root, '.gitignore'), `${LOCAL_LINE}\n`, 'utf8');
    mkdirSync(join(root, 'tools'), { recursive: true });
    const literal = j('const p = "', '.', 'local/config.mjs', '";');
    writeFileSync(join(root, 'tools', 'rogue.mjs'), literal, 'utf8');
    const hits = checkStructure(root, ['tools/rogue.mjs']);
    assert.ok(hits.some((v) => v.file === 'tools/rogue.mjs'), '源码直写本机侧字面没被报出来');

    // 豁免件：配置加载器允许承载该字面（它是公开范围通向本机侧的唯一入口）。
    writeFileSync(join(root, 'tools', 'local-config.mjs'), literal, 'utf8');
    const exempt = checkStructure(root, ['tools/local-config.mjs']);
    assert.equal(exempt.length, 0, `配置加载器被误报：${JSON.stringify(exempt)}`);
  } finally {
    rmTree(root);
  }
});

test('变异：跟踪文件落进本机侧的路径必须报红', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsafm-surface-'));
  try {
    writeFileSync(join(root, '.gitignore'), `${LOCAL_LINE}\n`, 'utf8');
    const hits = checkStructure(root, [j('.', 'local/docs/facts', '.md')]);
    assert.ok(hits.some((v) => v.label.includes('本机侧')), '跟踪到本机侧的文件没被报出来');
  } finally {
    rmTree(root);
  }
});

test('变异：豁免件带着本机指纹还在公开层里时，「发布前待办」必须报出来', () => {
  // 防线的现行语义：被豁免文件若仍被 git 跟踪会随仓发布，命中不出现在主判据读数
  // ——豁免不能盖住泄漏。
  //
  // 因此这里**临时注入**一条豁免来测机制本身：
  // 否则机制会因为没有活条目而永远返回空，测试也就随之恒真。
  const root = mkdtempSync(join(tmpdir(), 'dsafm-surface-'));
  const probe = 'probe-exempt.md';
  try {
    writeFileSync(join(root, probe), j('部署在 ', 'D:', BS, 'P', BS, 'x'), 'utf8');
    EXEMPT.set(probe, { reason: '测试临时注入', audit: true });
    const pending = auditExempt(root);
    assert.equal(pending.length, 1, `应报出 1 件待办，实际 ${JSON.stringify(pending)}`);
    assert.equal(pending[0].file, probe);
    assert.ok(pending[0].hits > 0, '命中了本机指纹却没计入待办');

    // 正向对照：文件移出公开层后待办必须消失——否则这一段是恒红的假警报，很快会被无视。
    rmSync(join(root, probe));
    assert.deepEqual(auditExempt(root), [], '文件不在树里时待办仍在报');
  } finally {
    EXEMPT.delete(probe);
    rmTree(root);
  }
});

test('反例：判据自身的豁免不进待办（它的规则表就是那些正则源码，不是泄漏）', () => {
  const pending = auditExempt();
  const files = pending.map((p) => p.file);
  assert.equal(
    files.includes('tools/check-public-surface.mjs'),
    false,
    '判据自身被当成泄漏报了出来——定义性噪声会淹掉真待办',
  );
});

test('反例：临时工单归档后不得再被豁免（重新放回公开层必须硬红，而不是一段提示）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsafm-surface-'));
  try {
    writeFileSync(join(root, '.gitignore'), `${LOCAL_LINE}\n`, 'utf8');
    writeFileSync(join(root, 'OPENSOURCE-PREP.md'), j('部署在 ', 'D:', BS, 'P', BS, 'x'), 'utf8');
    const violations = runCheck(root).violations;
    const hits = violations.filter((v) => v.file === 'OPENSOURCE-PREP.md');
    assert.ok(hits.length > 0, '归档的临时工单被放回公开层却没报红——豁免撤销失效了');
    assert.equal(auditExempt(root).length, 0, '它已不在豁免清单里，不该出现在「发布前待办」中');
  } finally {
    rmTree(root);
  }
});

test('反例：锁文件 integrity 哈希值里的判据形态不报（生成数据，不是人写引用）', () => {
  // 哈希值按片段拼装：R 锚形态（含连字母，靠 base64 后的加号制造词边界）与五位数端口
  // 形态都藏在 integrity 值里。不归一化的话这两条都会命中——公开范围检查将随依赖重锁
  // 撞上不可预知的哈希形态而变红，且无法处置（哈希由包内容决定，改不了）。
  const root = mkdtempSync(join(tmpdir(), 'dsafm-surface-'));
  try {
    writeFileSync(join(root, '.gitignore'), `${LOCAL_LINE}\n`, 'utf8');
    const lock = [
      '{',
      '  "name": "x",',
      j('  "integrity": "sha512-R', '75r+GkYP+x', '381', '14ab=="'),
      '}',
    ].join('\n');
    writeFileSync(join(root, 'package-lock.json'), lock, 'utf8');
    const violations = runCheck(root).violations;
    assert.deepEqual(violations, [], `integrity 值内的生成形态被误报：${JSON.stringify(violations)}`);
  } finally {
    rmTree(root);
  }
});

test('变异：同一文件里 integrity 行之外的 R 锚照报（归一化不缩小判据范围）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsafm-surface-'));
  try {
    writeFileSync(join(root, '.gitignore'), `${LOCAL_LINE}\n`, 'utf8');
    const lock = [
      '{',
      j('  "//note": "判据见 R', '29，人写的引用必须照报"'),
      j('  "integrity": "sha512-R', '75r+GkYP=="'),
      '}',
    ].join('\n');
    writeFileSync(join(root, 'package-lock.json'), lock, 'utf8');
    const hits = runCheck(root).violations.filter((v) => v.rule === 'retired-req-id');
    assert.equal(hits.length, 1, `integrity 归一化后人写的 R 锚也不报了：${JSON.stringify(hits)}`);
    assert.equal(hits[0].line, 2, '行号应指向 integrity 行之外的那一行');
  } finally {
    rmTree(root);
  }
});
