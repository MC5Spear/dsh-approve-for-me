/**
 * dsh-approve-for-me — client 半（单文件，工厂式 CJS）。
 *
 * 加载器只提供 `react` / `react/jsx-runtime` 等模块表里的包名，相对路径 `require` 会抛错，
 * 因此三个挂点（composer 的审查模型下拉、设置页卡片、审批卡片 body 的自动审批状态条）都在同一个 factory 闭包内实现。
 * 卡片外壳（「等待审批」条与两个按钮）仍由宿主渲染；插件只接管 body 里的 `conversation.approval.detail`，
 * 并自己渲染关联命令以保证非接管预设下的观感不变（design §7.1）。
 */
window.__ModuleLoader__.load({
	id: "dsh-approve-for-me",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const jsxRuntime = require("react/jsx-runtime");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		/**
		 * 14px 下箭头（内联 SVG）。
		 *
		 * 为什么不用 `primitives.IconChevronDownOutline14`：0.1.7 把图标改成尺寸变体命名
		 * （`IconChevronDownOutline` + `Regular`/`Medium`/`Artwork` 后缀），旧名在宿主里**不存在**，
		 * `jsx(undefined)` 直接触发 React #130「Element type is invalid」，
		 * 结果是槽条目整条崩溃、页面静默空白（实测：`slot entry crashed in 'plugins.row.config'`）。
		 * 图标名跨版本不稳定，自带两个内联 SVG 更可靠（design §7.1）。
		 * @param {object} props - `className`。
		 * @returns {object} SVG 元素。
		 */
		const ChevronDownIcon = ({ className }) =>
			jsxRuntime.jsx("svg", {
				className,
				width: 14,
				height: 14,
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": "true",
				children: jsxRuntime.jsx("path", {
					d: "M4 6.2 8 10.2 12 6.2",
					stroke: "currentColor",
					strokeWidth: 1.4,
					strokeLinecap: "round",
					strokeLinejoin: "round",
				}),
			});

		/** 设置命名空间（＝宿主行 id，0.1.7 起即设置命名空间）。 */
		const NS = "approve-for-me";
		/** 包名；Plugins 页 keyed 槽的键是 `<包名>#<行id>`）。 */
		const PACKAGE_NAME = "dsh-approve-for-me";
		/** RPC 端点前缀；三个端点共用同一份 TYPERT 清单（design §7.1）。 */
		const RPC_CHANNEL = "/api";

		const zh = {
			"card.unset": "未设置",
			"card.map.parent": "执行助手模型",
			"card.map.add": "添加一行",
			"card.map.remove": "删除",
			"card.map.col.parent": "执行助手模型",
			"card.map.col.reviewer": "审查模型",
			"card.map.col.effort": "推理强度",
			"card.map.col.action": "操作",
			"card.map.custom": "自定义…",
			"card.map.placeholder.parent": "执行助手模型 id",
			"card.field.defaultModel": "默认审查模型",
			"card.field.byParentModel": "按执行助手的模型选择审查模型",
			"card.field.followParent": "无可用审查模型时使用执行助手的模型",
			"card.effort.unsupported": "（模型不支持）",
			"effort.default": "自动选择",
			"card.override": "已单独设置",
			"card.resetField": "恢复默认",
			"card.save": "保存",
			"card.saving": "保存中…",
			"card.failed": "保存失败",
			"card.invalidNumber": "请填数字；留空表示使用默认值。",
			"seconds.resolved": "生效：{v}",
			"seconds.draft": "草稿：{v}",
			"seconds.unit": "秒",
			"warn.noLimit": "风险：审查模型挂起、工具或其他异常可能使请求无限停在自动审批；插件不会自动恢复时限，取消与其他人工路径按各自条件生效。",
			"card.readonly": "当前页面不可写入设置（非 loopback），可用 profile patch 配置。",
			"help.expand": "说明",
			"help.collapse": "收起说明",
			"help.trigger.presets": "会话使用清单内权限预设时，插件按接管规则处理升权审批；其他预设保持宿主原审批流程。清单为空时，任何已知预设都不接管；无法识别的预设按「无法识别权限预设时」的设置处置。选择接管范围不等于授予任意权限。",
			"help.trigger.unknown": "读不到会话权限预设时的处置。保持宿主原审批流程＝不接管；继续自动审查＝视为命中接管范围。可能原因包括服务缺失、读取失败或没有可用预设信息。",
			"help.trigger.auditEverySkip": "开启后，每次因预设不匹配而跳过的审批都逐条记录；关闭时同一会话同一原因只记录一条。只改变跳过记录的数量，不影响接管与审批本身，也不表示所有审批都被审查。",
			"help.reviewer.byParentModel": "按执行助手的模型选择审查模型：执行助手所用模型（纯模型 id）对应到审查模型与推理强度，比全局默认更具体，命中即生效；未命中按其余层级解析（顺序见上方「默认审查模型」）。",
			"help.reviewer.model": "全局默认的审查模型与推理强度。模型引用形如 provider/model；推理强度留空表示自动选择：模型支持 `low` 就使用 `low`，否则不指定、由模型默认值决定，不承诺所有模型都支持或采用相同强度。解析顺序为会话选择 → 按执行助手的模型映射 → 全局默认 → 跟随执行助手模型。",
			"help.reviewer.followParent": "仅在会话选择、按执行助手的模型映射、全局默认都不可用时生效：使用与执行助手相同的模型，独立发起一次审查调用——这是「使用相同模型」，不是由执行助手自己审批。关闭后，全部层级不可用时按审查故障拒绝。",
			"help.reviewer.timeoutMs": "自动审查的等待上限（毫秒），涵盖等待本次审查结论的全过程，内部重试不另计时。超时按拒绝处理并说明发生环节，不是危险判定。0 表示取消审查时限：审查模型挂起、工具或其他异常可能使请求无限停在自动审批，插件不自动恢复时限；取消与其他人工路径仍按各自条件生效（常驻风险提醒同此）。",
			"help.reviewer.maxTokens": "审查输出上限（token）。0 表示不向模型传输出上限，由模型或供应商默认值决定。推理模型可能先把额度用于推理：上限过小可能导致没有有效结论（正文为空，按审查故障处理）；具体数值因模型与推理强度而异，不以个别模型的测量结果作通用保证。",
			"help.human.timeoutMs": "人工作答等待上限（毫秒），仅在「自动审查未允许时＝交给人工决定」时使用。0 表示立即拒绝，不是无限等待。到点按拒绝结算，原因写明人工作答超时。",
			"help.human.timeoutFrom": "人工作答计时的起点：从审批请求起算＝交人工只使用剩余时间；从交人工起算＝交人工时重新开始计时。",
			"help.mode": "总开关：规则检查＋LLM 审查＝正常接管；完全不接管＝等同未安装，宿主审批流程不受影响。",
			"help.allowEscalationTo": "可自动批准的最高权限，只限制可送审或允许的升权范围；范围内仍须通过规则检查与模型审查，不等于自动批准全部操作。完全访问（默认）＝最宽；工作区内修改＝超出工作区写入的升权不放行。",
			"help.unknownSubject": "无法辨认本次实际操作（如回查不到命令或参数）时的处置。直接拒绝＝不调用模型、立即拒绝；带缺失说明继续审查＝携带已取得的参数与上下文继续审查，缺失明确标记，不把缺失当作安全。",
			"help.fallback": "自动审查未允许（拒绝、超时或故障）时的处置。直接拒绝＝按拒绝结算并通知执行助手；交给人工决定＝显示人工审批卡片等待你作答，人工作答等待上限到点按拒绝结算。子代理没有人工通道：未允许一律拒绝。",
			"help.ui.inject": "发给执行助手（发起工具操作的 Agent）的审批通知范围：允许、拒绝、超时和故障＝四类都发送；仅拒绝、超时和故障＝允许不发送；选择「不发送」＝一条都不发送。审查记录视图的显示不受本开关影响。",
			"help.ui.injectMaxBytes": "发给执行助手的单条通知的字节上限，超出截断并附截断标记；0 不裁剪。限制对象只是通知，审查记录按会话独立保留，与该上限无关。",
			"help.tools": "纳入自动审批的工具名单，每行一个工具名。空清单覆盖所有工具的升权审批；填写后只处理名单内工具的升权请求，其余工具保持宿主原流程。",
			"help.denyPatterns": "文本拒绝规则，每行一条正则表达式（正则表达式是文本匹配规则，不是完整命令语义分析）。匹配对象是受支持深度内的全部字符串参数值，不只命令字段；包含危险词的说明文本也可能命中。普通正则默认忽略大小写；写成 /source/flags 形式时按所填标志匹配，未写标志时与普通正则一样忽略大小写。命中即直接拒绝：不调用模型、不交人工，模型和人工都不能推翻。空清单只关闭这层文本匹配，可自动批准的最高权限、无法识别操作等其他检查不受影响；不可编译的行跳过，不构成有效保护。",
			"composer.label": "审查模型",
			"composer.followGlobal": "跟随全局（清除本会话选择）",
			"composer.followGlobalShort": "跟随全局",
			"composer.title": "本会话的审查模型；独立于执行助手调用，点开可只给这个会话指定",
			"composer.empty": "没有可选模型",
			"composer.failed": "切换失败",
			"composer.pendingSession": "会话尚未开始；现在设置的值会在会话开始后生效",
			"composer.section.model": "模型",
			"composer.section.effort": "推理强度",
			"card.presets.label": "启用自动审批的权限预设",
			"card.presets.empty": "未选择任何预设",
			"card.presets.count": "已选 {n} 个",
			"card.presets.default": "默认",
			"card.presets.none": "清单为空时，已知预设都不会接管审批；无法识别的预设按「无法识别权限预设时」的设置处置。",
			"card.presets.missing": "配置中存在但当前预设表里没有：",
			"card.presets.missing.remedy": "该预设不在宿主当前预设表中。可依次检查：插件是否已停用、宿主版本是否兼容、预设是否为自定义。重新启用插件或重启宿主可能恢复，不保证一定恢复；插件已卸载且配置仍选择该预设时，可改选标准权限档。插件不解析、不改写用户 YAML，不建议手工清理。",
			"card.presets.unavailable": "读不到预设目录。可能原因：服务缺失、读取失败或没有可用预设信息；可确认权限预设服务可用后重试。",
			"card.bool.on": "开启（true）",
			"card.bool.off": "关闭（false）",
			"card.value.unset": "未设置（跟随默认）",
			"option.trigger.unknown.skip": "保持宿主原审批流程",
			"option.trigger.unknown.review": "继续自动审查",
			"option.human.timeoutFrom.request": "从审批请求起算",
			"option.human.timeoutFrom.handoff": "从交人工起算",
			"option.mode.rules": "规则检查 + LLM 审查",
			"option.mode.off": "完全不接管",
			"option.allowEscalationTo.workspace-write": "工作区内修改",
			"option.allowEscalationTo.danger-full-access": "完全访问",
			"option.unknownSubject.reject": "直接拒绝",
			"option.unknownSubject.review": "带缺失说明继续审查",
			"option.fallback.reject": "直接拒绝",
			"option.fallback.ask": "交给人工决定",
			"option.ui.inject.all": "允许、拒绝、超时和故障",
			"option.ui.inject.reject": "仅拒绝、超时和故障",
			"option.ui.inject.off": "不发送",
			"help.ui.humanCardDuringReview": "开启时，自动审查进行中即显示人工审批卡片：你可以在审批未完成时抢先作答，人工结果优先；已完成的结果不能由迟到点击推翻。关闭时，仅在确实交给人工后显示卡片。",
			"cardstate.reviewing": "正在自动审批",
			"cardstate.waiting": "等待你决定",
			"cardstate.waiting.deny": "自动审查结论为拒绝：{reason}",
			"cardstate.waiting.timeout": "自动审查超时，未取得有效结论",
			"cardstate.waiting.error": "自动审查未取得有效结论：{reason}",
			"countdown.seconds": "剩余 {n} 秒后自动拒绝",
			"countdown.minutes": "剩余 {m} 分 {s} 秒后自动拒绝",
			"countdown.review": "审查时限剩余 {n} 秒",
			"countdown.unlimited": "审查无时限",
			"view.review": "审查记录",
			"view.needSession": "请先打开一个会话",
			"view.empty": "本会话还没有自动审批记录",
			"view.loading": "读取中…",
			"view.loadFailed": "读取审查记录失败",
			"view.count": "共 {n} 条",
			"view.refresh": "刷新",
			"view.disabled": "审查记录视图已关闭（ui.trace.ownView = false）",
			"view.readFailed": "记录读取失败或不完整，列表可能缺少条目",
			"view.retention": "记录跟随产生它的会话；每会话回读最近一个窗口（默认 200 条，随 ui.trace.maxRecords 可配置），磁盘最多保留 50 个会话文件（固定上限），超限删除最旧；减少采集不删除已有记录。",
			"list.outcome": "最终审批：{v}",
			"list.decision": "模型结论：{v}",
			"view.noOutcome": "未记录最终审批结果",
			"decision.allow": "放行（allow）",
			"decision.allowed-once": "放行（allowed-once）",
			"decision.deny": "拒绝（deny）",
			"decision.rejected": "拒绝（rejected）",
			"decision.timed-out": "超时（timed-out）",
			"decision.error": "失败（error）",
			"decision.cancelled": "取消（cancelled）",
			"time.total": "工具总计 {x} = 执行 {y} + 审批 {z}",
			"time.approvalOnly": "审批 {z}",
			"time.unmatched": "未匹配到工具行",
			"time.queue": "排队 {n}",
			"time.review": "审查 {n}",
			"time.human": "人工 {n}",
			"detail.title": "单次审查",
			"detail.outcome": "最终审批结果",
			"detail.decision": "模型结论",
			"detail.source": "决定方式",
			"detail.stage": "环节",
			"detail.model": "模型",
			"detail.effort": "推理强度",
			"detail.layer": "模型选择来源",
			"detail.attempts": "尝试次数",
			"detail.tokens": "推理 token 用量",
			"detail.risk": "风险",
			"detail.auth": "授权",
			"detail.fieldsDefaulted": "自动补全的字段",
			"detail.degraded": "缺失或异常情况",
			"detail.preset": "接管预设",
			"detail.origin": "归属",
			"detail.escalation": "升权目标",
			"detail.configTag": "配置标识",
			"detail.policyTag": "策略标识",
			"detail.evidence": "上下文证据",
			"detail.probes": "只读取证",
			"detail.reason": "理由",
			"detail.prompt": "提示词",
			"detail.input": "输入",
			"detail.reasoning": "模型返回的推理文本",
			"detail.output": "输出",
			"detail.truncated": "已截断",
			"absent.noContext": "未取上下文",
			"absent.noProbes": "未调用取证工具",
			"absent.modelNotProvided": "模型未提供",
			"absent.notFullCapture": "未开启全文采集",
			"absent.unknown": "本次未记录此项",
			"layer.session": "会话选择（session）",
			"layer.parent-map": "按执行助手的模型映射（parent-map）",
			"layer.global": "全局默认（global）",
			"layer.follow-parent": "跟随执行助手模型（follow-parent）",
			"layer.unavailable": "全部层级不可用（unavailable）",
			"fieldsDefaulted.risk": "风险分级（risk）",
			"fieldsDefaulted.auth": "授权分级（auth）",
			"fieldsDefaulted.reason": "理由（reason）",
			"degraded.command": "无法辨认本次操作（command）",
			"degraded.cwd": "会话目录缺失（cwd）",
			"degraded.transcript": "上下文读取失败或截断（transcript）",
			"degraded.entry": "单条证据截断（entry:…）",
			"degraded.all": "模型选择全部不可用（all）",
			"degraded.output-truncated": "输出截断（output-truncated）",
			"degraded.output-empty": "空输出（output-empty）",
			"degraded.superseded": "已被其他路径先结算（superseded）",
			"degraded.queue-overflow": "队列已满（queue-overflow）",
			"degraded.queue-timeout": "排队超时（queue-timeout）",
			"degraded.breaker-open": "冷却中未执行（breaker-open）",
			"degraded.inject-fail": "通知失败（inject-fail）",
			"enum.unknown": "{v}（含义未知）",
			"source.rule": "规则（rule）",
			"source.llm": "审查（llm）",
			"source.human": "人工（human）",
			"source.timeout": "超时（timeout）",
			"source.gateway": "通道关闭（gateway）",
			"source.signal": "取消（signal）",
			"source.error": "异常（error）",
			"stage.queue": "排队（queue）",
			"stage.review": "审查（review）",
			"stage.human": "人工（human）",
			"origin.main": "主会话（main）",
			"origin.subagent": "子代理（subagent）",
			"legacy.row": "【自动审批】{tool} · {decision} · 耗时 {duration}",
			"legacy.outcome.allowed-once": "放行",
			"legacy.outcome.rejected": "拒绝",
			"legacy.outcome.cancelled": "取消",
			"legacy.outcome.unavailable": "不可用",
			"field.trigger.unknown": "无法识别权限预设时",
			"field.trigger.auditEverySkip": "逐条记录预设不匹配的审批",
			"field.reviewer.timeoutMs": "自动审查等待上限（毫秒）",
			"field.reviewer.maxTokens": "审查输出上限（token）",
			"field.ui.humanCardDuringReview": "审查期间显示人工审批卡片",
			"field.human.timeoutMs": "人工作答等待上限（毫秒）",
			"field.human.timeoutFrom": "人工作答等待起算点",
			"field.mode": "模式",
			"field.allowEscalationTo": "可自动批准的最高权限",
			"field.unknownSubject": "无法识别本次操作时",
			"field.fallback": "自动审查未允许时",
			"field.ui.inject": "给执行助手的审批通知",
			"field.ui.injectMaxBytes": "通知长度上限（字节）",
			"field.tools": "纳入自动审批的工具",
			"field.denyPatterns": "文本拒绝规则（每行一条正则表达式）",
			"field.language.ui": "插件界面语言",
			"field.language.agent": "发送给模型的文本语言",
			"validate.number": "{label} 需要非负整数",
			"validate.option": "{label} 取值非法",
			"option.language.ui.auto": "跟随界面",
			"option.language.ui.zh": "中文",
			"option.language.ui.en": "英文",
			"option.language.agent.zh": "中文",
			"option.language.agent.en": "英文",
			"help.language.ui": "插件界面文案的语言：跟随宿主界面（auto）或强制中文／英文。保存后下一次渲染生效，不改变发送给模型的文本语言。",
			"help.language.agent": "发给模型的全部文本的语言（系统提示、策略、工具说明、轮次指引）与给执行助手的通知语言。默认英文。判定与授权规则不随语言改变；与插件界面语言互不影响。",
			"hint.trigger.presets": "会话使用清单内权限预设时，由本插件接管升权审批。",
			"hint.trigger.unknown": "读不到会话权限预设时的处置。",
			"hint.trigger.auditEverySkip": "因预设不匹配跳过的审批是否逐条记录。",
			"hint.reviewer.model": "全局默认的审查模型与推理强度。",
			"hint.reviewer.byParentModel": "按执行助手模型选择审查模型的映射表。",
			"hint.reviewer.followParent": "更高优先级的选择都不可用时，改用执行助手的模型独立审查。",
			"hint.language.ui": "插件界面文案的语言。",
			"hint.language.agent": "发给审查模型的文本与给执行助手的通知，两者使用的语言。",
			"hint.reviewer.timeoutMs": "自动审查的等待上限（毫秒）；0 取消时限，有常驻风险提醒。",
			"hint.reviewer.maxTokens": "审查输出的 token 上限；0 不设上限。",
			"hint.ui.humanCardDuringReview": "审查期间是否提前显示人工审批卡片。",
			"hint.human.timeoutMs": "人工作答的等待上限（毫秒）；0 立即拒绝。",
			"hint.human.timeoutFrom": "人工作答从何时开始计时：审批请求发出时，或交人工时。",
			"hint.mode": "总开关；关闭后插件完全不接管。",
			"hint.allowEscalationTo": "插件可自动授予的最高权限档；更高的升权不会被自动批准。",
			"hint.unknownSubject": "无法辨认本次实际操作时的处置。",
			"hint.fallback": "自动审查未允许时的处置。",
			"hint.ui.inject": "发给执行助手的审批通知范围。",
			"hint.ui.injectMaxBytes": "单条通知的字节上限；0 不裁剪。",
			"hint.tools": "纳入自动审批的工具，每行一个；空清单覆盖全部工具。",
			"hint.denyPatterns": "每行一条正则表达式；命中即直接拒绝，模型与人工都不能推翻。",
		};
		const en = {
			"card.unset": "Not set",
			"card.map.parent": "Agent's model",
			"card.map.add": "Add row",
			"card.map.remove": "Remove",
			"card.map.col.parent": "Agent's model",
			"card.map.col.reviewer": "Reviewer model",
			"card.map.col.effort": "Effort",
			"card.map.col.action": "Actions",
			"card.map.custom": "Custom…",
			"card.map.placeholder.parent": "Agent model id",
			"card.field.defaultModel": "Default reviewer model",
			"card.field.byParentModel": "Reviewer model by the agent's model",
			"card.field.followParent": "Use the agent's model when no reviewer is available",
			"card.effort.unsupported": " (unsupported by this model)",
			"effort.default": "Automatic",
			"card.override": "Set individually",
			"card.resetField": "Reset to default",
			"card.save": "Save",
			"card.saving": "Saving…",
			"card.failed": "Save failed",
			"card.invalidNumber": "Enter a number, or leave blank to use the default.",
			"seconds.resolved": "Effective: {v}",
			"seconds.draft": "Draft: {v}",
			"seconds.unit": "s",
			"warn.noLimit": "Risk: a hung review model, a tool failure or another error can leave the request stuck in auto-approval forever; the plugin does not restore the limit automatically — cancel and other human paths still apply per their conditions.",
			"card.readonly": "Settings are read-only on this page (non-loopback). Use a profile patch instead.",
			"help.expand": "Details",
			"help.collapse": "Hide details",
			"help.trigger.presets": "Sessions on a listed preset hand escalation approvals to this plugin; other presets keep the host flow. An empty list takes over no known preset; unidentifiable presets follow \"When the preset cannot be identified\". Choosing the take-over range grants no extra permissions.",
			"help.trigger.unknown": "What to do when the session preset cannot be read: keep the host flow means no take-over; continue means treat it as covered. Causes include a missing service, a read failure, or no preset information.",
			"help.trigger.auditEverySkip": "On: every preset-mismatch skip is logged; off: one line per session and reason. This only changes the number of skip lines, never the take-over itself, and does not imply every approval is reviewed.",
			"help.reviewer.byParentModel": "Picks the reviewer by the model the acting agent uses: the agent's plain model id maps to a reviewer model and effort, overriding the global default; misses fall through to the remaining layers (see Default reviewer model).",
			"help.reviewer.model": "Global default reviewer model and effort. The reference reads provider/model; an empty effort is automatic: use `low` when the model supports it, otherwise let the model default decide — no promise that every model supports it or matches the same intensity. Resolution: session choice, by the agent's model, global default, then follow the agent's model.",
			"help.reviewer.followParent": "Applies only when the session choice, the agent-model map and the global default are all unusable: the reviewer then runs on the same model as the agent, as an independent call — the same model, never the agent approving itself. Off: total resolution failure is rejected as a review failure.",
			"help.reviewer.timeoutMs": "Auto-review wait limit (ms), covering the whole wait for this review's conclusion; internal retries get no fresh budget. A timeout rejects with its stage named — not a danger verdict. 0 removes the limit: a hung model or tooling failure can leave the request stuck in auto-approval forever; the plugin never restores the limit silently, while cancellation and other human paths still apply (same as the standing note).",
			"help.reviewer.maxTokens": "Review output cap (tokens). 0 sends no cap, leaving the model or provider default. Reasoning models may spend the budget on reasoning first: too small a cap can leave no usable conclusion (empty body, treated as a review failure); the threshold varies by model and effort, so no single measurement is a general promise.",
			"help.human.timeoutMs": "Human-answer wait limit (ms), used only when the fallback is Ask. 0 rejects immediately, not an endless wait. Expiry settles as a rejection citing the human timeout.",
			"help.human.timeoutFrom": "Where the human timer starts: from the approval request (the handoff only gets the remainder), or from the handoff itself.",
			"help.mode": "Master switch: rule check plus LLM review takes over as configured; off behaves as if uninstalled, leaving host approvals untouched.",
			"help.allowEscalationTo": "The widest permission auto-approval may grant. It bounds what may be reviewed or allowed; everything in range still passes the rule checks and the review — it is not a blanket approval. Full access (default) is widest; workspace write rejects wider escalations.",
			"help.unknownSubject": "When the actual action cannot be identified (say, no command or arguments could be recovered): reject refuses at once without the model; keep reviewing submits what was recovered with explicit missing-action marks — missing never counts as safe.",
			"help.fallback": "What happens when the review does not approve (deny, timeout or failure): reject settles at once and notifies the agent; ask shows the human card until you answer or the human limit rejects. Subagents have no human channel — not allowed always means rejected.",
			"help.ui.inject": "Which approval notices reach the acting agent: allow, deny, timeout and failures sends all four; deny, timeout and failures skips allow notices; send none sends no notices. The review-log view is unaffected by this switch.",
			"help.ui.injectMaxBytes": "Byte cap for one notice to the agent; longer text is trimmed with a marker, 0 does not trim. Only notices are capped — review records are kept per session and ignore this limit.",
			"help.tools": "Tools under auto-approval, one name per line. Empty covers every tool's escalations; once filled, only listed tools are handled and the rest keep the host flow.",
			"help.denyPatterns": "Text deny rules, one regex per line (a regex is a text-matching rule, not command semantics). Every string argument within the supported depth is matched, not just the command; harmless prose containing a dangerous word can hit too. Plain patterns are case-insensitive by default; in /source/flags form the given flags apply, and with no flags given it stays case-insensitive like a plain pattern. A hit rejects outright — no model, no human, no override. An empty list disables only this text check; the escalation ceiling and unknown-action handling stay. Uncompilable lines are skipped and protect nothing.",
			"composer.label": "Reviewer model",
			"composer.followGlobal": "Follow global (clear this session)",
			"composer.followGlobalShort": "Follow global",
			"composer.title": "This session's reviewer model — called independently of the agent; pick one to override it for this session only",
			"composer.empty": "No selectable model",
			"composer.failed": "Switch failed",
			"composer.pendingSession": "This session has not started yet; the value applies once it does",
			"composer.section.model": "Model",
			"composer.section.effort": "Effort",
			"card.presets.label": "Presets that enable auto-approval",
			"card.presets.empty": "No preset selected",
			"card.presets.count": "{n} selected",
			"card.presets.default": "default",
			"card.presets.none": "With an empty list no known preset is taken over; presets that cannot be identified follow \"When the preset cannot be identified\".",
			"card.presets.missing": "Configured but absent from the current preset table:",
			"card.presets.missing.remedy": "The preset is absent from the host's current table. Check in turn: a disabled plugin, an incompatible host version, or a custom preset. Re-enabling or restarting may restore it, with no guarantee; if the plugin is uninstalled while the config still selects it, pick a standard tier. The plugin never parses or rewrites user YAML, and manual cleanup is not recommended.",
			"card.presets.unavailable": "The preset catalog is unavailable. Possible causes: a missing service, a read failure, or no preset information; check the permission preset service and retry.",
			"card.bool.on": "On (true)",
			"card.bool.off": "Off (false)",
			"card.value.unset": "Not set (follows the default)",
			"option.trigger.unknown.skip": "Keep the host approval flow",
			"option.trigger.unknown.review": "Continue with automatic review",
			"option.human.timeoutFrom.request": "From the approval request",
			"option.human.timeoutFrom.handoff": "From the handoff to the human",
			"option.mode.rules": "Rule check + LLM review",
			"option.mode.off": "Do not take over",
			"option.allowEscalationTo.workspace-write": "Workspace write",
			"option.allowEscalationTo.danger-full-access": "Full access",
			"option.unknownSubject.reject": "Reject",
			"option.unknownSubject.review": "Keep reviewing with missing-action notes",
			"option.fallback.reject": "Reject directly",
			"option.fallback.ask": "Ask the human",
			"option.ui.inject.all": "Allow, deny, timeout and failures",
			"option.ui.inject.reject": "Deny, timeout and failures only",
			"option.ui.inject.off": "Send none",
			"help.ui.humanCardDuringReview": "On: the human card shows while the review runs — you may answer first and the human answer wins; a settled result cannot be overturned by a late click. Off: the card appears only once the request is truly handed over.",
			"cardstate.reviewing": "Auto-reviewing",
			"cardstate.waiting": "Waiting for your decision",
			"cardstate.waiting.deny": "The review concluded deny: {reason}",
			"cardstate.waiting.timeout": "The review timed out without a conclusion",
			"cardstate.waiting.error": "The review failed without a conclusion: {reason}",
			"countdown.seconds": "Auto-rejects in {n}s",
			"countdown.minutes": "Auto-rejects in {m}m {s}s",
			"countdown.review": "Review deadline in {n}s",
			"countdown.unlimited": "No review deadline",
			"view.review": "Review log",
			"view.needSession": "Open a session first",
			"view.empty": "No auto-approval records in this session yet",
			"view.loading": "Loading…",
			"view.loadFailed": "Failed to load review records",
			"view.count": "{n} records",
			"view.refresh": "Refresh",
			"view.disabled": "The review-log view is disabled (ui.trace.ownView = false)",
			"view.readFailed": "Record read failed or incomplete; entries may be missing",
			"view.retention": "Records follow the session that produced them. Each session reads back the most recent window (200 entries by default, configurable via ui.trace.maxRecords); at most 50 session files are kept on disk (a fixed cap), the oldest deleted first. Reducing capture never deletes existing records.",
			"list.outcome": "Final approval: {v}",
			"list.decision": "Model conclusion: {v}",
			"view.noOutcome": "No final outcome recorded",
			"decision.allow": "Allowed (allow)",
			"decision.allowed-once": "Allowed (allowed-once)",
			"decision.deny": "Denied (deny)",
			"decision.rejected": "Denied (rejected)",
			"decision.timed-out": "Timed out (timed-out)",
			"decision.error": "Failed (error)",
			"decision.cancelled": "Cancelled (cancelled)",
			"time.total": "Tool total {x} = exec {y} + approval {z}",
			"time.approvalOnly": "Approval {z}",
			"time.unmatched": "no matching tool row",
			"time.queue": "queue {n}",
			"time.review": "review {n}",
			"time.human": "human {n}",
			"detail.title": "Review detail",
			"detail.outcome": "Final approval",
			"detail.decision": "Model conclusion",
			"detail.source": "Decided by",
			"detail.stage": "Stage",
			"detail.model": "Model",
			"detail.effort": "Effort",
			"detail.layer": "Model selection source",
			"detail.attempts": "Attempts",
			"detail.tokens": "Reasoning tokens",
			"detail.risk": "Risk",
			"detail.auth": "Authorization",
			"detail.fieldsDefaulted": "Auto-filled fields",
			"detail.degraded": "Missing or degraded conditions",
			"detail.preset": "Take-over preset",
			"detail.origin": "Origin",
			"detail.escalation": "Escalation target",
			"detail.configTag": "Config tag",
			"detail.policyTag": "Policy tag",
			"detail.evidence": "Context evidence",
			"detail.probes": "Read-only probes",
			"detail.reason": "Reason",
			"detail.prompt": "Prompt",
			"detail.input": "Input",
			"detail.reasoning": "Model-returned reasoning",
			"detail.output": "Output",
			"detail.truncated": "truncated",
			"absent.noContext": "No context collected",
			"absent.noProbes": "No evidence tools called",
			"absent.modelNotProvided": "Not provided by the model",
			"absent.notFullCapture": "Full-text capture was off",
			"absent.unknown": "Not recorded for this approval",
			"layer.session": "Session choice (session)",
			"layer.parent-map": "By the agent's model (parent-map)",
			"layer.global": "Global default (global)",
			"layer.follow-parent": "Follow the agent's model (follow-parent)",
			"layer.unavailable": "No layer available (unavailable)",
			"fieldsDefaulted.risk": "Risk level (risk)",
			"fieldsDefaulted.auth": "Authorization level (auth)",
			"fieldsDefaulted.reason": "Rationale (reason)",
			"degraded.command": "Action cannot be identified (command)",
			"degraded.cwd": "Working directory missing (cwd)",
			"degraded.transcript": "Context read failure or truncation (transcript)",
			"degraded.entry": "Single evidence entry truncated (entry:…)",
			"degraded.all": "No model layer available (all)",
			"degraded.output-truncated": "Output truncated (output-truncated)",
			"degraded.output-empty": "Empty output (output-empty)",
			"degraded.superseded": "Settled first by another path (superseded)",
			"degraded.queue-overflow": "Queue full (queue-overflow)",
			"degraded.queue-timeout": "Queue wait timeout (queue-timeout)",
			"degraded.breaker-open": "Skipped during cooldown (breaker-open)",
			"degraded.inject-fail": "Notice delivery failure (inject-fail)",
			"enum.unknown": "{v} (unknown meaning)",
			"source.rule": "rule",
			"source.llm": "review (llm)",
			"source.human": "human",
			"source.timeout": "timeout",
			"source.gateway": "card closed (gateway)",
			"source.signal": "cancelled (signal)",
			"source.error": "error",
			"stage.queue": "queue",
			"stage.review": "review",
			"stage.human": "human",
			"origin.main": "main session",
			"origin.subagent": "subagent",
			"legacy.row": "[auto-approval] {tool} · {decision} · took {duration}",
			"legacy.outcome.allowed-once": "allowed",
			"legacy.outcome.rejected": "rejected",
			"legacy.outcome.cancelled": "cancelled",
			"legacy.outcome.unavailable": "unavailable",
			"field.trigger.unknown": "When the preset cannot be identified",
			"field.trigger.auditEverySkip": "Log every preset-mismatch skip",
			"field.reviewer.timeoutMs": "Auto-review wait limit (ms)",
			"field.reviewer.maxTokens": "Review output cap (tokens)",
			"field.ui.humanCardDuringReview": "Human card during review",
			"field.human.timeoutMs": "Human-answer wait limit (ms)",
			"field.human.timeoutFrom": "Human timer starts",
			"field.mode": "Mode",
			"field.allowEscalationTo": "Highest auto-approvable permission",
			"field.unknownSubject": "When the action cannot be identified",
			"field.fallback": "When the review does not approve",
			"field.ui.inject": "Approval notices to the agent",
			"field.ui.injectMaxBytes": "Notice length cap (bytes)",
			"field.tools": "Tools under auto-approval",
			"field.denyPatterns": "Text deny rules (one regex per line)",
			"field.language.ui": "Plugin UI language",
			"field.language.agent": "Language of model-facing texts",
			"validate.number": "{label} requires a non-negative integer",
			"validate.option": "{label} has an invalid value",
			"option.language.ui.auto": "Follow UI",
			"option.language.ui.zh": "Chinese",
			"option.language.ui.en": "English",
			"option.language.agent.zh": "Chinese",
			"option.language.agent.en": "English",
			"help.language.ui": "Language of the plugin's own UI copy: follow the host (auto) or force zh/en. Takes effect on the next render and never touches model-facing texts.",
			"help.language.agent": "Language of every model-facing text (system prompt, policy, tool descriptions, round instructions) and of the notices to the agent. Defaults to English. Rules and authorization never change with the language; the plugin UI language is independent.",
			"hint.trigger.presets": "Sessions on a listed permission preset hand escalations to this plugin.",
			"hint.trigger.unknown": "What happens when the session preset cannot be read.",
			"hint.trigger.auditEverySkip": "Whether approvals skipped for a preset mismatch are each logged.",
			"hint.reviewer.model": "Global default reviewer model and effort.",
			"hint.reviewer.byParentModel": "Map from the agent's model to a reviewer model.",
			"hint.reviewer.followParent": "When no higher-priority choice works, review with the agent's model.",
			"hint.language.ui": "Language of the plugin's UI copy.",
			"hint.language.agent": "Language shared by the texts sent to the reviewer and the notices sent to the agent.",
			"hint.reviewer.timeoutMs": "Auto-review wait limit (ms); 0 removes it, with a standing risk note.",
			"hint.reviewer.maxTokens": "Review output cap in tokens; 0 sets none.",
			"hint.ui.humanCardDuringReview": "Whether the human card appears early during review.",
			"hint.human.timeoutMs": "Human-answer wait limit (ms); 0 rejects immediately.",
			"hint.human.timeoutFrom": "Where the human-answer timing starts: at the approval request, or at the handoff.",
			"hint.mode": "Master switch; off means no take-over at all.",
			"hint.allowEscalationTo": "The highest permission tier auto-approval may grant; wider escalations are never auto-approved.",
			"hint.unknownSubject": "What happens when the action cannot be identified.",
			"hint.fallback": "What happens when the review does not approve.",
			"hint.ui.inject": "Which approval notices reach the agent.",
			"hint.ui.injectMaxBytes": "Byte cap per notice; 0 does not trim.",
			"hint.tools": "Tools under auto-approval, one per line; empty covers all.",
			"hint.denyPatterns": "One regex per line; a hit rejects outright, beyond model or human.",
		};

		/** 字段按 FIELDS 的 section 标记（trigger/advanced）分组排序；审查模型三行与「接管预设」由专用控件渲染；不渲染分区标题（requirements §6.1）。 */

		/**
		 * 普通字段行；审查模型分区的三行与触发区的「接管预设」由专用控件渲染（design §7.2；「接管预设」是多选下拉，requirements §6.1），不在本表内。
		 * path 指向命名空间分节内的路径；标签与校验文案走字典（键 `field.<path.join('.')>`），helpKey 由 path 推导；
		 * `optionLabels` 走字典，键为 `option.<path.join('.')>.<值>`（design §7.2）。
		 */
		const FIELDS = [
			{ section: "trigger", path: ["trigger", "unknown"], labelKey: "field.trigger.unknown", kind: "select", options: ["skip", "review"] },
			{ section: "trigger", path: ["trigger", "auditEverySkip"], labelKey: "field.trigger.auditEverySkip", kind: "bool" },
			{ section: "advanced", path: ["language", "ui"], labelKey: "field.language.ui", kind: "select", options: ["auto", "zh", "en"] },
			{ section: "advanced", path: ["language", "agent"], labelKey: "field.language.agent", kind: "select", options: ["zh", "en"] },
			{ section: "advanced", path: ["reviewer", "timeoutMs"], labelKey: "field.reviewer.timeoutMs", kind: "number", unit: "ms" },
			{ section: "advanced", path: ["reviewer", "maxTokens"], labelKey: "field.reviewer.maxTokens", kind: "number" },
			{ section: "advanced", path: ["ui", "humanCardDuringReview"], labelKey: "field.ui.humanCardDuringReview", kind: "bool" },
			{ section: "advanced", path: ["human", "timeoutMs"], labelKey: "field.human.timeoutMs", kind: "number", unit: "ms" },
			{ section: "advanced", path: ["human", "timeoutFrom"], labelKey: "field.human.timeoutFrom", kind: "select", options: ["request", "handoff"] },
			{ section: "advanced", path: ["mode"], labelKey: "field.mode", kind: "select", options: ["rules", "off"] },
			{ section: "advanced", path: ["allowEscalationTo"], labelKey: "field.allowEscalationTo", kind: "select", options: ["workspace-write", "danger-full-access"] },
			{ section: "advanced", path: ["unknownSubject"], labelKey: "field.unknownSubject", kind: "select", options: ["reject", "review"] },
			{ section: "advanced", path: ["fallback"], labelKey: "field.fallback", kind: "select", options: ["reject", "ask"] },
			{ section: "advanced", path: ["ui", "inject"], labelKey: "field.ui.inject", kind: "select", options: ["all", "reject", "off"] },
			{ section: "advanced", path: ["ui", "injectMaxBytes"], labelKey: "field.ui.injectMaxBytes", kind: "number" },
			{ section: "advanced", path: ["tools"], labelKey: "field.tools", kind: "lines" },
			{ section: "advanced", path: ["denyPatterns"], labelKey: "field.denyPatterns", kind: "lines" },
		];

		/** 注入样式；同一 tagId 只插入一次，避免重复挂载时样式叠加。 */
		const CSS = [
			// 设置界面照官方设置表单重绘（规格来源见 docs/design.md；0.1.7 令牌表不存在的别名零命中）。
			// 外壳：无卡片边框/圆角/底色，只做纵向布局（按计算样式核）。
			".dsafm_form{display:flex;flex-direction:column;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}",
			".dsafm_readonly{margin:0 0 12px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}",
			// 字段：竖排，标签行 → 控件 → 常驻说明；相邻字段 0.5px 分隔线（见官方 fields.module.css）。
			".dsafm_field{display:flex;flex-direction:column;gap:6px;padding:12px 0}",
			".dsafm_field + .dsafm_field{border-top:.5px solid var(--dsw-alias-border-l2)}",
			".dsafm_f_head{display:flex;align-items:center;gap:8px}",
			".dsafm_labelgroup{display:flex;align-items:center;gap:4px;flex:1;min-width:0}",
			".dsafm_f_label{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}",
			// 说明按钮（design §7.2.1）：图标＋可见文字「说明／收起说明」，命中区不小于 24×24，
			// 依 label-secondary→primary 取色（官方 .helpButton:hover 引用的底色别名在 0.1.7 令牌表不存在，不得照抄）。
			".dsafm_helpbtn{display:inline-flex;align-items:center;gap:4px;justify-content:center;flex:none;min-width:24px;min-height:24px;padding:0 8px;border:0;border-radius:6px;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;font-size:12px;line-height:1.5}",
			".dsafm_helpbtn:hover,.dsafm_helpbtn[aria-expanded='true']{color:var(--dsw-alias-label-primary)}",
			".dsafm_helpbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
			".dsafm_helpregion{padding:10px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}",
			// 覆盖组：胶囊「已单独设置」（primitives.Tag 自带样式）＋「恢复默认」文本按钮。
			".dsafm_badges{display:inline-flex;align-items:center;gap:8px}",
			// 行内勾选（跟随执行助手模型一类）：贴标签行右端（标签组 flex:1 把它推到控制列位置），24px 命中区与说明按钮同规格。
			".dsafm_inlinecheck{display:inline-flex;align-items:center;flex:none;min-width:24px;min-height:24px;justify-content:center;margin-left:auto}",
			".dsafm_reset{border:none;background:none;padding:0;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer}",
			".dsafm_reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}",
			".dsafm_reset:disabled{cursor:default}",
			".dsafm_f_hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}",
			// 毫秒字段的秒数读数行——自绘在官方组件之外（官方 hint 在字段非法时被非法文案顶掉）。
			// 负 margin 把它拉进官方字段自己的 12px 底部内边距区，与官方字段内 6px 间隙对齐（视觉归属该字段）。
			".dsafm_f_sec{margin:-12px 0 12px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}",
			// 分隔线选择器组（design §7.2.1）：第一条在秒数行后排除说明行（不加分隔线）；
			// 第二条以说明行为锚恢复后继字段的 0.5px 分隔线（覆盖毫秒与非毫秒两种顺序）。
			".dsafm_f_sec + div:not(.dsafm_field):not(.dsafm_f_help){border-top:.5px solid var(--dsw-alias-border-l2)}",
			".dsafm_f_help + div:not(.dsafm_field){border-top:.5px solid var(--dsw-alias-border-l2)}",
			// 数字字段的平铺说明行（design §7.2.1）：与秒数读数行同一负边距，视觉归属该字段。
			".dsafm_f_help{margin:-12px 0 12px}",
			".dsafm_sec_invalid{color:var(--dsw-alias-state-error-primary)}",
			".dsafm_sec_warn{display:block;margin-top:2px;color:var(--dsw-alias-state-warn-primary,#b8860b)}",
			// 控件本体：官方输入规格（34px/0 12px/0.5px border-l4/8px/bg-layer-3；聚焦与非法边框）。
			".dsafm_input{flex:1;min-width:0;width:100%;height:34px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-3);font-family:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}",
			".dsafm_input:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}",
			".dsafm_input[aria-invalid='true']{border-color:var(--dsw-alias-state-error-primary)}",
			".dsafm_input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}",
			".dsafm_area{min-height:64px;height:auto;padding:8px 12px;white-space:pre;overflow:auto}",
			// 底部：唯一「保存」（实心，不可保存置灰）；失败文案用现行错误别名（官方 .failed 笔误不照抄）。
			".dsafm_footer{display:flex;align-items:center;gap:8px;padding-top:16px}",
			".dsafm_failed{flex:1;min-width:0;margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary)}",
			".dsafm_save{appearance:none;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-family:inherit;font-size:13px;line-height:1.5;cursor:pointer;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}",
			".dsafm_save:disabled{opacity:.4;cursor:default}",
			".dsafm_save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
			".dsafm_chevron{flex:0 0 auto;color:var(--dsw-alias-label-tertiary)}",
			".dsafm_ctl{display:flex;gap:6px;min-width:0}",
			".dsafm_map{display:flex;flex-direction:column;gap:6px}",
			".dsafm_map_head,.dsafm_map_row{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1.6fr) minmax(96px,.8fr) auto;gap:8px;align-items:center;min-width:0}",
			".dsafm_map_head{font-size:12px;color:var(--dsw-alias-label-tertiary)}",
			".dsafm_map_row select{width:100%;min-width:0}",
			".dsafm_map_del{justify-self:start;padding:0 10px}",
			".dsafm_button{border:none;background:none;padding:0;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer}",
			".dsafm_button:hover:not(:disabled){color:var(--dsw-alias-label-primary)}",
			".dsafm_button:disabled{cursor:default}",
			".dsafm_badge{font-size:11px;color:var(--dsw-alias-state-warn-primary);margin-left:6px}",
			".dsafm_hint{color:var(--dsw-alias-label-tertiary);font-size:12px;overflow-wrap:anywhere}",
			".dsafm_seat{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;border:none;border-radius:14px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;cursor:pointer}",
			".dsafm_seat_name{max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsafm_item{display:flex;flex-direction:column}",
			".dsafm_item_group{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
			".dsafm_seat_pending{font-size:11px;color:var(--dsw-alias-state-warn-primary);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsafm_stack{display:flex;flex-direction:column;gap:6px;min-width:0}",
			".dsafm_picker{display:flex;align-items:center;gap:8px;width:100%;text-align:left;cursor:pointer}",
			".dsafm_picker_text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsafm_picker_meta{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
			".dsafm_popover{display:flex;flex-direction:column;gap:2px;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2);padding:6px;max-height:240px;overflow:auto}",
			".dsafm_option{display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border-radius:8px;cursor:pointer}",
			".dsafm_option:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsafm_option_text{display:flex;flex-direction:column;gap:2px;min-width:0}",
			".dsafm_option_title{display:flex;align-items:center;gap:6px}",
			".dsafm_option_sub{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}",
			".dsafm_tag{font-size:10px;line-height:14px;padding:0 6px;border-radius:7px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}",
			".dsafm_warn{color:var(--dsw-alias-state-warn-primary)}",
			".dsafm_carddetail{display:flex;flex-direction:column;gap:4px;font-family:var(--dsh-font-family-base,inherit)}",
			".dsafm_state{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-weight:500}",
			".dsafm_state_time{font-weight:400;color:var(--dsw-alias-label-tertiary)}",
			".dsafm_state_warn{color:var(--dsw-alias-state-warn-primary)}",
			".dsafm_state_deny{color:var(--dsw-alias-state-error-primary)}",
			".dsafm_cmd{font-family:var(--ds-font-family-code);word-break:break-all;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}",
			".dsafm_review{display:flex;flex-direction:column;gap:8px;padding:12px 16px;min-width:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}",
			".dsafm_review_bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".dsafm_review_count{flex:1;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:12px}",
			".dsafm_review_list{display:flex;flex-direction:column;gap:6px}",
			".dsafm_review_item{display:flex;flex-direction:column;gap:2px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-module-platform);padding:8px 10px;min-width:0}",
			".dsafm_review_head{display:flex;align-items:baseline;gap:8px;min-width:0;flex-wrap:wrap;border:none;background:none;cursor:pointer;font-family:inherit;color:inherit;text-align:left;padding:0}",
			".dsafm_review_head:hover{color:var(--dsw-alias-label-primary)}",
			".dsafm_review_tool{font-weight:500;overflow-wrap:anywhere}",
			".dsafm_review_subject{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}",
			".dsafm_review_decision{font-size:12px;color:var(--dsw-alias-label-secondary)}",
			".dsafm_review_decision_allow{color:var(--dsw-alias-state-business-primary)}",
			".dsafm_review_decision_deny{color:var(--dsw-alias-state-error-primary)}",
			".dsafm_review_decision_sub{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
			".dsafm_review_meta{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;margin-left:auto}",
			".dsafm_review_z{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
			".dsafm_review_degraded{font-size:11px;color:var(--dsw-alias-state-warn-primary,#b8860b)}",
			".dsafm_review_equation{font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}",
			".dsafm_review_unmatched{color:var(--dsw-alias-label-tertiary)}",
			".dsafm_review_detail{display:flex;flex-direction:column;gap:8px;margin-top:6px;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:8px}",
			".dsafm_review_section{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}",
			".dsafm_review_text{font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto;background:var(--dsw-alias-bg-module-platform);border-radius:8px;padding:8px 10px;color:var(--dsw-alias-label-primary)}",
			".dsafm_review_absent{color:var(--dsw-alias-label-tertiary);font-size:12px}",
			".dsafm_review_hint{color:var(--dsw-alias-label-tertiary);font-size:12px;overflow-wrap:anywhere}",
			"@media (max-width:520px){.dsafm_map_head{display:none}.dsafm_map_row{grid-template-columns:minmax(0,1fr)}}",
		].join("");
		if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="dsh-approve-for-me"]') === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = NS;
			tag.dataset.pluginCss = "dsh-approve-for-me";
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/**
		 * 读取路径值。
		 * @param {object} root - 根对象。
		 * @param {readonly string[]} path - 路径。
		 * @returns {unknown} 值。
		 */
		function getPath(root, path) {
			let current = root;
			for (const key of path) {
				if (current === null || typeof current !== "object") return undefined;
				current = current[key];
			}
			return current;
		}

		/**
		 * 把字段值渲染成编辑框里的文本。
		 * @param {unknown} value - 值。
		 * @param {object} field - 字段定义。
		 * @returns {string} 文本。
		 */
		function toDraft(value, field) {
			if (value === undefined || value === null) return "";
			if (field.kind === "lines") return Array.isArray(value) ? value.join("\n") : String(value);
			return String(value);
		}

		/**
		 * 把编辑框文本解析成写入值。
		 * @param {string} text - 编辑框内容。
		 * @param {object} field - 字段定义。
		 * @param {(key: string) => string} [translate] - 取词函数（校验文案走字典）；缺省时退回字段键名。
		 * @returns {{ok: true, value: unknown} | {ok: false, error: string}} 解析结果。
		 */
		function fromDraft(text, field, translate) {
			const t = typeof translate === "function" ? translate : ((key) => key);
			const label = t(field.labelKey);
			const raw = text ?? "";
			if (field.kind === "number") {
				if (raw.trim().length === 0) return { ok: true, value: undefined };
				const value = Number(raw);
				if (!Number.isFinite(value) || value < 0 || Math.floor(value) !== value) {
					return { ok: false, error: t("validate.number").replace("{label}", label) };
				}
				return { ok: true, value };
			}
			if (field.kind === "lines") {
				const lines = raw.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
				return { ok: true, value: lines };
			}
			if (field.kind === "select") {
				if (raw.length === 0) return { ok: true, value: undefined };
				if (!field.options.includes(raw)) return { ok: false, error: t("validate.option").replace("{label}", label) };
				return { ok: true, value: raw };
			}
			if (field.kind === "bool") {
				if (raw.length === 0) return { ok: true, value: undefined };
				if (raw !== "true" && raw !== "false") return { ok: false, error: t("validate.option").replace("{label}", label) };
				return { ok: true, value: raw === "true" };
			}
			return { ok: true, value: raw };
		}

		/**
		 * 把模型选择归一化为 `{ model, effort }`；旧字符串写法读成 effort 空串（requirements §5.1）。
		 * @param {unknown} value - 配置值。
		 * @returns {{model: string, effort: string}} 归一化结果。
		 */
		function choiceOf(value) {
			if (typeof value === "string") return { model: value.trim(), effort: "" };
			if (value !== null && typeof value === "object") {
				return {
					model: typeof value.model === "string" ? value.model.trim() : "",
					effort: typeof value.effort === "string" ? value.effort.trim() : "",
				};
			}
			return { model: "", effort: "" };
		}

		/**
		 * 读 `reviewer.byParentModel`，得到行表；键兼容纯模型 id 与全引用（design §7.2）。
		 * @param {unknown} value - 映射对象。
		 * @returns {{parent: string, model: string, effort: string}[]} 行表。
		 */
		function rowsOf(value) {
			if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
			return Object.keys(value).map((key) => {
				const choice = choiceOf(value[key]);
				return { parent: key, model: choice.model, effort: choice.effort };
			});
		}

		/**
		 * 拆 `provider/model` 引用。
		 * @param {string} ref - 模型引用。
		 * @returns {{provider: string, model: string}} 两段；不是引用时都为空串。
		 */
		function splitRef(ref) {
			const at = typeof ref === "string" ? ref.indexOf("/") : -1;
			if (at <= 0 || at === ref.length - 1) return { provider: "", model: "" };
			return { provider: ref.slice(0, at), model: ref.slice(at + 1) };
		}

		/**
		 * 映射键：`provider/model` 取**最后一个** `/` 之后的模型 id，与宿主 `lookupByParentModel`
		 * 的取法（`lastIndexOf('/')`，design §6.2）一致；输入 `a/b/c` 得 `c`，不再得 `b/c`。
		 * @param {string} text - 用户输入或目录引用。
		 * @returns {string} 键；空输入返回空串。
		 */
		function keyOf(text) {
			const raw = typeof text === "string" ? text.trim() : "";
			const at = raw.lastIndexOf("/");
			return at === -1 ? raw : raw.slice(at + 1);
		}

		/**
		 * 模型下拉的选项：目录里的全部 `provider/model`，外加目录没有的当前值。
		 * @param {object | null} catalog - `approveForMe/modelCatalog` 的结果。
		 * @param {string} current - 当前模型引用。
		 * @returns {string[]} 选项。
		 */
		function modelRefsOf(catalog, current) {
			const refs = [];
			for (const provider of catalog?.providers ?? []) {
				for (const model of provider.models ?? []) refs.push(`${provider.id}/${model.id}`);
			}
			if (current.length > 0 && !refs.includes(current)) refs.unshift(current);
			return refs;
		}

		/**
		 * 展示用的执行助手模型引用：键已是全引用时原样返回，否则用目录拼上 provider（design §7.2）。
		 * @param {string} key - 映射键。
		 * @param {object | null} catalog - 模型目录。
		 * @returns {string} 展示引用。
		 */
		function displayRef(key, catalog) {
			if (key.includes("/")) return key;
			for (const provider of catalog?.providers ?? []) {
				for (const model of provider.models ?? []) if (model.id === key) return `${provider.id}/${model.id}`;
			}
			return key;
		}

		/**
		 * 档位下拉的选项：首项固定为空串（自动选择）；当前档位不被模型支持时保留该项并置灰（design §7.2）。
		 * 模型未选定或未取到档位时只剩首项且不可写。
		 * @param {{efforts: {id: string}[]} | undefined} entry - 该模型的档位表。
		 * @param {string} current - 当前档位。
		 * @param {string} defaultLabel - 首项文案。
		 * @param {string} unsupportedLabel - 不支持档位的后缀。
		 * @returns {{options: {value: string, label: string, disabled?: boolean}[], writable: boolean}} 选项与可写性。
		 */
		function effortOptions(entry, current, defaultLabel, unsupportedLabel) {
			const ids = (entry?.efforts ?? []).map((item) => item.id);
			const options = [{ value: "", label: defaultLabel }];
			for (const id of ids) options.push({ value: id, label: id });
			if (current.length > 0 && !ids.includes(current)) {
				options.push({ value: current, label: `${current}${unsupportedLabel}`, disabled: true });
			}
			return { options, writable: options.length > 1 };
		}

		/**
		 * 读某模型的档位表；`modelEfforts` 失败时按空表处理（design §7.1）。
		 * @param {((endpoint: string, args: object) => Promise<object | undefined>) | null} rpcCall - RPC 调用。
		 * @param {string} ref - 模型引用。
		 * @returns {Promise<{efforts: {id: string}[]}>} 档位表。
		 */
		function fetchEfforts(rpcCall, ref) {
			const parts = splitRef(ref);
			if (typeof rpcCall !== "function" || parts.model.length === 0) return Promise.resolve({ efforts: [] });
			return Promise.resolve()
				.then(() => rpcCall("approveForMe/modelEfforts", parts))
				.then((response) =>
					response?.ok === true && Array.isArray(response.value?.efforts)
						? { efforts: response.value.efforts.filter((item) => typeof item?.id === "string") }
						: { efforts: [] },
				)
				.catch(() => ({ efforts: [] }));
		}

		/**
		 * 把毫秒时长格式化成短文本：一秒内用整数毫秒，否则秒带一位小数（与记录表「21.3 s」口径一致）。
		 * @param {unknown} ms - 毫秒数。
		 * @returns {string} 文本；不可用时 `-`。
		 */
		function formatMillis(ms) {
			if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "-";
			if (ms < 1000) return `${Math.round(ms)} ms`;
			return `${(ms / 1000).toFixed(1)} s`;
		}

		/**
		 * 把毫秒换算成秒数读数的数字部分——整数秒不带小数点，非整数秒四舍五入到一位小数
		 * （`1500`→`1.5`、`1501`→`1.5`、`999`→`1.0`、`0`→`0`）。与 formatMillis 的「≥1000 ms 一位
		 * 小数」口径不同，不得混用（requirements §6.1）。入参须与数字字段草稿同一口径：有限、≥0、整数。
		 * @param {unknown} ms - 毫秒数。
		 * @returns {string | null} 秒数文本；入参不是合法毫秒整数时 null（占位由调用方出）。
		 */
		function secondsNumberText(ms) {
			if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || Math.floor(ms) !== ms) return null;
			const seconds = ms / 1000;
			return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
		}

		/**
		 * 把 epoch 毫秒格式化成 `MM-DD HH:MM:SS`（本地时区；列表行的「开始时间」列）。
		 * @param {unknown} ms - epoch 毫秒。
		 * @returns {string} 文本；不可用时 `-`。
		 */
		function formatClock(ms) {
			if (typeof ms !== "number" || !Number.isFinite(ms)) return "-";
			const date = new Date(ms);
			const pad = (value) => String(value).padStart(2, "0");
			return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
		}

		/**
		 * 分段耗时的展示文本：缺失段显示 `—`，不按 0 计（design §8.5；缺失不是测量值 0）。
		 * @param {unknown} ms - 分段毫秒数。
		 * @returns {string} 文本。
		 */
		function segmentText(ms) {
			return typeof ms === "number" && Number.isFinite(ms) ? formatMillis(ms) : "—";
		}

		/**
		 * 审批耗时 Z ＝ 在场分段之和（design §8.5：只累加在场的分段，缺失段不按 0 计）。
		 * @param {object | null | undefined} record - 记录（摘要或合并详情）。
		 * @returns {number} 毫秒。
		 */
		function approvalMsOf(record) {
			return [record?.queueMs, record?.reviewMs, record?.humanWaitMs].reduce(
				(sum, value) => (typeof value === "number" && Number.isFinite(value) ? sum + value : sum),
				0,
			);
		}

		/**
		 * 判定文案的字典键：兼容 verdict 词汇（allow/deny/error，现行 host 落盘值）与
		 * 结局词汇（allowed-once/rejected/timed-out，design §8.2 的字段口径）；其余原样返回 null。
		 * @param {unknown} decision - 判定值。
		 * @returns {string | null} 字典键。
		 */
		function decisionKeyOf(decision) {
			if (typeof decision !== "string" || decision.length === 0) return null;
			if (["allow", "allowed-once", "deny", "rejected", "timed-out", "error", "cancelled"].includes(decision)) return `decision.${decision}`;
			return null;
		}

		/**
		 * 双标注方向谓词（design §8.5.1）：allow 系（allow/allowed-once）与 deny 系（deny/rejected）同向；
		 * error、cancelled 与其余取值没有方向。同向的模型结论与最终审批不并列标注。
		 * @param {unknown} decision - 判定值。
		 * @returns {"allow" | "deny" | undefined} 方向。
		 */
		function directionOf(decision) {
			if (decision === "allow" || decision === "allowed-once") return "allow";
			if (decision === "deny" || decision === "rejected") return "deny";
			return undefined;
		}

		/**
		 * 在记录表快照里按 `callId` 找该工具调用的总时长 X（毫秒）。
		 *
		 * 口径复刻宿主 `dsh-client-ui-trajectory` 的 `durationSeconds(node.time, node.callTime)`：
		 * 结算行 = `time − callTime`、下限 0；`callTime` 缺失（窗口截断）或调用在飞时**没有总时长**，
		 * 返回 `null`（绝不猜 X，design §8.5）。根调用（`kind: 'tool-result'` 节点）与 PTC 子调用
		 * （`subCalls` 里的结算行，审批的 `callId` 多为 `…:ptc:N` 子调用）都在扫描范围。
		 * @param {object | null | undefined} snapshot - `useTrajectory` 选择器返回的记录表快照。
		 * @param {string | null | undefined} callId - 审批请求的 `callId`。
		 * @returns {number | null} 总时长毫秒；匹配不上或时间戳不可用时 `null`。
		 */
		function trajectoryToolMs(snapshot, callId) {
			if (typeof callId !== "string" || callId.length === 0) return null;
			const nodes = Array.isArray(snapshot?.eventNodes) ? snapshot.eventNodes : [];
			const ownMs = (block) => {
				const later = block?.time;
				const earlier = block?.callTime;
				if (earlier === null || !Number.isFinite(later) || !Number.isFinite(earlier)) return null;
				return Math.max(0, later - earlier);
			};
			const scan = (block) => {
				if (block === null || typeof block !== "object") return null;
				if (block.kind === "tool-result" && block.callId === callId) {
					const hit = ownMs(block);
					if (hit !== null) return hit;
				}
				const subs = Array.isArray(block.subCalls) ? block.subCalls : [];
				for (const sub of subs) {
					const hit = scan(sub);
					if (hit !== null) return hit;
				}
				return null;
			};
			for (const node of nodes) {
				if (node?.kind === "tool-result") {
					const hit = scan(node);
					if (hit !== null) return hit;
				}
			}
			return null;
		}

		/**
		 * composer 的审查模型下拉：模型段 + 档位段的两段式菜单（design §7.3）。
		 *
		 * 状态来自 RPC `approveForMe/getState`；选择写入 `approveForMe/setSessionModel`，
		 * 成功后重新拉取状态，不依赖会话投影（design §7.3）。取不到会话 id 时不渲染。
		 * @param {object} props - 注入的 `rpcCall`、`sessionIdOf`、`subscribeSessions` 与 `t`。
		 * @returns {object | null} React 元素。
		 */
		function ComposerModelSelect(props) {
			// 槽位注入的 useNsT 优先（强制语言档）；旧宿主/直调测试没传时退回宿主 t（auto 行为）。
			const { t: hostT, useNsT, sessionIdOf, subscribeSessions } = props;
			const t =
				typeof useNsT === "function"
					? useNsT(hostT)
					: typeof hostT === "function"
						? hostT
						: (key) => key;
			const [sessionId, setSessionId] = react.useState(() => sessionIdOf?.(props.sessionId) ?? "");
			const [state, setState] = react.useState(null);
			const [catalog, setCatalog] = react.useState(null);
			const [effortTable, setEffortTable] = react.useState(null);
			const [open, setOpen] = react.useState(false);
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState("");

			// 会话 id 来自 sessions 服务：`sessionId` 标准 prop 在本构建里可能是空值，
			// 而 slot 的 kit 钩子在插件侧不可用（调用会抛错），所以只读 store 快照（design §7.3）。
			react.useEffect(() => {
				const update = () => setSessionId(sessionIdOf?.(props.sessionId) ?? "");
				update();
				const stop = subscribeSessions?.(update);
				const timer = setTimeout(update, 400);
				return () => {
					clearTimeout(timer);
					if (typeof stop === "function") stop();
				};
			}, []);

			// 显隐与展示只依赖这几个字段；值没变就不 setState。
			// 这既是"避免无意义重渲染"，也是**自激保护**：下面的预设订阅效果在每次渲染都会跑，
			// 没有这个守卫就会 setState → 渲染 → 再拉 → 再 setState。
			const signatureOf = (value) =>
				value === undefined || value === null
					? ""
					: [value.active, value.preset, value.effective, value.sessionModel, value.sessionEffort, value.layer].join("|");
			const lastSignatureRef = react.useRef(null);
			const aliveRef = react.useRef(true);
			/**
			 * 拉一次状态；`active` 决定控件显隐，所以预设被切换后必须重新拉（design §7.3）。
			 * @returns {void}
			 */
			const refreshState = () => {
				if (typeof props.rpcCall !== "function") return;
				if (typeof sessionId !== "string" || sessionId.length === 0) return;
				Promise.resolve()
					.then(() => props.rpcCall("approveForMe/getState", { sessionId }))
					.then((response) => {
						if (aliveRef.current !== true || response?.ok !== true) return;
						const next = signatureOf(response.value);
						if (next === lastSignatureRef.current) return;
						lastSignatureRef.current = next;
						setState(response.value);
					})
					.catch(() => {});
			};

			react.useEffect(() => {
				if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
				if (typeof props.rpcCall !== "function") return undefined;
				aliveRef.current = true;
				refreshState();
				// 回退轮询：投影不可用（旧宿主 / 未注册）时才靠它；间隔 10 s，正常路径不吃这个延迟。
				const poll = setInterval(refreshState, 10000);
				Promise.resolve()
					.then(() => props.rpcCall("approveForMe/modelCatalog", {}))
					.then((response) => {
						if (aliveRef.current === true && response?.ok === true) setCatalog(response.value);
					})
					.catch(() => {});
				return () => {
					aliveRef.current = false;
					clearInterval(poll);
				};
			}, [sessionId]);

			// 权限预设变化即刷新：宿主已把权限状态发布成 `permissions` 投影（`dsh-permission-presets`，
			// 值为 `{options, currentValue}`），客户端只把它当"该刷新了"的闹钟——**接管判定仍在宿主侧**（design §2.1／§7.3）。
			// 钩子可能不存在（旧宿主）：用恒定空实现占位，保证 hooks 顺序稳定。
			const projectionHook = typeof props.useProjection === "function" ? props.useProjection : () => undefined;
			const permissionsValue = (() => {
				try {
					return projectionHook("permissions");
				} catch {
					return undefined;
				}
			})();
			const presetKey = typeof permissionsValue?.currentValue === "string" ? permissionsValue.currentValue : "";
			react.useEffect(() => {
				if (presetKey.length === 0) return undefined;
				refreshState();
				return undefined;
			}, [presetKey, sessionId]);

			// 档位段的数据源：对当前生效模型调一次 `modelEfforts`；失败时该段只留「自动选择」（design §7.3）。
			react.useEffect(() => {
				const ref = typeof state?.effective === "string" ? state.effective : "";
				if (ref.length === 0) return undefined;
				let alive = true;
				fetchEfforts(props.rpcCall, ref).then((entry) => {
					if (alive) setEffortTable((previous) => (previous?.ref === ref ? previous : { ref, efforts: entry.efforts }));
				});
				return () => {
					alive = false;
				};
			}, [state?.effective]);

			/**
			 * 把 composer 挂点的三次早退判定写进诊断对象（`window.__dsafmProbe.composer`）。
			 *
			 * 存在的理由：控件不可见时，页面既不报错也不留痕（三种早退都合法）。这条诊断让「没渲染」能自证是哪一个条件不满足——排查用，不影响渲染分支。
			 * @param {object} snapshot - 判定当时的 `sessionId`/`state`/`props.sessionId`。
			 * @returns {void}
			 */
			const noteComposerGate = (snapshot) => {
				try {
					if (typeof window === "undefined") return;
					const probe = (window.__dsafmProbe = window.__dsafmProbe ?? {});
					probe.composer = snapshot;
				} catch {
					// 诊断失败不影响渲染。
				}
			};

			if (typeof sessionId !== "string" || sessionId.length === 0) {
				noteComposerGate({ gate: "no-session-id", propSessionId: props.sessionId ?? null, stateLoaded: state !== null });
				return null;
			}
			if (state === null) {
				noteComposerGate({ gate: "state-null", sessionId });
				return null;
			}
			// 显隐只看宿主的接管结论（design §7.3）：非接管预设下不占位。
			// 旧宿主（部署里 client 比 host 新）没有 `active` 字段：此时按「照常显示」处理，宁可多显示也不要让控件消失。
			if (state.active !== undefined && state.active !== true) {
				noteComposerGate({ gate: "not-active", sessionId, active: state.active, preset: state.preset ?? null, layer: state.layer ?? null });
				return null;
			}

			// `found=false` 只是「宿主里没有这个活会话」，不再是禁用理由：写入按会话 id 落文件载体，
			// 会话开始后生效（requirements §6.2）。
			const pendingSession = state.found === false;
			const model = typeof state.effective === "string" ? state.effective : "";
			const currentEffort = state.sessionModel !== null && state.sessionModel !== undefined ? state.sessionEffort : state.effectiveEffort;
			const effort = typeof currentEffort === "string" ? currentEffort : undefined;
			const label =
				model.length === 0
					? t("composer.followGlobalShort")
					: effort === undefined
						? `${t("composer.label")}：${model}`
						: `${t("composer.label")}：${model} · ${effort.length === 0 ? t("effort.default") : effort}`;

			const modelItems = [];
			for (const provider of catalog?.providers ?? []) {
				for (const item of provider.models ?? []) {
					const ref = `${provider.id}/${item.id}`;
					modelItems.push({
						id: ref,
						label: jsxRuntime.jsxs("span", {
							className: "dsafm_item",
							children: [
								jsxRuntime.jsx("span", { children: item.id }),
								jsxRuntime.jsx("span", { className: "dsafm_item_group", children: provider.id }),
							],
						}),
					});
				}
			}
			const effortItems =
				model.length === 0
					? []
					: [
						{ id: "__effort__", label: `${t("composer.section.effort")}：${t("effort.default")}` },
						...(effortTable?.ref === model ? effortTable.efforts : []).map((item) => ({
							id: `__effort__:${item.id}`,
							label: `${t("composer.section.effort")}：${item.id}`,
						})),
					];

			/**
			 * 写会话级选择；`model` 为 `null` 清除本会话选择，`effort` 为 `null` 表示沿用受支持的当前档位。
			 * @param {string | null} nextModel - 目标模型。
			 * @param {string | null} nextEffort - 目标档位。
			 * @returns {void}
			 */
			const choose = (nextModel, nextEffort) => {
				const pending =
					nextEffort !== null
						? Promise.resolve(nextEffort)
						: nextModel === null || effort === undefined || effort.length === 0
							? Promise.resolve("")
							: fetchEfforts(props.rpcCall, nextModel).then((entry) =>
								entry.efforts.some((item) => item.id === effort) ? effort : "",
							);
				Promise.resolve(pending).then((settled) => {
					setOpen(false);
					setBusy(true);
					setError("");
					return props.rpcCall("approveForMe/setSessionModel", { sessionId, model: nextModel, effort: settled })
						.then((response) => {
							if (response?.ok !== true) {
								setError(response?.error ?? t("composer.failed"));
								return undefined;
							}
							return props.rpcCall("approveForMe/getState", { sessionId }).then((next) => {
								if (next?.ok === true) setState(next.value);
							});
						})
						.catch((failure) => {
							setError(failure instanceof Error ? failure.message : String(failure));
						})
						.finally(() => setBusy(false));
				});
			};

			const seat = jsxRuntime.jsxs("button", {
				type: "button",
				className: "dsafm_seat",
				"aria-haspopup": "menu",
				"aria-expanded": open,
				title:
					pendingSession
						? t("composer.pendingSession")
						: error === ""
							? t("composer.title")
							: `${t("composer.failed")}：${error}`,
				disabled: busy || modelItems.length === 0,
				onClick: () => setOpen((value) => !value),
				children: [
					jsxRuntime.jsx("span", { className: "dsafm_seat_name", children: label }),
					pendingSession ? jsxRuntime.jsx("span", { className: "dsafm_seat_pending", children: t("composer.pendingSession") }) : null,
					error === "" ? null : jsxRuntime.jsx("span", { className: "dsafm_badge", children: t("composer.failed") }),
					jsxRuntime.jsx(ChevronDownIcon, { className: "dsafm_chevron" }),
				],
			});

			return jsxRuntime.jsx(primitives.Menu, {
				open,
				onClose: () => setOpen(false),
				items: [
					{ id: "__follow_global__", label: t("composer.followGlobal") },
					{ type: "label", id: "__label_model__", text: t("composer.section.model") },
					...(modelItems.length === 0 ? [{ id: "__empty__", label: t("composer.empty"), disabled: true }] : modelItems),
					...(effortItems.length === 0
						? []
						: [{ type: "label", id: "__label_effort__", text: t("composer.section.effort") }, ...effortItems]),
				],
				selectedId: model.length === 0 ? "__follow_global__" : model,
				selectedIds: effort === undefined || effortItems.length === 0 ? [] : [`__effort__${effort.length === 0 ? "" : `:${effort}`}`],
				onSelect: (id) => {
					if (id === "__empty__" || id === "__label_model__" || id === "__label_effort__") return;
					if (id === "__follow_global__") return choose(null, "");
					if (id === "__effort__") return choose(model, "");
					if (id.startsWith("__effort__:")) return choose(model, id.slice("__effort__:".length));
					choose(id, null);
				},
				align: "start",
				portal: true,
				anchor: seat,
			});
		}

		/**
		 * 「接管预设」多选控件（requirements §6.1）。
		 *
		 * 触发器是一个按钮，点开是复选框面板：选项来自宿主预设目录 `approveForMe/presetCatalog`，
		 * 展示名优先用宿主给的 `label`（部署可能已给中文名），并标出默认预设。
		 * 勾选只暂存（`onChange` 上抛新数组），由设置界面的「保存」一次写入，不走选中即写。
		 * @param {object} props - `selected`（暂存显示数组）、`onChange`、`writable`、`rpcCall` 与 `t`。
		 * @returns {object} React 元素。
		 */
		function PresetPicker(props) {
			const { t, rpcCall, id, describedby, selected, onChange, writable } = props;
			const [catalog, setCatalog] = react.useState(null);
			const [open, setOpen] = react.useState(false);

			react.useEffect(() => {
				if (rpcCall === null) return undefined;
				let alive = true;
				Promise.resolve()
					.then(() => rpcCall("approveForMe/presetCatalog", {}))
					.then((response) => {
						if (alive && response?.ok === true) setCatalog(response.value);
					})
					.catch(() => {});
				return () => {
					alive = false;
				};
			}, []);

			/**
			 * 勾选/取消一个预设：只上抛新数组（暂存），不写库（只有保存才写）。
			 * @param {string} id - 预设 id。
			 * @returns {void}
			 */
			const toggle = (id) => {
				const next = selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id];
				onChange(next);
			};

			const rows = catalog?.presets ?? [];
			const configured = catalog?.configured ?? [];
			const missing = configured.filter((id) => !rows.some((row) => row.id === id));
			const summary =
				selected.length === 0
					? t("card.presets.empty")
					: selected
						.map((id) => rows.find((row) => row.id === id)?.label ?? id)
						.join("、");

			return jsxRuntime.jsxs("div", {
				className: "dsafm_stack",
				children: [
					jsxRuntime.jsxs("button", {
						type: "button",
						className: "dsafm_input dsafm_picker",
						id,
						"aria-haspopup": "listbox",
						"aria-expanded": open,
						"aria-label": t("card.presets.label"),
						"aria-describedby": describedby,
						disabled: !writable || rows.length === 0,
						onClick: () => setOpen((value) => !value),
						children: [
							jsxRuntime.jsx("span", { className: "dsafm_picker_text", children: summary }),
							jsxRuntime.jsx("span", { className: "dsafm_picker_meta", children: t("card.presets.count").replace("{n}", String(selected.length)) }),
							jsxRuntime.jsx(ChevronDownIcon, { className: "dsafm_chevron" }),
						],
					}),
					open && rows.length > 0
						? jsxRuntime.jsx("div", {
							className: "dsafm_popover",
							role: "listbox",
							"aria-multiselectable": "true",
							children: rows.map((row) =>
								jsxRuntime.jsxs(
									"label",
									{
										className: "dsafm_option",
										children: [
											jsxRuntime.jsx("input", {
												type: "checkbox",
												className: "dsafm_check",
												checked: selected.includes(row.id),
												onChange: () => toggle(row.id),
											}),
											jsxRuntime.jsxs("span", {
												className: "dsafm_option_text",
												children: [
													jsxRuntime.jsxs("span", {
														className: "dsafm_option_title",
														children: [
															row.label,
															row.isDefault ? jsxRuntime.jsx("span", { className: "dsafm_tag", children: t("card.presets.default") }) : null,
														],
													}),
													jsxRuntime.jsxs("span", {
														className: "dsafm_option_sub",
														// 宿主没给展示名时 `label === id`，副标题里就不再重复一遍 id（只留说明）。
														children: row.label === row.id
															? row.description
															: row.description === "" ? row.id : `${row.id} · ${row.description}`,
													}),
												],
											}),
										],
									},
									row.id,
								),
							),
						})
						: null,
					selected.length === 0 ? jsxRuntime.jsx("div", { className: "dsafm_hint dsafm_warn", children: t("card.presets.none") }) : null,
					rows.length === 0 ? jsxRuntime.jsx("div", { className: "dsafm_hint", children: t("card.presets.unavailable") }) : null,
					missing.length === 0
						? null
						: jsxRuntime.jsx("div", { className: "dsafm_hint", children: `${t("card.presets.missing")}${missing.join("、")}` }),
					// 缺失态附补救指引（requirements §6.1／design §9.2）——指引服务于缺失态，不是常驻文案。
					missing.length === 0 ? null : jsxRuntime.jsx("div", { className: "dsafm_hint", children: t("card.presets.missing.remedy") }),
				],
			});
		}

		/**
		 * 审批卡片 body 里的自动审批状态条（design §7.4）。
		 *
		 * 与 `dsh-client-ui-chat` 的 `ApprovalCommand` 同源：先用 `useChat` 找到关联命令并原样渲染，
		 * 再在其上方叠加状态行与倒计时。该 seat 是 `single`，本组件接管后必须自己渲染命令，
		 * 因此注册时用负数 priority 抢到 `entriesOfSlot[0]`，且在没有状态数据时只渲染命令文本（其他预设观感不变）。
		 * @param {object} props - owner props `{ callId }` 与标准 props `{ useChat, t }`。
		 * @returns {object | null} React 元素。
		 */
		function ApprovalDetail(props) {
			const { callId, t } = props;
			// 会话 id 与 composer 下拉同一条通道；宿主也传标准 `sessionId` prop，作为备用（design §7.1）。
			const sessionId = react.useMemo(() => {
				const fromSessions = typeof props.sessionIdOf === "function" ? props.sessionIdOf(props.sessionId) : "";
				if (typeof fromSessions === "string" && fromSessions.length > 0) return fromSessions;
				return typeof props.sessionId === "string" ? props.sessionId : "";
			}, []);
			const [entries, setEntries] = react.useState([]);
			const [now, setNow] = react.useState(() => Date.now());

			const command = props.useChat((snapshot) => {
				for (const node of snapshot.nodes.values()) {
					const root = node.kind === "tool-call" ? node.data.root : undefined;
					if (root !== undefined && root.callId === callId && !("kind" in root)) {
						try {
							const args = JSON.parse(root.argsRaw);
							return typeof args.command === "string" ? args.command : undefined;
						} catch {
							return undefined;
						}
					}
				}
				return undefined;
			});

			// 状态来自宿主（`pendingState`），客户端只做本地倒数；失败或为空时整条状态行不渲染。
			react.useEffect(() => {
				if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
				if (typeof props.rpcCall !== "function") return undefined;
				let alive = true;
				const poll = () => {
					Promise.resolve()
						.then(() => props.rpcCall("approveForMe/pendingState", { sessionId }))
						.then((response) => {
							if (alive && response?.ok === true) setEntries(Array.isArray(response.value?.entries) ? response.value.entries : []);
						})
						.catch(() => {});
				};
				poll();
				const timer = setInterval(poll, 1000);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, [sessionId]);

			const entry = entries.find((item) => item.callId === callId) ?? (entries.length === 1 ? entries[0] : undefined);

			// 本地倒数只在真的有状态条目时跑，避免空转。
			react.useEffect(() => {
				if (entry === undefined) return undefined;
				const timer = setInterval(() => setNow(Date.now()), 250);
				return () => clearInterval(timer);
			}, [entry === undefined]);

			if (entry === undefined) return command === undefined || command === null ? null : command;

			// 状态行（design §7.4）：`reviewing` →「正在自动审批」；`waiting-human` →「等待你决定 · 原因子句」。
			// 原因子句明确归属自动审查（deny/timeout/error），不冠「最终」字样——人工未决不是最终拒绝；
			// deny 且理由为空时省略冒号与理由；cause 缺失或写错按 error（与 pending-state 归一化同向）。
			const causeOf = () => (entry.cause === "deny" || entry.cause === "timeout" ? entry.cause : "error");
			const causeText =
				entry.state === "waiting-human"
					? causeOf() === "timeout"
						? t("cardstate.waiting.timeout")
						: causeOf() === "deny" && (entry.reason ?? "") === ""
							? t("cardstate.waiting.deny").replace(/[:：]\s*\{reason\}/u, "")
							: t(`cardstate.waiting.${causeOf()}`).replace("{reason}", entry.reason ?? "")
					: null;
			const stateText = entry.state === "waiting-human" ? `${t("cardstate.waiting")} · ${causeText}` : t("cardstate.reviewing");
			// 倒计时分派（design §7.4）：reviewing 状态读审查截止（review），waiting-human 读人工
			// 截止（human），两类时限不得互串——deadlineKind 与状态矛盾（如交人工却标 review）属
			// 归一化错误，按状态锚定，不让倒计时整段消失或串显另一类时限；审查截止为 null →
			// 「审查无时限」（审查时限配置为 0 时承接层对该形态写 null/null），人工阶段 null 截止
			// 不渲染倒计时（零时限立即结算，无瞬态）。
			const deadlineKind = entry.state === "waiting-human" ? "human" : "review";
			const remaining = entry.deadlineAt === null ? null : Math.max(0, Math.ceil((entry.deadlineAt - now) / 1000));
			const countdown =
				deadlineKind === "review"
					? remaining === null
						? t("countdown.unlimited")
						: t("countdown.review").replace("{n}", String(remaining))
					: deadlineKind === "human" && remaining !== null
						? remaining >= 60
							? t("countdown.minutes").replace("{m}", String(Math.floor(remaining / 60))).replace("{s}", String(remaining % 60))
							: t("countdown.seconds").replace("{n}", String(remaining))
						: null;
			// 色阶沿用旧观感的等价迁移：cause=deny 沿用拒绝警示色，其余交人工态用弱警示色（等待你行动）。
			const stateClass =
				entry.state === "waiting-human" && causeOf() === "deny"
					? "dsafm_state dsafm_state_deny"
					: entry.state === "waiting-human"
						? "dsafm_state dsafm_state_warn"
						: "dsafm_state";

			return jsxRuntime.jsxs(
				"span",
				{
					className: "dsafm_carddetail",
					children: [
						jsxRuntime.jsxs("span", {
							className: stateClass,
							children: [
								stateText,
								countdown === null ? null : jsxRuntime.jsx("span", { className: "dsafm_state_time", children: ` · ${countdown}` }),
							],
						}),
						command === undefined || command === null ? null : jsxRuntime.jsx("span", { className: "dsafm_cmd", children: command }),
					],
				},
				entry.callId,
			);
		}

		/**
		 * 会话视图「审查记录」（design §8.5 呈现层第一落点）：本会话全部自动审批记录 + 单次详情 + 每轮耗时对照。
		 *
		 * 列表走 `approveForMe/traceRecords`（只回摘要字段），点开一条再按需拉 `approveForMe/traceRecord` 全文；
		 * X（工具调用在记录表里的总时长）从标准 prop `useTrajectory` 取、按 `callId` 匹配工具行
		 * （匹配不上只显示 Z 并标注「未匹配到工具行」，整段 try/catch 承接，绝不猜 X）。
		 * 会话 id 为空时只显示「请先打开一个会话」，不渲染内容。
		 * @param {object} props - 注入的 `rpcCall`/`sessionIdOf`/`subscribeSessions`、标准 props（`t`/`useTrajectory`）
		 *   与 owner props（`viewRequest`/`completeViewRequest`）。
		 * @returns {object} React 元素。
		 */
		function ReviewView(props) {
			// 槽位注入的 useNsT 优先（强制语言档）；旧宿主/直调测试没传时退回宿主 t（auto 行为）。
			const { t: hostT, useNsT, sessionIdOf, subscribeSessions } = props;
			const t =
				typeof useNsT === "function"
					? useNsT(hostT)
					: typeof hostT === "function"
						? hostT
						: (key) => key;
			const [sessionId, setSessionId] = react.useState(() => sessionIdOf?.(props.sessionId) ?? "");
			const [records, setRecords] = react.useState(null);
			const [error, setError] = react.useState("");
			// 该会话记录读取是否降级（读失败或末行撕裂）——列表可能不完整，必须可见、不伪装成「没有记录」
			const [readFailed, setReadFailed] = react.useState(false);
			const [openId, setOpenId] = react.useState("");
			const [detail, setDetail] = react.useState(null);
			const [viewOff, setViewOff] = react.useState(false);
			// 会话键守卫：同一会话只做一次「重置 + 首拉」（效果对 sessionId 幂等，避免重渲染把已展开行冲掉）。
			const loadedRef = react.useRef("");
			// 详情键守卫：同一 (会话, reviewId) 只拉一次，关闭行时清空缓存。
			const detailKeyRef = react.useRef("");

			// 会话 id：与 composer 下拉同一条通道——标准 `sessionId` prop 在本构建可能为空，从 sessions 快照取。
			react.useEffect(() => {
				const update = () => setSessionId(sessionIdOf?.(props.sessionId) ?? "");
				update();
				const stop = subscribeSessions?.(update);
				const timer = setTimeout(update, 400);
				return () => {
					clearTimeout(timer);
					if (typeof stop === "function") stop();
				};
			}, []);

			/**
			 * 拉一次列表；失败保留旧列表并提示。
			 * @returns {void}
			 */
			const refresh = () => {
				if (typeof sessionId !== "string" || sessionId.length === 0) return;
				if (typeof props.rpcCall !== "function") return;
				Promise.resolve()
					.then(() => props.rpcCall("approveForMe/traceRecords", { sessionId }))
					.then((response) => {
						if (response?.ok !== true) return;
						setRecords(Array.isArray(response.value?.records) ? response.value.records : []);
						setReadFailed(response.value?.readFailed === true);
						setError("");
					})
					.catch(() => setError(t("view.loadFailed")));
			};

			// 换会话即重置并首拉；顺带读一次 `ownView` 档（关了就只显示说明行）；10 s 回退轮询让新记录露出来。
			react.useEffect(() => {
				if (typeof sessionId !== "string" || sessionId.length === 0) {
					loadedRef.current = "";
					return undefined;
				}
				if (typeof props.rpcCall !== "function") return undefined;
				if (loadedRef.current === sessionId) return undefined;
				loadedRef.current = sessionId;
				setRecords(null);
				setError("");
				setReadFailed(false);
				setOpenId("");
				setDetail(null);
				refresh();
				Promise.resolve()
					.then(() => props.rpcCall("approveForMe/getState", { sessionId }))
					.then((response) => {
						if (response?.ok === true && response.value?.trace?.ownView === false) setViewOff(true);
					})
					.catch(() => {});
				const poll = setInterval(refresh, 10000);
				return () => clearInterval(poll);
			}, [sessionId]);

			// 点开一条时按需拉详情（全文只有 `capture=full` 才有，缺段由渲染层说明）。
			react.useEffect(() => {
				const key = typeof openId === "string" && openId.length > 0 ? `${sessionId} ${openId}` : "";
				if (detailKeyRef.current === key) return undefined;
				detailKeyRef.current = key;
				if (key === "" || typeof props.rpcCall !== "function") {
					setDetail(null);
					return undefined;
				}
				setDetail(null);
				Promise.resolve()
					.then(() => props.rpcCall("approveForMe/traceRecord", { sessionId, approvalId: openId }))
					.then((response) => {
						if (response?.ok === true) setDetail(response.value?.record ?? null);
					})
					.catch(() => {});
				return undefined;
			}, [openId, sessionId]);

			// `viewRequest` 只是「打开本视图」的请求（`{view, focus}`）：本视图没有可聚焦的子目标，收到即完成。
			const viewRequest = props.viewRequest ?? null;
			react.useEffect(() => {
				if (viewRequest === null || typeof props.completeViewRequest !== "function") return undefined;
				try {
					props.completeViewRequest();
				} catch {
					// 完成请求失败只是视图状态残留，不影响内容。
				}
				return undefined;
			}, [viewRequest]);

			// 记录表快照整只取出（选择器必须返回稳定引用，否则 useSyncExternalStore 会循环重渲染）。
			// `useTrajectory` 可能不存在（旧宿主 / 未挂轨迹插件）：恒定 noop 占位保证 hooks 顺序稳定
			// （与 composer 的 `useProjection` 同一手法）。
			const trajectoryHook = typeof props.useTrajectory === "function" ? props.useTrajectory : () => undefined;
			const trajectorySnapshot = (() => {
				try {
					return trajectoryHook((snapshot) => snapshot);
				} catch {
					return undefined;
				}
			})();

			if (typeof sessionId !== "string" || sessionId.length === 0) {
				return jsxRuntime.jsx("div", { className: "dsafm_review", children: jsxRuntime.jsx("div", { className: "dsafm_review_hint", children: t("view.needSession") }) });
			}
			if (viewOff) {
				return jsxRuntime.jsx("div", { className: "dsafm_review", children: jsxRuntime.jsx("div", { className: "dsafm_review_hint", children: t("view.disabled") }) });
			}

			const bar = jsxRuntime.jsxs("div", {
				className: "dsafm_review_bar",
				children: [
					jsxRuntime.jsx("span", {
						className: "dsafm_review_count",
						children: records === null ? t("view.loading") : t("view.count").replace("{n}", String(records.length)),
					}),
					error === "" ? null : jsxRuntime.jsx("span", { className: "dsafm_hint dsafm_warn", children: error }),
					// 读取降级必须可见——「列表可能不完整」不是错误（数据仍在），用警示色而非错误文案。
					readFailed ? jsxRuntime.jsx("span", { className: "dsafm_review_degraded", children: t("view.readFailed") }) : null,
					jsxRuntime.jsx("button", { type: "button", className: "dsafm_button", onClick: refresh, children: t("view.refresh") }),
				],
			});
			// 保留范围说明（design §8.5.1）：列表条数行下方常驻，不因列表为空或读取降级消失。
			const retentionLine = jsxRuntime.jsx("div", { className: "dsafm_review_hint", children: t("view.retention") });
			if (records === null) return jsxRuntime.jsxs("div", { className: "dsafm_review", children: [bar, retentionLine] });
			if (records.length === 0) {
				return jsxRuntime.jsxs("div", {
					className: "dsafm_review",
					children: [bar, retentionLine, jsxRuntime.jsx("div", { className: "dsafm_review_hint", children: t("view.empty") })],
				});
			}

			/**
			 * 展开行的耗时等式（requirements §7.3）：`工具总计 X = 执行 Y + 审批 Z`；匹配不上或任何异常只显示 Z。
			 * @param {object} source - 详情记录（含 `humanWaitMs`，Z 才完整）。
			 * @returns {object} 等式元素。
			 */
			const equationOf = (source) => {
				const zMs = approvalMsOf(source);
				const zText = t("time.approvalOnly").replace("{z}", formatMillis(zMs));
				try {
					const xMs = trajectoryToolMs(trajectorySnapshot, source?.callId);
					if (xMs === null) throw new Error("no tool row");
					return jsxRuntime.jsx("div", {
						className: "dsafm_review_equation",
						children: t("time.total")
							.replace("{x}", formatMillis(xMs))
							.replace("{y}", formatMillis(Math.max(0, xMs - zMs)))
							.replace("{z}", formatMillis(zMs)),
					});
				} catch {
					return jsxRuntime.jsxs("div", {
						className: "dsafm_review_equation",
						children: [zText, jsxRuntime.jsx("span", { className: "dsafm_review_unmatched", children: ` · ${t("time.unmatched")}` })],
					});
				}
			};

			/**
			 * 详情的一段全文：缺段按分派出的 absent 键显示说明而不是空白；`truncated` 标注已截断。
			 * @param {string} titleKey - 段标题的字典键。
			 * @param {string} absentKey - 缺段说明的字典键（由 `absentKeyOf` 按 design §8.5.1 三级分派）。
			 * @param {unknown} value - 字段值（只有字符串算采到了）。
			 * @param {boolean} truncated - 记录级截断标记。
			 * @returns {object} 段元素。
			 */
			const sectionOf = (titleKey, absentKey, value, truncated) => {
				const present = typeof value === "string";
				return jsxRuntime.jsxs("div", {
					children: [
						jsxRuntime.jsxs("div", {
							className: "dsafm_review_section",
							children: [
								t(titleKey),
								present && truncated === true ? jsxRuntime.jsx("span", { className: "dsafm_tag", children: t("detail.truncated") }) : null,
							],
						}),
						present
							? jsxRuntime.jsx("div", { className: "dsafm_review_text", children: value })
							: jsxRuntime.jsx("div", { className: "dsafm_review_absent", children: t(absentKey) }),
					],
				});
			};

			// 旧在后 → 新在前展示。
			const rows = [...records].reverse().map((record) => {
				const open = record.approvalId === openId;
				// 双标注方向谓词（design §8.5.1）：allow 系（allow/allowed-once）与 deny 系（deny/rejected）同向；
				// decision=error、最终 cancelled 或两值方向相反 → 并列；decision 缺失不渲染次级标注。
				const hasOutcome = typeof record.outcome === "string" && record.outcome.length > 0;
				const hasDecision = typeof record.decision === "string" && record.decision.length > 0;
				const outcomeDir = hasOutcome ? directionOf(record.outcome) : undefined;
				const decisionDir = hasDecision ? directionOf(record.decision) : undefined;
				const decisionKey = decisionKeyOf(record.decision);
				const outcomeKey = decisionKeyOf(record.outcome);
				// 主位：有最终审批结果 →「最终审批：{v}」；旧格式行（outcome 缺失）→「模型结论：{v}」；
				// 两者都缺原样展示（不猜）。色阶跟随主位值。
				const primaryValue = hasOutcome ? record.outcome : record.decision;
				const primaryKey = decisionKeyOf(primaryValue);
				const primaryText = hasOutcome
					? t("list.outcome").replace("{v}", outcomeKey === null ? String(record.outcome) : t(outcomeKey))
					: hasDecision
						? t("list.decision").replace("{v}", decisionKey === null ? String(record.decision) : t(decisionKey))
						: String(primaryValue ?? "-");
				const decisionClass =
					primaryKey === "decision.allow" || primaryKey === "decision.allowed-once"
						? "dsafm_review_decision dsafm_review_decision_allow"
						: primaryKey === "decision.deny" || primaryKey === "decision.rejected" || primaryKey === "decision.error"
							? "dsafm_review_decision dsafm_review_decision_deny"
							: "dsafm_review_decision";
				const truncated = detail?.truncated === true;
				// 全文段任一在场即证实 capture=full（design §8.5.1 分派链第二级的依据）。
				const fullTextPresent =
					typeof detail?.prompt === "string" || typeof detail?.input === "string" || typeof detail?.output === "string";
				/**
				 * 缺段说明的三级分派（design §8.5.1）：①读取失败在场 → 一律「本次未记录此项」；
				 * ②全文采集证实（任一全文段在场）：evidence→未取上下文、probes→未调用取证工具、
				 * reasoning→模型未提供、output 缺且结算为故障类（decision=error）→模型未提供；
				 * ③全文段均不在场：全文段（prompt/input/output）与 reasoning 显示「未开启全文采集」；
				 * 其余缺段（reason；全文采集下的 input）→「本次未记录此项」。
				 * @param {string} segment - 段名（reason/evidence/probes/prompt/input/reasoning/output）。
				 * @returns {string} absent 字典键。
				 */
				const absentKeyOf = (segment) => {
					if (readFailed) return "absent.unknown";
					if (segment === "evidence") return "absent.noContext";
					if (segment === "probes") return "absent.noProbes";
					if (fullTextPresent) {
						if (segment === "reasoning") return "absent.modelNotProvided";
						if (segment === "output" && record.decision === "error") return "absent.modelNotProvided";
						return "absent.unknown";
					}
					if (segment === "prompt" || segment === "input" || segment === "output" || segment === "reasoning") return "absent.notFullCapture";
					return "absent.unknown";
				};
				/**
				 * 枚举字段的文案（design §8.5.1 探测式取词）：键在字典则取，不在则用 `enum.unknown` 按
				 * 原值展示——强制语言档缺键会抛错使整条视图失败，先经 try/catch 探测，缺键不得外抛。
				 * @param {string} prefix - 字典键前缀（如 `layer`）。
				 * @param {unknown} value - 字段值。
				 * @returns {string | null} 文案。
				 */
				const enumText = (prefix, value) => {
					if (typeof value !== "string" || value.length === 0) return null;
					const key = `${prefix}.${value}`;
					let text = null;
					try {
						const candidate = t(key);
						if (candidate !== key) text = candidate;
					} catch {
						// 强制语言档缺键：按含义未知展示，不中断视图。
					}
					return text ?? t("enum.unknown").replace("{v}", value);
				};
				/**
				 * 多值枚举串（design §8.5.1）：存储为逗号连接（与 inject-fail 组合用 `+` 连接），
				 * 逐项按探测式取词后以顿号连接；`entry:<事件类型>` 是前缀族，不逐事件类型落键，
				 * 按前缀映射为「单条证据截断」并保留完整原值。
				 * @param {string} prefix - 字典键前缀（`fieldsDefaulted` / `degraded`）。
				 * @param {unknown} value - 字段值。
				 * @returns {string | null} 文案。
				 */
				const multiEnumText = (prefix, value) => {
					if (typeof value !== "string" || value.length === 0) return null;
					return value
						.split(/[,+]/u)
						.filter((item) => item.length > 0)
						.map((item) => (item.startsWith("entry:") ? t("degraded.entry").replace("entry:…", item) : enumText(prefix, item)))
						.join("、");
				};
				// 详情元信息段：只列在场字段（design §8.4「取不到明确缺失」——缺失段不显示假占位）。
				const metaParts = [];
				const metaOf = (titleKey, value, formatter) => {
					if (value === undefined || value === null || value === "") return;
					if (formatter !== undefined) {
						const text = formatter(value);
						if (text === null) return;
						metaParts.push(`${t(titleKey)}: ${text}`);
						return;
					}
					metaParts.push(`${t(titleKey)}: ${String(value)}`);
				};
				// 旧格式详情（有模型结论、无最终结果）按 design §8.5 同样说明结果缺失——outcome 缺失
				// 且 decision 在场时显式标注，不静默跳过；其余字段仍按 §8.4「取不到明确缺失」不设假占位。
				if ((record.outcome === undefined || record.outcome === null || record.outcome === "") && typeof record.decision === "string" && record.decision.length > 0) {
					metaParts.push(`${t("detail.outcome")}: ${t("view.noOutcome")}`);
				} else {
					metaOf("detail.outcome", record.outcome, (value) => (decisionKeyOf(value) === null ? String(value) : t(decisionKeyOf(value))));
				}
				metaOf("detail.decision", record.decision, (value) => (decisionKey === null ? String(value) : t(decisionKey)));
				metaOf("detail.source", record.source, (value) => enumText("source", value));
				metaOf("detail.stage", detail?.stage, (value) => enumText("stage", value));
				metaOf("detail.origin", record.origin, (value) => enumText("origin", value));
				metaOf("detail.escalation", record.escalation);
				metaOf("detail.preset", detail?.preset);
				metaOf("detail.model", record.model);
				metaOf("detail.effort", record.effort);
				metaOf("detail.layer", detail?.layer, (value) => enumText("layer", value));
				metaOf("detail.attempts", detail?.attempts);
				metaOf("detail.tokens", detail?.tokens);
				metaOf("detail.risk", record.risk);
				metaOf("detail.auth", record.auth);
				metaOf("detail.fieldsDefaulted", detail?.fieldsDefaulted, (value) => multiEnumText("fieldsDefaulted", value));
				// degraded 的 `none` 是「无异常情况」标记（design §8.2）＝无标记：不列该段，与缺失同处置。
				metaOf("detail.degraded", detail?.degraded, (value) => (value === "none" ? null : multiEnumText("degraded", value)));
				metaOf("detail.configTag", detail?.configTag);
				metaOf("detail.policyTag", detail?.policyTag);
				return jsxRuntime.jsxs(
					"div",
					{
						className: "dsafm_review_item",
						children: [
							jsxRuntime.jsxs("button", {
								type: "button",
								className: "dsafm_review_head",
								"aria-expanded": open,
								onClick: () => setOpenId((value) => (value === record.approvalId ? "" : record.approvalId)),
								children: [
									jsxRuntime.jsx("span", { className: "dsafm_review_tool", children: typeof record.toolName === "string" && record.toolName.length > 0 ? record.toolName : "-" }),
									jsxRuntime.jsx("span", {
										className: decisionClass,
										children: primaryText,
									}),
									// 双标注（design §8.5.1）：模型结论与最终审批方向不一致（人工推翻、超时、取消、
									// 模型故障）时并列可分辨；同向（allow→allowed-once、deny→rejected）不重复标注。
									hasOutcome && hasDecision && !(decisionDir !== undefined && decisionDir === outcomeDir)
										? jsxRuntime.jsx("span", {
												className: "dsafm_review_decision_sub",
												children: t("list.decision").replace("{v}", decisionKey === null ? String(record.decision) : t(decisionKey)),
											})
										: null,
									// 旧格式行（无最终审批结果）：主位即模型结论，另附「未记录最终审批结果」。
									!hasOutcome && hasDecision
										? jsxRuntime.jsx("span", { className: "dsafm_review_decision_sub", children: t("view.noOutcome") })
										: null,
									jsxRuntime.jsx("span", { className: "dsafm_review_subject", children: typeof record.subject === "string" && record.subject.length > 0 ? record.subject : null }),
									jsxRuntime.jsx("span", { className: "dsafm_review_meta", children: formatClock(record.startedAt) }),
									jsxRuntime.jsx("span", { className: "dsafm_review_z", children: t("time.approvalOnly").replace("{z}", formatMillis(approvalMsOf(record))) }),
								],
							}),
							open
								? jsxRuntime.jsxs("div", {
									className: "dsafm_review_detail",
									children: [
										detail === null
											? jsxRuntime.jsx("div", { className: "dsafm_review_hint", children: t("view.loading") })
											: jsxRuntime.jsxs(jsxRuntime.Fragment, {
												children: [
													equationOf(detail),
													jsxRuntime.jsx("div", {
														className: "dsafm_review_equation",
														children: [
															// 缺失段显示 —，不按 0 计（design §8.5：缺失不是测量值）。
															t("time.queue").replace("{n}", segmentText(detail.queueMs)),
															` · ${t("time.review").replace("{n}", segmentText(detail.reviewMs))}`,
															` · ${t("time.human").replace("{n}", segmentText(detail.humanWaitMs))}`,
														].join(""),
													}),
													metaParts.length === 0 ? null : jsxRuntime.jsx("div", { className: "dsafm_review_meta", children: metaParts.join(" · ") }),
													sectionOf("detail.reason", absentKeyOf("reason"), detail.reason, truncated),
													sectionOf("detail.evidence", absentKeyOf("evidence"), detail.evidence, truncated),
													sectionOf("detail.probes", absentKeyOf("probes"), detail.probes, truncated),
													sectionOf("detail.prompt", absentKeyOf("prompt"), detail.prompt, truncated),
													sectionOf("detail.input", absentKeyOf("input"), detail.input, truncated),
													sectionOf("detail.reasoning", absentKeyOf("reasoning"), detail.reasoning, truncated),
													sectionOf("detail.output", absentKeyOf("output"), detail.output, truncated),
												],
											}),
									],
								})
								: null,
						],
					},
					record.approvalId,
				);
			});

			return jsxRuntime.jsxs("div", {
				className: "dsafm_review",
				children: [bar, retentionLine, jsxRuntime.jsx("div", { className: "dsafm_review_list", children: rows })],
			});
		}

		/**
		 * 记录表近似行的会话定义（design §8.5 第二落点，默认关）。
		 *
		 * `approval/asked` 开一个上下文、`approval/decided` 收尾（同一 `id` 配对），收尾后产出一行
		 * `kind: 'context'` 节点，文案含工具名、判定与耗时（两条审计事件的时间戳差）。
		 * 位置与时长条由内置视图决定（落在工具行之下、无时长条），本定义控制不了。
		 * @param {(key: string) => string} translate - 绑定到本命名空间的翻译函数。
		 * @returns {object} `ConversationNodeDefinition`。
		 */
		function legacyRowDefinition(translate) {
			/**
			 * 结局文案：`approval/decided` 的闭集词汇走字典，未知值原样返回。
			 * @param {unknown} outcome - 结局值。
			 * @returns {string} 文案。
			 */
			const outcomeLabel = (outcome) => {
				const key = `legacy.outcome.${outcome}`;
				const text = translate(key);
				return text === key ? String(outcome) : text;
			};
			return {
				kind: "approve-for-me-approval-row",
				target: "trajectory",
				match: (event) => {
					const type = event?.type;
					if (type !== "approval/asked" && type !== "approval/decided") return null;
					const id = typeof event.data?.id === "string" && event.data.id.length > 0 ? event.data.id : "";
					if (id === "") return null;
					return { id: `approval:${id}`, role: type === "approval/asked" ? "start" : "update" };
				},
				start: (_context, match) => ({ asked: match.event }),
				update: (context, match) => ({ asked: context.state?.asked ?? match.event, decided: match.event }),
				buildViewNode: (context) => {
					const state = context.state;
					const asked = state?.asked;
					const decided = state?.decided;
					// 只收尾了才成行（耗时需要两条事件的时间戳）。
					if (asked === undefined || decided === undefined) return null;
					const toolName = typeof asked.data?.toolName === "string" && asked.data.toolName.length > 0 ? asked.data.toolName : "-";
					const outcome = typeof decided.data?.outcome === "string" && decided.data.outcome.length > 0 ? decided.data.outcome : "-";
					const duration =
						Number.isFinite(decided.time) && Number.isFinite(asked.time)
							? formatMillis(Math.max(0, decided.time - asked.time))
							: "-";
					const text = translate("legacy.row")
						.replace("{tool}", toolName)
						.replace("{decision}", outcomeLabel(outcome))
						.replace("{duration}", duration);
					// 与宿主 `trajectoryNode` 同形的 target 包裹：data 是 `node` 贡献，节点本身是 ContextMessageNode 形状。
					return {
						key: context.key,
						kind: context.kind,
						id: context.id,
						target: "trajectory",
						anchorSeq: asked.seq,
						location: context.start?.location ?? { kind: "unresolved" },
						data: {
							kind: "node",
							node: {
								kind: "context",
								seq: asked.seq,
								time: asked.time,
								content: [{ type: "text", text }],
								source: { kind: "plugin", plugin: "dsh-approve-for-me" },
							},
						},
					};
				},
			};
		}

		/**
		 * 注册记录表近似行（可选，默认关）：`getState.trace.legacyRow === true` 时才等 `uiConversation` 服务并注册定义。
		 *
		 * 两条强制约束（违反会让整个客户端半部加载失败）：
		 * - `uiConversation` 在插件 `apply` 时还没注册——用**全局** `setTimeout` 轮询（500 ms，最多 20 次），拿到再注册；
		 * - 整个流程任何异常只写诊断对象 `window.__dsafmProbe`，绝不外抛；`legacyRow` 缺字段按关处理，不猜。
		 * @param {object} ctx - 客户端根上下文。
		 * @param {(endpoint: string, args: object) => Promise<object | undefined>} rpcCall - RPC 调用。
		 * @param {() => string} sessionIdOf - 读当前会话 id。
		 * @param {(key: string) => string} translate - 绑定到本命名空间的翻译函数。
		 * @returns {void}
		 */
		function registerLegacyRow(ctx, rpcCall, sessionIdOf, translate) {
			let timer;
			let disposer;
			let stopped = false;
			const probe = { stage: "off", tries: 0 };
			/**
			 * 写一行诊断；写不进去（无 window）就算了。
			 * @param {string} stage - 阶段名。
			 * @param {unknown} [failure] - 失败原因。
			 * @returns {void}
			 */
			const note = (stage, failure) => {
				probe.stage = stage;
				if (failure !== undefined) probe.error = String(failure);
				try {
					if (typeof window !== "undefined") window.__dsafmProbe = probe;
				} catch {
					// 诊断通道失败没有下一级承接，吞掉。
				}
			};
			// 卸载时停轮询并撤注册（`events.register` 返回幂等 disposer）。
			ctx.effect(
				() => () => {
					stopped = true;
					if (timer !== undefined) clearTimeout(timer);
					if (typeof disposer === "function") disposer();
				},
				"approve-for-me: legacy row",
			);
			try {
				Promise.resolve()
					.then(() => rpcCall("approveForMe/getState", { sessionId: sessionIdOf() }))
					.then((response) => {
						if (stopped || response?.ok !== true || response.value?.trace?.legacyRow !== true) {
							note("off");
							return;
						}
						const definition = legacyRowDefinition(translate);
						const attempt = (tries) => {
							if (stopped) return;
							probe.tries = tries;
							let service;
							try {
								service = ctx.get("uiConversation");
							} catch {
								service = undefined;
							}
							if (service === undefined || service === null || typeof service.events?.register !== "function") {
								if (tries >= 20) {
									note("service-missing");
									return;
								}
								timer = setTimeout(() => attempt(tries + 1), 500);
								return;
							}
							try {
								disposer = service.events.register(definition);
								note("registered");
							} catch (failure) {
								note("register-failed", failure);
							}
						};
						attempt(1);
					})
					.catch((failure) => note("state-failed", failure));
			} catch (failure) {
				note("state-failed", failure);
			}
		}

		/**
		 * 插件设置卡（挂 Plugins 页本包详情 `plugins.bundle.config`）：读 `configForms` 控制器快照（与旧 scope 同形）。
		 *
		 * 外观照官方设置表单重绘（规格与自绘落点见 docs/design.md）——无卡片外壳与分区标题、字段竖排、
		 * 覆盖＝胶囊「已覆盖」＋「恢复默认」、说明常驻＋帮助点击展开、底部唯一「保存」且无改动/非法/保存中置灰；
		 * 一切编辑（含接管预设、模型/档位、映射表、跟随执行助手模型）先暂存，只有「保存」写库，离开页面丢弃（requirements §6.1）。
		 * 嵌套路径沿用 `mutate` 的路径操作；数字字段直接用官方 `SettingsValueField`，其余控件按官方输入规格自绘。
		 * 写通道注意：控制器的 `mutate` 对「宿主拒绝」解析 `false` 而不抛错，保存后按返回值定相位并依赖订阅回读快照。
		 * @param {object} props - 注入的 `scope`（configForms 控制器）、`rpcCall`、`t` 与页面主的 `view`。
		 * @returns {object} React 元素。
		 */
		function SettingsCard(props) {
			// 槽位注入的 useNsT 优先（强制语言档）；旧宿主/直调测试没传时退回宿主 t（auto 行为）。
			const { t: hostT, useNsT, scope } = props;
			const t =
				typeof useNsT === "function"
					? useNsT(hostT)
					: typeof hostT === "function"
						? hostT
						: (key) => key;
			const rpcCall = typeof props.rpcCall === "function" ? props.rpcCall : null;
			const [snapshot, setSnapshot] = react.useState(() => scope.getSnapshot());
			// 暂存（requirements §6.1「只有保存才写」）：键＝字段路径（"." 连接），
			// 值＝{text}（FIELDS 文本）| {value}（结构化：presets/model/行表/布尔）| {clear}（恢复默认）。
			// 控件显示值＝暂存值 ?? 快照种子；暂存是组件本地 state，卸载即弃（离开页面丢弃，官方语义）。
			const [staged, setStaged] = react.useState({});
			const [phase, setPhase] = react.useState("idle");
			const [error, setError] = react.useState("");
			const [catalog, setCatalog] = react.useState(null);
			const [efforts, setEfforts] = react.useState({});

			react.useEffect(() => scope.subscribe(() => setSnapshot(scope.getSnapshot())), [scope]);

			react.useEffect(() => {
				if (rpcCall === null) return undefined;
				let alive = true;
				Promise.resolve()
					.then(() => rpcCall("approveForMe/modelCatalog", {}))
					.then((response) => {
						if (alive && response?.ok === true) setCatalog(response.value);
					})
					.catch(() => {});
				return () => {
					alive = false;
				};
			}, []);

			/**
			 * 按需读档位表并写进缓存；同一引用只请求一次，失败时记空表（design §7.2）。
			 * @param {string} ref - 模型引用。
			 * @returns {void}
			 */
			const requestEfforts = (ref) => {
				if (rpcCall === null || splitRef(ref).model.length === 0 || efforts[ref] !== undefined) return;
				setEfforts((previous) => (previous[ref] === undefined ? { ...previous, [ref]: { efforts: [] } } : previous));
				fetchEfforts(rpcCall, ref).then((entry) => setEfforts((previous) => ({ ...previous, [ref]: entry })));
			};

			const user = snapshot?.user ?? {};
			const value = snapshot?.value ?? {};
			const base = snapshot?.base ?? {};
			const writable = snapshot?.writable === true;

		/**
			 * 写入一个暂存条目。
			 * @param {string} key - 字段路径（"." 连接）。
			 * @param {object} entry - 暂存值（{text}/{value}/{clear}）。
			 * @returns {void}
			 */
			const stageEntry = (key, entry) => setStaged((previous) => ({ ...previous, [key]: entry }));
			/**
			 * 暂存 FIELDS 文本。
			 * @param {object} field - 字段定义。
			 * @param {string} text - 编辑文本。
			 * @returns {void}
			 */
			const stageText = (field, text) => stageEntry(field.path.join("."), { text });
			/**
			 * 暂存「恢复默认」（clear）：控件立即显示组合层默认值，保存时才落 unset。
			 * @param {readonly string[]} path - 字段路径。
			 * @returns {void}
			 */
			const stageClear = (path) => stageEntry(path.join("."), { clear: true });
			/**
			 * 暂存结构化值（presets 数组 / model 对象 / 行表 / 布尔）。
			 * @param {readonly string[]} path - 字段路径。
			 * @param {unknown} val - 值。
			 * @returns {void}
			 */
			const stageValue = (path, val) => stageEntry(path.join("."), { value: val });

			/**
			 * FIELDS 字段的暂存显示文本：暂存 ?? base（clear）?? 快照种子（toDraft 现算）。
			 * @param {object} field - 字段定义。
			 * @returns {string} 显示文本。
			 */
			const draftOf = (field) => {
				const entry = staged[field.path.join(".")];
				if (entry === undefined) return toDraft(getPath(value, field.path), field);
				if (entry.clear === true) return toDraft(getPath(base, field.path), field);
				return entry.text ?? "";
			};

			/**
			 * 结构化字段的暂存显示值。
			 * @param {string} key - 字段路径（"." 连接）。
			 * @param {unknown} seed - 快照种子。
			 * @param {unknown} baseSeed - 组合层默认值（clear 时的显示值）。
			 * @returns {unknown} 显示值。
			 */
			const stagedSpecial = (key, seed, baseSeed) => {
				const entry = staged[key];
				if (entry === undefined) return seed;
				if (entry.clear === true) return baseSeed;
				return entry.value;
			};

			/**
			 * 覆盖标记：暂存 clear → 无；暂存写 → 有（保存将留下覆盖，与基线同值也算）；
			 * 无暂存 → 用户层有该键（键在场，不是值比较）。
			 * @param {readonly string[]} path - 字段路径。
			 * @returns {boolean} 是否显示「已覆盖」。
			 */
			const overriddenOf = (path) => {
				const entry = staged[path.join(".")];
				if (entry === undefined) return getPath(user, path) !== undefined;
				return entry.clear !== true;
			};

			/**
			 * 结构化字段的显示值与暂存入口（模型选择、行表、跟随执行助手模型、预设数组）。
			 * @param {readonly string[]} path - 字段路径。
			 * @param {(seed: unknown, baseSeed: unknown) => unknown} [normalize] - 种子归一化。
			 * @returns {{display: unknown, set: (next: unknown) => void}} 显示值与暂存函数。
			 */
			const specialOf = (path, normalize) => {
				const key = path.join(".");
				const norm = typeof normalize === "function" ? normalize : (raw) => raw;
				return {
					display: stagedSpecial(key, norm(getPath(value, path)), norm(getPath(base, path))),
					set: (next) => stageValue(path, next),
				};
			};

			/** 行表 → 映射对象：键取纯模型 id，空键行丢弃（design §7.2）。 */
			const rowsToMap = (rows) => {
				const map = {};
				for (const row of rows) {
					const key = keyOf(row.parent);
					if (key.length > 0) map[key] = { model: row.model, effort: row.effort };
				}
				return map;
			};

			/** 四个结构化字段的保存规格（与 FIELDS 同一条暂存 → 保存路径）。 */
			const SPECIAL_PLAN = [
				{ path: ["reviewer", "model"], toValue: (val) => val },
				{ path: ["reviewer", "byParentModel"], toValue: rowsToMap },
				{ path: ["reviewer", "followParent"], toValue: (val) => val },
				{ path: ["trigger", "presets"], toValue: (val) => (Array.isArray(val) ? val : []) },
			];

			/**
			 * 保存计划：逐暂存条目解析——非法值阻塞（invalid）；与快照现值相同的条目跳过；
			 * clear 在用户层无键时也无操作（官方 SettingsFormModel.plan 同款语义）。
			 * @returns {{ops: object[], invalid: boolean}} 路径操作与合法性。
			 */
			const plan = () => {
				const ops = [];
				let invalid = false;
				for (const field of FIELDS) {
					const entry = staged[field.path.join(".")];
					if (entry === undefined) continue;
					if (entry.clear === true) {
						if (getPath(user, field.path) !== undefined) ops.push({ op: "unset", path: field.path });
						continue;
					}
					const parsed = fromDraft(entry.text, field, t);
					if (parsed.ok !== true) {
						invalid = true;
						continue;
					}
					const current = getPath(value, field.path);
					if (JSON.stringify(current ?? null) === JSON.stringify(parsed.value ?? null)) continue;
					ops.push(parsed.value === undefined ? { op: "unset", path: field.path } : { op: "set", path: field.path, value: parsed.value });
				}
				for (const spec of SPECIAL_PLAN) {
					const entry = staged[spec.path.join(".")];
					if (entry === undefined) continue;
					if (entry.clear === true) {
						if (getPath(user, spec.path) !== undefined) ops.push({ op: "unset", path: spec.path });
						continue;
					}
					const nextValue = spec.toValue(entry.value);
					const current = getPath(value, spec.path);
					if (JSON.stringify(current ?? null) === JSON.stringify(nextValue ?? null)) continue;
					ops.push({ op: "set", path: spec.path, value: nextValue });
				}
				return { ops, invalid };
			};

			const planNow = plan();
			const blocked = planNow.ops.length === 0 || planNow.invalid || phase === "saving";

			/**
			 * 保存：一次 `mutate` 写入全部暂存；成功清空暂存（显示值回落到新快照），
			 * 失败保留暂存供修改（官方语义）。0.1.7 控制器对「宿主拒绝」解析 false 而不抛错。
			 * @returns {void}
			 */
			const save = () => {
				const current = plan();
				if (current.ops.length === 0 || current.invalid || phase === "saving") return;
				setPhase("saving");
				setError("");
				scope.mutate(current.ops).then(
					(accepted) => {
						if (accepted === false) {
							setPhase("failed");
							setError(t("card.failed"));
						} else {
							setPhase("idle");
							setStaged({});
						}
					},
					(failure) => {
						setPhase("failed");
						setError(failure instanceof Error ? failure.message : String(failure));
					},
				);
			};

			/**
			 * 字段外壳（design §7.2）：标签行（label ＋帮助按钮 ＋覆盖组）→ 控件 → 常驻说明 →（展开的）帮助区。
			 * 帮助按钮 24×24、`IconInfoOutlineRegular`（12px）、`aria-expanded`/`aria-controls` 成对、键盘可达；
			 * 覆盖组＝`Tag`「已覆盖」＋文本按钮「恢复默认」（只暂存 `{clear}`，不写库）。
			 * @param {object} options - `label`/`path`/`hint`/`helpText`/`onReset` 与 `control(controlId, describedby)`。
			 * @returns {object} 元素。
			 */
			/**
		 * 说明开关（design §7.2.1）：图标与可见文字「说明／收起说明」同置按钮内，Enter 与 Space
		 * 键盘路径承载同一开合动作（`preventDefault` 防 Space 滚动与双触发）；展开区 `role="region"`、
		 * 无障碍名与按钮一致。字段外壳与数字字段的平铺说明行共用同一实现。
		 * @param {object} options - `label`/`helpId`/`open`/`setOpen`/`helpText`。
		 * @returns {object[]} 二元组 `[按钮, 展开区]`（收起时展开区为 null）。
		 */
		const helpToggleOf = (options) => {
			const { label, helpId, open, setOpen, helpText } = options;
			const toggle = () => setOpen((state) => !state);
			// 无障碍名＝「字段名：说明／收起说明」；分隔符随语言档：文案含 CJK 取全角冒号，否则半角冒号加空格。
			const nameOf = (isOpen) => {
				const word = t(isOpen ? "help.collapse" : "help.expand");
				const colon = /[\u3400-\u9fff]/u.test(word) ? "：" : ": ";
				return `${label}${colon}${word}`;
			};
			const button = jsxRuntime.jsxs("button", {
				type: "button",
				className: "dsafm_helpbtn",
				"aria-label": nameOf(open),
				"aria-expanded": open,
				"aria-controls": helpId,
				onClick: toggle,
				onKeyDown: (event) => {
					if (event.key !== "Enter" && event.key !== " ") return;
					event.preventDefault();
					toggle();
				},
				children: [
					jsxRuntime.jsx(primitives.IconInfoOutlineRegular, { size: 12 }),
					jsxRuntime.jsx("span", { className: "dsafm_helpbtn_text", children: open ? t("help.collapse") : t("help.expand") }),
				],
			});
			const region = open
				? jsxRuntime.jsx("div", { id: helpId, className: "dsafm_helpregion", role: "region", "aria-label": nameOf(true), children: helpText })
				: null;
			return [button, region];
		};

		const fieldShell = (options) => {
				const { label, path, hint, helpText, onReset, control } = options;
				// 直接调用（非组件引用）：钩子顺序＝字段固定次序，真 React 与测试替身都稳定。
				const [open, setOpen] = react.useState(false);
				const suffix = path.join("-");
				const controlId = `${NS}-ctl-${suffix}`;
				const hintId = `${NS}-hint-${suffix}`;
				const helpId = `${NS}-help-${suffix}`;
				const describedby = [hintId, open ? helpId : ""].filter(Boolean).join(" ");
				// 行内控件（布尔勾选类）：控件进标签行右端，不再单独占一行（勾孤悬在标签下方会被当成误置元素）。
				const inline = options.inlineControl === true ? control(controlId, describedby) : null;
			const [helpButton, helpRegion] = helpToggleOf({ label, helpId, open, setOpen, helpText });
				return jsxRuntime.jsxs("div", {
					className: "dsafm_field",
					children: [
						jsxRuntime.jsxs("div", {
							className: "dsafm_f_head",
							children: [
								jsxRuntime.jsxs("div", {
									className: "dsafm_labelgroup",
									children: [
										jsxRuntime.jsx("label", { className: "dsafm_f_label", htmlFor: controlId, children: label }),
										helpButton,
									],
								}),
								overriddenOf(path)
									? jsxRuntime.jsxs("span", {
										className: "dsafm_badges",
										children: [
											jsxRuntime.jsx(primitives.Tag, { tone: "neutral", children: t("card.override") }),
											jsxRuntime.jsx("button", {
												type: "button",
												className: "dsafm_reset",
												disabled: !writable,
												onClick: onReset,
												children: t("card.resetField"),
											}),
										],
									})
									: null,
								inline === null ? null : jsxRuntime.jsx("span", { className: "dsafm_inlinecheck", children: inline }),
							],
						}),
						inline === null ? control(controlId, describedby) : null,
						jsxRuntime.jsx("p", { id: hintId, className: "dsafm_f_hint", children: hint }),
						helpRegion,
					],
				});
			};

			/**
			 * 纯数字字段直接用官方 `SettingsValueField`（自带标签行/覆盖组/非法文案全套，其 CSS 无失效令牌；官方组件不传 help——纯图标按钮无法承载文字，design §7.2.1）。
			 * 说明入口改为官方字段之后平铺一行自绘说明行（毫秒字段顺序＝官方字段 → 秒数读数行 → 说明行，非毫秒字段说明行紧随官方字段，design §7.2.1）。
			 * 读数自绘在官方组件之外——官方 hint 在字段非法时被非法文案整段顶掉，拼进去会让生效值读数消失。
			 * @param {object} field - 字段定义。
			 * @returns {object} 元素。
			 */
			const numberField = (field) => {
				const key = field.path.join(".");
				const entry = staged[key];
				const invalid = entry !== undefined && entry.clear !== true && fromDraft(entry.text, field, t).ok !== true;
				const control = jsxRuntime.jsx(primitives.SettingsValueField, {
					id: `${NS}-ctl-${key.replace(/\./gu, "-")}`,
					label: t(field.labelKey),
					hint: t(`hint.${key}`),
					overriddenLabel: t("card.override"),
					resetLabel: t("card.resetField"),
					invalidLabel: t("card.invalidNumber"),
					numeric: true,
					disabled: !writable,
					overridden: overriddenOf(field.path),
					invalid,
					text: draftOf(field),
					onEdit: (text) => stageText(field, text),
					onReset: () => stageClear(field.path),
				});
				// 说明入口平铺（design §7.2.1）：官方组件不传 help（纯图标按钮无法承载文字），钩子顺序＝
				// 数字字段固定次序（每个数字字段恰一次 useState），真 React 与测试替身都稳定。
				const [open, setOpen] = react.useState(false);
				const helpId = `${NS}-help-${key.replace(/\./gu, "-")}`;
				const [helpButton, helpRegion] = helpToggleOf({ label: t(field.labelKey), helpId, open, setOpen, helpText: t(`help.${key}`) });
				const helpLine = jsxRuntime.jsxs("div", { className: "dsafm_f_help", children: [helpButton, helpRegion] });
				if (field.unit !== "ms") return jsxRuntime.jsxs(react.Fragment, { children: [control, helpLine] });
				return jsxRuntime.jsxs(react.Fragment, { children: [control, secondsLine(field), helpLine] });
			};

			/**
			 * 毫秒字段的秒数读数行（requirements §6.1）：生效值读数＝快照生效值（常驻，不随草稿变化）；
			 * 草稿读数＝暂存显示文本（渲染期现算，每次输入后的重渲染即更新——不防抖、不等失焦、不等保存）。
			 * 占位口径与数字字段草稿同一口径（有限、≥0、整数）；草稿非法时占位并转错误色，空串占位不变色（空不是非法）。
			 * @param {object} field - 字段定义（`unit:"ms"`）。
			 * @returns {object} 元素。
			 */
			const secondsLine = (field) => {
				const unit = t("seconds.unit");
				const resolvedNumber = secondsNumberText(getPath(value, field.path));
				const draftRaw = draftOf(field).trim();
				const draftNumber = draftRaw.length === 0 ? null : secondsNumberText(Number(draftRaw));
				const fill = (number) => (number === null ? "—" : `${number} ${unit}`);
				const draftInvalid = draftRaw.length > 0 && draftNumber === null;
				// 无上限风险提醒固定渲染在审查时限字段的秒数读数行内（design §7.2），可见性不依赖
				// 帮助区展开；草稿为 0 或生效值为 0 时显示。只描述风险，不改写输入：草稿为 0 仍可保存。
				// 人工时限字段的 0 是「立即拒绝」，不显示该提醒。
				const noLimitWarn =
					field.path.join(".") === "reviewer.timeoutMs" &&
					(resolvedNumber === "0" || draftNumber === "0")
						? t("warn.noLimit")
						: null;
				return jsxRuntime.jsxs("p", {
					id: `${NS}-sec-${field.path.join("-")}`,
					className: "dsafm_f_sec",
					children: [
						jsxRuntime.jsx("span", {
							className: "dsafm_sec_resolved",
							children: t("seconds.resolved").replace("{v}", fill(resolvedNumber)),
						}),
						" · ",
						jsxRuntime.jsx("span", {
							className: draftInvalid ? "dsafm_sec_draft dsafm_sec_invalid" : "dsafm_sec_draft",
							children: t("seconds.draft").replace("{v}", fill(draftNumber)),
						}),
						noLimitWarn === null ? null : jsxRuntime.jsx("span", { className: "dsafm_sec_warn", children: noLimitWarn }),
					],
				});
			};

			/**
			 * 模型下拉：目录里的全部引用，外加目录没有的当前值。
			 * @param {string} current - 当前模型引用。
			 * @param {(ref: string) => void} onChange - 选择回调。
			 * @param {string} [controlId] - 控件 id（标签行 htmlFor 指向第一个控件）。
			 * @param {string} [describedby] - aria-describedby。
			 * @returns {object} 元素。
			 */
			const modelSelect = (current, onChange, controlId, describedby) =>
				jsxRuntime.jsxs("select", {
					id: controlId,
					className: "dsafm_input dsafm_model",
					value: current,
					title: current,
					disabled: !writable,
					"aria-describedby": describedby,
					onChange: (event) => onChange(event.target.value),
					children: [
						jsxRuntime.jsx("option", { value: "", children: t("card.unset") }, ""),
						...modelRefsOf(catalog, current).map((ref) => jsxRuntime.jsx("option", { value: ref, children: ref }, ref)),
					],
				});

			/**
			 * 档位下拉：首项固定「自动选择」；模型未选定或未取到档位时置灰不可写（design §7.2）。
			 * @param {string} ref - 所属模型引用。
			 * @param {string} current - 当前档位。
			 * @param {(effort: string) => void} onChange - 选择回调。
			 * @returns {object} 元素。
			 */
			const effortSelect = (ref, current, onChange) => {
				const view = effortOptions(efforts[ref], current, t("effort.default"), t("card.effort.unsupported"));
				return jsxRuntime.jsxs("select", {
					className: "dsafm_input dsafm_effort",
					value: current,
					title: current.length === 0 ? t("effort.default") : current,
					disabled: !writable || !view.writable,
					onChange: (event) => onChange(event.target.value),
					children: view.options.map((option) =>
						jsxRuntime.jsx(
							"option",
							{
								value: option.value,
								disabled: option.disabled === true,
								title: option.disabled === true ? option.label : undefined,
								children: option.label,
							},
							option.value,
						),
					),
				});
			};

			/**
			 * 换模型后保留哪个档位：新模型支持就保留，否则清空（design §7.3 的同一规则）。
			 * @param {string} ref - 新模型引用。
			 * @param {string} current - 当前档位。
			 * @returns {Promise<string>} 档位。
			 */
			const pickEffort = (ref, current) => {
				if (current.length === 0 || splitRef(ref).model.length === 0) return Promise.resolve("");
				const cached = efforts[ref];
				if (cached !== undefined) return Promise.resolve(cached.efforts.some((item) => item.id === current) ? current : "");
				return fetchEfforts(rpcCall, ref).then((entry) => {
					setEfforts((previous) => ({ ...previous, [ref]: entry }));
					return entry.efforts.some((item) => item.id === current) ? current : "";
				});
			};

			// 结构化字段的显示值（暂存优先；种子与组合层默认值经归一化后取用）。
			const displayChoice = specialOf(["reviewer", "model"], choiceOf).display;
			const displayRows = specialOf(["reviewer", "byParentModel"], rowsOf).display;
			const displayFollow = specialOf(["reviewer", "followParent"], (raw) => raw !== false).display;
			const displayPresets = specialOf(["trigger", "presets"], (raw) => (Array.isArray(raw) ? raw : [])).display;

			react.useEffect(() => {
				requestEfforts(displayChoice.model);
				for (const row of displayRows) requestEfforts(row.model);
			});

			/** 模型选择字段的暂存入口。 */
			const stageModel = (next) => stageValue(["reviewer", "model"], next);

			const chooseDefaultModel = (ref) => {
				pickEffort(ref, displayChoice.effort).then((effort) => stageModel({ model: ref, effort }));
			};

			const chooseDefaultEffort = (effort) => {
				stageModel({ model: displayChoice.model, effort });
			};

			/**
			 * 暂存行表（不再即时写库）；键归一化挪到保存计划（rowsToMap）。
			 * @param {object[]} next - 新行表。
			 * @returns {void}
			 */
			const stageRows = (next) => stageValue(["reviewer", "byParentModel"], next);

			const patchRow = (index, patch) => stageRows(displayRows.map((row, position) => (position === index ? { ...row, ...patch } : row)));
			const typeRow = (index, text) => stageRows(displayRows.map((row, position) => (position === index ? { ...row, parent: text } : row)));
			const chooseRowModel = (index, ref) => {
				const current = displayRows[index]?.effort ?? "";
				pickEffort(ref, current).then((effort) => patchRow(index, { model: ref, effort }));
			};

			/**
			 * 普通字段行（select/bool/lines/数字）；数字字段用官方 `SettingsValueField`，其余走字段外壳自绘。
			 * @param {object} field - 字段定义。
			 * @returns {object} 行元素。
			 */
			const fieldRow = (field) => {
				if (field.kind === "number") return numberField(field);
				const key = field.path.join(".");
				/**
				 * 选项的中文文案：`option.<字段路径>.<值>`；字典缺该键时退回原值（外部来源的值保持原样，design §7.2）。
				 * @param {string} option - 原值。
				 * @returns {string} 展示文案。
				 */
				const label = (option) => {
					const text = t(`option.${key}.${option}`);
					return text === `option.${key}.${option}` ? option : `${text}（${option}）`;
				};
				return fieldShell({
					label: t(field.labelKey),
					path: field.path,
					hint: t(`hint.${key}`),
					helpText: t(`help.${key}`),
					onReset: () => stageClear(field.path),
					control: (controlId, describedby) =>
						field.kind === "select" || field.kind === "bool"
							? jsxRuntime.jsxs("select", {
									id: controlId,
									className: "dsafm_input",
									value: draftOf(field),
									disabled: !writable,
									"aria-describedby": describedby,
									onChange: (event) => stageText(field, event.target.value),
									children: [
										jsxRuntime.jsx("option", { value: "", children: t("card.value.unset") }),
										...(field.kind === "bool" ? ["true", "false"] : field.options).map((option) =>
											jsxRuntime.jsx(
												"option",
												{
													value: option,
													children: field.kind === "bool" ? t(option === "true" ? "card.bool.on" : "card.bool.off") : label(option),
												},
												option,
											),
										),
									],
								})
							: field.kind === "lines"
								? jsxRuntime.jsx("textarea", {
										id: controlId,
										className: "dsafm_input dsafm_area",
										value: draftOf(field),
										disabled: !writable,
										rows: 4,
										"aria-describedby": describedby,
										onChange: (event) => stageText(field, event.target.value),
									})
								: jsxRuntime.jsx("input", {
										id: controlId,
										className: "dsafm_input",
										type: "text",
										value: draftOf(field),
									disabled: !writable,
									"aria-describedby": describedby,
									onChange: (event) => stageText(field, event.target.value),
								}),
				});
			};

			/**
			 * 映射行：执行助手模型（下拉，列【模型】里注册的全部模型；另留「自定义…」兼顾手输）→
			 * 审查模型 → 档位 → 删除。四列布局由 `.dsafm_map_row` 的 grid 定义，整表占满卡片宽度；
			 * 每个下拉的 `title` 取当前完整值，长引用可悬停看全。键仍取纯模型 id，与解析侧一致（design §7.2）。
			 */
			const parentRefs = modelRefsOf(catalog, "");
			const mapRows = displayRows.map((row, index) =>
				jsxRuntime.jsxs(
					"div",
					{
						className: "dsafm_map_row",
						children: [
							row.custom === true
								? jsxRuntime.jsx("input", {
									className: "dsafm_input dsafm_map_parent",
									type: "text",
									value: row.parent,
									title: row.parent,
									placeholder: t("card.map.placeholder.parent"),
									disabled: !writable,
									onChange: (event) => typeRow(index, event.target.value),
								})
								: jsxRuntime.jsxs("select", {
									className: "dsafm_input dsafm_map_parent",
									value: displayRef(row.parent, catalog),
									title: displayRef(row.parent, catalog),
									disabled: !writable,
									onChange: (event) => {
										const value = event.target.value;
										if (value === "__custom__") {
											patchRow(index, { custom: true });
											return;
										}
										patchRow(index, { parent: keyOf(value), custom: false });
									},
									children: [
										jsxRuntime.jsx("option", { value: "", children: t("card.map.parent") }, ""),
										...parentRefs.map((ref) => jsxRuntime.jsx("option", { value: ref, children: ref }, ref)),
										row.parent !== "" && !parentRefs.includes(displayRef(row.parent, catalog))
											? jsxRuntime.jsx("option", { value: displayRef(row.parent, catalog), children: displayRef(row.parent, catalog) }, "__keep__")
											: null,
										jsxRuntime.jsx("option", { value: "__custom__", children: t("card.map.custom") }, "__custom__"),
									],
								}),
							modelSelect(row.model, (ref) => chooseRowModel(index, ref)),
							effortSelect(row.model, row.effort, (effort) => patchRow(index, { effort })),
							jsxRuntime.jsx("button", {
								type: "button",
								className: "dsafm_button dsafm_map_del",
								disabled: !writable,
								onClick: () => stageRows(displayRows.filter((entry, position) => position !== index)),
								children: t("card.map.remove"),
							}),
						],
					},
					String(index),
				),
			);

			/** 默认审查模型行（字段外壳＋模型/档位两个下拉，选择即暂存）。 */
			const modelRow = () =>
				fieldShell({
					label: t("card.field.defaultModel"),
					path: ["reviewer", "model"],
					hint: t("hint.reviewer.model"),
					helpText: t("help.reviewer.model"),
					onReset: () => stageClear(["reviewer", "model"]),
					control: (controlId, describedby) =>
						jsxRuntime.jsxs("div", {
							className: "dsafm_ctl",
							children: [
								modelSelect(displayChoice.model, chooseDefaultModel, controlId, describedby),
								effortSelect(displayChoice.model, displayChoice.effort, chooseDefaultEffort),
							],
						}),
				});

			/** 按执行助手模型映射行（字段外壳＋全宽四列表，增删改只暂存）。 */
			const mapRow = () =>
				fieldShell({
					label: t("card.field.byParentModel"),
					path: ["reviewer", "byParentModel"],
					hint: t("hint.reviewer.byParentModel"),
					helpText: t("help.reviewer.byParentModel"),
					onReset: () => stageClear(["reviewer", "byParentModel"]),
					control: (controlId, describedby) =>
						jsxRuntime.jsxs("div", {
							className: "dsafm_map",
							id: controlId,
							"aria-describedby": describedby,
							children: [
								jsxRuntime.jsxs("div", {
									className: "dsafm_map_head",
									children: [
										jsxRuntime.jsx("span", { children: t("card.map.col.parent") }),
										jsxRuntime.jsx("span", { children: t("card.map.col.reviewer") }),
										jsxRuntime.jsx("span", { children: t("card.map.col.effort") }),
										jsxRuntime.jsx("span", { children: t("card.map.col.action") }),
									],
								}),
								...mapRows,
								jsxRuntime.jsx("button", {
									type: "button",
									className: "dsafm_button dsafm_map_add",
									disabled: !writable,
									onClick: () => stageRows([...displayRows, { parent: "", model: "", effort: "" }]),
									children: t("card.map.add"),
								}),
							],
						}),
				});

			/** 跟随执行助手模型行（字段外壳＋复选框，勾选只暂存；复选框置于标签行右端）。 */
			const followParentRow = () =>
				fieldShell({
					label: t("card.field.followParent"),
					path: ["reviewer", "followParent"],
					hint: t("hint.reviewer.followParent"),
					helpText: t("help.reviewer.followParent"),
					onReset: () => stageClear(["reviewer", "followParent"]),
					inlineControl: true,
					control: (controlId, describedby) =>
						jsxRuntime.jsx("input", {
							id: controlId,
							className: "dsafm_check",
							type: "checkbox",
							checked: displayFollow === true,
							disabled: !writable,
							"aria-describedby": describedby,
							onChange: (event) => stageValue(["reviewer", "followParent"], event.target.checked),
						}),
				});

			/** 接管预设行（字段外壳＋多选 picker；勾选只暂存）。 */
			const presetsRow = () =>
				fieldShell({
					label: t("card.presets.label"),
					path: ["trigger", "presets"],
					hint: t("hint.trigger.presets"),
					helpText: t("help.trigger.presets"),
					onReset: () => stageClear(["trigger", "presets"]),
					control: (controlId, describedby) =>
						PresetPicker({
							t,
							rpcCall,
							id: controlId,
							describedby,
							selected: displayPresets,
							writable,
							onChange: (next) => stageValue(["trigger", "presets"], next),
						}),
				});

			// 打开即见＋字段顺序（design §7.2「21 字段」清单，无分区标题）：
			// 接管预设 → 触发两行 → 默认审查模型 → 映射 → 跟随执行助手模型 → 高级其余行；插件标题/描述由宿主页面自己画。
			return jsxRuntime.jsxs("div", {
				className: "dsafm_form",
				children: [
					writable ? null : jsxRuntime.jsx("p", { className: "dsafm_readonly", role: "status", children: t("card.readonly") }),
					presetsRow(),
					...FIELDS.filter((field) => field.section === "trigger").map((field) => fieldRow(field)),
					modelRow(),
					mapRow(),
					followParentRow(),
					...FIELDS.filter((field) => field.section === "advanced").map((field) => fieldRow(field)),
					jsxRuntime.jsxs("div", {
						className: "dsafm_footer",
						children: [
							phase === "failed"
								? jsxRuntime.jsx("p", {
										className: "dsafm_failed",
										role: "status",
										children: error === "" ? t("card.failed") : `${t("card.failed")}：${error}`,
									})
								: null,
							// 唯一「保存」：无改动/有非法值/保存中置灰（requirements §6.1；置灰条件与官方 blocked 字段同款）。
							jsxRuntime.jsx("button", {
								type: "button",
								className: "dsafm_save",
								disabled: !writable || blocked,
								onClick: save,
								children: phase === "saving" ? t("card.saving") : t("card.save"),
							}),
						],
					}),
				],
			});
		}

		/** 需要的客户端服务：slot 注册表、字典、RPC 载体、设置表单（0.1.7 的 configForms）。 */
		const inject = ["slots", "locale", "connection", "configForms", "sessions"];

		/**
		 * 注册挂点：设置卡、composer 下拉、审批卡片状态条。
		 * @param {object} ctx - 客户端根上下文。
		 * @returns {void}
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "approve-for-me: dictionaries");

			// 绑定到本命名空间的翻译（页签 label 与近似行文案用；宿主 locale 服务没有 `bind` 时退回键名）。
			const translate =
				typeof ctx.locale?.bind === "function" ? ctx.locale.bind(NS) : (key) => key;

			// 用户文案语言档（design §7.5）：`auto`＝宿主界面语言（沿用 `translate`，现状行为）；
			// `zh`/`en`＝强制直查本命名空间字典——不经宿主 setLocale（那会写全局语言）。缺键抛错，不静默回退。
			/** @type {(lang: string, key: string) => string} */
			const localT = (lang, key) => {
				const dict = lang === "en" ? en : zh;
				const text = dict[key];
				if (typeof text !== "string") throw new Error(`approve-for-me: dict missing "${key}" in "${lang}"`);
				return text;
			};
			/** 控制器；未服务或读取异常时返回 undefined（此时按 auto 处理）。 */
			const controllerOf = () => {
				try {
					return ctx.configForms?.get?.(NS);
				} catch {
					return undefined;
				}
			};
			/** 当前语言档：每次读快照现取（热生效）；非法/缺失值回落 auto。 */
			const uiLangOf = () => {
				try {
					const ui = controllerOf()?.getSnapshot?.()?.value?.language?.ui;
					return ui === "zh" || ui === "en" ? ui : "auto";
				} catch {
					return "auto";
				}
			};
			const subscribeUi = (listener) => {
				try {
					return controllerOf()?.subscribe?.(listener) ?? (() => {});
				} catch {
					return () => {};
				}
			};
			/**
			 * 组件取词 hook：订阅控制器快照，切换语言档即重画；auto 用宿主绑定，强制档直查字典。
			 * 宿主 react 缺 `useSyncExternalStore`（旧版/测试替身）时退化为渲染期现取，行为仍正确、只少一次主动重画。
			 * @param {(key: string) => string} [hostT] - 槽位标准 prop 传入的宿主绑定。
			 * @returns {(key: string) => string} 取词函数。
			 */
			const useNsT = (hostT) => {
				const fallback = typeof hostT === "function" ? hostT : (key) => key;
				const lang = typeof react.useSyncExternalStore === "function"
					? react.useSyncExternalStore(subscribeUi, uiLangOf, () => "auto")
					: uiLangOf();
				return lang === "auto" ? fallback : (key) => localT(lang, key);
			};
			/** 非组件路径取词（记录表近似行等）：无订阅，按当前快照现取。 */
			const nsT = (key) => {
				const lang = uiLangOf();
				return lang === "auto" ? translate(key) : localT(lang, key);
			};

			/**
			 * 调一个插件 RPC 端点。
			 * @param {string} endpoint - `approveForMe/` 后的端点名。
			 * @param {object} args - 端点参数。
			 * @returns {Promise<object | undefined>} 应答；调用失败时抛错。
			 */
			const call = (endpoint, args) => ctx.connection.rpc.call(RPC_CHANNEL, endpoint, { args });

			/**
			 * 读当前会话 id。
			 *
			 * 以 slot 的标准 prop `sessionId` 为准（`dsh-client-ui-slots` 标准 props，如 `client-ui-cordis:741` 的会话面板）。
			 * `sessions` 服务在 0.1.7 只提供 `retain/using/retainInfo`（`dsh-api-session-controller/lib/client.js:3194-3234`），
			 * `list.getSnapshot().current` 取不到当前会话——取到空串时 composer 控件与审批卡片状态条静默不渲染。
			 * @param {unknown} [explicit] - 组件拿到的标准 prop `sessionId`。
			 * @returns {string} 会话 id；读不到时返回空串，组件因此不渲染。
			 */
			const sessionIdOf = (explicit) => {
				if (typeof explicit === "string" && explicit.length > 0) return explicit;
				try {
					const snapshot = ctx.sessions?.list?.getSnapshot?.();
					if (typeof snapshot?.current === "string" && snapshot.current.length > 0) return snapshot.current;
					if (typeof ctx.sessions?.current === "string" && ctx.sessions.current.length > 0) return ctx.sessions.current;
					return "";
				} catch {
					return "";
				}
			};

			/**
			 * 订阅会话列表变化。
			 * @param {() => void} listener - 回调。
			 * @returns {(() => void) | undefined} 取消订阅函数。
			 */
			const subscribeSessions = (listener) => {
				try {
					return ctx.sessions?.list?.subscribe?.(listener);
				} catch {
					return undefined;
				}
			};

			// 设置表单（requirements §6.1／design §7.2）：本包详情页 `plugins.bundle.config`（keyed，键＝包名），生命周期由 `whileServed` 管理——
			// 宿主没服务本命名空间（或行被停用）时不挂表单，避免读不到控制器的空卡；宿主恢复服务时自动重挂。
			// 数据源是 `configForms.get(行id)` 控制器（getSnapshot/subscribe/mutate 与 0.1.5 旧 scope 控制器同形）；组件自取控制器，
			// bundle 级槽的 owner props 只有 `view:'page'`（不注入 form），不注册 `plugins.row.config`（落点唯一）。
			ctx.effect(
				() =>
					ctx.configForms.whileServed([NS], () =>
						ctx.slots.inject("plugins.bundle.config", () =>
							ctx.slots.register(
								{
									name: "plugins.bundle.config",
									key: PACKAGE_NAME,
									locale: NS,
									inject: () => ({
										scope: ctx.configForms.get(NS),
										rpcCall: call,
										useNsT,
									}),
								},
								SettingsCard,
							),
						),
					),
				"approve-for-me: settings form",
			);

			// composer 的审查模型下拉；非接管预设、拿不到会话 id 或 RPC 不可用时组件自己不渲染（design §7.3）。
			ctx.slots.inject("conversation.input.left", () =>
				ctx.slots.register(
					{
						name: "conversation.input.left",
						id: NS,
						locale: NS,
						inject: () => ({ rpcCall: call, sessionIdOf, subscribeSessions, useNsT }),
					},
					ComposerModelSelect,
				),
			);

			// 审批卡片 body 的自动审批状态条与倒计时（design §7.4）。
			// 该 seat 是 `single`：`ApprovalCommand` 未写 priority（即 0），这里必须给负数才能成为 `entriesOfSlot[0]`；
			// 组件自己渲染关联命令，因此非接管请求的观感与原生一致。
			ctx.slots.inject("conversation.approval.detail", () =>
				ctx.slots.register(
					{
						name: "conversation.approval.detail",
						priority: -1,
						locale: NS,
						inject: () => ({ rpcCall: call, sessionIdOf, useNsT }),
					},
					ApprovalDetail,
				),
			);

			// 会话视图「审查记录」（design §8.5 呈现层第一落点）：与「对话」（order 0）、「轨迹」（order 10）并列的
			// 第三个页签，`list` 座位按 `priority` 再 `order` 升序排，20 恰好排在其后。
			// owner props 是 `{ viewRequest, openView, completeViewRequest }`；`useTrajectory` 等 hook 走标准 props。
			ctx.slots.inject("conversation.view", () =>
				ctx.slots.register(
					{
						name: "conversation.view",
						id: NS,
						order: 20,
						locale: NS,
						label: () => nsT("view.review"),
						inject: () => ({ rpcCall: call, sessionIdOf, subscribeSessions, useNsT }),
					},
					ReviewView,
				),
			);

			// 记录表近似行（可选，默认关；design §8.5）：内部自回退，任何失败只写 window.__dsafmProbe，不影响上面四个挂点。
			registerLegacyRow(ctx, call, sessionIdOf, (key) => {
				// 近似行按当前语言档现取；结局闭集探测未命中时回退原值（auto 档键名回显的同一语义）。
				try {
					return nsT(key);
				} catch {
					return key;
				}
			});

		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
