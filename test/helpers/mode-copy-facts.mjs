/**
 * 关键事实检查器：mode 帮助「总开关」首段与空全局默认条目 reason（design §7.2.1／§7.2.0）。
 *
 * 只处理这两处普通说明的事实；不做自然语言全等义证明——把句子拆成短概念（子句），
 * 按概念与关系（开启态、关闭态、否定接管、等同未安装、宿主流程不受影响）逐项判定。
 * 正例与反例共用同一规则。检查器只证明：所列明确事实是否在场、所列正反例是否按预期
 * 通过／报缺失；不声称能判定任意等义改写，也不证明自然语言全等义。
 */

/** 子句切分：句号／分号／换行为子句边界（中英句点同列；冒号不切，保持「条件：结果」同子句）。 */
function clausesOf(text) {
  return String(text ?? '')
    .split(/[。；;.\n]/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

/** 关闭态标记；历史原句的“完全不接管”也承载关闭分支。 */
const OFF_MARKER = /关闭|关掉|\boff\b|完全(?:不|无|没有)[^。；;]{0,8}接管/iu;
const ON_MARKER = /开启|打开|\b(?:when\s+)?on\b/iu;

/** 否定接管：子句声明不接管（中英否定式与「零接管」表述）。 */
const NEG_TAKEOVER =
  /(不|无|未|没有)[^\n，。；;:,]{0,6}接管|(不|无|未|没有)任何接管|does not take over|do not take over|takes? over nothing|takes? over no|not take over|no take[- ]?over|without take[- ]?over/iu;

/** 肯定接管：子句出现接管动作（中英）。 */
const AFF_TAKEOVER = /接管|takes? over|take[- ]?over/iu;

/** 每次接管提及分别判极性，关态另一处“不接管”不能掩盖肯定接管。 */
function takeoverStates(text) {
  return [...text.matchAll(new RegExp(AFF_TAKEOVER.source, 'giu'))].map((match) => {
    const before = text.slice(0, match.index);
    const after = text.slice(match.index + match[0].length);
    const negative = /(?:不|无|未|没有)(?:进行|任何|正常|再|会){0,2}\s*$|\b(?:not|never|no|without)\s*$/iu.test(before)
      || /^\s*(?:nothing|no\b)/iu.test(after);
    const cancelled = /(?:并非|不是|不能说|不再)[^，。；;]{0,10}(?:不|无|未|没有)(?:进行|任何|正常|再|会){0,2}\s*$|\b(?:it is not true that|it is not the case that|cannot say that|no longer)[^,.;]{0,48}(?:not|no|without)\s*$/iu.test(before);
    return !negative || cancelled;
  });
}

/** 等同未安装：关闭态效果等同于插件未安装（中英多种等义说法）。 */
const AS_UNINSTALLED =
  /等同未安装|等同于?未安装|与未安装[^，。；]{0,6}(一样|相同|一致|无差别|无异)|如同未安装|未安装(时)?(一样|无异)|(as if|like|same as)[^,;.]{0,40}(not installed|uninstalled|absent)/iu;

/** 宿主审批不受影响：宿主自身的审批流程保持原样（中英）。 */
const HOST_FLOW_KEPT =
  /宿主[^，。；]{0,14}?(审批|许可)[^，。；]{0,12}?(不受影响|不会[^，。；]{0,6}改变|保持原样|照常|不变|原样)|(不影响|不改变|不触碰)宿主|宿主(自身)?的?(审批|许可)(流程|过程)?(照常|保持原样|不受影响)|(host|host's?)[^,;.]{0,20}?(approval|approvals)[^,;.]{0,40}?(untouched|unaffected|unchanged|stays|left untouched|keep)/iu;

/** 只看概念前后的有限动作否定；不把另一义务或另一分支的否定借给当前概念。 */
function conceptPolarity(text, concept) {
  let found = false;
  for (const match of text.matchAll(new RegExp(concept.source, concept.flags.replace('g', '') + 'g'))) {
    const before = text.slice(0, match.index);
    const after = text.slice(match.index + match[0].length);
    if (/(?:不正常|不做|不经|不进行|不执行|不经过|不通过|无需|无须|不用|省略|跳过|没有|不包含|without|excluding|not|no|never|skip|skips|omits?)(?:\s+(?:a|an|the|any|do|perform|run|conduct|include))*\s*$/iu.test(before)) return false;
    if (/^\s*(?:不做|不执行|不进行|不参与|(?:is|are)\s+(?:not\s+(?:performed|run|included)|omitted|skipped)|does not run|doesn['’]t run)/iu.test(after)) return false;
    found = true;
  }
  return found;
}

/** 逗号只在出现下一开关标记时切开，保留当前状态与后续动作的联系。 */
const modeClauses = (text) => clausesOf(text).flatMap((part) => part.split(/(?=(?:关闭|关掉|开启|打开|when\s+(?:on|off)\b|off\s*:|on\s*:))/iu)).filter(Boolean);
const PARTS = { rule: /规则(?:检查|筛查|审查)?|rule(?: check| screen)?/iu, llm: /LLM(?:\s*审查|\s*review)?|模型(?:独立)?审查|model review|review by the (?:LLM|model)/iu };

/**
 * 检查一段 mode 帮助文本是否承载总开关全部关键事实。
 * @param {string} text - 待检文本（历史档原句或改写文案，中英均可）。
 * @returns {string[]} 缺失事实／反转清单；空数组＝全部事实在场。
 */
export function checkModeHelpFacts(text) {
  const clauses = modeClauses(text);
  const missing = [];
  // 正常接管的隐含开态与显式 on 均可；两个审查义务分别核对，排除任一个都不能靠另一个补足。
  const onClauses = clauses.filter((part) => !OFF_MARKER.test(part) && AFF_TAKEOVER.test(part) && !NEG_TAKEOVER.test(part) && conceptPolarity(part, AFF_TAKEOVER));
  for (const [id, concept] of [['on-rule-check', PARTS.rule], ['on-llm-review', PARTS.llm]]) {
    const relevant = onClauses.filter((part) => concept.test(part));
    const offRunsIt = clauses.some((part) => OFF_MARKER.test(part) && AFF_TAKEOVER.test(part) && !NEG_TAKEOVER.test(part) && concept.test(part) && conceptPolarity(part, concept));
    if (!relevant.length || relevant.some((part) => !conceptPolarity(part, concept)) || offRunsIt) missing.push(id);
  }
  const offClauses = clauses.filter((part) => OFF_MARKER.test(part) && !ON_MARKER.test(part));
  const equivalent = (part) => AS_UNINSTALLED.test(part) && !/(?:不|非)等同|不与未安装|not\s+(?:behave|like|the same|as if)|does not behave|doesn['’]t behave/iu.test(part);
  // 英文现行“off behaves as if uninstalled”本身表达零接管；仅“关闭＝等同未装”仍须显式不接管。
  const noTakeover = (part) => takeoverStates(part).includes(false) || /\boff\b[^.;]{0,16}behaves?\s+as if/iu.test(part) && equivalent(part);
  const offReversal = offClauses.some((part) => takeoverStates(part).some(Boolean) || /不是不接管|并非不接管|not\s+(?:no take.over|not take over)/iu.test(part));
  if (!offClauses.some(noTakeover) || offReversal) missing.push('off-no-takeover');
  if (!offClauses.some(equivalent) || offClauses.some((part) => AS_UNINSTALLED.test(part) && !equivalent(part))) missing.push('off-equivalent-to-uninstalled');
  const hostReversal = clauses.some((part) => /宿主|\bhost\b/iu.test(part) && /宿主[^。；;]{0,24}(?:受到影响|会改变|被改变)|(?:不再|并非|不是)[^。；;]{0,8}(?:不受影响|保持原样)|host[^.;]{0,48}(?:is affected|is changed|not untouched|not unaffected|not unchanged)/iu.test(part));
  if (!clauses.some((part) => HOST_FLOW_KEPT.test(part)) || hostReversal) missing.push('host-flow-unaffected');
  if (offReversal) missing.push('off-reversal');
  return missing;
}

/**
 * 检查空全局默认条目 reason 是否承载其关键事实：全局（作用域）＋审查模型（对象）＋未设置（状态）。
 * @param {string} text - 待检 reason 文案。
 * @returns {string[]} 缺失事实／反转清单；空数组＝全部事实在场。
 */
export function checkEmptyGlobalReasonFacts(text) {
  const value = String(text ?? '');
  const missing = [];
  const global = /全局|\bglobal\b/iu;
  const object = /审查模型|审查用的模型|reviewer model|review model/iu;
  const parts = clausesOf(value).flatMap((part) => part.split(/[，,]|(?=会话|\bsession\b)/iu));
  const relevant = parts.filter((part) => global.test(part) && object.test(part));
  if (!parts.some((part) => global.test(part))) missing.push('scope-global');
  if (!relevant.length) missing.push('object-reviewer-model');
  if (!relevant.some((part) => /未设置|没有设置|尚未设置|\bnot set\b|\bunset\b/iu.test(part))) missing.push('state-unset');
  // 状态只绑定同一全局审查模型，另一会话模型已设置不构成反转。
  if (relevant.some((part) => /已设置|已经设置|\bis set\b|\balready set\b/iu.test(part))) missing.push('state-set-reversal');
  return missing;
}
