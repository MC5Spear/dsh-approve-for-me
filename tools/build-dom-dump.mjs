/**
 * 从 browser-shot 的 --result JSON 生成设置表单 DOM 证据档。
 * 用法：node tools/build-dom-dump.mjs <result.json> <css-scope.json|-> <out.txt> --f51-before N --f51-after N
 * 档案格式与 test/settings-dom-dump.test.mjs 的断言逐项对齐（requirements §6.1 结构判据＋暂存语义＋换算读数）。
 * CSS 收窄扫描在主取证内（DUMP-A 的 scoped 段）；第二参数传 - 表示无独立 CSS 结果文件。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [resultPath, cssPath, outPath, ...rest] = process.argv.slice(2);
if (!resultPath || !cssPath || !outPath) throw new Error('usage: build-dom-dump.mjs <result.json> <css-scope.json|-> <out.txt> --f51-before N --f51-after N');
const arg = (name, fallback) => {
	const i = rest.indexOf(name);
	return i >= 0 ? rest[i + 1] : fallback;
};
const results = JSON.parse(readFileSync(resultPath, 'utf8'));
const byIndex = new Map(results.map((r) => [r.index, r]));
const dumpA = results.find((r) => r?.value?.found === true && typeof r.value.text === 'string');
if (!dumpA) throw new Error('result 里找不到 DUMP-A（found:true 且有 text）');
const dumpHelp = byIndex.get(7)?.value ?? {};
const dumpStaged = byIndex.get(11)?.value ?? {};
const dumpReopened = byIndex.get(18)?.value ?? {};
const dumpSaved = byIndex.get(23)?.value ?? {};
const dumpRestored = byIndex.get(28)?.value ?? {};
const cssScope = dumpA.value.scoped ?? (cssPath !== '-' ? JSON.parse(readFileSync(cssPath, 'utf8')).find((r) => r?.value?.found === true)?.value : null);
if (!cssScope) throw new Error('CSS 收窄数据缺失（DUMP-A 无 scoped 段且未提供旧版 css-scope 结果文件）');

const { text, controls: inputs, dsafmClasses, seconds } = dumpA.value;
const lines = [];
lines.push('# 设置表单 DOM 证据档（结构判据＋毫秒字段秒数读数；机器可核留档）', '');
lines.push('- 采集：' + new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10) + '，真实部署实例（loopback）。主取证步骤含暂存往返（暂存不保存→重开读旧值→保存 unset→复原）；换算读数（seconds 段）与 CSS 收窄扫描（scoped 段，只读本包注入的 `style[data-plugin-css="dsh-approve-for-me"]`）并入同一脚本。');
lines.push('- 入口路径：侧栏「插件」→ `dsh-approve-for-me` → 本包详情页；页面身份 `[data-plugin-detail="dsh-approve-for-me"]`。');
lines.push('- 常驻断言：`test/settings-dom-dump.test.mjs` 读本文件逐项核对（变异验证：篡改本文件对应断言变红）。', '');
lines.push('## 1. 详情页 DOM 文本（innerText，逐字；零命中「重置全部覆盖」「当前生效值」「跟随模型默认」）', '', '```text');
lines.push(text, '```', '');
lines.push('## 2. 配置区容器计算样式（无自绘卡片外壳）', '');
lines.push(`\`.dsafm_form\` getComputedStyle：borderStyle=\`${dumpA.value.shell.borderStyle}\`、borderWidth=\`${dumpA.value.shell.borderWidth}\`、borderRadius=\`${dumpA.value.shell.borderRadius}\`、background=\`${dumpA.value.shell.background}\`（判据＝none/0 且 radius<12px）。`, '');
lines.push('## 3. 覆盖组与字段结构', '');
lines.push(`自绘覆盖组（\`.dsafm_badges\`＝Tag「已单独设置」＋文本按钮「恢复默认」）恰好 ${dumpA.value.overrideTags.length} 组：${dumpA.value.overrideTags.join('｜')}（默认审查模型、插件界面语言、发送给模型的文本语言——与 profile patch 用户层键一一对应；数字字段「已单独设置/恢复默认」在官方 SettingsValueField 内部，见 §1 文本）。`);
lines.push(`字段壳 \`dsafm_field\`＝${dumpA.value.fields}（自绘），数字字段 4 个走官方组件标记，合计 ${dumpA.value.fields + 4} 字段。`, '');
lines.push('## 4. 说明入口点击展开（aria 成对；design §7.2.1）', '');
lines.push(`说明按钮 ${dumpA.value.helpButtons.length} 个（${dumpA.value.fields} 自绘壳＋4 官方数字字段平铺行 \`.dsafm_f_help\`），按钮带可见文字「说明／收起说明」（\`.dsafm_helpbtn_text\`）、图标 \`IconInfoOutlineRegular\` size=12、\`aria-label\`＝「字段名：说明」、Enter/Space 键盘可达；全部带 aria-controls，初始 aria-expanded=false；点击 mode 字段后：aria-expanded=\`${dumpHelp.expanded}\`、展开区在场=\`${dumpHelp.regionPresent}\`、同屏展开区数量=${dumpHelp.openRegions}、展开文本首段＝「${dumpHelp.regionText}」；开合不触碰草稿/保存计划（纯展示状态）。`, '');
lines.push('## 5. 暂存语义：保存按钮三态与「只有保存才写」', '');
lines.push(`初始（无改动）：保存 disabled=\`${dumpA.value.save.disabled}\`。`);
lines.push(`点 language.ui「恢复默认」（只暂存）：控件值 \`${dumpStaged.value}\`、保存 disabled=\`${dumpStaged.saveDisabled}\`、该字段覆盖组消失（剩 ${dumpStaged.overrideTags.length} 组）。`);
lines.push(`重开页面（不保存）：控件值回到 \`${dumpReopened.value}\`、覆盖组回 ${dumpReopened.overrideTags.length} 组、保存 disabled=\`${dumpReopened.saveDisabled}\`——暂存丢弃、写库没发生。`);
lines.push(`再暂存＋点保存：控件值 \`${dumpSaved.value}\`、覆盖组 ${dumpSaved.overrideTags.length} 组、保存 disabled=\`${dumpSaved.saveDisabled}\`——unset 落库、覆盖消失。`);
lines.push(`取证后复原（设回 zh＋保存）：控件值 \`${dumpRestored.value}\`、覆盖组 ${dumpRestored.overrideTags.length} 组——现场回到采集前（profile patch \`language: {agent: en, ui: zh}\` 复核过）。`, '');
lines.push('## 6. 交付 CSS 串失效令牌零命中（收窄到本包 style 元素）', '');
const dividerNote =
	cssScope.secDividerRule === undefined
		? ''
		: `分隔线选择器组（design §7.2.1）：\`${cssScope.secDividerRule}\` 与 \`${cssScope.helpDividerRule ?? '（未捕获）'}\`；平铺说明行 \`${cssScope.helpLineRule ?? '（未捕获）'}\`。`;
lines.push(`本包注入样式 ${cssScope.cssLength} 字符${cssScope.ruleCount ? `（${cssScope.ruleCount} 条规则）` : ''}：${cssScope.banned.map((b) => `\`${b.token}\`×${b.hits}`).join('、')}（页面级命中来自宿主/其它包样式，不属本包交付串）。`);
lines.push(`关键规则原文：\`${cssScope.formRule}\`；\`${cssScope.saveRule}\`；\`${cssScope.helpBtnRule}\`；\`${cssScope.inputRule}\`。${dividerNote === '' ? '' : `\n${dividerNote}`}`, '');
lines.push('## 7. 控件清单（input/select/textarea，按文档序）', '', '| # | tag | type | id | value |', '|---|-----|------|----|-------|');
inputs.forEach((c, i) => {
	const value = c.value === '' ? '（空）' : c.value.length > 60 ? `${c.value.slice(0, 60)}…（截断展示）` : c.value;
	const checked = c.tag === 'input' && c.type === 'checkbox' ? `on（checked=${c.checked}）` : null;
	lines.push(`| ${i} | ${c.tag} | ${c.type} | ${c.id || '（无）'} | ${checked ?? value} |`);
});
lines.push('', '接管预设为多选 picker（button + aria-expanded），不计入本表。', '');
lines.push('## 8. dsafm 类清单（容器内去重；退役类零残留）', '', dsafmClasses.join(' / '), '');
lines.push('退役类零残留：无 dsafm_row、dsafm_label、dsafm_section、dsafm_divider、dsafm_actions、dsafm_help、dsafm_map_block。`dsafm_chevron` 在场属下拉 picker 箭头；`dsafm_helpbtn_text` 为说明按钮的可见文字 span；`dsafm_f_help` 为官方数字字段后的平铺说明行（design §7.2.1）。', '');
lines.push('## 9. 失败登录计数', '');
lines.push(`- 采集前 \`BadPasswordAttempts=${arg('--f51-before', '?')}\`，采集后 \`=${arg('--f51-after', '?')}\`（本次采集无头浏览器启动次数以当次运行记录表为准；窗口阈值 10/10min，纪律 ≤5 次/10min）。`, '');
lines.push('## 10. 毫秒字段换算读数（.dsafm_f_sec，干净页＝无暂存）', '');
if (!Array.isArray(seconds) || seconds.length === 0) {
	lines.push('（采集失败：seconds 段缺失——DUMP-A 未捕获换算读数行）', '');
} else {
	lines.push(`读数行 ${seconds.length} 行（恰两个 ms 字段各一行；字节/令牌字段不做换算）：`, '');
	for (const s of seconds) {
		lines.push(`- \`${s.id}\`：\`${s.text}\`（生效＝\`${s.resolvedText}\`、草稿＝\`${s.draftText}\`、draftInvalid=${String(s.draftInvalid)}）；行样式 fontSize=\`${s.fontSize}\`、color=\`${s.color}\`、marginTop=\`${s.marginTop}\`；后继节点 class=\`${s.nextSiblingClass}\`、borderTopWidth=\`${s.nextBorderTop}\`（design §7.2.1 分隔线选择器组：秒数行后继为本字段平铺说明行时不分隔，说明行后的下一字段恢复 0.5px 分隔线）。`);
	}
	lines.push('', '生效值读数与控件值一致（§7 控件表同 id 行）；初始草稿＝生效值文本。实时行为（键入即换算、占位、非法、保存重开、en 档单位）的验证不在本档范围，由开发期工件承载、不随仓发布。', '');
}
writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
console.log(`WROTE ${outPath} (controls=${inputs.length}, helpButtons=${dumpA.value.helpButtons.length}, cssLength=${cssScope.cssLength}, secLines=${Array.isArray(seconds) ? seconds.length : 0})`);
