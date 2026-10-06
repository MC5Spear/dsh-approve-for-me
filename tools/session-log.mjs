/**
 * Shared reader for dsh session logs.
 *
 * A `session.jsonl.zstd` file is a concatenated-frame Zstandard container: the
 * persistence backend appends one independently decodable, checksummed frame per
 * header / durable event batch. Node's one-shot `zstdDecompressSync` decodes only
 * the first frame, so this module scans frame boundaries first and decodes each
 * frame on its own. The scanner mirrors the container parser in
 * `@deepseek-ai/dsh-session-persistence-jsonl` (`scanZstdFrames`).
 * @module tools/session-log
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = 4247762216;

/**
 * Locate every structurally complete frame in a concatenated-frame container.
 * @param buffer - the complete bytes currently present in the artifact.
 * @returns `{ frames, tornStart? }` — frame ranges plus the start of an
 * incomplete final frame when the file was captured mid-append.
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
 * Decode a whole session log to UTF-8 text.
 * @param file - absolute path of a `session.jsonl.zstd` file.
 * @returns the concatenated plaintext of every complete frame.
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
 * Enumerate every session log under a dsh sessions root.
 * @param sessionsRoot - absolute path of `<DSH_HOME>/sessions`.
 * @returns `{ workspace, session, file }` entries.
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
