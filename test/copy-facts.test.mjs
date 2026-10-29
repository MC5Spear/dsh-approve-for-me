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
import { copyFactFailures, tokenRiskDisplayProtected } from './helpers/copy-facts.mjs';

const fails = (key, lang, text) => copyFactFailures(key, lang, text);

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

test('反例：说明缺失整条报缺失', () => {
  assert.deepEqual(fails('hint.mode', 'zh', ''), ['说明缺失']);
  assert.deepEqual(fails('hint.mode', 'zh', undefined), ['说明缺失']);
});
