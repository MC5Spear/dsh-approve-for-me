/**
 * dsh 会话日志的共用读取器。`session.jsonl.zstd` 是拼接帧的 Zstandard 容器：持久化后端按
 * 每个头部／持久事件批次追加一个独立可解码、带校验的帧。Node 的一次性 `zstdDecompressSync`
 * 只解码第一帧，因此本模块先扫帧边界、再逐帧解码。扫描器与
 * `@deepseek-ai/dsh-session-persistence-jsonl` 的容器解析器（`scanZstdFrames`）保持同一形状。
 *
 * 文件命名（同包 README）：`session.jsonl.zstd` 是第 0 代，`session.vN.jsonl.zstd` 是第 N 代
 * 已发布日志；一个会话目录可同时有多代，**最高代是当前视图**（宿主重放的就是它），低代是
 * 历史快照。`sessionLogFiles` 按代升序返回全部，`currentSessionLog` 取最高代。
 * @module tools/session-log
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = 4247762216;

/**
 * 在拼接帧容器中定位每个结构完整的帧。
 * @param buffer - 工件当前已有的完整字节。
 * @returns `{ frames, tornStart? }`——帧区间列表；文件在追加中途被截断时，附带末尾不完整帧的起点。
 */
export function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

/**
 * 把整份会话日志解码为 UTF-8 文本。
 * @param file - `session.jsonl.zstd` 文件的绝对路径。
 * @returns 全部完整帧拼接出的明文。
 */
export function readSessionLog(file) {
  const buffer = readFileSync(file);
  const { frames } = scanZstdFrames(buffer);
  let text = '';
  for (const { start, end } of frames) {
    text += zstdDecompressSync(buffer.subarray(start, end)).toString('utf8');
  }
  return text;
}

/**
 * 枚举 dsh sessions 根目录下的会话日志（每个会话目录取当前代＝最高代的文件）。
 * @param sessionsRoot - `<DSH_HOME>/sessions` 的绝对路径。
 * @returns `{ workspace, session, file, generation }` 条目列表。
 */
export function listSessionLogs(sessionsRoot) {
  const found = [];
  if (!existsSync(sessionsRoot)) return found;
  for (const workspace of readdirSync(sessionsRoot)) {
    const wsDir = join(sessionsRoot, workspace);
    if (!statSync(wsDir).isDirectory()) continue;
    for (const session of readdirSync(wsDir)) {
      const dir = join(wsDir, session);
      if (!statSync(dir).isDirectory()) continue;
      const current = currentSessionLog(dir);
      if (current !== undefined) found.push({ workspace, session, file: current.file, generation: current.generation });
    }
  }
  return found;
}

/** 会话日志文件名（第 0 代无后缀，第 N 代 `.vN`；压缩容器）。 */
const SESSION_LOG_RE = /^session(?:\.v(\d+))?\.jsonl\.zstd$/u;

/**
 * 列出一个会话目录下的全部会话日志文件，按代升序（第 0 代最先）。
 * @param dir - 会话目录绝对路径。
 * @returns `{ file, generation }` 列表；无匹配时为空。
 */
export function sessionLogFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const match = SESSION_LOG_RE.exec(name);
    if (match === null) continue;
    out.push({ file: join(dir, name), generation: match[1] === undefined ? 0 : Number(match[1]) });
  }
  out.sort((a, b) => a.generation - b.generation);
  return out;
}

/**
 * 一个会话目录的当前代日志（最高 vN；无版本后缀的算第 0 代）。
 * @param dir - 会话目录绝对路径。
 * @returns `{ file, generation }`；目录无会话日志时 `undefined`。
 */
export function currentSessionLog(dir) {
  const files = sessionLogFiles(dir);
  return files.length === 0 ? undefined : files[files.length - 1];
}

/**
 * 把日志明文解析为规范化事件行。
 * 兼容三种物理形态：直接事件行（`{seq,time,type,data}`）、信封包裹（`{event:{…}}`）、
 * 一行多事件的数组。损坏的 JSON 行跳过（计入 lines、不产生事件）。
 * @param {string} text - `readSessionLog` 的明文。
 * @returns `{ lines, events }`——非空行数与规范化事件（`{seq,time,type,data}`）列表。
 */
export function parseSessionEvents(text) {
  const events = [];
  let lines = 0;
  for (const line of String(text).split('\n')) {
    if (line.trim().length === 0) continue;
    lines += 1;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      const raw = item?.event ?? item;
      if (raw === null || typeof raw !== 'object' || typeof raw.type !== 'string') continue;
      events.push({ seq: raw.seq, time: raw.time, type: raw.type, data: raw.data });
    }
  }
  return { lines, events };
}

/**
 * 一个事件里承载的消息（与 dsh-session-format-v3-to-v4 的声明式消息遍历同口径）。
 * @param {object} event - `parseSessionEvents` 产出的事件。
 * @returns {object[]} 事件内消息列表（多数事件为空数组）。
 */
export function messagesOfEvent(event) {
  const data = event?.data;
  switch (event?.type) {
    case 'user/message':
      return [data?.message ?? data].filter((m) => m !== null && typeof m === 'object');
    case 'system/message':
    case 'assistant/message':
    case 'tool/result':
      return [data?.message].filter((m) => m !== null && typeof m === 'object');
    case 'agent/inbox/spliced':
      return Array.isArray(data?.inserted) ? data.inserted.filter((m) => m !== null && typeof m === 'object') : [];
    case 'session/title-llm-request':
      return Array.isArray(data?.messages) ? data.messages.filter((m) => m !== null && typeof m === 'object') : [];
    default:
      return [];
  }
}
