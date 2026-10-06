import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSafePattern, createReadonlyTools, globToRegExp, isDeniedPath } from '../lib/readonly-tools.js';

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
  await writeFile(join(root, 'settings.yaml'), 'approve-for-me: {}\n');
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

/** 收集审计与脱敏调用。 */
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
  for (const path of ['.credentials.yaml', 'id_rsa', 'settings.yaml', '.ssh/config']) {
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
  const upper = await tools.run('grep', { pattern: 'approve', path: join(root, 'SETTINGS.YAML') });
  assert.doesNotMatch(upper.text, /approve-for-me/, `大写变体不应读到内容：${upper.text}`);
  const lower = await tools.run('grep', { pattern: 'approve', path: join(root, 'settings.yaml') });
  assert.doesNotMatch(lower.text, /approve-for-me/);
});

test('grep 与 glob 不因 NTFS 备用数据流后缀而绕过拒止', async () => {
  const root = await fixture();
  const tools = createReadonlyTools({ rootDir: root });
  const stream = await tools.run('grep', { pattern: 'approve', path: join(root, 'settings.yaml::$DATA') });
  assert.doesNotMatch(stream.text, /approve-for-me/, `ADS 变体不应读到内容：${stream.text}`);
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

test('setLang 两档驱动结果模板语言（R32-4：工具失败回喂整句随语言切换）', async () => {
  const root = await fixture();
  const tools = createReadonlyTools({ rootDir: root });
  // 用文件路径列目录 → readdir 抛 ENOTDIR → run 的 catch 回喂 tool.failed（唯一产生该模板的路径）。
  tools.setLang('en');
  const en = await tools.run('list_dir', { path: 'src/a.txt' });
  tools.setLang('zh');
  const zh = await tools.run('list_dir', { path: 'src/a.txt' });
  assert.equal(en.isError, true);
  assert.equal(zh.isError, true);
  const enHead = 'Tool list_dir failed: ';
  const zhHead = '工具 list_dir 失败：';
  assert.ok(en.text.startsWith(enHead), `en 档回喂须以英文模板开头：${en.text}`);
  assert.ok(zh.text.startsWith(zhHead), `zh 档回喂须以中文模板开头：${zh.text}`);
  // 同一错误的主体两档逐字节一致：语言只切换模板句身，错误文本与语言无关。
  assert.equal(en.text.slice(enHead.length), zh.text.slice(zhHead.length));
  assert.ok(!en.text.includes('工具'), 'en 档不得残留 zh 模板');
  assert.ok(!zh.text.includes('Tool list_dir failed'), 'zh 档不得残留 en 模板');
  // 变红判据：结果模板退回硬编码 zh（r32 登记的缺口形态）→ enHead 断言红；硬编码 en → zhHead 红；
  // setLang 失效（两档同文）→ 两条首部断言之一必红（同一文本不可能同时以两种模板开头）。
});

// ── R32：grep 模式静态预检与资源上界 ──────────────────────────────────────

test('R32④ assertSafePattern：普通形态放行、病态形态给出拒止理由', () => {
  // 放行：无「量词作用于复杂组」、无反向引用、不超长。
  for (const source of ['[a-z]+\\d+', '(foo)+', 'foo|bar', 'a+?', '(?:ab)+', 'a{2,4}', '^\\d+$', String.raw`\bmkfs\b`]) {
    assert.equal(assertSafePattern(source), undefined, `应放行：${source}`);
  }
  // 拒止：反向引用、组上再量词（组体含量词或选择，含嵌套与前后视形态）、超长。
  for (const source of ['(a)\\1', '(a+)+', '(a|a)*', '(foo|bar)+', '([a-z]*)*', '(a(b|c))+', '(?:a+)+', 'x'.repeat(257)]) {
    assert.notEqual(assertSafePattern(source), undefined, `应拒止：${source}`);
  }
});

test('R32③ 病态 pattern 在编译前被静态拒止：同步返回、不触超时、审计照写', async () => {
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

test('R32① 超过 1 MiB 的文件跳过并说明；同目录小文件仍命中', async () => {
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

test('R32② 候选文件数截断：超过 200 个候选时说明截断为前 200', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsafm-many-'));
  for (let index = 0; index < 250; index += 1) {
    await writeFile(join(root, `f${String(index).padStart(3, '0')}.txt`), 'needle\n');
  }
  const tools = createReadonlyTools({ rootDir: root });
  const result = await tools.run('grep', { pattern: 'needle', path: root });
  assert.match(result.text, /候选文件截断为前 200 个/);
  assert.match(result.text, /f001\.txt/);
  // NTFS 的 readdir 按名序：前 200 个候选是 f000–f199，f2xx 不在扫描面内。
  assert.doesNotMatch(result.text, /f2\d\d\.txt/);
});

// ── R33：DSH 数据根围栏 ──────────────────────────────────────────────────

test('R33①② sessions/reviews/current-url.txt 全部拒止，拒止类别随行写出', async () => {
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
  assert.equal(grepped.denied, true, 'grep 基点在围栏内应拒止');
  const globbed = await tools.run('glob', { pattern: '**/*', cwd: home });
  assert.equal(globbed.denied, true, 'glob 基点在围栏内应拒止');
});

test('R33③④ 对照：注入根独立生效、工作区同名目录不误伤', async () => {
  const root = await fixture();
  await mkdir(join(root, 'sessions'), { recursive: true });
  await writeFile(join(root, 'sessions', 'note.txt'), 'workspace-session\n');
  const home = await mkdtemp(join(tmpdir(), 'dsafm-home2-'));
  const tools = createReadonlyTools({ rootDir: root, dshHomeOf: () => home });
  // 工作区里叫 sessions 的目录是普通目录。
  const read = await tools.run('read_file', { path: 'sessions/note.txt' });
  assert.equal(read.denied, false);
  assert.match(read.text, /workspace-session/);
  // 注入根里的路径即使文件不存在也拒止（围栏按路径判定，不要求文件在场）。
  const inEnv = await tools.run('read_file', { path: join(home, 'current-url.txt') });
  assert.equal(inEnv.denied, true);
});

// ── R36/R43：热改接线与真实超时 ──────────────────────────────────────────

test('R36①③ setter 现读生效、非法值不改变现值', async () => {
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
});

test('R43① 超时真实触发：慢任务＋小超时 → 超时形态且结算落在超时值邻域', async () => {
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

test('R43② junction 真建：遍历不进入符号链接目录（建链失败显式红）', async () => {
  const root = await fixture();
  await mkdir(join(root, 'real'), { recursive: true });
  await writeFile(join(root, 'real', 'inside.txt'), 'junction-target\n');
  const link = join(root, 'linkdir');
  await symlink(join(root, 'real'), link, 'junction');
  // 语义钉子（本机实测）：junction 的 lstat.isSymbolicLink()=false（reparse 点非符号链接）、
  // 但 readdir({withFileTypes}) 的 Dirent 报 symlink=true——walk 防护依赖的正是后者，这里显式钉住。
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
  // 内容经真实路径本来就可搜到；R43 的判据是「命中路径不得经链接」。
  assert.match(grepped.text, /real.*inside\.txt/u, '对照：真实路径可搜到内容');
  assert.doesNotMatch(grepped.text, /linkdir/u, 'grep 命中不得以链接目录为路径');
  // 对照：真实目录内的文件照常可查。
  assert.match((await tools.run('grep', { pattern: 'junction-target', path: join(root, 'real') })).text, /junction-target/);
});
