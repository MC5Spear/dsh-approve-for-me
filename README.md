# dsh-approve-for-me

[![CI](https://github.com/MC5Spear/dsh-approve-for-me/actions/workflows/ci.yml/badge.svg)](https://github.com/MC5Spear/dsh-approve-for-me/actions/workflows/ci.yml)

> 第三方社区插件，与 DeepSeek Harness 官方无关。个人维护，接受 issue，不接受外部 PR；不保证响应和修复时间。安全问题同样通过 issue 提交，请先脱敏。

为无人值守长任务和缺乏技术判断能力的用户提供沙箱升权审查。独立 LLM 审查器可以只读取证，安全则允许本次操作，危险则拒绝并说明原因；系统故障与危险判断分别说明。

**English summary.** This third-party DSH plugin reviews sandbox-escalation approval requests with an independent LLM and read-only local tools. Safe requests are allowed once; unsafe requests are denied. Review failures are fail-closed and distinguished from safety denials. The permission tier is supplied by the package declaration. Host settings may persist the tier in user overrides, so uninstall does not guarantee a clean user configuration. The target contract does not provide plugin-side YAML cleanup. The implementation has outstanding requirements and verification work; the current backlog is defined in the design document.

## 实现与验收边界

当前实现尚未满足或完成验证的事项，以[设计中的当前实施与验证待办](<docs/design.md#11-当前实施与验证待办>)为准。部署前尤其要核对独立审批、停用卸载时的用户配置写入、默认摘要完整性和无上限风险提醒；不能将目标要求当作已经交付的保证。

核对所用提交及验收结果后再部署，不能把目标描述当作已发布保证。

## 先了解风险与保护范围

- 只处理被接管的沙箱升权审批，不全面审查每次工具调用。“完全权限”下没有审批的操作不受保护。
- 允许只对本次操作有效，不能将此前对相同命令的允许当成后续授权。
- LLM 判断可能误判或受提示注入影响，不是绝对安全保证。操作参数、文件内容和工具结果不能自行建立用户授权。
- `denyPatterns` 默认 `[]`，即无文本规则拦截。显式配置后命中直接拒绝，不调用 LLM，人工也不能推翻；文本匹配存在绕过和误伤，不能替代语义审查。
- 默认审查失败、超时、输出不可解析或模型不可用时拒绝，不因审不了就允许。
- 默认不交人工备用；`fallback=ask` 可选。主会话默认审查期间显示人工卡片，可抢先作答；子代理无人工通道。
- 推荐先在非生产环境验证，按需要收窄接管工具、预设和升权上限。使用自定义拒绝规则前检查误伤范围。
- 宿主设置可能把插件预设持久化进用户配置。停用卸载有残留及默认预设失效风险，见下文，不承诺用户配置零残留。

## 兼容性

支持的宿主版本和依赖约束统一见[当前兼容基准](<docs/requirements.md#13-当前兼容基准>)，版本中携带宿主信息的格式和下一发布目标见[插件版本与发布标识](<docs/requirements.md#14-插件版本与发布标识>)。不要将某个目标版本推广为整个版本系列兼容，也不要靠 npm 标签推测依赖是否匹配。

宿主不兼容时可能跳过 bundle，并记录 `skipping profile bundle "dsh-approve-for-me"`。安装宿主依赖显式指定版本，不靠 npm 标签推测。宿主升级后重新验证应答者、模型目录、设置页面、卡片和记录视图；安装成功不等于完整可用。

## 安装

### 宿主通道

```powershell
dsh plugin --profile web add github:MC5Spear/dsh-approve-for-me
```

也可在宿主“插件”安装对话框填写同一包 spec。宿主负责依赖与启用列表；插件的包声明提供“自动审批”预设，不要求手工向 profile YAML 补预设，不使用安装或卸载生命周期脚本。

安装后重启宿主并重新加载页面，检查“自动审批”选项与插件设置表单。重启须从服务进程树外执行，不能把正在工作的任务一起终止。预设的相对顺序不是用户功能要求，三个标准权限的行为应保持不变。

宿主通道需要 pnpm；未安装时可先确认 `corepack pnpm --version`。固定包版本时使用实际已验证的完整 Git 标签，包括版本中的宿主信息；普通语义化版本范围不能凭构建元数据区分兼容宿主。需求中的下一发布目标不是已存在标签，不把未验收工作树当稳定发布。

### 本地克隆与链接

```powershell
git clone https://github.com/MC5Spear/dsh-approve-for-me.git
cd dsh-approve-for-me
npm install --omit=dev
dsh plugin --profile web add <克隆目录的绝对路径>
```

链接模式按真实路径解析依赖，克隆目录必须能自己解析依赖；schemastery 至少 `3.18.4` 才支持设置字段的 volatile 声明。包声明同样随装载组合，不需额外部署命令。

## 配置与使用

设置入口：“插件”面板 →“已安装”→ 本包 → 包详情页面直接显示表单。设置写入仅支持宿主本机回环入口；不可用时不影响审批，可由宿主管理 profile 配置。

配置命名空间为 `approve-for-me`。设置页及宿主 profile 配置作用于同一行；插件不读独立的 `settings.yaml` 分节。

默认值统一见[配置默认值](<docs/requirements.md#53-配置默认值>)；下表只说明设置用途，不维护第二份默认表。

| 设置 | 使用要点 |
| --- | --- |
| `enabled`、`mode`、`trigger.*` | 控制接管；空预设表不命中已知预设，未知预设仍按 `trigger.unknown`；子代理按根会话判断 |
| `trigger.auditEverySkip` | 开启后逐次记录跳过，不降噪 |
| `tools`、`allowEscalationTo` | 收窄工具和升权范围；空工具名单覆盖全部升权工具 |
| `denyPatterns`、`unknownSubject`、`fallback` | 拒绝规则、缺操作证据和人工备用处置；规则空清单不作文本拦截 |
| `reviewer.model`、`reviewer.parentModelRules` | 选择审查模型与推理强度；按执行助手模型命中的规则先于全局默认 |
| `reviewer.timeoutMs`、`human.timeoutMs`、`human.timeoutFrom` | 控制审查及人工等待；审查零取消时限，人工零立即拒绝，两者不同 |
| `reviewer.maxTokens`、`reviewer.temperature`、`reviewer.maxToolSteps`、`reviewer.toolTimeoutMs` | 控制模型响应和取证；工具轮次用尽要求直接回答；输出预算零不传上限，单工具零不设时限 |
| `context.*` | 控制上下文取样和脱敏；条数零不取上下文，本次真实参数仍独立送审；清单空表关闭遮蔽 |
| `concurrency.*`、`breaker.*` | 控制审查并发、排队及持续故障冷却 |
| `ui.inject`、`ui.injectMaxBytes`、`ui.humanCardDuringReview` | 通知范围、文本预算与审查期间人工卡片 |
| `ui.trace.*`、`audit.*` | 控制记录视图、保留范围和采集内容；敏感全文按需主动开启 |
| `language.ui`、`language.agent` | 界面文案与模型文案独立切换 |

合法类型和范围见[配置生效与校验](<docs/requirements.md#52-配置生效与校验>)及[时限](<docs/requirements.md#42-时限>)。非法草稿不能保存，非法加载值不能静默变成默认值。

### 模型选择与配置更新

会话选择 → 按执行助手的模型映射 → 全局默认；全局默认未设置时使用执行助手的当前模型独立审查（`reviewer.followParent` 已随本版退役，不再有独立开关）。不可用候选逐层降级并记录实际使用层，设置页与会话控件按位置分置醒目提示；全部不可用按故障拒绝。模型引用为 `provider/model`，推理强度与模型绑定，未指定时支持 low 则用 low，否则自动选择。

`reviewer.parentModelRules` 是结构化规则表，每条规则含作用范围与执行助手模型（完整纯模型 id，不切斜杠）：

- 作用范围＝任意 provider：任意 provider 下模型 id 相同即命中；
- 作用范围＝指定 provider：仅该 provider 下的该模型 id 命中。

同一作用范围与执行助手模型只能有一条规则，重复的行不能保存。旧 `reviewer.byParentModel` 字典继续参与匹配：纯模型 id 键按「任意 provider」读取；含斜杠的键在设置页请求确认原意，确认前按兼容规则读取、原值保留，不自动改写。

会话控件只在接管会话显示，权限变化后及时更新，不要求刷新。取得会话id后，在发第一条消息之前也能设置；切换失败显示可见错误并保留原值。

设置页面编辑先暂存，只有“保存”写入；单字段“恢复默认”也要保存才生效，离开丢弃未保存修改。覆盖按用户层是否有字段显示，不按值是否等于默认推测。毫秒字段显示生效值与随输入更新的草稿秒数，存储仍为毫秒。

设置可编辑字段保存后无需重启；其他配置按宿主更新或重载取得新值。取得新值后下一请求使用，已经审查或排队的请求保持自己的配置与取证目录。

**审查时限设为零**：你主动取消了等待上限，模型挂起或其他异常可能使请求无限停在自动审批；不会自动恢复默认时限。人工零表示立即拒绝，不要混淆。

### 可选拒绝规则

每行一条正则。默认空清单；显式命中直接拒绝，并说明参数位置与规则。内容可能位于命令包装或其他参数中，不能只检查命令预览。下面是参考示例，不是默认装填或完整安全保证：

```text
(^|[^A-Za-z0-9])(mkfs|diskpart|fdisk|parted)\b
(^|[^A-Za-z0-9])format\s+[a-z]:
```

说明文本出现这些词也可能误拒，应按自身需要配置，不靠文本规则判断全部真实意图。

## 审批结果与只读取证

- 安全允许：仅本次有效，按通知开关说明工具、操作与理由。
- 危险拒绝：解释原因，不能通过等价方式规避；可以采用更安全方案或风险告知后取得明确授权。
- 超时：说明发生在排队、审查或人工等待，没有得出安全结论；新的有效申请可以重新审查。
- 通道故障：说明系统故障而非危险判断，有限重试仍失败就停止连续请求并报告。冷却期间等待或报告，不立即反复重试。
- 取消或人工直接回答：不额外注入模型结论。

原生卡片保留命令和“拒绝／允许一次”，增加自动审批状态及对应阶段倒计时。无审查时限显示实际无时限语义；状态服务不可读时退回原卡片，不编造状态。

取证工具为read_file、list_dir、glob、grep，只读、不联网、不触发审批。读取／搜索有大小、候选和时间限制；凭据类路径、DSH会话、认证及审查记录受限。允许必要的工作区外本地取证，但不允许UNC或设备命名空间读取。名称限制不识别改名副本和硬链接；目录列表可能包含敏感文件名而不允许读内容。

## 审计与轨迹集成

stderr记录操作、接管原因、模型和决策、理由、风险授权、耗时、故障及缺失情况，一次审批可有多条可关联记录。日志裁剪或写失败必须承认不完整，不能将默认补全伪装成模型实际分析。

默认summary保留可复盘摘要，不要求保存提示词、推理文本或原始输出全文；full主动开启才采详情，全部先脱敏后裁剪。模型返回的推理不是判断正确的证明。摘要完整性的实施与验证状态见[当前实施与验证待办](<docs/design.md#11-当前实施与验证待办>)。

会话“审查记录”提供列表、详情及“工具总计 = 执行 + 审批”对照。列表行按审批实例合并审查与结算两类记录：主判定是最终结算（放行一次/拒绝/取消），审查判定与其不一致时并列显示；`审查未执行：`前缀标明未经过模型审查的拒绝。耗时按排队、审查、人工三段互斥分解，只累加实际在场的分段，缺失段显示“—”而非 0。读取失败或文件撕裂时页面明确提示“列表可能不完整”，不伪装成没有记录。插件不修改宿主原生轨迹的标签、位置或工具段跨度；旧版本记录行按原样独立展示，不能冒充原生审批记录。

记录在重启后按窗口回读，保留范围统一见[记录保留要求](<docs/requirements.md#73-自有视图耗时与保留范围>)。写失败可能仅留内存，重启会丢失；多实例共享同一记录目录不受支持。

## 卸载与已知风险

```powershell
dsh plugin --profile web remove dsh-approve-for-me
```

宿主移除依赖和启用项，重启后包声明不再参与组合，插件不再接管。**不承诺用户配置零残留**：

- 宿主设置可能把含“自动审批”的预设表写入用户profile配置，即使默认选择的是标准档也可能保留插件条目。
- 卸载后残留条目可能继续显示；默认选择失效还可能使权限服务加载失败并影响会话。
- 当前目标不由插件解析、改写或自动清理用户YAML，避免损坏用户自定义内容。不提供自动清理命令，也不宣称宿主已有完整恢复支持；等待宿主后续兼容处理并重新核验。
- 停用与卸载路径已按隔离配置副本验证：装卸全程不解析、不改写用户 YAML（副本逐字节不变）；插件不含配置清理模块，发布清单亦无对应条目。真实用户配置下的残留表现仍属上述已接受风险。

插件数据在 `$DSH_HOME/approve-for-me/`：会话模型选择及审查记录默认保留，不随卸载删除。它们是运行数据，不等同于部署副作用。

## 测试与排障

```powershell
npm test
npm run test:offline
npm run check
npm run probe:typert
npm run check:public-surface
```

宿主接线用例解析不到依赖时会跳过，跳过不是通过。宿主树由工具配置或 `DSAFM_HOST_MODULES` 指定；版本错误须检出。实际宿主的审批和界面验收不能由离线套件或旧DOM快照代替。

真实模型探针需要你自己的凭据，无凭据或断网只算未验证，不泄漏密钥。不要重启正在工作的实例；真实升权测试使用无害目标或隔离替身，不破坏用户数据。

## AI 维护者

参与本项目维护的 AI 维护者包括：

- `gpt-6.1-sol`
- `kimi k3`
- `glm-5.3`
- `deepseek-v4.1-flash`

## 文档与许可

| 内容 | 文档 |
| --- | --- |
| 产品行为、默认值、验收结果和增补需求 | [需求](<docs/requirements.md>) |
| 当前机制、验证方案与待实施事项 | [设计](<docs/design.md>) |
| 开发与公开内容边界 | [参与指南](<CONTRIBUTING.md>) |
| 发布历史 | [变更记录](<CHANGELOG.md>) |

需求与设计可以彼此引用，必要正文不依赖其他文档或外部资料补齐。公开交付不附带开发过程记录或本机运行产物。

MIT，见 [LICENSE](<LICENSE>)。部分英文Guardian模板、拒绝指令及策略源自 [OpenAI Codex](https://github.com/openai/codex)（Apache-2.0），归属与许可见 [NOTICE](<NOTICE>)。
