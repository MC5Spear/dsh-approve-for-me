#!/usr/bin/env node
/**
 * 「自动审批」预设条目的部署脚本（R26 / 设计 §14.1）。
 *
 * 为什么必须插件自带脚本：`permission` 行由 dsh-base 提供，第三方 bundle patch 在层序上
 * 不可能命中它；而 `dsh plugin remove` 是另一个进程、不执行任何插件代码——
 * 写入与回收都只能由这条零依赖命令完成（只 import node:* 与相对路径，删光
 * node_modules 后也要能跑）。
 *
 * 语义（锚点式文本编辑，不解析 YAML——不猜结构）：
 *   --init-row  干净 profile（从官方模板新建、patch 里还没重述过 `permission` 行）走这一步：
 *             把该行的整份内容追加到 patch 末尾（三档与 dsh-base 逐字一致）。老部署若已重述过，
 *             本条幂等跳过。没有它，`--apply` 会因为找不到锚点而失败——2026-09-25 在
 *             「干净 home + 官方 dsh plugin add」的受控实验里实测到的就是这一条（D7）。
 *   --apply   在 profile patch `permission` 行 `presets` 块的 `workspace-write:` 条目之后、
 *             `danger-full-access:` 之前插入 `auto-approve:` 条目（取值与 workspace-write
 *             完全相同，声明顺序必须在后）。已存在则跳过（幂等，二次执行零 diff）。
 *             若 `defaultPreset` 现值是 `auto-approve`：先把原值备份到
 *             `$DSH_HOME/approve-for-me/permission-grant.json`（`null` 表示原本没有该键），
 *             再改为宿主标准预设 `workspace-write`（取值相同，不改行为）——插件预设名
 *             不得作为 defaultPreset（R26 回收侧禁令）。
 *   --revert  删除 `auto-approve:` 条目块；`defaultPreset` 按备份恢复（备份记录 `null`
 *             则删除该键）；备份值等于本条条目名时折算为标准预设（否则指向已删预设会让
 *             设置注册失败）；无备份但现值仍是 `auto-approve` 时同样折算；随后删除备份文件。
 *
 * 锚点缺失（找不到 permission 行 / presets 块 / 两个邻接条目）一律报错退出、不落盘。
 * 写回：UTF-8 无 BOM（原文件带 BOM 则保留）、原子写（同目录临时文件 + rename）。
 *
 * 用法：node tools/permission-preset.mjs [--init-row|--apply|--revert] [--home <dir>] [--profile <name>]
 * @module dsh-approve-for-me/tools/permission-preset
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PRESET_ID = 'auto-approve';
const STANDARD_FALLBACK = 'workspace-write';
/** 插入的条目块（6 空格缩进，与 profile patch 的 presets 条目对齐；值与 workspace-write 完全相同）。 */
const ENTRY_LINES = [
	`      ${PRESET_ID}:`,
	'        sandbox: workspace-write',
	'        approval: ask',
	'        name: 自动审批',
	'        description: 与「工作区内修改」相同的沙箱与审批策略，升权请求先由 LLM 审查器自动判定。',
];
/** permission 行整行重述块（`--init-row` 用；内容与 dsh-base 同名行逐字一致的三个标准预设）。 */
const ROW_LINES = [
	'# permission 行整行重述（由 dsh-approve-for-me 的 --init-row 写入）。',
	'# 来源：@deepseek-ai/dsh-base 的 cordis.patch.yml 同名行——patch 按行覆盖**整份** config，',
	'# 所以要往这一行加预设，就必须先把它的完整内容重述一遍；三档取值与 base 逐字一致。',
	'- id: permission',
	"  name: '@deepseek-ai/dsh-permission-presets'",
	'  config:',
	'    presets:',
	'      read-only:',
	'        sandbox: read-only',
	'        approval: ask',
	'      workspace-write:',
	'        sandbox: workspace-write',
	'        approval: ask',
	'      danger-full-access:',
	'        sandbox: danger-full-access',
	'        approval: never',
];

/** 命令行参数解析；同时给多个模式视为用法错误。 */
function parseArgs(argv) {
	const args = { mode: '', home: '', profile: 'web' };
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (token === '--apply' || token === '--revert' || token === '--init-row') args.mode = token;
		else if (token === '--home') args.home = argv[(index += 1)] ?? '';
		else if (token === '--profile') args.profile = argv[(index += 1)] ?? 'web';
		else {
			process.stderr.write(`[permission-preset] 未知参数：${token}\n`);
			process.exit(2);
		}
	}
	if (args.mode === '') {
		process.stderr.write('用法：node tools/permission-preset.mjs --init-row|--apply|--revert [--home <dir>] [--profile <name>]\n');
		process.exit(2);
	}
	if (args.home === '') args.home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh');
	return args;
}

/**
 * 定位 `permission` 行的行号区间（从 `- id: permission` 到下一个顶层行之前）。
 * @param {string[]} lines - 全文行。
 * @returns {[number, number]} [start, endExclusive)；找不到时抛错。
 */
function permissionRowRange(lines) {
	const start = lines.findIndex((line) => /^- id: permission\s*$/.test(line));
	if (start === -1) throw new Error('锚点缺失：未找到 `- id: permission` 行（permission 行由 dsh-base 提供，本文件应整行重述它）');
	let end = lines.length;
	for (let index = start + 1; index < lines.length; index += 1) {
		if (/^- /.test(lines[index]) || /^- insert:/.test(lines[index])) {
			end = index;
			break;
		}
	}
	return [start, end];
}

/**
 * 在 permission 行区间内找子键行（缩进敏感）。
 * @param {string[]} lines - 全文行。
 * @param {number} start - 区间起点。
 * @param {number} end - 区间终点（不含）。
 * @param {RegExp} pattern - 行内容匹配。
 * @returns {number} 行号；找不到为 -1。
 */
function findLine(lines, start, end, pattern) {
	for (let index = start; index < end; index += 1) {
		if (pattern.test(lines[index])) return index;
	}
	return -1;
}

/** 备份文件路径：`$DSH_HOME/approve-for-me/permission-grant.json`。 */
const backupFileOf = (home) => join(home, 'approve-for-me', 'permission-grant.json');

/** 取 `defaultPreset:` 行里 `:` 之后的值（原样，含可能的引号与空白修剪）。 */
const rawValueOf = (line) => line.replace(/^ {4}defaultPreset:\s*/, '').trim();

/** 剥掉 YAML 标量两端可能存在的引号：`"auto-approve"` 与 `'auto-approve'` 与 `auto-approve` 同值。 */
const unquote = (value) => value.replace(/^(['"])(.*)\1$/, '$2');

/**
 * 读备份的 defaultPreset 原值。
 * @param {string} file - 备份文件路径。
 * @returns {{defaultPreset: string | null} | undefined} 备份内容；文件不存在为 undefined。
 * @throws {Error} 备份文件存在但损坏/形状不对（JSON 解析失败或缺 defaultPreset 键）——
 *   与锚点缺失同级的可诊断错误（r26 S5：裸 JSON.parse 的语法错对使用者不可读）。
 */
function readBackup(file) {
	if (!existsSync(file)) return undefined;
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(file, 'utf8'));
	} catch (error) {
		throw new Error(`备份文件损坏（不是合法 JSON）：${file}——请手工核对后修复或删除该文件再重试（内容应形如 {"defaultPreset": "..."}；原解析错误：${error.message}）`);
	}
	if (parsed === null || typeof parsed !== 'object' || typeof parsed.defaultPreset !== 'string' && parsed.defaultPreset !== null) {
		throw new Error(`备份文件形状不对（应仅含 defaultPreset 键，值为字符串或 null）：${file}——请手工核对后修复或删除该文件再重试`);
	}
	return parsed;
}

/**
 * 原子写回：同目录临时文件 + rename；保留原有 BOM 与行尾风格。
 * @param {string} file - 目标文件。
 * @param {string} text - 全文（LF 行尾）。
 * @param {boolean} hadBom - 原文件是否带 BOM。
 * @param {string} eol - 原文件行尾。
 * @returns {void}
 */
function writeAtomic(file, text, hadBom, eol) {
	mkdirSync(dirname(file), { recursive: true });
	const temp = `${file}.dsafm-tmp`;
	// 行尾规范：把任意多的尾随换行收敛成恰好一个——「读出→插行→写回」的往返必须零 diff。
	const normalized = text.replace(/\n+$/, '\n');
	writeFileSync(temp, (hadBom ? '\uFEFF' : '') + normalized.split('\n').join(eol), 'utf8');
	renameSync(temp, file);
}

/**
 * `--apply`：插入条目（幂等）＋ defaultPreset 禁令处置。
 * @param {object} args - 命令行参数。
 * @returns {void}
 */
function applyPreset(args) {
	const patchFile = join(args.home, 'profiles', args.profile, 'cordis.patch.yml');
	const hadBom = readFileSync(patchFile, 'utf8').startsWith('\uFEFF');
	const raw = readFileSync(patchFile, 'utf8').replace(/^\uFEFF/, '');
	const eol = raw.includes('\r\n') ? '\r\n' : '\n';
	const lines = raw.split(/\r?\n/);
	const [rowStart, rowEnd] = permissionRowRange(lines);
	const presetsLine = findLine(lines, rowStart, rowEnd, /^ {4}presets:\s*$/);
	if (presetsLine === -1) throw new Error('锚点缺失：permission 行内未找到 `presets:` 块（4 空格缩进）');
	const workspaceLine = findLine(lines, presetsLine, rowEnd, /^ {6}workspace-write:\s*$/);
	const dangerLine = findLine(lines, presetsLine, rowEnd, /^ {6}danger-full-access:\s*$/);
	if (workspaceLine === -1 || dangerLine === -1) {
		throw new Error('锚点缺失：presets 块内未同时找到 `workspace-write:` 与 `danger-full-access:` 条目（6 空格缩进）');
	}
	if (workspaceLine > dangerLine) throw new Error('锚点异常：`workspace-write:` 排在 `danger-full-access:` 之后，文件结构不合预期，拒绝编辑');

	const existing = findLine(lines, presetsLine, rowEnd, new RegExp(`^ {6}${PRESET_ID}:\\s*$`));
	const backupFile = backupFileOf(args.home);
	let next = lines;
	if (existing === -1) {
		next = [...lines.slice(0, dangerLine), ...ENTRY_LINES, ...lines.slice(dangerLine)];
		process.stdout.write(`[permission-preset] 已插入「${PRESET_ID}」条目（workspace-write 之后、danger-full-access 之前）\n`);
	} else {
		process.stdout.write('[permission-preset] 「auto-approve」条目已存在，跳过插入（幂等）\n');
	}

	// defaultPreset 禁令：插件预设名不得作为默认预设（R26）。两预设取值相同，改写不改行为。
	// 取值比较前先剥引号：`auto-approve` 与 `"auto-approve"` 是同一个 YAML 标量（2026-09-25 终审抓到
	// 带引号写法能同时绕过本禁令与 --revert 的兜底，从而复活 D6 那类「指向已删预设」的启动失败）。
	const [, nextEnd] = [rowStart, existing === -1 ? rowEnd + ENTRY_LINES.length : rowEnd];
	const presetLine = findLine(next, rowStart, nextEnd, /^ {4}defaultPreset:\s*\S+/);
	if (presetLine !== -1 && unquote(rawValueOf(next[presetLine])) === PRESET_ID) {
		const previous = readBackup(backupFile);
		if (previous === undefined) {
			mkdirSync(dirname(backupFile), { recursive: true });
			writeFileSync(backupFile, JSON.stringify({ defaultPreset: rawValueOf(next[presetLine]) }, null, 2), 'utf8');
		}
		next[presetLine] = `    defaultPreset: ${STANDARD_FALLBACK}`;
		process.stdout.write(`[permission-preset] defaultPreset 曾指向 ${PRESET_ID}（违反 R26）：原值已备份到 ${backupFile}，现改为 ${STANDARD_FALLBACK}（取值相同）\n`);
	}

	writeAtomic(patchFile, `${next.join('\n')}\n`, hadBom, eol);
	process.stdout.write(`[permission-preset] --apply 完成：${patchFile}\n`);
}

/**
 * `--revert`：删条目块＋ defaultPreset 恢复＋删备份。
 * @param {object} args - 命令行参数。
 * @returns {void}
 */
function revertPreset(args) {
	const patchFile = join(args.home, 'profiles', args.profile, 'cordis.patch.yml');
	const hadBom = readFileSync(patchFile, 'utf8').startsWith('\uFEFF');
	const raw = readFileSync(patchFile, 'utf8').replace(/^\uFEFF/, '');
	const eol = raw.includes('\r\n') ? '\r\n' : '\n';
	const lines = raw.split(/\r?\n/);
	const [rowStart, rowEnd] = permissionRowRange(lines);
	const presetsLine = findLine(lines, rowStart, rowEnd, /^ {4}presets:\s*$/);
	if (presetsLine === -1) throw new Error('锚点缺失：permission 行内未找到 `presets:` 块（4 空格缩进）');
	const entryLine = findLine(lines, presetsLine, rowEnd, new RegExp(`^ {6}${PRESET_ID}:\\s*$`));
	if (entryLine === -1) {
		process.stdout.write('[permission-preset] 「auto-approve」条目不存在，无需删除（幂等）\n');
	} else {
		// 条目块＝从条目行到下一个「缩进 ≤ 6 的兄弟键 / 更浅的键 / 区间外」之前。
		let blockEnd = entryLine + 1;
		while (blockEnd < rowEnd && /^ {8,}\S/.test(lines[blockEnd])) blockEnd += 1;
		lines.splice(entryLine, blockEnd - entryLine);
		process.stdout.write(`[permission-preset] 已删除「${PRESET_ID}」条目块（${blockEnd - entryLine} 行）\n`);
	}

	// defaultPreset：优先按备份恢复；无备份但现值指向已删条目时退到标准预设，避免设置注册失败。
	// 备份值本身可能**就是**本次删掉的条目名（0.1.5 时代该条目由旧部署写入、备份因此记下它）——
	// 直接写回会让 permission 行在下次启动时注册失败：`permission: unknown preset "auto-approve"`
	// （实测见 开发期部署演练记录 §9），故一律折算成仍然存在的标准预设。
	const backupFile = backupFileOf(args.home);
	const backup = readBackup(backupFile);
	const rowEndAfter = permissionRowRange(lines)[1];
	const presetLine = findLine(lines, rowStart, rowEndAfter, /^ {4}defaultPreset:\s*\S+/);
	/** 现值（剥引号后比较，与 `--apply` 的判定同一口径）。 */
	const presetValue = (line) => unquote(rawValueOf(line));
	/** 备份值 → 可安全写回的值；备份值等于已删条目名时退到标准预设。 */
	const restorable = (value) => (unquote(value) === PRESET_ID ? STANDARD_FALLBACK : value);
	if (backup !== undefined) {
		if (presetLine === -1) {
			if (backup.defaultPreset !== null) {
				const restored = restorable(backup.defaultPreset);
				const presetsAgain = findLine(lines, rowStart, rowEndAfter, /^ {4}presets:\s*$/);
				lines.splice(presetsAgain + 1, 0, `    defaultPreset: ${restored}`);
				process.stdout.write(restored === backup.defaultPreset
					? `[permission-preset] defaultPreset 按备份恢复为 ${restored}\n`
					: `[permission-preset] 备份值 ${backup.defaultPreset} 正是本次删除的条目名，改恢复为 ${restored}（否则 permission 行注册失败）\n`);
			} else process.stdout.write('[permission-preset] 备份记录原值缺失，保持无 defaultPreset 键\n');
		} else if (presetValue(lines[presetLine]) === PRESET_ID || presetValue(lines[presetLine]) === STANDARD_FALLBACK) {
			if (backup.defaultPreset === null) {
				lines.splice(presetLine, 1);
				process.stdout.write('[permission-preset] 备份记录原值缺失，已删除 defaultPreset 键\n');
			} else {
				const restored = restorable(backup.defaultPreset);
				lines[presetLine] = `    defaultPreset: ${restored}`;
				process.stdout.write(restored === backup.defaultPreset
					? `[permission-preset] defaultPreset 按备份恢复为 ${restored}\n`
					: `[permission-preset] 备份值 ${backup.defaultPreset} 正是本次删除的条目名，改恢复为 ${restored}（否则 permission 行注册失败）\n`);
			}
		} else process.stdout.write(`[permission-preset] defaultPreset 现值 ${presetValue(lines[presetLine])} 非 ${PRESET_ID}/${STANDARD_FALLBACK}，按用户手动设置保留\n`);
		unlinkSync(backupFile);
		process.stdout.write(`[permission-preset] 已删除备份 ${backupFile}\n`);
	} else if (presetLine !== -1 && presetValue(lines[presetLine]) === PRESET_ID) {
		lines[presetLine] = `    defaultPreset: ${STANDARD_FALLBACK}`;
		process.stdout.write(`[permission-preset] 无备份但 defaultPreset 指向已删条目，退到 ${STANDARD_FALLBACK}（否则设置注册会失败）\n`);
	}

	writeAtomic(patchFile, `${lines.join('\n')}\n`, hadBom, eol);
	process.stdout.write(`[permission-preset] --revert 完成：${patchFile}\n`);
}

/**
 * `--init-row`：profile patch 里没有 `permission` 行时，把它的整行重述追加到文件末尾
 * （干净 profile / 从模板新建的 profile 走这一步；老 profile 早已重述过，直接 `--apply`）。
 * 行序无装载语义（base 自己的注释即如此写），故追加在末尾是安全的；已存在则幂等跳过。
 * @param {object} args - 命令行参数。
 * @returns {void}
 */
function initRow(args) {
	const patchFile = join(args.home, 'profiles', args.profile, 'cordis.patch.yml');
	const hadBom = readFileSync(patchFile, 'utf8').startsWith('\uFEFF');
	const raw = readFileSync(patchFile, 'utf8').replace(/^\uFEFF/, '');
	const eol = raw.includes('\r\n') ? '\r\n' : '\n';
	const lines = raw.split(/\r?\n/);
	if (lines.some((line) => /^- id: permission\s*$/.test(line))) {
		process.stdout.write('[permission-preset] permission 行已存在，跳过（幂等）\n');
		process.stdout.write(`[permission-preset] --init-row 完成：${patchFile}\n`);
		return;
	}
	const body = [...lines];
	while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();
	// 官方模板的 patch 正文就是一行 `[]`（空数组文档，见 profiles/*/cordis.patch.yml 模板）：
	// 在它之后续写列表项不是合法 YAML（`end of the stream or a document separator is expected`），
	// 必须先用我们的块**替换**掉那一行。空文档之外的情形（已是块序列）追加即可。
	const emptyDoc = body.findIndex((line) => /^\[\]\s*$/.test(line));
	let next;
	if (emptyDoc !== -1) {
		// `[]` 之后若还有有效内容（非空行、非注释），本脚本无法在不猜结构的前提下合并两份内容——
		// 静默丢弃会毁掉使用者的 patch（2026-09-25 终审抓到的漏洞），故一律报错不落盘。
		const tail = body.slice(emptyDoc + 1).filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
		if (tail.length > 0) {
			throw new Error(`patch 的 \`[]\` 行之后还有 ${tail.length} 行有效内容（首行：${tail[0].trim()}）——本脚本不猜结构、不会替你合并，请手工把 permission 行整段贴到合适位置，或先删掉那行 \`[]\``);
		}
		const head = body.slice(0, emptyDoc);
		while (head.length > 0 && head[head.length - 1].trim() === '') head.pop();
		next = [...head, '', ...ROW_LINES, ''].join('\n');
		process.stdout.write('[permission-preset] 原 patch 是空数组文档 `[]`，已用整行重述替换该行');
	} else {
		next = [...body, '', ...ROW_LINES, ''].join('\n');
		process.stdout.write('[permission-preset] 原 patch 是块序列，已把整行重述追加到末尾');
	}
	writeAtomic(patchFile, next, hadBom, eol);
	process.stdout.write(`（${ROW_LINES.length} 行，三档与 dsh-base 一致）\n`);
	process.stdout.write(`[permission-preset] --init-row 完成：${patchFile}\n`);
}

try {
	const args = parseArgs(process.argv.slice(2));
	if (args.mode === '--apply') applyPreset(args);
	else if (args.mode === '--init-row') initRow(args);
	else revertPreset(args);
} catch (error) {
	process.stderr.write(`[permission-preset] 失败（未落盘）：${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
}
