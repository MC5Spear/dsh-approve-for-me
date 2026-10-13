# dsh-approve-for-me 设计

> 产品行为、默认值和验收结果以[需求文档](<requirements.md>)为准。本文定义相应实现机制与验证方法，不能用实现现状降低需求。
> 两份文档允许互引，不依靠其他文档或外部资料补齐必要说明。源码与测试定位仅供核验。本文不记录迁移批次、修复过程或验收完成历史。
> 本文描述当前目标设计，不表示工作树已经符合全部要求。尚需实施和验证的工作集中列于第 11 章，不保留与需求相反的备用方案。

## 1. 总体架构与宿主接口

### 1.1 审批应答者与模块

插件在宿主 `approval/request` 的瀑布式应答流程中注册前置应答者，保留沙箱。工具请求更宽权限时进入审批；未接管的请求调用下一个应答者。调用链为：

```text
工具请求升权 → 宿主审批服务 → 插件接管判定与规则检查
                                ├─ 不接管 → 原宿主流程
                                ├─ 规则拒绝 → rejected
                                └─ 独立 LLM 审查 → 结算／可选人工
```

宿主请求携带 Agent、工具名、可选工具调用标识、理由及中止信号，不直接携带工具参数。工具调用标识关联工具事件；宿主审批事件的请求 id 关联申请与结果，两者不是同一个对象。

| 职责 | 模块 |
| --- | --- |
| 组装与注册 | `lib/index.js` |
| 配置与模型选择 | `lib/config.js`、`lib/model-resolver.js` |
| 主会话与子代理接管 | `lib/mode.js`、`lib/subagents.js` |
| 规则检查、动作回查与上下文 | `lib/policy.js`、`lib/transcript.js` |
| 只读工具、提示构建与模型循环 | `lib/readonly-tools.js`、`lib/prompt.js`、`lib/reviewer.js`、`lib/agent-texts.js` |
| 审批状态机、等待和调度 | `lib/gate.js`、`lib/scheduler.js`、`lib/pending-state.js` |
| 模型选择持久化与查询 | `lib/session-store.js`、`lib/session-model.js`、`lib/bridge.js` |
| 审计与记录存储 | `lib/audit.js`、`lib/trace-store.js` |
| 客户端与远程过程调用（RPC）声明 | `client.js`、`typert.host.js` |

不为单次审查建立执行 Agent 子会话。独立调用 `llm.stream`，工具只出现在审查请求的工具定义中，执行由本地只读封装完成，不进入宿主工具执行和审批流水线。

### 1.2 运行时契约

宿主行依赖 `approval`、`llm`、`sessions`。权限预设、配置和客户端状态服务按实际可用性读取，缺失时按需求降级，不假装已接管。

审批应答者返回 `allowed-once`、`rejected` 或 `cancelled`；只有 `allowed-once` 授权本次操作。宿主也定义 `unavailable` 用于没有可用应答或异常归一化。插件异常路径应自行拒绝，不依靠非法返回值结束。

`gate` 使用的职责接口：读取配置、判断接管、回查操作、规则检查、审查、计时、中止监听、撤回卡片、通知和审计。每个请求单独建立状态、计时器和结算结果；结算后清理。模型请求不传执行会话 `sessionId`，通知使用生产者消息源 `{kind:'plugin:approve-for-me'}`。

### 1.3 宿主契约核验

当前宿主基准和依赖版本只定义于需求 1.3。核验对象包括瀑布式审批应答、沙箱升权入口、工具派发事件、配置更新、模型目录、客户端槽位和宿主持久化校验。

升级宿主需重新验证这些契约，不把旧版本接口存在当成当前事实。客户端到达浏览器以注入表和页面文档对象模型（DOM）判断；后端 RPC 正常不能证明客户端已加载。插件不改宿主源码，也不借直接修改宿主服务绕过缺少的接口。

## 2. 请求识别、接管与子代理处理

### 2.1 插件侧判定与跳过

按需求第 2 章先判断接管，再解析审查模型。权限预设优先读取 `permissionPresets.current(session)`，服务不可用时折叠最近的 `permission/preset` 事件，仍未知则使用 `trigger.unknown`。已知预设用名单成员判断，空预设名单不匹配任何已知预设；未知分支不因空名单被改写。

`mode=off` 请求期直接跳过，不能只在装载期判断。工具过滤及非升权请求同样跳过；跳过不调用 LLM，不通知执行 Agent。`getState.active` 与审批路径共用接管判定，客户端只消费结论，不重新推断权限组合。

升权理由按 `escalate sandbox to <mode>: <justification>` 解析。未知目标比任何上限都宽，拒绝；已知目标按 `read-only`、`workspace-write`、`danger-full-access` 的宽度排序检查。

### 2.2 子代理覆盖

以会话头的 `parentSession` 识别委派，沿链找到根会话。只有根预设命中且子代理覆盖开启时追加 `approval/policy {policy:'ask'}`；不调用整预设设置，以免改写委派沙箱。

创建监听器在 `session/created` 中同步追加策略，在子代理首步执行前完成；事件只写宿主接受的 `policy` 字段，不增加自定义 `source`。装载补扫处理已经存在的会话。监听器内部捕获错误并审计，不让异常回滚宿主会话挂载。停止覆盖不追加撤销事件；子代理未获覆盖继续遵守宿主策略。发起者被识别为无人工通道，状态机不调用下一个人工应答者、不登记人工卡片状态。

## 3. 审查输入、只读工具、策略与输出解析

### 3.1 动作回查与独立参数

倒序查会话事件，支持两种来源：

- 直接工具调用：`tool/call` 的 `data.callId`，参数为 JSON 字符串。
- 代码派发：`tool/ptc-dispatch-start` 与 `tool/code-dispatch-start` 的 `data.subCallId`，参数为对象；两个事件名使用相同回查逻辑。

工作目录来自会话头。回查失败，或回查参数无命令类键（无法辨认实际操作）而按 `unknownSubject` 处置时，记录 `degraded=command`；目录缺失记录 `degraded=cwd`，上下文读取失败记录 `degraded=transcript`。`unknownSubject=reject` 不进入模型；`review` 携缺证标记审查。

模型请求分为系统提示、上下文证据消息、待审动作消息。动作 JSON 保留工具名、命令、目录、目标模式和理由；完整参数作为动作消息中的独立段，不依赖上下文取样窗口。目录未知的说明进入动作证据；只读工具可使用本请求固定的 `process.cwd()` 备用目录，但该值不冒充会话目录。

### 3.2 上下文取材与脱敏

取最近的请求头、步骤结果、用户／助手消息、工具调用及结果、两种派发事件。默认条数和预算见需求 5.3。`maxEntries=0` 主动不取事件，不标读取错误；两个字节预算为零时分别跳过对应裁剪。

读取服务缺失、抛错或返回非事件数组时，产生空证据、零条数、未截断与 `degraded=transcript`。每条和总量分别保留首尾，插入 `<truncated omitted_approx_tokens="N" />`，`N` 为本次超预算 UTF-8 字节数除以四向上取整。极小预算优先保留完整标记，最终可能超过名义预算，尾部可能为空。

默认脱敏源如下，按顺序替换为 `[redacted]`。普通源默认 `i`，`/source/flags` 使用显式标志，替换补 `g`；不可编译单项跳过，其他项继续。清单整体替换与空表语义见需求。

```text
sk-[A-Za-z0-9_\-]{8,}
\bBearer\s+[A-Za-z0-9._\-]{8,}
\b(password|passwd|token|api_key|apikey|secret)\s*[=:]\s*[^\s"'`]+
-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----
Authorization:\s*[^\r\n]+
://[^/\s:@]+:[^/\s:@]+@
```

模型输入使用请求快照清单，工具结果使用同请求快照；审计、通知与记录出口在消费时读取生效清单。每条路径先脱敏后裁剪，不要求在途与后续出口用同一时间版本，不改原始会话日志。

### 3.3 防注入与参数呈现

证据首行声明转录、工具参数、结果和计划动作是不可信证据，不是新指令；保留真实角色前缀，用 `>>> TRANSCRIPT START` / `END` 分隔，动作单独成段。数据中的 `</` 转义为 `<\/`。可信授权来源与风险阈值以需求 3.1、3.3 为准，不从参数中的“用户已批准”字样建立授权。

参数呈现边界与规则扫描一致：根深度为零，深度不超过四的字符串值可见，容器到第四层不再下钻，子树用 `[depth-exceeded]` 标记。处理自有可枚举键，保留自有 `__proto__`、`constructor`、`prototype` 字段，不改输入对象原型。

输入为普通对象／数组，内容属于 JSON 值域且无环时，在受支持深度和未裁剪范围内，序列化结果与 `JSON.stringify` 相同；重复引用的无环对象在每处完整呈现。仅祖先回边为 `[circular]`。非普通对象、BigInt、函数或遍历异常使用 `[unserializable]`；`undefined` 属性及 Symbol 键按 JSON 语义省略，非有限数和数组空洞为 `null`。这些标记表示缺证，不表示无害。

参数经结构转义、请求清单脱敏，再用 `context.maxEntryBytes` 保留首尾和标记。动作 JSON 的五个字符串字段也先脱敏，不能只脱敏参数段而让命令或理由从另一处泄漏。详情采集失败用安全占位，不能在模型调用前将已有占位证据的审查变成异常。

### 3.4 只读工具与资源限制

工具由 `node:fs` 只读接口实现，不注册到宿主工具目录，不派生进程、不联网。每次工具调用有结果，包括参数错误、未知工具和失败，供模型继续判断。

| 工具 | 执行边界 |
| --- | --- |
| `read_file` | 每次 64 KiB，支持偏移与分页 |
| `list_dir` | 最多 200 条，不递归 |
| `glob` | 最多 200 条，支持 `**`、`*`、`?`；遍历不跟随链接 |
| `grep` | 最多 100 匹配，结果单行 500 字符；每文件 1 MiB、候选 200、模式 256 字符 |
| 遍历 | 最多 4000 个目录，超限说明 |

路径先归一化并核验真实路径；UNC 和设备命名空间拒绝，不能因此发起网络读取。名称限制覆盖 `.credentials*`、`.env*`、`id_rsa*`、`id_ed25519*`、`*_history`、`.netrc`、`.git-credentials`、`.npmrc`、`settings.yaml/yml`、`.pem/.key/.pfx/.kdbx`、`.ssh`、`.aws/credentials`、`.docker/config.json`。

DSH 敏感范围按实际 home 根判断，环境变量优先、缺省 `~/.dsh`；环境根和仍存在的默认根均限制，覆盖会话、认证信息与插件记录，工作区普通同名目录不因名字被禁止。目录列表可出现凭据文件名，不读其内容；不识别改名副本和硬链接的限制如实显示。

`grep` 读取前检查大小，超过阈值跳过且继续其他候选，候选达到上限停止收集并说明。同步正则先检查已知病态模式；不能声称静态规则证明所有表达式都有严格时限。验证必须覆盖长输入的事件循环响应；保护不足时需可终止执行方案，不能只靠无法触发的计时器宣称超时有效。

请求进入调度前构造工具上下文：目录、语言、工具时限和脱敏清单值拷贝；通过请求绑定的工具接口随调用传入。共享工具实例只提供未传上下文时的缺省值，不决定生产请求的配置。

### 3.5 可选拒绝规则

实际默认值只引用需求 5.3，不把参考清单装填为默认。规则检查在 `screen` 内的次序固定：`mode=off`、`tools` 过滤、非升权三类跳过分支先判，未接管的请求不运行规则扫描；升权超过 `allowEscalationTo` 的确定性拒绝先于规则扫描；随后编译并全量扫描拒绝规则；`unknownSubject` 的处置最后判定。全部确定性判定先于模型调用，通过 `allowEscalationTo` 检查的接管请求（含 `unknownSubject` 两种取值），规则扫描都执行。

扫描全部受支持深度的自有字符串参数值（与 3.3 的参数呈现边界一致），键名用于定位但不作为字符串值扫描；命中说明键路径和模式，键路径为点分与下标组合（如 `env.PAYLOAD`、`args[0]`）。回查失败时无值可扫，按 `unknownSubject` 处置。回查参数无命令类键（即无法辨认实际操作）时，规则命中与 `unknownSubject` 的交叉语义如下：

| `unknownSubject` | 规则未命中 | 规则命中 |
| --- | --- | --- |
| `reject` | 直接拒绝，带 `command` 降级标记 | 规则直接拒绝，理由带命中键路径与规则 |
| `review` | 携缺证标记进入审查，带 `command` 降级标记 | 规则直接拒绝，理由带命中键路径与规则 |

规则命中的两格不置 `command` 降级标记，命中信息由拒绝理由的键路径承载。

以下八条为可显式配置的参考源，不是语义安全保证：

```text
(^|[^A-Za-z0-9])(mkfs|diskpart|fdisk|parted)\b
(^|[^A-Za-z0-9])format\s+[a-z]:
(^|[^A-Za-z0-9])dd\s+.*\bof=/dev/
(^|[^A-Za-z0-9])rm\s+(-[a-z]*\s+)*(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+(/|/etc|/usr|/var|/home|\$HOME|[a-z]:\\)(\s|$)
(^|[^A-Za-z0-9])Remove-Item\b(?=.*-Recurse)(?=.*-Force).*([a-z]:\\(Windows|Users|Program Files)|\bC:\s*$)
(^|[^A-Za-z0-9])(vssadmin\s+delete\s+shadows|bcdedit|cipher\s+/w|wbadmin\s+delete)\b
(^|[^A-Za-z0-9])reg\s+delete\s+HKLM
(^|[^A-Za-z0-9])(shutdown|Stop-Computer)\b
```

边界为非字母数字，识别引号、括号与路径包装；显式清单下 `grep mkfs readme.md` 也可拒绝，这是文本命中，不推测真实意图。普通模式默认不区分大小写，显式标志按配置处理，不可编译模式跳过且不声称有效。默认无此层拦截的操作仍由 LLM 审查。

### 3.6 循环与消息序列

调用 `llm.stream({provider, model, system, messages, tools, signal, ...})`，用 `BlockAssembler` 收集文本、工具调用、终止原因和用量。每轮满足：

1. 带工具调用的 assistant 消息先进入消息列表。
2. 每个工具调用恰有一条对应 id 的工具结果；参数解析失败同样返回错误。
3. 全部结果返回后才发下一轮，不能漏配或只推工具结果。

工具轮次用尽后追加直接给结论的指令，下一次不提供工具。`maxTokens=0` 不传输出上限，由模型／供应商默认值决定，不表示无限输出；推理模型可能先消耗输出上限，小上限导致无正文。工具轮次和总时限分别受需求约束。

### 3.7 输出与解析容错

原始契约引用需求 3.5，不另写第二套字段和必填规则。内部映射 `outcome→decision`、`risk_level→risk`、`user_authorization→auth`、`rationale→reason`；模型未提供或字段不合法而被补全时，记录字段级来源。缺理由用固定说明，不伪造模型解释。

先解析整段 JSON，失败可解析首个 `{` 至最后 `}` 的对象；无合法 `outcome` 仍是故障。宿主流末 `max-tokens` 为截断，哪怕文本可解析也不采信；`error:EMPTY_RESPONSE` 或空正文为无响应。`finish`、输出截断、日志截断和默认补全是不同观察项。

### 3.8 随包安全策略与系统提示

`lib/agent-texts.js` 提供两套模板与策略读取入口；英文策略为 `assets/tenant-policy.md`，中文为 `assets/tenant-policy.zh.md`。`lib/prompt.js` 按请求语言读取正文，替换模板中的 `{{ tenant_policy_config }}`，再追加需求3.5的输出契约。正常加载必须确认五类安全规则实际进入系统提示，不能只因模板构建成功就声称已应用策略。

所选文件缺失、读取抛错或为空时使用同语言占位键 `agent.tenantPolicyMissing`，不读取另一语言补位；占位说明和基础风险审查遵守需求3.3。每种语言的读取结果在模块实例内保存，包括读取失败；修复文件后重新加载模块才刷新。验证通过独立模块或读取替身构造缺失、空文件和失败，不删除真实随包策略；正常对照确认正文存在。

## 4. 审批状态机、人工竞速、取消与时限

### 4.1 状态机与五条路径的返回值

产品结果以需求 4.1 为准。实现先筛选，再对 LLM、人工、中止和计时结算进行竞速，所有结算使用同一个最终状态守卫。

```text
接管与筛选 → 直接拒绝／原样下传／进入审查
进入审查 → 模型允许 → 本次允许
         → 模型未允许 → 默认拒绝／主会话可选人工
         → 已显示卡片的人工先答 → 采用人工结果
         → 请求取消／人工通道关闭 → 取消
任一时限或内部异常 → 对应拒绝／取消语义并释放资源
```

`next()` 至多调用一次。`ui.humanCardDuringReview` 开启时调用它启动人工等待；关闭时只在确实交人工时调用。无人工子代理不调用它。规则直接拒绝也不交人工。内部异常不转入 `fallback='ask'` 的人工通道，统一拒绝并记录。逃逸出口（即 8.4 的应答者逃逸）自身不得再抛。逃逸出口上生效配置读取一律防抛；应答者入口与状态机各自的最外层捕获生效配置读取的抛错时，按未取得配置处理，回退需求 5.3 的默认值——`language.agent` 为 `en`，脱敏用随包默认清单（静态，不读生效配置），注入上限 2048，注入开关 `all`。通知按通道故障处理，不是安全判定。写结算记录与审计行时自身的配置读取同样防抛：`preset` 取不到时该字段明确缺失，记录存储按需求 5.3 的默认采集档、窗口与预算继续落盘，审计默认开启并按默认行预算与脱敏清单继续写。任何生效配置异常都按拒绝结算、返回宿主并留痕，不外抛。

### 4.2 撤回机制

原始工具 `signal` 只表达工具取消。插件在下传前建立独立卡片撤回控制器，合并到下游 `req.signal`；宿主审批服务已经捕获原始信号，审查和取消监听仍用原始信号，不监听自身撤回造成的中止。投影信号只在本次审批期间生效：收尾时把请求对象上的信号恢复为进入时的原始值，请求对象离场不携带投影副作用，再次到达按新请求处理（见 5.1）。

结算时只撤回实际显示过的卡片。没有下传请求不报告撤回成功；请求冻结或网关不可用时记录 `withdraw=unavailable`。人工抢先作答或取消中止模型流，迟到流只留观测记录，不再次结算或通知。

每请求清理计时器与中止监听，恢复请求对象的原始信号，清理卡片状态。恢复带同一性守卫：仅当请求上的信号仍是本次写入的投影信号才回写原始值，已被后续到达的审批或宿主改写时跳过，不覆盖新值；恢复动作自身失败只留观测记录，不中断其余清理。请求对象冻结时没有投影写入，也没有恢复动作。同一对象在上次到达未收尾时被并发再派发，新到达会把投影信号误作原始信号；这类形态不设额外机制：一次审批对同一请求对象只派发一次，重复到达都发生在收尾之后，没有已知宿主路径产生该形态，不为其增加跨请求登记。计时回调抛错按超时拒绝，中止回调抛错按取消；错误来源不能退化成无含义的 `undefined` 返回。

### 4.3 时限与人工等待

预算与零值引用需求 4.2。审查计时器在审查任务开始等待结论时建立，包含排队与内部尝试；到点先中止流再结算。人工起算为 `request` 时保存截止时间，交人工只用剩余时间；为 `handoff` 时在交人工阶段创建新计时器。零人工时限以立即拒绝处理，不登记无限等待的人工状态。

人工剩余时间耗尽且卡片尚未出现时，不创建闪退卡片。确实交人工且人工时限大于零时，卡片状态改写为 `waiting-human` 并携带原因类别与人工截止时间（渲染规则见 7.4）。人工时限为 0 时不登记人工阶段的卡片状态：交人工立即按拒绝结算，不出现无截止时间的人工待决状态。「审查期间显示人工审批卡片」（`ui.humanCardDuringReview`，需求 4.1 的独立用户开关）与人工时限 0 组合时，卡片随审查开始显示、按立即拒绝结算时撤回——该卡片来自用户的显式选择，不属于本条禁止的交人工闪退卡片（2026-10-12 用户裁定维持现状）。审查无上限不建立审查计时器，其他取消或人工路径按条件存在；设置控件旁直接显示无上限风险提醒，不自动修改用户选择。

### 4.4 注入范围与上下文影响

通知开关、语义与英文拒绝末句引用需求 4.3、5.3。使用与当前语言匹配的允许、拒绝、超时、通道故障模板；超时环节使用真实的排队／审查／人工时限。冷却故障指明稍后重试而非鼓励立即反复请求。逃逸通知同样使用通道故障模板（未得出安全结论、给出故障原因、允许重新申请，引用需求 4.3），逃逸原因写入通知的「原因：」段，与内部异常通知同构，不另维护逃逸专用文案。

通知先使用消费时点清单脱敏，再按 `injectMaxBytes` 保留头部及完整截断标记；零预算不裁剪，极小正预算可能被标记超过。注入失败记录降级，不改变最终审批。未取得配置时使用需求规定的默认故障通知，不假装已读取开关。

## 5. 调度、有限重试与持续故障控制

### 5.1 调度

每个接管的审批各自进入一个独立审查任务，执行前满足需求 3.1 的本次审批要求。调度器不在请求之间共享执行中的任务，也不复用已完成结果：同一 `(sessionId, callId)` 重复到达时各自排队、各自执行完整审查，前一次的允许、拒绝或审查故障不能使后一次跳过本次判断。重复到达含宿主复用同一请求对象的再派发：请求对象离场不携带上一次的投影信号（见 4.2），再次到达按新请求处理。全局并发、同会话串行及等待队列按需求 4.4、5.3 设置，超队列返回 `queue-overflow`，超等待返回 `queue-timeout`；释放执行位后唤醒能运行的等待者。

排队耗时 `queueMs` 在调度器内测量，口径是请求进入调度到取得执行许可的时长；直接取得执行许可时为真实值 0。调度器把测得的 `queueMs` 注入任务回调，随审查调用进入审查记录。未执行审查的失败结果也携带排队观测：排队超时携带实际等待时长；冷却中或队列已满时未进入等待，该字段缺失，随结算记录呈现（见 8.4）。

排队等待与冷却的零值语义：`concurrency.queueTimeoutMs=0` 表示不等待排队，需要排队即在零延时计时器到点后按 `queue-timeout` 结束；`breaker.cooldownMs=0` 表示冷却在下一次检查时立即结束并清空计数。这两个零值不表示无限等待，也不拒绝加载配置。

任务结算或取消后释放执行位和等待资源，不由迟到流阻塞后续请求。计时器和长期登记表有明确回收路径；每个结构容量与回收时点写在对应模块，不能随请求数无限增长。

验证口径：结果共享与复用类测试替换为「重复调用标识不跳过本次判断」的回归——相同命令、目标内容变化、授权或配置变化、重复 `(sessionId, callId)`、同一请求对象再派发等受控输入下，核对每次请求的实际送审证据与本次结果；正常独立请求仍受并发、排队、取消、时限和冷却约束。

### 5.2 有限重试

`REVIEW_MAX_ATTEMPTS=2` 对应需求允许的总尝试次数。用单一错误分类处理流抛错、供应商错误（包括可间歇恢复的 `INVALID_REQUEST` 与 `EMPTY_RESPONSE`）及空响应；截断、模型解析失败和装配错误不重试。

每次从相同系统和动作输入建立完整消息序列，信号中止后不开始下一次尝试。工具轮次观测跨尝试累计，尝试进度进入最终理由与审计；一次审批只形成一份审查记录，记录内包含尝试摘要，不生成多份审批结果。时限为零也只有限次尝试，但任一次模型挂起可无限等待。

### 5.3 冷却计数

按需求阈值计一次审查任务的终态，内部尝试不分别计数。调度没有执行审查不计；人工抢答、关闭、取消或人工时限等先结算造成的中止标记为被替代，不计。审查计时器中止仍计审查错误（引用需求 4.4），计时回调抛错与正常超时同权：审查环节的回调抛错对在飞审查流复用审查超时的中止标记，走同一条判定与计数路径；人工时限环节的回调抛错维持被替代标记，不计。计数不改变回调抛错的结算形状，`decide` 行与结算记录仍是拒绝、`source=error`，`reason` 前缀「计时回调抛错（<环节>）：」，`stage` 按实际环节。

冷却期间不调用模型，生成可辨认的通道故障结果；到期清空计数后恢复。记录中风险拒绝与系统错误仍分别显示，不能因为同样触发冷却就混成危险判定。

## 6. 模型选择、配置读取与请求快照

### 6.1 配置结构与更新

字段默认值、合法范围只引用需求第 5 章。设置命名空间为宿主行 id `approve-for-me`；Config 的宿主可热更新字段声明 `.volatile()`，宿主设置服务投影并更新其稳定引用。这是配置更新资格，不表示插件页面已为每个字段提供控件；页面字段集合由 7.2 定义。

宿主可热更新集合包括 `mode`、`tools`、`allowEscalationTo`、`denyPatterns`、`unknownSubject`、`fallback`、`trigger.*`（预设／未知预设处置／跳过日志／子代理）、`reviewer.*`、`human.*`、通知设置（`ui.inject`／`ui.injectMaxBytes`）、`ui.humanCardDuringReview`、trace 显示与采集档、`language.*`。enabled、调度、冷却、审计、上下文及记录体积等普通配置沿宿主生命周期更新，不假称均可不重载更新。

`normalizeConfig` 逐分节合并默认值，单独处理 `ui.trace` 两层结构并解包 volatile 引用，language 同样补齐。面向客户端序列化的配置结构不包含函数转换节点；一跳／两跳序列化后校验有效，不让回调丢失造成设置整片空白。温度是连续区间 `[0,2]` 的有限数，schema 层与读取路径双层拒绝非有限数。schema 层声明区间边界并附退化步长 `Number.MIN_VALUE`：区间比较对 `NaN` 恒为假，`±Infinity` 被区间边界拒绝；一切有限双精度数都是 2^-1074 的整数倍，对退化步长取模恰为 0；常规步长表达离散取值集合，退化步长不排除任何有限值、只拒非有限数；非有限数取模也为 `NaN`——即便区间比较放行，也会被整除校验拒绝。步长是纯数值元数据，随面向客户端的序列化往返保留，不触碰类型解析器；带回调的校验节点不进配置树；替换既有类型解析器是进程级全局改动；注册全新类型名的解析器不随序列化跨进程——三者均不作为温度的拦截机制。`normalizeConfig` 读取路径的有限性检查保留：volatile 写路径原地更新引用、不过 schema 校验，读取检查是程序化写入的最后一层。各入口的拒绝落点：装载配置与 `Config` 调用在 schema 校验即拒、错误可见；设置页的 JSON 通道表达不了非有限数，空值按默认值回退；程序化写入的非法值由读取检查拒绝，请求经异常路径按拒绝结算（见 4.1），不静默改成默认值。

每次取当前配置建立普通数据快照；目录、语言、工具时限及清单在进入调度前绑定。变更发生在任务排队期间，也不改该任务取证快照。出口清单消费时点语义引用需求 5.2。

### 6.2 模型选择对象化与解析顺序

配置选择兼容字符串和 `{model, effort}`；模型引用按第一个斜杠切 provider，保留模型 id 中其余斜杠。父模型映射使用纯模型 id，兼容读取全引用键；界面显示可附 provider，但不能意外破坏模型 id。

四层解析顺序与档位只引用需求 5.1。每层校验 provider 可用及模型信息可解析，失败记录层级原因后继续；全部失败为 unavailable。父模型从最近 `model/selection`，缺失则从请求头读取。

解析信息可使用有界查找表；键包含配置修订、会话选择和档位、父 provider/model。父模型、适配器目录、volatile 更新或会话写入使旧解析失效。这里保存的是模型路由信息，不是审批结论。使用执行 Agent 当前模型作为审查模型时仍独立发起审查调用（需求 5.1）；设置页与会话控件的说明文案按 7.2.2、7.3.1 定稿区分「使用相同模型」与「由执行 Agent 自己审批」。

### 6.3 会话级选择的文件载体

路径为 `$DSH_HOME/approve-for-me/session-models.json`，环境变量未设置则 `~/.dsh`。结构为 version 1、entries 按会话 id 存 `{model, effort, updatedAt}`；去掉单层 `session-` 前缀归一键。`model:null` 表示明确跟随全局，不等于读不到条目。

读取顺序是文件条目 → 没有条目时兼容读取会话中的既有模型选择事件 → 四层解析剩余候选。写路径只写文件，不新增自定义会话事件。JSON 结构非法按空表降级，非法条目不牵连合法项；输入输出失败给出可见状态。

同目录临时文件后 rename；成功立即刷新读取状态，失败保留原文件。最多 200 个条目，按更新时间回收最旧；一秒的读取刷新窗口仅优化文件读，不影响成功写入即时生效。

## 7. 客户端交互与状态更新

### 7.1 加载、挂点与接口

客户端为宿主模块加载器工厂，使用宿主提供的 React 和 UI primitives。依赖声明必须完整；缺服务时不能整片静默失效后仍报告安装完成。

| 挂点 | 标识与数据通道 |
| --- | --- |
| 包设置页 | `plugins.bundle.config`，键 `dsh-approve-for-me`；自行取得 `configForms.get('approve-for-me')` |
| 会话模型控件 | `conversation.input.left`；`getState`、`setSessionModel`、`modelCatalog`、`modelEfforts` |
| 原生审批详情 | `conversation.approval.detail`；保留命令并调用 `pendingState` |
| 审查记录 | `conversation.view`；`traceRecords`、`traceRecord` |

RPC 共八项，其中 `presetCatalog` 提供宿主预设目录；统一在 `typert.host.js` 声明参数、结果和成员，参数和结果结构与服务实现一致。新增或扩展结果字段时三处同步：结果 schema、类型声明和成员描述，缺任何一处，该字段就会在校验或投影环节丢失。状态含会话是否存在、实际模型及档位、选择来源、预设、接管和记录开关；没有活会话不等于会话设置不可写。

### 7.2 设置页 GUI

设置表单只在宿主将命名空间列为可服务且页面通过本机回环地址访问时显示；`configForms.whileServed` 管理生命周期。不可用不自行开第二通道；profile 配置仍由宿主管理，审批不受表单消失影响。

共 21 个产品字段：启用自动审批的权限预设、无法识别权限预设时、逐条记录预设不匹配的审批；默认审查模型与推理强度、按执行助手的模型选择审查模型、无可用审查模型时使用执行助手的模型；插件界面语言、发送给模型的文本语言、自动审查等待上限、审查输出上限、审查期间显示人工审批卡片、人工作答等待上限、人工作答等待起算点、模式、可自动批准的最高权限、无法识别本次操作时、自动审查未允许时、给执行助手的审批通知、通知长度上限（字节）、纳入自动审批的工具、文本拒绝规则。名称与说明文案按 7.2.2 定稿。表单暂存与「已单独设置」状态按需求 6.1，不直接即选即写。

按执行助手的模型选择审查模型的映射为执行助手模型／审查模型／推理强度／操作行表，支持添加与删除；模型目录不可读时保留可核对原值或手输，不丢已有选择。换模型后支持原推理强度则保留，否则清空。

数字字段使用官方 `SettingsValueField`；下拉、布尔、多行及模型控件采用共用字段外壳和草稿模型。字段标签、说明、「已单独设置」状态和说明入口结构一致：13px标签、12px说明、字段间细分隔、12px上下间距；普通控件34px高、8px圆角，使用宿主现行颜色令牌。保存按钮只有草稿合法且有改动时可用，写失败保留草稿。每个字段的常驻文字说明入口按 7.2.1 实现。

毫秒读数在数字组件说明之外单独绘制，避免非法输入替换帮助说明字段 `hint` 时连生效读数一起消失。秒数按需求格式换算，不写回配置。

审查时限字段的无上限风险提醒固定渲染在该字段的秒数读数行内，可见性不依赖帮助区展开，帮助区开合不改变其位置；草稿为 0 或生效值为 0 时显示提醒文本。中英字典成对新增提醒键，内容覆盖：审查模型挂起、工具或其他异常可能使请求无限停在自动审批；插件不自动恢复时限，取消与其他人工路径按各自条件生效。提醒只描述风险，不改写用户输入：草稿为 0 仍可保存。人工时限字段的 0 表示立即拒绝，不显示该提醒。

#### 7.2.1 常驻文字说明入口（requirements §6.5）

每个设置字段的标签旁提供常驻的「说明」文字按钮，搭配信息图标；不能只有小图标，默认状态即可辨认文字与按钮，不依赖悬停。按钮文字用字典键 `help.expand`（中文「说明」／英文 `Details`）与 `help.collapse`（中文「收起说明」／英文 `Hide details`）。

DOM 结构（字段外壳与数字字段的平铺说明行共用同一套元素与样式类）：

```text
<div class="dsafm_field">
  <div class="dsafm_f_head">
    <div class="dsafm_labelgroup">
      <label class="dsafm_f_label" for="<控件id>"><字段名></label>
      <button type="button" class="dsafm_helpbtn" aria-expanded aria-controls="<helpId>"
              aria-label="<字段名>：说明 或 <字段名>：收起说明">
        <IconInfoOutlineRegular size=12 /><span class="dsafm_helpbtn_text">说明／收起说明（二选一）</span>
      </button>
    </div>
    …「已单独设置」胶囊与「恢复默认」…
  </div>
  …控件…
  <p id="<hintId>" class="dsafm_f_hint"><常驻短句></p>
  <div id="<helpId>" class="dsafm_helpregion" role="region" aria-label="<字段名>：说明"><展开说明></div>
</div>
```

点击切换 `open`：展开时按钮文字变为「收起说明」并在本字段内渲染 `helpId` 详细说明；再次点击收起。开合只改字段外壳的本地 UI 状态，不触碰暂存表、保存计划与保存按钮可用性，也不改常驻短句、秒数读数与风险提醒的位置（requirements §6.5）。

`.dsafm_helpbtn` 定稿样式与取色：

```css
.dsafm_helpbtn{display:inline-flex;align-items:center;gap:4px;justify-content:center;
  flex:none;min-width:24px;min-height:24px;padding:0 8px;border:0;border-radius:6px;
  background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;
  font-family:inherit;font-size:12px;line-height:1.5}
.dsafm_helpbtn:hover,.dsafm_helpbtn[aria-expanded='true']{color:var(--dsw-alias-label-primary)}
.dsafm_helpbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
```

- 文字与图标同用 `--dsw-alias-label-secondary`，悬停与展开态转 `--dsw-alias-label-primary`；保持次要操作的强调程度，不用警告色、错误色和动画。两主题下文字对比度按 10.3 用计算样式核验，要求 ≥4.5:1；令牌实际取值不满足时升用 primary 并同步测试记录。
- 点击区域由 `min-width` 与 `min-height` 保证不小于 24×24 CSS 像素；文字加内边距后实际更宽。
- 焦点样式沿用两像素 `:focus-visible` 描边。开合由组件自身承载：`onClick` 处理鼠标点击；`onKeyDown` 捕获 Enter 与 Space，`preventDefault` 后执行同一开合动作——既提供键盘路径（装置层与测试替身不转译键事件），又防止浏览器对 Enter／Space 合成 click 造成双触发把开合翻回原状。

aria 语义：`aria-expanded` 表开合；`aria-controls` 关联展开区域 `helpId`；`aria-label` 写「〈字段名〉：说明」或「〈字段名〉：收起说明」，英文档为 "〈Field name〉: Details"／"〈Field name〉: Hide details"（半角冒号），由字段名与 `help.expand`／`help.collapse` 组合生成；无障碍名称（accessible name）包含可见文本并标明所属字段，不含帮助正文（Label-in-Name 成立）。展开区域 `role="region"` 带同名 `aria-label`。控件的 `aria-describedby` 仍关联常驻短句与展开中的说明区。

六类字段的一致入口：下拉、布尔、多行文本、多选预设、模型选择与映射表经字段外壳获得同一入口；数字字段的承载方式如下。宿主组件不提供文字入口不构成省略理由（requirements §6.5）。

数字字段（官方 `SettingsValueField`）的承载：官方组件只在传入 `help` 时渲染自己的纯图标帮助按钮（dsh 0.2.0-rc.2 宿主制品 `dsh-client-ui-primitives` 的 `SettingsValueField` 已核：按 `help !== undefined` 条件渲染，不传即无帮助入口），无法承载文字按钮。方案是不传 `help`，在官方字段之后平铺一行自绘说明行 `.dsafm_f_help`（与秒数读数行同一负边距 `-12px 0 12px`，视觉归属该字段），行内渲染与字段外壳同一套「说明」按钮、展开区与样式类。毫秒字段的平铺顺序为官方字段 → 秒数读数行 → 说明行；非毫秒数字字段无秒数读数行，说明行紧随官方字段，与毫秒字段同构。官方组件的标签、非法文案、覆盖组与恢复默认行为保持不变。

分隔线选择器需同步调整（现行 `.dsafm_f_sec + div:not(.dsafm_field)` 会给说明行误加分隔线，并因说明行隔断而丢失后继官方字段的分隔线）：

```css
.dsafm_f_sec + div:not(.dsafm_field):not(.dsafm_f_help){border-top:.5px solid var(--dsw-alias-border-l2)}
.dsafm_f_help + div:not(.dsafm_field){border-top:.5px solid var(--dsw-alias-border-l2)}
```

第一条在原规则上排除说明行（秒数行与说明行相邻时不加分隔线）；第二条以说明行为锚恢复后继字段的 0.5px 分隔线（覆盖毫秒与非毫秒两种顺序）。10.3 的实机巡检在目标基准宿主上复核「不传 `help` 即无帮助入口」——官方图标按钮与自绘文字按钮同时出现即判该承载方案失效，须重估。

#### 7.2.2 设置页文案定稿（requirements §6.4 名称表）

字典值如下；未列键保持现行文案。名称调整不改变配置键、枚举值、默认值、审批规则或保存行为；英文表达同一含义与条件，不逐字直译。「执行助手」指发起工具操作的 Agent（requirements §6.4），「执行助手模型」指该 Agent 所用的模型。

字段名称与选项文案：

| 字典键 | 中文 | 英文 |
| --- | --- | --- |
| `card.presets.label` | 启用自动审批的权限预设 | Presets that enable auto-approval |
| `option.trigger.unknown.skip` | 保持宿主原审批流程 | Keep the host approval flow |
| `option.trigger.unknown.review` | 继续自动审查 | Continue with automatic review |
| `field.trigger.auditEverySkip` | 逐条记录预设不匹配的审批 | Log every preset-mismatch skip |
| `field.trigger.unknown` | 无法识别权限预设时 | When the preset cannot be identified |
| `card.field.defaultModel` | 默认审查模型 | Default reviewer model |
| `card.field.byParentModel` | 按执行助手的模型选择审查模型 | Reviewer model by the agent's model |
| `card.map.col.parent`、`card.map.parent` | 执行助手模型 | Agent's model |
| `card.map.col.reviewer` | 审查模型 | Reviewer model |
| `card.map.col.effort` | 推理强度 | Effort |
| `card.map.placeholder.parent` | 执行助手模型 id | Agent model id |
| `card.field.followParent` | 无可用审查模型时使用执行助手的模型 | Use the agent's model when no reviewer is available |
| `field.language.ui` | 插件界面语言 | Plugin UI language |
| `field.language.agent` | 发送给模型的文本语言 | Language of model-facing texts |
| `field.reviewer.timeoutMs` | 自动审查等待上限（毫秒） | Auto-review wait limit (ms) |
| `field.reviewer.maxTokens` | 审查输出上限（token） | Review output cap (tokens) |
| `field.ui.humanCardDuringReview` | 审查期间显示人工审批卡片 | Human card during review |
| `field.human.timeoutMs` | 人工作答等待上限（毫秒） | Human-answer wait limit (ms) |
| `field.human.timeoutFrom` | 人工作答等待起算点 | Human timer starts |
| `field.allowEscalationTo` | 可自动批准的最高权限 | Highest auto-approvable permission |
| `field.unknownSubject` | 无法识别本次操作时 | When the action cannot be identified |
| `option.unknownSubject.reject` | 直接拒绝 | Reject |
| `option.unknownSubject.review` | 带缺失说明继续审查 | Keep reviewing with missing-action notes |
| `field.fallback` | 自动审查未允许时 | When the review does not approve |
| `option.fallback.ask` | 交给人工决定 | Ask the human |
| `field.ui.inject` | 给执行助手的审批通知 | Approval notices to the agent |
| `option.ui.inject.all` | 允许、拒绝、超时和故障 | Allow, deny, timeout and failures |
| `option.ui.inject.reject` | 仅拒绝、超时和故障 | Deny, timeout and failures only |
| `option.ui.inject.off` | 不发送 | Send none |
| `field.ui.injectMaxBytes` | 通知长度上限（字节） | Notice length cap (bytes) |
| `field.tools` | 纳入自动审批的工具 | Tools under auto-approval |
| `field.denyPatterns` | 文本拒绝规则（每行一条正则表达式） | Text deny rules (one regex per line) |
| `card.override` | 已单独设置 | Set individually |
| `effort.default` | 定稿值见 7.3.1（自动选择） | See 7.3.1 (Automatic) |

常驻短句（`hint.*`，始终显示，承载零值与空清单等关键含义，不藏进折叠说明）：

| 字典键 | 中文 | 英文 |
| --- | --- | --- |
| `hint.trigger.presets` | 会话使用清单内权限预设时，由本插件接管升权审批。 | Sessions on a listed permission preset hand escalations to this plugin. |
| `hint.trigger.unknown` | 读不到会话权限预设时的处置。 | What happens when the session preset cannot be read. |
| `hint.trigger.auditEverySkip` | 因预设不匹配跳过的审批是否逐条记录。 | Whether approvals skipped for a preset mismatch are each logged. |
| `hint.reviewer.model` | 全局默认的审查模型与推理强度。 | Global default reviewer model and effort. |
| `hint.reviewer.byParentModel` | 按执行助手模型选择审查模型的映射表。 | Map from the agent's model to a reviewer model. |
| `hint.reviewer.followParent` | 更高优先级的选择都不可用时，改用执行助手的模型独立审查。 | When no higher-priority choice works, review with the agent's model. |
| `hint.language.ui` | 插件界面文案的语言。 | Language of the plugin's UI copy. |
| `hint.language.agent` | 发给审查模型的文本与给执行助手的通知，两者使用的语言。 | Language shared by the texts sent to the reviewer and the notices sent to the agent. |
| `hint.reviewer.timeoutMs` | 自动审查的等待上限（毫秒）；0 取消时限，有常驻风险提醒。 | Auto-review wait limit (ms); 0 removes it, with a standing risk note. |
| `hint.reviewer.maxTokens` | 审查输出的 token 上限；0 不设上限。 | Review output cap in tokens; 0 sets none. |
| `hint.ui.humanCardDuringReview` | 审查期间是否提前显示人工审批卡片。 | Whether the human card appears early during review. |
| `hint.human.timeoutMs` | 人工作答的等待上限（毫秒）；0 立即拒绝。 | Human-answer wait limit (ms); 0 rejects immediately. |
| `hint.human.timeoutFrom` | 人工作答从何时开始计时：审批请求发出时，或交人工时。 | Where the human-answer timing starts: at the approval request, or at the handoff. |
| `hint.mode` | 总开关；关闭后插件完全不接管。 | Master switch; off means no take-over at all. |
| `hint.allowEscalationTo` | 插件可自动授予的最高权限档；更高的升权不会被自动批准。 | The highest permission tier auto-approval may grant; wider escalations are never auto-approved. |
| `hint.unknownSubject` | 无法辨认本次实际操作时的处置。 | What happens when the action cannot be identified. |
| `hint.fallback` | 自动审查未允许时的处置。 | What happens when the review does not approve. |
| `hint.ui.inject` | 发给执行助手的审批通知范围。 | Which approval notices reach the agent. |
| `hint.ui.injectMaxBytes` | 单条通知的字节上限；0 不裁剪。 | Byte cap per notice; 0 does not trim. |
| `hint.tools` | 纳入自动审批的工具，每行一个；空清单覆盖全部工具。 | Tools under auto-approval, one per line; empty covers all. |
| `hint.denyPatterns` | 每行一条正则表达式；命中即直接拒绝，模型与人工都不能推翻。 | One regex per line; a hit rejects outright, beyond model or human. |

展开说明（`help.*`，经「说明」按钮展开）：

| 字典键 | 中文 | 英文 |
| --- | --- | --- |
| `help.trigger.presets` | 会话使用清单内权限预设时，插件按接管规则处理升权审批；其他预设保持宿主原审批流程。清单为空时，任何已知预设都不接管；无法识别的预设按「无法识别权限预设时」的设置处置。选择接管范围不等于授予任意权限。 | Sessions on a listed preset hand escalation approvals to this plugin; other presets keep the host flow. An empty list takes over no known preset; unidentifiable presets follow "When the preset cannot be identified". Choosing the take-over range grants no extra permissions. |
| `help.trigger.unknown` | 读不到会话权限预设时的处置。保持宿主原审批流程＝不接管；继续自动审查＝视为命中接管范围。可能原因包括服务缺失、读取失败或没有可用预设信息。 | What to do when the session preset cannot be read: keep the host flow means no take-over; continue means treat it as covered. Causes include a missing service, a read failure, or no preset information. |
| `help.trigger.auditEverySkip` | 开启后，每次因预设不匹配而跳过的审批都逐条记录；关闭时同一会话同一原因只记录一条。只改变跳过记录的数量，不影响接管与审批本身，也不表示所有审批都被审查。 | On: every preset-mismatch skip is logged; off: one line per session and reason. This only changes the number of skip lines, never the take-over itself, and does not imply every approval is reviewed. |
| `help.reviewer.model` | 全局默认的审查模型与推理强度。模型引用形如 provider/model；推理强度留空表示自动选择：模型支持 `low` 就使用 `low`，否则不指定、由模型默认值决定，不承诺所有模型都支持或采用相同强度。解析顺序为会话选择 → 按执行助手的模型映射 → 全局默认 → 跟随执行助手模型。 | Global default reviewer model and effort. The reference reads provider/model; an empty effort is automatic: use `low` when the model supports it, otherwise let the model default decide — no promise that every model supports it or matches the same intensity. Resolution: session choice, by the agent's model, global default, then follow the agent's model. |
| `help.reviewer.byParentModel` | 按执行助手的模型选择审查模型：执行助手所用模型（纯模型 id）对应到审查模型与推理强度，比全局默认更具体，命中即生效；未命中按其余层级解析（顺序见上方「默认审查模型」）。 | Picks the reviewer by the model the acting agent uses: the agent's plain model id maps to a reviewer model and effort, overriding the global default; misses fall through to the remaining layers (see Default reviewer model). |
| `help.reviewer.followParent` | 仅在会话选择、按执行助手的模型映射、全局默认都不可用时生效：使用与执行助手相同的模型，独立发起一次审查调用——这是「使用相同模型」，不是由执行助手自己审批。关闭后，全部层级不可用时按审查故障拒绝。 | Applies only when the session choice, the agent-model map and the global default are all unusable: the reviewer then runs on the same model as the agent, as an independent call — the same model, never the agent approving itself. Off: total resolution failure is rejected as a review failure. |
| `help.reviewer.timeoutMs` | 自动审查的等待上限（毫秒），涵盖等待本次审查结论的全过程，内部重试不另计时。超时按拒绝处理并说明发生环节，不是危险判定。0 表示取消审查时限：审查模型挂起、工具或其他异常可能使请求无限停在自动审批，插件不自动恢复时限；取消与其他人工路径仍按各自条件生效（常驻风险提醒同此）。 | Auto-review wait limit (ms), covering the whole wait for this review's conclusion; internal retries get no fresh budget. A timeout rejects with its stage named — not a danger verdict. 0 removes the limit: a hung model or tooling failure can leave the request stuck in auto-approval forever; the plugin never restores the limit silently, while cancellation and other human paths still apply (same as the standing note). |
| `help.reviewer.maxTokens` | 审查输出上限（token）。0 表示不向模型传输出上限，由模型或供应商默认值决定。推理模型可能先把额度用于推理：上限过小可能导致没有有效结论（正文为空，按审查故障处理）；具体数值因模型与推理强度而异，不以个别模型的测量结果作通用保证。 | Review output cap (tokens). 0 sends no cap, leaving the model or provider default. Reasoning models may spend the budget on reasoning first: too small a cap can leave no usable conclusion (empty body, treated as a review failure); the threshold varies by model and effort, so no single measurement is a general promise. |
| `help.human.timeoutMs` | 人工作答等待上限（毫秒），仅在「自动审查未允许时＝交给人工决定」时使用。0 表示立即拒绝，不是无限等待。到点按拒绝结算，原因写明人工作答超时。 | Human-answer wait limit (ms), used only when the fallback is Ask. 0 rejects immediately, not an endless wait. Expiry settles as a rejection citing the human timeout. |
| `help.human.timeoutFrom` | 人工作答计时的起点：从审批请求起算＝交人工只使用剩余时间；从交人工起算＝交人工时重新开始计时。 | Where the human timer starts: from the approval request (the handoff only gets the remainder), or from the handoff itself. |
| `help.allowEscalationTo` | 可自动批准的最高权限，只限制可送审或允许的升权范围；范围内仍须通过规则检查与模型审查，不等于自动批准全部操作。完全访问（默认）＝最宽；工作区内修改＝超出工作区写入的升权不放行。 | The widest permission auto-approval may grant. It bounds what may be reviewed or allowed; everything in range still passes the rule checks and the review — it is not a blanket approval. Full access (default) is widest; workspace write rejects wider escalations. |
| `help.unknownSubject` | 无法辨认本次实际操作（如回查不到命令或参数）时的处置。直接拒绝＝不调用模型、立即拒绝；带缺失说明继续审查＝携带已取得的参数与上下文继续审查，缺失明确标记，不把缺失当作安全。 | When the actual action cannot be identified (say, no command or arguments could be recovered): reject refuses at once without the model; keep reviewing submits what was recovered with explicit missing-action marks — missing never counts as safe. |
| `help.fallback` | 自动审查未允许（拒绝、超时或故障）时的处置。直接拒绝＝按拒绝结算并通知执行助手；交给人工决定＝显示人工审批卡片等待你作答，人工作答等待上限到点按拒绝结算。子代理没有人工通道：未允许一律拒绝。 | What happens when the review does not approve (deny, timeout or failure): reject settles at once and notifies the agent; ask shows the human card until you answer or the human limit rejects. Subagents have no human channel — not allowed always means rejected. |
| `help.ui.humanCardDuringReview` | 开启时，自动审查进行中即显示人工审批卡片：你可以在审批未完成时抢先作答，人工结果优先；已完成的结果不能由迟到点击推翻。关闭时，仅在确实交给人工后显示卡片。 | On: the human card shows while the review runs — you may answer first and the human answer wins; a settled result cannot be overturned by a late click. Off: the card appears only once the request is truly handed over. |
| `help.ui.inject` | 发给执行助手（发起工具操作的 Agent）的审批通知范围：允许、拒绝、超时和故障＝四类都发送；仅拒绝、超时和故障＝允许不发送；选择「不发送」＝一条都不发送。审查记录视图的显示不受本开关影响。 | Which approval notices reach the acting agent: allow, deny, timeout and failures sends all four; deny, timeout and failures skips allow notices; send none sends no notices. The review-log view is unaffected by this switch. |
| `help.ui.injectMaxBytes` | 发给执行助手的单条通知的字节上限，超出截断并附截断标记；0 不裁剪。限制对象只是通知，审查记录按会话独立保留，与该上限无关。 | Byte cap for one notice to the agent; longer text is trimmed with a marker, 0 does not trim. Only notices are capped — review records are kept per session and ignore this limit. |
| `help.tools` | 纳入自动审批的工具名单，每行一个工具名。空清单覆盖所有工具的升权审批；填写后只处理名单内工具的升权请求，其余工具保持宿主原流程。 | Tools under auto-approval, one name per line. Empty covers every tool's escalations; once filled, only listed tools are handled and the rest keep the host flow. |
| `help.denyPatterns` | 文本拒绝规则，每行一条正则表达式（正则表达式是文本匹配规则，不是完整命令语义分析）。匹配对象是受支持深度内的全部字符串参数值，不只命令字段；包含危险词的说明文本也可能命中。普通正则默认忽略大小写；写成 /source/flags 形式时按所填标志匹配，未写标志时与普通正则一样忽略大小写。命中即直接拒绝：不调用模型、不交人工，模型和人工都不能推翻。空清单只关闭这层文本匹配，可自动批准的最高权限、无法识别操作等其他检查不受影响；不可编译的行跳过，不构成有效保护。 | Text deny rules, one regex per line (a regex is a text-matching rule, not command semantics). Every string argument within the supported depth is matched, not just the command; harmless prose containing a dangerous word can hit too. Plain patterns are case-insensitive by default; in /source/flags form the given flags apply, and with no flags given it stays case-insensitive like a plain pattern. A hit rejects outright — no model, no human, no override. An empty list disables only this text check; the escalation ceiling and unknown-action handling stay. Uncompilable lines are skipped and protect nothing. |
| `help.language.ui` | 插件界面文案的语言：跟随宿主界面（auto）或强制中文／英文。保存后下一次渲染生效，不改变发送给模型的文本语言。 | Language of the plugin's own UI copy: follow the host (auto) or force zh/en. Takes effect on the next render and never touches model-facing texts. |
| `help.language.agent` | 发给模型的全部文本的语言（系统提示、策略、工具说明、轮次指引）与给执行助手的通知语言。默认英文。判定与授权规则不随语言改变；与插件界面语言互不影响。 | Language of every model-facing text (system prompt, policy, tool descriptions, round instructions) and of the notices to the agent. Defaults to English. Rules and authorization never change with the language; the plugin UI language is independent. |
| `help.mode` | 总开关：规则检查＋LLM 审查＝正常接管；完全不接管＝等同未安装，宿主审批流程不受影响。 | Master switch: rule check plus LLM review takes over as configured; off behaves as if uninstalled, leaving host approvals untouched. |

预设多选的提示文案（`card.presets.*`）：

| 字典键 | 中文 | 英文 |
| --- | --- | --- |
| `card.presets.none` | 清单为空时，已知预设都不会接管审批；无法识别的预设按「无法识别权限预设时」的设置处置。 | With an empty list no known preset is taken over; presets that cannot be identified follow "When the preset cannot be identified". |
| `card.presets.missing.remedy` | 该预设不在宿主当前预设表中。可依次检查：插件是否已停用、宿主版本是否兼容、预设是否为自定义。重新启用插件或重启宿主可能恢复，不保证一定恢复；插件已卸载且配置仍选择该预设时，可改选标准权限档。插件不解析、不改写用户 YAML，不建议手工清理。 | The preset is absent from the host's current table. Check in turn: a disabled plugin, an incompatible host version, or a custom preset. Re-enabling or restarting may restore it, with no guarantee; if the plugin is uninstalled while the config still selects it, pick a standard tier. The plugin never parses or rewrites user YAML, and manual cleanup is not recommended. |
| `card.presets.unavailable` | 读不到预设目录。可能原因：服务缺失、读取失败或没有可用预设信息；可确认权限预设服务可用后重试。 | The preset catalog is unavailable. Possible causes: a missing service, a read failure, or no preset information; check the permission preset service and retry. |

依据：字段名与选项名取自 requirements §6.4 名称表各行；覆盖胶囊的名称与预设缺失指引按 requirements §6.1；空清单语义按 requirements §2.1；`denyPatterns` 说明与 requirements §3.4 及 `lib/policy.js` 现行编译口径一致（普通源串默认加 `i`；`/source/flags` 按所填标志，未填标志同普通源串回退 `i`，`lib/policy.js:105`）；`followParent` 说明按 requirements §5.1 区分「使用相同模型」与「由执行 Agent 自己审批」；时限零值按 requirements §4.2；通知范围与记录的区分按 requirements §6.4 `ui.inject` 行。`help.reviewer.maxTokens` 不含具体测量数字，只作定性表述。机制叙述中的「执行 Agent」与「父模型」即界面文案的「执行助手」与「执行助手模型」，机制叙述中的「档位」（模型的 `effort` 取值）即界面的「推理强度」（requirements §6.4 定名，未指定显示「自动选择」），同一概念，用户可见名称以本表为准。

### 7.3 会话级下拉与更新

菜单包含跟随全局、模型和推理强度，触发器显示实际模型与推理强度；没有会话 id 或 RPC 不可用时优雅降级。权限变化使用宿主 `permissions` 投影作刷新信号，重取 `getState`；保留十秒备用刷新，需求不规定该间隔。

显隐只看宿主 `active`；会话未激活时仍可按会话 id 写入并在激活后使用。错误徽标直接可见，不仅依赖鼠标悬停。模型及预设原始数据不翻译，需要核对的 id 附于文案。

#### 7.3.1 会话控件文案（requirements §6.4）

| 字典键 | 中文 | 英文 |
| --- | --- | --- |
| `composer.label` | 审查模型 | Reviewer model |
| `composer.section.effort` | 推理强度 | Effort |
| `composer.title` | 本会话的审查模型；独立于执行助手调用，点开可只给这个会话指定 | This session's reviewer model — called independently of the agent; pick one to override it for this session only |
| `effort.default` | 自动选择 | Automatic |
| `composer.followGlobal` | 跟随全局（清除本会话选择） | Follow global (clear this session) |

推理强度未指定时显示「自动选择」，含义按 requirements §6.4 的 effort 行，与 7.2.2 `help.reviewer.model` 的说明一致（模型支持 `low` 就使用 `low`，否则不指定、由模型默认值决定），不在此重复全文。触发器提示语说明审查调用独立于执行助手（requirements §5.1 的区分），模型引用与推理强度的枚举值保持原样。

### 7.4 审批卡片内的自动审批状态条与倒计时

`pendingState` 返回本插件正在处理的条目、状态、原因、原因类别、起点、截止时间与时限归属。状态枚举为 `reviewing`（审查中）与 `waiting-human`（已交人工、等待你决定）两个值，写错状态值按 `reviewing` 归一化。交人工的条目携带原因类别 `cause`，取值 `deny`（模型判定拒绝）、`timeout`（审查超时）、`error`（模型异常、队列已满、冷却中未执行等未取得有效结论的通道故障）；`cause` 写错或缺失按 `error` 归一化，原因子句走「未取得有效结论」。`pending-state` 的归一化透传 `cause` 字段，条目并带人工截止时间与 `deadlineKind: 'human'`。该枚举是插件内部 UI 状态通道的枚举，不是配置枚举；「不改枚举值」只约束配置枚举，此通道取 `reviewing`／`waiting-human` 两值满足 requirements §6.3 的状态区分要求，不触碰配置键与审批规则。`cause` 是 `pendingState` 的结果字段，按 7.1 三处同步落进 `typert.host.js`：`pendingState` 结果 schema、`PendingState` 类型声明与成员描述各补一处，缺任何一处该字段就会在校验或投影环节丢失。

状态行文案字典键：

| 字典键 | 中文 | 英文 |
| --- | --- | --- |
| `cardstate.reviewing` | 正在自动审批 | Auto-reviewing |
| `cardstate.waiting` | 等待你决定 | Waiting for your decision |
| `cardstate.waiting.deny` | 自动审查结论为拒绝：{reason} | The review concluded deny: {reason} |
| `cardstate.waiting.timeout` | 自动审查超时，未取得有效结论 | The review timed out without a conclusion |
| `cardstate.waiting.error` | 自动审查未取得有效结论：{reason} | The review failed without a conclusion: {reason} |

渲染规则：审查中显示「正在自动审批 · 审查时限剩余 N 秒」，审查时限为零（无上限）时显示「审查无时限」，不渲染自动拒绝倒计时。进入人工阶段显示「等待你决定 · 〈按 cause 选择的原因子句〉 · 剩余 N 分 N 秒后自动拒绝」。倒计时一律按 `deadlineKind` 分派取值：`reviewing` 状态读审查截止时间（`deadlineKind: 'review'`），`waiting-human` 状态读人工截止时间（`deadlineKind: 'human'`），归一化错误不得使两类时限互串——`deadlineKind` 与状态矛盾的组合同样按状态锚定；`deadlineKind` 缺失（如审查无上限时空截止写入）时按状态回退推断取值（`reviewing`→审查时限语义），缺失不得导致不渲染或互串。原因子句明确归属自动审查，不冠「最终」字样，人工未作答前不把自动审查未允许呈现为最终审批已拒绝（requirements §6.3）。`cause=error` 的文案只说未取得有效结论并给出故障原因：模型异常、队列已满、冷却中未执行都经此呈现，任何状态下不得显示为「模型已判定危险」。`cause=deny` 且理由为空时，原因子句省略冒号与理由，只显示「自动审查结论为拒绝」。

时限与零值：人工时限为零时不登记人工阶段状态（交人工立即按拒绝结算），不会出现无截止时间的等待状态，也不显示「将一直等待」类文案；人工等待的倒计时一律来自人工截止时间。结算后状态表清除该条目，客户端轮询不到即整条状态行移除，只保留关联命令与原按钮，不残留陈旧状态。

卡片挂载后每秒重取状态，本地每250ms刷新倒数，只更新文字。状态为空或服务失败不伪造审查状态，保留原关联命令和原按钮；状态通道不可用时退回宿主原卡片。

### 7.5 字典与语言

插件界面语言（`language.ui`）取宿主 locale 或强制中文／英文；发送给模型的文本语言（`language.agent`）按请求快照选择。字典键集完全一致，未知语言或缺键是可观测缺陷，不静默回退成另一语言。字段名、工具名、输出契约、不可信声明和缺证标记保持一致；审计固定格式不随开关改写。

字典键集见 7.2.1、7.2.2、7.3.1、7.4、8.5.1 各表。中英键集逐对相等；英文与中文表达同一含义与同一生效条件，枚举附原始 id 的既有形式保持。文案不改配置键、枚举值、默认值、审批规则或保存行为（requirements §6.4 末行）。

## 8. 审计、记录存储、脱敏与容量

### 8.1 单行格式与关联

stderr 的一行是一条日志记录，不是一次审批的全部内容。阶段包括 `screen`、`review`、`tool`、`handoff`、`decide`、`error`；全文开关额外启用 `prompt`、`raw`。请求身份在阶段间关联，直接规则拒绝可以在 `screen` 终结；异常可在 `error` 终结，不能只靠是否有 `decide` 字段判断完整性。

既有格式字段包括 `id/callId/tool/cwd/mode/action/source/decision/path`，实际模型、档位、层级、风险、授权、时长、尝试及降级信息，通知和撤回状态，`finish/fieldsDefaulted/late/truncated/reason`。格式版本由一处常量同时提供启动行和阶段行。

按需求 7.1 扩充摘要身份、操作证据、配置与策略标识及字段来源，字段含义与 8.2 的摘要字段词汇表一致；模型结果与最终审批结果分别记录，不能把人工拒绝或审查超时仅呈现为模型allow。文本转义引号、反斜杠和换行，一条日志不能因理由内容变多行。

日志reason先脱敏再按200字符裁剪；整行默认预算引用需求。超预算先去reason，再压缩身份、阶段和截断信息，仍超预算时截取。预算零写空行，极小合法预算可能连身份或标记都不能保全；此时不声称日志完整，默认摘要所需信息须在结构化记录中可查。

日志跳过降噪按会话和原因登记，逐次开关绕过降噪；登记表有界。审计写失败不改变审批。启动行给生效模式、接管预设名、模型、档位、时限与注册状态，不写凭据。

### 8.2 摘要与可选全文

需求 7.1 定义基础摘要，不将提示词、模型返回推理和原始输出全文作为必需证据。默认摘要（`summary` 档）保留可复盘的理由、风险授权、操作与取证摘要、缺失说明，以及配置和策略标识，不依赖 `full` 全文解释一次决定。

摘要字段词汇表统一定义记录字段，生产、存储、投影与呈现四个环节消费同一份定义。文中「审查记录」专指 `kind='review'` 的存储行，界面视图名沿用「审查记录」但显示合并记录；泛指审查与结算两类记录时写「审查与结算记录」。

| 字段 | 含义 |
| --- | --- |
| `kind` | 存储行类别：`review` 审查记录，`settle` 结算记录 |
| `reviewId` | 存储行主键，由会话、callId、`kind` 与审批实例 id 组成（见 8.3） |
| `approvalId` | 审批实例 id，同一审批两类记录的共同关联键，也是客户端列表行的合并键（见 8.3） |
| `callId` / `toolName` | 工具调用标识与工具名 |
| `origin` | 审批发起方归属：`main` 主会话，`subagent` 被覆盖的委派子代理 |
| `escalation` | 本次请求的升权目标权限档（如 `workspace-write`、`danger-full-access`），未知目标照实记录 |
| `preset` | 本次触发接管命中的权限预设名；子代理按根会话的命中名，规则直拒路径同源可得 |
| `startedAt` / `endedAt` | 本类记录的起止时刻 |
| `queueMs` / `reviewMs` / `humanWaitMs` | 分段耗时，互斥分解一次审批等待（见 8.5） |
| `decision` | 审查判定：`allow`、`deny`、`error`；只描述模型侧结论 |
| `outcome` / `source` / `stage` | 最终结算、来源与环节（见 8.4） |
| `model` / `effort` / `layer` | 实际模型、推理强度与模型解析层级（`session`、`parent-map`、`global`、`follow-parent`、`unavailable`） |
| `tokens` | 推理思维链 token 用量，与审计行 `reasoningTokens` 同源；供应商未返回时缺失 |
| `attempts` | 实际执行的模型尝试次数；未进入模型调用为 0，内部重试递增。一次审查任务只计一次的口径见 5.3 |
| `reason` | 判定理由或结算原因，先脱敏，再按 `context.maxEntryBytes` 保留首尾并置截断标记 |
| `risk` / `auth` | 风险与授权分级；审查未产出时缺失 |
| `fieldsDefaulted` | 被解析补全的字段名清单，逗号分隔，取值为 `risk`、`auth`、`reason` 的子集；模型原始字段齐全时为空 |
| `subject` | 脱敏后的操作摘要：优先命令原文，回退描述或参数摘要；先脱敏再按 `context.maxEntryBytes` 裁剪，超限置截断标记 |
| `evidence` | 脱敏后的上下文证据摘要，先脱敏再按 `context.maxEntryBytes` 裁剪，超限置截断标记；未取上下文时缺失 |
| `probes` | 只读取证工具及结果的逐条摘要（工具名与结果状态一行一条），先脱敏再按 `context.maxEntryBytes` 裁剪；未调用取证工具时缺失 |
| `tools` | 只读取证的工具调用次数 |
| `degraded` | 审查侧缺失与降级标记，取值为固定清单：回查失败或回查参数无命令类键且按 `unknownSubject` 处置 `command`、目录缺失 `cwd`、上下文读取失败或总量预算截断 `transcript`（现行实现两种情形同用该标记）、单条证据截断 `entry:<事件类型>`、模型解析全层不可用 `all`、输出截断 `output-truncated`、空输出 `output-empty`、已被其他路径先结算 `superseded`、队列已满 `queue-overflow`、排队超时 `queue-timeout`、冷却未执行 `breaker-open`、注入失败 `inject-fail`；多项以逗号连接，与 `inject-fail` 组合用 `+` 连接；无标记为 `none`。新增标记须同步本词汇表 |
| `configTag` | 生效配置标识，形状见下 |
| `policyTag` | 策略标识，形状见下 |
| `truncated` | 记录内任一字段被裁剪即置真 |

`configTag` 的形状：对影响审查行为的配置子集做键序稳定的规范化序列化，取 SHA-256 哈希的前 12 位十六进制。子集固定为：`mode` 与 `tools`、`allowEscalationTo`、`denyPatterns`、`unknownSubject`、`fallback`、`trigger.*`、`reviewer.*`（模型与预算及时限）、`human.*`（人工时限与起算）、上下文预算与脱敏清单、并发与冷却、`language.agent`。配置变化使子集变化，标识随之变化；子集随请求快照绑定，排队中的配置更新不改动已进入审查的请求标识。

`policyTag` 的形状：`<语言>:<摘要>`，语言为 `zh` 或 `en`，摘要为随包策略文件内容的 SHA-256 前 12 位十六进制，取本次审查实际加载的策略读取结果计算，不用磁盘当前状态。策略缺失、读取失败或为空时摘要为 `missing`，对应「仅按基础风险分级执行」的降级状态；文件修复并重新加载后标识随之更新。

生产到呈现的数据链贯通一次：审查器在审查收束回调产出全部 `review` 字段；存储层的产品字段白名单即本词汇表，未列产品字段不落盘。存储行另含存储内部字段（行主键 `reviewId`、会话键、落盘时刻），不进产品投影。`reviewKeySource` 随新键设计退役：新记录不再写，旧格式行保留原样，新投影不透出。RPC 声明按 7.1 的三处同步规则扩充，客户端呈现按同一词汇表扩充。列表行是合并行，携带 `approvalId`、`callId`、`toolName`、`origin`、`escalation`、`startedAt`、`endedAt`、三个分段耗时、`decision`、`outcome`、`source`、`model`、`effort`、`risk`、`auth`、`reason`、`subject`、`truncated`；行的组成由 `decision` 与 `outcome` 的在场表达——有 `decision` 即有审查记录，有 `outcome` 即有结算记录。合并行的 `startedAt` 取审查记录起点，无审查记录时取结算记录起点；`endedAt` 取结算记录终点，结算记录缺失时取审查记录终点。详情按 `approvalId` 返回该审批两类记录的合并详情，在列表之外补充 `stage`、`layer`、`attempts`、`preset`、`tools`、`fieldsDefaulted`、`degraded`、`evidence`、`probes`、`configTag`、`policyTag`、`tokens` 与全文段。`decision` 词表保持审查判定，最终结算由 `outcome` 承载，两者不混用。

全文主动开启后才保存 prompt、input、reasoning、output；提示和输入先使用请求快照脱敏，落盘消费时点再脱敏并裁剪。`ui.trace.maxBytes=0` 使用需求 5.3 的默认单字段预算，不表示不裁剪或只保留零字节。只保存供应商实际返回的推理，不补造。采集故障不影响审查调用或结算。

列表RPC只回摘要，详情按单条读取。采集改少不删除已有记录。

### 8.3 自有存储与保留

路径为 `$DSH_HOME/approve-for-me/reviews/<sessionId>.jsonl`，JSONL是持久化来源，内存是最近窗口。审批实例 id（`approvalId`，插件内每审批唯一的标识，不是宿主审批事件的请求 id）在审批应答者入口即生成，先于接管判定与配置读取：不接管的请求不落记录；任何产生记录或结算的路径（含应答者逃逸）都持有该合并键。存储行主键 `reviewId` 由会话 id、callId、`kind` 与审批实例 id 组成；`kind` 与审批实例 id 都进入主键，审查记录与结算记录不会互撞，同一 `reviewId` 不重复落盘（同一审批同类记录只一条）。同一审批的两类记录经 `approvalId` 关联。

旧格式行兼容按字段缺失判定：既有存储行没有 `kind` 与 `approvalId` 字段即为旧格式，不按 `reviewId` 的段数或第三段含义识别——既有旧记录的第三段可能是审批事件序号，也可能是开始时刻。旧格式行在读取路径合成 `approvalId`：取该行自身 `reviewId` 全文，仅读取时使用、不落盘。合成后独立成行，`outcome`、`source` 等新字段按缺失呈现，不与其他行合并，也不写回磁盘。

每会话串行追加，默认窗口、会话文件上限及轮转行为引用需求 5.3、7.3。`ui.trace.maxRecords=0` 使用需求 5.3 的默认窗口，不表示不保存记录或无限窗口。达到轮转条件时重写只保留最近窗口；超过会话文件上限时按修改时间、同时间按名字淘汰，新触发文件不进入删除候选。内存窗口、行计数、读取标记和写队列随文件淘汰回收。

读取失败在会话级暴露降级状态：存储层为发生读取失败或末行撕裂的会话维护读失败标记，列表结果携带该标记（`readFailed`），不把失败静默折叠成空列表；文件缺失是合法空，不标记。末行撕裂跳过，后续写入前补分隔，坏行不变成伪造审批。写入失败记录暂留内存但标未持久化，重启会丢失。一个目录只支持一个进程写者，轮转不能依赖跨进程单行原子性。

长期容量量级：审计计时登记最多2000，模式及覆盖观察登记最多1000，会话模型条目200；结算及时清理是主路径，容量淘汰是异常路径限制。不是对审批数量或授权的限制。

### 8.4 结算记录

每次审批恰有一条最终结算记录（`kind='settle'`），由状态机在每个结算点写出；最终状态守卫保证只写一次。字段取值：

| 字段 | 取值 |
| --- | --- |
| `outcome` | `allowed-once`、`rejected`、`cancelled`，与应答者返回值一致 |
| `source` | `rule` 规则命中、升权超过上限或 `unknownSubject=reject` 的确定性拒绝；`llm` 模型判定直接结算（含审查故障按默认拒绝），队列已满或冷却中未执行审查的通道故障结算同归此来源；`human` 人工抢答或人工阶段作答；`timeout` 审查、排队或人工时限到点；`gateway` 人工通道关闭；`signal` 原始请求取消；`error` 计时或中止回调抛错、内部异常、应答者逃逸 |
| `stage` | 超时或故障结算能辨认环节时携带：`queue`、`review`、`human`。队列已满与冷却未执行发生在调度环节，取 `queue`；无法辨认环节的（如中止回调抛错）省略；其余来源不带（前句已列者除外） |
| `reason` | 结算原因，先脱敏再按 `context.maxEntryBytes` 裁剪；规则直拒带命中键路径与规则 |

应答者逃逸指审批应答函数主流程抛出、被入口最外层捕获并按拒绝结算的异常。结算记录与审查记录经 `approvalId` 关联，落同一会话文件。结算记录按 8.2 词汇表携带可取得字段：身份与背景字段（会话、callId、toolName、origin、escalation、preset）、起止时间与在场的排队观测（`queueMs`）可取得时必带；模型侧字段（model、effort、layer、risk、auth 等）未执行审查时缺失。规则直拒、排队未执行、冷却未执行与应答者逃逸路径没有审查记录，合并列表行只取自结算记录，上述字段保其可查。全部未执行审查的调度失败（队列已满、排队超时、冷却未执行）的结算 `reason` 以固定前缀「审查未执行：」开头、后接具体原因；前缀措辞固定，不随语言或环境变化。调度失败的辨认以 `source` 为准：排队超时为 `timeout` 且 `stage` 为 `queue`，实际等待时长由 `queueMs` 承载；队列已满与冷却未执行为 `llm`。迟到审查结论不改判：结算后审查被中止仍可落一条带中止标记的审查记录（观测留痕），不产生第二条结算记录，不覆盖已落结算。取不到的字段明确缺失。

### 8.5 自有视图与耗时

使用 `conversation.view` 显示会话记录与详情。列表行按 `approvalId` 合并同一审批的审查记录与结算记录，合并键进列表投影；旧格式行按合成的 `approvalId` 独立成行（见 8.3）。列表以最终审批结果为主判定，渲染为「最终审批：拒绝（rejected）」形式；模型结论与最终结果方向不同时并列一条「模型结论：允许（allow）」，两个角色标签都在场，不并列两个无标签结果（requirements §7.3）。方向谓词固定：`allow` 与 `allowed-once` 同向（允许），`deny` 与 `rejected` 同向（拒绝）——同向不并列（如 `deny→rejected`）；`decision` 为 `error`、最终为 `cancelled` 或两值方向相反（人工推翻、故障与取消结算）时并列；`decision` 缺失时无模型结论可并列，不渲染次级标注。详情按 `approvalId` 返回两类记录的合并详情，不按存储行主键单查。列表结果带 `readFailed`（见 8.3）时显示「记录读取失败或不完整」提示，不把降级呈现为确认没有记录。

旧记录没有最终结果（`outcome` 缺失）时，列表行主位显示已记录的模型结论（「模型结论：…」），不冒充最终批准，并在行内附「未记录最终审批结果」说明；详情同样说明结果缺失。详情缺段的原因按 8.5.1 的五类可确认说明与统一缺省文案呈现，不归因于摘要采集。列表条数行下方常驻一行保留范围说明（`view.retention`，文案定稿见 8.5.1）：记录跟随产生它的会话；每会话回读最近一个窗口，磁盘按会话文件上限保留，超限删除最旧；减少采集不删除已有记录。该说明只陈述保留行为，不因列表为空或读取降级消失。

分段耗时互斥分解一次审批等待：`queueMs` 在调度器测量（见 5.1）；`reviewMs` 在审查任务内测量，含内部尝试，中止时计至中止；`humanWaitMs` 从确实交人工（审查收束、卡片因等待人工而持有）起，到人工作答、人工超时、通道关闭或取消结算。未交人工的路径该段缺失——无头会话；`fallback=reject` 时审查收束即结算、不进入人工等待（`ui.humanCardDuringReview` 不改变该缺失）；该开关开启且 `timeoutFrom=request` 的人工预算在审查期间耗尽、未及交人工即结算；以及审查期间人工抢答。并行期的等待已由 `reviewMs` 承载，不重复计入。审批总耗时只累加在场的分段，缺失段显示 `—`，不按 0 计；每段至多计入一次。

工具总耗时来自宿主工具记录，按调用关联；等式「工具总计 = 执行 + 审批」的审批一侧使用同一分段求和口径，净执行为非负的差值。关联失败只显示已知审批值，不能用零或猜测冒充测量。

原生轨迹组装在宿主内部，插件不改其审批标签、位置或工具段跨度。近似行匹配既有审批事件形成context节点，默认不显示；不能称作原生审批已实现。自有记录不写自定义会话事件，不进入会话压缩或分叉恢复。

#### 8.5.1 记录视图文案定稿（requirements §6.4、§7.3）

详情字段名：

| 字典键 | 中文 | 英文 |
| --- | --- | --- |
| `detail.outcome` | 最终审批结果 | Final approval |
| `detail.decision` | 模型结论 | Model conclusion |
| `detail.source` | 决定方式 | Decided by |
| `detail.effort` | 推理强度 | Effort |
| `detail.layer` | 模型选择来源 | Model selection source |
| `detail.fieldsDefaulted` | 自动补全的字段 | Auto-filled fields |
| `detail.degraded` | 缺失或异常情况 | Missing or degraded conditions |
| `detail.tokens` | 推理 token 用量 | Reasoning tokens |
| `detail.reasoning` | 模型返回的推理文本 | Model-returned reasoning |

`detail.reasoning` 与 `detail.tokens` 只说明模型或供应商实际返回的信息，不宣称得到模型完整内部思考（requirements §6.4、§7.2）。`reasoning` 缺失与 `prompt`／`input` 缺失的归因不同，见下。

列表双标注与旧记录：

| 字典键 | 中文 | 英文 |
| --- | --- | --- |
| `list.outcome` | 最终审批：{v} | Final approval: {v} |
| `list.decision` | 模型结论：{v} | Model conclusion: {v} |
| `view.noOutcome` | 未记录最终审批结果 | No final outcome recorded |
| `view.retention` | 记录跟随产生它的会话；每会话回读最近一个窗口（默认 200 条，随 ui.trace.maxRecords 可配置），磁盘最多保留 50 个会话文件（固定上限），超限删除最旧；减少采集不删除已有记录。 | Records follow the session that produced them. Each session reads back the most recent window (200 entries by default, configurable via ui.trace.maxRecords); at most 50 session files are kept on disk (a fixed cap), the oldest deleted first. Reducing capture never deletes existing records. |

详情缺段说明（`sectionOf` 的缺省分支按优先级链分派；无法确认时用统一文案）：

| 字典键 | 中文 | 英文 | 适用 |
| --- | --- | --- | --- |
| `absent.noContext` | 未取上下文 | No context collected | `evidence` 缺失 |
| `absent.noProbes` | 未调用取证工具 | No evidence tools called | `probes` 缺失 |
| `absent.modelNotProvided` | 模型未提供 | Not provided by the model | 全文段在场证实全文采集时：`reasoning` 缺失（模型或供应商未返回）；`output` 缺失且结算为故障类（空输出、模型异常，正文未产生） |
| `absent.notFullCapture` | 未开启全文采集 | Full-text capture was off | 全文段（`prompt`／`input`／`output`）均缺失，或 `reasoning` 缺失且全文段均不在场 |
| `absent.unknown` | 本次未记录此项 | Not recorded for this approval | 其余缺段（如 `reason` 缺失；`input` 缺失——送审对象摘要在场性依赖回查，回查失败与未开启全文在投影上同形，不冒充可确认原因），及会话级读取降级（`readFailed`）在场时的全部缺段 |

分派依据是已记录信息，按优先级链执行，不落新存储字段：读取降级（`readFailed`）在场时一律 `absent.unknown`（一级）；任一全文段（`prompt`／`input`／`output`）在场即证全文采集开启（二级），其余缺段按可确认路径分派——`evidence` 缺→未取上下文，`probes` 缺→未调用取证工具，`reasoning` 缺或 `output` 缺且结算为故障类（正文未产生）→模型未提供，其余（`reason` 缺；`input` 缺——送审对象摘要在场性依赖回查，回查失败与未开启全文在投影上同形，统一走本次未记录此项，不冒充可确认原因）→本次未记录此项；全文段均不在场才落「未开启全文采集」（三级）。读取降级在场时不把缺失归因于摘要采集，也不承诺开启全文后补回已有记录的缺失内容（requirements §7.3）。已知边界：`capture=full` 但写盘故障致全文段全部缺失时，三级推断会把该情形呈现为「未开启全文采集」——现有投影字段无法区分这两种状态，明示接受该边界：正常摘要档的推断成立，写失败时由读取降级在场时的 `absent.unknown` 统一缺省承接，不为该罕见路径新增存储字段或改判统一缺省（那会让最常见的「确实未开启全文」失去可确认说明）。

枚举文案（先中文含义，附原始值，中英成对）：

| 值 | 中文 | 英文 |
| --- | --- | --- |
| `layer.session` | 会话选择（session） | Session choice (session) |
| `layer.parent-map` | 按执行助手的模型映射（parent-map） | By the agent's model (parent-map) |
| `layer.global` | 全局默认（global） | Global default (global) |
| `layer.follow-parent` | 跟随执行助手模型（follow-parent） | Follow the agent's model (follow-parent) |
| `layer.unavailable` | 全部层级不可用（unavailable） | No layer available (unavailable) |
| `fieldsDefaulted` 值 | 风险分级（risk）、授权分级（auth）、理由（reason） | Risk level (risk), authorization level (auth), rationale (reason) |
| `degraded=command` | 无法辨认本次操作（command） | Action cannot be identified (command) |
| `degraded=cwd` | 会话目录缺失（cwd） | Working directory missing (cwd) |
| `degraded=transcript` | 上下文读取失败或截断（transcript） | Context read failure or truncation (transcript) |
| `degraded=entry:*` | 单条证据截断（entry:…） | Single evidence entry truncated (entry:…) |
| `degraded=all` | 模型选择全部不可用（all） | No model layer available (all) |
| `degraded=output-truncated` | 输出截断（output-truncated） | Output truncated (output-truncated) |
| `degraded=output-empty` | 空输出（output-empty） | Empty output (output-empty) |
| `degraded=superseded` | 已被其他路径先结算（superseded） | Settled first by another path (superseded) |
| `degraded=queue-overflow` | 队列已满（queue-overflow） | Queue full (queue-overflow) |
| `degraded=queue-timeout` | 排队超时（queue-timeout） | Queue wait timeout (queue-timeout) |
| `degraded=breaker-open` | 冷却中未执行（breaker-open） | Skipped during cooldown (breaker-open) |
| `degraded=inject-fail` | 通知失败（inject-fail） | Notice delivery failure (inject-fail) |

`degraded=entry:<事件类型>` 是前缀族，不逐事件类型落字典键，按前缀映射为「单条证据截断（entry:…）」并保留完整原值。枚举取词一律用探测式：键在字典则取，不在则用 `enum.unknown`（中文「{v}（含义未知）」／英文 `{v} (unknown meaning)`）按原值展示，不编造解释；强制语言档的翻译函数缺键会抛错使整条视图失败，枚举取词不得走该通道。`fieldsDefaulted` 与 `degraded` 多值时逐项映射后以顿号连接。`source` 行名为「决定方式」、`decision` 行名为「模型结论」，枚举值含义不变；`source`／`stage`／`origin`／`decision` 枚举沿用现行「中文（原值）」形式。

## 9. 随包安装、停用与卸载边界

### 9.1 包声明与权限预设

包的 `dsh.bundle.patch` 提供插件行和permission行配置声明。宿主按bundle顺序组合，profile用户层最后覆盖；插件层必须在提供基线permission行的宿主包之后。目标名字不匹配或id不存在时应有可见诊断，不能伪装新增成功。

权限声明保留宿主三个标准权限档，添加 `auto-approve`，其sandbox／approval与 `workspace-write` 完全相同。宿主没有有效显式选择时取第一个匹配组合，因此新增档排在 `workspace-write` 之后，避免旧会话被自动误判为已开启。相对于“完全权限”的顺序不是用户产品要求。

包声明不写 `defaultPreset`，安装不主动将自动审批设为默认。会话存储档名失效时，宿主按当前沙箱和审批组合回到标准权限档；新预设取值相等是这一回落的前提。

不声明安装／卸载生命周期写入脚本，安装路径只使用包声明及宿主管理依赖、启用列表和重新加载。发布产物必须包含包配置、宿主入口、客户端入口和协议入口。安装后是否可免重启由宿主装载验证；使用说明不承诺未经验证的热装载。

### 9.2 用户配置残留风险

宿主设置写回以活动配置为基础，可能把插件档与默认选择一起持久化到profile用户层。包层消失后，用户层仍可能留档；默认引用失效还可能造成permission服务加载或会话不可用。

按需求第8章，插件不解析、改写或代清用户YAML，也不提供备用清理操作。装卸路径只保留包声明与宿主官方管理。曾经的用户 YAML 手术对象（守护回调、手术内核、命令行清理工具、随包发布项、`yaml` 依赖与其解析锚定、对应合同测试）已整体退役并经隔离副本验证（装卸全程用户 YAML 逐字节不变），退役明细由 Git 历史承载，不再在本设计保留清单。

随包 bundle patch（`cordis.patch.yml` 的权限预设安装声明）保留，是需求第 8 章要求的存在物；README 的卸载风险陈述保留。

验证口径：使用隔离的配置副本（profile 与用户层 YAML 复制到临时环境），走主会话启用、停用、卸载与普通关闭路径，核对装卸全程不解析、不改写用户 YAML——副本文件内容逐字节不变，也不提供备用清理推荐；三个标准权限行为不变。不触碰真实用户配置。

正常停用卸载只移除包贡献和审批接管，不能承诺用户配置全部回到原样。使用说明必须同时说明风险和保护范围，不能以干净环境卸载成功掩盖用户设置情形。

插件运行数据默认保留；停止接管与删除审查历史是不同操作。宿主后续提供兼容处理时重新核验，不预写尚不存在的官方恢复功能。

### 9.3 版本字段与发布核验

版本格式和当前下一发布目标只定义于[需求 1.4](<requirements.md#14-插件版本与发布标识>)，宿主依赖约束引用需求 1.3。版本是展示与发布坐标，不替代宿主加载校验。

实施时同步 `package.json.version`、锁文件顶层 `version` 与根包 `packages[""].version`。核对 Git 标签移除前导 `v` 后与包版本逐字一致；发布产物读取的完整版本和宿主插件管理界面不得去掉 `+` 后部分。Release 标题按需求规定的顺序生成，不在本文另列目标值。

验证版本字符串的语义化版本解析和 Git 标签合法性，检查包元数据中的宿主部分与实际依赖／peer 一致。用隔离安装验证完整 Git 标签定位、产物版本和页面展示；普通版本范围比较忽略构建元数据，不能用它证明装对宿主版本。发布标签和 Release 在相应产物完成核验后创建，不移动已有发布标签。

## 10. 验证方案

### 10.1 验证边界

以需求第9章为结果合同，下面的方法不能取代产品要求。真实宿主测试记录实际版本、插件提交、配置和操作；离线测试、静态扫描、合成模型、旧截图各自只能证明其范围，不算全功能验收。界面用实际DOM和计算样式配合截图，不按文件名猜内容。

### 10.2 单元、接线与反例

| 主题 | 验证方式 |
| --- | --- |
| 接管与子代理 | 主／子会话、根链、未知预设、跳过、不改沙箱、创建监听失败及无人工通道矩阵 |
| 动作与授权 | 直接和双派发事件、非命令工具、零上下文、缺目录、真实参数／特殊自有键／共享无环对象／循环和深度边界；恶意指令只在证据段；无命令类键而其他键含危险字符串、命中显式规则时按规则直拒、理由带键路径，`unknownSubject` 两种取值交叉下规则扫描都执行 |
| 敏感与资源 | 真文件、凭据名、DSH根及链接别名、超大文件和候选、病态模式与事件循环响应；失败／超时不直接改判断 |
| 输出 | 完整JSON、最小allow、散文恢复、字段补全、畸形、空、截断即使局部合法仍拒；原始与内部字段来源 |
| 竞速 | 人工先答、审查先答、所有取消和时限、回调失败、迟到流；注入异常不改结果，next至多一次，资源释放；结算收尾恢复原始信号（同一性守卫、冻结对象无恢复、取消与关闭用例不回归）；逃逸出口在配置不可读时回退默认值，自身不再抛，恰落一条结算记录且审计行照常写出，通知按通道故障模板呈现 |
| 调度与故障 | 新操作独立判断、按 5.1 的重复调用回归、并发排队与等待结束、两次尝试共享时限、可重试分类、冷却排除及恢复、排队等待零值立即超时与冷却零值下次检查退出；同一请求对象再派发不因残留中止信号立即取消，执行完整审查并新落一条结算记录；计时回调抛错直接驱动 `gate` 层验证（公共审批流水线注入不了回调抛错），审查环节与真实超时两种情形计数一致：两次后第三次冷却拦截；人工时限环节不计；既有结算形状用例不回归 |
| 配置 | 每个边界值、部分分节、volatile现读、请求隔离、一次／两次配置结构序列化；实例级设置函数的直测不能冒充生产请求隔离；温度非有限数按入口可见拒绝：`Config(NaN)` 在 schema 校验即拒（退化步长经序列化往返仍拒），装载配置报错可见，设置页 JSON 通道无法表达，程序化写入由读取检查拒绝并按内部异常结算 |
| 记录 | 摘要字段词汇表四层贯通、字段来源与配置策略标识、主／子代理归属与升权目标、接管预设名、证据与取证摘要、尝试次数与解析层级、审查判定与最终结算关联及全路径覆盖、审查未执行前缀与 source 辨认、旧格式行独立成行、分段耗时缺失不当零、脱敏先截断、不同预算、写读失败、撕裂、读失败页面降级、回读、同时间轮转不删新文件、长期容量 |
| 界面与语言 | 控件回读、暂存保存恢复、无上限风险提醒、秒数非法输入仍保生效值、已配置但不存在的预设显式提示且不丢弃用户值、英文id、两语言独立、卡片真实状态与及时显隐、人工零时限不出现无时限等待瞬态 |
| 说明入口与名称 | 7.2.1/7.2.2/7.3.1/8.5.1 的键值与行为：21 个字段各有一个带可见文字的说明按钮、`aria-expanded`/`aria-controls` 成对、展开后按钮文字变「收起说明」、再点收起；鼠标点击与键盘激活各有用例——替身上对按钮分别调点击处理器与 keydown 处理器（Enter 与 Space 各一次），断言 `aria-expanded` 翻转与展开区显隐（装置层不转译键事件，键盘路径由组件自身承载）；开合前后暂存表、保存计划、保存可用性、输入值与常驻提醒句均不变；数字字段不传 `help` 且平铺说明行，分隔线选择器组（`.dsafm_f_sec + div:not(.dsafm_field):not(.dsafm_f_help)` 与 `.dsafm_f_help + div:not(.dsafm_field)`）在 CSS 文本断言，防说明行误加分隔线与后继字段分隔线丢失；双主题样式类（`min-width/min-height:24px`、`label-secondary` 取色、`focus-visible`）在 CSS 文本与 DOM 替身双核对；名称表逐键断言中英定稿值、退役键不出现在字典（测试替身中仅防回潮装置可引用退役键名，并断言其不被消费）；`card.presets.none`/`missing.remedy`/`unavailable` 的定稿文案与空清单两分支 |
| 卡片状态区分 | `pendingState` 枚举归一化为 `reviewing`/`waiting-human`，交人工序列断言为 `['reviewing','waiting-human']` 且带 `cause`（deny/timeout/error 三分支各一例；`cause` 写错按 `error` 归一化有用例），`test/pending-state.test.mjs` 断言使用新枚举与 `cause` 透传；`cause=error`（模型异常、队列已满、冷却未执行转人工）文案不含危险判定措辞；人工未决不出现「最终拒绝」措辞；人工零时限不登记状态；结算后状态清除 |
| 记录双标注与缺段 | 列表行 `list.outcome`/`list.decision` 前缀成对出现于方向不一致的行，方向谓词按 8.5（`allow↔allowed-once`、`deny↔rejected` 同向不并列；`decision=error`、最终 `cancelled` 或反向并列；`decision` 缺失不渲染次级标注），并含同向反例断言——`decision=deny→outcome=rejected` 与 `decision=allow→outcome=allowed-once` 的行不出现次级标注；旧格式行（无 `outcome`）主位为 `list.decision` 并附 `view.noOutcome`；`absent.*` 五类分派按 8.5.1 优先级链（读取降级→统一缺省；任一全文段在场→按可确认路径分派；全文段均缺→未开启全文采集）；`layer`/`fieldsDefaulted`/`degraded` 枚举中英定稿附原值、`entry:*` 前缀映射与探测式取词（缺键走 `enum.unknown`：原值＋含义未知标注，不抛错）；`view.retention` 常驻在场 |
| 装卸 | 宿主组合干净装卸、保留原档、用户配置复制风险，不自动改YAML；发布产物含完整入口 |
| 版本 | 包与锁文件一致、版本及标签解析有效、依赖／peer 对应宿主信息；完整标签隔离安装、产物与管理界面展示核对，Release 标题顺序正确 |
| 测试运行 | 全套准确计数与退出码：通过、失败、跳过分别计数，非零退出码即失败，跳过带理由；报告器可见范围不代替完整结论 |

对关键安全规则撤去保护或恢复错误形态，验证能检出退化；只使用隔离替身或复制数据，不对用户环境作危险操作。慢任务真实触发超时，链接测试创建真链接，流中途失败使用可迭代替身；竞速用受控时钟或足够间隔，防止测试时序抖动。

### 10.3 真实宿主与界面

- 验证allow后实际工具执行、安全拒绝、人工时限、审查及排队超时、取消和持续故障恢复。
- 验证无浏览器时默认审批仍可完成，不因为人工卡片下游等待无限挂起；无头子代理全程不交人工。
- 设置页面在 `[data-plugin-detail="dsh-approve-for-me"]` 的配置区真实可见；修改保存与重开回读一致，新请求使用新值。删表单注册或改槽键时，页面验收必须失败。
- 无上限风险提醒在草稿、保存读回和卡片语义中正确；人工零不能变无限等待。
- 控件显隐用真实权限切换和宿主状态对照，不卡固定轮询周期；审批卡状态与同帧截图核对。
- 审查与结算记录跟最终审批结果、实际模型和耗时一致；不能用审查allow代替人工或超时最终结果。
- 干净安装、停用卸载和用户设置持久化情形分别验证。用户配置风险是已接受边界，不把它写成插件已自动修复。

界面文案与说明入口的真实页面验证（requirements §9「界面文案与说明入口还须证明」三条逐项），用 `tools/browser-shot.mjs` 驱动真实部署实例（实例地址经 `tools/local-config.mjs` 解析），浅色与深色主题各跑一轮，截图留证于输出目录。主题切换手段：经 `eval` 写宿主主题偏好（宿主设置服务的主题写入入口；不可行时注入宿主主题类名或存储键，具体键名实施时以 `--dump` 探测），每轮截图前用 `eval` 读取页面计算样式的主题 token 取值（如正文背景色）并断言两轮不同，防止两轮同主题；探测结论记录在验证产物里，供下次巡检复用。

- 未展开巡检：逐字段核对常驻短句在场（影响对象、默认与零值含义、风险提醒），再用 `eval` 读取每个 `.dsafm_helpbtn` 的 `getBoundingClientRect`（≥24×24 CSS 像素）与计算样式取值，按 WCAG 相对亮度公式计算对比度并断言 ≥4.5:1——采样对象为按钮文字的 `color` 与最近带背景色的祖先元素的背景色，浅深两轮各测并记录原始取值与计算比值；鼠标路径 `clickSelector` 点开与收起各一次，键盘路径对同一按钮 `eval` 聚焦后派发 keydown（Enter 与 Space 各一次，组件自身处理键事件并 `preventDefault`），断言 `aria-expanded` 逐次翻转、展开区与「收起说明」文字随开合出现消失；开合前后用 `eval` 比对输入值、保存按钮可用态与常驻提醒句在场不变。七类字段（数字、下拉、多行文本、多选、布尔、模型选择、映射表）各抽至少一个代表截图（收起与展开两态）。
- 名称一致性巡检：设置页、会话模型控件、审批卡片与审查记录四处截图，按 7.2.2/7.3.1/7.4/8.5.1 定稿逐名核对；审查使用相同模型的说明、推理强度「自动选择」、空预设清单与未知预设处置、通知范围与记录开关、文本拒绝规则与其他检查的区分各自可见；保存前后用设置快照核对配置键、枚举值与默认值不变。
- 卡片与记录状态巡检：对安全拒绝、超时、模型故障、队列已满、冷却未执行、人工先答与迟到点击分别截同帧卡片，核对文案不误报危险、不暗示已完成的审批还能改判；记录列表中模型结论与最终结果不一致的行双标注可见，详情缺段按 `absent.*` 五类说明，摘要级记录不依赖开启全文解释；旧记录行附「未记录最终审批结果」。

静态 DOM 判据由 `tools/build-dom-dump.mjs` 三件套（`test/settings-dom-dump.test.mjs`、`test/fixtures/settings-dom-dump.txt`）同步承载：说明按钮计数 21 个、全部带可见文字与成对 aria 属性、点击后展开区在场。旧截图与接口返回不作为界面验证证据。

## 11. 当前实施与验证待办

本章是当前实施与验证差距的唯一工作清单。完成后删除对应项，不保存修正历史。本轮已完成事项（调度独立审查任务、用户 YAML 手术对象退役与隔离验证、摘要词汇表四层贯通、结算记录全路径、分段耗时生产与呈现、无上限风险提醒、人工零时限双防线、读取失败页面降级、排队与冷却零值边界、零预算默认回退、全套测试计数与退出码）均有对应实现、测试与独立盲审记录，由 Git 历史承载，不再列于此。仍待办理：

- 界面文案与说明入口未实施（requirements 71b506a 的设计定于 7.2.1、7.2.2、7.3.1、7.4、8.5.1）：client.js 字典与渲染、数字字段平铺说明行、`pending-state` 的 `waiting-human` 与 `cause`（归一化透传 `cause`，写错按 `error`；`test/pending-state.test.mjs` 旧枚举用例同步）、`gate` 层交人工登记、记录视图双标注与缺段分派、`typert.host.js` 的 `pendingState` 结果 schema／`PendingState` 类型声明／成员描述三处同步加 `cause`（缺一处字段即被校验或投影剥除）、settings-dom-dump 三件套与各测试断言均待施工。字典迁移对照（完成后随本条删除）：`cardstate.timeout`、`cardstate.denied`、`cardstate.denied.noreason`、`detail.notCaptured`、`detail.absent`（无消费点）及其英文对应键删除，改用 7.4 与 8.5.1 的键；`countdown.unlimited` 中文定稿「审查无时限」；`effort.default`「跟随模型默认」改「自动选择」（英文 `Model default`→`Automatic`，定稿见 7.3.1）；「主模型」字样改「执行助手模型」、「档位」用户可见字样改「推理强度」（`card.map.col.reviewer` 定稿值即现行值，无需改）；`test/pending-state.test.mjs` 旧枚举断言（`'reviewing'`/`'timeout'`/`'denied'`）改 `['reviewing','waiting-human']` 与 `cause` 透传；`test/gate.test.mjs` 两处交人工旧枚举断言（`['reviewing','denied']` 与 `'timeout'`）改 `['reviewing','waiting-human']`＋`cause`——裸状态串不在退役键 grep 范围，须点名该文件核改；删除后全仓 grep 退役键与旧字样零残留（含测试替身字典与 settings-dom-dump 基线）。完成后按 10.3 的三条界面巡检执行真实页面验证。
- 真实宿主与界面核验未执行（10.3 清单）：allow 后实际工具执行、无头全程不交人工、设置页真实可见与保存生效、卡片状态与同帧截图、记录与最终结果一致、干净安装与用户设置持久化情形。本轮的静态扫描、接线测试、替身渲染、本地取证页的像素级视觉判定（已由视觉能力验收者逐张判图通过）各自只证明其范围，不冒充实机结论。
- 发布链核验未执行（9.3）：发布产物读取的完整版本、完整 Git 标签隔离安装、宿主管理界面展示、Release 标题。本轮发布项仅同步包与锁文件版本（已完成并核对三处一致）；标签与 Release 在发布流程执行时创建，不移动已有发布标签。

## 12. 增补设计

本章承接需求第10章的已批准增补项，注明需求标识、机制、边界和验证方法。变更已有机制时同时修正原主题，不能在此保留另一套相反方案。维护者定期并回第1至第10章，完成后删除第11章对应项，历史由Git保存。

当前无未归并的增补设计。
