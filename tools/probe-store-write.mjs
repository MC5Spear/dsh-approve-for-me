/**
 * 一次性取证脚本：用**已部署的**存储实现，向真实 reviews 目录写一条记录，判断「存储能不能写进去」。
 *
 * 不是产品代码：写入的是一条 `probe-` 前缀的临时记录，跑完立即删除对应文件。
 * 用法：node tools/probe-store-write.mjs
 */
import { readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const deployed = join(
  homedir(),
  '.dsh',
  'profiles',
  'web',
  'node_modules',
  'dsh-approve-for-me',
  'lib',
  'trace-store.js',
);
console.log('store module:', deployed, existsSync(deployed));
const { createTraceStore } = await import(`file:///${deployed.replace(/\\/gu, '/')}`);

const dir = join(homedir(), '.dsh', 'approve-for-me', 'reviews');
const key = 'probe-store-write';
const before = readdirSync(dir);
console.log('files before:', before.length);

const store = createTraceStore({ dir, capture: 'full', maxRecords: 200, maxBytes: 8192 });
const ok = await store.record({
  sessionId: key,
  callId: 'call_probe:ptc:1',
  toolName: 'pwsh',
  startedAt: Date.now() - 1200,
  endedAt: Date.now(),
  reviewMs: 1200,
  decision: 'allow',
  model: 'probe/model',
  effort: 'max',
  tokens: 7,
  prompt: 'p',
  input: 'i',
  reasoning: 'r',
  output: 'o',
});
await store.flush();
console.log('record() returned:', ok);

const file = join(dir, `${key}.jsonl`);
console.log('file exists:', existsSync(file));
if (existsSync(file)) {
  const text = readFileSync(file, 'utf8');
  console.log('file bytes:', text.length, 'lines:', text.split('\n').filter((l) => l.trim().length > 0).length);
  console.log('first line keys:', Object.keys(JSON.parse(text.split('\n')[0])).join(','));
}
console.log('list() rows:', store.list(key).length);
rmSync(file, { force: true });
console.log('cleaned up; files after:', readdirSync(dir).length);
