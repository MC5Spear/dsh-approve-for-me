/**
 * 回归测试：设置界面 DOM dump 留档（夹具 test/fixtures/settings-dom-dump.txt）。
 *
 * 判定口径（requirements §6.1；实测口径 design §10.3）：0.1.7 上宣称成立的条目必须以真实实例实测为准；
 * 可用性判据是本包详情页的页面 DOM 与计算样式（注入表命中不算）。
 * 本测试把采集的 dump 变成常驻断言：结构判据（requirements §6.1）的回归（重置按钮回潮、覆盖组丢失、
 * 保存按钮启用状态失守、卡片外壳回潮、帮助折叠回潮、失效令牌混入）与毫秒换算读数
 * （读数行丢失、生效值与控件值脱钩、样式漂移）都在这里先红。
 * 结构断言抓不到取值整片为空——字段取值逐项等于生效值的核对在此常驻
 * （decode 失败→snapshot.value 空→每个控件值不匹配→红）。
 *
 * 能失败性：①正向对照——匹配器能命中已知在场字段；②反例——表单不该出现的字段
 * （如「系统提示词」，从未是 config schema 字段）必须不命中；③变异验证——临时篡改
 * dump 文件内容（如 disabled=`true`→`false`、恰好 3 组→2 组）对应断言变红，还原后复绿。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeConfig } from '../lib/config.js';

const DUMP_PATH = join(import.meta.dirname, 'fixtures', 'settings-dom-dump.txt');
const dump = readFileSync(DUMP_PATH, 'utf8');

/** 字段级匹配器：按行精确匹配标签行（与采集时 innerText 行结构一致）。 */
function hasLine(label) {
  return dump.split('\n').some((line) => line.trim() === label);
}

/** 取「标签行 → 已单独设置/恢复默认」的邻接读数（覆盖组紧跟标签行与说明按钮，§1 逐字文本）。 */
function hasOverrideNear(label, maxDistance = 3) {
  const lines = dump.split('\n').map((l) => l.trim());
  const idx = lines.indexOf(label);
  if (idx === -1) return false;
  return lines.slice(idx + 1, idx + 1 + maxDistance).includes('已单独设置') && lines.slice(idx + 1, idx + 1 + maxDistance).includes('恢复默认');
}

test('dump 留档存在且含页面身份与采集元数据', () => {
  assert.ok(dump.length > 1500, 'dump 过短，疑似截断或误删');
  assert.match(dump, /data-plugin-detail="dsh-approve-for-me"/u, '页面身份应为 bundle 级 data-plugin-detail');
  assert.match(dump, /CSS 收窄扫描（scoped 段，只读本包注入的 `style\[data-plugin-css="dsh-approve-for-me"\]`）并入同一脚本/u, 'CSS 收窄扫描并入主取证脚本（scoped 段）');
  assert.match(dump, /style\[data-plugin-css="dsh-approve-for-me"\]/u, '扫描口径应收窄到本包注入样式');
  // 来源可追性：夹具必须交代自己是怎么来的。采集工具链随仓发布（tools/browser-shot.mjs 驱动、
  // tools/build-dom-dump.mjs 汇编），档里点名；步骤场景脚本属开发期工件、不随仓发布。
  assert.match(dump, /采集工具链随仓发布（`tools\/browser-shot\.mjs` 驱动取证、`tools\/build-dom-dump\.mjs` 汇编成档）/u, '夹具须声明采集来源口径');
});

/** §1 的逐字页面文本（```text 围栏内）——零命中断言只针对页面本体，不扫元数据。 */
const pageText = (() => {
  // 行尾容忍：仓库里存的是 LF，检出时可能被 core.autocrlf 转成 CRLF；围栏解析两种行尾都认。
  // 这类「只在自己机器上绿」的缺陷正是干净检出验证要抓的缺陷形态。
  const match = /```text\r?\n([\s\S]*?)\r?\n```/u.exec(dump);
  return match === null ? '' : match[1].replace(/\r\n/gu, '\n');
})();

test('退役件零命中——重置全部覆盖、当前生效值、分区标题、旧操作区', () => {
  // 反恒真防线：围栏解析失败时 pageText 为空串，零命中断言会恒绿——先证明文本块真的取到了。
  assert.ok(pageText.includes('启用自动审批的权限预设') && pageText.includes('保存'), '§1 逐字文本块缺失或为空（围栏解析失败会让零命中断言恒真）');
  assert.equal(pageText.includes('重置全部覆盖'), false, '「重置全部覆盖」应零命中');
  assert.equal(pageText.includes('当前生效值'), false, '「当前生效值」灰字行应零命中');
  // 退役话术防回潮：页面文本零命中。
  assert.equal(pageText.includes('跟随模型默认'), false, '「跟随模型默认」应零命中（effort.default＝自动选择）');
  assert.equal(pageText.includes('已覆盖'), false, '「已覆盖」应零命中（card.override＝已单独设置）');
  assert.equal(pageText.includes('主模型'), false, '「主模型」用户可见字样应零命中（执行助手模型）');
  assert.equal(pageText.includes('档位'), false, '「档位」用户可见字样应零命中（推理强度）');
  assert.equal(pageText.includes('跳过（不接管）'), false, '旧选项文案「跳过（不接管）」应零命中');
  // 分区标题退役：正文里不得出现独立的「触发」「高级」行（「审查模型」是映射表列头，按类清单判）。
  assert.equal(hasLine('触发'), false, '分区标题「触发」应退役');
  assert.equal(hasLine('高级'), false, '分区标题「高级」应退役');
  const classLine = dump.split('\n').find((l) => l.trim().startsWith('dsafm_form /'));
  assert.ok(classLine, '找不到类清单行（应以 dsafm_form / 开头）');
  const classTokens = classLine.trim().split(' / ').map((token) => token.split('.')[0]);
  for (const gone of ['dsafm_row', 'dsafm_label', 'dsafm_section', 'dsafm_divider', 'dsafm_actions', 'dsafm_help']) {
    assert.equal(classTokens.includes(gone), false, `退役类残留于类清单：${gone}`);
  }
});

test('逐项等价：表单字段集与 config schema 的 UI 字段集一致（20 字段，竖排无分区）', () => {
  const fields = [
    '启用自动审批的权限预设',
    '无法识别权限预设时',
    '逐条记录预设不匹配的审批',
    '默认审查模型',
    '按执行助手的模型选择审查模型',
    '插件界面语言',
    '发送给模型的文本语言',
    '自动审查等待上限（毫秒）',
    '审查输出上限（token）',
    '审查期间显示人工审批卡片',
    '人工作答等待上限（毫秒）',
    '人工作答等待起算点',
    '模式',
    '可自动批准的最高权限',
    '无法识别本次操作时',
    '自动审查未允许时',
    '给执行助手的审批通知',
    '通知长度上限（字节）',
    '纳入自动审批的工具',
    '文本拒绝规则（每行一条正则表达式）',
  ];
  const missing = fields.filter((f) => !hasLine(f));
  assert.deepEqual(missing, [], '设置表单丢字段（对照 lib/config.js 的 UI 字段集）');
  assert.ok(hasLine('保存'), '唯一保存按钮缺失');
  // followParent 字段不出现在页面文本：零命中是字段集一致的一部分。
  assert.equal(pageText.includes('无可用审查模型时使用执行助手的模型'), false, 'followParent 字段标签应零命中（design §7.2 20 字段）');
  assert.equal(hasLine('作用范围'), true, '映射表头应含作用范围列（五列结构化规则表）');
  assert.match(dump, /字段壳 `dsafm_field`＝16/u, '自绘字段壳应 16 个');
  assert.match(dump, /数字字段 4 个走官方组件标记，合计 20/u, '20 字段＝16 自绘壳＋4 官方数字字段');
});

test('覆盖组「已单独设置＋恢复默认」与用户层键一一对应', () => {
  assert.match(dump, /恰好 3 组/u, '自绘覆盖组应恰好 3 组（reviewer.model/language.ui/language.agent）');
  // 自绘字段：标签行后 3 行内出现「说明」「已单独设置」与「恢复默认」。
  for (const label of ['默认审查模型', '插件界面语言', '发送给模型的文本语言']) {
    assert.ok(hasOverrideNear(label), `${label} 缺覆盖组`);
  }
  // 数字字段：覆盖组在官方 SettingsValueField 内部（§1 文本仍逐字可见）。
  // human.timeoutMs 无用户层键（profile 的 human 为空节，300000＝默认值），
  // 官方组件内覆盖组只剩 reviewer.timeoutMs 一处。
  for (const label of ['自动审查等待上限（毫秒）']) {
    assert.ok(hasOverrideNear(label, 3), `${label} 缺官方组件内的覆盖组`);
  }
  // 未覆盖字段不得误报：无用户层键的字段旁不得出现覆盖组。
  assert.equal(hasOverrideNear('模式'), false, 'mode 无用户层键，不应有覆盖组');
  assert.equal(hasOverrideNear('人工作答等待起算点'), false, 'human.timeoutFrom 无用户层键，不应有覆盖组');
  assert.equal(hasOverrideNear('人工作答等待上限（毫秒）'), false, 'human.timeoutMs 无用户层键（profile 的 human 为空节，300000＝默认值），不应有覆盖组');
});

test('暂存语义：保存按钮三态与「只有保存才写」的行为差异', () => {
  assert.match(dump, /初始（无改动）：保存 disabled=`true`/u, '初始应置灰');
  assert.match(dump, /点 language\.ui「恢复默认」（只暂存）：控件值 `auto`、保存 disabled=`false`/u, '暂存后应可点');
  assert.match(dump, /重开页面（不保存）：控件值回到 `zh`、覆盖组回 3 组、保存 disabled=`true`——暂存丢弃、写库没发生/u, '重开读旧值＝没写库');
  assert.match(dump, /再暂存＋点保存：控件值 `auto`、覆盖组 2 组、保存 disabled=`true`——unset 落库、覆盖消失/u, '保存才落库');
  assert.match(dump, /取证后复原（设回 zh＋保存）：控件值 `zh`、覆盖组 3 组/u, '取证后现场应复原');
});

test('配置区容器无自绘卡片外壳（计算样式）', () => {
  assert.match(dump, /borderStyle=`none`/u, 'border-style 应为 none');
  assert.match(dump, /borderWidth=`0px`/u, '边框宽度应为 0');
  assert.match(dump, /borderRadius=`0px`/u, '圆角应 <12px（实测 0）');
  assert.match(dump, /background=`rgba\(0, 0, 0, 0\)`/u, '不应有成片底色');
});

test('说明入口（§7.2.1）：20 个按钮带可见文字，aria 成对，展开文本为新总开关文案', () => {
  assert.match(dump, /说明按钮 20 个（16 自绘壳＋4 官方数字字段平铺行 `\.dsafm_f_help`）/u, '说明按钮应 20 个（含数字字段平铺行）');
  assert.match(dump, /按钮带可见文字「说明／收起说明」（`\.dsafm_helpbtn_text`）/u, '说明按钮应带可见文字');
  assert.match(dump, /`aria-label`＝「字段名：说明」、Enter\/Space 键盘可达/u, '无障碍名格式与键盘可达应在档');
  assert.match(dump, /点击 mode 字段后：aria-expanded=`true`、展开区在场=`true`、同屏展开区数量=1/u, '点击后应展开且仅展开一个');
  assert.match(dump, /展开文本首段＝「总开关：规则检查＋LLM 审查＝正常接管；完全不接管＝等同未安装，宿主审批流程不受影响。」/u, '展开文本应为定稿总开关文案（design §7.2.1）');
  assert.match(dump, /开合不触碰草稿\/保存计划（纯展示状态）/u, '开合纯展示语义应在档');
  // §1 逐字文本：每个字段名行后紧跟「说明」按钮文字（20 处＝20 字段）。
  assert.equal((pageText.split('\n').filter((l) => l.trim() === '说明').length), 20, '§1 中「说明」按钮文字应恰 20 处');
});

test('交付 CSS 串失效令牌零命中（收窄到本包 style 元素）；长度与规则数对账实算', () => {
  assert.match(dump, /`--dsw-alias-state-warning-primary`×0、`--dsw-alias-label-error`×0、`--dsw-alias-bg-layer-4`×0/u, '三个失效令牌应零命中');
  // 数字不自证：fixture 声称的字符数与规则数必须与 client.js CSS 块实算一致——
  // 同一口径＝取 `const CSS = [...]` 数组、`join("")` 后的注入串长度与数组元素数（含 @media 整条计 1）。
  const clientSource = readFileSync(join(import.meta.dirname, '..', 'client.js'), 'utf8');
  const cssAt = clientSource.indexOf('const CSS = [');
  assert.ok(cssAt !== -1, 'client.js 应有 CSS 数组');
  const cssEnd = clientSource.indexOf('].join("")', cssAt);
  assert.ok(cssEnd !== -1, 'CSS 数组应 join 为注入串');
  const cssRules = new Function(`return ${clientSource.slice(cssAt + 'const CSS = '.length, cssEnd + 1)}`)();
  const cssLength = cssRules.join('').length;
  const claimed = new RegExp(`本包注入样式 (\\d+) 字符（(\\d+) 条规则）`).exec(dump);
  assert.ok(claimed !== null, 'fixture 应声明注入样式字符数与规则数');
  assert.equal(Number(claimed[1]), cssLength, `fixture 字符数应与实算一致（实算 ${cssLength}）`);
  assert.equal(Number(claimed[2]), cssRules.length, `fixture 规则数应与实算一致（实算 ${cssRules.length}）`);
  assert.match(dump, /\.dsafm_form\{display:flex;flex-direction:column;/u, '外壳规则应无边框/圆角/底色');
  assert.match(dump, /\.dsafm_save\{[^}]*border-radius:8px;padding:5px 14px;/u, '保存按钮应取官方规格');
  assert.match(dump, /\.dsafm_helpbtn\{[^}]*min-width:24px;min-height:24px;/u, '说明按钮应为 24×24 最小命中区（文字按钮，design §7.2.1）');
  assert.match(dump, /\.dsafm_input\{[^}]*height:34px;padding:0 12px;border:\.5px solid var\(--dsw-alias-border-l4\);border-radius:8px;/u, '输入应取官方规格');
  // 分隔线选择器组（design §7.2.1）：两条规则原文在档，且在实算注入串中原样在场（档案↔源码双向对账）。
  assert.match(dump, /\.dsafm_f_sec \+ div:not\(\.dsafm_field\):not\(\.dsafm_f_help\)\{border-top:\.5px solid var\(--dsw-alias-border-l2\)\}/u, '秒数行后继排除说明行');
  assert.match(dump, /\.dsafm_f_help \+ div:not\(\.dsafm_field\)\{border-top:\.5px solid var\(--dsw-alias-border-l2\)\}/u, '说明行作锚恢复分隔线');
  assert.match(dump, /\.dsafm_f_help\{margin:-12px 0 12px\}/u, '平铺说明行负边距应在档');
  assert.ok(cssRules.join('').includes('.dsafm_f_help{margin:-12px 0 12px}'), '平铺说明行规则应在实算注入串中');
});

test('控件清单：生效值就在控件里，id 挂在控件上', () => {
  for (const row of [
    '| 4 | select | select-one | approve-for-me-ctl-language-ui | zh |',
    '| 5 | select | select-one | approve-for-me-ctl-language-agent | en |',
    '| 2 | select | select-one | approve-for-me-ctl-reviewer-model | zai/glm-5.3-flash |',
    '| 6 | input | text | approve-for-me-ctl-reviewer-timeoutMs | 300000 |',
    '| 9 | input | text | approve-for-me-ctl-human-timeoutMs | 300000 |',
    '| 11 | select | select-one | approve-for-me-ctl-mode | rules |',
  ]) {
    assert.ok(dump.includes(row), `控件表缺行：${row}`);
  }
  assert.match(dump, /接管预设为多选 picker（button \+ aria-expanded），不计入本表/u, 'picker 不应计入 input 清单');
  assert.equal(dump.includes('reviewer-followParent'), false, 'followParent 控件行应随字段退役');
});

// ── 取值逐项等于生效值（结构断言抓不到整片为空） ─────────────────────────────
// 夹具＝真实部署的 profile patch 的 approve-for-me 用户层逐字（cordis.patch.yml :129-143）。
const REAL_PROFILE = {
  reviewer: { model: { model: 'zai/glm-5.3-flash', effort: 'high' }, timeoutMs: 300000 },
  human: {},
  ui: { trace: { capture: 'full' } },
  language: { ui: 'zh', agent: 'en' },
};
/** 控件 id 尾段 → 生效值路径（与 client.js 的 ctl id 命名一一对应；followParent 已退役）。 */
const CTL_PATHS = {
  'trigger-unknown': 'trigger.unknown',
  'trigger-auditEverySkip': 'trigger.auditEverySkip',
  'reviewer-model': 'reviewer.model',
  'language-ui': 'language.ui',
  'language-agent': 'language.agent',
  'reviewer-timeoutMs': 'reviewer.timeoutMs',
  'reviewer-maxTokens': 'reviewer.maxTokens',
  'ui-humanCardDuringReview': 'ui.humanCardDuringReview',
  'human-timeoutMs': 'human.timeoutMs',
  'human-timeoutFrom': 'human.timeoutFrom',
  mode: 'mode',
  allowEscalationTo: 'allowEscalationTo',
  unknownSubject: 'unknownSubject',
  fallback: 'fallback',
  'ui-inject': 'ui.inject',
  'ui-injectMaxBytes': 'ui.injectMaxBytes',
  tools: 'tools',
  denyPatterns: 'denyPatterns',
};

test('控件取值逐项等于生效值（profile 用户层＋默认合并的产物）', () => {
  const effective = normalizeConfig(REAL_PROFILE);
  const at = (path) => path.split('.').reduce((node, key) => node?.[key], effective);
  const rows = [...dump.matchAll(/^\| \d+ \| (\w+) \| [\w-]+ \| approve-for-me-ctl-([\w.-]+) \| (.+) \|$/gmu)];
  // 反恒真防线：先证明控件表真的解析到了行（恰 18 行带 id 控件＝19 控件减 1 个无 id 的 effort 子选择器，
  // followParent 复选框随字段退役；丢行会让后续对账漏项，行数不等即红）。
  assert.equal(rows.length, 18, `控件表解析行数应为 18（实得 ${rows.length}），围栏或表头漂移会让后续断言漏项`);
  for (const [, tag, suffix, cell] of rows) {
    const path = CTL_PATHS[suffix];
    assert.ok(path, `未知控件 id：${suffix}（CTL_PATHS 需同步 client.js 的字段集合）`);
    let expected = at(path);
    if (/^on（checked=(true|false)）$/u.test(cell)) {
      // checkbox 显示 on（checked=true）。
      assert.equal(cell.includes(`checked=${String(expected)}`), true, `${suffix} 取值应等于生效值 ${expected}`);
      continue;
    }
    if (tag === 'textarea') {
      // 名单类字段：数组按行渲染，空数组显示（空）。
      const cellText = cell === '（空）' ? '' : cell;
      assert.equal(cellText, Array.isArray(expected) ? expected.join('\n') : String(expected), `${suffix} 取值应等于生效值`);
      continue;
    }
    // select：reviewer-model 的生效值是 { model, effort } 对象，控件显示 model 串。
    if (typeof expected === 'object' && expected !== null) expected = expected.model;
    assert.equal(cell, String(expected), `${suffix}（${path}）取值应等于生效值 ${JSON.stringify(expected)}，实得 ${cell}`);
  }
});

test('失败登录计数在阈值内留档', () => {
  assert.match(dump, /采集前 `BadPasswordAttempts=未读`，采集后 `=未读`/u, '失败登录计数应留档（Get-LocalUser 的 BadPasswordAttempts 非提升与提升查询均返回 null，如实留档未读；无头 Edge 启动次数以 shots-manifest 记录表为准）');
});

test('毫秒字段换算读数常驻（生效值＝控件值、样式与分隔线恢复）', () => {
  // 读数行恰两行，且生效值读数与 §7 控件表同字段值一致（300000→300 秒 ×2）。
  assert.match(dump, /读数行 2 行（恰两个 ms 字段各一行；字节\/令牌字段不做换算）/u, '读数行应恰 2 行');
  for (const row of [
    '`approve-for-me-sec-reviewer-timeoutMs`：`生效：300 秒 · 草稿：300 秒`（生效＝`生效：300 秒`、草稿＝`草稿：300 秒`、draftInvalid=false）',
    '`approve-for-me-sec-human-timeoutMs`：`生效：300 秒 · 草稿：300 秒`（生效＝`生效：300 秒`、草稿＝`草稿：300 秒`、draftInvalid=false）',
  ]) {
    assert.ok(dump.includes(row), `换算读数行缺失或漂移：${row}`);
  }
  // 行样式与官方 .hint 同规格：12px／三级色；上边距 -12px 抵官方字段底 padding（贴住说明行），
  // 下边距 12px 还给后继分隔线（同官方字段底部节奏）。
  assert.match(dump, /fontSize=`12px`、color=`rgb\(129, 133, 140\)`、marginTop=`-12px`/u, '读数行应为 12px 三级色＋-12px 负边距（贴住说明行不隔行）');
  // Fragment 平铺＋平铺说明行（design §7.2.1）：秒数行的后继是本字段的说明行（无边框）；
  // 说明行之后才恢复分隔线（官方字段容器 1px；自绘字段 1px）。宿主 CSS 模块哈希随宿主版本变化
  // （ui-primitives 改版后为 `_field_bjqpo_3`，0.2.0-rc.2 实测未变）；宿主升级后复核本档 DOM。
  assert.match(dump, /后继节点 class=`dsafm_f_help`、borderTopWidth=`0px`/u, '秒数行的直接后继是平铺说明行，不分隔');
  assert.match(dump, /class=`_field_bjqpo_3`、borderTopWidth=`1px`/u, '说明行后的官方字段应恢复分隔线');
  assert.match(dump, /class=`dsafm_field`、borderTopWidth=`1px`/u, '说明行后的自绘字段应恢复分隔线');
  // 实时性取证指针在档。
  assert.match(dump, /实时性（键入即换算、占位、非法、保存重开、en 档单位）见/u, '实时性取证指针应在档');
});

test('反恒真对照：匹配器能命中（正向）、表单无幽灵字段（反向）', () => {
  // 正向对照：同一匹配器命中确定在场的行——证明匹配器本身没有恒真/恒假。
  assert.ok(hasLine('启用自动审批的权限预设'), '正向对照失败：匹配器连在场字段都找不到');
  // 反向：这些从未是 config 字段，出现在表单上反而说明漂移。
  assert.equal(hasLine('系统提示词'), false, '「系统提示词」不是 config 字段，表单出现即为漂移');
  assert.equal(dump.includes('Tooltip'), false, '设置界面不应再出现 Tooltip（帮助改为内联展开）');
});
