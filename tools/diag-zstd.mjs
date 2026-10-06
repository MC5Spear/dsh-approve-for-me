/**
 * 诊断：解压多帧 zstd 会话日志（session.v4.jsonl.zstd），定位 v4 校验拒绝的行。
 * 每次 append 一个独立 zstd 帧，zstdDecompressSync 只解第一帧——按魔数 0x28B52FFD 切帧，
 * 单帧失败时与下一帧合并重试（魔数偶尔出现在压缩负载里）。
 * 用法：node tools/diag-zstd.mjs <session-log-path> <out-path>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const [src, outPath] = process.argv.slice(2);
const buf = readFileSync(src);
const MAGIC = 0x28b52ffd;

function magicAt(i) {
  return buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd;
}

const starts = [];
for (let i = 0; i + 4 <= buf.length; i += 1) {
  if (magicAt(i)) starts.push(i);
}
if (starts.length === 0 || starts[0] !== 0) starts.unshift(0);

const parts = [];
let failed = 0;
for (let i = 0; i < starts.length; i += 1) {
  const chunk = buf.subarray(starts[i], i + 1 < starts.length ? starts[i + 1] : buf.length);
  try {
    parts.push(zstdDecompressSync(chunk));
  } catch {
    failed += 1;
  }
}
// 合并重试一轮：把上一轮失败的段并进后一段再试（简单实现：整段逐帧推进时失败即并入下一段）。
if (failed > 0) {
  const parts2 = [];
  let carry = null;
  for (let i = 0; i < starts.length; i += 1) {
    const chunkStart = carry === null ? starts[i] : carry;
    const chunkEnd = i + 1 < starts.length ? starts[i + 1] : buf.length;
    if (chunkStart >= chunkEnd) continue;
    try {
      parts2.push(zstdDecompressSync(buf.subarray(chunkStart, chunkEnd)));
      carry = null;
    } catch {
      if (carry === null) carry = chunkStart;
    }
  }
  if (parts2.length > parts.length) {
    parts.length = 0;
    parts.push(...parts2);
  }
}

const full = Buffer.concat(parts).toString();
writeFileSync(outPath, full);
const rows = full.split('\n').filter(Boolean);
console.log(`file=${src}`);
console.log(`bytes=${buf.length} magicSplits=${starts.length} parts=${parts.length} failedFrames=${failed}`);
console.log(`decompressed=${full.length} rows=${rows.length}`);

const kinds = {};
for (const row of rows) {
  let type = '?';
  try {
    type = JSON.parse(row).type ?? '?';
  } catch {
    type = '(unparsable)';
  }
  kinds[type] = (kinds[type] ?? 0) + 1;
}
console.log('row types:', JSON.stringify(kinds));

const bad = rows.filter((r) => r.includes('"kind":"plugin"'));
console.log(`rows with source.kind=plugin: ${bad.length}`);
for (const row of bad) console.log('BADROW:', row.slice(0, 500));

console.log('--- last 3 rows (truncated) ---');
for (const row of rows.slice(-3)) console.log(row.slice(0, 400));
