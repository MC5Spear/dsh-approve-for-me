/**
 * 文本字典守护（requirements §5.4）：lib/agent-texts.js 的结构与语义断言。
 * design §7.5：键集相等（可变红——给单侧加键必红）、冻结、未知 lang 抛错、缺键抛错、
 * 不变块两语言逐字节一致、en 拒绝末句＝codex 原文、超时文案不含末句（requirements §4.3）。
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AGENT_LANGS, AGENT_TEXT_KEYS, agentText, agentT, OUTPUT_CONTRACT, UNTRUSTED_NOTICE, REJECTION_INSTRUCTIONS_EN, REJECTION_INSTRUCTIONS_ZH } from '../lib/agent-texts.js';
import { errorText } from '../lib/gate.js';
import { buildSystem, buildUserTexts, tenantPolicy, systemPromptTemplate, toolBudgetExhausted, SYSTEM_PROMPT_TEMPLATE, TOOL_BUDGET_EXHAUSTED } from '../lib/prompt.js';

test('AGENT_LANGS 恰为 [zh, en] 且冻结', () => {
  assert.deepEqual([...AGENT_LANGS], ['zh', 'en']);
  assert.ok(Object.isFrozen(AGENT_LANGS));
});

test('grep 工具描述写明整行跳过边界与跳过计数（design §3.4，与 worker 行为一致）', () => {
  // 关键事实断言（等义改写可过）：两语言都必须说明超长行整行跳过（不是截断）且结果报告跳过数。
  // 实现依据：lib/regex-worker.mjs 超过 maxLineChars 的行在匹配前整行跳过并回传 skippedLong；
  // 结果后缀由 tool.grepSkippedLong 渲染。
  for (const lang of AGENT_LANGS) {
    const grep = agentT(lang, 'tool.schemas').find((tool) => tool.name === 'grep');
    assert.ok(grep, `${lang} 档存在 grep 工具`);
    const joined = grep.description.replace(/\s+/gu, ' ');
    assert.match(joined, /100/u, `${lang}：命中数上限在场`);
    assert.match(joined, /500/u, `${lang}：行长阈值在场`);
    if (lang === 'zh') {
      assert.match(joined, /整行跳过/u, `${lang}：整行跳过（非截断）`);
      assert.match(joined, /不截断/u);
      assert.match(joined, /报告跳过/u, `${lang}：结果报告跳过数`);
    } else {
      assert.match(joined, /skipped whole/u, `${lang}: skipped whole, not truncated`);
      assert.match(joined, /not truncated/u);
      assert.match(joined, /reports the skipped count/u);
    }
  }
});

test('两语言键集一一对应（单侧加键必红）', () => {
  assert.deepEqual([...AGENT_TEXT_KEYS.zh], [...AGENT_TEXT_KEYS.en]);
  // 反向对照：证明比较器本身在工作——把键集复制后增删，差集非空。
  const probe = new Set(AGENT_TEXT_KEYS.zh);
  probe.add('probe.only');
  assert.notDeepEqual([...probe].sort(), [...AGENT_TEXT_KEYS.en].sort());
});

test('两语言命名空间对象冻结', () => {
  assert.ok(Object.isFrozen(agentText('zh')));
  assert.ok(Object.isFrozen(agentText('en')));
});

test('agentText：未知语言抛错', () => {
  assert.throws(() => agentText('fr'), /unknown lang/u);
  assert.throws(() => agentText(undefined), /unknown lang/u);
});

test('agentT：缺键抛错，无静默回退（不落另一语言的词）', () => {
  assert.throws(() => agentT('zh', 'no.such.key'), /missing key/u);
  assert.throws(() => agentT('en', 'agent.systemPrompt.x'), /missing key/u);
  // 缺键抛的是键名与语言，不是值——错误信息里能定位。
  try {
    agentT('zh', 'no.such.key');
    assert.fail('should have thrown');
  } catch (error) {
    assert.match(error.message, /no\.such\.key/u);
    assert.match(error.message, /zh/u);
  }
});

test('不变块两语言逐字节一致：输出契约与不可信声明行', () => {
  assert.equal(agentText('zh')['agent.outputContract'], agentText('en')['agent.outputContract']);
  assert.equal(agentText('zh')['agent.untrustedNotice'], agentText('en')['agent.untrustedNotice']);
  assert.equal(agentText('en')['agent.outputContract'], OUTPUT_CONTRACT);
  assert.equal(agentText('en')['agent.untrustedNotice'], UNTRUSTED_NOTICE);
});

test('系统提示两语言不同且都含租户策略占位；en 模板＝兼容导出', () => {
  const zh = systemPromptTemplate('zh');
  const en = systemPromptTemplate('en');
  assert.notEqual(zh, en, 'zh/en 系统提示必须是两份文本');
  assert.ok(zh.includes('{{ tenant_policy_config }}'));
  assert.ok(en.includes('{{ tenant_policy_config }}'));
  assert.equal(en, SYSTEM_PROMPT_TEMPLATE, '兼容导出必须与 en 档同源');
  // 反引号字段名（schema 标识符）在 zh 档里保持原样（不变块口径）。
  for (const token of ['`risk_level`', '`user_authorization`', '`outcome`', 'read_file', 'list_dir', 'glob', 'grep']) {
    assert.ok(zh.includes(token), `zh 系统提示应原样保留 ${token}`);
    assert.ok(en.includes(token), `en 系统提示应含 ${token}`);
  }
  assert.ok(zh.includes('<truncated ... />') && en.includes('<truncated ... />'));
});

test('租户策略：两语言文件都可读入且内容不同', () => {
  const zh = tenantPolicy('zh');
  const en = tenantPolicy('en');
  assert.ok(zh.length > 200, 'zh 策略有正文');
  assert.ok(en.length > 200, 'en 策略有正文');
  assert.notEqual(zh, en);
  assert.match(zh, /租户安全策略/u);
  assert.match(en, /Tenant Security Policy/u);
});

test('buildSystem：拼接模板+策略+契约，两语言各自成篇', () => {
  const en = buildSystem('en');
  assert.ok(en.includes('You are judging one planned coding-agent action.'));
  assert.ok(en.endsWith(OUTPUT_CONTRACT));
  const zh = buildSystem('zh');
  assert.ok(zh.includes('你在判定一条编程代理计划执行的动作。'));
  assert.ok(zh.endsWith(OUTPUT_CONTRACT), '输出契约是不变块，zh 档同样以它收尾');
  assert.notEqual(en, zh);
});

test('拒绝文本：en 末句＝codex REJECTION_INSTRUCTIONS 原文；zh 末句三段与其逐句等价', () => {
  const enReject = agentT('en', 'gate.reject.body');
  assert.ok(enReject.endsWith(REJECTION_INSTRUCTIONS_EN), 'en 拒绝末句必须是 codex 原文');
  assert.match(REJECTION_INSTRUCTIONS_EN, /must not attempt to achieve the same outcome via workaround/u);
  const zhReject = agentT('zh', 'gate.reject.body');
  assert.match(zhReject, /不要用等价手段绕过该拒绝/u);
  // zh 末句三段与 en 三句一一对应：禁止绕过／更安全方案或明确批准／否则停止并请求输入（requirements §4.3）。
  const segments = REJECTION_INSTRUCTIONS_ZH.slice(0, -1).split('；');
  assert.equal(segments.length, 3, 'zh 拒绝末句必须三段，缺段即安全指令弱于 en 档');
  assert.match(REJECTION_INSTRUCTIONS_ZH, /否则停止并请求用户输入。$/u, '第三段＝安全停止指令（en「Otherwise, stop and request user input.」）');
  assert.ok(zhReject.endsWith(REJECTION_INSTRUCTIONS_ZH), 'zh 拒绝正文以末句定稿常量收尾');
});

test('超时文案（两语言）都不含「绕过拒绝」末句（requirements §4.3）', () => {
  for (const lang of ['zh', 'en']) {
    const body = agentT(lang, 'gate.timeout.body');
    assert.ok(!body.includes(REJECTION_INSTRUCTIONS_EN), `${lang} 超时文案不得含 en 拒绝末句`);
    assert.ok(!/不要用等价手段绕过该拒绝/u.test(body), `${lang} 超时文案不得含 zh 拒绝末句`);
    assert.match(body, /重试|retry/ui, `${lang} 超时文案要点明可重试`);
  }
});

test('通道故障模板：两语言结构一致、含防风暴指引、不含拒绝末句；errorText 渲染 {reason}', () => {
  const zh = agentT('zh', 'gate.error.body');
  const en = agentT('en', 'gate.error.body');
  // 结构与超时模板平行：首行前缀＋原因行＋说明行＋末行处置指引（四行）。
  for (const [lang, body] of [['zh', zh], ['en', en]]) {
    assert.ok(body.startsWith('[approve-for-me] '), `${lang} 首行须为 [approve-for-me] 前缀`);
    assert.equal(body.split('\n').length, 4, `${lang} 四行结构与超时模板平行`);
    assert.ok(!body.includes(REJECTION_INSTRUCTIONS_EN), `${lang} 通道故障文案不得含 en 拒绝末句`);
    assert.ok(!/不要用等价手段绕过该拒绝/u.test(body), `${lang} 通道故障文案不得含 zh 拒绝末句`);
    assert.match(body, /重试|retry/ui, `${lang} 通道故障文案要点明可重试`);
  }
  // 占位集两语言一致（换占位名会在对侧丢词）。
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/gu)].map((m) => m[1]).sort().join(',');
  assert.equal(placeholders(zh), placeholders(en), 'gate.error.body 占位集两语言必须一致');
  assert.equal(placeholders(zh), 'reason');
  // 防风暴指引（不可裁剪项）：末行不得写成无限重试许可。
  assert.match(zh, /不要连续反复重试.*把故障报告用户/u);
  assert.match(en, /do not keep retrying in a row; report the failure to the user/u);
  // errorText 渲染：reason 原文进 {reason} 位，缺省落 gate.noReason，两语言各自成句。
  assert.match(errorText('attempt 2/2: empty payload', 'zh'), /^原因：attempt 2\/2: empty payload$/mu);
  assert.match(errorText('x', 'en'), /^Reason: x$/mu);
  assert.match(errorText(undefined, 'zh'), /原因：未提供原因/u);
  assert.doesNotMatch(errorText('x', 'zh'), /风险：/u, '通道故障模板不带 deny 的风险/授权行');
});

test('轮次用尽指令：两语言各自成句且互不残留；兼容导出＝zh 现行', () => {
  const zh = toolBudgetExhausted('zh');
  const en = toolBudgetExhausted('en');
  assert.match(zh, /工具轮次已用完/u);
  assert.match(en, /The tool round budget is exhausted/u);
  assert.ok(!zh.includes('exhausted'));
  assert.ok(!/轮次/.test(en));
  assert.equal(TOOL_BUDGET_EXHAUSTED, zh);
});

test('工具 Schema：结构同形（字段名/上限/必填），描述各语言不同', () => {
  const zh = agentT('zh', 'tool.schemas');
  const en = agentT('en', 'tool.schemas');
  assert.equal(zh.length, en.length);
  const shape = (schemas) => schemas.map((tool) => ({
    name: tool.name,
    required: tool.parameters.required,
    props: Object.keys(tool.parameters.properties),
    minimums: Object.values(tool.parameters.properties).map((p) => p.minimum ?? null),
  }));
  assert.deepEqual(shape(zh), shape(en), '结构是不变块：字段名、必填、上限必须同形');
  assert.notEqual(zh[0].description, en[0].description, '描述必须分语言');
  assert.match(zh[0].description, /读取/u);
  assert.match(en[0].description, /Read a UTF-8/u);
});

test('工具结果模板：两语言占位集一致（换参名会在对侧丢词）', () => {
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/gu)].map((m) => m[1]).sort().join(',');
  const zh = agentText('zh');
  const en = agentText('en');
  for (const key of AGENT_TEXT_KEYS.zh.filter((k) => k.startsWith('tool.') && k !== 'tool.schemas')) {
    assert.equal(placeholders(zh[key]), placeholders(en[key]), `键 ${key} 的占位集两语言必须一致`);
  }
  // 截断后缀键里不得复含不变块标记（标记由代码拼）。
  for (const lang of ['zh', 'en']) {
    assert.ok(!agentT(lang, 'tool.truncatedDirSuffix').includes('<truncated'));
  }
});

test('buildUserTexts：动作段衔接行按 lang 切换，两档首行不同（两语言行为差异）', () => {
  const input = { evidence: 'EVIDENCE', action: { toolName: 'pwsh', command: 'npm i', cwd: 'C:/work', mode: 'danger-full-access', justification: 'test' } };
  const zh = buildUserTexts(input, 'zh');
  const en = buildUserTexts(input, 'en');
  assert.equal(zh.actionText.split('\n')[0], '计划动作 JSON：', 'zh 档衔接行须为中文标题');
  assert.equal(en.actionText.split('\n')[0], 'Planned action JSON:', 'en 档衔接行须为英文标题');
  assert.notEqual(zh.actionText, en.actionText, '两档 actionText 必须是两份文本');
  assert.ok(!en.actionText.includes('计划动作'), 'en 档不得残留 zh 档标题');
  assert.ok(!zh.actionText.includes('Planned action'), 'zh 档不得残留 en 档标题');
  // 衔接行之外的动作 JSON 主体两档逐字节一致（语言只切标题行），证据段与语言无关。
  const body = (value) => value.split('\n').slice(1).join('\n');
  assert.equal(body(zh.actionText), body(en.actionText));
  assert.equal(zh.evidenceText, en.evidenceText);
  // 变红判据：若 buildUserTexts 退回硬编码 en 衔接行，zh 首行等值断言红；
  // 若 lang 参数断裂（两档同文），notEqual 与两条互不残留断言红。
});

test('字典外无残留硬编码送模文本（静态扫描：锚短语只许住在 agent-texts.js）', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const libDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib');
  // 锚短语取送模文本的特征句（拒绝/放行/超时注入正文、轮次用尽指令、动作段衔接行、
  // 回喂模板）；审计 reason 的合法中文（字典排除项，如 index.js 的「应答者逃逸异常：」）
  // 不在锚集里，不会误伤。
  const anchors = [
    '本次升权请求被拒绝',
    '已自动放行一项超出当前权限的操作',
    '自动审批未在时限内完成',
    '工具参数不是合法 JSON',
    '计划动作 JSON：',
    'Planned action JSON:',
    '工具轮次已用完',
    'The tool round budget is exhausted',
    // 工具失败模板：模板句身的两种源码形态各作锚——占位符写法 {name} 与模板字面量写法 ${name}，
    // 消费方无论用哪种形式硬编码回喂句，都会离开字典出现在消费文件里被扫出。
    '工具 {name} 失败',
    'Tool {name} failed',
    '工具 ${name} 失败',
    'Tool ${name} failed',
  ];
  const scan = (source) => anchors.filter((phrase) => source.includes(phrase));
  // 反例先行（能失败的证明）：对每一个锚短语，含它的硬编码串都必须命中——写错或写丢的锚在此红，不静默失明。
  for (const phrase of anchors) {
    assert.deepEqual(scan('const text = "x' + phrase + 'y";'), [phrase]);
  }
  const offenders = [];
  for (const file of readdirSync(libDir)) {
    if (!file.endsWith('.js') || file === 'agent-texts.js') continue;
    const hits = scan(readFileSync(join(libDir, file), 'utf8'));
    if (hits.length > 0) offenders.push(`${file}: ${hits.join(', ')}`);
  }
  assert.deepEqual(offenders, [], `送模文本句身必须只住在字典（design §7.5）：\n${offenders.join('\n')}`);
  // 变红判据：把任一消费方（index/reviewer/prompt/gate）改回内联硬编码句——即「故意留一处」——
  // 对应锚短语离开字典出现在消费文件，本扫描必红；这正是字典化要堵住的那类缺口。
});
