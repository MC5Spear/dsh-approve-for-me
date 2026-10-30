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

/** 仅核文本规则的命中→拒绝关系；条件和动作的否定只绑定各自局部分句。 */
function hitRejects(text, lang) {
  const actionNegative = lang === 'zh'
    ? /不|未|无需|无须|可能|也许|或许|有时/u
    : /\b(?:not|no|never|may|might|could|can|sometimes)\b|n['’]t/iu;
  const conditionNegative = lang === 'zh'
    ? /(?:未|不|没有|并未|未能|不曾)(?:发生)?\s*$/u
    : /\b(?:no|not(?:\s+a)?|without(?:\s+a)?|non[- ]?)\s*$/iu;
  let affirmative = 0;
  for (const clause of text.split(/[。；;，,:：.!?！？\n—]/u)) {
    const relations = lang === 'zh'
      ? clause.matchAll(/(?:命中|匹配到)(.*?)拒绝/gu)
      : clause.matchAll(/\b(?:hit|match)\b(.*?)\b(?:rejects?|rejected|deny|denies|denied)\b/giu);
    for (const relation of relations) {
      const negativeCondition = conditionNegative.test(clause.slice(0, relation.index));
      const negativeAction = actionNegative.test(relation[1]);
      if (negativeCondition) {
        if (!negativeAction) return false; // 未命中即拒绝是条件反转；未命中不拒绝不作肯定依据。
      } else {
        if (negativeAction) return false;
        affirmative++;
      }
    }
  }
  return affirmative > 0;
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

/** 已登记正向关系的紧邻否定；只查看关系词前缀，不把其他分句的否定当作反转。 */
function affirmativeConcept(text, lang, concept, definite = false) {
  const negativePrefix = lang === 'zh'
    ? /(?:不|未|非|没有|并非|不是|无需|不能|无法|不再)(?:会|再|更|直接|立即|单独|保持|被|逐条|只|按拒绝|由|因|按|使用|可改选|按拒绝)?\s*$/u
    : /\b(?:not|no|never|without|cannot|can't|doesn't|don't|isn't|aren't)(?:\s+(?:be|a|an|the|as|called|used|run|act|acts|counted|timed|remain|remains|more|directly|immediately))*\s*$/iu;
  let found = false;
  for (const clause of text.split(/[。；;，,:：.!?！？\n—]/u)) {
    const matches = clause.matchAll(new RegExp(concept.source, concept.flags.replace('g', '') + 'g'));
    for (const match of matches) {
      const before = clause.slice(0, match.index);
      if (negativePrefix.test(before)) return false;
      if (definite && (lang === 'zh' ? /(?:未必|不一定)\s*$/u : /\bnot necessarily\s*$/iu).test(before)) return false;
      found = true;
    }
  }
  return found;
}

/** 有限条件关系：只在同一动作分句判断指定条件类别，邻句的相反类别不作全文禁词。 */
function conditionRelation(text, condition, opposite, action, validate = () => true) {
  let found = false;
  for (const clause of sents(text)) {
    if (!action.test(clause)) continue;
    const local = opposite?.test(clause) ? clause.split(/[，,]/u) : [clause];
    if (local.some((part) => action.test(part) && condition.test(part) && !opposite?.test(part) && validate(part))) found = true;
  }
  return found;
}

const EMPTY = { zh: /空|留空/u, en: /\bempt(?:y|ied)\b/iu };
const NONEMPTY = { zh: /非空|不为空|不留空|不是空/u, en: /\bnon[- ]?empty\b|\bnot (?:an? )?empty\b/iu };

/** 空工具清单的明确反转只绑定本分句肯定的空条件，非空／not empty不作空条件。 */
function emptyToolsReversed(text, lang) {
  const condition = lang === 'zh' ? /留空|空/gu : /\bempt(?:y|ied)\b/giu;
  const negatedCondition = lang === 'zh' ? /(?:非|不为|不留|不是)\s*$/u : /\bnon[- ]?$|\bnot\s+(?:an?\s+)?$/iu;
  const reversal = lang === 'zh' ? /^[^。；，]{0,15}(?:不覆盖|不处理|零工具)/u : /^[^.;,]{0,30}(?:no tools|not cover|excludes all)/iu;
  for (const part of text.split(/[。；;，,.\n]|\b(?:but|while)\b/iu)) {
    for (const match of part.matchAll(condition)) {
      if (negatedCondition.test(part.slice(0, match.index))) continue;
      if (reversal.test(part.slice(match.index + match[0].length))) return true;
    }
  }
  return false;
}
const UNSET = { zh: /未设置|没有设置|尚未设置|为空/u, en: /\bunset\b|\bnot set\b/iu };
const SET = { zh: /已设置|已经设置|不为空/u, en: /\b(?:is|already) set\b|(?<!not )\bset(?: means| default| reviews)/iu };

// 条件类别以外，动作极性也只核这些已登记关系；不涉及其他说明的否定。
const CONDITION_ACTIONS = {
  '空清单条件': [/覆盖|包含|适用|处理/u, /covers?|includes?|applies|handles?|takes?/iu],
  '空预设条件': [null, null, /不是不|并非不|不再[^。；]{0,8}不接管/u, /not\s+(?:no|not)|not\s+taken over/iu],
  '空拒绝层条件': [/关闭/u, /disables?/iu],
  '空强度自动条件': [/自动/u, /automatic/iu],
  '清单内预设接管条件': [/处理升权|接管/u, /hand/iu],
  'Reject结算条件': [/结算/u, /settles?/iu],
  'Ask人工卡片条件': [/显示/u, /shows?/iu],
  '仅人工备用条件': [/使用|生效|适用/u, /used|applies/iu],
  '未设默认跟随条件': [/跟随|使用/u, /\bfollow\b|\breviews?\b|\bmeans?\b/iu],
  '关闭等同未装条件': [/等同|一样|相同/u, /behaves|same|like/iu],
  '关闭不接管条件': [null, null, /不是不|并非不/u, /not\s+no take|not\s+not take/iu],
  '关闭才交人工条件': [/显示/u, /appears?|shows?/iu],
  '关闭零通知条件': [null, null, /不是不发送|并非不发/u, /not\s+(?:no|nothing|not a)/iu],
  '开启逐条条件': [/记录/u, /logged|log/iu],
  '关闭单条条件': [/记录/u, /one line|single|logged|log/iu],
};

/** 只登记当前文案已承诺的条件，未知改写仍须人工核对。 */
function conditionFactFailures(key, lang, text) {
  const failures = [];
  if (key === 'hint.trigger.unknown' && !(lang === 'zh' ? /读不到|无法读取|无法识别|不可读|读取不到/u : /cannot be read|unreadable|cannot be identified/iu).test(text)) failures.push('读不到预设条件');
  if ((key === 'hint.reviewer.model' || key === 'help.reviewer.model') && (lang === 'zh' ? /不使用执行助手/u : /not the agent|not on the agent|any model/iu).test(text)) failures.push('默认跟随目标反转');
  if (key === 'hint.allowEscalationTo' && !(lang === 'zh' ? /更高[^。；]{0,12}(?:不|不能|不会)[^。；]{0,8}批准/u : /wider[^.;]{0,24}(?:never|not)[^.;]{0,12}approv/iu).test(text)) failures.push('更高权限不批准');
  const check = (id, condition, opposite, action) => {
    const spec = CONDITION_ACTIONS[id];
    const validate = (clause) => {
      if (!spec) return true;
      const concept = spec[lang === 'zh' ? 0 : 1];
      const reversal = spec[lang === 'zh' ? 2 : 3];
      if (id === '空预设条件' && !(lang === 'zh' ? /(?:不|无)[^。；]{0,5}接管/u : /no known preset|not[^.;]{0,12}(?:take|taken)/iu).test(clause)) return false;
      return (!concept || affirmativeConcept(clause, lang, concept)) && !reversal?.test(clause);
    };
    if (!conditionRelation(text, condition, opposite, action, validate)) failures.push(id);
  };
  if (/^(?:hint|help)\.tools$/u.test(key)) check('空清单条件', EMPTY[lang], NONEMPTY[lang], lang === 'zh' ? /(?:覆盖|包含|适用|处理)(?:全部|所有|一切)/u : /(?:covers?|includes?|applies|handles?|takes?)[^.;]{0,12}\b(?:all|every)\b/iu);
  if (key === 'help.trigger.presets' || key === 'card.presets.none') check('空预设条件', EMPTY[lang], NONEMPTY[lang], lang === 'zh' ? /已知[^。；]{0,12}(?:不|无)[^。；]{0,5}接管/u : /known preset/iu);
  if (key === 'help.denyPatterns') check('空拒绝层条件', EMPTY[lang], NONEMPTY[lang], lang === 'zh' ? /只关闭|仅关闭/u : /disables? only|only[^.;]{0,16}(?:disables?|text check|layer)/iu);
  if (key === 'help.reviewer.model') check('空强度自动条件', lang === 'zh' ? /留空|不填|强度.{0,4}空/u : /(?:empty|blank) effort/iu, lang === 'zh' ? /非空|不留空|强度.{0,4}不为空/u : /non[- ]?empty effort|not (?:an? )?(?:empty|blank) effort/iu, lang === 'zh' ? /自动/u : /automatic/iu);
  if ((key === 'help.human.timeoutMs' || /^warn\.modelIssue\.globalUnset(?:Shadowed)?$/u.test(key)) && (lang === 'zh' ? /(?:不只|不仅)(?:在|当)[^。；]{0,40}(?:交给人工决定|人工决定|全局)/u : /not only when[^.;]{0,60}(?:ask|global)/iu).test(text)) failures.push('仅在条件被扩大');
  if (key === 'hint.trigger.presets' || key === 'help.trigger.presets') check('清单内预设接管条件', lang === 'zh' ? /清单内/u : /(?<!un)\blisted\b/iu, lang === 'zh' ? /清单外/u : /\bunlisted\b/iu, lang === 'zh' ? /处理升权|接管升权/u : /hand[^.;]{0,30}escalation/iu);
  if (key === 'help.fallback') {
    check('Reject结算条件', lang === 'zh' ? /直接拒绝[＝=]/u : /\breject settles/iu, lang === 'zh' ? /交给人工决定[＝=]/u : /\bask settles/iu, lang === 'zh' ? /按拒绝结算/u : /settles as a rejection/iu);
    check('Ask人工卡片条件', lang === 'zh' ? /交给人工决定[＝=]/u : /\bask shows/iu, lang === 'zh' ? /直接拒绝[＝=]/u : /\breject shows/iu, lang === 'zh' ? /显示人工审批卡片/u : /shows the human card/iu);
  }
  if (key === 'help.human.timeoutMs') check('仅人工备用条件', lang === 'zh' ? /(?:仅|只)[^。；]{0,18}(?:交给人工决定|交人工|人工决定)/u : /only[^.;]{0,40}\b(?:ask|handoff)\b/iu, lang === 'zh' ? /(?:仅|只)[^。；]{0,18}直接拒绝/u : /only[^.;]{0,40}\breject\b/iu, lang === 'zh' ? /使用|生效|适用|时/u : /used|when|applies/iu);
  if (key === 'hint.reviewer.model' || key === 'help.reviewer.model' || /^warn\.modelIssue\.(?:globalUnset|followParent|globalUnsetShadowed)$/u.test(key)) check('未设默认跟随条件', UNSET[lang], SET[lang], lang === 'zh' ? /(?:跟随|使用)[^。；]{0,12}执行助手/u : /(?:follow|review|means)[^.;]{0,30}(?:agent|current model)/iu);
  if (key === 'warn.modelIssue.globalUnset') {
    const noSession = lang === 'zh' ? /(?:无|没有)(?:有效|生效的)?会话选择/u : /(?:no|without) (?:effective )?session choice/iu;
    const noRule = lang === 'zh' ? /(?:无|没有)(?:有效|生效的)?映射/u : /(?:no|without) (?:effective )?rule/iu;
    const bothAbsent = lang === 'zh' ? /(?:无|没有)(?:有效|生效的)?会话选择(?:且|和)(?:无|没有)?(?:有效|生效的)?映射/u : /(?:no|without) (?:effective )?session choice and (?:no (?:effective )?)?rule/iu;
    if (!(bothAbsent.test(text) || noSession.test(text) && noRule.test(text))) failures.push('无会话且无映射条件');
  }
  if (/^warn\.modelIssue\.(?:global|rule|session)$/u.test(key)) check('模型不可用条件', lang === 'zh' ? /不可用|无法|不能|失败/u : /unavailable|cannot|failed/iu, lang === 'zh' ? /模型[^。；:：]{0,20}(?<!不)可用/u : /(?<!un)\bavailable\b/iu, lang === 'zh' ? /模型/u : /model/iu);
  if (key === 'warn.modelIssue.followParent' && !(lang === 'zh' ? /会话(?:未|没有)(?:单独)?选择/u : /session has no reviewer|session[^.;]{0,15}(?:not selected|no choice)/iu).test(text)) failures.push('会话未选择条件');
  if (/^warn\.modelIssue\.(?:globalUnset|globalUnsetShadowed)$/u.test(key) && !(lang === 'zh' ? /仅|只有/u : /only/iu).test(text)) failures.push('仅全局落层条件');
  const zeroKey = /^(?:hint|help)\.(?:reviewer\.(?:timeoutMs|maxTokens)|human\.timeoutMs|ui\.injectMaxBytes)$/u.test(key);
  if (zeroKey) {
    check('零值条件', /\b0\b/u, lang === 'zh' ? /非\s*0|不为\s*0|大于\s*0/u : /non[- ]?zero|non[- ]?0|not\s+0|greater than\s+0/iu, /\b0\b|non[- ]?zero/iu);
    for (const clause of sents(text).filter((part) => /\b0\b/u.test(part))) {
      if (/maxTokens$/u.test(key) && (lang === 'zh' ? /不是不|并非不|仍(?:向模型)?传|仍发送/u : /not\s+(?:send\s+)?(?:no|omit)|still sends?\s+(?:a|the)\s+cap/iu).test(clause)) failures.push('零不传额度动作反转');
      if (/injectMaxBytes$/u.test(key) && (lang === 'zh' ? /不是不|并非不|仍裁剪/u : /not\s+(?:no|not)|still trims?/iu).test(clause)) failures.push('零不裁剪动作反转');
    }
  }
  if (key === 'help.mode') check('关闭等同未装条件', lang === 'zh' ? /关闭|完全不接管/u : /\boff\b/iu, lang === 'zh' ? /开启|完全接管/u : /\bon\b/iu, lang === 'zh' ? /等同未安装|与未安装|如同未安装/u : /uninstalled|not installed/iu);
  if (key === 'hint.mode') check('关闭不接管条件', lang === 'zh' ? /关闭|关掉/u : /\boff\b/iu, lang === 'zh' ? /开启|打开/u : /\bon\b/iu, lang === 'zh' ? /不接管/u : /no take.over|not take.over/iu);
  if (key === 'help.ui.humanCardDuringReview') check('关闭才交人工条件', lang === 'zh' ? /关闭/u : /\boff\b/iu, lang === 'zh' ? /开启/u : /\bon\b/iu, lang === 'zh' ? /仅在确实|只[^。；]{0,8}真正/u : /only[^.;]{0,40}(?:truly|actually|really)/iu);
  if (key === 'help.ui.inject') check('关闭零通知条件', lang === 'zh' ? /(?:选|选择)[「“"]?不发送[」”"]?[＝=]/u : /(?:pick\s*["']?)?send none/iu, lang === 'zh' ? /(?:选|选择)[「“"]?(?:四类都发送|全部发送)[」”"]?[＝=]/u : /send all[^.;]{0,15}(?:no notices|nothing|not a)/iu, lang === 'zh' ? /(?:一条|任何)[^。；]{0,8}(?:不发送|不发)/u : /no notices|nothing|not a single/iu);
  if (key === 'help.trigger.auditEverySkip') {
    check('开启逐条条件', lang === 'zh' ? /开启|打开/u : /\bon\b/iu, lang === 'zh' ? /关闭|关掉/u : /\boff\b/iu, lang === 'zh' ? /每次|逐条/u : /every/iu);
    check('关闭单条条件', lang === 'zh' ? /关闭|关掉/u : /\boff\b/iu, lang === 'zh' ? /开启|打开/u : /\bon\b/iu, lang === 'zh' ? /同一[^。；]{0,16}一条/u : /one line|single/iu);
  }
  return failures;
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
    r('审查独立调用', AND(S(/独立|另行|单独/u, /调用|审查|发起/u), (text) => affirmativeConcept(text, 'zh', /独立|(?:另行|单独)(?=(?:进行|作出|发起)?(?:调用|审查))/u)), AND(S(/independent|separately|on its own/iu, /call|review|issued/iu), (text) => affirmativeConcept(text, 'en', /independent(?:ly)?|separately|on its own/iu))),
  ],
};

// ── help.mode：复用 mode-copy-facts 的总开关事实检查器（避免两套权威） ──

/** help.mode 检查器缺失事实 id → 本表规则 id 的映射（on 两项并入「规则加模型正常接管」）。 */
const MODE_RULE_BY_MISSING = {
  'on-rule-check': '规则加模型正常接管',
  'on-llm-review': '规则加模型正常接管',
  'off-no-takeover': '关闭等同未装',
  'off-equivalent-to-uninstalled': '关闭等同未装',
  'host-flow-unaffected': '宿主流程不受影响',
  'off-reversal': '关闭含义反转',
};

/** help.mode 仅映射专用唯一权威返回的事实 id，不另作语义补充。 */
function helpModeFailures(text) {
  return [...new Set(checkModeHelpFacts(text).map((id) => MODE_RULE_BY_MISSING[id] ?? id))];
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
    r('映射先于全局', AND(/(?:命中|映射|规则)[^。；]{0,8}(?:先于|优先于|高于)[^。；]{0,8}全局/u, (text) => affirmativeConcept(text, 'zh', /先于|优先于|高于/u, true)), AND(/\bhit\b[^.;]{0,40}(?:beats|outranks)[^.;]{0,40}global/iu, (text) => affirmativeConcept(text, 'en', /beats?|outranks?/iu, true))),
    r('会话更优先', AND(/会话选择[^。；]{0,8}更优先|会话选择[^。；]{0,6}最高/u, (text) => affirmativeConcept(text, 'zh', /更优先|最高/u, true)), AND(/session choice[^.;]{0,30}(?:beats|outranks|tops)/iu, (text) => affirmativeConcept(text, 'en', /beats?|outranks?|tops?/iu, true))),
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
    r('完整id作用范围', S(/任意 provider|provider/iu, /完整.{0,4}模型|模型 id/u, /作用范围|范围/u), S(/any provider|scope/iu, /full model id|complete model id|model id/iu, /scope|provider/iu)),
    r(
      '会话高于映射高于全局',
      // 方向性共现：主语在前、优先词居中、宾语在后，反转顺序必红。
      AND(/会话选择[^。；]{0,8}更优先|会话选择[^。；]{0,6}最高/u, /命中[^。；]{0,8}(?:先于|优先于|高于)[^。；]{0,8}全局/u, (text) => affirmativeConcept(text, 'zh', /更优先|最高|先于|优先于|高于/u, true)),
      AND(/session choice[^.;]{0,30}(?:outranks|beats)/iu, /\bhit\b[^.;]{0,40}(?:outranks|beats)[^.;]{0,40}global/iu, (text) => affirmativeConcept(text, 'en', /beats?|outranks?/iu, true)),
    ),
    r('唯一条件', S(/只能有一条|只允许一条|唯一/u, /规则|条/u), S(/one rule/iu, /per|scope/iu)),
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
    r('排队不占预算', AND(S(/排队|队列/u, /独立|单独|另行/u, /计时|另计/u, /不消耗|不占用|不算|不占/u), (text) => affirmativeConcept(text, 'zh', /独立|单独|另行/u)), AND(S(/queue/iu, /separate|independent|on its own/iu, /timed|clocked|counted/iu, /not consume|never consume|does not consume|consume nothing/iu), (text) => affirmativeConcept(text, 'en', /separately|separate|independent|on its own/iu))),
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
    r('抢先人工优先', AND(S(/抢先|先/u, /人工/u, /优先/u), /人工(?:结果|作答)[^。；]{0,4}优先/u, (text) => affirmativeConcept(text, 'zh', /优先/u)), AND(S(/answer first|first/iu, /human/iu, /wins|beats|prevails/iu), /human answer[^.;]{0,6}(?:wins|beats|prevails)/iu, (text) => affirmativeConcept(text, 'en', /wins?|beats?|prevails?/iu))),
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
    r('拒绝无模型人工', S(/命中|匹配到/u, /拒绝/u, /模型/u, /人工/u, /不|无/u), S(/\b(?:hit|match)\b/iu, /reject/iu, /model/iu, /human/iu, /no|without/iu)),
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
    r('轮转前备份', S(/轮转/u, /前/u, /备份/u), AND(T(/rotation|rotat/iu, /before/iu, /back/iu), /before[^.;]{0,16}rotat/iu)),
    r('减少采集不删', S(/减少|调低|降低/u, /采集|capture|collect/u, /不|不会|并不/u, /删除|删|delet/u), S(/reduc|turning.{0,12}down|lower|cut/iu, /capture|collect/iu, /not|never|no/u, /delet|remove/iu)),
  ],
};
// 每个不同事实只列一个主类；行为/状态与精确记号的测试职责分开。
export const FACT_KINDS = {
  positive: '采用模型或供应商默认|审查文本和执行通知|审查期间提前人工卡片|阈值依模型和强度|清单外宿主流程|接管升权|其他预设保留流程|未知预设按设置|强度自动低档|否则模型默认|旧纯id任意provider|装配结论全程|到点拒绝|请求起算用剩余|交人工重新起算|范围仍审查|完全访问最宽|拒绝结算|人工卡片和超时拒绝|分叉按主会话|全部四类|字节上限及截断标记|匹配所有字符串参数非仅命令|坏正则跳过|跟随宿主|下一渲染生效|默认英文|原因后实际模型|真实生效层|跟随当前执行模型|斜杠旧键需确认|确认前兼容读取原值|未知按设置|检查服务后重试|标准档与卸载清理|记录随会话|超四倍轮转留窗口删旧|超文件上限删最旧|轮转前备份'.split('|'),
  negative: '操作无法识别|模型人工不能推翻|不是额外授权|不影响审批|斜杠确认且不自动改写|重试不重赠|超时拒绝报环节不是危险|不是全批|工作区不放行更宽|拒绝不调模型|缺失标记不作安全|委派无人工|已结算不可迟改|仅失败不发允许|记录视图独立|记录独立|拒绝无模型人工|不影响模型语言|独立界面语言|默认模型不可用|规则模型不可用|会话配置不可用|未选模型不保存|模型拒绝非最终结果|超时无结论|故障无有效结论|目录不可读|服务缺失|读取失败|信息不可用|配置在场但当前表缺失|插件不改YAML|减少采集不删'.split('|'),
  condition: '额度可能先用于推理|过小上限可能无有效结论|重新启用或重启可能恢复|预设清单决定接管升权|读不到预设的处置|预设不匹配跳过记录|未设置跟随当前模型|零立即超时|零立即拒绝|零不传上限|关闭完全不接管|最高权限及更高不批|审查未允许后处置|零不裁剪|空清单覆盖全部|命中拒绝|填写后只处理名单内|空清单已知不接管|不接管与继续两分支|开启逐条|关闭同原因一条|未设跟随当前模型|排队不占预算|零立即到点|仅人工备用|零拒绝非无限|关闭后真交人工才显示|关闭零通知|空只关本层|默认未设置|仅全局落层跟随|无会话及映射条件|会话未选且默认未设|全局未设且仅此层跟随|仅本会话选择'.split('|'),
  direction: '映射先于全局|会话更优先|会话映射全局顺序|审查独立调用|会话高于映射高于全局|抢先人工优先'.split('|'),
  quantity: '毫秒单位|通知字节单位|每行一个工具|每行正则|唯一条件|每条件唯一|回读窗口及默认'.split('|'),
  format: '模型引用格式|标志格式|配置键'.split('|'),
  object: '默认模型与强度|执行模型匹配|插件界面语言|token 文本计量单位|请求和交人工两个起点|给执行助手通知范围|完整id作用范围|最高权限上限|本会话审查模型|可能原因框架|停用兼容自定义排查'.split('|'),
};

/** 行为极性只作用于该事实的对象子句，不能从无关分句借否定或动作。 */
const behaviorPositive = (zhSubject, zhAction, enSubject, enAction) => {
  const check = (text, lang, subject, action) => {
    const relevant = sents(text).filter((part) => subject.test(part) && action.test(part));
    return relevant.length > 0 && relevant.every((part) => affirmativeConcept(part, lang, action));
  };
  return { zh: (text) => check(text, 'zh', zhSubject, zhAction), en: (text) => check(text, 'en', enSubject, enAction) };
};
const behaviorNegative = (zh, en) => ({ zh, en });

/** 会话文件淘汰只配对自身上限与最旧文件动作，备份／其他目录的不删不作该动作否定。 */
function oldestSessionFileEviction(text, lang) {
  const subject = lang === 'zh' ? /会话文件/u : /session files?/iu;
  const limit = lang === 'zh' ? /上限/u : /\bcap\b/iu;
  const boundary = lang === 'zh' ? /超上限|超过上限/u : /exceeded|pass/iu;
  const targetAction = lang === 'zh'
    ? /(?:(?:不|未|并非)\s*)?(?:删除|删)最旧/gu
    : /\boldest (?:session files|ones)\s+(?:are\s+)?(?:(?:not|never)\s+)?(?:deleted|dropped|go first)\b/giu;
  const action = lang === 'zh' ? /删除|删/u : /deleted|dropped|go first/iu;
  let found = false;
  for (const part of sents(text)) {
    if (!subject.test(part) || !limit.test(part)) continue;
    for (const match of part.matchAll(targetAction)) {
      const reached = affirmativeConcept(part, lang, boundary);
      const executes = affirmativeConcept(match[0], lang, action);
      if (reached !== executes) return false;
      if (reached) found = true;
    }
  }
  return found;
}

/** 分叉的分类谓词绑定主会话对象；其他对象的not treated不借为本关系否定。 */
function forkedAsMainSession(text, lang) {
  const relation = lang === 'zh'
    ? /分叉会话\s*(不|未|并非)?(?:按|算作?|视为)主会话(?:对待)?/gu
    : /\bforked sessions?\s+(?:(?:are|is)\s+)?(?:(not|never)\s+)?(?:treated|classified|handled)\s+as\s+(?:(not)\s+)?(?:(?:a|the)\s+)?main sessions?\b/giu;
  let found = false;
  for (const part of text.split(/[。；;，,.\n]|\bbut\b/iu)) {
    for (const match of part.matchAll(relation)) {
      const before = part.slice(0, match.index);
      const outerNegative = lang === 'zh'
        ? /(?:并非|不是|不能说)\s*$/u.test(before)
        : /\bit is not (?:true|the case) that\s*$/iu.test(before);
      const predicateNegative = Boolean(match[1] || match[2]);
      if (predicateNegative !== outerNegative) return false;
      found = true;
    }
  }
  return found;
}

/** 三项可能性事实：检查动作前的情态作用域；“可能不”仍是可能，“不可能”及必然结论不是。 */
function possibleEvent(text, lang, subject, event) {
  const maybe = lang === 'zh'
    ? /(?:(?<!不)可能|或许|也许|或可|可以|可|会)(?:不|不会|无法)?\s*$/u
    : /\b(?:may|might|could|can)(?:\s+or\s+(?:may|might|could|can))?(?:\s+not)?\s*$/iu;
  const impossibleOrCertain = lang === 'zh'
    ? /(?:不可能|不能|不会|无法|从不|绝不|绝不会|不|必然|一定|必定|总会)(?:再|能够|会)?\s*$/u
    : /\b(?:cannot|can['’]t|could not|couldn['’]t|does not|doesn['’]t|do not|don['’]t|will not|won['’]t|never|always|must|certainly|definitely|not possible to|impossible to|guaranteed to)\s*$/iu;
  let found = false;
  for (const clause of text.split(/[。；;，,.!?！？\n—]/u)) {
    if (!subject.test(clause)) continue;
    for (const match of clause.matchAll(new RegExp(event.source, event.flags.replace('g', '') + 'g'))) {
      const prefix = clause.slice(0, match.index);
      const uncertain = maybe.test(prefix);
      // 先认不可能，避免把“不会”的尾字“会”误当可能；“可能不会”则保留不确定性。
      const uncertainNegative = lang === 'zh' ? /(?<!不)(?:可能|或许|也许)(?:不|不会|无法)\s*$/u.test(prefix) : /\b(?:may|might|could)(?:\s+or\s+(?:may|might|could))?\s+not\s*$/iu.test(prefix);
      if (impossibleOrCertain.test(prefix) && !uncertainNegative || !uncertain) return false;
      found = true;
    }
  }
  return found;
}
const modalFact = (zhSubject, zhEvent, enSubject, enEvent) => ({
  zh: (text) => possibleEvent(text, 'zh', zhSubject, zhEvent),
  en: (text) => possibleEvent(text, 'en', enSubject, enEvent),
});

/** 阈值与动作极性须配对；未达到阈值且不执行是正确邻句，但不能替代达到阈值时执行的事实。 */
function thresholdEvent(text, lang, boundary, action, joinComma = false) {
  const parts = text.split(joinComma ? /[。；;.!?！？\n—]/u : /[。；;，,.!?！？\n—]/u).filter((part) => boundary.test(part) && action.test(part));
  let found = false;
  for (const part of parts) {
    const reached = affirmativeConcept(part, lang, boundary);
    const executes = affirmativeConcept(part, lang, action);
    if (reached !== executes) return false;
    if (reached) found = true;
  }
  return found;
}

/** 内部前置、阈值、范围与时序独立于主分类；只核已登记事实当前承载的短关系。 */
const SUBCONDITION_FACTS = {
  '强度自动低档': {
    zh: (text) => sents(text).some((part) => /模型支持\s*`?low`?[^。；]{0,5}(?:使用|选用)\s*`?low`?/iu.test(part) && !/(?:不|未)支持\s*`?low`?[^。；]{0,5}(?:使用|选用)/iu.test(part)),
    en: (text) => sents(text).some((part) => /(?:use\s*`?low`?\s+when the model supports it|when the model supports\s*`?low`?[^.;]{0,4}use\s*`?low`?)/iu.test(part) && !/(?:does not|doesn't|cannot|can't) support[^.;]{0,8}(?:it|`?low`?)/iu.test(part)),
  },
  '否则模型默认': { zh: (text) => /否则|不然|若不支持/u.test(text), en: (text) => /otherwise|else|if not/iu.test(text) },
  '填写后只处理名单内': {
    zh: (text) => conditionRelation(text, /填写|填入|填/u, null, /(?:只|仅)[^。；]{0,8}(?:名单|清单|列表)(?:之)?内/u, (part) => !/(?:不只|不仅)[^。；]{0,8}(?:名单|清单|列表)(?:之)?内/u.test(part)),
    en: (text) => conditionRelation(text, /filled/iu, null, /(?:only|just) (?:the )?listed tools/iu, (part) => !/not (?:only|just) (?:the )?listed tools/iu.test(part)),
  },
  '完整id作用范围': { zh: (text) => /完整.{0,4}模型/u.test(text) && !/(?:不完整|部分).{0,4}模型/u.test(text), en: (text) => /(?:full|complete) model id/iu.test(text) && !/(?:not full|not complete|partial) model id/iu.test(text) },
  '唯一条件': { zh: (text) => /同一作用范围(?:与|和|加)(?:同一)?执行助手模型[^。；]{0,8}(?:一条|唯一)/u.test(text), en: (text) => /one rule (?:per|for each) scope (?:and|plus) agent model|(?:each )?scope plus (?:one )?agent model[^.;]{0,20}one rule/iu.test(text) },
  '每条件唯一': { zh: (text) => /同一作用范围(?:与|加|和)(?:同一)?执行助手模型[^。；]{0,8}(?:一条|唯一)/u.test(text), en: (text) => /one rule (?:per|for each) scope (?:and|plus) agent model|(?:each )?scope plus (?:one )?agent model[^.;]{0,20}one rule/iu.test(text) },
  '旧纯id任意provider': { zh: (text) => /纯(?:模型 )?\s*id[^。；]{0,8}任意 provider/iu.test(text), en: (text) => /plain.id[^.;]{0,20}any.provider/iu.test(text) },
  '斜杠确认且不自动改写': { zh: (text) => sents(text).some((part) => /确认前|未确认/u.test(part) && /原值/u.test(part) && /读取/u.test(part)), en: (text) => sents(text).some((part) => /until confirmed|before confirm(?:ation)?/iu.test(part) && /as.is/iu.test(part)) },
  '请求起算用剩余': { zh: (text) => sents(text).some((part) => /审批请求[^。；]{0,6}(?:起算|开始计时)/u.test(part) && /剩余|余下/u.test(part)), en: (text) => sents(text).some((part) => /(?:from|at) the approval request/iu.test(part) && /remainder|remaining/iu.test(part)) },
  '交人工重新起算': { zh: (text) => sents(text).some((part) => /从交人工(?:起算|开始计时)/u.test(part) && /重新|重起|另起/u.test(part)), en: (text) => /(?:from|at) the handoff itself|handoff[^.;]{0,16}(?:fresh|restart|begins again)/iu.test(text) },
  '范围仍审查': { zh: (text) => /范围内/u.test(text) && !/范围外[^。；]{0,8}(?:仍须|仍要|必须)[^。；]{0,12}(?:规则检查|模型审查)/u.test(text), en: (text) => /in range|in scope/iu.test(text) && !/(?:out of|outside) (?:range|scope)[^.;]{0,32}(?:rule|review)/iu.test(text) },
  '完全访问最宽': { zh: (text) => /完全访问[^。；]{0,12}最宽/u.test(text), en: (text) => /full access[^.;]{0,24}widest/iu.test(text) },
  '工作区不放行更宽': { zh: (text) => affirmativeConcept(text, 'zh', /超出|更高|更宽|以上/u) && /(?:超出|更高|更宽|以上)[^。；]{0,16}(?:升权|写入)/u.test(text), en: (text) => /wider escalations|escalation beyond workspace/iu.test(text) },
  '已结算不可迟改': { zh: (text) => /(?:已完成|已结算)的?结果/u.test(text) && !/(?:未完成|未结算)的?结果[^。；]{0,24}(?:推翻|改变)/u.test(text), en: (text) => /\bsettled result\b/iu.test(text) && !/\b(?:unsettled|not settled) result\b/iu.test(text) },
  '关闭后真交人工才显示': { zh: (text) => !/(?:不只|不仅)[^。；]{0,18}(?:交给人工|交人工)/u.test(text), en: (text) => !/not only[^.;]{0,50}handed over/iu.test(text) },
  '全部四类': { zh: (text) => /四类|全部/u.test(text) && !/非四类|不全/u.test(text), en: (text) => /all four/iu.test(text) && !/not all four/iu.test(text) },
  '仅失败不发允许': { zh: (text) => /仅拒绝|只[^。；]{0,6}拒绝/u.test(text) && !/不仅拒绝|不只[^。；]{0,6}拒绝/u.test(text), en: (text) => sents(text).filter((part) => /skips? allow|omits? allow|allow notices are not sent/iu.test(part)).every((part) => !/deny[^.;]{0,40}(?:not only|and allow)/iu.test(part)) },
  '字节上限及截断标记': {
    zh: (text) => thresholdEvent(text, 'zh', /超出|超过/u, /截断|裁剪/u),
    en: (text) => thresholdEvent(text, 'en', /longer|exceeds?|exceeding/iu, /trim(?:med)?/iu),
  },
  '匹配所有字符串参数非仅命令': { zh: (text) => /全部字符串|所有字符串/u.test(text) && !/(?<!不)(?:仅|只)命令字段/u.test(text), en: (text) => /every string argument|all string argument/iu.test(text) && !/(?<!not )only (?:the )?command|not every string argument/iu.test(text) },
  '空只关本层': { zh: (text) => !/(?:不只|不仅)关闭/u.test(text), en: (text) => !/disables? not only|not only this text check/iu.test(text) },
  '坏正则跳过': { zh: (text) => /不可编译|无法编译/u.test(text) && !/(?<!不)可编译的行跳过/u.test(text), en: (text) => /uncompilable|cannot compile/iu.test(text) },
  '下一渲染生效': { zh: (text) => /下一次|下次|随后/u.test(text), en: (text) => /next render/iu.test(text) },
  '未选模型不保存': { zh: (text) => /未选|没有选/u.test(text), en: (text) => /no agent model|not chosen/iu.test(text) },
  '确认前兼容读取原值': { zh: (text) => /确认前|未确认/u.test(text), en: (text) => /until confirmed|before confirm(?:ation)?/iu.test(text) },
  '仅本会话选择': { zh: (text) => /只给这个会话|只给这一个会话|仅本会话/u.test(text) && !/不只给|不仅本会话/u.test(text), en: (text) => /this session only|only (?:for )?this session/iu.test(text) && !/not only (?:for )?this session|not this session only/iu.test(text) },
  '回读窗口及默认': { zh: (text) => /默认\s*200\s*条/u.test(text) && !/默认非\s*200|默认不(?:是|为)\s*200/u.test(text), en: (text) => /\b200 entries by default|default[^.;]{0,10}\b200\b/iu.test(text) && !/not\s+200|non[- ]?200/iu.test(text) },
  '超四倍轮转留窗口删旧': {
    zh: (text) => thresholdEvent(text, 'zh', /超过|超出/u, /轮转/u) && /(?:超过|超出)[^。；]{0,12}四倍/u.test(text) && /最近(?:一个)?窗口|最近窗口/u.test(text) && !/不是最近|非最近|保留最旧/u.test(text),
    en: (text) => thresholdEvent(text, 'en', /exceeds?|passes|pass/iu, /rewritten|rotat/iu, true) && /four times/iu.test(text) && /latest|recent/iu.test(text) && !/not (?:the )?latest|keep only (?:the )?oldest one/iu.test(text),
  },
  '超文件上限删最旧': { zh: (text) => oldestSessionFileEviction(text, 'zh'), en: (text) => oldestSessionFileEviction(text, 'en') },
  '轮转前备份': { zh: (text) => /轮转前|轮转之前/u.test(text), en: (text) => /before rotation/iu.test(text) },
  '过小上限可能无有效结论': { zh: (text) => affirmativeConcept(text, 'zh', /过小|太小|太低|不足/u), en: (text) => affirmativeConcept(text, 'en', /too small|too low|insufficient/iu) },
};
export const SUBCONDITION_IDS = Object.keys(SUBCONDITION_FACTS);

/** 明确取消只绑定登记负关系的局部匹配；原关系自身的not/不是不算外层取消。 */
function negativeRelationCancelled(text, lang, spec) {
  const relation = spec.assertion ?? spec;
  const cancel = lang === 'zh'
    ? /并非|不是|不属于?|不能说|不能认为|不再|这一说法不成立/gu
    : /\bit is not true that\b|\bit is not the case that\b|\bcannot say(?: that)?\b|\bcan['’]t say(?: that)?\b|\bdoes not mean\b|\bdoesn['’]t mean\b|\bno longer means\b|\bno longer\b|\bnot\b|\bis false\b|\bis not true\b/giu;
  // 独立转折另起作用域；“configured but absent”共用主语的短关系不拆。
  const parts = text.split(/[。；;.!?！？\n—]/iu).flatMap((sentence) =>
    sentence.split(/\bbut\b(?=\s+(?:the|a|an|this|that|it|internal)\b)|但是/iu).flatMap((independent) => {
      if (lang === 'en' && /\b(?:it is not true that|it is not the case that|cannot say(?: that)?|can['’]t say(?: that)?)\b/iu.test(independent)) return [independent];
      return independent.split(/[，,:：]|\bbut\b/iu);
    }));
  for (const original of parts) {
    let part = original;
    if (spec.meaning) for (const meaning of original.matchAll(/\b(?:does not mean|doesn['’]t mean|no longer means)\b/giu)) {
      const before = original.slice(0, meaning.index);
      const subject = before.match(spec.meaning.subject);
      const predicate = original.slice(meaning.index + meaning[0].length).match(spec.meaning.predicate);
      if (!subject || !predicate) continue;
      const enclosing = before.slice(0, subject.index).match(/\bit is not (?:true|the case) that\s*$/iu);
      if (!enclosing) return true;
      // 外层否定取消meaning取消本身；只屏蔽此关系，其他直接取消仍独立受检。
      const start = enclosing.index;
      const end = meaning.index + meaning[0].length + predicate[0].length;
      part = part.slice(0, start) + ' '.repeat(end - start) + part.slice(end);
    }
    for (const outer of part.matchAll(cancel)) {
      if (/mean/iu.test(outer[0])) continue;
      const stripped = part.slice(0, outer.index) + part.slice(outer.index + outer[0].length);
      for (const match of stripped.matchAll(new RegExp(relation.source, relation.flags.replace('g', '') + 'g'))) {
        const start = match.index;
        const end = start + match[0].length;
        if (outer.index >= start && outer.index <= end) return true;
        if (outer.index < start && (start - outer.index <= (lang === 'zh' ? 28 : 64) || lang === 'en' && /true that|case that|say(?: that)?/iu.test(outer[0]))
          && (!/^not$/iu.test(outer[0]) || /^\s*$/u.test(stripped.slice(outer.index, start)))) return true;
        if (outer.index > end && /^(?:这一|该)?说法\s*$|^(?:\s*(?:this claim|that statement))?\s*$/iu.test(stripped.slice(end, outer.index))) return true;
      }
    }
  }
  return false;
}
const NEGATIVE_RELATIONS = {
  '模型人工不能推翻': [/(?:都)?不能推翻|无法推翻|不可推翻/u, /beyond (?:model or human|human or model)|neither model nor human[^.;]{0,12}(?:override|overturn)|no override/iu],
  '不是额外授权': [/不等于授予|并非授予|不是额外授权/u, /grants no extra permission|no additional permission/iu],
  '不影响审批': [/不影响(?:接管|审批)/u, /never the take.over|not[^.;]{0,12}approval/iu],
  '斜杠确认且不自动改写': [/不自动改写|不会自动改写/u, /never rewritten|not rewritten/iu],
  '重试不重赠': [/不另获时限|不会再获得|不获新预算/u, /get no fresh time budget|never handed a fresh time budget/iu],
  '超时拒绝报环节不是危险': [/不是危险判定|并非危险判定/u, /not a danger verdict|no danger verdict/iu],
  '不是全批': [/不等于自动批准|并非全批|不是无条件|绝不是无条件/u, /not a blanket approval|never a blanket approval/iu],
  '工作区不放行更宽': [/不放行|一律不批/u, /rejects wider|never lets[^.;]{0,32}through/iu],
  '拒绝不调模型': [/不调用模型|不调模型/u, /without the model|no model/iu],
  '缺失标记不作安全': [/不把缺失当作安全|不会视为安全|并非安全/u, /never counts as safe|not safe/iu],
  '委派无人工': [/没有人工通道|无人工通道/u, /have no human channel|without a human channel/iu],
  '已结算不可迟改': [/不能由迟到[^。；]{0,4}推翻|无法被迟到[^。；]{0,4}推翻/u, /cannot be overturned|cannot be undone/iu],
  '仅失败不发允许': [/允许不发送|允许那一类不发送/u, /skips allow notices|allow notices are not sent|omits allow notices/iu],
  '记录视图独立': [/不受本开关影响|与此开关无关/u, /unaffected by this switch|nothing to do with this switch|not affected by this switch/iu],
  '记录独立': [/与该上限无关|不受该上限/u, /ignore this limit|regardless of this limit/iu],
  '拒绝无模型人工': [/不调用模型|不交人工|(?:都)?不能推翻/u, /no model|no human|no override/iu],
  '不影响模型语言': [/不改变发送|不影响模型|不触碰文本/u, /never touches|not affect[^.;]{0,8}model/iu],
  '独立界面语言': [/互不影响|独立/u, /independent(?: of| from)?|is independent/iu],
  '默认模型不可用': [/不可用/u, /unavailable/iu],
  '规则模型不可用': [/不可用/u, /unavailable/iu],
  '会话配置不可用': [/不可用/u, /unavailable/iu],
  '未选模型不保存': [/不保留该行|不留该行|丢弃/u, /not kept|dropped/iu],
  '超时无结论': [/未取得有效结论|无结论/u, /without a conclusion|no conclusion/iu],
  '故障无有效结论': [/未取得有效结论|无有效结论/u, /without a conclusion|no valid conclusion/iu],
  '目录不可读': [/读不到|无法读取|不可用/u, /unavailable|cannot be read|unreadable/iu],
  '服务缺失': [/服务缺失/u, /missing service/iu],
  '读取失败': [/读取失败/u, /read failure|a read that failed/iu],
  '信息不可用': [/没有可用预设信息|无可用预设信息/u, /no preset information|without preset information/iu],
  '配置在场但当前表缺失': [/当前预设表里没有|不在当前预设表/u, /absent from[^.;]{0,20}current table|absent from|missing from/iu],
  '插件不改YAML': [/不解析|不改写/u, /never parses|never rewrites/iu],
  '减少采集不删': [/不删除已有记录|并不会删除已有记录/u, /never deletes|never removes/iu],
  '未设置跟随当前模型': [/未设置|没有设置/u, /unset|not set/iu],
  '零不传上限': [/不向模型传输出上限/u, { assertion: /sends no cap|no cap is sent/iu, meaning: { subject: /\b0\s*$/u, predicate: /^\s+no (?:output )?cap\b/iu } }],
  '关闭完全不接管': [/不接管/u, /no take.over|not take over/iu],
  '最高权限及更高不批': [/不会被自动批准|不会批准|不批准/u, /never auto.approved|never approved|not approved/iu],
  '零不裁剪': [/不裁剪|不截断/u, { assertion: /does not trim|no trimming|not trimmed/iu, meaning: { subject: /\b0\s*$/u, predicate: /^\s+no trimming\b/iu } }],
  '空清单已知不接管': [/不接管|不会接管/u, /no known preset|not taken over/iu],
  '不接管与继续两分支': [/不接管/u, /no take.over|not take over/iu],
  '未设跟随当前模型': [/未设置|没有设置/u, /unset|not set/iu],
  '排队不占预算': [/不消耗本预算|不消耗这份预算|不占用/u, /never consume|does not consume|consume nothing/iu],
  '零拒绝非无限': [/不是无限等待|并非无限等待/u, /not an endless wait|not unlimited/iu],
  '关闭零通知': [/一条都不发送|不发任何通知/u, { assertion: /sends no notices|sends nothing/iu, meaning: { subject: /\bsend none["'”]?\s*$/iu, predicate: /^\s+(?:no notices|nothing)\b/iu } }],
  '默认未设置': [/未设置/u, /not set|unset/iu],
  '无会话及映射条件': [/无有效会话选择|无有效映射/u, /no effective session choice|no effective rule/iu],
  '会话未选且默认未设': [/未单独选择|未设置/u, /no reviewer|unset|not set/iu],
  '全局未设且仅此层跟随': [/未设置/u, /not set|unset/iu],
};
export const NEGATIVE_RELATION_IDS = Object.keys(NEGATIVE_RELATIONS);

/** 只在承载该关系的分句核参与者，前后明确排除不能以另一处同名词补足。 */
function includedParticipants(text, lang, relation, participants) {
  const parts = sents(text).filter((part) => relation.test(part));
  return participants.every((concept) => parts.some((part) => concept.test(part)))
    && parts.every((part) => participants.every((concept) => {
      for (const match of part.matchAll(new RegExp(concept.source, concept.flags.replace('g', '') + 'g'))) {
        const before = part.slice(0, match.index);
        const after = part.slice(match.index + match[0].length);
        if (lang === 'zh'
          ? /(?:不含|不包括|排除|而非|并非|不是|不由|非)\s*$/u.test(before) || /^\s*(?:不参与|不在内|被排除|不适用)/u.test(after)
          : /\b(?:not|without|excluding|except)\s*(?:the\s+)?$/iu.test(before) || /^\s*(?:not\b|is excluded|are excluded|does not apply|is not included)/iu.test(after)) return false;
      }
      return true;
    }));
}
const participantFact = (zhRelation, zhParticipants, enRelation, enParticipants) => ({
  zh: (text) => includedParticipants(text, 'zh', zhRelation, zhParticipants),
  en: (text) => includedParticipants(text, 'en', enRelation, enParticipants),
});

/** 数量只绑定登记对象与动作；阿拉伯数字和有限中英文数词表示同一数量。 */
const cardinal = (text) => ({ '一': 1, '一个': 1, one: 1, single: 1, '四': 4, four: 4, '二百': 200, '两百': 200, 'two hundred': 200 }[text.toLowerCase()] ?? Number(text));
function exactCount(text, pattern, expected, implicit = false) {
  const matches = [...text.matchAll(new RegExp(pattern.source, pattern.flags.replace('g', '') + 'g'))];
  return matches.length > 0 && matches.every((match) => {
    const amount = match.slice(1).find((value) => value !== undefined);
    return amount === undefined ? implicit : cardinal(amount) === expected;
  });
}
const QUANTITY_FACTS = {
  '每行一个工具': { zh: (text) => exactCount(sents(text).filter((part) => /工具/u.test(part)).join('；'), /每行[^。；，]{0,4}(一|\d+)个(?=工具|名|[，,；]|$)/iu, 1), en: (text) => exactCount(text, /\b(one|single|\d+)\s+(?:name|tool)?\s*(?:on |per |each )?(?:each |per )?line/iu, 1) },
  '每行正则': { zh: (text) => exactCount(text, /每行[^。；，]{0,3}(一|\d+)条正则/u, 1), en: (text) => exactCount(text, /\b(one|single|\d+)\s+(?:regex|regular expression)\s+(?:per|on each) line/iu, 1) },
  '关闭同原因一条': { zh: (text) => exactCount(text, /(?:关闭|关掉)[^。；]{0,24}(一|\d+)条/u, 1), en: (text) => exactCount(text, /\boff[^.;]{0,12}(one|single|\d+)\s+line/iu, 1) },
  '唯一条件': { zh: (text) => exactCount(text, /(?:只能有|只允许)(一|\d+)条规则/u, 1), en: (text) => exactCount(text, /\b(one|single|\d+) rule(?:s)?\s+(?:per|for each)|(?:allows only|allows)\s+(one|single|\d+) rule/iu, 1) },
  '每条件唯一': { zh: (text) => exactCount(text, /(?:只能有|只允许)(一|\d+)条规则/u, 1), en: (text) => exactCount(text, /\b(one|single|\d+) rule(?:s)?\s+(?:per|for each)|only\s+(one|single|\d+) rule/iu, 1) },
  '全部四类': { zh: (text) => exactCount(text, /(四|\d+)类[^。；]{0,8}(?:发送|发给)/u, 4), en: (text) => exactCount(text, /all\s+(four|\d+)(?:\s+kinds)?(?:\s+reach)?/iu, 4) },
  '回读窗口及默认': { zh: (text) => exactCount(text, /默认\s*(\d+|二百|两百)\s*条/u, 200), en: (text) => exactCount(text, /(\d+|two hundred) entries by default|default[^\d.;]{0,10}(\d+|two hundred) entries/iu, 200) },
  '超四倍轮转留窗口删旧': {
    zh: (text) => exactCount(text, /(?:超过|超出)[^。；，]{0,10}(四|\d+)倍/u, 4) && exactCount(text, /(?:只保留|只留下|留下)(?:最近)(?:(一|二|两|\d+)个)?窗口/u, 1, true),
    en: (text) => exactCount(text, /\b(four|\d+) times the window/iu, 4) && exactCount(text, /(?:keep only|only) the latest\s+(?:(one|two|\d+)|window)/iu, 1, true),
  },
};
export const QUANTITY_IDS = Object.keys(QUANTITY_FACTS);
/** 只拒默认来源被加上双来源必需条件；中性and/both枚举不表示两个来源都必需。 */
function requiresBothDefaultSources(text, lang = 'en') {
  if (lang === 'zh') {
    for (const part of sents(text)) {
      const source = part.match(/(?:由|采用|使用|改用|取用)[^，,。；]{0,24}(?:模型[^，,。；]{0,8}供应商|供应商[^，,。；]{0,8}模型)[^，,。；]{0,8}默认值(?:决定)?/u);
      if (!source) continue;
      const continuation = part.slice(source.index + source[0].length);
      if (/^[，,]\s*只有(?:两者|二者|模型和供应商|供应商和模型)都(?:提供|供给)默认值时才(?:生效|得到有效结论)/u.test(continuation)) return true;
    }
    return false;
  }
  const sources = /(?:the\s+)?(?:model\s+and\s+(?:the\s+)?provider|provider\s+and\s+(?:the\s+)?model)/iu;
  for (const part of text.split(/[。；;.,，:：\n—]|\bbut\b/iu)) {
    if (!/\bleaving\b/iu.test(part) || !/\bdefaults?\b/iu.test(part)) continue;
    for (const necessary of part.matchAll(/\b(?:unless|only if|only when|requires?)\s+both\s+|\bboth\s+/giu)) {
      if (/\b(?:not|never)\s*$/iu.test(part.slice(0, necessary.index))) continue;
      const after = part.slice(necessary.index + necessary[0].length);
      const pair = after.match(sources);
      if (!pair || pair.index !== 0) continue;
      const provision = after.slice(pair[0].length);
      const prerequisite = /^(?:unless|only if|only when|requires?)\b/iu.test(necessary[0]);
      if (prerequisite && /^\s+(?:(?:must|need to|have to|to)\s+)?(?:supply|provide)\s+defaults?\b/iu.test(provision)) return true;
      if (/^\s+(?:are\s+)?(?:required|necessary)\s+to\s+(?:supply|provide)\s+defaults?\b/iu.test(provision)) return true;
    }
  }
  return false;
}
const PARTICIPANT_FACTS = {
  '采用模型或供应商默认': { zh: (text) => includedParticipants(text.replace(/[，,]/gu, '；'), 'zh', /(?:由|采用|使用|改用|取用)[^。；]{0,24}(?:模型|供应商)[^。；]{0,12}默认(?:值)?[^。；]{0,8}(?:决定|提供|生效)?/u, [/模型/u, /供应商/u]) && !requiresBothDefaultSources(text, 'zh'), en: (text) => includedParticipants(text, 'en', /leaving|defaults? (?:appl(?:y|ies)|decide)|default provided/iu, [/model/iu, /provider/iu]) && !requiresBothDefaultSources(text) },
  '默认模型与强度': participantFact(/默认/u, [/审查模型/u, /推理强度|强度/u], /default/iu, [/reviewer model/iu, /effort|strength/iu]),
  '审查文本和执行通知': participantFact(/文本|通知/u, [/审查/u, /文本/u, /执行助手/u, /通知/u], /text|notice/iu, [/text/iu, /reviewer/iu, /notice/iu, /agent/iu]),
  '请求和交人工两个起点': participantFact(/计时|起算/u, [/审批请求|请求/u, /交人工|转人工/u], /timing|timer/iu, [/approval request|request/iu, /handoff/iu]),
  '完整id作用范围': participantFact(/作用范围/u, [/任意 provider/iu, /指定 provider/iu], /scope/iu, [/any provider/iu, /specific/iu]),
  '范围仍审查': participantFact(/范围内/u, [/规则检查|规则/u, /模型审查|模型/u], /in range|in scope/iu, [/rule checks?|rules?/iu, /review/iu]),
  '全部四类': participantFact(/四类|全部/u, [/允许/u, /拒绝/u, /超时/u, /故障/u], /all four|all 4/iu, [/allow/iu, /deny/iu, /timeout/iu, /fail/iu]),
  '仅失败不发允许': participantFact(/仅拒绝|只[^。；]{0,8}拒绝/u, [/拒绝/u, /超时/u, /故障/u], /skips? allow|omits? allow|allow notices are not sent/iu, [/deny/iu, /timeout/iu, /fail/iu]),
  '模型人工不能推翻': participantFact(/推翻|改变|反转/u, [/模型/u, /人工/u], /beyond|override|overturn/iu, [/model/iu, /human/iu]),
  '拒绝无模型人工': participantFact(/不调用|不交/u, [/模型/u, /人工/u], /no model|no human/iu, [/model/iu, /human/iu]),
  '阈值依模型和强度': participantFact(/数值|阈值/u, [/模型/u, /推理强度|强度/u], /threshold|number/iu, [/model/iu, /effort|strength/iu]),
  '装配结论全程': participantFact(/全程|全过程/u, [/装配/u, /结论/u], /whole|entire|covering/iu, [/assembly/iu, /conclusion/iu]),
  '无会话及映射条件': participantFact(/无有效|没有/u, [/会话选择/u, /映射/u], /no effective|without/iu, [/session choice/iu, /rule/iu]),
  '会话未选且默认未设': { zh: (text) => includedParticipants(text, 'zh', /未|没有/u, [/本会话/u, /选择/u, /全局默认/u]) && /本会话[^。；]{0,8}(?:未|没有)[^。；]{0,6}选择/u.test(text), en: (text) => includedParticipants(text, 'en', /no reviewer|unset|not set/iu, [/this session/iu, /reviewer/iu, /global default/iu]) && /this session[^.;]{0,12}no reviewer/iu.test(text) },
  '停用兼容自定义排查': participantFact(/检查|排查/u, [/停用/u, /兼容/u, /自定义/u], /check/iu, [/disabled/iu, /incompatible|compatible/iu, /custom/iu]),
  '重新启用或重启可能恢复': participantFact(/恢复/u, [/重新启用/u, /重启/u], /restore/iu, [/re.enabl/iu, /restart/iu]),
  '插件不改YAML': participantFact(/YAML/u, [/解析/u, /改写/u], /YAML/iu, [/parses/iu, /rewrites/iu]),
};
export const PARTICIPANT_IDS = Object.keys(PARTICIPANT_FACTS);

const BEHAVIOR_FACTS = {
  '采用模型或供应商默认': behaviorPositive(/模型|供应商/u, /由模型或供应商默认|默认/u, /model|provider/iu, /leaving|defaults?/iu),
  '额度可能先用于推理': { zh: (text) => possibleEvent(text, 'zh', /推理/u, /先(?:把|将|用)|先花|优先/u), en: (text) => /first|before/iu.test(text) && possibleEvent(text, 'en', /reasoning/iu, /spend(?:s)?|eat|use/iu) },
  '审查文本和执行通知': behaviorPositive(/文本|通知/u, /发给|给执行助手/u, /text|notice/iu, /sent|shared/iu),
  '审查期间提前人工卡片': { zh: (text) => affirmativeConcept(text, 'zh', /提前|早|抢先/u), en: (text) => /early/iu.test(text) && affirmativeConcept(text, 'en', /appears?|shows?/iu) },
  '阈值依模型和强度': behaviorPositive(/模型|强度/u, /因模型|异|变|不同|决定/u, /model|effort/iu, /varies|depends|differs/iu),
  '清单外宿主流程': behaviorPositive(/其余|其他|名单外|清单外/u, /保持|走/u, /rest|unlisted|others/iu, /keep|retain|flow/iu),
  '接管升权': behaviorPositive(/清单内/u, /接管|处理/u, /listed preset/iu, /hand|take/iu),
  '其他预设保留流程': behaviorPositive(/其他|其余|别的/u, /保持|流程/u, /other/iu, /keep|retain/iu),
  '未知预设按设置': behaviorPositive(/无法识别|不能识别/u, /按|处置/u, /unidentifiable|cannot be identified/iu, /follow/iu),
  '强度自动低档': behaviorPositive(/low/iu, /使用|用|选/u, /low/iu, /use|pick/iu),
  '否则模型默认': behaviorPositive(/否则|不然|若不支持/u, /由模型默认|默认/u, /otherwise|else|if not/iu, /default|decide/iu),
  '旧纯id任意provider': behaviorPositive(/纯模型 id|纯 id/u, /任意/u, /plain.id/iu, /any.provider|any/iu),
  '装配结论全程': behaviorPositive(/装配/u, /涵盖|覆盖/u, /assembly/iu, /cover/iu),
  '到点拒绝': {
    zh: (text) => thresholdEvent(text, 'zh', /到点|到期|超时/u, /(?:按)?拒绝(?:结算)?/u),
    en: (text) => thresholdEvent(text.replace(/\b(?:before|prior to)\s+(?:the\s+)?expiry\b/giu, 'not expiry'), 'en', /\bexpiry\b|expires?|times? out/iu, /settles? as (?:a )?rejection|reject(?:s|ed|ion)?/iu),
  },
  '请求起算用剩余': behaviorPositive(/请求/u, /使用剩余|剩余|余下/u, /request/iu, /gets?|remainder|remaining/iu),
  '交人工重新起算': behaviorPositive(/交人工|转人工/u, /重新|重起|另起/u, /handoff/iu, /handoff itself|fresh|restart|begins again|new|itself/iu),
  '范围仍审查': { zh: (text) => !/(?:无需|不必|不用|不须)(?:通过)?[^。；]{0,18}(?:规则|模型审查)/u.test(text) && affirmativeConcept(text, 'zh', /通过|过规则/u), en: (text) => !/(?:need not|does not|do not|not required to)[^.;]{0,18}pass/iu.test(text) && affirmativeConcept(text, 'en', /pass(?:es)?/iu) },
  '完全访问最宽': behaviorPositive(/完全访问/u, /最宽/u, /full access/iu, /widest/iu),
  '拒绝结算': behaviorPositive(/直接拒绝/u, /结算/u, /reject/iu, /settles?/iu),
  '人工卡片和超时拒绝': behaviorPositive(/人工作答|人工/u, /按拒绝结算|拒绝/u, /human/iu, /reject/iu),
  '分叉按主会话': { zh: (text) => forkedAsMainSession(text, 'zh'), en: (text) => forkedAsMainSession(text, 'en') },
  '全部四类': behaviorPositive(/四类/u, /发送|发给/u, /all four/iu, /sends? all|reach/iu),
  '字节上限及截断标记': { zh: (text) => thresholdEvent(text, 'zh', /超出|超过/u, /截断|裁剪/u), en: (text) => thresholdEvent(text, 'en', /longer|exceeds?|exceeding/iu, /trim(?:med)?/iu) },
  '匹配所有字符串参数非仅命令': behaviorPositive(/字符串|参数/u, /匹配/u, /string argument/iu, /matched/iu),
  '坏正则跳过': behaviorPositive(/不可编译|无法编译/u, /跳过/u, /uncompilable|cannot compile/iu, /skip/iu),
  '跟随宿主': behaviorPositive(/宿主/u, /跟随/u, /host/iu, /follow/iu),
  '下一渲染生效': behaviorPositive(/渲染/u, /生效/u, /render/iu, /takes? effect|applies/iu),
  '默认英文': behaviorPositive(/默认/u, /英文/u, /default/iu, /English/iu),
  '原因后实际模型': behaviorPositive(/\{effective\}/u, /实际|当前|使用|在用/u, /\{effective\}/u, /using|in use|actual/iu),
  '真实生效层': behaviorPositive(/\{layer\}/u, /生效|当前/u, /\{layer\}/u, /effective|current/iu),
  '跟随当前执行模型': behaviorPositive(/执行助手/u, /跟随|使用/u, /agent/iu, /follow/iu),
  '斜杠旧键需确认': { zh: (text) => affirmativeConcept(text, 'zh', /确认/u), en: (text) => affirmativeConcept(text, 'en', /confirm(?!ed)/iu) },
  '确认前兼容读取原值': behaviorPositive(/确认|原值/u, /读取|保留/u, /confirm|value/iu, /read|keeps?/iu),
  '未知按设置': behaviorPositive(/无法识别|不能识别/u, /按|处置/u, /cannot be identified/iu, /follow/iu),
  '检查服务后重试': behaviorPositive(/服务/u, /确认|检查|重试/u, /service/iu, /check|retry/iu),
  '重新启用或重启可能恢复': modalFact(/重新启用|重启/u, /恢复/u, /re.enabl|restart/iu, /restore|recover/iu),
  '标准档与卸载清理': behaviorPositive(/标准|卸载/u, /可改选|改选|处理|清理/u, /standard|uninstall/iu, /pick|cleanup/iu),
  '记录随会话': behaviorPositive(/记录/u, /跟随|跟着|属于/u, /record/iu, /follow|belong|stay/iu),
  '超四倍轮转留窗口删旧': { zh: (text) => thresholdEvent(text, 'zh', /超过|超出/u, /轮转/u), en: (text) => thresholdEvent(text, 'en', /exceeds?|passes|pass/iu, /rewritten|rotat/iu, true) },
  '超文件上限删最旧': { zh: (text) => oldestSessionFileEviction(text, 'zh'), en: (text) => oldestSessionFileEviction(text, 'en') },
  '轮转前备份': { zh: (text) => /轮转/u.test(text) && affirmativeConcept(text, 'zh', /备份/u), en: (text) => /rotation|rotat/iu.test(text) && affirmativeConcept(text, 'en', /back/iu) },
  '过小上限可能无有效结论': { zh: (text) => /(?:没有|无|得不到|不产生|难以)(?:任何)?(?:有效|可用)(?:的)?(?:结论|结果)/u.test(text) && possibleEvent(text, 'zh', /过小|太低|太小|不足/u, /导致|得不到|无可用/u), en: (text) => /(?:no|without)(?: a)? (?:usable|valid) (?:conclusion|answer)/iu.test(text) && possibleEvent(text, 'en', /too small|too low|insufficient/iu, /leave|end/iu) },
  '操作无法识别': behaviorNegative(/(?:无法|不能|难以)(?:辨认|识别|确定)/u, /(?:cannot|unable|can't)[^.;]{0,12}(?:identif|recogniz|recover)/iu),
  '模型人工不能推翻': behaviorNegative(/(?:模型[^。；]{0,12}人工|人工[^。；]{0,12}模型)[^。；]{0,6}(?:都不能|不能|无法|不可|均不)[^。；]{0,3}(?:推翻|改变|反转)/u, /(?:beyond (?:model or human|human or model)|neither model nor human[^.;]{0,12}(?:override|overturn)|no[^.;]{0,12}(?:model|human)[^.;]{0,12}override)/iu),
  '不是额外授权': behaviorNegative(/(?:不等于|并非|不是)[^。；]{0,8}(?:授予|授权|权限)/u, /(?:grants? no|no extra|no additional)[^.;]{0,12}permission/iu),
  '不影响审批': behaviorNegative(/(?:不|无关)[^。；]{0,6}影响[^。；]{0,6}(?:接管|审批)/u, /(?:never|not)[^.;]{0,12}(?:take.over|approval|affect|change)/iu),
  '斜杠确认且不自动改写': behaviorNegative(/(?:不|不会)自动?改写/u, /(?:never|not)[^.;]{0,12}rewrit/iu),
  '重试不重赠': behaviorNegative(/重试[^。；]{0,8}(?:不|无|没)[^。；]{0,12}(?:时限|预算)/u, /retr(?:y|ies)[^.;]{0,16}(?:no|not|never)[^.;]{0,20}(?:budget|time)/iu),
  '超时拒绝报环节不是危险': behaviorNegative(/(?:不是|并非|非|不算)危险/u, /(?:not a|no|not) danger/iu),
  '不是全批': behaviorNegative(/(?:不等于|并非|不是|绝不是|绝不)[^。；]{0,8}(?:自动批准全部|全部操作|全批|无条件)/u, /(?:not a|never a|no|not) blanket/iu),
  '工作区不放行更宽': behaviorNegative(/(?:升权[^。；]{0,5}(?:不放行|不批|拒绝)|(?:不放行|不批|拒绝)[^。；]{0,12}升权)/u, /workspace[^.;]{0,12}(?:reject|never|not)[^.;]{0,30}escalation/iu),
  '拒绝不调模型': { zh: (text) => /(?:不调用|不调)模型/u.test(text) && affirmativeConcept(text, 'zh', /立即拒绝/u), en: (text) => /without the model|no model|not call[^.;]{0,8}model/iu.test(text) && affirmativeConcept(text, 'en', /refuses?|rejects?/iu) },
  '缺失标记不作安全': behaviorNegative(/(?:不把缺失当作|不(?:会)?(?:视为|当作)|并非|从未)[^。；]{0,8}安全/u, /missing[^.;]{0,12}(?:never|not)[^.;]{0,16}safe/iu),
  '委派无人工': behaviorNegative(/(?:委派|子代理)[^。；]{0,8}(?:没有|无)人工通道/u, /(?:delegated|subagents?)[^.;]{0,20}(?:no|without) human channel/iu),
  '已结算不可迟改': behaviorNegative(/(?:已完成|已结算)[^。；]{0,8}(?:不能|无法|不可)[^。；]{0,12}(?:推翻|改变|撤销)/u, /settled[^.;]{0,12}(?:cannot|can't|not)[^.;]{0,30}(?:overturned|overturn|undo)/iu),
  '仅失败不发允许': behaviorNegative(/允许[^。；]{0,6}(?:不发送|不发)/u, /skips? allow|allow[^.;]{0,24}(?:not sent|omitted)|omits[^.;]{0,8}allow/iu),
  '记录视图独立': behaviorNegative(/(?:审查记录|记录)[^。；]{0,18}(?:不受|无关|独立)[^。；]{0,8}(?:开关|显示)|(?:开关|显示)[^。；]{0,8}无关/u, /(?:review.log|record)[^.;]{0,20}(?:unaffected|independent|nothing to do)/iu),
  '记录独立': behaviorNegative(/(?:该上限|本上限)[^。；]{0,4}无关|(?:不受|无关)[^。；]{0,8}(?:上限|限制)/u, /records?[^.;]{0,40}(?:ignore|regardless|independent)[^.;]{0,12}(?:limit|cap)|regardless[^.;]{0,12}(?:limit|cap)/iu),
  '拒绝无模型人工': behaviorNegative(/(?:不调用模型|无模型)[^。；]{0,8}(?:不交人工|无人工)|(?:不交人工|无人工)[^。；]{0,8}(?:不调用模型|无模型)/u, /no model[^.;]{0,8}no human|no human[^.;]{0,8}no model|without (?:a )?model[^.;]{0,12}(?:or )?human/iu),
  '不影响模型语言': behaviorNegative(/(?:不改变|不影响|不触碰)[^。；]{0,15}(?:模型|文本)/u, /(?:never|not)[^.;]{0,12}(?:touch|change|affect)[^.;]{0,12}(?:model|text)/iu),
  '独立界面语言': { zh: (text) => /(?:界面|插件)[^。；]{0,8}(?:互不影响|独立|无关)/u.test(text), en: (text) => affirmativeConcept(text, 'en', /independent|separate/iu) },
  '默认模型不可用': behaviorNegative(/(?:默认|全局)[^。；:：]{0,12}(?:不可用|无法|不能|失败)/u, /default[^.;:]{0,25}(?:unavailable|cannot|failed)/iu),
  '规则模型不可用': behaviorNegative(/规则[^。；:：]{0,14}(?:不可用|无法)/u, /(?:rule|picked)[^.;:]{0,30}unavailable|unavailable[^.;:]{0,30}(?:rule|picked)/iu),
  '会话配置不可用': behaviorNegative(/会话[^。；:：]{0,30}不可用/u, /session[^.;:]{0,40}unavailable/iu),
  '未选模型不保存': behaviorNegative(/(?:不保留|不留|丢弃)[^。；]{0,8}(?:行|模型)|(?:行|模型)[^。；]{0,8}(?:不保留|丢弃)/u, /not kept|dropped/iu),
  '模型拒绝非最终结果': { zh: (text) => !claimsFinalOutcome(text, 'zh'), en: (text) => !claimsFinalOutcome(text, 'en') },
  '超时无结论': behaviorNegative(/(?:未取得|无)[^。；]{0,4}结论/u, /(?:without|no|not)[^.;]{0,8}conclusion/iu),
  '故障无有效结论': behaviorNegative(/(?:未取得|无)[^。；]{0,4}结论/u, /(?:without|no|not)[^.;]{0,8}conclusion/iu),
  '目录不可读': behaviorNegative(/读不到|无法读取|不可用/u, /unavailable|cannot be read|unreadable/iu),
  '服务缺失': behaviorNegative(/服务[^。；]{0,4}缺失/u, /missing service|service[^.;]{0,8}missing/iu),
  '读取失败': behaviorNegative(/读取[^。；]{0,4}失败/u, /read failure|read that failed|failed read|reading fails/iu),
  '信息不可用': behaviorNegative(/(?:没有|无)[^。；]{0,6}(?:预设信息|可用)/u, /no preset information|unusable|without preset information/iu),
  '配置在场但当前表缺失': { zh: (text) => /配置[^。；]{0,6}(?<!不)存在[^。；]{0,20}(?:没有|不在|缺失)/u.test(text), en: (text) => affirmativeConcept(text, 'en', /configured|config/iu) && /absent|missing|not in/iu.test(text) },
  '插件不改YAML': behaviorNegative(/(?:不解析[^。；]{0,4}不改写|不改写[^。；]{0,4}不解析)[^。；]{0,8}YAML/u, /(?:never|not)[^.;]{0,12}(?:parses\s+(?:nor|or)\s+rewrites|rewrites\s+(?:nor|or)\s+parses)[^.;]{0,12}YAML/iu),
  '减少采集不删': behaviorNegative(/(?:减少|调低|降低)[^。；]{0,6}采集[^。；]{0,4}(?:不|不会|并不)删除/u, /(?:reduc|turning.{0,12}down|lower|cut)[^.;]{0,30}(?:not|never|no)[^.;]{0,10}(?:delet|remove)/iu),
};

const PLACEHOLDERS = {
  'warn.modelIssue.global': ['reason', 'effective'], 'warn.modelIssue.rule': ['reason', 'effective'],
  'warn.modelIssue.session': ['configured', 'reason', 'effective'], 'warn.modelIssue.layer': ['layer'],
  'warn.modelIssue.followParent': ['effective'], 'warn.modelIssue.globalUnsetShadowed': ['effective'],
  'cardstate.waiting.deny': ['reason'], 'cardstate.waiting.error': ['reason'],
};
export const normalizeCopy = (text) => String(text).replace(/[\u2060\u200b]/gu, '').replace(/\s+/gu, ' ').trim();
/** 仅归一已登记数量的有限等价写法，不把其他配置或协议中的数字改写。 */
function normalizeFactCounts(key, text) {
  let value = text;
  if (/tools$|denyPatterns$/u.test(key)) value = value.replace(/每行([^。；，]{0,4})1(?=[个条])/gu, '每行$1一').replace(/\b1 (?=(?:name|tool|regex|regular expression|per line)\b)|\bsingle (?=(?:name|tool|regex|regular expression)\b)/giu, 'one ');
  if (key === 'help.trigger.auditEverySkip') value = value.replace(/只记录1条/gu, '只记录一条').replace(/\b1 line\b/giu, 'one line');
  if (key === 'help.reviewer.parentModelRules' || key === 'card.map.duplicate') value = value.replace(/(?:只能有|只允许)1条规则/gu, (part) => part.replace('1', '一')).replace(/\b1 rule\b/giu, 'one rule');
  if (key === 'help.ui.inject') value = value.replace(/4类/gu, '四类').replace(/\ball 4\b/giu, 'all four');
  if (key === 'view.retention') value = value.replace(/默认\s*(?:二百|两百)\s*条/gu, '默认 200 条').replace(/\btwo hundred entries\b/giu, '200 entries').replace(/窗口(?:的)?4倍/gu, '窗口四倍').replace(/\b4 times\b/giu, 'four times').replace(/最近1个窗口/gu, '最近一个窗口').replace(/latest 1\b/giu, 'latest one');
  return value;
}

/**
 * 检查一条文案是否承载该键的全部关键事实。
 * @param {string} key - 文案键（COPY_FACTS 的键）。
 * @param {'zh'|'en'} lang - 语言档。
 * @param {string} text - 文案原文（含 U+2060 等显示保护字符，检查前语义归一）。
 * @returns {string[]} 失败规则 id／占位符问题；空数组＝全部事实与占位符通过。
 */
export function copyFactFailures(key, lang, text) {
  if (typeof text !== 'string' || !text.trim()) return ['说明缺失'];
  const normalized = normalizeFactCounts(key, normalizeCopy(text));
  const failures = key === 'help.mode' ? helpModeFailures(normalized) : (COPY_FACTS[key] ?? []).filter((fact) => {
    const check = fact[lang];
    const present = typeof check === 'function' ? check(normalized) : check.test(normalized);
    const behavior = BEHAVIOR_FACTS[fact.id]?.[lang];
    const polarity = !behavior || (typeof behavior === 'function' ? behavior(normalized) : behavior.test(normalized));
    const subcondition = SUBCONDITION_FACTS[fact.id]?.[lang];
    const negativeRelation = NEGATIVE_RELATIONS[fact.id]?.[lang === 'zh' ? 0 : 1];
    const cancelled = negativeRelation && negativeRelationCancelled(normalized, lang, negativeRelation);
    const quantity = QUANTITY_FACTS[fact.id]?.[lang];
    const participants = PARTICIPANT_FACTS[fact.id]?.[lang];
    return !present || !polarity || subcondition && !subcondition(normalized) || cancelled || quantity && !quantity(normalized) || participants && !participants(normalized);
  }).map((fact) => fact.id);
  failures.push(...conditionFactFailures(key, lang, normalized));
  if (key === 'help.fallback' && !(lang === 'zh' ? /(?:未允许|未通过|不允许)(?:一律|均|都)?拒绝/u : /(?:not allowed|not approved)[^.;]{0,24}(?:reject|denied)/iu).test(normalized)) failures.push('委派未允许拒绝');
  if (key === 'help.denyPatterns' && !(lang === 'zh' ? /模型[^。；]{0,4}人工[^。；]{0,6}(?:不能|无法|不可)[^。；]{0,4}(?:推翻|改变|反转)/u : /no override|neither model nor human[^.;]{0,16}(?:override|overturn)/iu).test(normalized)) failures.push('命中结果不可推翻');
  const zeroClause = sents(normalized).find((clause) => /\b0\b/u.test(clause));
  if (zeroClause && /timeoutMs$/u.test(key) && !affirmativeConcept(zeroClause, lang, lang === 'zh' ? /立即|马上|即刻|拒绝|超时/u : /immediately|at once|right away|rejects?|times? out|timeout/iu)) failures.push('零值正向关系被否定');
  if (zeroClause && /timeoutMs$/u.test(key) && /(?:不|不会|并非|不是).{0,3}立即|(?:不|不会|并非|不是)\s*(?:拒绝|超时)|\b(?:does not|do not|doesn't|don't|not|never)\b.{0,15}(?:immediate|at once|reject|time out)|\b(?:reject|timeout)\b.{0,8}\b(?:not|never)\b/iu.test(zeroClause)) failures.push('零值含义反转');
  if (/^(?:hint|help)\.denyPatterns$/u.test(key) && !hitRejects(normalized, lang)) failures.push('命中拒绝含义反转');
  if (zeroClause && /injectMaxBytes$/u.test(key) && /不是不|并非不|not untrimmed|not without trimming/iu.test(zeroClause)) failures.push('零值含义反转');
  if (/tools$/u.test(key) && emptyToolsReversed(normalized, lang)) failures.push('空清单含义反转');
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
