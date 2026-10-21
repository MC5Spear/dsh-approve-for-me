/**
 * dsh-approve-for-me — 规则强制检查（纯函数）。
 *
 * 本模块不引用 cordis、会话或宿主服务，因此可用 `node --test` 直接验证；宿主插件只做适配。
 * 规则强制检查独立于 LLM：命中即拒绝，LLM 与人工都不能推翻。
 *
 * 术语沿用 `@deepseek-ai/dsh-user-approval` 与 `@deepseek-ai/dsh-sandbox`：
 *   - 审批请求形如 `{ agent, toolName, callId?, reason?, signal? }`，不含工具参数；
 *   - 沙箱升权 reason 形如 `escalate sandbox to <mode>: <justification>`；
 *   - 结果是闭集 `allowed-once | rejected | cancelled | unavailable`。
 * @module dsh-approve-for-me/policy
 */

/** 沙箱模式由窄到宽排序；未知模式视为比任何上限都宽（fail-closed）。 */
export const MODE_RANK = Object.freeze({
  'read-only': 0,
  'workspace-write': 1,
  'danger-full-access': 2,
});

/** 沙箱允许的升权目标闭集（`dsh-sandbox` 的 `ESCALATION_TARGETS`）。 */
export const ESCALATION_TARGETS = Object.freeze(['workspace-write', 'danger-full-access']);

/**
 * 规则强制拒绝清单：只收不可逆的极危险操作，避免把日常命令误判成危险。
 * 每项是 JavaScript 正则源，编译时统一加 `i`；命中即跳过 LLM 直接拒绝。
 * 前锚取非字母数字边界 `(^|[^A-Za-z0-9])`：引号、括号、`=`、`$(`、反引号等包裹形态
 * 都是非字母数字，一条规则覆盖全部；词内命中（`grep mkfs readme.md`）按 fail-closed 接受，用户可自定义清单收窄。
 */
export const DEFAULT_DENY_PATTERNS = Object.freeze([
  String.raw`(^|[^A-Za-z0-9])(mkfs|diskpart|fdisk|parted)\b`,
  // format 单列且不加尾锚 `\b`：冒号是非词字符，`\b` 要求后随词字符才成立——`format c:"`、`format c: /q`、
  // 行尾 `format c:` 全都不成立，加锚等于把整条模式判死。
  String.raw`(^|[^A-Za-z0-9])format\s+[a-z]:`,
  String.raw`(^|[^A-Za-z0-9])dd\s+.*\bof=/dev/`,
  String.raw`(^|[^A-Za-z0-9])rm\s+(-[a-z]*\s+)*(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+(/|/etc|/usr|/var|/home|\$HOME|[a-z]:\\)(\s|$)`,
  String.raw`(^|[^A-Za-z0-9])Remove-Item\b(?=.*-Recurse)(?=.*-Force).*([a-z]:\\(Windows|Users|Program Files)|\bC:\s*$)`,
  String.raw`(^|[^A-Za-z0-9])(vssadmin\s+delete\s+shadows|bcdedit|cipher\s+/w|wbadmin\s+delete)\b`,
  String.raw`(^|[^A-Za-z0-9])reg\s+delete\s+HKLM`,
  String.raw`(^|[^A-Za-z0-9])(shutdown|Stop-Computer)\b`,
]);

/**
 * 脱敏清单（design §3.2）：五类出口统一替换为 `[redacted]`——提示词证据、工具结果、
 * 审计 reason、注入文本，与审查/结算记录的详情字段（subject 等）。不改会话日志。
 * 首项带左边界（lookbehind）：只匹配词首的 `sk-` 凭据形态，`task-specific` 一类
 * 词内命中不遮蔽；独立 token 前是空白/引号/行首，不受边界影响。
 */
export const DEFAULT_REDACT_PATTERNS = Object.freeze([
  String.raw`(?<![A-Za-z0-9_\-])sk-[A-Za-z0-9_\-]{8,}`,
  String.raw`\bBearer\s+[A-Za-z0-9._\-]{8,}`,
  String.raw`\b(password|passwd|token|api_key|apikey|secret)\s*[=:]\s*[^\s"'` + '`' + String.raw`]+`,
  String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`,
  String.raw`Authorization:\s*[^\r\n]+`,
  String.raw`://[^/\s:@]+:[^/\s:@]+@`,
]);

/**
 * 解析沙箱升权 reason。
 * @param {unknown} reason - 审批请求的 `reason`。
 * @returns {{mode: string, justification: string} | undefined} 非升权请求返回 `undefined`。
 */
export function parseEscalationReason(reason) {
  if (typeof reason !== 'string') return undefined;
  const match = /^escalate sandbox to ([a-z-]+):\s*([\s\S]*)$/.exec(reason);
  if (match === null) return undefined;
  return { mode: match[1], justification: match[2] };
}

/**
 * 判断请求的模式是否不超过配置上限。
 * @param {string} requested - 请求的沙箱模式。
 * @param {string} ceiling - 允许自动放行的最宽模式。
 * @returns {boolean} 未知模式一律 `false`（fail-closed）。
 */
export function modeWithinCeiling(requested, ceiling) {
  const requestedRank = MODE_RANK[requested];
  const ceilingRank = MODE_RANK[ceiling];
  if (requestedRank === undefined || ceilingRank === undefined) return false;
  return requestedRank <= ceilingRank;
}

/**
 * 从 `tool/code-dispatch-start` 的 `data.arguments`（对象）中取出可读的命令或路径。
 * @param {unknown} args - 回查到的参数对象。
 * @returns {string | undefined} 命令/路径文本；取不到返回 `undefined`。
 */
export function extractSubject(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined;
  for (const key of ['command', 'cmd', 'script', 'path', 'file_path', 'filePath', 'pattern']) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * 编译一条配置里的正则。支持普通源串（加 `i`）与 `/source/flags` 形式。
 * @param {unknown} pattern - 配置里的模式串或 RegExp。
 * @returns {RegExp | undefined} 不可用时返回 `undefined`（该项失效但不影响其余项）。
 */
export function compilePattern(pattern) {
  if (pattern instanceof RegExp) return pattern;
  if (typeof pattern !== 'string' || pattern.length === 0) return undefined;
  const literal = /^\/(.*)\/([a-z]*)$/.exec(pattern);
  try {
    if (literal !== null && literal[1].length > 0) return new RegExp(literal[1], literal[2] || 'i');
    return new RegExp(pattern, 'i');
  } catch {
    return undefined;
  }
}

/**
 * 硬性危险拦截层（design §12.1，需求增补 H1/H2/H3）：确定性纯文本判定，默认开启、无配置项。
 * 命中即拒绝，不调用 LLM、不交人工，与规则直拒同一结算语义（结算 source=hard）。
 * 匹配对象只限回查参数中的命令文本（command/cmd/script 三键＋同对象 args/argv 拼接），
 * 随行文字（理由、说明、提交信息）不参与；与用户 denyPatterns 全串扫描是两个独立层。
 */
/** PowerShell 删除动词全集：Remove-Item 本名与六个别名（大小写不敏感）。 */
const PS_DELETE_VERBS = new Set(['remove-item', 'rm', 'ri', 'del', 'erase', 'rd', 'rmdir']);
/** POSIX rm 短标志全集的小写归一（GNU/BSD/busybox：r R f i I d v P）——短标志簇的字母表。 */
const RM_SHORT_FLAG_LETTERS = /^[rfdvip]+$/u;
/** H2 参数边界扫描的参数名族（design §12.1）：小写全名，前缀匹配；跨类歧义按目标>开关>取值定类。 */
const TARGET_PARAM_NAMES = ['path', 'literalpath'];
const SWITCH_PARAM_NAMES = ['force', 'recurse', 'verbose', 'debug', 'whatif', 'confirm'];
const VALUE_PARAM_NAMES = [
  'filter', 'include', 'exclude', 'credential',
  'erroraction', 'warningaction', 'informationaction',
  'errorvariable', 'warningvariable', 'informationvariable',
  'outvariable', 'outbuffer', 'pipelinevariable',
];
/** 包装剥层认识的解释器（首词去路径与后缀后的基名）与执行标志。
 *  cmd 的 `/k`（执行并保持）与 `/c`（执行并退出）同为「实际要执行的命令文本」的入口。 */
const WRAPPER_INTERPRETERS = new Set(['powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh', 'dash', 'ksh']);
const WRAPPER_EXEC_FLAGS = new Set(['-command', '-c', '/c', '/k']);
/** 簇形态执行标志只认 POSIX 类首词（design §12.1）：pwsh 的 `-c` 是 `-Command` 缩写、无簇语法，
 *  cmd 是斜杠制，都不适用簇规则。 */
const POSIX_WRAPPER_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
/**
 * POSIX shell 的短旗标簇执行标志（design §12.1）：单横线＋全小写字母且簇内含 `c` 的 token。
 * `-c` 的语义是命令文本取自标志 token 之后的下一个非选项实参；主流 shell 的单字母启动选项中
 * 其余小写字母（l/i/r/e/u/x 等）都不取实参，剥层仍剥标志 token 之后的文本。
 * 含 `o` 的簇一律不认：`o` 取实参——`-oc` 里 `c` 被吃成 `o` 的实参值、`-co` 里 `o` 抢走后随
 * token 作选项名，两种形态都不是执行入口，维持无法归一、回落审查层。
 * @param {string} token - 待判定的 token 原文（大小写敏感：大写字母是别的选项或无效）。
 * @returns {boolean} 是否按执行标志读。
 */
function posixClusterExecFlag(token) {
  return /^-[a-z]+$/u.test(token) && !token.includes('o') && token.includes('c');
}

/** H2 目标候选扫描的命令族（design §12.1 按命令族分道）：族只决定参数消费与动态标记规则，
 *  不改变动词集合与 H1/H2/H3 形态判定。POSIX（rm）与 CMD（del/erase/rd/rmdir）的全部单横线
 *  token 只跳过自身——POSIX 短旗标不取值、CMD 无此语法，按参数名归类消费会把紧跟旗标的真目标
 *  藏进参数值（漏拦方向）；PowerShell（remove-item/ri）维持参数名四类归位。别名重载（rm/del/rd
 *  在 PowerShell 里是 Remove-Item 别名，具名参数语义存在）统一取不消费一侧：两侧不可兼得时，
 *  取偏误拦侧、经改写重送条款消化。
 *  动态标记同族分道：CMD 的延迟变量 `!名字!` 按 `!` 子串判定（名字可含空格、成对形态匹配盖不住，
 *  且允许未闭合残留）；PowerShell 的 splat `@名字` 与子表达式 `(…)` 按前导前缀判定——两者在
 *  路径中段是普通文件名字符，子串判定会把字面路径误判为动态目标，只认串首。 */
const POSIX_OPERAND_FAMILY = Object.freeze({
  slashFlags: false,
  consumeParams: false,
  markers: Object.freeze(['$', '%', '`', '~']),
  prefixes: Object.freeze([]),
});
const CMD_OPERAND_FAMILY = Object.freeze({
  slashFlags: true,
  consumeParams: false,
  markers: Object.freeze(['$', '%', '`', '~', '!']),
  prefixes: Object.freeze([]),
});
const PS_OPERAND_FAMILY = Object.freeze({
  slashFlags: false,
  consumeParams: true,
  markers: Object.freeze(['$', '%', '`', '~']),
  prefixes: Object.freeze(['@', '(']),
});
/** 剥去 token 首尾引号（不成对也剥，多层也剥）：shell 先行去引号后 `rm "-rf"` 等价 `rm -rf`。 */
function stripQuotes(token) {
  let t = token;
  while (t.length > 0 && (t.startsWith('"') || t.startsWith("'"))) t = t.slice(1);
  while (t.length > 0 && (t.endsWith('"') || t.endsWith("'"))) t = t.slice(0, -1);
  return t;
}
/** token 去路径前缀与引号后的基名（小写）：`C:\x\rm`→`rm`、`"mshta.exe"`→`mshta`。 */
function tokenBasename(token) {
  // 首尾引号剥除见 stripQuotes：命令文本内的引号段（git commit -m "Remove-Item …"、
  // echo "rm -rf /"）按命令文本整体过检，不做内容级豁免（需求 §10 H1 随行文字条款收窄的范围）。
  const t = stripQuotes(token);
  const slash = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/'));
  const base = slash === -1 ? t : t.slice(slash + 1);
  const lowered = base.toLowerCase();
  return lowered.endsWith('.exe') ? lowered.slice(0, -4) : lowered;
}
/** PowerShell 开关冒号绑定的真值判定（design §12.1「按绑定真值计」）。经 `Get-ChildItem -Force`
 *  实测裁定（Windows PowerShell 5.1 cmdlet 绑定器）：只接受布尔字面量（`$true`／`$false`，任意
 *  大小写与 `$` 前缀）与无符号十进制数值（数值按零／非零绑定为假／真；`1.5` 为真、`0.0` 为假）；
 *  其余一切串（裸 `true`、`yes`、`on`、`-1`、`abc`）参数绑定报错、命令不执行——返回 `null`，
 *  该 token 不算开关、回落审查层。无绑定（裸开关）＝真。 */
function psSwitchBoundTrue(rawValue) {
  if (rawValue === undefined) return true;
  const v = rawValue.toLowerCase();
  if (v.startsWith('$')) {
    const literal = v.slice(1);
    if (literal === 'true') return true;
    if (literal === 'false') return false;
    return null;
  }
  if (/^\d+(?:\.\d+)?$/.test(v)) return Number(v) !== 0;
  return null;
}
/** 装配命令文本（design §12.1）：三键各为一段（值为数组时按序拼接其字符串元素）；同一参数对象内
 *  args/argv 的字符串元素（含一层嵌套数组）按序单空格拼接；无三键而独有 args/argv 的对象、以及
 *  参数根本身为数组的形态，同样产出拼接段——匹配对象是「实际要执行的命令文本」，不因上游
 *  用数组形态提交而豁免。枚举异常安全（gate.js 头注不变量 I2：应答者永不抛出）：恶意 getter 在 Object.entries 处
 *  引爆时降级为逐键探取三键，再取不到就当无命令文本——请求按既有路径继续，不因本层抛错改变结算。 */
function joinCommandWords(words) {
  const parts = [];
  for (const word of words) {
    if (typeof word === 'string' && word.length > 0) parts.push(word);
    else if (Array.isArray(word)) {
      for (const inner of word) {
        if (typeof inner === 'string' && inner.length > 0) parts.push(inner);
      }
    }
  }
  return parts.join(' ');
}
function collectCommandTexts(value, depth, keyPath, out) {
  if (value === null || typeof value !== 'object' || depth >= 4) return;
  if (Array.isArray(value)) {
    // 数组只在两处产出命令段：参数根本身（字符串元素按序拼接＝命令词序列）与 args/argv 分支（另行处理）。
    // 非根数组不产出段——非命令键的数组值（说明、提交信息等）属随行文字，按三键白名单不参与装配；
    // 数组内的对象元素仍递归探取其中的命令键（[{command:…}] 形态可装配）。
    if (keyPath === '') {
      const text = joinCommandWords(value);
      if (text.length > 0) out.push({ key: 'arguments', text });
    }
    for (let i = 0; i < value.length; i += 1) {
      const element = value[i];
      if (element !== null && typeof element === 'object' && !Array.isArray(element)) {
        collectCommandTexts(element, depth + 1, `${keyPath === '' ? 'arguments' : keyPath}[${i}]`, out);
      }
    }
    return;
  }
  let entries;
  try {
    entries = Object.entries(value);
  } catch {
    for (const name of ['command', 'cmd', 'script']) {
      let child;
      try {
        child = value[name];
      } catch {
        continue;
      }
      const single = typeof child === 'string' && child.length > 0 ? child : Array.isArray(child) ? joinCommandWords(child) : '';
      if (single.length > 0) {
        out.push({ key: keyPath === '' ? name : `${keyPath}.${name}`, text: single });
      }
    }
    return;
  }
  let hasCommandKey = false;
  for (const [name, child] of entries) {
    if (name === 'command' || name === 'cmd' || name === 'script') {
      const own = typeof child === 'string' ? child : Array.isArray(child) ? joinCommandWords(child) : '';
      if (own.length > 0) hasCommandKey = true;
    }
  }
  for (const [name, child] of entries) {
    const path = keyPath === '' ? String(name) : `${keyPath}.${String(name)}`;
    if ((name === 'command' || name === 'cmd' || name === 'script') && (typeof child === 'string' || Array.isArray(child))) {
      const own = typeof child === 'string' ? child : joinCommandWords(child);
      if (own.length === 0) continue;
      let text = own;
      for (const arrKey of ['args', 'argv']) {
        let arr;
        try {
          arr = value[arrKey];
        } catch {
          continue;
        }
        if (!Array.isArray(arr)) continue;
        const joined = joinCommandWords(arr);
        if (joined.length > 0) text += ` ${joined}`;
      }
      out.push({ key: path, text });
      continue;
    }
    // 无三键而独有 args/argv：数组本身就是命令词序列，整段过检。
    if ((name === 'args' || name === 'argv') && Array.isArray(child) && !hasCommandKey) {
      const text = joinCommandWords(child);
      if (text.length > 0) {
        out.push({ key: path, text });
        continue;
      }
    }
    collectCommandTexts(child, depth + 1, path, out);
  }
}
/**
 * 参数名归类（design §12.1 H2 参数边界扫描，PowerShell 族专用——POSIX/CMD 族的横线 token
 * 一律不消费后随 token）：`name` 是某族参数名的前缀（含全名，PS 缩写即前导前缀）
 * 即归该族；跨族歧义按目标>开关>取值解决——误按开关（不消费）只把真参数值多计为一个位置候选（偏误拦），
 * 误按取值（消费）会把真目标藏进参数值（偏漏拦），取偏误拦一侧。其余为未识别。
 * @param {string} name - 去横线、去绑定值后的参数名（小写）。
 * @returns {'target' | 'switch' | 'value' | 'unknown'} 类别。
 */
function classifyParamName(name) {
  if (name.length > 0 && TARGET_PARAM_NAMES.some((n) => n.startsWith(name))) return 'target';
  if (name.length > 0 && SWITCH_PARAM_NAMES.some((n) => n.startsWith(name))) return 'switch';
  if (name.length > 0 && VALUE_PARAM_NAMES.some((n) => n.startsWith(name))) return 'value';
  return 'unknown';
}

/**
 * H2 目标字面可判定（design §12.1）：删除目标操作数不含变量引用、命令替换与波浪线才算字面。
 * 操作数按命令族分道扫描（族表见 `*_OPERAND_FAMILY`）：PowerShell 族按参数名四类归位——目标参数
 * 的绑定值（冒号或分离）是删除目标、取值参数的绑定值跳过、开关参数不消费后续；POSIX 与 CMD 族的
 * 全部单横线 token 只跳过自身、不消费后随 token，冒号绑定值按目标候选过检（保守）。
 * @param {number} verbIndex - 动词 token 下标。
 * @param {string[]} tokens - 语句 token（已剥首尾引号）。
 * @param {object} family - 命令族描述（`*_OPERAND_FAMILY`）。
 * @returns {boolean} 全部目标候选字面且至少有一个候选。
 */
function operandsAllLiteral(verbIndex, tokens, family) {
  let seen = 0;
  let clean = true;
  /** 记一个目标候选：含族标记（`$`、`$env:`、`%VAR%`、`$( )`、反引号、`~`，CMD 族另含 `!`）
   *  或带结构前缀（PowerShell 的 `@` splat、`(` 子表达式）即不可字面确定。 */
  const note = (t) => {
    seen += 1;
    if (family.markers.some((m) => t.includes(m)) || family.prefixes.some((p) => t.startsWith(p))) clean = false;
  };
  let i = verbIndex + 1;
  while (i < tokens.length) {
    const raw = tokens[i];
    const t = raw.toLowerCase();
    // `--` 长选项与分隔符：标志判定在旗标循环，这里只跳过 token 本身、不消费后续；
    // 冒号绑定值按目标候选过标记检查（design §12.1：未识别长选项的绑定值不因 `--` 前缀豁免）。
    // 裸分隔符（恰为 `--`）无绑定值，其后的 token 按位置操作数过检。
    if (t.startsWith('--')) {
      const colon = t.indexOf(':');
      if (colon !== -1 && t.length > colon + 1) note(t.slice(colon + 1));
      i += 1;
      continue;
    }
    if (t.startsWith('-') && t.length > 1) {
      // POSIX/CMD 族：单横线 token（短旗标、簇、任意拼写）只跳过自身、不消费后随 token；
      // 冒号绑定值按目标候选过检（未确定的参数边界按保守处理，宁可误拦）。
      if (!family.consumeParams) {
        const colon = t.indexOf(':');
        if (colon !== -1 && t.length > colon + 1) note(t.slice(colon + 1));
        i += 1;
        continue;
      }
      const colon = t.indexOf(':');
      const name = colon === -1 ? t.slice(1) : t.slice(1, colon);
      const bound = colon === -1 ? undefined : t.slice(colon + 1);
      const kind = classifyParamName(name);
      if (kind === 'target') {
        // 目标参数：冒号绑定值或分离绑定值是删除目标；无可绑定值时不产生候选（偏误拦方向）。
        if (bound !== undefined) {
          if (bound.length > 0) note(bound);
          i += 1;
          continue;
        }
        const next = tokens[i + 1];
        if (next !== undefined && !next.toLowerCase().startsWith('-')) {
          note(next);
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }
      if (kind === 'value') {
        // 取值参数：绑定值不是删除目标——冒号与分离绑定值都跳过（`-ErrorAction Continue` 的
        // `Continue` 不再被当目标）；后随 token 是横线前缀时不消费（那是下一个参数）。
        if (bound !== undefined) {
          i += 1;
          continue;
        }
        const next = tokens[i + 1];
        i += next !== undefined && !next.toLowerCase().startsWith('-') ? 2 : 1;
        continue;
      }
      if (kind === 'switch') {
        // 开关参数：不消费后续 token；冒号绑定值是真值表达式（-Force:$true 一类），一并跳过。
        i += 1;
        continue;
      }
      // 未识别参数：只跳过该 token 本身、不消费后续；冒号绑定值按目标候选过标记检查。
      if (bound !== undefined && bound.length > 0) note(bound);
      i += 1;
      continue;
    }
    // CMD 族跳过斜杠旗标：单字母、斜杠分隔（/s/q）与 1–3 字母合并簇（单字母旗标连写，/sq）；
    // 4 字母以上（/data）按操作数，否则 `rd /s /data` 的短路径会被当旗标跳过、操作数计零
    // 而误判「无操作数」。POSIX 语境（rm）与 PowerShell 语境不跳过斜杠 token——`/a` 一类单字母根路径是操作数不是旗标。
    if (family.slashFlags && (/^\/[a-z](\/[a-z])*$/i.test(raw) || /^\/[a-z]{1,3}$/i.test(raw))) {
      i += 1;
      continue;
    }
    note(raw);
    i += 1;
  }
  // 无候选＝目标无从证明字面：按不可确定处理（宁可误拦）。
  return seen > 0 && clean;
}
/**
 * 判定单个语句是否命中硬性危险拦截（design §12.1）。
 * @param {string} statement - 已拆分的单条语句文本。
 * @param {number} wrapDepth - 当前包装层数（剥层递归时累加）。
 * @returns {{code: string, form: string, wrapDepth: number} | undefined} 命中返回形态短码、名称与层数。
 */
function classifyStatement(statement, wrapDepth) {
  // 分词即剥引号：动词基名、旗标、操作数同源过检——shell 先行去引号后 `rm "-rf"` 等价 `rm -rf`，
  // 旗标侧不剥会留下「一字之差绕过 H1」的降级缝（引号化旗标把硬性拦截请求变成 LLM 审查）。
  const tokens = statement
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map(stripQuotes);
  if (tokens.length === 0) return undefined;
  const head = tokenBasename(tokens[0]);
  if (WRAPPER_INTERPRETERS.has(head)) {
    const posixShell = POSIX_WRAPPER_SHELLS.has(head);
    const flagIndex = tokens.findIndex(
      (t, i) => i > 0 && (WRAPPER_EXEC_FLAGS.has(t.toLowerCase()) || (posixShell && posixClusterExecFlag(t))),
    );
    if (flagIndex !== -1) {
      // 剥出内层文本：标志文本在语句中首次出现处之后的原文（早于标志本位的同名子串会使起点
      // 前移——只偏多扫、不漏拦）；整段被一层引号包住时剥掉该层。已知边界：内层文本
      // 以反斜杠转义引号（源码级 `\"rm` 形态）时该层引号剥不掉、动词带 `\"` 前缀不识别——属
      // 「无法归一＝回落审查层」的既定口径（真实回查参数经 JSON 解码后多为裸引号，可正常剥层）。
      if (wrapDepth >= 3) return undefined; // 超过三层按无法归一处理，回落审查层。
      const flagToken = tokens[flagIndex];
      const cut = statement.toLowerCase().indexOf(flagToken.toLowerCase());
      const after = cut === -1 ? '' : statement.slice(cut + flagToken.length).trim();
      let inner = after;
      if (inner.length >= 2 && ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'")))) {
        inner = inner.slice(1, -1);
      }
      if (inner.length === 0) return undefined; // 内层无法提取＝无法归一。
      return classifyStatement(inner, wrapDepth + 1);
    }
    return undefined; // 解释器无执行标志：无法归一，不猜。
  }
  // H3 远程内容入口：语句内任一 token 基名为 mshta（或 rundll32＋url.dll,FileProtocolHandler 形态）
  // 且语句含 http/https 地址即命中（与 H1 同取动词任意位置口径；`start mshta`、`& mshta` 前置词不豁免）。
  const lower = statement.toLowerCase();
  const hasUrl = lower.includes('http://') || lower.includes('https://');
  if (hasUrl) {
    if (tokens.some((t) => tokenBasename(t) === 'mshta')) {
      return { code: 'hard-h3-entry', form: 'mshta 加载网址', wrapDepth };
    }
    if (tokens.some((t) => tokenBasename(t) === 'rundll32') && tokens.some((t) => tokenBasename(t) === 'url.dll,fileprotocolhandler')) {
      return { code: 'hard-h3-entry', form: 'rundll32 url.dll,FileProtocolHandler 加载网址', wrapDepth };
    }
  }
  // H1/H2：删除动词与标志组合。动词取语句内任意 token（管道、前后缀形态同判；误差只偏多拦）。
  for (let i = 0; i < tokens.length; i += 1) {
    const verb = tokenBasename(tokens[i]);
    if (!PS_DELETE_VERBS.has(verb)) continue;
    const flag = { psForce: false, psRecurse: false, posixR: false, posixF: false, longR: false, longF: false, cmdF: false, cmdS: false, cmdQ: false };
    for (const raw of tokens) {
      const t = raw.toLowerCase();
      // PowerShell 开关绑定写法（-Force:$true）按绑定真值计（实测裁定见 psSwitchBoundTrue）：
      // 布尔字面量与无符号数值按绑定结果计，绑定报错的串不算开关、回落审查层——命令本身不会执行。
      // 前缀族取实测可绑定成功的无歧义前缀：Force 族 fo/for/forc/force（裸 -f 歧义排除），
      // Recurse 族 r/re/rec/recu/recur/recurs/recurse。
      const psSwitch = /^-(force|fo|for|forc|recurse|recurs|recur|recu|rec|re|r)(?::([^:]*))?$/i.exec(t);
      if (psSwitch !== null && psSwitchBoundTrue(psSwitch[2]) === true) {
        if (/^(fo|for|forc|force)$/.test(psSwitch[1].toLowerCase())) flag.psForce = true;
        else flag.psRecurse = true;
      }
      // 短标志簇按字母表判定（design §12.1）：去横线后全部字母属于主流 rm 短标志全集的小写归一
      // {r f i d v p} 即簇，长度不限、字母可重复——`-rfvv`、`-frvvv`、`-irfdvp` 都按簇读（重复 v
      // 是合法 verbose 标志）。字母表外的字母不按簇读：`-force`、`-filter` 是 PowerShell 参数拼写，
      // `-force` 含 f 与 r，按任意字母簇误读会把「仅强制」的 PowerShell 形态判成递归+强制。
      if (/^-[a-z]+$/u.test(t) && RM_SHORT_FLAG_LETTERS.test(t.slice(1))) {
        if (t.includes('r')) flag.posixR = true;
        if (t.includes('f')) flag.posixF = true;
      } else if (t === '--recursive') flag.longR = true;
      else if (t === '--force') flag.longF = true;
      // CMD 旗标三种写法同判：单字母（/f）、斜杠分隔（/s/q）、合并簇（/sq）——cmd 的合并与分隔写法等价。
      // 归一层把 2–4 字母簇也按字母集扫：动词已限定删除族、簇内无 f/s/q 即无效果，宽归一只偏多拦；
      // 目标候选的跳过层另按 1–3 字母簇从严（4 字母以上按操作数，理由见上方跳过规则）。
      if (t.startsWith('/')) {
        const body = t.slice(1);
        if (/^[a-z]$/.test(body) || /^[a-z]{2,4}$/.test(body) || /^(?:[a-z]\/)+[a-z]$/.test(body)) {
          for (const ch of body.replace(/\//g, '')) {
            if (ch === 'f') flag.cmdF = true;
            else if (ch === 's') flag.cmdS = true;
            else if (ch === 'q') flag.cmdQ = true;
          }
        }
      }
    }
    const hasR = flag.posixR || flag.longR;
    const hasF = flag.posixF || flag.longF;
    // H1-POSIX：rm 同时带递归与强制（聚合、拆分、长选项任意组合），判在 PS 缩写族之前。
    if (verb === 'rm' && hasR && hasF) {
      return { code: 'hard-h1-posix', form: 'POSIX rm 同时带递归与强制标志', wrapDepth };
    }
    // H1-PowerShell：Remove-Item（含全部别名）带 -Recurse（含无歧义缩写与真值绑定）。
    // 仅 -Force 不命中 H1（需求 §10 H1 枚举边界）：目标非字面时按 H2 仅强制形态拦截。
    // 边界（design §12.1）：`-r` 一律按 -Recurse 缩写读（经 -WhatIf 实测裁定），任何 shell 语境的
    // `rm -r`（含 `git rm -r`）按本分支命中并直接拒绝，不落 H1-POSIX 的「递归+强制」双标志要求。
    if (flag.psRecurse) {
      return { code: 'hard-h1-powershell', form: 'PowerShell 删除动词带 -Recurse 标志', wrapDepth };
    }
    // H1-CMD：del/erase 带 /f；rd/rmdir 同时带 /s 与 /q（合并簇与斜杠分隔写法已在旗标归一步统一）。
    if ((verb === 'del' || verb === 'erase') && flag.cmdF) {
      return { code: 'hard-h1-cmd', form: 'CMD del/erase 带 /f', wrapDepth };
    }
    if ((verb === 'rd' || verb === 'rmdir') && flag.cmdS && flag.cmdQ) {
      return { code: 'hard-h1-cmd', form: 'CMD rd/rmdir 带 /s 与 /q', wrapDepth };
    }
    // H2：H1 未命中的仅递归族与仅强制族，目标非字面即拒绝（需求 §10 H2：形态口径宽于 H1 枚举边界）。
    // 仅递归＝rm 仅递归、rd/rmdir 仅 /s、del/erase 仅 /s；仅强制＝rm 仅 -f/--force、PS 动词仅 -Force、
    // rd/rmdir 仅 /q（del/erase 的 /f 属 H1-CMD 枚举，已提前返回，不在此列）。
    // 字面目标的仅标志形态交审查层（3.3 第 4 条）。
    const recursiveOnly =
      (verb === 'rm' && hasR && !hasF) ||
      ((verb === 'rd' || verb === 'rmdir') && flag.cmdS && !flag.cmdQ) ||
      ((verb === 'del' || verb === 'erase') && flag.cmdS && !flag.cmdF);
    const forceOnly =
      (verb === 'rm' && hasF && !hasR) ||
      flag.psForce ||
      ((verb === 'rd' || verb === 'rmdir') && flag.cmdQ && !flag.cmdS);
    const family =
      verb === 'rm' ? POSIX_OPERAND_FAMILY
        : verb === 'del' || verb === 'erase' || verb === 'rd' || verb === 'rmdir' ? CMD_OPERAND_FAMILY
          : PS_OPERAND_FAMILY;
    if ((recursiveOnly || forceOnly) && !operandsAllLiteral(i, tokens, family)) {
      return { code: 'hard-h2-target', form: '删除目标无法从字面确定（仅强制或仅递归形态）', wrapDepth };
    }
  }
  return undefined;
}
/**
 * 引号感知拆句（design §12.1）：单引号与双引号逐字符切换引号态，只在引号态之外按换行与分号拆分，
 * 引号内的分隔符不拆散语句（`Remove-Item 'C:\a;b' -Recurse` 保持单语句）。边界规则：不解释转义
 * （`\`、反引号与成对单引号等各方言转义不改变引号态——三种 shell 转义方言互斥且命令的 shell
 * 不总可判定，逐字符切换是无方言假设的确定规则）；未闭合引号到文本末尾按一段处理，不丢语句。
 * @param {string} text - 命令文本段。
 * @returns {string[]} 语句数组（含空串，由调用方逐句判定时自然过滤）。
 */
function splitStatements(text) {
  const out = [];
  let current = '';
  let quote = '';
  for (const ch of text) {
    if (quote === '') {
      if (ch === "'" || ch === '"') quote = ch;
      else if (ch === '\n' || ch === ';') {
        out.push(current);
        current = '';
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === quote) quote = '';
    current += ch;
  }
  out.push(current);
  return out;
}

/**
 * 对回查参数做硬性危险拦截判定（design §12.1）。
 * @param {{arguments?: object} | null} located - 回查结果。
 * @returns {{code: string, form: string, key: string, wrapDepth: number} | undefined} 命中信息。
 */
export function matchHardDeny(located) {
  const segments = [];
  collectCommandTexts(located?.arguments, 0, '', segments);
  for (const { key, text } of segments) {
    for (const statement of splitStatements(text)) {
      const hit = classifyStatement(statement, 0);
      if (hit !== undefined) return { ...hit, key };
    }
  }
  return undefined;
}

/**
 * 对一次审批请求做规则强制检查。
 * @param {{toolName?: string, callId?: string, reason?: string}} request - 审批请求。
 * @param {{command?: string, cwd?: string, arguments?: object} | null} located - 回查结果。
 * @param {object} cfg - 已解析的插件配置。
 * @returns {{action: 'skip' | 'deny' | 'review', why: string, reason?: string, fields: object}}
 *   `skip` = 不接管，交给下一个应答者；`deny` = 直接拒绝；`review` = 进入 LLM 审查。
 */

export function screen(request, located, cfg) {
  const base = {
    callId: request?.callId,
    tool: request?.toolName,
    cwd: located?.cwd,
    mode: parseEscalationReason(request?.reason)?.mode,
  };

  if ((cfg?.mode ?? 'rules') === 'off') {
    return { action: 'skip', why: 'mode=off', fields: { ...base, action: 'skip' } };
  }

  const tools = cfg?.tools ?? [];
  if (tools.length > 0 && !tools.includes(request?.toolName)) {
    return {
      action: 'skip',
      why: `tool "${request?.toolName}" is outside the configured tools list`,
      fields: { ...base, action: 'skip' },
    };
  }

  const escalation = parseEscalationReason(request?.reason);
  if (escalation === undefined) {
    // 非沙箱升权请求不归本插件管；保持宿主原有的审批通道不变。
    return { action: 'skip', why: 'not a sandbox escalation', fields: { ...base, action: 'skip' } };
  }

  const ceiling = cfg?.allowEscalationTo ?? 'danger-full-access';
  if (!modeWithinCeiling(escalation.mode, ceiling)) {
    return {
      action: 'deny',
      why: `escalation to "${escalation.mode}" exceeds allowEscalationTo "${ceiling}"`,
      reason: `升权目标 ${escalation.mode} 超过自动放行上限 ${ceiling}`,
      fields: { ...base, action: 'deny' },
    };
  }

  // 硬性危险拦截（design §12.1，需求增补 H1/H2/H3）：先于用户规则；命中即拒绝，不调 LLM、不交人工，
  // 无配置项、默认开启。匹配对象只限命令文本三键（含同对象 args/argv 拼接），随行文字不参与。
  const hard = matchHardDeny(located);
  if (hard !== undefined) {
    const wrapText = hard.wrapDepth > 0 ? `；包装 ${hard.wrapDepth} 层` : '';
    return {
      action: 'deny',
      why: `hard deny ${hard.code}: key "${hard.key}" wrap ${hard.wrapDepth}`,
      reason: `命中硬性危险拦截（${hard.code}）：${hard.form}；命令键 "${hard.key}"${wrapText}`,
      fields: { ...base, action: 'deny', source: 'hard' },
    };
  }

  // 规则扫描先于主体判定：扫描对象是 arguments 的全部字符串值，不依赖 extractSubject 的结果，
  // 回查参数无命令类键时其他键的载荷同样过检（命中即直拒，缺证降级标记只随 unknownSubject 处置出现）。
  // 主体全量过检：deny 判定遍历 arguments 里全部字符串值（own enumerable，深 ≤4，对象与数组都走），
  // 不只看 extractSubject 的首键——毒藏后位键（script/args 一类）同样命中；首键语义保留给 evidence 取材。
  // 非命令字符串（env 值、注释一类）也会过检：口径＝宁可误伤，fail-closed。
  const compiledDeny = [];
  for (const pattern of cfg?.denyPatterns ?? []) {
    const compiled = compilePattern(pattern);
    if (compiled !== undefined) compiledDeny.push({ pattern, compiled });
  }
  let hit;
  for (const entry of compiledDeny) {
    eachStringValue(located?.arguments, (text, key) => {
      if (hit === undefined && entry.compiled.test(text)) hit = { pattern: entry.pattern, key };
    });
    if (hit !== undefined) break;
  }
  if (hit !== undefined) {
    return {
      action: 'deny',
      why: `deny pattern ${String(hit.pattern)} matched key "${hit.key}"`,
      reason: `命令命中规则强制拒绝清单：键 "${hit.key}" 命中模式 ${String(hit.pattern)}`,
      // source=rule 与硬性拦截的 source=hard 同走「规则命中的直接拒绝」通知通道（需求 §4.3）。
      fields: { ...base, action: 'deny', source: 'rule' },
    };
  }

  const subject = extractSubject(located?.arguments);
  if (subject === undefined) {
    if ((cfg?.unknownSubject ?? 'reject') === 'reject') {
      return {
        action: 'deny',
        why: 'command not found for callId',
        reason: '未能回查到本次调用的命令或参数，按无证据处理',
        fields: { ...base, action: 'deny', degraded: 'command' },
      };
    }
    return {
      action: 'review',
      why: 'command not found; unknownSubject=review',
      fields: { ...base, action: 'review', degraded: 'command' },
    };
  }

  return { action: 'review', why: 'rules passed', fields: { ...base, action: 'review' } };
}

/**
 * 遍历一个值里的全部字符串（own enumerable，对象与数组，深度上限 4 防构造深嵌套）。
 * @param {unknown} value - 任意值。
 * @param {(text: string, key: string) => void} visit - 访问器（key 为点分与下标组合路径，根为 `arguments`）。
 * @param {number} [depth] - 当前深度。
 * @param {string} [key] - 当前键路径。
 * @returns {void}
 */
function eachStringValue(value, visit, depth = 0, key = '') {
  if (typeof value === 'string') {
    visit(value, key === '' ? 'arguments' : key);
    return;
  }
  if (value === null || typeof value !== 'object' || depth >= 4) return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      eachStringValue(value[index], visit, depth + 1, key === '' ? `[${index}]` : `${key}[${index}]`);
    }
    return;
  }
  for (const [name, childValue] of Object.entries(value)) {
    eachStringValue(childValue, visit, depth + 1, key === '' ? String(name) : `${key}.${String(name)}`);
  }
}
