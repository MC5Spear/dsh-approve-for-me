/**
 * copy-facts 检查器的正反例测试（事实与显示分别保护，措辞不冻结）。
 *
 * 正例＝真正换措辞的中英文文案（非原句重排：概念顺序、句式、用词均与 client.js 现行文案不同），
 * 经同一 copyFactFailures 必须通过；反例＝逐项缺事实、零空含义反转、改单位、删占位符／改次数、
 * 丢条件，同一检查必须报出对应失败。U+2060 显示保护独立检验：语义归一后事实仍过，但删掉
 * 连接符的中文 token 文案必须红显示检查；带防拆连接符的换措辞正例显示检查也过。
 * 只证明所列事实与正反例，不证明自然语言全等义；普通短句不做整句冻结。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { COPY_FACTS, FACT_KINDS, copyFactFailures, tokenRiskDisplayProtected } from './helpers/copy-facts.mjs';
import { checkModeHelpFacts } from './helpers/mode-copy-facts.mjs';

const fails = (key, lang, text) => copyFactFailures(key, lang, text);

test('登记事实职责完整：134不同事实恰好各属一个主类', () => {
  const actual = [...new Set(Object.values(COPY_FACTS).flatMap((facts) => facts.map((fact) => fact.id)))].sort();
  const classified = Object.values(FACT_KINDS).flat();
  assert.equal(actual.length, 134);
  assert.equal(new Set(classified).size, classified.length, '分类不能重复占位');
  assert.deepEqual(classified.sort(), actual, '所有当前事实都须显式分类，不以分类代替行为反例');
});

// ── 正例：真正换措辞的中英文文案（同一检查器通过） ────────────────────────────

test('hint 类换措辞正例：timeout 两键中英通过（单位＋零值语义）', () => {
  assert.deepEqual(fails('hint.reviewer.timeoutMs', 'zh', '自动审查最多等待多少毫秒（ms）。等待上限填 0 会立即超时，不留任何等待时间。'), []);
  assert.deepEqual(fails('hint.reviewer.timeoutMs', 'en', 'How long (in ms) the automatic review may wait at most. A value of 0 times out immediately, with no waiting at all.'), []);
  assert.deepEqual(fails('hint.human.timeoutMs', 'zh', '等人工作答最多多少毫秒（ms）？这个值是上限；填 0 则立即拒绝。'), []);
  assert.deepEqual(fails('hint.human.timeoutMs', 'en', 'The most milliseconds (ms) to wait for a human answer; 0 rejects at once.'), []);
});

test('help 类换措辞正例：mode／timeout／allowEscalationTo／inject／tools 中英通过', () => {
  assert.deepEqual(fails('help.mode', 'zh', '开启后由插件接管审批：先做规则筛查，再交模型独立审查。关闭时插件不进行任何接管，效果与未安装它相同；宿主自身的审批流程保持原样。'), []);
  assert.deepEqual(fails('help.mode', 'en', 'When on, the plugin takes over approvals: a rule screen first, then an independent LLM review. When off, it does not take over at all — the effect is the same as if it were not installed, and the host approval flow is left untouched.'), []);
  assert.deepEqual(
    fails(
      'help.reviewer.timeoutMs',
      'zh',
      '自动审查的等待时间上限，以毫秒计。预算覆盖从装配到取得结论的全过程：排队另按单独计时，不消耗这份预算；内部重试也不会再获得新的时限。一旦超时就按拒绝结算并注明发生的环节，这并不是危险判定。把值设为 0 表示立即超时；想要更长的等待就调大数值。',
    ),
    [],
  );
  assert.deepEqual(
    fails(
      'help.reviewer.timeoutMs',
      'en',
      'The wait limit for an automatic review, counted in milliseconds (ms). The budget covers the whole journey from assembly to the review\'s conclusion: queue time is clocked separately and does not consume this budget; internal retries are never handed a fresh time budget. On timeout the request settles as a rejection naming the stage where it happened — this is not a danger verdict. Setting the value to 0 times out immediately; raise it when you expect longer waits.',
    ),
    [],
  );
  assert.deepEqual(
    fails(
      'help.allowEscalationTo',
      'zh',
      '本项设定自动批准所能给出的最高权限，只是圈定可送审、可允许的升权范围；范围内的请求照样要过规则检查和模型审查，绝不是无条件全批。默认的完全访问最宽；选工作区内修改时，比工作区写入更高的升权一律不放行。',
    ),
    [],
  );
  assert.deepEqual(
    fails(
      'help.allowEscalationTo',
      'en',
      'This sets the highest permission auto-approval may hand out; it merely bounds which escalations may be reviewed or allowed. Anything in range still passes the rule checks and the model review — never a blanket approval of everything. Full access, the default, is the widest; workspace write never lets an escalation beyond workspace writes through.',
    ),
    [],
  );
  assert.deepEqual(fails('help.ui.inject', 'zh', '选「允许、拒绝、超时和故障」＝这四类全部发给执行助手；选「仅拒绝、超时和故障」＝允许那一类不发送；选「不发送」＝任何一条都不发。审查记录视图的显示与此开关无关。'), []);
  assert.deepEqual(fails('help.ui.inject', 'en', 'Pick "allow, deny, timeout and failures" and all four kinds reach the agent; pick "deny, timeout and failures only" and the allow notices are not sent; pick "send none" and not a single one goes out. What the review-log view shows has nothing to do with this switch.'), []);
  assert.deepEqual(fails('help.tools', 'zh', '哪些工具交给自动审批：每行写一个名字。清单留空＝覆盖所有工具的升权；一旦填了，就只办理名单之内的工具，其余工具仍走宿主自己的流程。'), []);
  assert.deepEqual(fails('help.tools', 'en', 'Write one tool on each line. Once filled in, only the listed tools enter automatic review; unlisted tools retain the host flow. An empty list handles every tool.'), []);
});

test('错误说明换措辞正例：预设缺失标签与目录不可用、行级重复条件中英通过', () => {
  assert.deepEqual(fails('card.presets.missing', 'zh', '配置里存在、宿主当前预设表里没有的预设：'), []);
  assert.deepEqual(fails('card.presets.missing', 'en', 'Still in the config but missing from the host\'s current preset table: '), []);
  assert.deepEqual(
    fails('card.presets.unavailable', 'zh', '预设目录当前读不到。可能的原因包括：权限预设服务缺失、读取时失败、或没有任何可用的预设信息；可先确认该服务可用，然后重试。'),
    [],
  );
  assert.deepEqual(
    fails('card.presets.unavailable', 'en', 'The preset catalog cannot be read right now. Possible causes include a missing service for permission presets, a read that failed, or no preset information at all; check that the service works, then retry.'),
    [],
  );
  assert.deepEqual(fails('card.map.duplicate', 'zh', '该匹配条件重复了：同一作用范围加同一执行助手模型只允许一条规则。'), []);
  assert.deepEqual(fails('card.map.duplicate', 'en', 'This match condition is duplicated: a single scope plus one agent model admits only one rule.'), []);
});

test('模型 warning 换措辞正例：global 与 globalUnset 中英通过（占位符保持）', () => {
  assert.deepEqual(fails('warn.modelIssue.global', 'zh', '默认的审查模型当前不可用：{reason}。本次实际使用：{effective}。'), []);
  assert.deepEqual(fails('warn.modelIssue.global', 'en', 'The default reviewer model is unavailable right now: {reason}. In use this time: {effective}.'), []);
  assert.deepEqual(
    fails(
      'warn.modelIssue.globalUnset',
      'zh',
      '默认审查模型还没有设置：只有当解析确实落到全局默认这一层（既没有生效的会话选择，也没有生效的映射）时，审查才会跟随执行助手当前使用的模型，并以独立于执行助手会话的一次调用发起。',
    ),
    [],
  );
  assert.deepEqual(
    fails(
      'warn.modelIssue.globalUnset',
      'en',
      'The default reviewer model is not set: only when resolution truly falls through to the global default layer (no effective session choice and no effective rule in play) does the review follow the model the agent is currently using, issued as a call independent of the agent\'s session.',
    ),
    [],
  );
});

test('composer.title 换措辞正例：本会话范围＋独立调用中英通过', () => {
  assert.deepEqual(fails('composer.title', 'zh', '本会话的审查模型：审查调用独立于执行助手发起；在这里挑选可以只给这一个会话指定模型。'), []);
  assert.deepEqual(fails('composer.title', 'en', 'This session\'s reviewer model: review calls go out independently of the agent; pick one here to override the model for this session only.'), []);
});

test('保留说明换措辞正例：view.retention 中英通过（窗口默认值与配置键保持精确）', () => {
  assert.deepEqual(
    fails(
      'view.retention',
      'zh',
      '记录跟着产出它的会话走。界面每次回读的是最近一个窗口，默认 200 条（由 ui.trace.maxRecords 配置）；单个会话的文件一旦超过窗口的四倍就触发轮转，只留下最近窗口、更早的记录在此时删除；会话文件数量超过上限时删最旧的那些。需要长期保存请在轮转之前先备份；调低采集量并不会删除已有记录。',
    ),
    [],
  );
  assert.deepEqual(
    fails(
      'view.retention',
      'en',
      'Records stay with the session that produced them. Each read-back shows the latest window, 200 entries by default (configurable through ui.trace.maxRecords); once a single session\'s file passes four times the window, rotation kicks in — only the latest window is kept and older entries are deleted at that point; when session files pass the cap, the oldest ones go first. Back things up before rotation if you need them long-term; turning capture down never deletes records that already exist.',
    ),
    [],
  );
});

// ── token 类：语义归一过 U+2060、显示保护独立检验 ────────────────────────────

test('token 类：现行中文文案删连接符后事实仍过、显示保护必红', () => {
  const hintZh = '审查输出的 token 上限（token 是模型计量文本的单位）；0 不向模型传输出上限，由模型或供应商默认值决定；推理模型可能先把额度用于推理，上限过小可能导致没有有效结论。';
  const helpZh = 'token 是模型计量文本的单位。本项设置审查输出的 token 上限。0 不向模型传输出上限，由模型或供应商默认值决定。推理模型可能先把额度用于推理，上限过小可能导致没有有效结论（正文为空，按审查故障处理）；具体数值因模型与推理强度而异。';
  for (const [key, text] of [['hint.reviewer.maxTokens', hintZh], ['help.reviewer.maxTokens', helpZh]]) {
    assert.deepEqual(fails(key, 'zh', text), [], `${key} 删连接符后语义事实应仍过（U+2060 只影响显示）`);
    assert.equal(tokenRiskDisplayProtected(text), false, `${key} 删连接符后显示保护必须红`);
  }
});

test('token 类：带防拆连接符的换措辞正例事实与显示保护都过', () => {
  const rewordedZh = '审查输出最多允许多少 token（token 是模型用来计量文本大小的单位）。上限填 0 时不传任何输出上限，改由所用模型或供应商的默认值决定；推理可能先把额度耗在推理上，上限设得过小可能得\u2060不\u2060到\u2060有\u2060效\u2060结\u2060论。具体阈值随所用模型与推理强度而变。';
  assert.deepEqual(fails('help.reviewer.maxTokens', 'zh', rewordedZh), []);
  assert.equal(tokenRiskDisplayProtected(rewordedZh), true, '换措辞正例保留防拆连接符，显示保护应过');
  const alternative = rewordedZh.replace('得\u2060不\u2060到\u2060有\u2060效\u2060结\u2060论', '无\u2060可\u2060用\u2060结\u2060论');
  assert.deepEqual(fails('help.reviewer.maxTokens', 'zh', alternative), []);
  assert.equal(tokenRiskDisplayProtected(alternative), true, '无可用结论等义表达的整段保护也应通过');
  assert.deepEqual(
    fails(
      'hint.reviewer.maxTokens',
      'en',
      'A token is the unit a model uses to measure text; this sets how many tokens the review output may use. At 0 no cap is sent to the model — the model or provider default applies instead. Reasoning may eat the budget before anything else, so too small a cap can end with no usable conclusion.',
    ),
    [],
  );
});

test('显示反例：防拆字符错位或只覆盖风险的一部分都不能通过', () => {
  const bare = '审查输出的 token 上限（token 是模型计量文本的单位）；0 不向模型传输出上限，由模型或供应商默认值决定；推理模型可能先把额度用于推理，上限过小可能导致没有有效结论。';
  for (const wrong of [
    bare.replace('上限过小', '上\u2060限\u2060过小'),
    bare.replace('没有有效结论', '没\u2060有有效结论'),
    bare.replace('没有有效结论', '没有有\u2060效\u2060结\u2060论'),
    bare.replace('没有有效结论', '没\u2060有\u2060有\u2060效结论'),
  ]) {
    assert.deepEqual(fails('hint.reviewer.maxTokens', 'zh', wrong), [], '错位显示不应误报语义事实');
    assert.equal(tokenRiskDisplayProtected(wrong), false, '否定、有效性及结论须位于同一防拆段');
  }
});

// ── 反例：同一 copyFactFailures 必须报出对应失败（能失败性） ──────────────────

test('反例：逐项缺事实报对应失败', () => {
  assert.ok(fails('hint.tools', 'zh', '纳入自动审批的工具，每行一个。').includes('空清单覆盖全部'), '缺「空清单覆盖全部」应报失败');
  assert.ok(fails('help.tools', 'zh', '纳入自动审批的工具，每行一个；空清单覆盖全部工具。').includes('填写后只处理名单内'), '缺「填写后只处理名单内工具」应报失败');
  assert.ok(fails('help.ui.inject', 'zh', '选「允许、拒绝、超时和故障」＝四类都发送；选「仅拒绝、超时和故障」＝允许不发送。').includes('记录视图独立'), '缺「审查记录视图独立」应报失败');
  assert.ok(fails('card.presets.missing', 'zh', '配置中存在：').includes('配置在场但当前表缺失'), '缺「当前表缺失」应报失败');
  assert.ok(fails('hint.denyPatterns', 'zh', '每行一条正则表达式；命中即直接拒绝。').includes('模型人工不能推翻'), '缺「模型与人工不能推翻」应报失败');
});

test('反例：零值含义反转报失败（0 不是无限／照常裁剪＝错）', () => {
  assert.ok(fails('hint.reviewer.timeoutMs', 'zh', '自动审查的等待上限（毫秒）；0 表示永不超时。').includes('零立即超时'), '「0 永不超时」反转零值语义应报失败');
  assert.ok(fails('hint.ui.injectMaxBytes', 'zh', '单条通知的字节上限；0 也照常裁剪。').includes('零不裁剪'), '「0 也照常裁剪」反转零值语义应报失败');
  assert.ok(fails('help.human.timeoutMs', 'zh', '人工作答的等待上限（毫秒）；0 表示无限等待。').includes('零拒绝非无限'), '「0 无限等待」反转应报失败');
});

test('反例：改单位报失败（毫秒／ms 换成秒／s）', () => {
  assert.ok(fails('hint.reviewer.timeoutMs', 'zh', '自动审查的等待上限（秒）；0 立即超时。').includes('毫秒单位'), '毫秒改秒应报失败');
  assert.ok(fails('hint.reviewer.timeoutMs', 'en', 'Auto-review wait limit (s); 0 times out immediately.').includes('毫秒单位'), 'ms 改 s 应报失败');
});

test('反例：删占位符或改次数报占位符失败', () => {
  assert.ok(fails('warn.modelIssue.global', 'zh', '默认审查模型不可用。实际使用：{effective}。').includes('占位符名称或次数'), '删 {reason} 应报占位符失败');
  assert.ok(fails('warn.modelIssue.global', 'zh', '默认审查模型不可用：{reason}。实际使用：{effective}；备查：{effective}。').includes('占位符名称或次数'), '{effective} 出现两次应报占位符失败');
  assert.ok(fails('cardstate.waiting.deny', 'zh', '自动审查结论为拒绝（无原因说明）').includes('占位符名称或次数'), 'deny 文案丢 {reason} 应报占位符失败');
});

test('反例：丢条件与关闭含义反转报失败', () => {
  assert.ok(
    fails('warn.modelIssue.globalUnset', 'zh', '默认审查模型未设置：仅当解析实际落到全局默认层时，审查跟随执行助手的当前模型，独立于执行助手会话发起审查调用。').includes('无会话及映射条件'),
    '丢「无会话选择且无映射」条件应报失败',
  );
  assert.ok(fails('help.mode', 'zh', '关闭后插件仍正常接管审批；开启时规则检查与 LLM 审查照常进行，宿主审批流程不受影响，等同未安装。').includes('关闭含义反转'), '反转关闭含义（关闭仍接管）应报失败');
  assert.ok(fails('cardstate.waiting.deny', 'zh', '自动审查拒绝即为最终结论，无需人工再作答：{reason}').includes('模型拒绝非最终结果'), '声称拒绝为最终结论应报失败（等待卡语义）');
});

test('反例：默认供给候选删一报失败（模型与供应商都须在场）', () => {
  assert.ok(fails('hint.reviewer.maxTokens', 'zh', '审查输出的 token 上限（token 是模型计量文本的单位）；0 不传输出上限，改由供应商的默认值决定；推理模型可能先把额度用于推理，上限过小可能导致没有有效结论。').includes('采用模型或供应商默认'), '删「模型」供给候选应报失败');
  assert.ok(fails('hint.reviewer.maxTokens', 'zh', '审查输出的 token 上限（token 是模型计量文本的单位）；0 不传输出上限，改由模型的默认值决定；推理模型可能先把额度用于推理，上限过小可能导致没有有效结论。').includes('采用模型或供应商默认'), '删「供应商」供给候选应报失败');
});

test('反例：解析优先顺序反转报失败（方向性共现）', () => {
  assert.ok(fails('hint.reviewer.parentModelRules', 'zh', '按执行助手模型匹配的规则表：全局默认先于命中，会话选择更优先。').includes('映射先于全局'), '「全局先于命中」反转映射优先级应报失败');
  assert.ok(fails('hint.reviewer.parentModelRules', 'zh', '按执行助手模型匹配的规则表：命中时先于全局默认，映射比会话选择优先。').includes('会话更优先'), '「映射比会话优先」反转会话优先级应报失败');
  assert.ok(fails('help.reviewer.parentModelRules', 'en', 'Rules matched by the agent\'s model: a hit outranks the global default, and the global default outranks any session choice.').includes('会话高于映射高于全局'), '反转 session 优先级应报失败');
});

test('反例：超时危险判定反转报失败（不是危险＝否定事实）', () => {
  assert.ok(fails('help.reviewer.timeoutMs', 'zh', '自动审查的等待上限（毫秒），涵盖装配与等待本次审查结论的全过程，排队等待独立计时、不消耗本预算，内部重试不另获时限。超时按拒绝处理并说明发生环节，属于危险判定。0 立即超时。').includes('超时拒绝报环节不是危险'), '「属于危险判定」反转非危险事实应报失败');
});

test('两语退化反例：零值否定、供给候选、占位符和必要条件逐项失败', () => {
  for (const [key, lang, text] of [
    ['hint.reviewer.timeoutMs', 'zh', '等待上限为毫秒；0 不立即超时。'],
    ['hint.reviewer.timeoutMs', 'en', 'Wait limit in ms; 0 does not time out immediately.'],
    ['hint.ui.injectMaxBytes', 'en', 'Byte cap per notice; 0 trims notices.'],
    ['hint.tools', 'en', 'Tools under auto-approval, one per line; an empty list covers no tools.'],
    ['warn.modelIssue.global', 'en', 'Default reviewer model unavailable: {reason}. Currently using a fallback.'],
    ['warn.modelIssue.global', 'en', 'Default reviewer model unavailable: {reason}. Currently using {effective} {effective}.'],
    ['warn.modelIssue.globalUnset', 'en', 'Default reviewer model is not set: only at the global default do reviews follow the agent current model in an independent call.'],
    ['help.mode', 'en', 'Rule check + LLM review takes over; off behaves as if uninstalled, with host approvals untouched. {extra}'],
    ['hint.reviewer.maxTokens', 'en', 'A token measures text. 0 sends no cap, using provider defaults. Reasoning may spend the budget first; too small a cap may leave no usable conclusion.'],
  ]) assert.ok(fails(key, lang, text).length > 0, `${key}/${lang} ${text}`);
});

test('直接反转：零立即不拒绝与命中不拒绝的中英样本必须失败', () => {
  for (const [key, lang, text, expected] of [
    ['hint.human.timeoutMs', 'zh', '等待人工的上限（毫秒）；0 立即不拒绝。', '零值含义反转'],
    ['hint.human.timeoutMs', 'en', 'Human-answer wait limit (ms); 0 immediately does not reject.', '零值含义反转'],
    ['hint.reviewer.timeoutMs', 'zh', '审查等待上限（毫秒）；0 立即不超时。', '零值含义反转'],
    ['hint.denyPatterns', 'zh', '每行一条正则表达式；命中不拒绝，模型与人工都不能推翻。', '命中拒绝含义反转'],
    ['hint.denyPatterns', 'en', 'One regex per line; a hit does not reject, and neither model nor human can override it.', '命中拒绝含义反转'],
  ]) assert.ok(fails(key, lang, text).includes(expected), `${key}/${lang} 直接反转必须检出`);
});

test('关系正反例：否定最终结果允许，肯定最终或命中不拒绝失败', () => {
  for (const [lang, text] of [
    ['zh', '自动审查结论为拒绝：{reason}。这不是最终审批结果，仍等待人工作答。'],
    ['zh', '自动审查已拒绝：{reason}。这并非最后决定，人工仍可作答。'],
    ['en', 'The review concluded deny: {reason}. This is not the final approval outcome; a human answer is still pending.'],
    ['en', 'Review verdict: deny ({reason}); this is not a conclusive decision while waiting for you.'],
  ]) assert.deepEqual(fails('cardstate.waiting.deny', lang, text), [], '明确否定最终关系不是禁词命中');
  for (const [lang, text] of [
    ['zh', '自动审查结论为拒绝：{reason}。这就是最终审批结果，无需人工。'],
    ['en', 'The review concluded deny: {reason}. This is the final approval outcome; no human is needed.'],
  ]) assert.ok(fails('cardstate.waiting.deny', lang, text).includes('模型拒绝非最终结果'));
  for (const key of ['hint.denyPatterns', 'help.denyPatterns']) {
    for (const [lang, fragment] of [
      ['zh', '命中不拒绝'], ['zh', '命中不会直接拒绝'], ['zh', '命中可能立即拒绝'],
      ['en', 'a hit does not directly reject'], ['en', 'a hit may immediately reject'],
    ]) assert.ok(fails(key, lang, fragment).includes('命中拒绝'), `${key} 共用确定命中拒绝关系`);
  }
});

test('命中条件正反例：未命中不能充当肯定条件，邻句继续审查不误拒', () => {
  for (const key of ['hint.denyPatterns', 'help.denyPatterns']) {
    for (const [lang, text] of [
      ['zh', '未命中即直接拒绝'], ['zh', '不匹配到即直接拒绝'],
      ['en', 'no hit rejects outright'], ['en', 'no match rejects outright'], ['en', 'a non-match rejects outright'],
    ]) assert.ok(fails(key, lang, text).includes('命中拒绝'), `${key}/${lang} 否定命中不能成为肯定关系`);
  }
  for (const [lang, text] of [
    ['zh', '每行写一条正则表达式；未命中不代表安全，命中后立即拒绝，模型和人工都不能推翻。'],
    ['zh', '每行一条正则；未命中继续审查；匹配到就直接拒绝，模型与人工无法推翻。'],
    ['en', 'One regex on each line; no match does not establish safety. A hit immediately rejects, and neither model nor human can override it.'],
    ['en', 'One regex per line; no hit continues review, but a match rejects outright, beyond model or human.'],
  ]) assert.deepEqual(fails('hint.denyPatterns', lang, text), [], '独立肯定命中关系不受邻句未命中说明影响');
});

test('已登记正向关系有限自查：紧邻不/not不能保留优先、独立和零立即含义', () => {
  for (const [key, lang, text] of [
    ['hint.reviewer.parentModelRules', 'zh', '按执行助手模型匹配的规则表：命中时不先于全局默认，会话选择更优先。'],
    ['hint.reviewer.parentModelRules', 'en', "Rules matching the agent's model; a hit does not beat the global default, a session choice beats both."],
    ['hint.reviewer.parentModelRules', 'zh', '按执行助手模型匹配的规则表：命中时先于全局默认，会话选择不更优先。'],
    ['hint.reviewer.parentModelRules', 'en', "Rules matching the agent's model; a hit beats the global default, a session choice does not beat both."],
    ['composer.title', 'zh', '本会话的审查模型；不独立于执行助手调用，点开可只给这个会话指定'],
    ['composer.title', 'en', "This session's reviewer model — not called independently of the agent; pick one to override it for this session only"],
    ['hint.human.timeoutMs', 'zh', '人工作答的等待上限（毫秒）；0 不会立即拒绝。'],
    ['hint.human.timeoutMs', 'en', 'Human-answer wait limit (ms); 0 does not immediately reject.'],
  ]) assert.ok(fails(key, lang, text).length > 0, `${key}/${lang} 正向关系紧邻否定必须失败`);
  for (const [key, lang, text] of [
    ['hint.reviewer.parentModelRules', 'zh', '按执行助手模型匹配的规则表：命中时先于全局默认，会话选择更优先；未命中不代表安全。'],
    ['hint.reviewer.parentModelRules', 'en', "Rules matching the agent's model; a hit beats the global default, a session choice beats both. No match does not establish safety."],
    ['composer.title', 'zh', '本会话的审查模型；独立于执行助手调用，点开可只给这个会话指定；这不是最终审批结果。'],
    ['composer.title', 'en', "This session's reviewer model — called independently of the agent; pick one to override it for this session only. This is not the final outcome."],
  ]) assert.deepEqual(fails(key, lang, text), [], '无关邻句否定不反转已登记正向关系');
});

test('条件等义正例：空与非空、Ask与Reject邻句各自绑定动作', () => {
  for (const [lang, text] of [
    ['zh', '纳入自动审批的工具，每行一个。非空清单只处理名单内工具；清单留空覆盖所有工具，其余工具走宿主流程。'],
    ['en', 'One tool per line. A non-empty list only handles listed tools; an empty list covers every tool, while the rest keep the host flow.'],
    ['zh', '每行一个工具；非空清单只处理名单内，空清单覆盖全部工具。'],
    ['en', 'One tool per line; a non-empty list handles listed tools, an empty list covers all.'],
  ]) assert.deepEqual(fails('hint.tools', lang, text), [], '非空邻句不能冒充空条件也不应误伤正确空条件');
  for (const [lang, text] of [
    ['zh', '人工作答等待上限（毫秒）。仅在交给人工决定时使用；直接拒绝时不使用这份人工预算。0 表示立即拒绝，不是无限等待；到点按拒绝结算。'],
    ['en', 'Human-answer wait limit (ms), used only when fallback is Ask. Reject does not use this budget. 0 rejects immediately, not an endless wait. Expiry rejects.'],
  ]) assert.deepEqual(fails('help.human.timeoutMs', lang, text), [], 'Ask用途不能由别句Reject说明误伤');
  for (const [key, lang, text] of [
    ['hint.tools', 'zh', '每行一个工具；非空清单覆盖全部工具。'],
    ['hint.tools', 'en', 'One tool per line; non-empty covers all.'],
    ['help.human.timeoutMs', 'zh', '人工作答等待上限（毫秒），仅在直接拒绝时使用。0 立即拒绝，不是无限等待；到点拒绝。'],
    ['help.human.timeoutMs', 'en', 'Human-answer wait limit (ms), used only when fallback is Reject. 0 rejects immediately, not an endless wait. Expiry rejects.'],
  ]) assert.ok(fails(key, lang, text).length > 0, `${key}/${lang} 直接条件类别反转必须失败`);
});

test('确定行为极性只绑定对应对象，不被无关否定分句误拒', () => {
  assert.deepEqual(fails('help.allowEscalationTo', 'zh', '本项设定自动批准所能给出的最高权限，只是圈定可送审、可允许的升权范围；范围内的请求照样要过规则检查和模型审查，绝不是无条件全批。默认的完全访问最宽；选工作区内修改时，比工作区写入更高的升权一律不放行。未命中并不代表安全。'), []);
  assert.deepEqual(fails('help.allowEscalationTo', 'en', 'This sets the highest permission auto-approval may hand out; it bounds which escalations may be reviewed or allowed. Anything in range still passes the rule checks and the model review — never a blanket approval of everything. Full access is the widest default; workspace write never lets an escalation beyond workspace writes through. This is not the final approval outcome.'), []);
  assert.deepEqual(fails('help.denyPatterns', 'zh', '每行一条正则表达式；全部字符串参数都匹配，不仅命令。可写 /source/flags。命中即拒绝，不调用模型、不交人工，模型和人工都无法推翻。空清单只关闭这层文本匹配；不可编译的行跳过。'), []);
});

test('可能性与建议不冒充必然义务：保守说明可与原风险同时成立', () => {
  assert.deepEqual(fails('card.presets.missing.remedy', 'zh', '该预设不在宿主当前预设表中。可依次检查插件是否已停用、宿主版本是否兼容、预设是否自定义。重新启用或重启可能恢复，也可能不恢复；仍未恢复时按原因排查，改选标准权限档，卸载清理手工处理。插件不解析、不改写用户 YAML。'), []);
  assert.deepEqual(fails('card.presets.missing.remedy', 'en', 'The preset is absent from the current preset table. Check disabled plugins, compatible hosts and custom presets. Re-enabling or restarting may restore it, and may not restore it; pick a standard tier and use the uninstall manual cleanup. The plugin never parses nor rewrites user YAML.'), []);
});

test('三项可能性的局部否定作用域：可能不与无关cannot邻句不消除原风险', () => {
  const zh = '审查输出的 token 上限（token 是模型计量文本的单位）；0 不向模型传输出上限，由模型或供应商默认值决定；推理模型可能先把额度用于推理，上限过小可能导致没有有效结论。';
  const en = 'Review output cap in tokens (a token is the unit models use to measure text); 0 sends no cap, leaving the model or provider default; reasoning models may spend the budget on reasoning first — too small a cap can leave no usable conclusion.';
  for (const [lang, original, from, to] of [
    ['zh', zh, '可能先把', '可能不会先把'],
    ['en', en, 'may spend', 'may not spend'],
    ['zh', zh, '可能导致', '可能不导致'],
    ['en', en, 'can leave', 'may or may not leave'],
  ]) assert.deepEqual(fails('hint.reviewer.maxTokens', lang, original.replace(from, to)), [], '可能发生或可能不发生均不等于不能发生');
  assert.deepEqual(fails('hint.reviewer.maxTokens', 'zh', zh + '无法识别的操作不能自动批准。'), [], '无关对象否定不反转额度风险');
  assert.deepEqual(fails('hint.reviewer.maxTokens', 'en', en + ' An unknown action cannot be approved.'), [], 'unrelated cannot does not negate the token event');
});

test('内部子条件等义正例：相反类别邻句不替代支持、阈值及only关系', () => {
  const modelZh = '全局默认的审查模型与推理强度。模型引用为 provider/model；推理强度留空即自动：模型支持 `low` 时选用 `low`，否则不指定、由模型默认值决定。解析顺序为会话选择 → 按执行助手的模型映射 → 全局默认；全局默认未设置时使用执行助手的当前模型，独立于执行助手会话发起审查调用。';
  const modelEn = 'Global default reviewer model and effort. Model reference is provider/model; empty effort is automatic: when the model supports `low`, use `low`, otherwise let the model default decide. Resolution: session choice, by the agent\'s model, global default; an unset default reviews on the agent\'s current model in an independent call.';
  assert.deepEqual(fails('help.reviewer.model', 'zh', modelZh), []);
  assert.deepEqual(fails('help.reviewer.model', 'en', modelEn), []);
  assert.deepEqual(fails('help.tools', 'zh', '纳入自动审批的工具，每行一个。空清单覆盖所有工具；填写后只处理名单内工具，其余工具保持宿主流程。不是名单内的工具仍交宿主处理。'), []);
  assert.deepEqual(fails('help.tools', 'en', 'One tool per line. Empty covers all tools; once filled, only listed tools are handled and the rest keep the host flow. Unlisted tools are not intercepted.'), []);
  assert.deepEqual(fails('help.ui.injectMaxBytes', 'zh', '发给执行助手的单条通知的字节上限；超过上限时截断并带标记，0 不裁剪。审查记录按会话独立保存，与该上限无关。未超过上限的通知保持原样。'), []);
  assert.deepEqual(fails('help.ui.injectMaxBytes', 'en', 'Byte cap for one notice; text exceeding the cap is trimmed with a marker, 0 does not trim. Review records are kept per session and ignore this limit. A shorter notice is unchanged.'), []);
});

test('mode有限关系正反例：开关分支与两个审查动作各自绑定，正确关态邻句保留', () => {
  const samples = [
    ['zh', '开启后由插件接管审批：先做规则筛查，再交模型独立审查。关闭时插件不进行任何接管，效果与未安装它相同；宿主自身的审批流程保持原样。'],
    ['en', 'When on, the plugin takes over approvals: a rule screen first, then an independent LLM review. When off, it does not take over at all — the effect is the same as if it were not installed, and the host approval flow is left untouched.'],
  ];
  for (const [lang, text] of samples) {
    assert.deepEqual(checkModeHelpFacts(text), []);
    assert.deepEqual(fails('help.mode', lang, text), []);
    const suffix = lang === 'zh' ? '关闭时不做规则检查，不经LLM审查，也不接管审批。' : ' When off, there is no take-over, without a rule check or LLM review.';
    assert.deepEqual(checkModeHelpFacts(text + suffix), [], '正确off分支否定两动作不能伤及on义务');
    assert.deepEqual(fails('help.mode', lang, text + suffix), []);
  }
  const cases = [
    ['zh', '先做规则筛查', '不做规则筛查', 'on-rule-check'],
    ['zh', '先做规则筛查', '不经规则筛查', 'on-rule-check'],
    ['zh', '再交模型独立审查', '不做模型独立审查', 'on-llm-review'],
    ['zh', '再交模型独立审查', '不经模型独立审查', 'on-llm-review'],
    ['en', 'a rule screen first', 'without a rule screen', 'on-rule-check'],
    ['en', 'a rule screen first', 'no rule screen', 'on-rule-check'],
    ['en', 'an independent LLM review', 'without LLM review', 'on-llm-review'],
    ['en', 'an independent LLM review', 'LLM review is not performed', 'on-llm-review'],
    ['zh', '开启后', '关闭后', 'on-rule-check'],
    ['en', 'When on', 'When off', 'on-llm-review'],
    ['zh', '关闭时', '开启时', 'off-no-takeover'],
    ['en', 'When off', 'When on', 'off-no-takeover'],
    ['zh', '插件不进行任何接管', '插件进行任何接管', 'off-reversal'],
    ['en', 'does not take over', 'takes over', 'off-reversal'],
    ['zh', '效果与未安装它相同', '效果不与未安装它相同', 'off-equivalent-to-uninstalled'],
    ['en', 'the same as if it were not installed', 'not the same as if it were not installed', 'off-equivalent-to-uninstalled'],
    ['zh', '宿主自身的审批流程保持原样', '宿主自身的审批流程会改变', 'host-flow-unaffected'],
    ['en', 'host approval flow is left untouched', 'host approval flow is affected', 'host-flow-unaffected'],
  ];
  for (const [lang, from, to, id] of cases) {
    const original = samples.find(([language]) => language === lang)[1];
    assert.ok(original.includes(from));
    const actual = original.replace(from, to);
    assert.ok(checkModeHelpFacts(actual).includes(id), `${lang}/${id}:${to}`);
    assert.ok(fails('help.mode', lang, actual).length > 0);
  }
  assert.equal(cases.length, 18);
  for (const [lang, suffix, id] of [
    ['zh', '关闭时不接管，但插件仍接管审批。', 'off-reversal'],
    ['en', ' When off, it does not take over, but the plugin takes over approvals.', 'off-reversal'],
    ['zh', '关闭时不等同未安装。', 'off-equivalent-to-uninstalled'],
    ['en', ' When off, it does not behave as if uninstalled.', 'off-equivalent-to-uninstalled'],
    ['zh', '宿主审批流程受到影响。', 'host-flow-unaffected'],
    ['en', ' The host approval flow is affected.', 'host-flow-unaffected'],
  ]) assert.ok(checkModeHelpFacts(samples.find(([language]) => language === lang)[1] + suffix).includes(id), '另一正确关系不能掩盖同对象相反关系');
});

test('负关系取消作用域有限正反例：真实负关系等义与无关取消不冲突', () => {
  const samples = [
    ['hint.denyPatterns', 'zh', '每行一条正则；命中即拒绝，模型与人工都不能推翻。', '都不能推翻', '都无法推翻'],
    ['hint.denyPatterns', 'en', 'One regex per line; a hit rejects outright, beyond model or human.', 'beyond model or human', 'beyond model or human override'],
    ['help.ui.inject', 'zh', '允许、拒绝、超时和故障＝四类都发送；仅拒绝、超时和故障＝允许不发送；选择「不发送」＝一条都不发送。审查记录视图的显示不受本开关影响。', '不受本开关影响', '与此开关无关'],
    ['help.ui.inject', 'en', 'Allow, deny, timeout and failures sends all four; deny, timeout and failures skips allow notices; send none sends no notices. The review-log view is unaffected by this switch.', 'unaffected by this switch', 'independent of this switch'],
    ['help.reviewer.timeoutMs', 'zh', '自动审查等待上限（毫秒）涵盖装配和取得结论的全过程；排队独立计时，不消耗本预算；内部重试不另获时限。超时拒绝并注明环节，不是危险判定。0 立即超时。', '不另获时限', '不会再获得新的时限'],
    ['help.reviewer.timeoutMs', 'en', 'Auto-review wait limit (ms), covering assembly and the whole wait for this conclusion; queue waits are timed separately and never consume this budget, internal retries get no fresh time budget. A timeout rejects with its stage named, not a danger verdict. 0 times out immediately.', 'get no fresh time budget', 'are never handed a fresh time budget'],
  ];
  for (const [key, lang, original, from, to] of samples) {
    assert.deepEqual(fails(key, lang, original), []);
    assert.deepEqual(fails(key, lang, original.replace(from, to)), [], '真正负关系等义须保持');
    assert.deepEqual(fails(key, lang, original + (lang === 'zh' ? '这并非最终审批结果。' : ' This is not the final approval outcome.')), [], '无关对象取消不影响登记负义务');
  }
  for (const [key, lang, text, id] of [
    ['hint.denyPatterns', 'zh', '每行一条正则；命中即拒绝，模型与人工不属于都不能推翻。', '模型人工不能推翻'],
    ['hint.denyPatterns', 'en', 'One regex per line; a hit rejects outright, no longer beyond model or human.', '模型人工不能推翻'],
    ['help.ui.inject', 'zh', samples[2][2].replace('不受本开关影响', '不能说不受本开关影响'), '记录视图独立'],
    ['help.reviewer.timeoutMs', 'zh', samples[4][2].replace('不另获时限', '不再不另获时限'), '重试不重赠'],
    ['hint.denyPatterns', 'zh', '每行一条正则；命中即拒绝，模型与人工都不能推翻这一说法不成立。', '模型人工不能推翻'],
    ['hint.denyPatterns', 'en', 'One regex per line; a hit rejects outright, beyond model or human this claim is false.', '模型人工不能推翻'],
  ]) assert.ok(fails(key, lang, text).includes(id), '有限前后置取消须指向对应事实');
  for (const [text, id] of [
    ['总开关：规则检查＋LLM 审查＝正常接管；关闭时并非不接管＝等同未安装，宿主审批流程不受影响。', 'off-no-takeover'],
    ['On: rule check plus LLM review takes over. When off, it is not true that it does not take over; it is like uninstalled, host approvals untouched.', 'off-no-takeover'],
  ]) assert.ok(checkModeHelpFacts(text).includes(id));
});

test('量与候选只绑定所属关系：不同对象数字和排除邻句不能误拒，来源or不强制同时采用', () => {
  for (const [key, lang, text] of [
    ['hint.tools', 'zh', '纳入自动审批的工具，每行1个；空清单覆盖所有工具。另一个界面每行2个按钮。'],
    ['hint.tools', 'en', 'Tools under auto-approval, 1 per line; empty covers all. Another interface has 2 buttons per line.'],
    ['hint.reviewer.maxTokens', 'zh', '审查输出的 token 上限（token 是模型计量文本的单位）；0 不向模型传输出上限，由供应商或模型默认值决定；推理模型可能先把额度用于推理，上限过小可能导致没有有效结论。另一个默认设置不含供应商选项。'],
    ['hint.reviewer.maxTokens', 'en', 'Review output cap in tokens (a token is the unit models use to measure text); 0 sends no cap, leaving the provider or model default; reasoning models may spend the budget on reasoning first — too small a cap can leave no usable conclusion. Another default setting excludes provider options.'],
  ]) assert.deepEqual(fails(key, lang, text), [], '明确其他对象不改变数量与来源候选');
  for (const [lang, text] of [
    ['zh', '审查输出的 token 上限（token 是模型计量文本的单位）；0 不向模型传输出上限，由模型而非供应商默认值决定；推理模型可能先把额度用于推理，上限过小可能导致没有有效结论。'],
    ['en', 'Review output cap in tokens (a token is the unit models use to measure text); 0 sends no cap, leaving the model default, not the provider default; reasoning models may spend the budget on reasoning first — too small a cap can leave no usable conclusion.'],
  ]) assert.ok(fails('hint.reviewer.maxTokens', lang, text).includes('采用模型或供应商默认'));
});

test('默认来源必要条件有限保护：unless双来源不是or枚举，not required和中性both仍通过', () => {
  const original = 'Review output cap in tokens (a token is the unit models use to measure text); 0 sends no cap, leaving the model or provider default; reasoning models may spend the budget on reasoning first — too small a cap can leave no usable conclusion.';
  const from = 'leaving the model or provider default';
  for (const replacement of [
    'leaving no usable conclusion unless both the model and provider supply defaults',
    'leaving a usable conclusion only if both the provider and model provide defaults',
  ]) assert.ok(fails('hint.reviewer.maxTokens', 'en', original.replace(from, replacement)).includes('采用模型或供应商默认'));
  for (const replacement of [
    'leaving either the provider default or the model default',
    'leaving both the model and provider defaults in effect together',
    'leaving the model and provider defaults; both are not required to supply defaults',
    'leaving the model or provider default; a separate setting works only if both sources supply defaults',
  ]) assert.deepEqual(fails('hint.reviewer.maxTokens', 'en', original.replace(from, replacement)), [], '只判同一默认来源的肯定必要条件，不把or当互斥');
});

test('mean只取消同一send-none负谓词，不以无关recording或最终结果否定误拒', () => {
  const original = 'Allow, deny, timeout and failures sends all four; deny, timeout and failures skips allow notices; send none sends no notices. The review-log view is unaffected by this switch.';
  for (const cancel of ['does not mean', "doesn't mean", 'no longer means']) assert.ok(fails('help.ui.inject', 'en', original.replace('send none sends no notices', `send none ${cancel} no notices`)).includes('关闭零通知'));
  for (const suffix of [
    ' This setting does not disable recording.',
    ' This is not the final approval outcome.',
    ' Another label does not mean no notices.',
    ' Another label does not mean a final approval outcome, but send none means no notices.',
    ' It is not true that send none does not mean no notices.',
    ' It is not the case that send none does not mean no notices.',
  ]) assert.deepEqual(fails('help.ui.inject', 'en', original + suffix), [], '无关对象与独立转折不误伤零通知关系');
  assert.deepEqual(fails('help.ui.inject', 'en', original.replace('send none sends no notices', 'send none means no notices')), []);
});

test('人工时点触发极性：未到点拒绝失败，到点才拒绝和未到点不拒绝保持', () => {
  const zh = '人工作答等待上限（毫秒），仅在自动审查未允许时交给人工决定时使用。0 立即拒绝，不是无限等待。到点按拒绝结算，原因写明人工作答超时。';
  const en = 'Human-answer wait limit (ms), used only when the fallback is Ask. 0 rejects immediately, not an endless wait. Expiry settles as a rejection citing the human timeout.';
  for (const [lang, from, to, original] of [
    ['zh', '到点按拒绝结算', '未到点按拒绝结算', zh],
    ['en', 'Expiry settles as a rejection', 'Before expiry the request settles as a rejection', en],
    ['en', 'Expiry settles as a rejection', 'When it is not expiry the request settles as a rejection', en],
  ]) assert.ok(fails('help.human.timeoutMs', lang, original.replace(from, to)).includes('到点拒绝'));
  assert.deepEqual(fails('help.human.timeoutMs', 'zh', zh.replace('到点按拒绝结算', '未到点不按拒绝结算；到点才按拒绝结算')), []);
  assert.deepEqual(fails('help.human.timeoutMs', 'en', en.replace('Expiry settles as a rejection', 'Before expiry the request does not settle as a rejection; at expiry it settles as a rejection')), []);
});

test('空工具清单反转只看肯定空条件，非空不覆盖的正确邻句保留', () => {
  const samples = [
    ['zh', '每行一个工具；空清单覆盖所有工具。', '非空清单不覆盖全部工具。', '空清单不覆盖全部工具。'],
    ['en', 'One tool per line; empty covers all.', 'A non-empty list does not cover every tool.', 'An empty list does not cover every tool.'],
  ];
  for (const [lang, current, correct, wrong] of samples) {
    assert.deepEqual(fails('hint.tools', lang, current + correct), []);
    assert.deepEqual(fails('hint.tools', lang, correct + current), []);
    assert.ok(fails('hint.tools', lang, current + wrong).includes('空清单含义反转'));
  }
});

test('优先确定性与默认来源条件：不以未必弱化确定关系，不向其他设置借只有条件', () => {
  const priority = '按执行助手模型匹配的规则表：命中时先于全局默认，会话选择更优先。';
  for (const weak of ['未必', '不一定']) assert.ok(fails('hint.reviewer.parentModelRules', 'zh', priority.replace('会话选择更优先', `会话选择${weak}更优先`)).includes('会话更优先'));
  assert.deepEqual(fails('hint.reviewer.parentModelRules', 'zh', priority + '其他模型未必可用。'), []);
  const token = '审查输出的 token 上限（token 是模型计量文本的单位）；0 不向模型传输出上限，由模型或供应商默认值决定；推理模型可能先把额度用于推理，上限过小可能导致没有有效结论。';
  assert.ok(fails('hint.reviewer.maxTokens', 'zh', token.replace('默认值决定', '默认值决定，只有两者都提供默认值时才生效')).includes('采用模型或供应商默认'));
  assert.deepEqual(fails('hint.reviewer.maxTokens', 'zh', token + '另一个默认设置只有两者都提供默认值时才生效。'), []);
  assert.deepEqual(fails('hint.reviewer.maxTokens', 'zh', token.replace('模型或供应商', '供应商或模型')), []);
});

test('分叉主会话分类谓词：not treated局部反转，classified等义与否定错误断言保留', () => {
  const current = 'If the review does not approve, reject settles as a rejection. Ask shows the human card until the human limit rejects. Delegated subagents have no human channel — not allowed always means rejected; forked sessions are treated as main sessions.';
  assert.deepEqual(fails('help.fallback', 'en', current), []);
  for (const predicate of ['are not treated as', 'are never treated as', 'are not classified as']) assert.ok(fails('help.fallback', 'en', current.replace('are treated as', predicate)).includes('分叉按主会话'));
  assert.deepEqual(fails('help.fallback', 'en', current.replace('are treated as', 'are classified as')), []);
  assert.deepEqual(fails('help.fallback', 'en', current.replace('are treated as', 'are handled as')), []);
  assert.deepEqual(fails('help.fallback', 'en', current + ' Delegated subagents are not treated as main sessions.'), []);
  assert.deepEqual(fails('help.fallback', 'en', current + ' Other requests are not treated as main sessions.'), []);
  assert.deepEqual(fails('help.fallback', 'en', current + ' It is not true that forked sessions are not treated as main sessions.'), []);
});

test('会话文件上限只绑定最旧文件淘汰，其他文件不删除不污染', () => {
  const samples = [
    ['zh', '记录跟随产生它的会话。界面回读最近窗口，默认 200 条，可用 ui.trace.maxRecords 配置；单会话文件超过窗口四倍时轮转，只保留最近一个窗口，更早记录此时删除；会话文件数超上限时删除最旧。轮转前备份；减少采集不删除已有记录。', '备份文件不删除。', '时删除最旧', '时不删除最旧'],
    ['en', 'Records follow the session that produced them. Read-back shows a window of 200 entries by default via ui.trace.maxRecords; when a session file exceeds four times the window it is rewritten to keep only the latest one, deleting older entries; the oldest session files are deleted when the file cap is exceeded. Back up before rotation; reducing capture never deletes existing records.', 'Backup files are not deleted.', 'files are deleted', 'files are not deleted'],
  ];
  for (const [lang, current, neighbor, from, to] of samples) {
    assert.deepEqual(fails('view.retention', lang, current + ' ' + neighbor), []);
    assert.deepEqual(fails('view.retention', lang, neighbor + ' ' + current), []);
    const notReached = lang === 'zh' ? '会话文件数未超上限时不删除最旧。' : ' The oldest session files are not deleted when the file cap is not exceeded.';
    assert.deepEqual(fails('view.retention', lang, current + notReached), [], '正确未超限且不删除分支不污染已达上限的淘汰义务');
    assert.ok(fails('view.retention', lang, current.replace(from, to) + ' ' + neighbor).includes('超文件上限删最旧'));
  }
});

test('拒绝不能只当对立动作宾语，零立即动作不能被可能性弱化', () => {
  const rule = '每行一条正则表达式；命中即直接拒绝，模型与人工都不能推翻。';
  assert.ok(fails('hint.denyPatterns', 'zh', rule.replace('命中即直接拒绝', '命中即直接允许而非拒绝')).includes('命中拒绝'));
  assert.deepEqual(fails('hint.denyPatterns', 'zh', rule + '其他规则允许而非拒绝。'), []);
  assert.ok(fails('hint.denyPatterns', 'en', 'One regex per line; a hit permits instead of rejects outright, beyond model or human.').includes('命中拒绝'));
  for (const [key, action] of [['hint.human.timeoutMs', 'reject'], ['hint.reviewer.timeoutMs', 'time out']]) {
    assert.ok(fails(key, 'en', `Wait limit (ms); 0 may ${action} immediately.`).includes('零值正向关系被否定'));
    assert.deepEqual(fails(key, 'en', `Wait limit (ms); 0 ${action === 'reject' ? 'rejects' : 'times out'} immediately. Another operation may reject later.`), []);
  }
});

test('零值的不是可能而是立即按同动作归一，保留后来直接反转', () => {
  const samples = [
    ['hint.human.timeoutMs', 'zh', '等待人工上限（毫秒）；0 不是可能立即拒绝，而是立即拒绝。', '0 不立即拒绝。'],
    ['hint.reviewer.timeoutMs', 'zh', '审查等待上限（毫秒）；0 不是可能立即超时，而是立即超时。', '0 不立即超时。'],
    ['hint.human.timeoutMs', 'en', 'Human-answer wait limit (ms); 0 does not mean it may reject immediately; it means it rejects immediately.', ' 0 does not reject immediately.'],
    ['hint.reviewer.timeoutMs', 'en', 'Auto-review wait limit (ms); 0 does not mean it may time out immediately; it means it times out immediately.', ' 0 does not time out immediately.'],
  ];
  for (const [key, lang, correct, contradiction] of samples) {
    assert.deepEqual(fails(key, lang, correct), []);
    assert.ok(fails(key, lang, correct + contradiction).includes('零值含义反转'));
  }
});

test('清单外不接管与开态不只人工交接显示：正确另一条件不污染登记条件', () => {
  const presets = 'Sessions on a listed preset hand escalation approvals to this plugin; other presets keep the host flow. An empty list takes over no known preset; unidentifiable presets follow the setting. Choosing the take-over range grants no extra permissions.';
  const unlisted = ' Unlisted presets do not hand escalation approvals to this plugin.';
  assert.deepEqual(fails('help.trigger.presets', 'en', presets + unlisted), []);
  assert.ok(fails('help.trigger.presets', 'en', presets.replace('listed preset hand', 'listed preset do not hand') + unlisted).includes('接管升权'));
  const card = '开启时，审查期间提前显示人工卡片，抢先的人工结果优先；已完成结果不能被迟到点击推翻。关闭时，仅在确实交给人工后显示卡片。';
  const on = '开启时，不只在确实交给人工后显示卡片。';
  assert.deepEqual(fails('help.ui.humanCardDuringReview', 'zh', card + on), []);
  assert.ok(fails('help.ui.humanCardDuringReview', 'zh', card + '关闭时，不只在确实交给人工后显示卡片。' + on).includes('关闭后真交人工才显示'));
});

test('反例：说明缺失整条报缺失', () => {
  assert.deepEqual(fails('hint.mode', 'zh', ''), ['说明缺失']);
  assert.deepEqual(fails('hint.mode', 'zh', undefined), ['说明缺失']);
});
