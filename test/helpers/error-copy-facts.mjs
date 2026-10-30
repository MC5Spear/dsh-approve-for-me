/** 错误说明的有限事实检查；不改安全原文、协议或模型答复契约。 */
export function errorCopyFailures(kind, lang, text) {
  const value = String(text);
  const failures = [];
  const has = (id, zh, en) => { if (!(lang === 'zh' ? zh : en).test(value)) failures.push(id); };
  const placeholders = [...value.matchAll(/\{([a-z]+)\}/gu)].map((m) => m[1]).sort();
  const expected = kind === 'tool' ? ['error', 'name'] : kind === 'args' ? ['error'] : [];
  if (JSON.stringify(placeholders) !== JSON.stringify(expected)) failures.push('placeholders');
  if (kind === 'tool') {
    has('tool', /工具/u, /\btool\b/iu);
    const currentTool = value.split(/[。；;，,.\n]|(?=另一个|\banother\b)/iu).filter((part) => /\{name\}|该工具|本工具|\bthis tool\b|\bthe same tool\b/iu.test(part));
    if (!currentTool.some((part) => (lang === 'zh' ? /失败|出错|未能完成/u : /failed|failure|could not complete/iu).test(part))) failures.push('failure');
    if (currentTool.some((part) => /(?:并非|不是|没有).{0,5}(?:失败|出错)|(?:并未|未|不)\s*(?:失败|出错)|\b(?:not|no|never)\s+(?:a\s+)?(?:failed|failure)|\bdid not fail\b/iu.test(part))) failures.push('failure-reversal');
  } else if (kind === 'args') {
    has('arguments', /参数/u, /arguments?|parameters?/iu);
    has('invalid-json', /(?:不是|非|无效|不合法).{0,8}JSON|JSON.{0,6}(?:无效|非法|不合法)/iu, /(?:not\s+(?:a\s+)?valid|invalid|malformed)\s+JSON|JSON.{0,10}(?:invalid|malformed)/iu);
    // 仅排除这些错误类型的直接反转，不尝试一般自然语言推理。
    if (/(?:并非|不是|不属于|没有).{0,5}(?:无效|非法|不合法)|\b(?:not|never)\s+(?:invalid|malformed)\s+JSON|JSON\s+(?:is\s+)?not\s+(?:invalid|malformed)/iu.test(value)) failures.push('invalid-json-reversal');
  } else if (kind === 'channel') {
    has('prefix', /^\[approve-for-me\]/u, /^\[approve-for-me\]/u);
    has('channel-failure', /通道.{0,5}(?:故障|失败|异常)/u, /channel.{0,10}(?:failure|failed|error)/iu);
    has('one-escalation', /本次.{0,5}升权/u, /this.{0,15}escalation/iu);
    has('rejected', /(?:按|予以|作).{0,5}拒绝|拒绝处理/u, /\brejected\b|\breject\b.{0,30}request/iu);
    if (/(?:不|不会|并非|不是|无需).{0,5}拒绝|\b(?:not|never)\s+(?:be\s+)?rejected\b|\b(?:do|does|will|shall)\s+not\s+reject\b/iu.test(value)) failures.push('rejection-reversal');
    const danger = /危险判定|判定.{0,4}危险|danger verdict|judged dangerous/giu;
    const affirmedDanger = value.split(/[。；;，,.\n]/u).some((part) => [...part.matchAll(danger)].some((match) => !/(?:不是|并非|不属于|不算)\s*$|\b(?:not|never)\s+(?:(?:a|the)\s+)?$/iu.test(part.slice(0, match.index))));
    if (affirmedDanger) failures.push('failure-not-danger');
  }
  return failures;
}
