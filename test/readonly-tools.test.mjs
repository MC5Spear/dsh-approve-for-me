import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { assertSafePattern, createReadonlyTools, globToRegExp, isDeniedPath } from '../lib/readonly-tools.js';
import { agentT } from '../lib/agent-texts.js';
import { errorCopyFailures } from './helpers/error-copy-facts.mjs';

/**
 * 拒止文件的合成正文 marker：独立合成标记用于区分内容与拒止消息中的路径
 * （拒止消息回显的绝对路径含仓库名 approve-for-me，不能拿它当敏感内容判据）。
 */
const DENIED_MARKER = 'DSAFM-DENIED-BODY-MARKER-8e42c1';

/**
 * 建一棵临时目录树。
 * @returns {Promise<string>} 根目录。
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsafm-'));
  await mkdir(join(root, 'src', 'nested'), { recursive: true });
  await writeFile(join(root, 'src', 'a.txt'), 'hello world\nsecret sk-abcdefgh12345678\n');
  await writeFile(join(root, 'src', 'nested', 'b.txt'), 'second file\n');
  await writeFile(join(root, 'src', 'code.js'), 'const answer = 42;\n');
  await writeFile(join(root, '.credentials.yaml'), 'DEEPSEEK_API_KEY: sk-should-never-be-read\n');
  await writeFile(join(root, 'id_rsa'), 'PRIVATE\n');
  // 裸点形态（基名即扩展名，无主干名）必须真实落在磁盘上验证端到端拒止。
  await writeFile(join(root, '.pem'), 'BARE-PEM-PRIVATE\n');
  await writeFile(join(root, 'settings.yaml'), `session-model: ${DENIED_MARKER}\n`);
  // 大写名必须落在独立目录：NTFS 上同目录写 settings.yaml 与 SETTINGS.YAML 是同一个文件，
  // 磁盘名会保持先写的小写，用例就无法区分大小写敏感与否。
  await mkdir(join(root, 'UPPER'), { recursive: true });
  await writeFile(join(root, 'UPPER', 'SETTINGS.YAML'), 'upper-case-name: should-not-be-read\n');
  await writeFile(join(root, 'UPPER', 'ID_RSA'), 'UPPER-PRIVATE\n');
  await writeFile(join(root, 'UPPER', '.ENV'), 'UPPER_ENV=1\n');
  await mkdir(join(root, '.ssh'), { recursive: true });
  await writeFile(join(root, '.ssh', 'config'), 'Host *\n');
  return root;
}

/** 收集 audit 回调的调用记录。 */
function spy() {
  const audits = [];
  return { audits, audit: (fields) => audits.push(fields) };
}

test('globToRegExp 支持 ** / * / ?', () => {
  assert.equal(globToRegExp('src/**/*.txt').test('src/nested/b.txt'), true);
  assert.equal(globToRegExp('src/**/*.txt').test('src/a.txt'), true);
  assert.equal(globToRegExp('src/*.txt').test('src/nested/b.txt'), false);
  assert.equal(globToRegExp('src/?.txt').test('src/a.txt'), true);
});

test('isDeniedPath 覆盖凭据类文件与目录', () => {
  for (const path of [
    'C:/x/.credentials.yaml',
    'C:/x/.credentials.json',
    'C:/x/id_rsa',
    'C:/x/id_ed25519.pub',
    'C:/x/settings.yaml',
    'C:/x/.env.local',
    'C:/x/.netrc',
    'C:/x/.npmrc',
    'C:/x/.git-credentials',
    'C:/x/key.pem',
    'C:/x/cert.pfx',
    'C:/x/.ssh/config',
    'C:/x/.aws/credentials',
    'C:/x/.docker/config.json',
    'C:/x/bash_history',
  ]) {
    assert.equal(isDeniedPath(path).denied, true, `应拒止：${path}`);
  }
  assert.equal(isDeniedPath('C:/x/src/a.txt').denied, false);
  assert.equal(isDeniedPath('C:/x/.aws/config').denied, false);
});

test('isDeniedPath 拒止基名即扩展名的裸点文件，不影响普通隐藏文件', () => {
  for (const path of ['C:/x/.pem', 'C:/x/.key', 'C:/x/.pfx', 'C:/x/.kdbx', 'C:/x/.PEM']) {
    assert.equal(isDeniedPath(path).denied, true, `应拒止：${path}`);
  }
  // 无主干隐藏文件的「后缀」不在清单内，不因放宽扩展名提取而误伤。
  assert.equal(isDeniedPath('C:/x/.gitignore').denied, false);
  assert.equal(isDeniedPath('C:/x/.vscode').denied, false);
});

test('read_file 读取内容、支持 offset/limit 并对超限留截断标记', async () => {
  const root = await fixture();
  const { audit } = spy();
  const tools = createReadonlyTools({ rootDir: root, audit });
  const whole = await tools.run('read_file', { path: 'src/a.txt' });
  assert.match(whole.text, /hello world/);
  assert.equal(whole.isError, false);

  const offset = await tools.run('read_file', { path: 'src/a.txt', offset: 6, limit: 5 });
  assert.equal(offset.text, 'world');

  const big = join(root, 'big.txt');
  await writeFile(big, 'x'.repeat(70000));
  const truncated = await tools.run('read_file', { path: big });
  assert.match(truncated.text, /<truncated omitted_approx_tokens="\d+" \/>/);
  assert.ok(Buffer.byteLength(truncated.text, 'utf8') < 70000);
});

test('read_file 拒止凭据类文件且不回显内容', async () => {
  const root = await fixture();
  const tools = createReadonlyTools({ rootDir: root });
  for (const path of ['.credentials.yaml', 'id_rsa', 'settings.yaml', '.ssh/config', '.pem']) {
    const result = await tools.run('read_file', { path });
    assert.equal(result.isError, true, `应拒止：${path}`);
    assert.equal(result.denied, true);
    assert.doesNotMatch(result.text, /sk-should-never-be-read|PRIVATE|Host \*/);
  }
});

test('list_dir 非递归且最多 200 条', async () => {
  const root = await fixture();
  const many = join(root, 'many');
  await mkdir(many);
  for (let index = 0; index < 205; index += 1) await writeFile(join(many, `f${index}.txt`), 'x');
  const tools = createReadonlyTools({ rootDir: root });
  const result = await tools.run('list_dir', { path: 'many' });
  assert.match(result.text, /<truncated omitted_approx_tokens="0" \/>/);
  assert.equal(result.text.split('\n').length, 201);
});

test('glob 只在给定根下匹配并跳过符号链接', async () => {
  const root = await fixture();
  const tools = createReadonlyTools({ rootDir: root });
  const result = await tools.run('glob', { pattern: 'src/**/*.txt' });
  const lines = result.text.split('\n').filter((line) => line.length > 0);
  assert.equal(lines.length, 2);
  assert.ok(lines.some((line) => line.endsWith('a.txt')));
  assert.ok(lines.some((line) => line.endsWith('b.txt')));
});

test('grep 命中上限、跳过拒止文件、非法正则返回错误', async () => {
  const root = await fixture();
  const tools = createReadonlyTools({ rootDir: root });
  const hits = await tools.run('grep', { pattern: 'file', path: 'src' });
  assert.match(hits.text, /b\.txt:1:/);
  assert.doesNotMatch(hits.text, /sk-/);

  const capped = await tools.run('grep', { pattern: '.', path: 'src', maxMatches: 1 });
  assert.match(capped.text, /仅显示前 1 条/);

  const invalid = await tools.run('grep', { pattern: '([' });
  assert.equal(invalid.isError, true);
  assert.match(invalid.text, /正则编译失败/);
});

test('工具结果统一脱敏后才回喂', async () => {
  const root = await fixture();
  const tools = createReadonlyTools({
    rootDir: root,
    redactPatterns: ['sk-[A-Za-z0-9]+'],
    redact: (text, patterns) => {
      let out = text;
      for (const pattern of patterns) out = out.replace(new RegExp(pattern, 'g'), '[redacted]');
      return out;
    },
  });
  const result = await tools.run('read_file', { path: 'src/a.txt' });
  assert.doesNotMatch(result.text, /sk-abcdefgh12345678/);
  assert.match(result.text, /\[redacted]/);
});

test('每次调用写 phase=tool 审计，且不写文件内容', async () => {
  const root = await fixture();
  const { audits, audit } = spy();
  const tools = createReadonlyTools({ rootDir: root, audit });
  await tools.run('read_file', { path: 'src/a.txt' });
  await tools.run('read_file', { path: '.credentials.yaml' });
  assert.equal(audits.length, 2);
  assert.equal(audits[0].phase, 'tool');
  assert.equal(audits[0].tool, 'read_file');
  assert.equal(audits[0].path, 'src/a.txt');
  assert.equal(audits[0].degraded, 'none');
  assert.equal(audits[1].degraded, 'denied');
  assert.match(audits[0].reason, /bytes=\d+ denied=no/);
  assert.match(audits[1].reason, /denied=yes/);
  assert.doesNotMatch(audits[0].reason, /hello world|sk-/);
});

test('未知工具、取消信号与超时都转成错误结果，不外抛', async () => {
  const root = await fixture();
  const tools = createReadonlyTools({ rootDir: root, timeoutMs: 5000 });
  const unknown = await tools.run('write_file', { path: 'x' });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /未知工具/);

  const aborted = new AbortController();
  aborted.abort();
  const cancelled = await tools.run('read_file', { path: 'src/a.txt' }, aborted.signal);
  assert.equal(cancelled.isError, true);
  assert.match(cancelled.text, /取消/);
});

test('只读工具不修改目标文件', async () => {
  const root = await fixture();
  const target = join(root, 'src', 'a.txt');
  const before = await readFile(target, 'utf8');
  const tools = createReadonlyTools({ rootDir: root });
  await tools.run('read_file', { path: 'src/a.txt' });
  await tools.run('grep', { pattern: 'hello', path: 'src' });
  assert.equal(await readFile(target, 'utf8'), before);
});

test('grep 的拒止判定经过 realpath 归一化：大小写变体不可绕过', async () => {
  const root = await fixture();
  const tools = createReadonlyTools({ rootDir: root });
  // 大小写变体在 Windows 上指向同一文件；两个形态都必须拒止且不泄漏正文 marker。
  for (const target of [join(root, 'SETTINGS.YAML'), join(root, 'settings.yaml')]) {
    const hit = await tools.run('grep', { pattern: DENIED_MARKER, path: target });
    assert.equal(hit.denied, true, `应拒止：${target}`);
    assert.ok(!String(hit.text).includes(DENIED_MARKER), `拒止消息不得泄漏正文 marker：${hit.text}`);
  }
  // 正常对照：同一 grep 方法在非拒止文件上确实返回正文——「不泄 marker」由此才是有效判据。
  const control = await tools.run('grep', { pattern: 'hello', path: join(root, 'src') });
  assert.ok(String(control.text).includes('hello world'), '对照组应返回正文命中');
});

test('grep 与 glob 不因 NTFS 备用数据流后缀而绕过拒止', async () => {
  const root = await fixture();
  const tools = createReadonlyTools({ rootDir: root });
  const stream = await tools.run('grep', { pattern: DENIED_MARKER, path: join(root, 'settings.yaml::$DATA') });
  assert.equal(stream.denied, true, 'ADS 后缀形态应拒止');
  assert.ok(!String(stream.text).includes(DENIED_MARKER), `拒止消息不得泄漏正文 marker：${stream.text}`);
  const listed = await tools.run('glob', { pattern: 'settings.yaml*', cwd: root });
  assert.ok(!String(listed.text).includes(DENIED_MARKER), 'glob 不得泄正文 marker');
  // 正常对照：同一 grep 方法在非拒止文件上确实返回正文——「不泄 marker」由此才是有效判据。
  const control = await tools.run('grep', { pattern: 'hello', path: join(root, 'src', 'a.txt') });
  assert.ok(String(control.text).includes('hello world'), '对照组应返回正文命中');
});

test('glob 过滤拒止清单且拒止目录不可作为枚举起点', async () => {
  const root = await fixture();
  const tools = createReadonlyTools({ rootDir: root });
  const all = await tools.run('glob', { pattern: '**/*' });
  assert.doesNotMatch(all.text, /settings\.yaml/);
  assert.doesNotMatch(all.text, /id_rsa/);
  assert.doesNotMatch(all.text, /\.credentials\.yaml/);
  assert.match(all.text, /a\.txt/);

  const deniedBase = await tools.run('glob', { pattern: '*', cwd: join(root, '.ssh') });
  assert.equal(deniedBase.denied, true);
});

test('UNC 与设备命名空间一律拒止', async () => {
  const root = await fixture();
  const tools = createReadonlyTools({ rootDir: root });
  for (const path of ['\\\\server\\share\\x.txt', '//?/C:/Windows/win.ini']) {
    const read = await tools.run('read_file', { path });
    assert.equal(read.denied, true, `应拒止：${path}`);
  }
});

test('磁盘上大写形式的凭据文件名同样拒止', async () => {
  const root = await fixture();
  const tools = createReadonlyTools({ rootDir: root });
  for (const name of ['SETTINGS.YAML', 'ID_RSA', '.ENV']) {
    const read = await tools.run('read_file', { path: join(root, 'UPPER', name) });
    assert.equal(read.denied, true, `read_file 应拒止 ${name}`);
  }
  const grepped = await tools.run('grep', { pattern: 'upper', path: join(root, 'UPPER') });
  assert.doesNotMatch(grepped.text, /upper-case-name|UPPER-PRIVATE|UPPER_ENV/);
  const listed = await tools.run('glob', { pattern: '**/*' });
  assert.doesNotMatch(listed.text, /SETTINGS\.YAML|ID_RSA|\.ENV/);
});

test('自定义 NTFS 流名不能绕过拒止', async () => {
  const root = await fixture();
  const tools = createReadonlyTools({ rootDir: root });
  const read = await tools.run('read_file', { path: join(root, 'settings.yaml:secret') });
  assert.equal(read.denied, true);
  const grepped = await tools.run('grep', { pattern: 'approve', path: join(root, 'settings.yaml:secret') });
  assert.equal(grepped.denied, true);
});

test('setLang 两档驱动结果模板语言（requirements §5.4：工具失败回喂整句随语言切换）', async () => {
  const root = await fixture();
  const tools = createReadonlyTools({ rootDir: root });
  // 用文件路径列目录 → readdir 抛 ENOTDIR → run 的 catch 回喂 tool.failed（唯一产生该模板的路径）。
  tools.setLang('en');
  const en = await tools.run('list_dir', { path: 'src/a.txt' });
  tools.setLang('zh');
  const zh = await tools.run('list_dir', { path: 'src/a.txt' });
  assert.equal(en.isError, true);
  assert.equal(zh.isError, true);
  for (const lang of ['zh', 'en']) assert.deepEqual(errorCopyFailures('tool', lang, agentT(lang, 'tool.failed')), []);
  const enHead = agentT('en', 'tool.failed').replace('{name}', 'list_dir').split('{error}')[0];
  const zhHead = agentT('zh', 'tool.failed').replace('{name}', 'list_dir').split('{error}')[0];
  assert.ok(en.text.startsWith(enHead), `en 档回喂须以英文模板开头：${en.text}`);
  assert.ok(zh.text.startsWith(zhHead), `zh 档回喂须以中文模板开头：${zh.text}`);
  // 同一错误的主体两档逐字节一致：语言只切换模板句身，错误文本与语言无关。
  assert.equal(en.text.slice(enHead.length), zh.text.slice(zhHead.length));
  assert.ok(!en.text.includes('工具'), 'en 档不得残留 zh 模板');
  assert.ok(!zh.text.includes('Tool list_dir failed'), 'zh 档不得残留 en 模板');
  // 变红判据：结果模板退回硬编码 zh → enHead 断言红；硬编码 en → zhHead 红；
  // setLang 失效（两档同文）→ 两条首部断言之一必红（同一文本不可能同时以两种模板开头）。
});

// ── grep 模式静态预检与资源上界（design §3.4） ──────────────────────────────

test('assertSafePattern：普通形态放行、病态形态给出拒止理由', () => {
  // 放行：无「量词作用于复杂组」、无反向引用、不超长。
  for (const source of ['[a-z]+\\d+', '(foo)+', 'foo|bar', 'a+?', '(?:ab)+', 'a{2,4}', '^\\d+$', String.raw`\bmkfs\b`]) {
    assert.equal(assertSafePattern(source), undefined, `应放行：${source}`);
  }
  // 拒止：反向引用、组上再量词（组体含量词或选择，含嵌套与前后视形态）、超长。
  for (const source of ['(a)\\1', '(a+)+', '(a|a)*', '(foo|bar)+', '([a-z]*)*', '(a(b|c))+', '(?:a+)+', 'x'.repeat(257)]) {
    assert.notEqual(assertSafePattern(source), undefined, `应拒止：${source}`);
  }
});

test('病态 pattern 在编译前被静态拒止：同步返回、不触超时、审计照写', async () => {
  const root = await fixture();
  const { audits, audit } = spy();
  const tools = createReadonlyTools({ rootDir: root, timeoutMs: 5000, audit });
  const result = await tools.run('grep', { pattern: '(a+)+$', path: join(root, 'src') });
  assert.equal(result.isError, true);
  assert.match(result.text, /安全预检/);
  assert.doesNotMatch(result.text, /超时/, '静态拒止不是超时，两者的模板必须可区分');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].phase, 'tool');
});

test('超过 1 MiB 的文件跳过并说明；同目录小文件仍命中', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsafm-big-'));
  // ≈1.15 MiB 且末尾带 needle：若不做大小跳过，big.log 会是命中项。
  await writeFile(join(root, 'big.log'), `${'x'.repeat(96)}\n`.repeat(12000) + 'needle\n');
  await writeFile(join(root, 'small.txt'), 'needle here\n');
  const tools = createReadonlyTools({ rootDir: root });
  const result = await tools.run('grep', { pattern: 'needle', path: root });
  assert.match(result.text, /small\.txt/);
  assert.doesNotMatch(result.text, /big\.log/, '超限文件不得成为命中项');
  assert.match(result.text, /跳过 1 个超过 1 MiB 的文件/);
});

test('候选文件数截断：超过 200 个候选时说明截断为前 200', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsafm-many-'));
  for (let index = 0; index < 250; index += 1) {
    await writeFile(join(root, `f${String(index).padStart(3, '0')}.txt`), 'needle\n');
  }
  const tools = createReadonlyTools({ rootDir: root });
  const result = await tools.run('grep', { pattern: 'needle', path: root });
  assert.match(result.text, /候选文件截断为前 200 个/);
  assert.match(result.text, /f001\.txt/);
  // NTFS 的 readdir 按名序：前 200 个候选是 f000–f199，f2xx 不在扫描范围内。
  assert.doesNotMatch(result.text, /f2\d\d\.txt/);
});

// ── DSH 敏感范围（design §3.4／§8.3） ────────────────────────────────────

test('sessions/reviews/current-url.txt 全部拒止，拒止类别随行写出', async () => {
  const root = await fixture();
  const home = await mkdtemp(join(tmpdir(), 'dsafm-home-'));
  await mkdir(join(home, 'sessions'), { recursive: true });
  await writeFile(join(home, 'sessions', 'session-1.jsonl'), 'transcript\n');
  await mkdir(join(home, 'approve-for-me', 'reviews'), { recursive: true });
  await writeFile(join(home, 'approve-for-me', 'reviews', 's1.jsonl'), 'review\n');
  await writeFile(join(home, 'current-url.txt'), 'http://127.0.0.1:3000\n');
  const tools = createReadonlyTools({ rootDir: root, dshHomeOf: () => home });
  for (const rel of ['sessions/session-1.jsonl', 'approve-for-me/reviews/s1.jsonl', 'current-url.txt']) {
    const read = await tools.run('read_file', { path: join(home, rel) });
    assert.equal(read.denied, true, `read_file 应拒止：${rel}`);
    assert.equal(read.isError, true);
    assert.match(read.text, /DSH 数据目录/);
  }
  const grepped = await tools.run('grep', { pattern: 'transcript', path: join(home, 'sessions') });
  assert.equal(grepped.denied, true, 'grep 基点在敏感范围内应拒止');
  const globbed = await tools.run('glob', { pattern: '**/*', cwd: home });
  assert.equal(globbed.denied, true, 'glob 基点在敏感范围内应拒止');
});

test('对照：注入根独立生效、工作区同名目录不误伤', async () => {
  const root = await fixture();
  await mkdir(join(root, 'sessions'), { recursive: true });
  await writeFile(join(root, 'sessions', 'note.txt'), 'workspace-session\n');
  const home = await mkdtemp(join(tmpdir(), 'dsafm-home2-'));
  const tools = createReadonlyTools({ rootDir: root, dshHomeOf: () => home });
  // 工作区里叫 sessions 的目录是普通目录。
  const read = await tools.run('read_file', { path: 'sessions/note.txt' });
  assert.equal(read.denied, false);
  assert.match(read.text, /workspace-session/);
  // 注入根里的路径即使文件不存在也拒止（敏感范围按路径判定，不要求文件在场）。
  const inEnv = await tools.run('read_file', { path: join(home, 'current-url.txt') });
  assert.equal(inEnv.denied, true);
});

test('home 根为别名拼写时围栏仍拒止（8.3 短名；不自证别名则明示跳过）', async (t) => {
  // 全新父目录＋长名子目录：父目录里没有同干兄弟名，NTFS 对首个目录按顺序后缀（~1 起）
  // 生成短名，可确定性取得。会话临时目录里既有 dsafm-* 夹具会占尽 ~1..~4，迫使 NTFS 改用
  // 哈希形态短名（非「前缀＋~n」），按规则构造不出——不在拥挤目录里做该构造。
  const parent = await mkdtemp(join(tmpdir(), 'dsafm-sn-'));
  const home = join(parent, 'dsafm-sn-tail');
  await mkdir(join(home, 'sessions'), { recursive: true });
  await writeFile(join(home, 'sessions', 'session-1.jsonl'), 'transcript\n');
  const canonical = await realpath(home);
  let alias = null;
  if (home.toLowerCase() !== canonical.toLowerCase()) {
    // home 拼写本身就是别名（TEMP 含 8.3 短名前缀；macOS 的 /var→/private/var 等
    // realpath 会归一的平台侧别名），同样接受。
    alias = home;
  } else if (process.platform === 'win32') {
    // 8.3 短名自证用 stat().ino 跨拼写等值：同一目录长短拼写的卷内文件号相同、不同目录
    // 不同。不依赖 realpath 的归一行为——个别目录经 realpath 可能仍返回短名拼写，
    // realpath 字符串等值判据在那种目录上会漏（ino 判据不受影响）。候选按 NTFS 规则
    // 构造：大写、滤非法字符、取前 6 字符＋~n，n 回退扫描 ~1..~4。
    const stem = basename(canonical).toUpperCase().replace(/[^A-Z0-9_-]/gu, '').slice(0, 6);
    const homeIno = (await stat(canonical)).ino;
    for (let n = 1; n <= 4; n += 1) {
      const candidate = join(parent, `${stem}~${n}`);
      try {
        if ((await stat(candidate)).ino === homeIno) {
          alias = candidate;
          break;
        }
      } catch {}
    }
  }
  if (alias === null) {
    // 跳过原因写实：卷禁用 8.3（候选全部 stat 失败）或平台无该别名形态；本环境下别名分支
    // 未被本用例执行，不计为通过。
    t.skip('未取得可自证的 8.3 别名：卷未启用 8.3 短名、顺序后缀不可构造或平台无该别名形态');
    return;
  }
  assert.notEqual(alias.toLowerCase(), canonical.toLowerCase(), '别名拼写须与真实路径不同（防恒真）');
  const tools = createReadonlyTools({ rootDir: tmpdir(), dshHomeOf: () => alias });
  // 不变式：只归一目标、不归一根的实现对别名根拼写失配——根与目标两侧都按字面与真实形态
  // 并集判定，两种别名拼写的目标都必须拒止。
  const p1 = await tools.run('read_file', { path: join(canonical, 'sessions', 'session-1.jsonl') });
  assert.equal(p1.denied, true, '长名拼写的目标应拒止');
  assert.equal(p1.isError, true);
  assert.match(p1.text, /DSH 数据目录/);
  const p2 = await tools.run('read_file', { path: join(alias, 'sessions', 'session-1.jsonl') });
  assert.equal(p2.denied, true, '别名拼写的目标应拒止');
  // 并集哨兵：别名根下不存在的路径按字面命中——「两侧只比较 realpath」的朴素实现在此失效打开。
  const p3 = await tools.run('read_file', { path: join(alias, 'current-url.txt') });
  assert.equal(p3.denied, true, '别名根下不存在的路径同样拒止（并集哨兵）');
});

test('home 根为联结点拼写时围栏仍拒止，别名根下不存在路径同样拒止', async () => {
  const homeReal = await mkdtemp(join(tmpdir(), 'dsafm-jh-'));
  await mkdir(join(homeReal, 'sessions'), { recursive: true });
  await writeFile(join(homeReal, 'sessions', 'session-1.jsonl'), 'transcript\n');
  const canonical = await realpath(homeReal);
  // Windows 联结点无需特权；POSIX 忽略 type 实参建为普通符号链接，用例同样有效。建链失败即抛错变红。
  const junctionPath = join(tmpdir(), `dsafm-jl-${process.pid}-${Date.now()}`);
  await symlink(canonical, junctionPath, 'junction');
  const tools = createReadonlyTools({ rootDir: tmpdir(), dshHomeOf: () => junctionPath });
  // 不变式同上：根按字面与真实形态并集判定，联结点拼写的根同样拒止两种目标拼写。
  const p1 = await tools.run('read_file', { path: join(canonical, 'sessions', 'session-1.jsonl') });
  assert.equal(p1.denied, true, '真实路径目标应拒止');
  const p2 = await tools.run('read_file', { path: join(junctionPath, 'sessions', 'session-1.jsonl') });
  assert.equal(p2.denied, true, '联结点拼写目标应拒止');
  // 并集哨兵：别名根下不存在的路径按字面命中——「两侧只比较 realpath」的朴素实现在此失效打开。
  const p3 = await tools.run('read_file', { path: join(junctionPath, 'current-url.txt') });
  assert.equal(p3.denied, true, '联结点根下不存在的路径同样拒止（并集哨兵）');
  // 对照组方向相反：home 为真实根、目标经联结点拼写——检验目标侧归一化（缺失路径须先归一
  // 再判围栏），该组目标必须拒止，与根侧拼写组互补。
  const control = createReadonlyTools({ rootDir: tmpdir(), dshHomeOf: () => canonical });
  const p4 = await control.run('read_file', { path: join(junctionPath, 'sessions', 'session-1.jsonl') });
  assert.equal(p4.denied, true, '对照：真实根下经联结点拼写的目标仍拒止');
});

// ── 热改接线与真实超时（requirements §5.3／design §3.4） ────────────────────

test('setter 现读生效、非法值不改变现值', async () => {
  const seen = [];
  let delayMs = 0;
  const tools = createReadonlyTools({
    rootDir: '.',
    timeoutMs: 5000,
    redact: (text, patterns) => {
      seen.push(patterns);
      return text;
    },
    invoke: () => new Promise((resolvePromise) => {
      setTimeout(() => resolvePromise({ text: 'done', isError: false, denied: false }), delayMs);
    }),
  });
  tools.setRedactPatterns(['aa.+']);
  await tools.run('read_file', { path: 'x' });
  assert.deepEqual(seen.at(-1), ['aa.+']);
  tools.setRedactPatterns(['bb.+']);
  await tools.run('read_file', { path: 'x' });
  assert.deepEqual(seen.at(-1), ['bb.+'], '热改的脱敏清单必须现读');
  tools.setRedactPatterns('not-an-array');
  tools.setRedactPatterns(42);
  await tools.run('read_file', { path: 'x' });
  assert.deepEqual(seen.at(-1), ['bb.+'], '非法清单不得改写现值');

  delayMs = 150;
  tools.setToolTimeoutMs(15);
  const timed = await tools.run('read_file', { path: 'x' });
  assert.equal(timed.isError, true);
  assert.match(timed.text, /超时/);
  tools.setToolTimeoutMs(-1);
  tools.setToolTimeoutMs(Number.NaN);
  const still = await tools.run('read_file', { path: 'x' });
  assert.equal(still.isError, true, '非法超时不得改写现值：仍按 15ms 生效');

  // 单工具超时零值＝立即超时（不是不限时）——挂起任务与同步快任务
  // 都不得赢得竞速：不发起调用、直接按超时返回失败说明。
  delayMs = 0;
  tools.setToolTimeoutMs(0);
  const immediate = await tools.run('read_file', { path: 'x' });
  assert.equal(immediate.isError, true, '0 立即超时');
  assert.match(immediate.text, /超时/u, '超时失败说明在场');
  assert.ok(!immediate.text.includes('done'), '同步快返回的任务结果不得胜出（requirements §4.2 字面立即）');
});

test('超时真实触发：慢任务＋小超时 → 超时形态且结算落在超时值邻域', async () => {
  const tools = createReadonlyTools({
    rootDir: '.',
    timeoutMs: 15,
    invoke: () => new Promise((resolvePromise) => {
      setTimeout(() => resolvePromise({ text: 'done', isError: false, denied: false }), 150);
    }),
  });
  const startedAt = Date.now();
  const result = await tools.run('read_file', { path: 'x' });
  const elapsed = Date.now() - startedAt;
  assert.equal(result.isError, true);
  assert.match(result.text, /超时/);
  assert.ok(elapsed >= 14, `计时器必须真实触发：${elapsed}ms`);
  assert.ok(elapsed < 140, `必须在超时值附近结算而不是等满任务：${elapsed}ms`);
});

test('junction 真建：遍历不进入符号链接目录（建链失败显式红）', async () => {
  const root = await fixture();
  await mkdir(join(root, 'real'), { recursive: true });
  await writeFile(join(root, 'real', 'inside.txt'), 'junction-target\n');
  const link = join(root, 'linkdir');
  await symlink(join(root, 'real'), link, 'junction');
  // 语义钉子：Windows junction 在 readdir({withFileTypes}) 的 Dirent 里报 symlink=true
  // ——walk 防护依赖的正是这一点，这里显式钉住。
  const dirents = await readdir(join(root), { withFileTypes: true });
  const linkEntry = dirents.find((entry) => entry.name === 'linkdir');
  assert.ok(linkEntry, 'junction 建链失败即显式失败，不静默跳过');
  assert.equal(linkEntry.isSymbolicLink(), true, 'Dirent 必须把 junction 报成符号链接（walk 防护的前提）');
  const tools = createReadonlyTools({ rootDir: root });
  const listed = await tools.run('glob', { pattern: '**/*' });
  // 遍历不进入链接目录：链接名本身可作为目录条目出现（与普通子目录同名同权），但目标内容不可达。
  assert.doesNotMatch(listed.text, /linkdir.*inside\.txt/, 'glob 不得进入链接目录');
  assert.match(listed.text, /real.*inside\.txt/, '对照：真实目录内容在列');
  const grepped = await tools.run('grep', { pattern: 'junction-target', path: root });
  // 内容经真实路径本来就可搜到；判据是「命中路径不得经链接」。
  assert.match(grepped.text, /real.*inside\.txt/u, '对照：真实路径可搜到内容');
  assert.doesNotMatch(grepped.text, /linkdir/u, 'grep 命中不得以链接目录为路径');
  // 对照：真实目录内的文件照常可查。
  assert.match((await tools.run('grep', { pattern: 'junction-target', path: join(root, 'real') })).text, /junction-target/);
});

// ── 正则安全判据与工作者线程执行（design §3.4） ──────────────────────────────

test('assertSafePattern 判据④：相邻量词原子连跑 4 拦 3 过，组边界与选择透明、字面量中断', () => {
  // 拦：可变跨度紧邻堆叠（`a*a*a*a*b` 一类病态回溯形态）。
  assert.equal(assertSafePattern('a*a*a*a*b'), 'adjacent quantified atoms');
  assert.equal(assertSafePattern('a*b*c*d*e'), 'adjacent quantified atoms');
  assert.equal(assertSafePattern('.*.*.*.*'), 'adjacent quantified atoms');
  assert.equal(assertSafePattern('[abc]*[def]*[ghi]*[jkl]*'), 'adjacent quantified atoms');
  assert.equal(assertSafePattern('a{2,3}b{2,3}c{2,3}d{2,3}'), 'adjacent quantified atoms');
  // 组边界透明：`a*(?:b*c*d*)e*` 与 `a*b*c*d*e` 同形归一。
  assert.equal(assertSafePattern('a*(?:b*c*d*)e*'), 'adjacent quantified atoms');
  assert.equal(assertSafePattern('(?:a*b*c*)d*'), 'adjacent quantified atoms');
  // 量化组的量化性＝组内末原子带量词：`(a)*(b)*(c)*(d)*` 与裸写 `a*a*a*a*` 同级回溯，同拦。
  assert.equal(assertSafePattern('(a)*(b)*(c)*(d)*'), 'adjacent quantified atoms');
  assert.equal(assertSafePattern('(?:ab)+(?:cd)+(?:ef)+(?:gh)+'), 'adjacent quantified atoms');
  assert.equal(assertSafePattern('a*(?:b)*(?:c)*d*'), 'adjacent quantified atoms', '组量化跨组传导恢复连跑');
  assert.equal(assertSafePattern('(a)*(?:x*)(?:y*)(?:z*)'), 'adjacent quantified atoms', '混合形态与全组形态机械一致');
  assert.equal(assertSafePattern('x*((a))*(b)*(c)*'), 'adjacent quantified atoms', '嵌套量化组的恢复由外层组闭承接');
  // 嵌套组续算按深度入栈：内组首原子不得覆写外层已捕获的组前连跑——同语言异判定消除。
  assert.equal(assertSafePattern('a*b*c*(?:(?:d)e)*'), 'adjacent quantified atoms');
  assert.equal(assertSafePattern('a*b*c*(?:d(?:e))*'), 'adjacent quantified atoms', '内组在后的同语言形态同拦');
  assert.equal(assertSafePattern('a*b*c*((d)y(e))*'), 'adjacent quantified atoms');
  assert.equal(assertSafePattern('a*a*a*((a)(a))*'), 'adjacent quantified atoms', '可利用形：与 a*a*a*(?:aa)* 同级回溯');
  // 多字符转义按整原子消费：`\x41*`×4 与 `A*`×4 同级，不得拆成幻影原子逐次清零连跑。
  assert.equal(assertSafePattern('\\x41*\\x42*\\x43*\\x44*'), 'adjacent quantified atoms');
  assert.equal(assertSafePattern('\\u0041*\\u0042*\\u0043*\\u0044*'), 'adjacent quantified atoms');
  assert.equal(assertSafePattern('\\p{L}*\\p{L}*\\p{L}*\\p{L}*'), 'adjacent quantified atoms');
  assert.equal(assertSafePattern('\\d*\\x41*\\s*\\x42*'), 'adjacent quantified atoms', '转义混排同拦');
  assert.equal(assertSafePattern('[\\x41]*[\\x42]*[\\x43]*[\\x44]*'), 'adjacent quantified atoms', '类内转义对照');
  assert.equal(assertSafePattern('\\x41*\\x42*'), undefined, '两连不过限');
  // `\B` 是宽容零宽（全部内部位置成立、歧义保留），不中断连跑；`\b` 约束切分点仍中断。
  assert.equal(assertSafePattern('a*a*a*\\Ba*'), 'adjacent quantified atoms');
  assert.equal(assertSafePattern('a*a*a*\\ba*'), undefined);
  // 过：三连跑以内，或字面量中断。
  assert.equal(assertSafePattern('a*a*a*b'), undefined);
  assert.equal(assertSafePattern('a*b*c*d'), undefined);
  assert.equal(assertSafePattern('a*(?:b*c*)'), undefined);
  assert.equal(assertSafePattern('(ab)*c*'), undefined);
  assert.equal(assertSafePattern('(a)*(b)*'), undefined, '两个单原子量化组＝两连跑，不过限');
  assert.equal(assertSafePattern('(a)*(b)*(c)*'), undefined, '三个单原子量化组＝三连跑，不过限哨兵');
  assert.equal(assertSafePattern('(?:ab)c*'), undefined, '无量化组＝透明，末原子中断维持');
  assert.equal(assertSafePattern('a*b*c(x)*(y)*'), undefined, '组外无量化原子是真隔断：左右两段各自计数');
  assert.equal(assertSafePattern('a|b|c'), undefined);
  // 既有判据保持：嵌套量词、量词复杂组、反向引用（数字与命名形式整类拒止）。
  assert.equal(assertSafePattern('(a+)+b'), 'quantified complex group');
  assert.equal(assertSafePattern('(?:x|y)*z'), 'quantified complex group');
  assert.equal(assertSafePattern('(a)\\1'), 'backreference');
  assert.equal(assertSafePattern('(?<n>a)\\k<n>'), 'backreference', '命名反向引用同属判据③');
});

test('病态 glob 匹配式在工作者线程回溯，时限到点强制终止且主事件循环保持响应', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsafm-patho-'));
  // 文件名里 `a` 饱和：glob 匹配式 `^a[^/]*a…b$` 的相邻可变跨度产生组合数级回溯。
  await writeFile(join(root, `${'a'.repeat(80)}b.txt`), 'x');
  const tools = createReadonlyTools({ rootDir: root });
  let loopFiredAt = 0;
  const loopScheduledAt = Date.now();
  const loopTimer = setTimeout(() => { loopFiredAt = Date.now(); }, 80);
  const startedAt = Date.now();
  const result = await tools.run(
    'glob',
    { pattern: 'a*a*a*a*a*a*a*a*a*a*a*b' },
    undefined,
    { toolTimeoutMs: 300 },
  );
  const elapsed = Date.now() - startedAt;
  clearTimeout(loopTimer);
  assert.equal(result.isError, true, '病态匹配式必须按失败返回，不得假绿');
  assert.match(result.text, /超时/u, '失败说明按超时口径');
  assert.ok(elapsed < 2500, `时限到点即终止，不等回溯自然结束（实得 ${elapsed}ms）`);
  // 工作者烧 CPU 期间主线程定时器照常按点触发——事件循环未被阻塞。
  assert.ok(loopFiredAt > 0, '响应性探针定时器已触发');
  assert.ok(loopFiredAt - (loopScheduledAt + 80) < 200, `主事件循环保持响应（定时器时延 ${loopFiredAt - loopScheduledAt - 80}ms）`);
});

test('工作者在飞时请求取消 → 按取消口径返回，不等回溯自然结束', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsafm-cancel-'));
  await writeFile(join(root, `${'a'.repeat(80)}b.txt`), 'x');
  const tools = createReadonlyTools({ rootDir: root });
  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = tools.run(
    'glob',
    { pattern: 'a*a*a*a*a*a*a*a*a*a*a*b' },
    controller.signal,
    { toolTimeoutMs: 5000 },
  );
  setTimeout(() => controller.abort('user cancelled'), 120);
  const result = await pending;
  const elapsed = Date.now() - startedAt;
  assert.equal(result.isError, true);
  assert.match(result.text, /取消/u, '取消口径的失败说明');
  assert.ok(elapsed < 2000, `取消即终止工作者（实得 ${elapsed}ms）`);
});

test('grep 的 glob 过滤式在工作者内执行——过滤后命中集与上限说明保持', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsafm-filter-'));
  await writeFile(join(root, 'a.ts'), 'hello alpha\n');
  await writeFile(join(root, 'b.md'), 'hello beta\n');
  const tools = createReadonlyTools({ rootDir: root });
  const filtered = await tools.run('grep', { pattern: 'hello', path: root, glob: '*.ts' });
  assert.equal(filtered.isError, false);
  assert.match(filtered.text, /a\.ts:1: hello alpha/u);
  assert.doesNotMatch(filtered.text, /b\.md/u, '过滤式只保留匹配 glob 的候选');
  const all = await tools.run('grep', { pattern: 'hello', path: root });
  assert.match(all.text, /b\.md:1: hello beta/u, '不带过滤式时全部候选参与');});

test('grep 超长行整行跳过并计数说明（不截断）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsafm-longline-'));
  await writeFile(join(root, 'x.txt'), `${'x'.repeat(600)}needle\nneedle\n`);
  const tools = createReadonlyTools({ rootDir: root });
  const result = await tools.run('grep', { pattern: 'needle', path: join(root, 'x.txt') });
  assert.equal(result.isError, false);
  assert.match(result.text, /x\.txt:2: needle/u, '短行照常命中');
  assert.match(result.text, /跳过 1 个超过 500 字符的超长行，整行跳过、不截断/u, '超长行跳过计数说明在场');
});
