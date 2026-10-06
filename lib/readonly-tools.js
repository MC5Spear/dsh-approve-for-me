/**
 * dsh-approve-for-me — 审查器专用只读工具集。
 *
 * 四个工具全部基于 `node:fs` 的只读 API 实现：不经工具注册表、不触发审批、不派生进程、不联网。
 * 只读性由构造保证——本文件只出现 `open(path,'r')`、`readdir`、`stat`、`lstat`、`realpath`、`readFile`。
 * 审查器在无人工通道时若拿不到证据会倾向误拒，故工具必须能读工作区外的路径（升权目标多在工作区外）。
 * @module dsh-approve-for-me/readonly-tools
 */
import { open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { agentT } from './agent-texts.js';

/**
 * DSH 数据根目录（R33）：`DSH_HOME` 优先、缺省回落 `~/.dsh`——与本插件 reviews 目录同一解析口径
 * （lib/index.js 的 reviewsDir）；拒止围栏与自身落盘必须同源，自己写在哪就拒读到哪。
 * @returns {string} home 根。
 */
export function dshHome() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  return configured.length > 0 ? configured : join(homedir(), '.dsh');
}

/** 取词并做 `{param}` 占位替换（R28：模型侧文案全部来自 agent-texts 字典）。 */
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
/** `grep` 单行保留的字符数。 */
export const GREP_MAX_LINE_CHARS = 500;
/** grep 源串长度上限（R32）：取证用正则远短于此，超限直接判不安全。 */
export const PATTERN_MAX_CHARS = 256;
/** grep 单文件字节上限（R32）：超过即跳过并在结果里说明，不整读进内存。 */
export const GREP_MAX_FILE_BYTES = 1024 * 1024;
/** grep 候选文件数上限（R32）：一次取证合理的文件数，达上限即停止收集。 */
export const GREP_MAX_CANDIDATES = 200;
/** 单次遍历的目录数上限，防止在巨大目录树上打转。 */
const WALK_MAX_DIRS = 4000;

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
 * 判定路径是否落在 DSH 数据根之内（R33；设计 §22.3）：路径前缀围栏，不按目录名匹配——
 * 只看「是否在 home 根之下」，不看段名，工作区同名 `sessions` 目录不受影响。
 * 两个根都判：`DSH_HOME`（若设置）与默认 `~/.dsh`——操作者迁移 home 后旧目录仍在磁盘上，双根都拒。
 * 误伤面：`DSH_HOME` 指到工作区内部/其父目录属自伤配置，接受。
 * @param {string} real - 已归一（realpath 或字面）的绝对路径。
 * @param {() => string} [dshHomeOf] - home 取法注入点（测试注入临时目录）。
 * @returns {{denied: boolean, reason?: string}} 判定结果。
 */
function dshHomeVerdict(real, dshHomeOf = dshHome) {
  const target = resolve(real).toLowerCase();
  const roots = [];
  const primary = dshHomeOf();
  if (typeof primary === 'string' && primary.length > 0) roots.push(primary);
  const fallback = join(homedir(), '.dsh');
  if (!roots.some((root) => resolve(root).toLowerCase() === resolve(fallback).toLowerCase())) {
    roots.push(fallback);
  }
  for (const root of roots) {
    const fence = resolve(root).toLowerCase();
    // 大小写不敏感的前缀比较（Windows 文件系统语义）；两路径先 resolve 归一。
    if (target === fence || target.startsWith(fence + sep) || target.startsWith(`${fence}/`)) {
      return { denied: true, reason: 'dsh-home' };
    }
  }
  return { denied: false };
}

/**
 * 把 glob 模式编译成正则。支持 `**`、`*`、`?` 与字符类；`/` 只作为路径分隔符。
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
 * 静态校验模型给出的 grep 正则（R32；设计 §22.2）：拒止病态回溯形态，剩余形态在
 * `GREP_MAX_LINE_CHARS` 行长内是最坏 O(行长×模式长) 的多项式——确定性上界，优于杀掉后无结论的墙上时钟硬杀。
 * 分界：本函数只校验「模型 pattern」；deny/redact 配置（操作者自担）与 `globToRegExp` 的生成式翻译
 * 不套此校验——拒止操作者的 deny 规则会让防护静默失效，比病态回溯更危险。
 * 判据：①长度 ≤ `PATTERN_MAX_CHARS`；②量词作用于组、且组体内（含嵌套）出现过量词或 `|` → 拒止
 * （嵌套量词、`(a|a)*` 类歧义选择一并覆盖；前后视组按普通组归组；惰性量词与贪婪同形）；③反向引用 `\1`–`\9` → 拒止。
 * @param {string} source - 正则源串。
 * @returns {string | undefined} 拒止理由；安全时返回 `undefined`。
 */
export function assertSafePattern(source) {
  if (source.length > PATTERN_MAX_CHARS) {
    return `pattern longer than ${PATTERN_MAX_CHARS} chars`;
  }
  /** 每个未闭合组的「复杂」标记：组内（含嵌套内容）出现过量词或 `|`。 */
  const complexStack = [];
  let lastAtomWasGroup = false;
  let lastGroupComplex = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\') {
      const next = source[index + 1];
      if (next >= '1' && next <= '9') return 'backreference';
      index += 1; // 跳过转义字面量（\d、\b、\( 一类）。
      lastAtomWasGroup = false;
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
      continue;
    }
    if (char === '(') {
      // 捕获/非捕获/前后视组一律按普通组归组；组前缀字符（`?:`、`?=`、`?!`、`?<=`、`?<!`、`?<name>`）
      // 先消费掉——否则 `(?:ab)+` 的 `?` 会被当成量词把组误标成「复杂」，放行面误收窄。
      complexStack.push(false);
      lastAtomWasGroup = false;
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
          index -= 1; // 裸 `(?)`（u 旗标下编译报错）等形态不在此消费，交编译期兜底。
        }
      }
      continue;
    }
    if (char === ')') {
      const complex = complexStack.pop() ?? false;
      if (complexStack.length > 0 && complex) complexStack[complexStack.length - 1] = true;
      lastAtomWasGroup = true;
      lastGroupComplex = complex;
      continue;
    }
    if (char === '|') {
      if (complexStack.length > 0) complexStack[complexStack.length - 1] = true;
      lastAtomWasGroup = false;
      continue;
    }
    if (char === '*' || char === '+' || char === '?') {
      // 惰性后缀（`*?`、`+?`、`??`）与贪婪同形，一并消费。
      if (source[index + 1] === '?') index += 1;
      if (lastAtomWasGroup && lastGroupComplex) return 'quantified complex group';
      if (complexStack.length > 0) complexStack[complexStack.length - 1] = true;
      lastAtomWasGroup = false;
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
      }
      lastAtomWasGroup = false;
      continue;
    }
    lastAtomWasGroup = false;
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
 * @returns {{schemas: readonly object[], run: (name: string, args: object, signal?: AbortSignal) => Promise<{text: string, isError: boolean, denied: boolean}>}}
 *   工具集；`run` 永不抛出。
 */
export function createReadonlyTools(options = {}) {
  let rootDir = options.rootDir ?? process.cwd();
  // R28：模型侧文案语言（工具说明＋结果模板）；每次审查前由宿主接 `setLang` 现设（方向＝agentLangOf），缺省 zh。
  let lang = options.lang === 'en' ? 'en' : 'zh';
  // R36：超时与脱敏清单改为可变状态＋setter——构造期快照会让热改失效，`run` 每次现读。
  let toolTimeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 5000;
  let redactPatterns = options.redactPatterns ?? [];
  // R33：DSH 数据根取法注入点（默认与 reviewsDir 同源；测试注入临时目录）。
  const dshHomeOf = options.dshHomeOf ?? dshHome;
  const audit = options.audit ?? (() => {});
  const redactText = options.redact ?? ((text) => text);
  // R43：分发级测试注入点——注入真·慢任务以驱动真实超时；生产装配不传。
  const invokeOverride = options.invoke;
  /** 按当前语言取词并替换占位。 */
  const T = (key, params) => fmt(agentT(lang, key), params);

  /**
   * 执行一次工具调用并计时；异常与超时都转成错误结果，绝不外抛。
   * @param {string} name - 工具名。
   * @param {object} args - 模型给出的参数。
   * @param {AbortSignal} [signal] - 审查请求的取消信号。
   * @returns {Promise<{text: string, isError: boolean, denied: boolean}>} 回喂给模型的文本。
   */
  async function run(name, args, signal) {
    const startedAt = Date.now();
    const pathArg = args?.path ?? args?.cwd ?? args?.file_path;
    let result;
    try {
      result = await withTimeout(() => invoke(name, args ?? {}, signal), toolTimeoutMs, signal, lang);
    } catch (error) {
      result = { text: T('tool.failed', { name, error: errorText(error) }), isError: true, denied: false };
    }
    const text = redactText(result.text, redactPatterns);
    audit({
      phase: 'tool',
      tool: name,
      path: typeof pathArg === 'string' ? pathArg : '-',
      ms: Date.now() - startedAt,
      degraded: result.denied === true ? 'denied' : 'none',
      // R33：拒止命中类别随行写出（dsh-home / basename …），与凭据命中可区分。
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
   * @returns {Promise<{text: string, isError: boolean, denied: boolean}>} 结果。
   */
  async function invoke(name, args, signal) {
    // options.invoke 覆盖分发本身：测试注入点（R43——超时用例需要一个真·慢任务，不得用「已中止」冒充），生产装配不传。
    if (invokeOverride !== undefined) return invokeOverride(name, args, signal);
    switch (name) {
      case 'read_file':
        return runReadFile(args);
      case 'list_dir':
        return runListDir(args);
      case 'glob':
        return runGlob(args, signal);
      case 'grep':
        return runGrep(args, signal);
      default:
        return { text: T('tool.unknown', { name }), isError: true, denied: false };
    }
  }

  /**
   * 解析并校验目标路径；命中拒止清单直接返回错误结果。
   * @param {unknown} raw - 原始路径。
   * @returns {Promise<{path?: string, denied: boolean, result?: object}>} 解析结果。
   */
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
   * 先拒 UNC/设备命名空间，再剥流后缀，再做 realpath 归一化，最后查清单与 DSH 数据根围栏。
   * 归一化是关键：大小写变体与符号链接只有在解析到真实路径后才会命中 basename 规则。
   * @param {string} raw - 目标路径（可相对）。
   * @returns {Promise<{denied: boolean, reason?: string, path: string}>} 判定结果与用于读取的路径。
   */
  async function checkDenied(raw) {
    const resolved = resolveTarget(raw, rootDir);
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
    // R33：DSH 数据根围栏先于名称清单——sessions、approve-for-me/reviews、current-url.txt
    // 都在 home 前缀内自动覆盖，不逐名枚举（未来 home 内新增敏感文件同样被围住）。
    const fence = dshHomeVerdict(real, dshHomeOf);
    if (fence.denied) return { denied: true, reason: fence.reason, path: resolved };
    const verdict = isDeniedPath(real);
    return { denied: verdict.denied, reason: verdict.reason, path: resolved };
  }

  async function guard(raw) {
    if (typeof raw !== 'string' || raw.length === 0) {
      return { denied: false, result: { text: T('tool.missingPath'), isError: true, denied: false } };
    }
    const verdict = await checkDenied(raw);
    if (verdict.denied) {
      return {
        denied: true,
        result: {
          text: T(verdict.reason === 'dsh-home' ? 'tool.deniedDsh' : 'tool.deniedRead', {
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
  async function runReadFile(args) {
    const guarded = await guard(args.path);
    if (guarded.result !== undefined) return guarded.result;
    const offset = Number.isFinite(args.offset) && args.offset >= 0 ? Math.floor(args.offset) : 0;
    const explicitLimit = Number.isFinite(args.limit) && args.limit > 0;
    const limit = explicitLimit ? Math.min(Math.floor(args.limit), READ_MAX_BYTES) : READ_MAX_BYTES;
    const info = await stat(guarded.path);
    if (info.isDirectory()) return { text: T('tool.isDir', { path: args.path }), isError: true, denied: false };
    const slice = await readSlice(guarded.path, offset, limit);
    // 分页读取是调用方的显式意图，不视为超限；只有触到 64 KiB 上限才标截断。
    const hitCap = !explicitLimit || args.limit > READ_MAX_BYTES;
    const suffix = slice.truncated && hitCap
      ? `\n<truncated omitted_approx_tokens="${Math.ceil(Math.max(0, info.size - offset - limit) / 4)}" />`
      : '';
    return { text: `${slice.text}${suffix}`, isError: false, denied: false };
  }

  /** `list_dir` 实现。 */
  async function runListDir(args) {
    const guarded = await guard(args.path);
    if (guarded.result !== undefined) return guarded.result;
    const entries = await readdir(guarded.path, { withFileTypes: true });
    const shown = entries.slice(0, LIST_MAX_ENTRIES);
    const lines = shown.map((entry) => {
      const kind = entry.isDirectory() ? 'dir ' : entry.isSymbolicLink() ? 'link' : 'file';
      return `${kind}\t${entry.name}`;
    });
    if (entries.length > shown.length) {
      // `<truncated ... />` 标记是不变块，后缀计数文案随语言（R28）。
      lines.push(`<truncated omitted_approx_tokens="0" />${T('tool.truncatedDirSuffix', { n: entries.length })}`);
    }
    return { text: lines.join('\n'), isError: false, denied: false };
  }

  /** `glob` 实现。 */
  async function runGlob(args, signal) {
    if (typeof args.pattern !== 'string' || args.pattern.length === 0) {
      return { text: T('tool.missingPattern'), isError: true, denied: false };
    }
    const base = resolveTarget(args.cwd, rootDir);
    const baseVerdict = await checkDenied(base);
    if (baseVerdict.denied) {
      return {
        text: T(baseVerdict.reason === 'dsh-home' ? 'tool.deniedDsh' : 'tool.deniedList', {
          path: args.cwd ?? base,
          reason: baseVerdict.reason,
        }),
        isError: true,
        denied: true,
        deniedReason: baseVerdict.reason,
      };
    }
    const matcher = globToRegExp(args.pattern);
    const candidates = [];
    const walkResult = await walk(base, WALK_MAX_DIRS, (child, entry) => {
      if (signal?.aborted === true) return false;
      const rel = relative(base, child).split(sep).join('/');
      if (matcher.test(rel)) candidates.push(child);
      return candidates.length < GLOB_MAX_ENTRIES * 2;
    });
    // 逐个过拒止清单：列出凭据文件名本身也是泄漏，不能只靠遍历时跳过。
    const matches = [];
    for (const child of candidates) {
      if (matches.length >= GLOB_MAX_ENTRIES) break;
      const verdict = await checkDenied(child);
      if (verdict.denied) continue;
      matches.push(child);
    }
    const suffix = matches.length >= GLOB_MAX_ENTRIES
      ? `\n${T('tool.firstNEntries', { n: GLOB_MAX_ENTRIES })}`
      : walkResult.stopped
        ? `\n${T('tool.walkLimit')}`
        : '';
    return { text: `${matches.join('\n')}${suffix}`, isError: false, denied: false };
  }

  /** `grep` 实现。 */
  async function runGrep(args, signal) {
    if (typeof args.pattern !== 'string' || args.pattern.length === 0) {
      return { text: T('tool.missingPattern'), isError: true, denied: false };
    }
    // R32：模型 pattern 先过静态安全校验——病态回溯形态（嵌套量词、歧义选择、反向引用）直接回喂错误文本，
    // 模型可改写重试；fail-closed 且不中断其余候选，同步 `regex.test` 由此拿到确定性时间上界。
    const unsafe = assertSafePattern(args.pattern);
    if (unsafe !== undefined) {
      return { text: T('tool.unsafePattern', { reason: unsafe }), isError: true, denied: false };
    }
    let regex;
    try {
      regex = new RegExp(args.pattern, 'u');
    } catch (error) {
      // 正则编译失败是模型参数错误，直接回喂错误文本，不静默按无匹配处理。
      return { text: T('tool.regexFail', { error: errorText(error) }), isError: true, denied: false };
    }
    const maxMatches = Number.isFinite(args.maxMatches) && args.maxMatches > 0
      ? Math.min(Math.floor(args.maxMatches), GREP_MAX_MATCHES)
      : GREP_MAX_MATCHES;
    const targetVerdict = await checkDenied(args.path);
    if (targetVerdict.denied) {
      return {
        text: T(targetVerdict.reason === 'dsh-home' ? 'tool.deniedDsh' : 'tool.deniedGrep', {
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
    const hits = [];
    let skippedLarge = 0;

    const searchFile = async (file) => {
      if (hits.length >= maxMatches) return;
      const guarded = await checkDenied(file);
      if (guarded.denied) return;
      // R32：stat 预检——超阈值文件不整读进内存，跳过并计数，结果末尾说明（同目录其余候选不受影响）。
      let info;
      try {
        info = await stat(file);
      } catch {
        return;
      }
      if (info.size > GREP_MAX_FILE_BYTES) {
        skippedLarge += 1;
        return;
      }
      let content;
      try {
        content = await readFile(file, 'utf8');
      } catch {
        return;
      }
      if (content.includes('\u0000')) return;
      const lines = content.split(/\r?\n/u);
      for (let index = 0; index < lines.length && hits.length < maxMatches; index += 1) {
        const line = lines[index];
        if (line.length > GREP_MAX_LINE_CHARS) continue;
        if (regex.test(line)) hits.push(`${file}:${index + 1}: ${line}`);
        regex.lastIndex = 0;
      }
    };

    let info;
    try {
      info = await stat(target);
    } catch (error) {
      return { text: T('tool.inaccessible', { path: args.path, error: errorText(error) }), isError: true, denied: false };
    }
    let candidatesCapped = false;
    if (info.isFile()) {
      await searchFile(target);
    } else {
      // 先收集候选文件再逐个读：遍历回调是同步的，边遍历边发异步读会让上限判断失真。
      const candidates = [];
      await walk(target, WALK_MAX_DIRS, (child, entry) => {
        if (signal?.aborted === true) return false;
        if (!entry.isFile()) return true;
        const rel = relative(target, child).split(sep).join('/');
        if (filter !== undefined && !filter.test(rel)) return true;
        // R32：候选文件数上限——达上限即停止收集，结果末尾说明截断。
        if (candidates.length >= GREP_MAX_CANDIDATES) {
          candidatesCapped = true;
          return false;
        }
        candidates.push(child);
        return true;
      });
      for (const file of candidates) {
        if (hits.length >= maxMatches || signal?.aborted === true) break;
        await searchFile(file);
      }
    }
    const suffixParts = [];
    if (hits.length >= maxMatches) suffixParts.push(T('tool.firstNMatches', { n: maxMatches }));
    if (skippedLarge > 0) suffixParts.push(T('tool.grepSkippedLarge', { n: skippedLarge }));
    if (candidatesCapped) suffixParts.push(T('tool.grepTruncated', { n: GREP_MAX_CANDIDATES }));
    const suffix = suffixParts.length > 0 ? `\n${suffixParts.join('\n')}` : '';
    return { text: `${hits.join('\n')}${suffix}`, isError: false, denied: false };
  }

  return {
    /** 按当前语言取工具 Schema（getter：`setLang` 后下一次审查请求即用新描述，R28 热生效）。 */
    get schemas() {
      return agentT(lang, 'tool.schemas');
    },
    run,
    /**
     * 切换相对路径的基准目录；每次审查前设为会话工作目录。
     * @param {string} next - 新的基准目录。
     * @returns {void}
     */
    setRoot(next) {
      if (typeof next === 'string' && next.length > 0) rootDir = next;
    },
    /**
     * 切换模型侧文案语言（工具说明＋结果模板）；每次审查前由宿主接配置现设（R28）。
     * @param {string} next - 语言（AGENT_LANGS 之一）。
     * @returns {void}
     */
    setLang(next) {
      if (next === 'en' || next === 'zh') lang = next;
    },
    /**
     * 切换单工具超时；每次审查前由宿主接配置现设（R36 热改接线，`lib/index.js` 的 `rt.review`）。
     * @param {number} next - 新的超时毫秒；有限非负数才生效（0＝不设超时，语义对齐 `reviewer.timeoutMs`）。
     * @returns {void}
     */
    setToolTimeoutMs(next) {
      if (Number.isFinite(next) && next >= 0) toolTimeoutMs = next;
    },
    /**
     * 切换脱敏清单；每次审查前由宿主接配置现设（R36：工具结果与注入、trace 落盘三路同口径）。
     * @param {string[]} next - 新的模式数组；字符串数组才生效。
     * @returns {void}
     */
    setRedactPatterns(next) {
      if (Array.isArray(next) && next.every((item) => typeof item === 'string')) redactPatterns = next;
    },
  };
}

/**
 * 给一次工具调用套上超时与取消。
 * @param {() => Promise<object>} task - 实际调用。
 * @param {number} timeoutMs - 超时毫秒；非正数表示不设超时。
 * @param {AbortSignal} [signal] - 外部取消。
 * @returns {Promise<object>} 结果。
 */
function withTimeout(task, timeoutMs, signal, lang) {
  const textsLang = lang === 'en' ? 'en' : 'zh';
  if ((!Number.isFinite(timeoutMs) || timeoutMs <= 0) && signal === undefined) return task();
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
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => finish(rejectPromise, new Error(fmt(agentT(textsLang, 'tool.timeout'), { ms: timeoutMs }))), timeoutMs)
      : undefined;
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
