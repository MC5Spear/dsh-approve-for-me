/**
 * dsh 会话日志的共用读取器。`session.jsonl.zstd` 是拼接帧的 Zstandard 容器：持久化后端按
 * 每个头部／持久事件批次追加一个独立可解码、带校验的帧。Node 的一次性 `zstdDecompressSync`
 * 只解码第一帧，因此本模块先扫帧边界、再逐帧解码。扫描器与
 * `@deepseek-ai/dsh-session-persistence-jsonl` 的容器解析器（`scanZstdFrames`）保持同一形状。
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
 * 枚举 dsh sessions 根目录下的全部会话日志。
 * @param sessionsRoot - `<DSH_HOME>/sessions` 的绝对路径。
 * @returns `{ workspace, session, file }` 条目列表。
 */
export function listSessionLogs(sessionsRoot) {
  const found = [];
  if (!existsSync(sessionsRoot)) return found;
  for (const workspace of readdirSync(sessionsRoot)) {
    const wsDir = join(sessionsRoot, workspace);
    if (!statSync(wsDir).isDirectory()) continue;
    for (const session of readdirSync(wsDir)) {
      const file = join(wsDir, session, 'session.jsonl.zstd');
      if (existsSync(file)) found.push({ workspace, session, file });
    }
  }
  return found;
}
