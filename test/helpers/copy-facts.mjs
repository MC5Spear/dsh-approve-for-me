import { checkModeHelpFacts } from './mode-copy-facts.mjs';

/**
 * 普通说明的关键事实检查器（client.js 文案；design §7～§8）。
 *
 * 检查方式：短概念＋条件关系，不做长整句冻结——每条规则是「同一子句（句号／分号／换行切分）
 * 内若干概念共现」或「全文若干概念共现」的谓词；中英各自独立谓词，顺序无关，等义改写措辞
 * 应通过。协议值（provider/model、/source/flags、ui.trace.maxRecords、占位符、200 条）仍精确。
 * 只证明所列明确事实在场／缺失与所批准正反例的行为，不证明自然语言全等义。
 * 自然语言完整性仍须人工阅读。
 */

// ── 概念组合子（子句＝句号／分号／换行切分；冒号与逗号不切，保持条件关系同子句） ──

/** 切分子句。 */
const sents = (text) => String(text ?? '').split(/[。；;.\n]/u).map((clause) => clause.trim()).filter(Boolean);

/** 任一子句内全部概念共现。 */
const S = (...patterns) => (text) => sents(text).some((clause) => patterns.every((pattern) => pattern.test(clause)));

/** 全文级全部概念共现（跨子句的条件链，如「两分支」类说明）。 */
const T = (...patterns) => (text) => patterns.every((pattern) => pattern.test(text));

/** 多个谓词／正则全部成立（用于「同文多条独立子句事实」）。 */
const AND = (...predicates) => (text) => predicates.every((predicate) => (typeof predicate === 'function' ? predicate(text) : predicate.test(text)));

const rule = (id, zh, en) => ({ id, zh, en });
const r = rule;

/** 仅核文本规则的命中→拒绝关系；否定及不确定动作不能当作确定拒绝。 */
function hitRejects(text, lang) {
  const relations = lang === 'zh'
    ? [...text.matchAll(/(?:命中|匹配到)([^。；;]*?)拒绝/gu)]
    : [...text.matchAll(/\b(?:hit|match)\b([^.;]*?)\b(?:rejects?|rejected|deny|denies|denied)\b/giu)];
  const negatedOrUncertain = lang === 'zh'
    ? /不|未|无需|无须|可能|也许|或许|有时/u
    : /\b(?:not|no|never|may|might|could|can|sometimes)\b|n['’]t/iu;
  return relations.length > 0 && relations.every((relation) => !negatedOrUncertain.test(relation[1]));
}

/** 等待人工的文案可明确说“不是最终结果”；拒绝的是肯定最终结算或无需人工的关系。 */
function claimsFinalOutcome(text, lang) {
  const withoutNegatedFinal = lang === 'zh'
    ? text.replace(/(?:不是|并非|不属于|不算|尚非)(?:本次|当前|这次)?的?(?:最终|最后)(?:审批)?(?:结果|结论|决定)/gu, '')
    : text.replace(/\b(?:not|never)\s+(?:(?:the|a|any)\s+)?(?:final|conclusive)\s+(?:approval\s+)?(?:outcome|result|decision|conclusion)\b/giu, '');
  return lang === 'zh'
    ? /(?:即为|就是|为|是|属于|成为|构成|视为)的?(?:最终|最后)(?:审批)?(?:结果|结论|决定)|无需人工|不用人工|不可更改/u.test(withoutNegatedFinal)
    : /\b(?:is|as|becomes?|constitutes?)\s+(?:(?:the|a)\s+)?(?:final|conclusive)\s+(?:approval\s+)?(?:outcome|result|decision|conclusion)\b|\bno human (?:is )?(?:needed|required)\b|\bcannot be overturned\b/iu.test(withoutNegatedFinal);
}

// ── 跨键共用事实组 ──

const shared = {
  token: [
    r('token 文本计量单位', S(/token/iu, /单位|计量|衡量|度量/u, /文本|文字/u), S(/token/iu, /unit|measure/iu, /text/iu)),
    r('零不传上限', S(/\b0\b/u, /不|省|无/u, /上限|额度|限制/u), S(/\b0\b/u, /no|not|omit|never|without/iu, /cap|limit/iu)),
    // 两个供给候选（模型、供应商）都必须在同子句在场：只留其一＝事实缺失。
    r('采用模型或供应商默认', S(/模型/u, /供应商/u, /默认/u), S(/model/iu, /provider/iu, /default/iu)),
    // 方向性共现：先「推理」后「先／优先」再「额度／预算」，防只提推理不提额度。
    r('额度可能先用于推理', S(/推理/u, /先|优先|首先/u, /额度|预算/u), S(/reasoning/iu, /first|before|spend|eat/iu, /budget|tokens?/iu)),
    r(
      '过小上限可能无有效结论',
      S(/过小|太低|太小|不足/u, /可能|或许|会|将/u, /没有|无|得不到|不产生|难以/u, /有效|可用/u, /结论|结果/u),
      S(/too small|too low|insufficient/iu, /can|may|might/iu, /no|without/iu, /usable|valid/iu, /conclusion|answer/iu),
    ),
  ],
  timeout: [r('毫秒单位', S(/毫秒|\bms\b/iu), S(/\bms\b|millisecond/iu))],
  tools: [
    r('每行一个工具', S(/每行|一行/u, /一个|1\s*个/u), S(/\bone\b/iu, /per|each|every/iu, /line/iu)),
    r(
      '空清单覆盖全部',
      S(/空/u, /清单|列表/u, /覆盖|包含|适用|处理/u, /全部|所有|一切/u),
      S(/empty|emptied/iu, /covers|includes|applies|handles|takes/iu, /all|every/iu),
    ),
  ],
  independent: [
    r('审查独立调用', S(/独立|另行|单独/u, /调用|审查|发起/u), S(/independent|separately|on its own/iu, /call|review|issued/iu)),
  ],
};

// ── help.mode：复用 mode-copy-facts 的总开关事实检查器（避免两套权威） ──
// 英文现行文案以「off behaves as if uninstalled」承载零接管（无显式否定接管词），补充认定。

/** help.mode 检查器缺失事实 id → 本表规则 id 的映射（on 两项并入「规则加模型正常接管」）。 */
const MODE_RULE_BY_MISSING = {
  'on-rule-check': '规则加模型正常接管',
  'on-llm-review': '规则加模型正常接管',
  'off-no-takeover': '关闭等同未装',
  'off-equivalent-to-uninstalled': '关闭等同未装',
  'host-flow-unaffected': '宿主流程不受影响',
  'off-reversal': '关闭含义反转',
};

/** 关闭态以「等同未安装」承载零接管的补充认定（同一子句内 off 标记＋等同未安装说法）。 */
const offAsUninstalled = S(/off|关闭|关掉/iu, /as if[^,;.]{0,40}(not installed|uninstalled)|等同未安装|与未安装|如同未安装/iu);

/** help.mode 事实检查：返回缺失规则 id 列表（复用 mode 检查器＋上述补充认定）。 */
function helpModeFailures(text) {
  const missing = checkModeHelpFacts(text);
  const effective = missing.filter((id) => id !== 'off-no-takeover' || !offAsUninstalled(text));
  return [...new Set(effective.map((id) => MODE_RULE_BY_MISSING[id] ?? id))];
}

export const COPY_FACTS = {
  'help.mode': [], // 专用检查与普通键共用此枚举，不能遗漏当前字典。
  'hint.trigger.presets': [r('预设清单决定接管升权', S(/清单|列表|预设/u, /接管|交由|交给|处理/u, /升权|权限/u), S(/listed|list|preset/iu, /hand|take|escalat|approv/iu, /escalation|approval/iu))],
  'hint.trigger.unknown': [r('读不到预设的处置', S(/读不到|无法读取|无法识别|不可读|读取不到/u, /预设/u), S(/preset/iu, /cannot be read|unreadable|cannot be identified|what happens/iu))],
  'hint.trigger.auditEverySkip': [r('预设不匹配跳过记录', S(/预设/u, /不匹配/u, /跳过/u, /逐条|每次|记录|每个|是否/u), S(/preset/iu, /mismatch/iu, /skip/iu, /log|logged|each|whether/iu))],
  'hint.reviewer.model': [
    r('默认模型与强度', S(/全局默认|默认/u, /审查模型|模型/u, /推理强度|强度/u), S(/default/iu, /reviewer model|model/iu, /effort|strength/iu)),
    r('未设置跟随当前模型', S(/未设置|没有设置|为空/u, /执行助手/u, /当前模型/u), S(/unset|not set|empty/iu, /agent/iu, /current model/iu)),
  ],
  'hint.reviewer.parentModelRules': [
    r('执行模型匹配', S(/执行助手/u, /模型/u, /匹配|规则/u), S(/agent/iu, /model/iu, /match|rule/iu)),
    // 方向性共现（主语→优先词→宾语同子句按序），防「全局先于命中」式反转误过。
    r('映射先于全局', /(?:命中|映射|规则)[^。；]{0,8}(?:先于|优先于|高于)[^。；]{0,8}全局/u, /\bhit\b[^.;]{0,40}(?:beats|outranks)[^.;]{0,40}global/iu),
    r('会话更优先', /会话选择[^。；]{0,8}更优先|会话选择[^。；]{0,6}最高/u, /session choice[^.;]{0,30}(?:beats|outranks|tops)/iu),
  ],
  'hint.language.ui': [r('插件界面语言', S(/插件/u, /界面/u, /语言/u), S(/plugin/iu, /UI|interface/iu, /language/iu))],
  'hint.language.agent': [r('审查文本和执行通知', S(/审查|发给/u, /文本/u, /执行助手|通知/u, /通知|执行助手/u), S(/text/iu, /reviewer/iu, /notice/iu, /agent/iu))],
  'hint.reviewer.timeoutMs': [...shared.timeout, r('零立即超时', S(/\b0\b/u, /立即|马上|即刻/u, /超时/u), S(/\b0\b/u, /immediately|at once|right away/iu, /times? out|timeout|expiry/iu))],
  'hint.human.timeoutMs': [...shared.timeout, r('零立即拒绝', S(/\b0\b/u, /立即|马上|即刻/u, /拒绝/u), S(/\b0\b/u, /immediately|at once|right away/iu, /reject/iu))],
  'hint.reviewer.maxTokens': [...shared.token],
  'hint.ui.humanCardDuringReview': [r('审查期间提前人工卡片', S(/审查|期间/u, /提前|早|抢先/u, /人工|卡片/u, /人工|卡片|显示/u), S(/human card|card/iu, /early|during/iu, /review|appears|shows/iu))],
  'hint.human.timeoutFrom': [r('请求和交人工两个起点', S(/计时|起算|开始计时/u, /审批请求|请求/u, /交人工|转人工/u), S(/timer|timing|starts/iu, /approval request|request/iu, /handoff/iu))],
  'hint.mode': [r('关闭完全不接管', S(/关闭|关掉/u, /不|无|零/u, /接管/u), S(/\boff\b/iu, /no|not|never|nothing/iu, /take.over/iu))],
  'hint.allowEscalationTo': [r('最高权限及更高不批', AND(S(/最高|顶格|上限/u, /权限/u), S(/更高|超出|以上/u, /不|不会|绝不/u, /批准|授予|通过/u)), AND(S(/highest|widest/iu, /permission|tier/iu), S(/wider|higher|broader/iu, /never|not/iu, /approv/iu)))],
  'hint.unknownSubject': [r('操作无法识别', S(/无法|不能|难以/u, /辨认|识别|确定/u, /操作/u), S(/cannot|unable|can.t/iu, /identif|recogniz|recover/iu, /action/iu))],
  'hint.fallback': [r('审查未允许后处置', S(/自动审查|审查/u, /未允许|未通过|不通过|拒绝|未准/u, /处置|处理/u), S(/review/iu, /does not approve|not approve|fails|disapprove/iu, /what happens|handling|happens/iu))],
  'hint.ui.inject': [r('给执行助手通知范围', S(/执行助手/u, /审批通知|通知/u, /范围|哪些|哪类/u), S(/notice/iu, /agent/iu, /which|reach|what/iu))],
  'hint.ui.injectMaxBytes': [
    r('通知字节单位', S(/通知/u, /字节/u, /上限|限额/u), S(/byte/iu, /cap|limit/iu, /notice/iu)),
    r('零不裁剪', S(/\b0\b/u, /不|无需/u, /裁剪|截断|修剪/u), S(/\b0\b/u, /\b(?:no|not|never|does not)\b/iu, /trim|cut|clip/iu)),
  ],
  'hint.tools': [...shared.tools],
  'hint.denyPatterns': [
    r('每行正则', S(/每行|一行/u, /正则/u), S(/\bone\b/iu, /regex|regular expression/iu, /per line|each line|line/iu)),
    r('命中拒绝', (text) => hitRejects(text, 'zh'), (text) => hitRejects(text, 'en')),
    r('模型人工不能推翻', S(/模型/u, /人工/u, /不能|无法|不可|均不|都不能/u, /推翻|改变|反转/u), S(/model/iu, /human/iu, /no|not|cannot|beyond|neither/iu, /override|overturn|overrule|beyond/iu)),
  ],
  'help.reviewer.maxTokens': [...shared.token, r('阈值依模型和强度', S(/数值|阈值|门槛/u, /模型/u, /推理强度|强度/u, /异|变|不同|决定/u), S(/threshold|cap|number/iu, /varies|depends|differs/iu, /model/iu, /effort|strength/iu))],
  'help.tools': [
    ...shared.tools,
    r('填写后只处理名单内', S(/填写|填入|填/u, /只|仅/u, /(?:名单|清单|列表)之内|名单内|清单内|列表内/u, /工具/u), S(/filled in|once filled|filled/iu, /only|just/iu, /listed/iu, /tools?/iu)),
    r('清单外宿主流程', S(/其余|其他|名单外|清单外/u, /工具/u, /宿主/u, /流程|原流程|保持/u), S(/rest|unlisted|others/iu, /tool/iu, /host/iu, /flow/iu)),
  ],
  'help.trigger.presets': [
    r('接管升权', S(/接管|交由/u, /升权|审批|权限/u), S(/hand|take/iu, /escalation|approval/iu)),
    r('其他预设保留流程', S(/其他|其余|别的/u, /预设/u, /宿主/u, /流程|审批流程|保持/u), S(/other/iu, /preset/iu, /host/iu, /flow/iu)),
    r('空清单已知不接管', S(/空|清单为空/u, /清单|列表/u, /已知/u, /不|无/u, /接管/u), S(/empty/iu, /list/iu, /known|no known/iu, /no|not/iu, /take/iu)),
    r('未知预设按设置', S(/无法识别|不能识别/u, /预设/u, /无法识别权限预设时|设置|按/u), S(/cannot be identified|unidentifiable/iu, /preset/iu, /When the preset cannot be identified|setting/iu)),
    r('不是额外授权', S(/不等于|并非|不是/u, /授予|授权|权限|批准/u), S(/grant|permission/iu, /no extra|not a|no additional|grants no/iu)),
  ],
  'help.trigger.unknown': [r('不接管与继续两分支', AND(S(/宿主.{0,10}流程|保持宿主/u, /不接管/u), S(/继续/u, /视为|命中接管范围|接管范围/u)), AND(S(/host.{0,8}flow|keep the host/iu, /no take.over|not take/iu), S(/continue/iu, /covered|treated|take.over/iu)))],
  'help.trigger.auditEverySkip': [
    r('开启逐条', S(/开启|打开|每次|逐条/u, /逐条|每次|记录/u, /跳过|略过/u), S(/\bon\b|every/iu, /skip/iu, /logged|log|each/iu)),
    r('关闭同原因一条', S(/关闭|关掉/u, /同一会话|同会话|同一原因|同一/u, /一条/u), S(/\boff\b/iu, /one line|single|per session and reason/iu, /per session and reason|one/iu)),
    r('不影响审批', S(/不|无关|仅/u, /影响/u, /接管|审批/u), S(/never|only|just/iu, /take.over|approval/iu, /changes?|affect/iu)),
  ],
  'help.reviewer.model': [
    r('模型引用格式', T(/provider\/model/u), T(/provider\/model/u)),
    r('强度自动低档', S(/留空|空|不填/u, /自动/u, /low/iu, /使用|用|选/u), S(/empty|blank/iu, /automatic/iu, /low/iu, /use|pick|when/iu)),
    r('否则模型默认', S(/否则|不然|若不支持/u, /模型默认|默认值|模型自己/u), S(/otherwise|else|if not/iu, /model default|default/iu)),
    r('会话映射全局顺序', /会话选择\s*[→＞>]\s*(?:按)?执行助手的模型映射\s*[→＞>]\s*全局默认/u, /session choice\s*(?:[→>]|,)\s*(?:by the agent.s model|mapping)\s*(?:[→>]|,)\s*global default/iu),
    r('未设跟随当前模型', S(/未设置|没有设置/u, /执行助手/u, /当前模型/u), S(/unset|not set/iu, /agent/iu, /current model/iu)),
    ...shared.independent,
  ],
  'help.reviewer.parentModelRules': [
    r('完整id作用范围', S(/任意 provider|provider/iu, /完整.{0,4}模型|模型 id/u, /作用范围|范围/u), S(/any provider|scope/iu, /full model id|model id/iu, /scope|provider/iu)),
    r(
      '会话高于映射高于全局',
      // 方向性共现：主语在前、优先词居中、宾语在后，反转顺序必红。
      AND(/会话选择[^。；]{0,8}更优先|会话选择[^。；]{0,6}最高/u, /命中[^。；]{0,8}(?:先于|优先于|高于)[^。；]{0,8}全局/u),
      AND(/session choice[^.;]{0,30}(?:outranks|beats)/iu, /\bhit\b[^.;]{0,40}(?:outranks|beats)[^.;]{0,40}global/iu),
    ),
    r('唯一条件', S(/只能有一条|唯一/u, /规则|条/u), S(/one rule/iu, /per|scope/iu)),
    r('旧纯id任意provider', S(/纯模型 id|纯 id/u, /任意 provider|任意/u), S(/plain.id/iu, /any.provider|any/iu)),
    r(
      '斜杠确认且不自动改写',
      AND(S(/含斜杠|斜杠/u, /确认/u), S(/不|不会/u, /自动?改写|改写/u)),
      AND(S(/slash/iu, /confirm/iu), S(/never|not/iu, /rewritten|rewrit/iu)),
    ),
  ],
  'help.reviewer.timeoutMs': [
    ...shared.timeout,
    r('装配结论全程', S(/装配/u, /结论/u, /全程|全过程|整个|从.{0,12}到/u), S(/assembly/iu, /conclusion/iu, /whole|entire|all the way|start to finish/iu)),
    r('排队不占预算', S(/排队|队列/u, /独立|单独|另行/u, /计时|另计/u, /不消耗|不占用|不算|不占/u), S(/queue/iu, /separate|independent|on its own/iu, /timed|clocked|counted/iu, /not consume|never consume|does not consume|consume nothing/iu)),
    r('重试不重赠', S(/重试/u, /不|无|没/u, /时限|预算|时间预算/u), S(/retr(y|ies)/iu, /no|not|never/iu, /budget|time/iu)),
    r('超时拒绝报环节不是危险', S(/超时/u, /拒绝/u, /环节/u, /不是|并非|非|不算/u), S(/timeout/iu, /reject/iu, /stage/iu, /not a danger|no danger|not danger/iu)),
    r('零立即到点', S(/\b0\b/u, /立即|马上|即刻/u, /超时/u), S(/\b0\b/u, /immediately|at once|right away/iu, /times? out|timeout/iu)),
  ],
  'help.human.timeoutMs': [
    ...shared.timeout,
    r('仅人工备用', S(/仅|只/u, /人工/u, /使用|生效|适用|时/u), S(/only/iu, /ask|human|handoff/iu, /when|used|applies/iu)),
    r('零拒绝非无限', S(/\b0\b/u, /拒绝/u, /无限|无期|无尽/u, /不是|并非|非/u), S(/\b0\b/iu, /reject/iu, /endless|unlimited|infinite/iu, /not|no/iu)),
    r('到点拒绝', S(/到点|到期|超时/u, /拒绝/u), S(/expiry|expire|times? out/iu, /reject/iu)),
  ],
  'help.human.timeoutFrom': [
    r('请求起算用剩余', S(/审批请求|请求/u, /起算|开始计时|计时/u, /剩余|余下/u), S(/approval request|request/iu, /start|timer|begins/iu, /remainder|remaining/iu)),
    r('交人工重新起算', S(/交人工|转人工/u, /重新|重起|另起/u, /计时|起算/u), S(/handoff/iu, /fresh|restart|begins again|new|itself/iu, /timer|start|clock/iu)),
  ],
  'help.allowEscalationTo': [
    r('最高权限上限', S(/最高|顶格|上限/u, /权限|升权/u), S(/highest|widest/iu, /permission|escalation/iu)),
    r('范围仍审查', S(/范围|内/u, /规则检查|规则/u, /模型审查|模型|审查/u, /仍|须|依然|要|通过/u), S(/range|in scope|everything/iu, /rule check|rule/iu, /review/iu, /still|must|passes/iu)),
    r('不是全批', S(/不等于|并非|不是|绝不/u, /自动批准全部|全部操作|全批|批准全部|无条件/u), S(/not a blanket|never a blanket|no blanket|not blanket/iu, /approval|approve|grant/iu)),
    r('完全访问最宽', S(/完全访问/u, /默认/u, /最宽/u), S(/full access/iu, /default/iu, /widest/iu)),
    r('工作区不放行更宽', S(/工作区/u, /升权/u, /不放行|不批|拒绝|一律不/u), S(/workspace/iu, /escalation/iu, /reject|never|not/iu)),
  ],
  'help.unknownSubject': [
    r('拒绝不调模型', S(/拒绝/u, /不调用|不调/u, /模型/u), S(/reject/iu, /without the model|no model|not call/iu, /model/iu)),
    r('缺失标记不作安全', S(/缺失/u, /标记/u, /不|从未|并非/u, /当作|视为|算作|安全/u), S(/missing/iu, /mark/iu, /never|not/iu, /safe/iu)),
  ],
  'help.fallback': [
    r('拒绝结算', S(/拒绝/u, /结算|按拒绝/u), S(/reject/iu, /settles|rejection/iu)),
    r('人工卡片和超时拒绝', S(/人工|卡片/u, /上限|到点|超时/u, /拒绝/u), S(/human card|card/iu, /limit|expiry|timeout/iu, /reject/iu)),
    r('委派无人工', S(/委派|子代理/u, /没有|无|不/u, /人工通道|人工/u), S(/delegated|subagent/iu, /no|without/iu, /human channel/iu)),
    r('分叉按主会话', S(/分叉/u, /主会话/u), S(/forked/iu, /main session/iu)),
  ],
  'help.ui.humanCardDuringReview': [
    r('抢先人工优先', S(/抢先|先/u, /人工/u, /优先/u), S(/answer first|first/iu, /human/iu, /wins|beats|prevails/iu)),
    r('已结算不可迟改', S(/已完成|已结算/u, /不能|无法|不可/u, /迟到|晚|迟/u, /推翻|改变|撤销/u), S(/settled/iu, /cannot|can.t|not/iu, /late/iu, /overturned|overturn|undo/iu)),
    r('关闭后真交人工才显示', S(/关闭/u, /仅|只/u, /确实|真正|真的/u, /交给人工|交人工/u, /显示/u), S(/\boff\b/iu, /only/iu, /truly|actually|really/iu, /handed over|handoff/iu, /appears|shows|card/iu)),
  ],
  'help.ui.inject': [
    r('全部四类', S(/允许/u, /拒绝/u, /超时/u, /故障/u, /全部|都|四类/u), S(/allow/iu, /deny/iu, /timeout/iu, /fail/iu, /all|four/iu)),
    r('仅失败不发允许', S(/仅|只/u, /拒绝/u, /故障/u, /允许/u, /不发送|不发/u), S(/deny/iu, /timeout/iu, /fail/iu, /allow/iu, /skip|not sent|omits/iu)),
    r('关闭零通知', S(/不发送|不发/u, /一条|任何|都不|零/u), S(/send none|none/iu, /no notices|nothing|not a/iu)),
    r('记录视图独立', S(/审查记录|记录/u, /不受|无关|独立/u, /开关/u), S(/review.log|record/iu, /unaffected|independent|nothing to do/iu, /switch/iu)),
  ],
  'help.ui.injectMaxBytes': [
    r('字节上限及截断标记', AND(S(/字节/u, /上限/u), S(/截断|超出/u, /标记/u)), AND(S(/byte/iu, /cap/iu), S(/trim|exceed|longer/iu, /marker/iu))),
    r('零不裁剪', S(/\b0\b/u, /不/u, /裁剪|截断/u), S(/\b0\b/u, /\b(?:no|not|does not)\b/iu, /trim/iu)),
    r('记录独立', S(/审查记录|记录/u, /会话/u, /独立|按会话/u, /无关|不受|不/u), S(/record/iu, /session/iu, /per session|independent/iu, /ignore|regardless|not/iu)),
  ],
  'help.denyPatterns': [
    r('每行正则', S(/每行|一行/u, /正则/u), S(/\bone\b/iu, /regex|regular expression/iu, /per line|each line|line/iu)),
    r('匹配所有字符串参数非仅命令', S(/字符串|参数/u, /全部|所有|不只|不仅/u, /命令/u), S(/string argument|argument|string/iu, /every|not just|all/iu, /command/iu)),
    r('标志格式', T(/\/source\/flags/u), T(/\/source\/flags/u)),
    r('命中拒绝', (text) => hitRejects(text, 'zh'), (text) => hitRejects(text, 'en')),
    r('拒绝无模型人工', S(/命中/u, /拒绝/u, /模型/u, /人工/u, /不|无/u), S(/\bhit\b/iu, /reject/iu, /model/iu, /human/iu, /no|without/iu)),
    r('空只关本层', S(/空/u, /只|仅/u, /本层|这层|文本匹配|这一层/u), S(/empty/iu, /only/iu, /this text check|text check|layer/iu)),
    r('坏正则跳过', S(/不可编译|无法编译/u, /跳过/u), S(/uncompilable|cannot compile/iu, /skip/iu)),
  ],
  'help.language.ui': [
    r('跟随宿主', S(/跟随|auto|宿主/u), S(/follow|auto|host/iu)),
    r('下一渲染生效', S(/下一次|下次|随后/u, /渲染/u, /生效/u), S(/next/iu, /render/iu, /effect|takes effect|applies/iu)),
    r('不影响模型语言', S(/不/u, /模型|文本/u, /改变|影响|触碰/u), S(/never|not/iu, /model.facing|texts|model/iu, /touch|change|affect/iu)),
  ],
  'help.language.agent': [
    r('默认英文', S(/默认/u, /英文/u), S(/default/iu, /English/iu)),
    r('独立界面语言', S(/插件|界面/u, /互不|独立|无关/u, /影响|独立/u), S(/plugin UI|UI/iu, /independent|separate/iu, /language/iu)),
  ],
  'warn.modelIssue.global': [
    r('默认模型不可用', S(/默认|全局/u, /审查模型|模型/u, /不可用|无法|不能|失败/u), S(/default/iu, /reviewer model|model/iu, /unavailable|cannot|failed/iu)),
    r('原因后实际模型', T(/\{reason\}/u, /\{effective\}/u, /实际|当前|使用|在用/u), T(/\{reason\}/u, /\{effective\}/u, /actual|current|using|in use/iu)),
  ],
  'warn.modelIssue.rule': [
    r('规则模型不可用', S(/规则|映射/u, /审查模型|模型|选择/u, /不可用|无法/u), S(/rule|picked/iu, /model/iu, /unavailable/iu)),
    r('原因后实际模型', T(/\{reason\}/u, /\{effective\}/u, /实际|当前|使用|在用/u), T(/\{reason\}/u, /\{effective\}/u, /actual|current|using|in use/iu)),
  ],
  'warn.modelIssue.session': [
    r('会话配置不可用', S(/会话/u, /\{configured\}/u, /不可用/u), S(/session/iu, /\{configured\}/u, /unavailable/iu)),
    r('原因后实际模型', T(/\{reason\}/u, /\{effective\}/u, /实际|当前|使用|在用/u), T(/\{reason\}/u, /\{effective\}/u, /actual|current|using|in use/iu)),
  ],
  'warn.modelIssue.layer': [r('真实生效层', T(/\{layer\}/u, /生效|当前/u), T(/\{layer\}/u, /effective|current/iu))],
  'warn.modelIssue.globalUnset': [
    r('默认未设置', S(/默认|全局/u, /未设置|没有设置|尚未/u), S(/default/iu, /not set|unset/iu)),
    r('仅全局落层跟随', S(/仅|只有/u, /全局/u, /跟随|使用/u, /执行助手/u, /当前模型|当前.{0,4}模型/u), S(/only/iu, /global/iu, /follow|use/iu, /agent/iu, /current/iu, /model/iu)),
    r('无会话及映射条件', S(/无|没有/u, /会话选择/u, /且|和|也/u, /映射/u), S(/no|without/iu, /session choice/iu, /and/iu, /rule/iu)),
    ...shared.independent,
  ],
  'warn.modelIssue.followParent': [
    r(
      '会话未选且默认未设',
      AND(S(/会话/u, /未|没有/u, /选择/u), S(/默认/u, /未设置/u)),
      AND(S(/session/iu, /no|not/iu, /reviewer|own|select/iu), S(/default/iu, /unset|not set/iu)),
    ),
    r('跟随当前执行模型', S(/跟随|使用/u, /执行助手/u, /当前模型/u), S(/follow/iu, /agent/iu, /current model/iu)),
    ...shared.independent,
  ],
  'warn.modelIssue.globalUnsetShadowed': [
    r(
      '全局未设且仅此层跟随',
      AND(S(/默认|全局/u, /未设置/u), S(/仅|只有/u, /全局/u, /跟随/u, /执行助手/u, /当前模型/u)),
      AND(S(/default/iu, /not set|unset/iu), S(/only/iu, /global/iu, /follow/iu, /agent/iu, /current/iu, /model/iu)),
    ),
    ...shared.independent,
  ],
  'card.map.duplicate': [r('每条件唯一', S(/重复/u, /作用范围|范围/u, /执行助手模型|模型/u, /一条|只能|唯一/u), S(/duplicate/iu, /scope/iu, /agent model/iu, /one rule|only one/iu))],
  'card.map.incomplete': [r('未选模型不保存', S(/未选|没有选/u, /执行助手模型|模型/u, /保存/u, /不保留|不留|丢弃/u), AND(S(/no agent model|not chosen/iu, /model/iu), S(/not kept|dropped/iu, /saving|saved/iu)))],
  'card.map.legacy.title': [r('斜杠旧键需确认', S(/旧键|键/u, /斜杠/u, /确认/u), AND(S(/legacy|key/iu, /slash/iu), S(/confirm/iu)))],
  'card.map.legacy.pending': [r('确认前兼容读取原值', S(/确认前|未确认/u, /读取/u, /原值/u, /兼容/u), S(/until confirmed|before confirm/iu, /read|keeps/iu, /value/iu, /compatibility|as.is/iu))],
  'composer.title': [
    r('本会话审查模型', S(/本会话|会话/u, /审查模型|模型/u), S(/session/iu, /reviewer model|model/iu)),
    r('仅本会话选择', S(/只|仅/u, /会话/u), S(/only/iu, /session/iu)),
    ...shared.independent,
  ],
  'cardstate.waiting.deny': [r('模型拒绝非最终结果', AND(S(/自动审查|审查/u, /拒绝/u), T(/\{reason\}/u), (text) => !claimsFinalOutcome(text, 'zh')), AND(S(/review/iu, /deny/iu), T(/\{reason\}/u), (text) => !claimsFinalOutcome(text, 'en')))],
  'cardstate.waiting.timeout': [r('超时无结论', S(/审查/u, /超时/u, /未|无/u, /结论/u), S(/review/iu, /timed out|timeout/iu, /without|no|not/iu, /conclusion/iu))],
  'cardstate.waiting.error': [r('故障无有效结论', AND(S(/审查/u, /未取得|无/u, /结论/u), T(/\{reason\}/u)), AND(S(/review/iu, /failed|error|without/iu, /conclusion/iu), T(/\{reason\}/u)))],
  'card.presets.none': [
    r('空清单已知不接管', S(/空|清单为空/u, /清单|列表/u, /已知/u, /不|无/u, /接管/u), S(/empty/iu, /list/iu, /known|no known/iu, /no|not/iu, /taken over|take/iu)),
    r('未知按设置', S(/无法识别|不能识别/u, /预设/u), S(/cannot be identified|unidentifiable/iu, /preset/iu)),
  ],
  'card.presets.unavailable': [
    r('目录不可读', S(/读不到|无法读取|不可用/u, /预设|目录/u), S(/unavailable|cannot be read|unreadable/iu, /preset|catalog/iu)),
    r('可能原因框架', S(/可能|原因/u), S(/possible|causes/iu)),
    r('服务缺失', S(/服务缺失|服务.{0,4}缺失/u), S(/missing service|service.{0,10}missing/iu)),
    r('读取失败', S(/读取失败|读取时失败|读取.{0,2}失败/u), S(/read failure|a read that failed|failed read|reading fails/iu)),
    r('信息不可用', S(/没有可用|无可用|没有.{0,6}预设信息/u), S(/no preset information|unusable|without preset information/iu)),
    r('检查服务后重试', S(/确认|检查/u, /服务/u, /重试/u), S(/check/iu, /service/iu, /retry/iu)),
  ],
  'card.presets.missing': [r('配置在场但当前表缺失', S(/配置/u, /存在/u, /当前/u, /预设表|预设/u, /没有|不在|缺失/u), S(/configured|config/iu, /absent|missing|not in/iu, /current/iu, /preset/iu, /table/iu))],
  'card.presets.missing.remedy': [
    r(
      '停用兼容自定义排查',
      T(/停用/u, /兼容/u, /自定义/u, /预设/u),
      T(/disabled/iu, /incompatible|compatible/iu, /custom/iu, /preset/iu),
    ),
    r('重新启用或重启可能恢复', S(/重新启用|重启/u, /可能|或许/u, /恢复/u), S(/re.enabl|restart/iu, /may|might/iu, /restore/iu)),
    r(
      '标准档与卸载清理',
      T(/标准/u, /权限档|档/u, /卸载/u, /清理|手工/u),
      T(/standard/iu, /tier/iu, /uninstall/iu, /cleanup|manual/iu),
    ),
    r('插件不改YAML', S(/不/u, /解析/u, /不改写|改写/u, /YAML/u), S(/never|not/iu, /parses/iu, /rewrites/iu, /YAML/iu)),
  ],
  'view.retention': [
    r('记录随会话', S(/记录/u, /会话/u, /跟随|跟着|属于/u), S(/record/iu, /session/iu, /follow|belong|stay with/iu)),
    r('回读窗口及默认', T(/回读|窗口/u, /默认/u, /200/u), T(/window/iu, /default/u, /200/u)),
    r('配置键', T(/ui\.trace\.maxRecords/u), T(/ui\.trace\.maxRecords/u)),
    r(
      '超四倍轮转留窗口删旧',
      S(/四倍/u, /轮转/u, /窗口/u, /删除/u, /更早/u),
      S(/four times/iu, /rewritten|rotation|rotat/iu, /window/iu, /delet/iu, /older/iu),
    ),
    r(
      '超文件上限删最旧',
      S(/文件/u, /上限/u, /删除|删/u, /最旧/u),
      S(/files?/iu, /cap/iu, /delet|go first|dropped/iu, /oldest/iu),
    ),
    r('轮转前备份', S(/轮转/u, /前/u, /备份/u), S(/rotation|rotat/iu, /before/u, /back/iu)),
    r('减少采集不删', S(/减少|调低|降低/u, /采集|capture|collect/u, /不|不会|并不/u, /删除|删|delet/u), S(/reduc|turning.{0,12}down|lower|cut/iu, /capture|collect/iu, /not|never|no/u, /delet|remove/iu)),
  ],
};
const PLACEHOLDERS = {
  'warn.modelIssue.global': ['reason', 'effective'], 'warn.modelIssue.rule': ['reason', 'effective'],
  'warn.modelIssue.session': ['configured', 'reason', 'effective'], 'warn.modelIssue.layer': ['layer'],
  'warn.modelIssue.followParent': ['effective'], 'warn.modelIssue.globalUnsetShadowed': ['effective'],
  'cardstate.waiting.deny': ['reason'], 'cardstate.waiting.error': ['reason'],
};
export const normalizeCopy = (text) => String(text).replace(/[\u2060\u200b]/gu, '').replace(/\s+/gu, ' ').trim();

/**
 * 检查一条文案是否承载该键的全部关键事实。
 * @param {string} key - 文案键（COPY_FACTS 的键）。
 * @param {'zh'|'en'} lang - 语言档。
 * @param {string} text - 文案原文（含 U+2060 等显示保护字符，检查前语义归一）。
 * @returns {string[]} 失败规则 id／占位符问题；空数组＝全部事实与占位符通过。
 */
export function copyFactFailures(key, lang, text) {
  if (typeof text !== 'string' || !text.trim()) return ['说明缺失'];
  const normalized = normalizeCopy(text);
  const failures = key === 'help.mode' ? helpModeFailures(normalized) : (COPY_FACTS[key] ?? []).filter((fact) => {
    const check = fact[lang];
    return typeof check === 'function' ? !check(normalized) : !check.test(normalized);
  }).map((fact) => fact.id);
  const zeroClause = sents(normalized).find((clause) => /\b0\b/u.test(clause));
  if (zeroClause && /timeoutMs$/u.test(key) && /(?:不|不会|并非|不是).{0,3}立即|(?:不|不会|并非|不是)\s*(?:拒绝|超时)|\b(?:does not|do not|doesn't|don't|not|never)\b.{0,15}(?:immediate|at once|reject|time out)|\b(?:reject|timeout)\b.{0,8}\b(?:not|never)\b/iu.test(zeroClause)) failures.push('零值含义反转');
  if (/^(?:hint|help)\.denyPatterns$/u.test(key) && !hitRejects(normalized, lang)) failures.push('命中拒绝含义反转');
  if (zeroClause && /injectMaxBytes$/u.test(key) && /不是不|并非不|not untrimmed|not without trimming/iu.test(zeroClause)) failures.push('零值含义反转');
  if (/tools$/u.test(key) && /空.{0,15}(?:不覆盖|不处理|零工具)|empty[^.;]{0,30}(?:no tools|not cover|excludes all)/iu.test(normalized)) failures.push('空清单含义反转');
  const actual = [...text.matchAll(/\{([a-zA-Z][\w]*)\}/gu)].map((hit) => hit[1]).sort();
  const expected = [...(PLACEHOLDERS[key] ?? [])].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push('占位符名称或次数');
  return failures;
}
/** 防拆连续段必须覆盖否定、有效性和结论三个风险片段，不能只保护相邻的额度说明。 */
export function tokenRiskDisplayProtected(text) {
  return String(text).split(/[。；;（）()]/u).some((part) => {
    if (!/(?:过小|太小|太低|不足)/u.test(normalizeCopy(part))) return false;
    const protectedRuns = part.match(/\p{Script=Han}(?:\u2060\p{Script=Han})+/gu) ?? [];
    return protectedRuns.some((run) => /(?:没有|无|得不到|不产生|难以)(?:任何)?(?:有效|可用)(?:的)?(?:结论|结果|答案)/u.test(normalizeCopy(run)));
  });
}
