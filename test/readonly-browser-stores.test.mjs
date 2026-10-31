import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadonlyTools, isDeniedPath } from '../lib/readonly-tools.js';
import { createReviewer } from '../lib/reviewer.js';
import { DEFAULT_REDACT_PATTERNS } from '../lib/policy.js';
import * as prompt from '../lib/prompt.js';

/**
 * 浏览器规范存储拒止的回归测试（design §3.4／§10.2）。
 *
 * 样本纪律：全部自造合成文本（SYNTHETIC_BROWSER_STORE_*），不使用真实浏览器数据、
 * 不依赖真实账号资料；回喂验证用本地模型与消息替身在进程内跑生产审查循环，
 * 不联网、不调用真实模型。
 * 正例固定误伤边界：无上下文段的同名普通文件照常可读；上下文段目录自身可列举
 * （列名可见不算读取正文）。联结点用例沿用名称拒止的双形态纪律：字面与真实
 * 路径任一命中规范形态即拒止，双普通联结点保持可读。
 */

const MARKER = 'SYNTHETIC_BROWSER_STORE_NOT_A_REAL_SECRET';

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

test('isDeniedPath：浏览器规范存储按上下文段拒止，普通同名路径不受影响', () => {
  const denied = [
    'C:/Users/u/AppData/Local/Microsoft/Edge/User Data/Default/Login Data',
    'C:/Users/u/AppData/Local/Microsoft/Edge/User Data/Default/Cookies',
    'C:/Users/u/AppData/Local/Microsoft/Edge/User Data/Default/Network/Cookies',
    'C:/Users/u/AppData/Local/Google/Chrome/User Data/Profile 1/Login Data',
    'C:/Users/u/AppData/Local/Google/Chrome/User Data/Login Data For Account',
    'C:/Users/u/AppData/Local/Google/Chrome/User Data/Local State',
    'C:/Users/u/AppData/Local/Google/Chrome/User Data/Default/Web Data',
    'C:/Users/u/AppData/Roaming/Mozilla/Firefox/Profiles/abc.default-release/logins.json',
    'C:/Users/u/AppData/Roaming/Mozilla/Firefox/Profiles/abc.default-release/key4.db',
    'C:/Users/u/AppData/Roaming/Mozilla/Firefox/Profiles/abc.default-release/key3.db',
    'C:/Users/u/AppData/Roaming/Mozilla/Firefox/Profiles/abc.default-release/cookies.sqlite',
    'C:/Users/u/AppData/Roaming/Mozilla/Firefox/Profiles/abc.default-release/cookies.sqlite-wal',
    'C:/USERS/U/APPDATA/LOCAL/MICROSOFT/EDGE/USER DATA/DEFAULT/LOGIN DATA',
    'C:/Users/u/AppData/Local/Microsoft/Edge/User Data/Default/NETWORK/cookies',
  ];
  for (const path of denied) {
    const verdict = isDeniedPath(path);
    assert.equal(verdict.denied, true, path);
    assert.match(verdict.reason ?? '', /^browser (user data|profiles)\//u, `reason 须标 browser 类别与上下文段：${path}`);
  }
  const allowed = [
    'D:/docs/notes/Cookies',
    'D:/work/backup/logins.json',
    'D:/work/notes/cookies.sqlite 说明.txt',
    'C:/Users/u/Desktop/User Data.txt',
    'C:/Users/u/AppData/Local/SomeApp/Profiles/settings.json',
    'C:/Users/u/AppData/Local/Microsoft/Edge/User Data',
    'C:/Users/u/Read Me.md',
  ];
  for (const path of allowed) assert.equal(isDeniedPath(path).denied, false, `普通路径不得误拦：${path}`);
});

test('原型键段名不炸查表：constructor／__proto__ 一类路径照常判定与取证', async () => {
  // 单元层：段名恰为对象原型键时不抛、不误拦（查表必须 hasOwn 防继承属性）。
  for (const path of [
    'C:/tmp/constructor/foo.txt',
    'D:/work/__proto__/notes.md',
    'D:/work/hasOwnProperty/readme',
  ]) {
    const verdict = isDeniedPath(path);
    assert.equal(verdict.denied, false, `原型键段名不得误拦：${path}`);
  }
  // 真实上下文段的拒止在原型键路径存在的同时不受影响（查表顺序无关）。
  assert.equal(isDeniedPath('C:/Users/u/AppData/Local/Microsoft/Edge/User Data/Default/Login Data').denied, true);

  // 端到端：含 constructor 目录的树里，读取／glob／grep 整体正常返回，不因单路径查表失败。
  const { root, tools } = await makeToolkit('dsafm-proto-seg-');
  try {
    await mkdir(join(root, 'constructor'), { recursive: true });
    await mkdir(join(root, '__proto__'), { recursive: true });
    await writeFile(join(root, 'constructor', 'note.txt'), MARKER);
    await writeFile(join(root, '__proto__', 'note.txt'), MARKER);
    const read = await tools.run('read_file', { path: join(root, 'constructor', 'note.txt') });
    assert.equal(read.isError, false, 'constructor 目录下普通文件可读');
    assert.equal(read.text, MARKER);
    const globbed = await tools.run('glob', { pattern: '**/note.txt', cwd: root });
    assert.equal(globbed.isError, false, 'glob 不得因原型键目录整体失败');
    assert.ok(globbed.text.includes(join(root, 'constructor', 'note.txt')), 'glob 列出原型键目录下文件');
    const grepped = await tools.run('grep', { pattern: 'SYNTHETIC_BROWSER_STORE', path: root });
    assert.equal(grepped.isError, false, 'grep 不得因原型键目录整体失败');
    assert.ok(grepped.text.includes('constructor'), 'grep 命中原型键目录下内容');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const viaAlias of [false, true]) test(`真实 IO（${viaAlias ? '目录别名' : '普通路径'}）：合成规范路径读取拒止且不回显正文；同名普通文件、列目录与搜索正例保持`, async () => {
  const { root, tools, auditRows } = await makeToolkit('dsafm-browser-store-');
  const before = auditRows.length;
  const fixtureRoot = join(root, 'fixture');
  const aliasRoot = join(root, 'fixture-alias');
  const fixturePath = viaAlias ? aliasRoot : fixtureRoot;
  const edgeProfile = join(fixturePath, 'AppData/Local/Microsoft/Edge/User Data/Default');
  const firefoxProfile = join(fixturePath, 'AppData/Roaming/Mozilla/Firefox/Profiles/synthetic.default');
  const notes = join(fixturePath, 'plain-notes');
  try {
    await mkdir(fixtureRoot);
    if (viaAlias) await linkTo(fixtureRoot, aliasRoot);
    await mkdir(join(edgeProfile, 'Network'), { recursive: true });
    await mkdir(firefoxProfile, { recursive: true });
    await mkdir(notes, { recursive: true });
    await writeFile(join(edgeProfile, 'Login Data'), MARKER);
    await writeFile(join(edgeProfile, 'Network', 'Cookies'), MARKER);
    await writeFile(join(edgeProfile, 'Local State'), MARKER);
    await writeFile(join(firefoxProfile, 'logins.json'), MARKER);
    await writeFile(join(firefoxProfile, 'cookies.sqlite'), MARKER);
    await writeFile(join(notes, 'Cookies'), MARKER);
    await writeFile(join(notes, 'logins.json'), MARKER);

    for (const sensitive of [
      join(edgeProfile, 'Login Data'),
      join(edgeProfile, 'Network', 'Cookies'),
      join(edgeProfile, 'Local State'),
      join(firefoxProfile, 'logins.json'),
      join(firefoxProfile, 'cookies.sqlite'),
    ]) {
      const result = await tools.run('read_file', { path: sensitive });
      assert.equal(result.denied, true, `须拒止：${sensitive}`);
      assert.equal(result.isError, true, sensitive);
      assert.ok(!result.text.includes(MARKER), `拒止结果不得回显正文：${sensitive}`);
    }
    // 短路径或目录别名可能使审计带 literal/real 前缀；类别判据须兼容双形态来源。
    const denyAudits = auditRows.slice(before).map((row) => String(row.reason ?? ''));
    assert.equal(denyAudits.filter((reason) => /deny=(?:(?:literal|real) )?browser /u.test(reason)).length, 5, '五次敏感读取各留一条 browser 类别审计');
    assert.ok(denyAudits.some((reason) => /deny=(?:(?:literal|real) )?browser user data\/login data/u.test(reason)), 'reason 标明上下文段与基名');
    assert.ok(denyAudits.some((reason) => /deny=(?:(?:literal|real) )?browser user data\/cookies/u.test(reason)), 'Network 子目录变体同样命中');
    assert.ok(denyAudits.some((reason) => /deny=(?:(?:literal|real) )?browser profiles\//u.test(reason)), 'Firefox 上下文段同样命中');
    if (viaAlias) assert.ok(denyAudits.every((reason) => reason.includes('deny=literal browser ')), '目录别名用例必须触发双形态来源前缀');
    for (const ordinary of [join(notes, 'Cookies'), join(notes, 'logins.json')]) {
      const result = await tools.run('read_file', { path: ordinary });
      assert.equal(result.isError, false, `普通同名文件照常可读：${ordinary}`);
      assert.equal(result.text, MARKER, ordinary);
    }
    // 列名可见不算读取正文：上下文段目录自身可列举。
    const listing = await tools.run('list_dir', { path: edgeProfile });
    assert.equal(listing.isError, false, '目录列举不拒止');
    assert.ok(listing.text.includes('Login Data'), '目录列表可见敏感名称');
    // glob：敏感命中被过滤、普通文件保留。
    const globbed = await tools.run('glob', { pattern: '**/*ookies*', cwd: fixturePath });
    assert.equal(globbed.isError, false);
    assert.ok(!globbed.text.includes(join(edgeProfile, 'Network', 'Cookies')), 'glob 不得列出敏感命中');
    assert.ok(globbed.text.includes(join(notes, 'Cookies')), 'glob 保留普通同名文件');
    // grep：敏感文件内容不进结果，普通文件内容照常命中。
    const grepped = await tools.run('grep', { pattern: 'SYNTHETIC_BROWSER_STORE', path: fixturePath });
    assert.equal(grepped.isError, false);
    assert.ok(!grepped.text.includes('User Data'), 'grep 输出不得含规范存储路径');
    assert.ok(grepped.text.includes('plain-notes'), 'grep 保留普通文件命中');
  } finally {
    if (viaAlias) await removeLink(aliasRoot);
    await rm(root, { recursive: true, force: true });
  }
});

test('浏览器存储拒止的字面与真实双形态：联结点两个方向都拦，双普通联结点可读', async () => {
  const { root, tools, auditRows } = await makeToolkit('dsafm-browser-dual-');
  const realStore = join(root, 'AppData/Local/Microsoft/Edge/User Data/Default');
  try {
    await mkdir(realStore, { recursive: true });
    await writeFile(join(realStore, 'Login Data'), MARKER);
    // 真实形态：普通字面经联结点指向规范存储目录。
    const aliasIntoStore = join(root, 'plain-alias');
    await linkTo(realStore, aliasIntoStore);
    const viaReal = await tools.run('read_file', { path: join(aliasIntoStore, 'Login Data') });
    assert.equal(viaReal.denied, true, '真实形态命中须拒止');
    assert.ok(!viaReal.text.includes(MARKER));
    // 字面形态：规范字面经联结点指向普通目录（用另一处 Chromium 路径，避免与真实目录撞名）。
    const plainTarget = join(root, 'plain-target');
    await mkdir(plainTarget);
    await writeFile(join(plainTarget, 'Login Data'), MARKER);
    const literalChromium = join(root, 'AppData/Local/Chromium/User Data/Default');
    await mkdir(join(root, 'AppData/Local/Chromium/User Data'), { recursive: true });
    await linkTo(plainTarget, literalChromium);
    const viaLiteral = await tools.run('read_file', { path: join(literalChromium, 'Login Data') });
    assert.equal(viaLiteral.denied, true, '字面形态命中须拒止');
    assert.ok(!viaLiteral.text.includes(MARKER));
    // 双形态来源与 browser 类别随审计行可辨（real/literal 前缀由统一入口标注）。
    const reasons = auditRows.map((row) => String(row.reason ?? '')).filter((reason) => reason.includes('deny=') && reason.includes('browser '));
    assert.ok(reasons.some((reason) => reason.includes('deny=real browser user data/login data')), '真实形态命中带 real 前缀');
    assert.ok(reasons.some((reason) => reason.includes('deny=literal browser user data/login data') || reason.includes('deny=browser user data/login data')), '字面形态命中可辨');
    // 双普通联结点正例：无任何规范段，照常可读。
    const plainLink = join(root, 'plain-link');
    await linkTo(plainTarget, plainLink);
    const plainRead = await tools.run('read_file', { path: join(plainLink, 'Login Data') });
    assert.equal(plainRead.isError, false, '双普通路径不得误拦');
    assert.equal(plainRead.text, MARKER);
    await removeLink(plainLink);
    await removeLink(literalChromium);
    await removeLink(aliasIntoStore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('生产审查循环回喂：拒止后合成标记不进入下一轮模型请求（本地替身，不联网）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsafm-browser-flow-'));
  const edgeProfile = join(root, 'AppData/Local/Microsoft/Edge/User Data/Default');
  const notes = join(root, 'plain-notes');
  await mkdir(edgeProfile, { recursive: true });
  await mkdir(notes, { recursive: true });
  await writeFile(join(edgeProfile, 'Login Data'), MARKER);
  await writeFile(join(notes, 'Cookies'), MARKER);
  try {
    /** 本地审查循环替身：首轮固定发起对目标文件的 read_file，次轮给出合成拒绝结论。 */
    const runFlow = async (target) => {
      class LocalAssembler {
        constructor() { this.items = []; }
        push(chunk) { if (chunk.block) this.items.push(chunk.block); }
        blocks() { return this.items; }
      }
      const requests = [];
      let round = 0;
      const llm = { stream(request) {
        requests.push(structuredClone(request.messages));
        const block = round++ === 0
          ? { type: 'tool-call', id: 'synthetic-call', name: 'read_file', arguments: JSON.stringify({ path: target }) }
          : { type: 'text', text: '{"outcome":"deny","rationale":"Synthetic local transport only"}' };
        return (async function* () { yield { block }; })();
      } };
      const messages = {
        createUserMessage: (x) => ({ role: 'user', ...x }),
        createAssistantMessage: (x) => ({ role: 'assistant', ...x }),
        createToolResultMessage: (x) => ({ role: 'tool-result', ...x }),
      };
      const tools = createReadonlyTools({
        rootDir: root,
        lang: 'en',
        dshHomeOf: () => join(root, 'fake-dsh-home'),
        redactPatterns: [...DEFAULT_REDACT_PATTERNS],
      });
      const reviewer = createReviewer({ llm, blocks: { BlockAssembler: LocalAssembler }, messages, tools, prompt, audit: () => {} });
      const cfg = {
        reviewer: { maxTokens: 0, temperature: 0, maxToolSteps: 4, timeoutMs: 1000 },
        resolution: { provider: 'local-synthetic', model: 'no-network-stub', layer: 'global' },
        context: { maxEntryBytes: 4096, redactPatterns: [...DEFAULT_REDACT_PATTERNS] },
        audit: { includePrompt: false, includeRaw: false },
        language: { agent: 'en' },
        ui: { trace: { capture: 'summary' } },
      };
      const verdict = await reviewer.review(
        { toolName: 'synthetic-tool', reason: 'No real operation' },
        { command: 'synthetic', cwd: root },
        { fields: {}, evidence: 'Synthetic data only.' },
        cfg,
        { id: 'synthetic-review', signal: new AbortController().signal },
      );
      const second = requests[1] ?? [];
      return { decision: verdict.decision, secondRequestHasMarker: JSON.stringify(second).includes(MARKER), streamCalls: requests.length };
    };
    // 敏感目标：工具结果被拒止，标记不进下一轮请求。
    const sensitive = await runFlow(join(edgeProfile, 'Login Data'));
    assert.equal(sensitive.decision, 'deny');
    assert.equal(sensitive.streamCalls >= 2, true, '替身至少完成两轮请求');
    assert.equal(sensitive.secondRequestHasMarker, false, '合成标记不得进入下一轮模型请求');
    // 对照：普通同名文件可读，标记随工具结果进入下一轮——传输本身无屏蔽，缺的只是拒止。
    const ordinary = await runFlow(join(notes, 'Cookies'));
    assert.equal(ordinary.secondRequestHasMarker, true, '对照路径须证明回喂通道会携带内容');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
