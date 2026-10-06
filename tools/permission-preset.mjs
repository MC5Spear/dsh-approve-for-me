#!/usr/bin/env node
/**
 * 「自动审批」预设条目的部署脚本（R26 / 设计 §14.1；R57 起降位为**存量部署**的回收通道——
 * 0.2.0 及此前本脚本写过 profile 层重述，新机制（随包 bundle patch，设计 §28）部署不再需要它）。
 *
 * 为什么必须插件自带脚本（0.1.7 立项理由，层序认知已过时、回收使命仍在）：写入侧的
 * 「第三方 bundle 层命中不了 permission 行」判断只对 0.1.7 成立；但**回收侧**的理由始终成立——
 * `dsh plugin remove` 是另一个进程、不执行任何插件代码，profile 层的存量重述只有这条零依赖
 * 命令能收（只 import node:* 与相对路径，删光 node_modules 后也要能跑）。
 *
 * 语义（锚点式文本编辑，不解析 YAML——不猜结构；实现住在 lib/permission-preset.js）：
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
 *             新机制部署想回到纯 bundle 形态时，用它回收 profile 层的存量重述。
 *
 * 锚点缺失（找不到 permission 行 / presets 块 / 两个邻接条目）一律报错退出、不落盘。
 * 写回：UTF-8 无 BOM（原文件带 BOM 则保留）、原子写（同目录临时文件 + rename）。
 *
 * 用法：node tools/permission-preset.mjs [--init-row|--apply|--revert] [--home <dir>] [--profile <name>]
 * @module dsh-approve-for-me/tools/permission-preset
 */
import { join } from 'node:path';
import { applyPreset, initRow, revertPreset } from '../lib/permission-preset.js';

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

try {
	const args = parseArgs(process.argv.slice(2));
	// 路径换算（设计 §14.1）：`$DSH_HOME/profiles/<profile>/cordis.patch.yml` 与共享备份文件。
	const patchFile = join(args.home, 'profiles', args.profile, 'cordis.patch.yml');
	const backupFile = join(args.home, 'approve-for-me', 'permission-grant.json');
	if (args.mode === '--apply') applyPreset(patchFile, backupFile);
	else if (args.mode === '--init-row') initRow(patchFile);
	else revertPreset(patchFile, backupFile);
} catch (error) {
	process.stderr.write(`[permission-preset] 失败（未落盘）：${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
}
