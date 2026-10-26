/**
 * 取证：解码指定会话日志，抽出 approve-for-me 注入消息，打印首行与字节长。
 * 判据（requirements §5.4）：agent=zh 档下注入文本首行应为中文 `[approve-for-me] …`。
 *
 * 日志解析走共用读取器：JSONL 行、v4 事件包裹（`{event:{…}}`）与一行多事件数组都认；
 * 注入消息从声明式消息事件（`user/message`、`agent/inbox/spliced` 等）提取。同一条消息
 * 可能同时出现在 inbox（`agent/inbox/spliced` 的 `inserted`）与正式持久化（`user/message`）
 * 两处——按消息 id 去重后统计，不把事件数当消息数，更不当审批数（审批另有
 * `approval/decided` 事件，本探针只做语言档取证）。会话目录里的各代日志（`session.jsonl.zstd`
 * 与 `session.vN.jsonl.zstd`）都读，跨文件按 id 去重。
 * 用法：node tools/probe-r28-zh-inject.mjs <sessionsRoot> <sessionId>
 * @module tools/probe-r28-zh-inject
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { messagesOfEvent, parseSessionEvents, readSessionLog, sessionLogFiles } from './session-log.mjs';

const ZH_RE = /[\u3400-\u9fff]/u;

/**
 * 汇总一个会话目录各代日志里的插件注入消息。
 * @param {string} dir - 会话目录绝对路径。
 * @param {string} [pluginName] - 插件源 kind 里的插件名（默认 approve-for-me）。
 * @returns {{
 *   files: Array<{file: string, lines: number, events: number, pluginMessages: number, error?: string}>,
 *   injected: Array<{id: string, kind: string, text: string, via: string[], zh: boolean}>,
 * }} 每文件读数与去重后的注入消息（via 记录出现过的事件类型）。
 */
export function analyzeSessionInjections(dir, pluginName = 'approve-for-me') {
  const files = [];
  const byId = new Map();
  for (const { file } of sessionLogFiles(dir)) {
    let text;
    try {
      text = readSessionLog(file);
    } catch (error) {
      files.push({ file, lines: 0, events: 0, pluginMessages: 0, error: String(error.message) });
      continue;
    }
    const { lines, events } = parseSessionEvents(text);
    let pluginMessages = 0;
    for (const event of events) {
      for (const message of messagesOfEvent(event)) {
        const kind = String(message?.source?.kind ?? '');
        if (!kind.includes(pluginName)) continue;
        pluginMessages += 1;
        const content = Array.isArray(message?.content) ? message.content : [];
        const textOf = content.filter((block) => block?.type === 'text').map((block) => String(block.text ?? '')).join('\n');
        const id = typeof message?.id === 'string' && message.id.length > 0
          ? message.id
          : `${kind}|${message?.role ?? ''}|${textOf}`;
        const entry = byId.get(id) ?? { id, kind, text: textOf, via: [] };
        if (!entry.via.includes(event.type)) entry.via.push(event.type);
        byId.set(id, entry);
      }
    }
    files.push({ file, lines, events, pluginMessages });
  }
  const injected = [...byId.values()].map((entry) => ({
    ...entry,
    zh: entry.text.startsWith('[approve-for-me]') && ZH_RE.test(entry.text),
  }));
  return { files, injected };
}

/**
 * 命令行入口（可直接调用便于测试）。
 * @param {string[]} args - `[sessionsRoot, sessionId]`。
 * @returns {{code: number, out: string[]}} 退出码与输出行。
 */
export function cli(args) {
  const [root, sessionId] = args;
  const out = [];
  if (!root || !sessionId) {
    out.push('usage: probe-r28-zh-inject.mjs <sessionsRoot> <sessionId>');
    return { code: 2, out };
  }
  const dir = join(root, sessionId);
  if (!existsSync(dir)) {
    out.push(`session ${sessionId} not found under ${root}`);
    return { code: 1, out };
  }
  const { files, injected } = analyzeSessionInjections(dir);
  injected.forEach((entry, index) => {
    const first = entry.text.split('\n')[0];
    out.push(`#${index + 1} kind=${entry.kind} via=${entry.via.join('+')} zh=${entry.zh} firstLine=${JSON.stringify(first)} bytes=${Buffer.byteLength(entry.text, 'utf8')}`);
  });
  let errors = 0;
  for (const file of files) {
    if (file.error !== undefined) {
      errors += 1;
      out.push(`FILE ${file.file} ERROR ${file.error}`);
      continue;
    }
    out.push(`FILE ${file.file} lines=${file.lines} events=${file.events} pluginMessages=${file.pluginMessages}`);
  }
  const inbox = injected.filter((entry) => entry.via.includes('agent/inbox/spliced')).length;
  const persisted = injected.filter((entry) => entry.via.includes('user/message')).length;
  out.push(`TOTAL files=${files.length} errors=${errors} injected=${injected.length} (inbox=${inbox} persisted=${persisted})`);
  return { code: errors > 0 ? 1 : 0, out };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { code, out } = cli(process.argv.slice(2));
  for (const line of out) console.log(line);
  process.exitCode = code;
}
