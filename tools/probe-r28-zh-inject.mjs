/**
 * 取证：解码指定会话日志，抽出 approve-for-me 注入消息，打印首行与字节长。
 * 判据（requirements §5.4）：agent=zh 档下注入文本首行应为中文 `[approve-for-me] …`。
 * 兼容两种会话文件命名：session.jsonl.zstd 与 session.v*.jsonl.zstd。
 * 用法：node tools/probe-r28-zh-inject.mjs <sessionsRoot> <sessionId>
 * @module tools/probe-r28-zh-inject
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readSessionLog } from './session-log.mjs';

const [root, sessionId] = process.argv.slice(2);
if (!root || !sessionId) throw new Error('usage: probe-r28-zh-inject.mjs <sessionsRoot> <sessionId>');
const files = [];
for (const workspace of readdirSync(root)) {
	const dir = join(root, workspace, sessionId);
	if (!existsSync(dir)) continue;
	for (const name of readdirSync(dir)) {
		if (/^session(\.v\d+)?\.jsonl\.zstd$/u.test(name)) files.push({ workspace, file: join(dir, name) });
	}
}
if (files.length === 0) throw new Error(`session ${sessionId} not found under ${root}`);
for (const f of files) {
	const rows = readSessionLog(f.file);
	let n = 0;
	for (const row of rows) {
		const text = row?.text ?? row?.message?.text ?? '';
		const kind = row?.source?.kind ?? row?.message?.source?.kind ?? '';
		if (!String(kind).includes('approve-for-me')) continue;
		n += 1;
		const first = String(text).split('\n')[0];
		const bytes = Buffer.byteLength(String(text), 'utf8');
		console.log(`#${n} kind=${kind} firstLine=${JSON.stringify(first)} bytes=${bytes}`);
	}
	console.log(`WORKSPACE ${f.workspace} FILE ${f.file} rows=${rows.length} injected=${n}`);
}
