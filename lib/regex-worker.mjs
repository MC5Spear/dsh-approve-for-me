/**
 * dsh-approve-for-me — 正则匹配工作者（worker_threads，design §3.4）。
 *
 * 模型输入派生的正则（grep pattern、glob 模式经 `globToRegExp` 生成的匹配式）不在宿主插件
 * 主线程执行：病态回溯只烧本线程，主事件循环保持响应；单工具时限到点或请求取消由主线程
 * `terminate()` 强制结束在飞匹配——同步匹配无法被打断，终止线程是唯一真实生效的时限手段。
 * 任务经 `workerData` 一次性下发，结果经 `parentPort` 一次性回传；敏感路径检查已在主线程
 * 完成，本文件收到的都是通过检查的路径。本文件不导入项目模块（避免循环依赖），只依赖
 * node: 内置包；随包发布（package.json files 含 lib/）。
 * @module dsh-approve-for-me/regex-worker
 */
import { readFile, stat } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';

/**
 * grep 任务：glob 过滤 → stat 预检 → 读取 → 逐行匹配。
 * 过滤后的候选数达上限即停止（主线程在结果尾部说明截断）；超阈值文件与超长行分别计数回传。
 * @param {object} payload - 任务参数。
 * @param {string} payload.pattern - 已过静态校验与编译检查的正则源串。
 * @param {string} [payload.filterSource] - glob 过滤式源串（单文件目标不传）。
 * @param {{rel: string, abs: string}[]} payload.files - 候选文件（已过敏感路径检查）。
 * @param {number} payload.maxMatches - 命中数上限。
 * @param {number} payload.maxCandidates - 过滤后候选数上限。
 * @param {number} payload.maxFileBytes - 单文件字节上限。
 * @param {number} payload.maxLineChars - 单行字符数上限。
 * @returns {Promise<{hits: string[], skippedLarge: number, skippedLong: number, capped: boolean}>} 结果。
 */
async function grepTask(payload) {
  const regex = new RegExp(payload.pattern, 'u');
  const filter = payload.filterSource === undefined ? undefined : new RegExp(payload.filterSource, 'u');
  const hits = [];
  let skippedLarge = 0;
  let skippedLong = 0;
  let searched = 0;
  let capped = false;
  for (const file of payload.files) {
    if (filter !== undefined && !filter.test(file.rel)) continue;
    if (searched >= payload.maxCandidates) {
      capped = true;
      break;
    }
    searched += 1;
    let info;
    try {
      info = await stat(file.abs);
    } catch {
      continue; // stat 失败（文件消失/无权限）按跳过处理，不中断其余候选。
    }
    if (info.size > payload.maxFileBytes) {
      skippedLarge += 1;
      continue;
    }
    let content;
    try {
      content = await readFile(file.abs, 'utf8');
    } catch {
      continue;
    }
    if (content.includes(String.fromCharCode(0))) continue; // 含 NUL 的二进制内容不参与取证。
    const lines = content.split(/\r?\n/u);
    for (let index = 0; index < lines.length && hits.length < payload.maxMatches; index += 1) {
      const line = lines[index];
      if (line.length > payload.maxLineChars) {
        skippedLong += 1;
        continue; // 超长行整行跳过、不截断，计数回传。
      }
      if (regex.test(line)) hits.push(`${file.abs}:${index + 1}: ${line}`);
      regex.lastIndex = 0;
    }
  }
  return { hits, skippedLarge, skippedLong, capped };
}

/**
 * glob 任务：相对路径批量过匹配式，命中回传（含绝对路径，主线程再做敏感路径检查）。
 * @param {object} payload - 任务参数。
 * @param {string} payload.matcherSource - 匹配式源串。
 * @param {{rel: string, abs: string}[]} payload.paths - 待测路径批次。
 * @param {number} payload.maxMatches - 命中数上限（主线程拒止过滤前的收集上限）。
 * @returns {Promise<{matched: {rel: string, abs: string}[], capped: boolean}>} 结果。
 */
async function globTask(payload) {
  const matcher = new RegExp(payload.matcherSource, 'u');
  const matched = [];
  let capped = false;
  for (const item of payload.paths) {
    if (!matcher.test(item.rel)) continue;
    if (matched.length >= payload.maxMatches) {
      capped = true;
      break;
    }
    matched.push(item);
  }
  return { matched, capped };
}

const payload = workerData;
try {
  const result = payload.kind === 'glob' ? await globTask(payload) : await grepTask(payload);
  parentPort.postMessage({ ok: true, ...result });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
