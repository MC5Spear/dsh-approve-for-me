/**
 * dsh-approve-for-me — 审查器专用只读工具集。
 *
 * 四个工具全部基于 `node:fs` 的只读 API 实现：不经工具注册表、不触发审批、不派生进程、不联网。
 * 只读性由构造保证——本文件只出现 `open(path,'r')`、`readdir`、`stat`、`realpath`。
 * 审查器在无人工通道时若拿不到证据会倾向误拒，故工具必须能读工作区外的路径（升权目标多在工作区外）。
 * 实例闭包状态是**未传上下文时的回退基线**；生产路径（`rt.review`）按请求构造快照、
 * 经 `run` 的第 4 参显式传入——在飞任务的基准目录/文案语言/超时/遮蔽清单不受并发请求或热改影响。
 * @module dsh-approve-for-me/readonly-tools
 */
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import { agentT } from './agent-texts.js';

/**
 * DSH 数据根目录：`DSH_HOME` 优先、缺省回落 `~/.dsh`——与本插件 reviews 目录同一解析口径
 * （lib/index.js 的 reviewsDir）；拒止围栏与自身落盘必须同源，自己写在哪就拒读到哪。
 * @returns {string} home 根。
 */
export function dshHome() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  return configured.length > 0 ? configured : join(homedir(), '.dsh');
}

/** 取词并做 `{param}` 占位替换（模型侧文案全部来自 agent-texts 字典）。 */
function fmt(text, params) {
  let out = text;
  for (const [key, value] of Object.entries(params ?? {})) out = out.replaceAll(`{${key}}`, String(value));
  return out;
}

/** 单次 `read_file` 的字节上限。 */
export const READ_MAX_BYTES = 64 * 1024;
/** `list_dir` 的条目上限。 */
export const LIST_MAX_ENTRIES = 200;
/** `glob` 的匹配上限。 */
export const GLOB_MAX_ENTRIES = 200;
/** `grep` 的匹配上限。 */
export const GREP_MAX_MATCHES = 100;
/** `grep` 单行字符数上限：超长行整行跳过、不截断（计数进结果尾部说明）。 */
export const GREP_MAX_LINE_CHARS = 500;
/** grep 源串长度上限：取证用正则远短于此，超限直接判不安全。 */
export const PATTERN_MAX_CHARS = 256;
/** grep 单文件字节上限：超过即跳过并在结果里说明，不整读进内存。 */
export const GREP_MAX_FILE_BYTES = 1024 * 1024;
/** grep 候选文件数上限（过滤后计数）：一次取证合理的文件数，达上限即停止搜索。 */
export const GREP_MAX_CANDIDATES = 200;
/** grep 原始候选上限（过滤前）：glob 过滤式在工作者内执行，主线程只按原始量封顶收集。 */
export const GREP_MAX_RAW_CANDIDATES = 2000;
/** glob 原始路径上限（匹配前）：遍历收集的相对路径批量送工作者匹配。 */
export const GLOB_MAX_RAW_PATHS = 2000;
/** 静态判据④的相邻量词原子连跑阈值：`a*a*a*a*b` 一类多项式回溯形态在此拦下。 */
export const ADJACENT_QUANTIFIERS_LIMIT = 4;
/** 单次遍历的目录数上限，防止在巨大目录树上打转。 */
const WALK_MAX_DIRS = 4000;
/** 正则工作者入口：随包发布（package.json files 含 lib/），`execArgv` 清空以在干净线程加载。 */
const REGEX_WORKER_URL = new URL('./regex-worker.mjs', import.meta.url);

/** 凭据类文件名（按 basename 匹配）。 */
const DENIED_BASENAMES = Object.freeze([
  /^\.credentials/u,
  /^id_rsa/u,
  /^id_ed25519/u,
  /^\.env/u,
  /_history$/u,
  /^\.netrc$/u,
  /^\.git-credentials$/u,
  /^\.npmrc$/u,
  /^settings\.ya?ml$/u,
]);

/** 凭据类扩展名。 */
const DENIED_EXTENSIONS = new Set(['.pem', '.key', '.pfx', '.kdbx']);

/** 凭据类目录：`.ssh` 下全部拒止；`.aws` 下 `credentials`；`.docker` 下 `config.json`。 */
const DENIED_DIRECTORIES = Object.freeze({
  '.ssh': null,
  '.aws': 'credentials',
  '.docker': 'config.json',
});

/**
 * 判断路径是否命中读取拒止清单。
 * @param {string} target - 目标路径（调用方已解析为绝对路径）。
 * @returns {{denied: boolean, reason?: string}} 判定结果。
 */
export function isDeniedPath(target) {
  const normalized = target.replace(/\\/gu, '/');
  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  const basename = segments[segments.length - 1] ?? '';
  // 名称型清单在大小写不敏感的文件系统上必须同样不敏感，否则磁盘上的 SETTINGS.YAML 会漏过。
  const lowerBasename = basename.toLowerCase();
  for (const pattern of DENIED_BASENAMES) {
    if (pattern.test(lowerBasename)) return { denied: true, reason: `basename ${basename}` };
  }
  const dot = basename.lastIndexOf('.');
  if (dot > 0 && DENIED_EXTENSIONS.has(basename.slice(dot).toLowerCase())) {
    return { denied: true, reason: `extension ${basename.slice(dot)}` };
  }
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index].toLowerCase();
    if (!Object.hasOwn(DENIED_DIRECTORIES, segment)) continue;
    const expected = DENIED_DIRECTORIES[segment];
    if (expected === null) return { denied: true, reason: `directory ${segment}` };
    if (segments[index + 1]?.toLowerCase() === expected) {
      return { denied: true, reason: `file ${segment}/${expected}` };
    }
  }
  return { denied: false };
}

/**
 * 判定路径是否落在 DSH 数据根之内（design §3.4）：路径前缀围栏，不按目录名匹配——
 * 只看「是否在 home 根之下」，不看段名，工作区同名 `sessions` 目录不受影响。
 * 两个根都判：`DSH_HOME`（若设置）与默认 `~/.dsh`——操作者迁移 home 后旧目录仍在磁盘上，双根都拒。
 * 目标与根都取「字面＋真实路径」双形态比较：home 以 8.3 短名或符号链接／联结点（junction）拼写
 * 给出时按物理根拦截，别名拼写不能绕过；根下不存在的路径按字面形态对字面根命中，不要求文件在场。
 * 根不存在时没有 realpath，只有字面形态（与 checkDenied 的字面回退同一纪律）。
 * 每次判定现做 realpath、不缓存：DSH_HOME 可热改、联结点可重指向，围栏按当前文件系统逐次解析。
 * 误伤范围：`DSH_HOME` 指到工作区内部/其父目录属自伤配置，接受。
 * @param {string} real - 目标经 realpath 归一（或不存在时字面回退）的绝对路径。
 * @param {string} literal - 目标剥流后缀后的字面绝对路径。
 * @param {() => string} [dshHomeOf] - home 取法注入点（测试注入临时目录）。
 * @returns {Promise<{denied: boolean, reason?: string}>} 判定结果。
 */
async function dshHomeVerdict(real, literal, dshHomeOf = dshHome) {
  // 目标形态集：常态 realpath 与字面相同，集合退化为单形态。
  const targets = [...new Set([resolve(real), resolve(literal)].map((path) => path.toLowerCase()))];
  const roots = [];
  const primary = dshHomeOf();
  if (typeof primary === 'string' && primary.length > 0) roots.push(primary);
  const fallback = join(homedir(), '.dsh');
  if (!roots.some((root) => resolve(root).toLowerCase() === resolve(fallback).toLowerCase())) {
    roots.push(fallback);
  }
  // 大小写不敏感的前缀比较（Windows 文件系统语义）；每个根的字面与真实路径两形态都作围栏。
  const fences = new Set();
  for (const root of roots) {
    const literalRoot = resolve(root).toLowerCase();
    fences.add(literalRoot);
    try {
      const physicalRoot = (await realpath(resolve(root))).toLowerCase();
      if (physicalRoot !== literalRoot) fences.add(physicalRoot);
    } catch { /* 根 realpath 失败（典型为根不存在）：只有字面形态 */ }
  }
  for (const target of targets) {
    for (const fence of fences) {
      if (target === fence || target.startsWith(fence + sep) || target.startsWith(`${fence}/`)) {
        return { denied: true, reason: 'dsh-home' };
      }
    }
  }
  return { denied: false };
}

/**
 * 把 glob 模式编译成正则。支持 `**`、`*`、`?`；方括号按字面量转义，不解析字符类语法；
 * `/` 只作为路径分隔符。
 * @param {string} pattern - glob 模式。
 * @returns {RegExp} 匹配整个相对路径（`/` 分隔）的正则。
 */
export function globToRegExp(pattern) {
  const source = pattern.replace(/\\/gu, '/');
  let out = '^';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '*') {
      if (source[index + 1] === '*') {
        index += 1;
        if (source[index + 1] === '/') {
          index += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return new RegExp(`${out}$`, 'u');
}

/**
 * 判断 index 处是否开始一个量词（`*`/`+`/`?` 或合法 `{n,m}` 形态）。
 * 判据④的连跑计数用：原子带量词时计数由量词分支自增，原子分支只在前瞻到「无量化」时清零。
 * @param {string} source - 正则源串。
 * @param {number} index - 待判位置。
 * @returns {boolean} 是否量词起点。
 */
function isQuantifierAhead(source, index) {
  const char = source[index];
  if (char === undefined) return false;
  if (char === '*' || char === '+' || char === '?') return true;
  return char === '{' && /^\{\d+(,\d*)?\}/u.test(source.slice(index));
}

/**
 * 静态校验模型给出的 grep 正则（design §3.4）：拒止已知病态回溯形态——静态判据挡形态，
 * 工作者线程挡时长（通过检查的模式也不在主线程执行，超时与取消由 `terminate()` 强制生效）。
 * 分界：本函数只校验「模型 pattern」；deny/redact 配置（操作者自担）与 `globToRegExp` 的生成式
 * 翻译不套此校验——拒止操作者的 deny 规则会让防护静默失效，比病态回溯更危险；生成式匹配
 * 全程在工作者内执行，由线程终止机制承接时限。
 * 判据：①长度 ≤ `PATTERN_MAX_CHARS`；②量词作用于组、且组体内（含嵌套）出现过量词或 `|` → 拒止
 * （嵌套量词、`(a|a)*` 类歧义选择一并覆盖；前后视组按普通组归组；惰性量词与贪婪同形）；
 * ③反向引用 `\1`–`\9`（含 `\k<name>` 命名形式）→ 拒止；④相邻量词原子连跑达 `ADJACENT_QUANTIFIERS_LIMIT` → 拒止
 * （`a*a*a*a*b` 一类可变跨度紧邻堆叠；带量词原子由量词自增计数，无量化原子与零宽转义中断
 * 连跑；组边界与 `|` 透明——`a*(?:b*c*d*)e*` 与 `a*b*c*d*e` 同形归一；残余形态由工作者终止机制承接）。
 * @param {string} source - 正则源串。
 * @returns {string | undefined} 拒止理由；安全时返回 `undefined`。
 */
export function assertSafePattern(source) {
  if (source.length > PATTERN_MAX_CHARS) {
    return `pattern longer than ${PATTERN_MAX_CHARS} chars`;
  }
  /** 每个未闭合组的「复杂」标记：组内（含嵌套内容）出现过量词或 `|`。 */
  const complexStack = [];
  /**
   * 续算通道（与 complexStack 平行入栈）：无量化原子会中断连跑，但若它恰好是「即将被组量化」
   * 的组内末原子，该中断需在组闭处撤销——`(a)*(b)*(c)*(d)*` 与 `a*a*a*a*` 同级回溯（组的量化
   * 性＝末原子带量词），记下中断前的连跑值，`)` 后随量词时恢复，由量词分支正常自增。组开把
   * 组外待续算压栈：嵌套组的内组首原子不得覆写外层已捕获的组前连跑（`a*b*c*(?:d(?:e))*` 与
   * `a*b*c*(?:(?:d)e)*` 同语言同拦）；组闭未恢复时向外交接——更早的中断优先，替换的语义安全
   * 由量化组首原子的重捕获保证（消耗性恢复后链自组前真实连跑重新起算）。
   */
  const carryStack = [];
  let runBeforeAtomReset = 0;
  let atomResetCarry = false;
  let lastAtomWasGroup = false;
  let lastGroupComplex = false;
  let quantifiedRun = 0;
  const resetRunForAtom = () => {
    if (!atomResetCarry) runBeforeAtomReset = quantifiedRun;
    atomResetCarry = true;
    quantifiedRun = 0;
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\') {
      const next = source[index + 1];
      // 反向引用整类拒止（design §3.4 判据③）：数字形式 `\1`–`\9` 与命名形式 `\k<name>`。
      if ((next >= '1' && next <= '9') || next === 'k') return 'backreference';
      index += 1; // 消费反斜杠。
      // 多字符转义按语法整段消费为一个原子（`\xHH`、`\uHHHH`、`\u{...}`、`\cX`、`\p{…}`／`\P{…}`）：
      // 逐字符读会把 `\x41` 拆成幻影原子、把连跑逐次清零（`\x41*`×4 与 `A*`×4 同级回溯）。
      if (next === 'x') {
        for (let h = 0; h < 2 && /[0-9a-fA-F]/u.test(source[index + 1] ?? ''); h += 1) index += 1;
      } else if (next === 'u') {
        if (source[index + 1] === '{') {
          while (source[index + 1] !== '}' && index + 1 < source.length) index += 1;
          if (source[index + 1] === '}') index += 1;
        } else {
          for (let h = 0; h < 4 && /[0-9a-fA-F]/u.test(source[index + 1] ?? ''); h += 1) index += 1;
        }
      } else if (next === 'c') {
        if (/[A-Za-z]/u.test(source[index + 1] ?? '')) index += 1;
      } else if (next === 'p' || next === 'P') {
        if (source[index + 1] === '{') {
          while (source[index + 1] !== '}' && index + 1 < source.length) index += 1;
          if (source[index + 1] === '}') index += 1;
        } else if (source[index + 1] !== undefined) index += 1;
      }
      lastAtomWasGroup = false;
      // 转义原子带量词时保留连跑计数（量词分支自增）；无量化才中断。零宽断言按中断计，唯独
      // `\B` 例外：它是宽容零宽（对全部内部位置成立），不消除分割歧义——`a*a*a*\Ba*` 与
      // `a*a*a*a*` 的四段歧义同构，按不中断计（偏多拦口径）。
      if (!isQuantifierAhead(source, index + 1) && next !== 'B') resetRunForAtom();
      continue;
    }
    if (char === '[') {
      // 字符类：内含的 `|` 与量词都不参与归组，整段消费到未转义的 `]`。
      index += 1;
      while (index < source.length && source[index] !== ']') {
        if (source[index] === '\\') index += 1;
        index += 1;
      }
      lastAtomWasGroup = false;
      if (!isQuantifierAhead(source, index + 1)) resetRunForAtom(); // 字符类同理。
      continue;
    }
    if (char === '(') {
      // 捕获/非捕获/前后视组一律按普通组归组；组前缀字符（`?:`、`?=`、`?!`、`?<=`、`?<!`、`?<name>`）
      // 先消费掉——否则 `(?:ab)+` 的 `?` 会被当成量词把组误标成「复杂」，放行范围误收窄。
      // 组开边界透明：`a*(?:b*c*)` 与 `a*b*c*` 同形归一，连跑计数跨组继续。组开把组外待续算
      // 压栈、组内重新起算——组外无量化原子的中断是真实隔断（`a*b*c(x)*(y)*` 左右两段不相邻），
      // 不得被组闭恢复撤销；压栈值供组闭未恢复时按「更早者优先」交还给外层。
      complexStack.push(false);
      carryStack.push([runBeforeAtomReset, atomResetCarry]);
      lastAtomWasGroup = false;
      atomResetCarry = false;
      if (source[index + 1] === '?') {
        index += 2;
        const lead = source[index];
        if (lead === ':' || lead === '=' || lead === '!') {
          // 已消费到前缀末字符。
        } else if (lead === '<') {
          index += 1;
          const behind = source[index];
          if (behind === '=' || behind === '!') index += 1;
          else {
            while (index < source.length && /[A-Za-z0-9_]/u.test(source[index])) index += 1;
            if (source[index] === '>') index += 1;
          }
          index -= 1;
        } else {
          index -= 1; // 裸 `(?)`（u 旗标下编译报错）等形态不在此消费，交编译期报错拦下。
        }
      }
      continue;
    }
    if (char === ')') {
      const complex = complexStack.pop() ?? false;
      if (complexStack.length > 0 && complex) complexStack[complexStack.length - 1] = true;
      lastAtomWasGroup = true;
      lastGroupComplex = complex;
      // 组闭边界：无量化组等价于其内容原子（`(?:a*b*c*)d*` 与 `a*b*c*d*` 同形归一，连跑跨组继续）；
      // 量化组的量化性＝末原子带量词——末原子的中断在此撤销（恢复中断前连跑），由后随量词分支
      // 正常自增，`(a)*(b)*(c)*(d)*`、`(?:ab)+(?:cd)+(?:ef)+(?:gh)+` 与裸写四级连跑同拦。恢复后
      // 回到组开前的续算状态（外层自己的待续算不被本组消费）；未恢复（无后随量词）时向外交接：
      // 本组末原子的中断传递外承（嵌套量化组 `x*((a))*` 的恢复义务由外层组闭承接），组开前已有
      // 更早续算时保留更早的（其捕获的连跑上下文更大）。
      const outerCarry = carryStack.pop() ?? [0, false];
      if (atomResetCarry && isQuantifierAhead(source, index + 1)) {
        quantifiedRun = runBeforeAtomReset;
        runBeforeAtomReset = outerCarry[0];
        atomResetCarry = outerCarry[1];
      } else if (outerCarry[1]) {
        runBeforeAtomReset = outerCarry[0];
        atomResetCarry = true;
      }
      continue;
    }
    if (char === '|') {
      if (complexStack.length > 0) complexStack[complexStack.length - 1] = true;
      lastAtomWasGroup = false;
      atomResetCarry = false; // 分支边界：他分支的中断不带入本分支的组闭恢复。
      continue; // 选择边界透明：歧义选择由判据②归组，连跑计数跨分支继续。
    }
    if (char === '*' || char === '+' || char === '?') {
      // 惰性后缀（`*?`、`+?`、`??`）与贪婪同形，一并消费。
      if (source[index + 1] === '?') index += 1;
      if (lastAtomWasGroup && lastGroupComplex) return 'quantified complex group';
      if (complexStack.length > 0) complexStack[complexStack.length - 1] = true;
      lastAtomWasGroup = false;
      quantifiedRun += 1;
      if (quantifiedRun >= ADJACENT_QUANTIFIERS_LIMIT) return 'adjacent quantified atoms';
      continue;
    }
    if (char === '{') {
      // `{n,m}` 量词；非此形态按字面量消费（`u` 旗标下非法花括号在编译时报错，走 regexFail 路径）。
      const matched = /^\{\d+(,\d*)?\}/u.exec(source.slice(index));
      if (matched !== null) {
        index += matched[0].length - 1;
        if (source[index + 1] === '?') index += 1;
        if (lastAtomWasGroup && lastGroupComplex) return 'quantified complex group';
        if (complexStack.length > 0) complexStack[complexStack.length - 1] = true;
        lastAtomWasGroup = false;
        quantifiedRun += 1;
        if (quantifiedRun >= ADJACENT_QUANTIFIERS_LIMIT) return 'adjacent quantified atoms';
      } else {
        // 字面量花括号是消费性原子，中断连跑（续算通道同其他原子）。
        resetRunForAtom();
      }
      lastAtomWasGroup = false;
      continue;
    }
    lastAtomWasGroup = false;
    // 字面量字符（含 `.`）带量词时保留连跑计数（量词分支自增）；无量化才中断。
    if (!isQuantifierAhead(source, index + 1)) resetRunForAtom();
  }
  return undefined;
}

/**
 * 解析调用方给出的路径；相对路径以 `rootDir` 为基准。
 * @param {unknown} raw - 原始路径参数。
 * @param {string} rootDir - 默认工作目录。
 * @returns {string} 绝对路径。
 */
function resolveTarget(raw, rootDir) {
  if (typeof raw !== 'string' || raw.length === 0) return rootDir;
  return isAbsolute(raw) ? resolve(raw) : resolve(join(rootDir, raw));
}

/**
 * 按字节预算读取文件内容。
 * @param {string} path - 绝对路径。
 * @param {number} offset - 起始字节偏移。
 * @param {number} limit - 读取字节上限。
 * @returns {Promise<{text: string, bytes: number, truncated: boolean}>} 内容与统计。
 */
async function readSlice(path, offset, limit) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const truncated = bytesRead > limit;
    const text = buffer.subarray(0, Math.min(bytesRead, limit)).toString('utf8');
    return { text, bytes: Math.min(bytesRead, limit), truncated };
  } finally {
    await handle.close();
  }
}

/**
 * 有界目录遍历；不跟随符号链接，符号链接目录不进入。
 * @param {string} root - 起始目录。
 * @param {number} maxDirs - 目录数上限。
 * @param {(path: string, entry: import('node:fs').Dirent) => boolean} visit - 返回 `false` 停止遍历。
 * @returns {Promise<{scanned: number, stopped: boolean}>} 遍历统计。
 */
async function walk(root, maxDirs, visit) {
  const queue = [root];
  let scanned = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (scanned >= maxDirs) return { scanned, stopped: true };
    scanned += 1;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (visit(child, entry) === false) return { scanned, stopped: true };
      if (entry.isDirectory()) queue.push(child);
    }
  }
  return { scanned, stopped: false };
}

/** 四个只读工具的 JSON Schema 描述（en 档，与审查请求 `GenerateOptions.tools` 现状逐字相同）；双语正文由 agent-texts 唯一持有。 */
export const TOOL_SCHEMAS = agentT('en', 'tool.schemas');

/**
 * 创建只读工具集。
 * @param {object} [options] - 构造选项。
 * @param {string} [options.rootDir] - 相对路径的基准目录（通常为会话 cwd）。
 * @param {number} [options.timeoutMs] - 单次调用超时；超时按「无证据」处理。
 * @param {readonly string[]} [options.redactPatterns] - 工具结果脱敏清单。
 * @param {(fields: object) => void} [options.audit] - 每次调用的审计入口（不写文件内容）。
 * @returns {{schemas: readonly object[], run: (name: string, args: object, signal?: AbortSignal, context?: {rootDir?: string, lang?: string, toolTimeoutMs?: number, redactPatterns?: string[]}) => Promise<{text: string, isError: boolean, denied: boolean}>}}
 *   工具集；`run` 永不抛出（第 4 参＝请求绑定上下文；未传时按实例状态现读；前提＝注入的
 *   redact／audit 自身不抛——生产装配两者全程吞错）。
 */
export function createReadonlyTools(options = {}) {
  let rootDir = options.rootDir ?? process.cwd();
  // 模型侧文案语言（工具说明＋结果模板）实例基线（缺省 zh）；生产路径按请求快照传入，setter 为直测回退。
  let lang = options.lang === 'en' ? 'en' : 'zh';
  // 超时与脱敏清单是可变实例基线；`run` 未传上下文时现读（setter 直测路径），
  // 生产路径按请求快照传入——在飞任务不读实例状态，热改自下一次审查生效。
  let toolTimeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 5000;
  let redactPatterns = options.redactPatterns ?? [];
  // DSH 数据根取法注入点（默认与 reviewsDir 同源；测试注入临时目录）。
  const dshHomeOf = options.dshHomeOf ?? dshHome;
  const audit = options.audit ?? (() => {});
  const redactText = options.redact ?? ((text) => text);
  // 分发级测试注入点——注入真·慢任务以驱动真实超时；生产装配不传。
  const invokeOverride = options.invoke;
  /** 按指定语言取词并替换占位；语言缺省取实例状态（直测回退路径）。 */
  const T = (key, params, l = lang) => fmt(agentT(l, key), params);

  /**
   * 解析本次调用的生效上下文。
   * 未传 `context` 时按实例状态**现读**（setter 直测路径与既有语义不变）；
   * 传入时逐字段校验，非法或缺省字段回落实例状态——生产路径由 `rt.review` 在请求进入时
   * 构造完整快照，任务执行期间不读实例状态，并发下后到请求无法改写在飞任务的取证上下文。
   * @param {{rootDir?: string, lang?: string, toolTimeoutMs?: number, redactPatterns?: string[]} | undefined} context - 请求绑定上下文。
   * @returns {{rootDir: string, lang: string, toolTimeoutMs: number, redactPatterns: string[]}} 生效上下文。
   */
  function contextOf(context) {
    if (context === undefined || context === null) return { rootDir, lang, toolTimeoutMs, redactPatterns };
    return {
      rootDir: typeof context.rootDir === 'string' && context.rootDir.length > 0 ? context.rootDir : rootDir,
      lang: context.lang === 'en' || context.lang === 'zh' ? context.lang : lang,
      toolTimeoutMs: Number.isFinite(context.toolTimeoutMs) && context.toolTimeoutMs >= 0 ? context.toolTimeoutMs : toolTimeoutMs,
      redactPatterns: Array.isArray(context.redactPatterns) && context.redactPatterns.every((item) => typeof item === 'string')
        ? [...context.redactPatterns]
        : redactPatterns,
    };
  }

  /**
   * 执行一次工具调用并计时；异常与超时都转成错误结果，绝不外抛（注入的 redact／audit
   * 自身不抛为前提——生产装配两者全程吞错，测试替代注入需自守）。
   * @param {string} name - 工具名。
   * @param {object} args - 模型给出的参数。
   * @param {AbortSignal} [signal] - 审查请求的取消信号。
   * @param {{rootDir?: string, lang?: string, toolTimeoutMs?: number, redactPatterns?: string[]}} [context]
   *   - 请求绑定上下文：传入时基准目录/文案语言/超时/遮蔽清单按本请求执行，不受实例状态影响。
   * @returns {Promise<{text: string, isError: boolean, denied: boolean}>} 回喂给模型的文本。
   */
  async function run(name, args, signal, context) {
    const startedAt = Date.now();
    const pathArg = args?.path ?? args?.cwd ?? args?.file_path;
    const ctx = contextOf(context);
    let result;
    try {
      result = await withTimeout(() => invoke(name, args ?? {}, signal, ctx), ctx.toolTimeoutMs, signal, ctx.lang);
    } catch (error) {
      result = { text: T('tool.failed', { name, error: errorText(error) }, ctx.lang), isError: true, denied: false };
    }
    const text = redactText(result.text, ctx.redactPatterns);
    audit({
      phase: 'tool',
      tool: name,
      path: typeof pathArg === 'string' ? pathArg : '-',
      ms: Date.now() - startedAt,
      degraded: result.denied === true ? 'denied' : 'none',
      // 拒止命中类别随行写出（dsh-home / basename …），与凭据命中可区分。
      reason: `bytes=${Buffer.byteLength(text, 'utf8')} denied=${result.denied === true ? 'yes' : 'no'}${
        result.deniedReason !== undefined ? ` deny=${result.deniedReason}` : ''
      }`,
    });
    return { text, isError: result.isError === true, denied: result.denied === true };
  }

  /**
   * 分发到具体工具。
   * @param {string} name - 工具名。
   * @param {object} args - 参数。
   * @param {AbortSignal} [signal] - 取消信号。
   * @param {{rootDir: string, lang: string}} ctx - 本次调用生效上下文。
   * @returns {Promise<{text: string, isError: boolean, denied: boolean}>} 结果。
   */
  async function invoke(name, args, signal, ctx) {
    // options.invoke 覆盖分发本身：测试注入点（超时用例需要一个真·慢任务，不得用「已中止」冒充），生产装配不传。
    if (invokeOverride !== undefined) return invokeOverride(name, args, signal);
    switch (name) {
      case 'read_file':
        return runReadFile(args, ctx);
      case 'list_dir':
        return runListDir(args, ctx);
      case 'glob':
        return runGlob(args, signal, ctx);
      case 'grep':
        return runGrep(args, signal, ctx);
      default:
        return { text: T('tool.unknown', { name }, ctx.lang), isError: true, denied: false };
    }
  }

  /**
   * 剥离 NTFS 备用数据流后缀（`file.txt:stream` / `file.txt::$DATA`）。
   * 不剥离时，按 basename 的拒止规则会被 `settings.yaml::$DATA` 这类写法绕过。
   * @param {string} resolved - 已解析为绝对路径的路径。
   * @returns {string} 去掉流后缀的路径。
   */
  function stripAlternateStream(resolved) {
    const match = /^([a-zA-Z]:[\\/][^:]*?):[^\\/]*$/u.exec(resolved);
    return match === null ? resolved : match[1];
  }

  /**
   * 判定一个路径是否命中读取拒止清单（统一入口）。
   * 先拒 UNC/设备命名空间，再剥流后缀，再做 realpath 归一化（不存在的路径按字面判定，
   * 不能用「不存在」绕过拒止清单），最后查 DSH 数据根围栏与名称清单。
   * 围栏两侧同口径：目标与 home 根都取字面与真实路径双形态（见 dshHomeVerdict）；
   * 大小写差异由两侧小写比较吸收，别名拼写（符号链接、8.3 短名）经真实路径归一后命中。
   * @param {string} raw - 目标路径（可相对）。
   * @param {string} [rootDirOf] - 相对路径基准（缺省实例状态；请求绑定路径传 ctx.rootDir）。
   * @returns {Promise<{denied: boolean, reason?: string, path: string}>} 判定结果与用于读取的路径。
   */
  async function checkDenied(raw, rootDirOf = rootDir) {
    const resolved = resolveTarget(raw, rootDirOf);
    if (/^[\\/]{2}/u.test(resolved)) {
      return { denied: true, reason: 'UNC 或设备路径', path: resolved };
    }
    const stripped = stripAlternateStream(resolved);
    let real = stripped;
    try {
      real = await realpath(stripped);
    } catch {
      // 不存在的路径没有 realpath；按字面路径判定，避免用「不存在」绕过拒止清单。
      real = stripped;
    }
    // DSH 数据根围栏先于名称清单——sessions、approve-for-me/reviews、current-url.txt
    // 都在 home 前缀内自动覆盖，不逐名枚举（home 内后续新增的文件同样落在围栏内）。
    const fence = await dshHomeVerdict(real, stripped, dshHomeOf);
    if (fence.denied) return { denied: true, reason: fence.reason, path: resolved };
    const verdict = isDeniedPath(real);
    return { denied: verdict.denied, reason: verdict.reason, path: resolved };
  }

  /**
   * 解析并校验目标路径；命中拒止清单直接返回错误结果。
   * @param {unknown} raw - 原始路径。
   * @returns {Promise<{path?: string, denied: boolean, result?: object}>} 解析结果。
   */
  async function guard(raw, ctx) {
    const t = (key, params) => T(key, params, ctx.lang);
    if (typeof raw !== 'string' || raw.length === 0) {
      return { denied: false, result: { text: t('tool.missingPath'), isError: true, denied: false } };
    }
    const verdict = await checkDenied(raw, ctx.rootDir);
    if (verdict.denied) {
      return {
        denied: true,
        result: {
          text: t(verdict.reason === 'dsh-home' ? 'tool.deniedDsh' : 'tool.deniedRead', {
            path: raw,
            reason: verdict.reason,
          }),
          isError: true,
          denied: true,
          deniedReason: verdict.reason,
        },
      };
    }
    return { path: verdict.path, denied: false };
  }

  /** `read_file` 实现。 */
  async function runReadFile(args, ctx) {
    const t = (key, params) => T(key, params, ctx.lang);
    const guarded = await guard(args.path, ctx);
    if (guarded.result !== undefined) return guarded.result;
    const offset = Number.isFinite(args.offset) && args.offset >= 0 ? Math.floor(args.offset) : 0;
    const explicitLimit = Number.isFinite(args.limit) && args.limit > 0;
    const limit = explicitLimit ? Math.min(Math.floor(args.limit), READ_MAX_BYTES) : READ_MAX_BYTES;
    const info = await stat(guarded.path);
    if (info.isDirectory()) return { text: t('tool.isDir', { path: args.path }), isError: true, denied: false };
    const slice = await readSlice(guarded.path, offset, limit);
    // 分页读取是调用方的显式意图，不视为超限；只有触到 64 KiB 上限才标截断。
    const hitCap = !explicitLimit || args.limit > READ_MAX_BYTES;
    const suffix = slice.truncated && hitCap
      ? `\n<truncated omitted_approx_tokens="${Math.ceil(Math.max(0, info.size - offset - limit) / 4)}" />`
      : '';
    return { text: `${slice.text}${suffix}`, isError: false, denied: false };
  }

  /** `list_dir` 实现。 */
  async function runListDir(args, ctx) {
    const t = (key, params) => T(key, params, ctx.lang);
    const guarded = await guard(args.path, ctx);
    if (guarded.result !== undefined) return guarded.result;
    const entries = await readdir(guarded.path, { withFileTypes: true });
    const shown = entries.slice(0, LIST_MAX_ENTRIES);
    const lines = shown.map((entry) => {
      const kind = entry.isDirectory() ? 'dir ' : entry.isSymbolicLink() ? 'link' : 'file';
      return `${kind}\t${entry.name}`;
    });
    if (entries.length > shown.length) {
      // `<truncated ... />` 标记是不变块，后缀计数文案随语言。
      lines.push(`<truncated omitted_approx_tokens="0" />${t('tool.truncatedDirSuffix', { n: entries.length })}`);
    }
    return { text: lines.join('\n'), isError: false, denied: false };
  }

  /** `glob` 实现。 */
  async function runGlob(args, signal, ctx) {
    const t = (key, params) => T(key, params, ctx.lang);
    if (typeof args.pattern !== 'string' || args.pattern.length === 0) {
      return { text: t('tool.missingPattern'), isError: true, denied: false };
    }
    const base = resolveTarget(args.cwd, ctx.rootDir);
    const baseVerdict = await checkDenied(base, ctx.rootDir);
    if (baseVerdict.denied) {
      return {
        text: t(baseVerdict.reason === 'dsh-home' ? 'tool.deniedDsh' : 'tool.deniedList', {
          path: args.cwd ?? base,
          reason: baseVerdict.reason,
        }),
        isError: true,
        denied: true,
        deniedReason: baseVerdict.reason,
      };
    }
    // 匹配式在工作者线程执行（design §3.4）：glob 模式经 `globToRegExp` 生成的正则同样可能
    // 病态回溯（`*a*a*a*a*b` 一类），主线程只负责遍历收集与拒止路径检查。
    const matcher = globToRegExp(args.pattern);
    const paths = [];
    const walkResult = await walk(base, WALK_MAX_DIRS, (child, entry) => {
      if (signal?.aborted === true) return false;
      if (!entry.isFile()) return true;
      if (paths.length >= GLOB_MAX_RAW_PATHS) return false;
      paths.push({ rel: relative(base, child).split(sep).join('/'), abs: child });
      return true;
    });
    if (signal?.aborted === true) return { text: t('tool.cancelled'), isError: true, denied: false };
    // 路径批次整批送工作者判定（收集上限 2× 命中上限：主线程还要过一遍拒止清单才会满额）。
    const workerResult = await runInRegexWorker(
      { kind: 'glob', matcherSource: matcher.source, paths, maxMatches: GLOB_MAX_ENTRIES * 2 },
      ctx.toolTimeoutMs,
      signal,
    );
    if (workerResult.ok !== true) {
      return workerResult.kind === 'timeout'
        ? { text: t('tool.timeout', { ms: ctx.toolTimeoutMs }), isError: true, denied: false }
        : workerResult.kind === 'cancelled'
          ? { text: t('tool.cancelled'), isError: true, denied: false }
          : { text: t('tool.workerFail', { error: workerResult.message }), isError: true, denied: false };
    }
    // 逐个过拒止清单：收集期不做拒止检查（异步 checkDenied 放不进同步遍历回调），匹配
    // 结果回来后才过滤——列出凭据文件名本身也是外泄，过滤必须在呈现前完成。
    const matches = [];
    for (const item of workerResult.matched) {
      if (matches.length >= GLOB_MAX_ENTRIES) break;
      const verdict = await checkDenied(item.abs, ctx.rootDir);
      if (verdict.denied) continue;
      matches.push(item.abs);
    }
    const suffix = matches.length >= GLOB_MAX_ENTRIES
      ? `\n${t('tool.firstNEntries', { n: GLOB_MAX_ENTRIES })}`
      : walkResult.stopped
        ? `\n${t('tool.walkLimit')}`
        : '';
    return { text: `${matches.join('\n')}${suffix}`, isError: false, denied: false };
  }

  /** `grep` 实现。 */
  async function runGrep(args, signal, ctx) {
    const t = (key, params) => T(key, params, ctx.lang);
    if (typeof args.pattern !== 'string' || args.pattern.length === 0) {
      return { text: t('tool.missingPattern'), isError: true, denied: false };
    }
    // 模型 pattern 先过静态安全校验——嵌套量词、歧义选择、反向引用与相邻量词原子连跑直接
    // 回喂错误文本，模型可改写重试；通过检查的模式同样不在主线程执行（design §3.4）——
    // 静态判据挡形态、工作者线程挡时长，主事件循环不承担任何模型正则的回溯计算。
    const unsafe = assertSafePattern(args.pattern);
    if (unsafe !== undefined) {
      return { text: t('tool.unsafePattern', { reason: unsafe }), isError: true, denied: false };
    }
    try {
      new RegExp(args.pattern, 'u');
    } catch (error) {
      // 正则编译失败是模型参数错误，直接回喂错误文本，不静默按无匹配处理。
      return { text: t('tool.regexFail', { error: errorText(error) }), isError: true, denied: false };
    }
    const maxMatches = Number.isFinite(args.maxMatches) && args.maxMatches > 0
      ? Math.min(Math.floor(args.maxMatches), GREP_MAX_MATCHES)
      : GREP_MAX_MATCHES;
    const targetVerdict = await checkDenied(args.path, ctx.rootDir);
    if (targetVerdict.denied) {
      return {
        text: t(targetVerdict.reason === 'dsh-home' ? 'tool.deniedDsh' : 'tool.deniedGrep', {
          path: args.path,
          reason: targetVerdict.reason,
        }),
        isError: true,
        denied: true,
        deniedReason: targetVerdict.reason,
      };
    }
    const target = targetVerdict.path;
    const filter = typeof args.glob === 'string' && args.glob.length > 0 ? globToRegExp(args.glob) : undefined;
    let info;
    try {
      info = await stat(target);
    } catch (error) {
      return { text: t('tool.inaccessible', { path: args.path, error: errorText(error) }), isError: true, denied: false };
    }
    // 候选收集在主线程（异步遍历、可中止、有目录数与原始量上限）；拒止路径检查也在主线程
    // 完成——工作者只接收通过检查的路径（design §3.4 分工）。单文件目标不过 glob 过滤。
    let files = [];
    let rawCapped = false;
    if (info.isFile()) {
      files.push({ rel: '', abs: target });
    } else {
      const raw = [];
      await walk(target, WALK_MAX_DIRS, (child, entry) => {
        if (signal?.aborted === true) return false;
        if (!entry.isFile()) return true;
        if (raw.length >= GREP_MAX_RAW_CANDIDATES) {
          rawCapped = true;
          return false;
        }
        raw.push({ rel: relative(target, child).split(sep).join('/'), abs: child });
        return true;
      });
      files = [];
      for (const file of raw) {
        if (signal?.aborted === true) break;
        const guarded = await checkDenied(file.abs, ctx.rootDir);
        if (!guarded.denied) files.push(file);
      }
    }
    if (signal?.aborted === true) return { text: t('tool.cancelled'), isError: true, denied: false };
    // stat 预检、读取、glob 过滤与逐行匹配整批在工作者内执行；过滤后候选达上限、命中满额、
    // 超阈值文件与超长行都由工作者计数回传，主线程只拼结果尾部说明。
    const workerResult = await runInRegexWorker(
      {
        kind: 'grep',
        pattern: args.pattern,
        filterSource: filter !== undefined && !info.isFile() ? filter.source : undefined,
        files,
        maxMatches,
        maxCandidates: GREP_MAX_CANDIDATES,
        maxFileBytes: GREP_MAX_FILE_BYTES,
        maxLineChars: GREP_MAX_LINE_CHARS,
      },
      ctx.toolTimeoutMs,
      signal,
    );
    if (workerResult.ok !== true) {
      return workerResult.kind === 'timeout'
        ? { text: t('tool.timeout', { ms: ctx.toolTimeoutMs }), isError: true, denied: false }
        : workerResult.kind === 'cancelled'
          ? { text: t('tool.cancelled'), isError: true, denied: false }
          : { text: t('tool.workerFail', { error: workerResult.message }), isError: true, denied: false };
    }
    const hits = workerResult.hits;
    const suffixParts = [];
    if (hits.length >= maxMatches) suffixParts.push(t('tool.firstNMatches', { n: maxMatches }));
    if (workerResult.skippedLarge > 0) suffixParts.push(t('tool.grepSkippedLarge', { n: workerResult.skippedLarge }));
    if (workerResult.skippedLong > 0) {
      suffixParts.push(t('tool.grepSkippedLong', { n: workerResult.skippedLong, max: GREP_MAX_LINE_CHARS }));
    }
    // 截断说明按实际触发的上限取值：过滤后候选上限（200）或原始收集上限（2000）。
    const cappedAt = workerResult.capped
      ? GREP_MAX_CANDIDATES
      : rawCapped
        ? GREP_MAX_RAW_CANDIDATES
        : 0;
    if (cappedAt > 0) suffixParts.push(t('tool.grepTruncated', { n: cappedAt }));
    const suffix = suffixParts.length > 0 ? `\n${suffixParts.join('\n')}` : '';
    return { text: `${hits.join('\n')}${suffix}`, isError: false, denied: false };
  }

  return {
    /** 按当前语言取工具 Schema（实例回退基线；生产路径经门面按请求语言现取，不经本 getter）。 */
    get schemas() {
      return agentT(lang, 'tool.schemas');
    },
    run,
    /**
     * 切换相对路径的基准目录（实例回退基线；生产路径按请求快照传入，不经本 setter）。
     * @param {string} next - 新的基准目录。
     * @returns {void}
     */
    setRoot(next) {
      if (typeof next === 'string' && next.length > 0) rootDir = next;
    },
    /**
     * 切换模型侧文案语言（工具说明＋结果模板）；实例回退基线，生产路径按请求快照传入。
     * @param {string} next - 语言（AGENT_LANGS 之一）。
     * @returns {void}
     */
    setLang(next) {
      if (next === 'en' || next === 'zh') lang = next;
    },
    /**
     * 切换单工具超时；热改 setter＋实例回退基线（生产路径按请求快照传入）。
     * @param {number} next - 新的超时毫秒；有限非负数才生效（0＝立即超时，与 `reviewer.timeoutMs` 同语义）。
     * @returns {void}
     */
    setToolTimeoutMs(next) {
      if (Number.isFinite(next) && next >= 0) toolTimeoutMs = next;
    },
    /**
     * 切换脱敏清单；三路同口径的实例回退基线（生产路径按请求快照传入）。
     * @param {string[]} next - 新的模式数组；字符串数组才生效。
     * @returns {void}
     */
    setRedactPatterns(next) {
      if (Array.isArray(next) && next.every((item) => typeof item === 'string')) redactPatterns = next;
    },
  };
}

/**
 * 在正则工作者线程执行一批匹配（design §3.4）：模型输入派生的正则不在主线程执行，病态回溯
 * 只烧工作者线程，主事件循环保持响应；单工具时限到点或请求取消时 `terminate()` 强制结束——
 * 同步匹配无法被打断，终止线程是唯一真实生效的时限手段。工作者随调用创建、收尾即终止
 * （无复用、无泄漏）；无法创建或异常退出按失败类别返回，由调用方转成工具错误结果（模型可改写重试）。
 * @param {object} payload - 工作者任务（`workerData` 直传：grep 候选与模式源串 / glob 路径批次）。
 * @param {number} timeoutMs - 单工具时限（毫秒；调用点保证 >0，0 值不会进到本函数）。
 * @param {AbortSignal} [signal] - 请求取消信号。
 * @returns {Promise<object>} 工作者结果（`{ok:true, …}`）或失败类别
 *   （`{ok:false, kind:'timeout'|'cancelled'|'error', message}`）。
 */
function runInRegexWorker(payload, timeoutMs, signal) {
  return new Promise((resolvePromise) => {
    let worker;
    try {
      // execArgv 清空：工作者只跑 stdlib 正则匹配，不继承宿主的 --import/--require 注入链，
      // 在干净线程加载（宿主钩子在工作者内没有对应服务，继承反而可能加载失败）。
      worker = new Worker(REGEX_WORKER_URL, { workerData: payload, execArgv: [] });
    } catch (error) {
      resolvePromise({ ok: false, kind: 'error', message: errorText(error) });
      return;
    }
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal !== undefined && signal !== null) {
        try {
          signal.removeEventListener('abort', onAbort);
        } catch {
          // 摘除失败不改变已定的结束路径。
        }
      }
      worker.terminate();
      resolvePromise(value);
    };
    const onAbort = () => finish({ ok: false, kind: 'cancelled', message: 'cancelled' });
    worker.on('message', (message) => {
      if (message?.ok === true) finish({ ok: true, ...message });
      else finish({ ok: false, kind: 'error', message: message?.error ?? 'worker failure' });
    });
    worker.on('error', (error) => finish({ ok: false, kind: 'error', message: errorText(error) }));
    worker.on('exit', () => finish({ ok: false, kind: 'error', message: 'worker exited without result' }));
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => finish({ ok: false, kind: 'timeout', message: String(timeoutMs) }), timeoutMs);
    }
    if (signal !== undefined && signal !== null) {
      try {
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted === true) onAbort();
      } catch {
        // 信号不可监听时只保留超时与消息两条结束路径。
      }
    }
  });
}

/**
 * 给一次工具调用套上超时与取消。
 * @param {() => Promise<object>} task - 实际调用。
 * @param {number} timeoutMs - 超时毫秒；0＝立即超时（该次调用立即按超时返回失败说明，requirements §4.2）；负数或非有限数按 0 处理。
 * @param {AbortSignal} [signal] - 外部取消。
 * @returns {Promise<object>} 结果。
 */
function withTimeout(task, timeoutMs, signal, lang) {
  const textsLang = lang === 'en' ? 'en' : 'zh';
  const effectiveMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0;
  // 零值＝立即超时（requirements §4.2）：不发起 task——同步校验失败或亚毫秒完成的调用
  // 也不得赢得竞速；同时先查外部取消（已取消按取消语义返回）。
  if (effectiveMs <= 0) {
    if (signal?.aborted === true) return Promise.reject(new Error(agentT(textsLang, 'tool.cancelled')));
    return Promise.reject(new Error(fmt(agentT(textsLang, 'tool.timeout'), { ms: effectiveMs })));
  }
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(rejectPromise, new Error(agentT(textsLang, 'tool.cancelled')));
    const timer = setTimeout(
      () => finish(rejectPromise, new Error(fmt(agentT(textsLang, 'tool.timeout'), { ms: effectiveMs }))),
      effectiveMs,
    );
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted === true) finish(rejectPromise, new Error(agentT(textsLang, 'tool.cancelled')));
    task().then((value) => finish(resolvePromise, value), (error) => finish(rejectPromise, error));
  });
}

/**
 * 把任意异常转成一行文本。
 * @param {unknown} error - 捕获值。
 * @returns {string} 文本。
 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
