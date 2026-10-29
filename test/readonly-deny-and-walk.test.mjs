import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadonlyTools } from '../lib/readonly-tools.js';

/**
 * 只读工具的名称拒止双形态与 grep 遍历预算说明的回归测试。
 *
 * 名称拒止：字面与真实路径任一含敏感名即拒止——联结点把敏感字面指向普通名目录、
 * 或普通字面指向敏感目录，两个方向都必须拒止；双普通联结点保持可读。
 * 遍历预算：目录数预算耗尽时 grep 必须声明搜索不完整，空结果不得被读成完整无匹配。
 *
 * 样本纪律：全部自造合成文本；联结点一律经 node:fs/promises 的 symlink 异步创建——
 * 主持者环境实测（Windows）：同步 symlinkSync 会被物化成真实目录拷贝，构造不出活
 * 联结点；断言按工具行为，不按链接类型断言（同环境实测：lstat 对活联结点报目录，
 * 非 Node 契约行为）；清理先卸链接本体再删样本根。
 */

const WALK_LIMIT = '(results may be incomplete: traversal cap reached)';
const TRUNCATED_200 = '(candidate list truncated at 200 files)';
const TRUNCATED_2000 = '(candidate list truncated at 2000 files)';
const FIRST_3 = '(showing first 3 matches only)';
const NEEDLE = 'SYNTHETIC_R5_NEEDLE';
const ABSENT = 'SYNTHETIC_R5_ABSENT';

/** 建样本根与配套工具集；DSH 数据根注入样本根内，不依赖也不触碰真实 home。 */
async function makeToolkit(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const auditRows = [];
  const tools = createReadonlyTools({
    rootDir: root,
    lang: 'en',
    timeoutMs: 30000,
    dshHomeOf: () => join(root, 'fake-home'),
    audit: (fields) => auditRows.push(fields),
  });
  return { root, tools, auditRows };
}

/** 联结点创建（异步 API；Windows 用 junction 形态，不需要特权）。 */
function linkTo(target, path) {
  return symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');
}

/** 卸一个联结点：只作用于链接本体、不触目标；rmdir 失败时退回 rm。 */
async function removeLink(path) {
  try {
    await rmdir(path);
  } catch {
    await rm(path, { force: true }).catch(() => {});
  }
}

/** 清理样本根：先卸全部联结点，再递归删根；不设链接类型守卫。 */
async function cleanup(root, ...links) {
  for (const item of links) await removeLink(item);
  await rm(root, { recursive: true, force: true });
}

test('敏感字面经联结点指向普通名目录仍拒止（字面形态命中）', async () => {
  const { root, tools, auditRows } = await makeToolkit('dsafm-deny-literal-');
  const relocated = join(root, 'relocated');
  const alias = join(root, '.ssh');
  try {
    await mkdir(relocated);
    await writeFile(join(relocated, 'config'), 'SYNTHETIC_CREDENTIAL_ALIASED');
    await linkTo(relocated, alias);
    const result = await tools.run('read_file', { path: join(alias, 'config') });
    assert.equal(result.denied, true);
    assert.ok(!result.text.includes('SYNTHETIC_CREDENTIAL_ALIASED'));
    const row = auditRows.find((item) => item.tool === 'read_file');
    assert.ok(row.reason.includes('deny=literal'));
    assert.ok(row.reason.includes('directory .ssh'));
  } finally {
    await cleanup(root, alias);
  }
});

test('普通字面经联结点指向敏感目录仍拒止（真实形态命中）', async () => {
  const { root, tools, auditRows } = await makeToolkit('dsafm-deny-real-');
  const realDir = join(root, '.ssh');
  const alias = join(root, 'alias');
  try {
    await mkdir(realDir);
    await writeFile(join(realDir, 'config'), 'SYNTHETIC_CREDENTIAL_REALFORM');
    await linkTo(realDir, alias);
    const result = await tools.run('read_file', { path: join(alias, 'config') });
    assert.equal(result.denied, true);
    assert.ok(!result.text.includes('SYNTHETIC_CREDENTIAL_REALFORM'));
    const row = auditRows.find((item) => item.tool === 'read_file');
    assert.ok(row.reason.includes('deny=real'));
  } finally {
    await cleanup(root, alias);
  }
});

test('双普通联结点正例保持可读', async () => {
  const { root, tools } = await makeToolkit('dsafm-deny-plain-');
  const docs = join(root, 'real-docs');
  const alias = join(root, 'docs-link');
  try {
    await mkdir(docs);
    await writeFile(join(docs, 'readme.txt'), 'SYNTHETIC_PLAIN_README');
    await linkTo(docs, alias);
    const result = await tools.run('read_file', { path: join(alias, 'readme.txt') });
    assert.equal(result.denied, false);
    assert.equal(result.isError, false);
    assert.ok(result.text.includes('SYNTHETIC_PLAIN_README'));
  } finally {
    await cleanup(root, alias);
  }
});

test('DSH 数据根围栏：字面形态命中', async () => {
  const { root, tools, auditRows } = await makeToolkit('dsafm-fence-literal-');
  try {
    await mkdir(join(root, 'fake-home'));
    const result = await tools.run('read_file', { path: join(root, 'fake-home', 'sessions', 'x') });
    assert.equal(result.denied, true);
    const row = auditRows.find((item) => item.tool === 'read_file');
    assert.ok(row.reason.includes('deny=dsh-home'));
  } finally {
    await cleanup(root);
  }
});

test('DSH 数据根围栏：真实形态命中（联结点进入，真实路径落物理根内）', async () => {
  const { root, tools, auditRows } = await makeToolkit('dsafm-fence-alias-');
  const home = join(root, 'fake-home');
  const alias = join(root, 'home-link');
  try {
    await mkdir(join(home, 'sessions'), { recursive: true });
    await writeFile(join(home, 'sessions', 'x'), 'SYNTHETIC_HOME_SESSION');
    await linkTo(home, alias);
    const result = await tools.run('read_file', { path: join(alias, 'sessions', 'x') });
    assert.equal(result.denied, true);
    assert.ok(!result.text.includes('SYNTHETIC_HOME_SESSION'));
    const row = auditRows.find((item) => item.tool === 'read_file');
    assert.ok(row.reason.includes('deny=dsh-home'));
  } finally {
    await cleanup(root, alias);
  }
});

test('DSH 数据根不存在时按字面围栏拒止', async () => {
  const { root, tools, auditRows } = await makeToolkit('dsafm-fence-missing-');
  try {
    // fake-home 未创建：根没有 realpath，围栏只有字面形态，根下路径仍按字面拒止。
    const result = await tools.run('read_file', { path: join(root, 'fake-home', 'nope.txt') });
    assert.equal(result.denied, true);
    const row = auditRows.find((item) => item.tool === 'read_file');
    assert.ok(row.reason.includes('deny=dsh-home'));
  } finally {
    await cleanup(root);
  }
});

test('不存在路径按字面拒止，不能用「不存在」绕过清单', async () => {
  const { root, tools } = await makeToolkit('dsafm-deny-missing-');
  try {
    const result = await tools.run('read_file', { path: join(root, 'missing', '.ssh', 'config') });
    assert.equal(result.denied, true);
  } finally {
    await cleanup(root);
  }
});

test('NTFS 流后缀写法：敏感名拒止、普通名不扩大', async () => {
  const { root, tools } = await makeToolkit('dsafm-deny-stream-');
  const dir = join(root, 'streams');
  try {
    await mkdir(dir);
    await writeFile(join(dir, 'settings.yaml'), 'SYNTHETIC_STREAM_SETTINGS');
    await writeFile(join(dir, 'notes.txt'), 'SYNTHETIC_STREAM_NOTES');
    const denied = await tools.run('read_file', { path: join(dir, 'settings.yaml::$DATA') });
    assert.equal(denied.denied, true);
    assert.ok(!denied.text.includes('SYNTHETIC_STREAM_SETTINGS'));
    const plain = await tools.run('read_file', { path: join(dir, 'notes.txt:s') });
    assert.equal(plain.denied, false);
  } finally {
    await cleanup(root);
  }
});

test('大小写变体同样拒止（独立目录避免大小写同名折叠）', async () => {
  const { root, tools } = await makeToolkit('dsafm-deny-case-');
  const upperDir = join(root, 'upper-ssh');
  const settingsDir = join(root, 'upper-settings');
  try {
    await mkdir(join(upperDir, '.SSH'), { recursive: true });
    await writeFile(join(upperDir, '.SSH', 'config'), 'SYNTHETIC_CASE_SSH');
    await mkdir(settingsDir);
    await writeFile(join(settingsDir, 'SETTINGS.YAML'), 'SYNTHETIC_CASE_SETTINGS');
    const sshResult = await tools.run('read_file', { path: join(upperDir, '.SSH', 'config') });
    assert.equal(sshResult.denied, true);
    assert.ok(!sshResult.text.includes('SYNTHETIC_CASE_SSH'));
    const settingsResult = await tools.run('read_file', { path: join(settingsDir, 'SETTINGS.YAML') });
    assert.equal(settingsResult.denied, true);
    assert.ok(!settingsResult.text.includes('SYNTHETIC_CASE_SETTINGS'));
  } finally {
    await cleanup(root);
  }
});

test('glob 逐条目拒止：敏感命中被过滤、普通文件保留', async () => {
  const { root, tools } = await makeToolkit('dsafm-glob-deny-');
  const store = join(root, 'store');
  try {
    await mkdir(store);
    await writeFile(join(store, 'a.pem'), 'SYNTHETIC_PEM_CONTENT');
    await writeFile(join(store, 'b.txt'), 'SYNTHETIC_PLAIN_B');
    const result = await tools.run('glob', { pattern: 'store/**' });
    assert.ok(!result.text.includes('a.pem'));
    assert.ok(result.text.includes('b.txt'));
  } finally {
    await cleanup(root);
  }
});

test('grep 逐文件拒止：敏感文件内容不进结果', async () => {
  const { root, tools } = await makeToolkit('dsafm-grep-deny-');
  const store = join(root, 'store');
  try {
    await mkdir(store);
    await writeFile(join(store, 'id_rsa'), `${NEEDLE}\n`);
    await writeFile(join(store, 'plain.txt'), 'nothing relevant\n');
    const result = await tools.run('grep', { pattern: NEEDLE, path: store });
    assert.ok(!result.text.includes(NEEDLE));
  } finally {
    await cleanup(root);
  }
});

let bigTree;
let rawTree;
let flatTree;

before(async () => {
  // 大树：root 下平铺 4005 个零填充目录 d0000–d4004（零填充使 NTFS 按名排序即数值序，
  // root 计入 scanned，d4004 落在 4000 目录数预算之外）；d0001–d0003 各放一个匹配串
  // 文件，d4004 放含同一匹配串的 tail.txt，全树共 4 个文件。预算内/外的确定性依赖
  // NTFS readdir 按名排序，Node 对 readdir 顺序无契约——换文件系统或 Node 行为变化时
  // 按此注释排查。
  bigTree = await mkdtemp(join(tmpdir(), 'dsafm-walk-big-'));
  for (let index = 0; index <= 4004; index += 1) {
    await mkdir(join(bigTree, `d${String(index).padStart(4, '0')}`));
  }
  for (const dir of ['d0001', 'd0002', 'd0003']) {
    await writeFile(join(bigTree, dir, 'needle.txt'), `${NEEDLE}\n`);
  }
  await writeFile(join(bigTree, 'd4004', 'tail.txt'), `${NEEDLE}\n`);
  // 原始候选树：单目录 2200 个文件（2100 填充 + 100 hit），用于原始候选收集上限 2000。
  rawTree = await mkdtemp(join(tmpdir(), 'dsafm-walk-raw-'));
  for (let index = 0; index < 2100; index += 1) {
    await writeFile(join(rawTree, `fill-${String(index).padStart(4, '0')}.txt`), 'filler\n');
  }
  for (let index = 0; index < 100; index += 1) {
    await writeFile(join(rawTree, `hit-${String(index).padStart(3, '0')}.txt`), 'hit candidate\n');
  }
  // 并列树：root 下平铺 4005 个空目录，300 个 c-XXX.txt 与目录同级混排在 root——
  // rel 无目录前缀，锚定过滤式 c-* 全部命中；构造不依赖 readdir 顺序。
  flatTree = await mkdtemp(join(tmpdir(), 'dsafm-walk-flat-'));
  for (let index = 0; index <= 4004; index += 1) {
    await mkdir(join(flatTree, `d${String(index).padStart(4, '0')}`));
  }
  for (let index = 0; index < 300; index += 1) {
    await writeFile(join(flatTree, `c-${String(index).padStart(3, '0')}.txt`), 'parallel candidate\n');
  }
});

after(async () => {
  await rm(bigTree, { recursive: true, force: true });
  await rm(rawTree, { recursive: true, force: true });
  await rm(flatTree, { recursive: true, force: true });
});

function treeTools(root) {
  return createReadonlyTools({
    rootDir: root,
    lang: 'en',
    timeoutMs: 30000,
    dshHomeOf: () => join(root, 'no-home'),
  });
}

test('完整无匹配不带任何说明', async () => {
  const small = await mkdtemp(join(tmpdir(), 'dsafm-walk-small-'));
  try {
    await writeFile(join(small, 'plain-a.txt'), 'plain content\n');
    await writeFile(join(small, 'plain-b.txt'), 'other plain\n');
    const tools = treeTools(small);
    const result = await tools.run('grep', { pattern: ABSENT, path: small });
    assert.equal(result.isError, false);
    assert.ok(!result.text.includes(ABSENT));
    assert.ok(!result.text.includes(WALK_LIMIT));
  } finally {
    await rm(small, { recursive: true, force: true });
  }
});

test('遍历未停止时有命中、无预算说明', async () => {
  const small = await mkdtemp(join(tmpdir(), 'dsafm-walk-hit-'));
  try {
    await writeFile(join(small, 'needle.txt'), `${NEEDLE}\n`);
    await writeFile(join(small, 'plain.txt'), 'plain content\n');
    const tools = treeTools(small);
    const result = await tools.run('grep', { pattern: NEEDLE, path: small });
    assert.ok(result.text.includes(NEEDLE));
    assert.ok(!result.text.includes(WALK_LIMIT));
  } finally {
    await rm(small, { recursive: true, force: true });
  }
});

test('有匹配但遍历不完整：命中在场且预算说明在场，预算外路径缺席', async () => {
  const tools = treeTools(bigTree);
  const result = await tools.run('grep', { pattern: NEEDLE, path: bigTree });
  assert.ok(result.text.includes('d0001'));
  assert.ok(result.text.includes(WALK_LIMIT));
  assert.ok(!result.text.includes('d4004'));
});

test('无匹配且遍历不完整：空结果必须声明不完整', async () => {
  const tools = treeTools(bigTree);
  const result = await tools.run('grep', { pattern: ABSENT, path: bigTree });
  assert.equal(result.isError, false);
  assert.ok(!result.text.includes(ABSENT));
  assert.ok(result.text.includes(WALK_LIMIT));
});

test('预取消按取消结算，不携带尾部说明', async () => {
  const tools = treeTools(bigTree);
  const controller = new AbortController();
  controller.abort();
  const result = await tools.run('grep', { pattern: NEEDLE, path: bigTree }, controller.signal);
  assert.equal(result.isError, true);
  assert.ok(result.text.includes('Call cancelled'));
  assert.ok(!result.text.includes(WALK_LIMIT));
});

test('原始候选收集上限显示 n=2000，不误标目录数预算', async () => {
  const tools = treeTools(rawTree);
  const result = await tools.run('grep', { pattern: ABSENT, path: rawTree, glob: 'hit-*' });
  assert.ok(result.text.includes(TRUNCATED_2000));
  assert.ok(!result.text.includes(WALK_LIMIT));
});

test('工作者候选上限与目录数预算两个说明同场并列（末位顺序）', async () => {
  const tools = treeTools(flatTree);
  const result = await tools.run('grep', { pattern: ABSENT, path: flatTree, glob: 'c-*' });
  assert.ok(result.text.includes(TRUNCATED_200));
  assert.ok(result.text.includes(WALK_LIMIT));
  assert.ok(result.text.indexOf(WALK_LIMIT) > result.text.indexOf(TRUNCATED_200));
});

test('命中满额与遍历不完整两条说明并列（末位顺序）', async () => {
  const tools = treeTools(bigTree);
  const result = await tools.run('grep', { pattern: NEEDLE, path: bigTree, maxMatches: 3 });
  assert.ok(result.text.includes(FIRST_3));
  assert.ok(result.text.includes(WALK_LIMIT));
  assert.ok(result.text.indexOf(WALK_LIMIT) > result.text.indexOf(FIRST_3));
});

test('单文件目标无遍历、无预算说明（尾文件直接搜索对照）', async () => {
  const tools = treeTools(bigTree);
  const result = await tools.run('grep', { pattern: NEEDLE, path: join(bigTree, 'd4004', 'tail.txt') });
  assert.ok(result.text.includes(NEEDLE));
  assert.ok(!result.text.includes(WALK_LIMIT));
});
