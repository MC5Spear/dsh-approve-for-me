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

/** 关闭态标记：子句谈的是关闭／off 状态。 */
const OFF_MARKER = /(关闭|关掉|off|when off|完全)/iu;

/** 否定接管：子句声明不接管（中英否定式与「零接管」表述）。 */
const NEG_TAKEOVER =
  /(不|无|未|没有)[^\n，。；;:,]{0,6}接管|(不|无|未|没有)任何接管|does not take over|do not take over|takes? over nothing|takes? over no|not take over|no take[- ]?over|without take[- ]?over/iu;

/** 肯定接管：子句出现接管动作（中英）。 */
const AFF_TAKEOVER = /(接管|take[s]? over|takeover)/iu;

/** 等同未安装：关闭态效果等同于插件未安装（中英多种等义说法）。 */
const AS_UNINSTALLED =
  /等同未安装|等同于?未安装|与未安装[^，。；]{0,6}(一样|相同|一致|无差别|无异)|如同未安装|未安装(时)?(一样|无异)|(as if|like|same as)[^,;.]{0,40}(not installed|uninstalled|absent)/iu;

/** 宿主审批不受影响：宿主自身的审批流程保持原样（中英）。 */
const HOST_FLOW_KEPT =
  /宿主[^，。；]{0,14}?(审批|许可)[^，。；]{0,12}?(不受影响|不会[^，。；]{0,6}改变|保持原样|照常|不变|原样)|(不影响|不改变|不触碰)宿主|宿主(自身)?的?(审批|许可)(流程|过程)?(照常|保持原样|不受影响)|(host|host's?)[^,;.]{0,20}?(approval|approvals)[^,;.]{0,40}?(untouched|unaffected|unchanged|stays|left untouched|keep)/iu;

/**
 * 检查一段 mode 帮助文本是否承载总开关全部关键事实。
 * @param {string} text - 待检文本（历史档原句或改写文案，中英均可）。
 * @returns {string[]} 缺失事实／反转清单；空数组＝全部事实在场。
 */
export function checkModeHelpFacts(text) {
  const clauses = clausesOf(text);
  const missing = [];
  // 开启态事实 1／2：同一条子句里「规则检查」「LLM（模型）审查」与肯定接管并存
  //（历史句「规则检查＋LLM 审查＝正常接管」与改写「先做规则筛查，再交模型独立审查」同过）。
  // on-llm-review 只认显式 LLM／模型参与：仅「规则审查」等不含模型的措辞不算模型事实。
  const onClauses = clauses.filter((clause) => !OFF_MARKER.test(clause) && AFF_TAKEOVER.test(clause) && !NEG_TAKEOVER.test(clause));
  if (!onClauses.some((clause) => /(规则|rule)/iu.test(clause))) missing.push('on-rule-check');
  if (!onClauses.some((clause) => /(LLM|模型|model review|review by the (?:LLM|model))/iu.test(clause))) missing.push('on-llm-review');
  // 关闭态事实 3／4：关闭＝不接管；关闭＝等同未安装。
  if (!clauses.some((clause) => OFF_MARKER.test(clause) && NEG_TAKEOVER.test(clause))) missing.push('off-no-takeover');
  if (!clauses.some((clause) => AS_UNINSTALLED.test(clause))) missing.push('off-equivalent-to-uninstalled');
  // 事实 5：宿主审批流程不受影响。
  if (!clauses.some((clause) => HOST_FLOW_KEPT.test(clause))) missing.push('host-flow-unaffected');
  // 反转守卫：关闭态子句出现无否定的肯定接管＝关闭含义被反转。
  if (clauses.some((clause) => OFF_MARKER.test(clause) && AFF_TAKEOVER.test(clause) && !NEG_TAKEOVER.test(clause))) missing.push('off-reversal');
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
  if (!/(全局|global)/iu.test(value)) missing.push('scope-global');
  if (!/(审查模型|审查用的模型|reviewer model|review model)/iu.test(value)) missing.push('object-reviewer-model');
  if (!/(未设置|没有设置|尚未设置|not set|unset)/iu.test(value)) missing.push('state-unset');
  // 反转守卫：声称已设置＝状态事实反转。
  if (/(已设置|已经设置|is set|already set)/iu.test(value)) missing.push('state-set-reversal');
  return missing;
}
