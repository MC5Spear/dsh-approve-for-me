# dsh-approve-for-me

[![CI](https://github.com/MC5Spear/dsh-approve-for-me/actions/workflows/ci.yml/badge.svg)](https://github.com/MC5Spear/dsh-approve-for-me/actions/workflows/ci.yml)

> **第三方社区插件**，与 DeepSeek Harness 官方无关。
>
> **维护姿态**：个人维护、按精力更新。**接受 issue**（问题、场景、想法都欢迎；不保证响应与修复时间），**不接受外部 PR**；不设漏洞管理流程——安全相关问题按普通 issue 提，请自行斟酌脱敏。

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）做的自动审批插件：需要审批的沙箱升权请求，先由 LLM 审查器逐次判断——判定安全就直接放行，判定危险就直接拒绝并把理由交回主模型。等价于 codex 的 `--approve-for-me`。

> **English summary.** `dsh-approve-for-me` is a third-party plugin for DeepSeek Harness that takes over sandbox-escalation approval requests and decides them with an LLM reviewer instead of a human click. Safe requests are auto-allowed (`allowed-once`), dangerous ones are rejected with the reason injected back into the main model. Failures — timeout, error, unparseable output, unavailable model — are **fail-closed** (reject). The reviewer may call read-only tools (`read_file` / `list_dir` / `glob` / `grep`) implemented in-process with `node:fs`; they never trigger approvals, never write, never touch the network. The plugin ships its permission tier inside its own bundle patch: installing writes nothing to the profile layer (no lifecycle scripts run), and removing the package removes the tier — restart the host to see the baseline. Normal operation modifies no host files; the single exception is an uninstall-time guard that deletes the default-preset override row the host settings UI wrote, when it points at this plugin's now-removed tier. **Read the risk section below before enabling it.**

---

## ⚠️ 先读这一节：它会替你做决定

本插件在**沙箱升权**这条调用链上替代人工点击。默认配置下：

- `mode: rules` 表示「规则强制检查 + LLM 审查」；
- `denyPatterns` **出厂为空数组**，即**规则层不拦截任何东西**——每一次升权请求都交给 LLM 判断。

具体来说：

1. **判定为安全的请求会被自动放行**（`allowed-once`，仅本次有效）。放行的是**升权后的沙箱权限**，也就是让工具能读写工作区之外、执行更宽的操作。
2. **LLM 判定不是安全边界**。它是模型给出的判断：会被提示注入影响、会有误判、会随模型与档位变化。审查器的输入来自被审操作本身与其上下文（含会话转录），**这些内容是不可信数据**——提示词里写明了这一点，但它不构成保证。
3. **失败姿态是 fail-closed**：审查超时、调用失败、输出不可解析、模型不可用 → 一律**拒绝**，并注入理由。默认不会因为「审不了」就放行。
4. **规则强制检查（`denyPatterns`）不可被推翻**：命中即拒绝，LLM 与人工都不能改判；但它出厂为空，需要你显式配置（见下「出厂参考清单」）。
5. 建议的启用方式：先在非生产环境试跑；把 `denyPatterns` 抄进配置恢复确定性拦截；按需收窄 `allowEscalationTo`、`tools`、`trigger.presets`；需要人工备用通道时用 `fallback: 'ask'`。
6. **本插件的「自动审批」预设档随包自带**（包内 `cordis.patch.yml`），装卸全程**不写 profile 层**、无生命周期脚本、不触发宿主构建审批——卸载即档位消失，重启宿主回到基线（见「回滚」）。运行期不修改宿主任何文件；唯一例外＝卸载防护会在「宿主设置写出的 permission 覆盖行含本包贡献（自动审批条目或悬空默认档）、且本包正被移除/停用」时，对该行做贡献级清理——只摘本包条目与悬空默认行，无有效默认选择且无自定义时才整行删除（该写入本身即清理，见「回滚」）。

**行为一览**

- 判定安全 → 自动放行（`allowed-once`）。
- 判定危险 → 直接拒绝（`rejected`），并经 `agent.inject()` 把理由交给主模型。
- 审查超时、失败、输出不可解析、模型不可用 → 直接拒绝（fail-closed），同样注入理由。
- `req.signal` abort → `cancelled`。
- 可选人工通道（`fallback: 'ask'`）启用时，人工无响应 → 自动拒绝。

**审查器可以调用只读工具取证**（`read_file` / `list_dir` / `glob` / `grep`）。工具由插件用 `node:fs` 只读接口实现，不经工具注册表、不触发审批、不写工作区、不联网。边界与已知局限见「只读工具边界」。

## 兼容性

适配 dsh `0.2.0-rc.2`：`@deepseek-ai/dsh-llm` 与 `@deepseek-ai/dsh-typert-protocol` 锁定为 `0.2.0-rc.2`，peer `@deepseek-ai/cordis` 与宿主同版（`~4.0.4`）。

宿主装载 bundle 时会**精确校验 peer 版本锁定**：`package.json` 里声明的 `@deepseek-ai/*` 版本与运行时不一致时，该 bundle 会被**直接跳过**（宿主日志出现 `skipping profile bundle "dsh-approve-for-me"`），插件看起来「装了但没反应」。换宿主版本时先核对自己锁定的版本。

**装宿主锚点包请显式带版本**：npm 上这两个 peer 包的 `latest` 标签指向旧版本——`@deepseek-ai/dsh-llm` → `0.0.1-rc.1`、`@deepseek-ai/dsh-typert-protocol` → `0.1.0-rc.6`，`0.2.0-rc.2` 挂在 `next` 上。不带版本装会拿到对不上的旧包，插件随即被宿主跳过。宿主主包 `@deepseek-ai/dsh` 的 `latest` 就是 `0.2.0-rc.2`（上游另有 `0.2.1-alpha.1` 的 alpha 线在跑）。

## 安装

### 主路径（推荐）：dsh 原生通道

```powershell
dsh plugin --profile web add github:MC5Spear/dsh-approve-for-me
```

就这一步。重启宿主后权限选择器里多出「自动审批」档：预设档随包自带的 bundle patch（包内 `cordis.patch.yml` 重述 permission 行并加第四档）随装载合成，**安装全程不写 profile 层、不跑任何生命周期脚本、不触发宿主构建审批**；卸载（`dsh plugin … remove`）后档位即消失。0.2.x 时代的两条手工命令（`--init-row` / `--apply`）已退役——它们往 profile 层写重述，新机制不需要。

`dsh plugin` 把参数原样转发给 pnpm，pnpm 原生支持 git 源形态：`github:<owner>/<repo>`，也可用 `#<tag>` 用标签锁定（如 `github:MC5Spear/dsh-approve-for-me#v0.2.0`）。本包纯 JS、零生命周期脚本（`postinstall` / `preuninstall` 均不声明），任何源形态都不会弹宿主的构建审批提示。

**GUI 形态**：设置页「插件」面板的安装对话框里粘贴同一 spec 即可（与 CLI 同一安装引擎；对话框先 inspect 再安装，pnpm 输出折叠可见）。

`dsh plugin` 通道要跑 `pnpm`。没装 pnpm 时用 Node 自带的 corepack 即可（`corepack pnpm --version`），它只落 corepack 缓存、不改全局 PATH。

### 备选路径：克隆 + 本地链接

```powershell
git clone https://github.com/MC5Spear/dsh-approve-for-me.git
cd dsh-approve-for-me
npm install --omit=dev            # 包目录必须能自己解析依赖（见下）

# 把包装进目标 profile：会同时写入 dependencies 与 dsh.profile.bundles
dsh plugin --profile web add <克隆目录的绝对路径>
```

克隆通道与主路径的差别只在 `dependencies` 里记录的是 `link:` 本地路径而非 `github:` 源——预设档同样由包内 bundle patch 提供，无需任何手工步骤。

**包目录必须能自己解析依赖**：链接模式下 Node 按真实路径解析，克隆目录里要先 `npm install --omit=dev`。`@deepseek-ai/schemastery` 必须 ≥ 3.18.4——插件用 `.volatile()` 声明可热改字段，低于该版本整行会被设置接口跳过。

装完重启宿主（宿主侧要重启才装载；客户端侧随页面加载生效）。**重启要在服务进程树之外执行**：宿主服务默认会清理整棵进程树，从服务自身进程树内发起的重启会把自己一起杀掉、停在停止态。

## 审批时序

```
工具沙箱拒绝后带 sandbox_permissions 重试
  → approveEscalation() → ctx.approval.request({ agent, toolName, callId, reason, signal? })
  → approval/request waterfall
       ├─ dsh-approve-for-me（prepend）
       │     ├─ 规则强制检查命中 → 直接拒绝（不消耗 LLM，LLM 与人工都不能推翻）
       │     ├─ 不接管 → next() 原样下传
       │     └─ 接管 → 改写 req.signal 后先 next()（卡片出现）→ 并行审查 → 按结果竞速
       └─ 浏览器审批 UI 应答者
```

审批请求本身**不带工具参数**，真实命令按 `callId` 回查派发事件的 `data.arguments`；插件同时接受新名 `tool/ptc-dispatch-start` 与旧名 `tool/code-dispatch-start`（`lib/transcript.js` 的 `DISPATCH_EVENT_SET`）。

## 配置

配置住在插件的宿主行里，行 id 就是设置命名空间 `approve-for-me`。两种改法：

1. **设置页**（仅 loopback 页面）：「插件」面板里本包的详情页表单，改动**保存后**即时生效——前提是各字段在 `Config` 里声明了 `.volatile()`（否则设置接口会跳过整行）。
2. **profile patch**：`<profile 目录>/cordis.patch.yml` 里 `- id: approve-for-me` 那一行的 `config:` 块。行不存在时补一行（`name: dsh-approve-for-me`）。

**本插件不读 `settings.yaml`**：配置只住在 profile patch 的 `config:` 块（设置页写入的也是它）。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；关闭时不注册应答者 |
| `mode` | `rules` | `rules` = 规则强制检查 + LLM 审查；`off` = 不接管 |
| `tools` | `[]` | 接管工具名单；留空 = 对所有工具生效，填了则只接管名单内工具的审批请求，其余原样交给下一个应答者 |
| `allowEscalationTo` | `danger-full-access` | 自动放行允许的最宽升权目标；默认值即最宽档，等于不设额外上限 |
| `denyPatterns` | `[]` | 规则强制拒绝清单；**留空＝不启用规则强制检查**，显式写入后命中即拒绝、不消耗 LLM 调用。出厂参考清单见下 |
| `unknownSubject` | `reject` | `callId` 回查不到命令时：`reject` 直接拒绝，`review` 带 `degraded=command` 继续审查 |
| `fallback` | `reject` | 审查未放行时：`reject` 直接拒绝，`ask` 交人工 |
| `reviewer.model` | `''` | 默认审查模型与档位：`{ model, effort }`（旧字符串写法仍可读）；`model` 形如 `provider/model`，`effort` 空串表示跟随模型默认 |
| `reviewer.byParentModel` | `{}` | 按主模型映射：父模型 id（纯模型 id）→ `{ model, effort }` |
| `reviewer.followParent` | `true` | 最后一层：跟随父 agent 当前模型 |
| `reviewer.timeoutMs` | `90000` | 审查超时；`0` = 无审查超时（模型挂起则本次审批挂起） |
| `reviewer.maxTokens` | `0` | 审查请求输出上限；**`0` = 本插件不设上限**，由模型自己的默认值决定（与 codex 一致）。见下方「输出预算」 |
| `reviewer.temperature` | `0` | 审查请求温度 |
| `reviewer.maxToolSteps` | `4` | 工具轮次上限；超限后追加「请直接给出结论」再请求一次（不带工具） |
| `reviewer.toolTimeoutMs` | `5000` | 单次只读工具调用超时；超时按「无证据」处理 |
| `human.timeoutMs` | `300000` | 人工响应时限，仅 `fallback: 'ask'` 时生效；`0` = 立即拒绝 |
| `human.timeoutFrom` | `request` | 计时起点：`request` 从请求进入插件起算，`handoff` 从交人工起算 |
| `context.*` | `24576` / `4096` / `40` / `true` | 依次是：会话上下文预算字节数、单条上限字节数、取样条数、是否纳入工具结果 |
| `context.redactPatterns` | 6 条 | 脱敏清单；作用于提示词、工具结果与审计 |
| `concurrency.max` / `queueMax` / `queueTimeoutMs` | `2` / `8` / `30000` | 全局并发、每会话排队上限、排队等待上限 |
| `breaker.*` | `3` / `50` / `10` / `600000` | 熔断阈值：连续拒绝、窗口大小、窗口内拒绝、冷却时长。计数口径把 `error` 与 `deny` 同权（审查通道不再产出可信结论即计数，无论模型坏还是判定严）；`allow` 清零连续计数；`queue-overflow` 一类调度失败不计数。打开后新请求零 LLM 调用，直接拒绝并注入通道故障文案 |
| `audit.enabled` / `includePrompt` / `includeRaw` / `maxLineBytes` | `true` / `false` / `false` / `4096` | 审计开关与追溯开关 |
| `trigger.presets` / `unknown` / `subagents` / `auditEverySkip` | `['auto-approve']` / `skip` / `review` / `false` | 权限预设触发：哪些预设下接管（设置页是多选下拉，选项与中文名来自宿主预设表，并标出默认预设）、预设不可判定时的处置、是否把委派子代理纳入接管（按**委派链根会话**预设判定后接管，并把子会话审批策略翻为 ask；子代理无人工通道，`fallback: 'ask'` 对其按拒绝结算）、是否逐次写跳过审计 |
| `ui.inject` / `injectMaxBytes` | `all` / `2048` | 会话页注入范围（`all` / `reject` / `off`）与单条字节上限 |
| `ui.humanCardDuringReview` | `true` | 审查期间是否就把原生人工卡片弹出来。`true`＝审查期间可见、可抢先人工决定；`false`＝审查期间不弹，仅在审查未放行且 `fallback: 'ask'` 时才出现（卡片会标明是超时还是拒绝） |
| `ui.trace.capture` / `ui.trace.legacyRow` | `full` / `false` | 审查记录页签的留痕深度（见「轨迹集成」） |
| `language.ui` | `auto` | **用户文案语言**：`auto` 跟随宿主界面语言；`zh`／`en` 强制插件全部界面文案（设置卡字段与说明、composer 控件、审批卡状态条、审查记录页签）走该语言字典（缺键即抛错，不静默回退） |
| `language.agent` | `en` | **Agent 提示语言**：送给审查模型的系统提示、只读工具 schema 与结果文案、注入主模型的放行/拒绝/超时文本所用语言。输出契约、不可信声明、`<truncated/>` 标记、工具名与 schema 字段名两语言逐字节一致；拒绝文案英文末句为 codex `REJECTION_INSTRUCTIONS` 原文 |

### `denyPatterns` 出厂参考清单

`denyPatterns` 出厂默认为空＝**不启用规则强制检查**，全部升权交 LLM 审查。要恢复确定性拦截，把下面 8 条抄写进配置（常量源＝`lib/policy.js` 的 `DEFAULT_DENY_PATTERNS`，前锚为非字母数字边界）：

```
(^|[^A-Za-z0-9])(mkfs|diskpart|fdisk|parted)\b
(^|[^A-Za-z0-9])format\s+[a-z]:
(^|[^A-Za-z0-9])dd\s+.*\bof=/dev/
(^|[^A-Za-z0-9])rm\s+(-[a-z]*\s+)*(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+(/|/etc|/usr|/var|/home|\$HOME|[a-z]:\\)(\s|$)
(^|[^A-Za-z0-9])Remove-Item\b(?=.*-Recurse)(?=.*-Force).*([a-z]:\\(Windows|Users|Program Files)|\bC:\s*$)
(^|[^A-Za-z0-9])(vssadmin\s+delete\s+shadows|bcdedit|cipher\s+/w|wbadmin\s+delete)\b
(^|[^A-Za-z0-9])reg\s+delete\s+HKLM
(^|[^A-Za-z0-9])(shutdown|Stop-Computer)\b
```

**这是文本匹配护栏，不是安全边界。** 同一意图的等价变形（改写、编码、别的命令组合）可以绕过它；它只是第一道筛子，用来把最危险的一批操作从 LLM 的判断范围里摘出去。清单公开不降低安全性——默认本来就为空，装填与否由你决定。

显式配置后：命中即直接拒绝（`action=deny source=rule`），不消耗 LLM 调用，LLM 与人工都不能推翻；审计行 reason 写明命中键与模式。文本引用类命令（如 `grep mkfs readme.md`）也会命中——fail-closed 口径，可自定义清单收窄。

### 审批卡片上的自动审批状态

卡片外壳（「等待审批」条与两个按钮）由宿主原生渲染；插件在卡片 body 里加一条状态行与倒计时（`conversation.approval.detail`）：

| 状态 | 什么时候 | 卡片上显示 |
|---|---|---|
| 正在自动审批 | 审查进行中（`ui.humanCardDuringReview = true`） | `正在自动审批` + 「剩余 N 秒」＝审查时限 |
| 自动审批超时 | 审查超时后转为等人工（`fallback: 'ask'`） | `自动审批超时，已转人工` + 「剩余 N 秒后自动拒绝」 |
| 自动审批拒绝 | 审查拒绝后转为等人工 | `自动审批拒绝；原因：<理由>` + 「剩余 N 秒后自动拒绝」 |

没有时限时不显示倒计时；`pendingState` 取不到时状态行整条不渲染，卡片退化为原样。

### 注入文案的三种口径

主模型收到的注入文本按结局分三种，选择集中在 `gate` 的结算分支：

- **超时**（审查超时 / 人工超时 / 排队超时）：点明「没等到结论、按拒绝处理、可以直接重试」——超时不是安全判定，主模型不该因此放弃或绕路。
- **判定为危险**（deny：LLM 给出 `deny`、规则命中、升权超上限）：codex 原版拒绝文案，末句是「不要用等价手段绕过该拒绝……」。
- **通道故障**（error 判定：LLM 流失败、空输出、截断、模型不可用、`queue-overflow`、`breaker-open`、插件内部异常）：点明「审查通道故障、不是判定为危险、同一操作可直接重试」，末行是防风暴指引（重试仍失败就报告用户，不要连续反复重试）——故障没有安全结论，不该套用拒绝禁令把可放行的操作锁死。

### 输出预算

codex 的自动审查请求不设输出上限（codex 的 `ResponsesApiRequest` 结构体没有 `max_output_tokens` 字段，见 `codex-rs/codex-api/src/common.rs:260-283`），本插件同样默认不设：`reviewer.maxTokens = 0` 时不把该字段放进请求，实际上限由 provider 的模型元数据决定。

为什么不能给小上限：思考型模型先吃掉这份预算。实测（`deepseek-flash`，120 输入 token 的极短审查提示；同一组合跑两次取区间）：

| `maxTokens` | 档位 | `finish` | 正文 | 思考 token |
|---|---|---|---|---|
| 512 | `max` | `max-tokens` | 0 B / 27 B | 503–512（吃满） |
| 512 | `low` | `max-tokens` | 0 B / 320 B | 448–512（吃满） |
| 2048 | `max` | `stop` | 416–482 B | 351–1347 |
| 2048 | `low` | `stop` | 325–539 B | 220–340 |
| 不传 | `max` | `stop` | 444–805 B | 953–1457 |
| 不传 | `low` | `stop` | 356–387 B | 381–422 |

512 时 `finish` 恒为 `max-tokens`，正文要么为空、要么是被切断的半句 JSON：两种形态都不可能通过审查判定。

截断与空响应一律 fail-closed：`finish.kind = 'max-tokens'` → 本次审查判失败（`degraded=output-truncated`），即使正文已能解析出 JSON 也不采信；`finish.kind = 'error'` 且 `code = 'EMPTY_RESPONSE'` → `degraded=output-empty`。

### 审查模型解析顺序

先命中先用；任一层给出不可用的 provider/model 时降级到下一层并写审计：

1. 会话级选择：文件载体 `$DSH_HOME/approve-for-me/session-models.json`（没有条目时回退到旧事件折叠）
2. 父模型映射：`reviewer.byParentModel[父模型 id]`（键为纯模型 id，值为 `{ model, effort }`）
3. 全局默认：`reviewer.model`
4. 跟随父模型：`reviewer.followParent` 且能读到父 agent 的 `model/selection` 事件

全部失败 → 审计 `layer=unavailable degraded=all`，按 `fallback` 处置（默认直接拒绝）。
档位按 codex 规则解析：模型支持 `low` 就用 `low`，否则不传档位（由模型默认档决定）；显式指定的档位不受支持时不传并写 `degraded=<layer>:effort=X unsupported`。

### 两条超时

- `reviewer.timeoutMs`：到点先中止审查流，再以 `{decision:'error', reason:'review timeout'}` 结算。
- `human.timeoutMs`：只在 `fallback: 'ask'` 时生效；到点撤回卡片、拒绝并注入理由。
- 两者都不改写 `req.signal`；`req.signal` 只表达「工具调用被取消」，插件监听它并返回 `cancelled`。撤回卡片用独立的控制器，经 `AbortSignal.any` 合并到 `req.signal` 上。

## 只读工具边界

| 工具 | 上限 |
|---|---|
| `read_file` | 单次 64 KiB；支持 `offset` / `limit` 分页 |
| `list_dir` | 最多 200 条，不递归 |
| `glob` | 最多 200 条；支持 `**` `*` `?`；不跟随符号链接 |
| `grep` | 最多 100 条匹配；单行 500 字符；正则编译失败即返回错误 |

读取拒止清单（在 `realpath` 归一化后的路径上匹配，大小写不敏感）：`.credentials*`、`*.pem`、`*.key`、`*.pfx`、`id_rsa*`、`id_ed25519*`、`.env*`、`*_history`、`*.kdbx`、`.netrc`、`.git-credentials`、`.npmrc`、`.aws/credentials`、`.docker/config.json`、`.ssh/**`、`settings.yaml`。命中即返回「已拒止」错误。

已知边界：

- 清单按**名称**判定，不识别硬链接与改名副本（`ln` 或复制到别的名字后内容可读）；插件不负责发现这类等价物。
- `list_dir` 只过滤拒止目录本身，**不过滤条目名**——凭据文件名可能出现在目录列表里，但内容读不到。
- UNC 与设备命名空间路径（`\\server\share`、`//?/C:/…`、`\\?\C:\…`）一律拒止，不发起网络访问。
- 相对路径以会话工作目录为基准；`..` 可以指向工作区之外，这是审查取证的需要，不是越权。

工具失败或超时按「无证据」处理：把错误文本作为该次工具结果回喂，循环继续，不因此自动放行或拒绝。

## 审计

写宿主 stderr，单行一条，字段顺序固定（`v=3`；版本号＝`AUDIT_VERSION`，与启动行同源）：

```
[approve-for-me] v=3 ts=<ISO> id=<uuid> phase=<screen|review|tool|handoff|decide|error|prompt|raw>
  callId=<id|-> tool=<name|-> cwd="<path|->" mode=<requestedMode|-> action=<review|deny|skip>
  source=<llm|human|rule|timeout|error|signal|gateway|queue|breaker|preset>
  path=<allowed-once|rejected|cancelled|-> decision=<...> inject=<yes|no> injectBytes=<n>
  withdraw=<ok|unavailable|skipped>
  layer=<session|parent-map|global|follow-parent|unavailable> model=<provider/model|->
  effort=<档位 id|none|-> finish=<max-tokens|stop|tool-calls|error:CODE|-> reasoningTokens=<n|->
  fieldsDefaulted=<true|false> risk=<low|medium|high|critical|-> auth=<unknown|low|medium|high|->
  tools=<n> reviewTimeout=<ms|disabled>
  degraded=<none|all|cwd|command|output-truncated|output-empty|layer:reason[,…]>
  ms=<n> truncated=<true|false> reason="<escaped>"
```

- `truncated=` 只表示**审计行本身**被截断（`reason` 超 200 字符或整行超 `audit.maxLineBytes`）。
- `degraded=output-truncated` / `output-empty` 表示**模型输出**被截断或为空（见「输出预算」）。
- `fieldsDefaulted=true` 表示模型缺了 `risk_level` / `user_authorization`，按 `outcome` 补齐默认值。
- `phase=tool` 记录每次只读工具调用（工具名、路径、字节数、耗时、是否命中拒止清单），不写文件内容。`audit.includePrompt` / `includeRaw` 打开时各写独立行，默认关闭。

查日志（按你的宿主部署：前台运行直接看终端，服务托管看服务管理器收集的 stderr 文件）：

```powershell
Select-String -Path <宿主 stderr 日志> -Pattern '\[approve-for-me\]'
```

## UI

三个挂点（另有会话「审查记录」页签，见「轨迹集成」一节），都在同一个 client 文件里（`client.js`）：

- **composer 下拉**（`conversation.input.left`）：两段式菜单——「跟随全局（清除本会话选择）」+ 模型段 + 档位段；触发器显示 `审查模型：<model> · <effort|跟随模型默认>`。写入走 `approveForMe/setSessionModel`，落到 `$DSH_HOME/approve-for-me/session-models.json`。**只在当前会话确实由插件接管时显示**（会话权限预设命中 `trigger.presets`），挂载期间每 3 s 复核一次，所以切换预设后最多 3 s 内出现/消失，不必刷新页面；会话尚未激活也能改（写入按会话 id 落盘，会话开始时生效）；写入失败时触发器上出现「切换失败」徽标，悬停可见宿主给的原因。
- **审批卡片内的状态条**（`conversation.approval.detail`）：在原生卡片 body 里显示「正在自动审批 / 自动审批超时 / 自动审批拒绝（含原因）」与自动拒绝倒计时。外壳与两个按钮仍是宿主的；插件自己把原生的关联命令渲染出来，所以非接管预设下的观感不变。
- **设置卡片**（侧栏「插件」面板 → 本包条目 → 打开**本包详情页**；槽位 `plugins.bundle.config`，行 id 即命名空间 `approve-for-me`）：表单**恒渲染**在详情页里（无折叠、无展开步骤），照官方设置表单的形态竖排全部字段（无分区标题、无卡片外壳，字段间以细横线分隔；接管预设＝多选下拉，选项来自宿主预设目录；按主模型映射＝行表，四列：主模型／审查模型／档位／操作，底部「添加一行」；数字字段复用官方组件）。枚举选项与开关带本地化标签，原值附在括号里；**生效值就在控件里**，被用户层覆盖的字段旁标「已覆盖」＋「恢复默认」文本按钮；每个字段带常驻灰色说明与一个 ⓘ 帮助按钮（点击内联展开长说明，再点收起）。两个毫秒字段（审查超时／人工超时）的说明下自带一行**秒数换算读数**——「生效」读数常驻、「草稿」读数随每次键入实时换算（空或非数字显示 `—`；换算只在显示层，存储单位仍是毫秒）。改动先进暂存——**只有点「保存」才写库**（无改动时「保存」置灰；「恢复默认」点击只暂存清除，重开页面即丢弃，保存后才落 `unset`）；保存失败保留暂存并显示失败文案，可重试；离开页面未保存的改动全部丢弃。

  数据通道：读写走官方 `configForms`（挂载槽位 `plugins.bundle.config`；行级 `plugins.row.config` 已弃用）。卡片上的改动热生效（volatile 字段经 `loader/volatile-update` 失效缓存，无需重启）。配置等价物也可直接写 profile patch 本行 `config:` 块。

  语言切换：`language.ui` 与 `language.agent` 两块独立——前者只改界面文案（`auto` 跟随宿主、强制档直查字典），后者只改送给模型与注入的文本；切一块不影响另一块（同一页面可分别核对照）。审计行与日志措辞不随任一开关变化。

- 设置卡片只在宿主把该命名空间列为「已服务」时渲染（官方机制 `configForms.whileServed`）；读不到时卡片根本不出现（即天然降级），配置仍可通过 profile patch 的 `config:` 生效。composer 的会话级下拉不依赖设置写入，非 loopback 页面仍可见。

## 轨迹集成：只做插件自有视图

「自动审批成为记录表里的一等记录」这件事，**核心功能在内置视图里，插件改不了**。本插件运行期因此**不修改宿主任何文件**（唯一例外＝停用/卸载防护对含本包贡献的默认预设覆盖行做贡献级清理，见「回滚」），轨迹集成只有自有视图这一条路：

| 功能 | 插件给到什么 |
|---|---|
| 提示词 / 送审输入 / 思维链 / 输出 | ✅ 会话「审查记录」页签：列表 + 详情（受 `ui.trace.capture` 约束） |
| 那次审批自己的耗时 | ✅ 数字正确（取自审计事件时间戳差） |
| 每轮耗时对照 | ✅ 自有视图里的 `工具总计 X = 执行 Y + 审批 Z` 等式 |
| 记录表里能看到这次审批 | ⚠️ 可选近似行（`ui.trace.legacyRow`）：标签「上下文」、位于工具行之后 |
| 记录表里的原生「审批」记录与它的位置 | ❌ 做不到，见下 |
| 时间线条里「工具」段只含净执行 | ❌ 做不到，见下 |

**已知局限（实测登记，不粉饰）**

- **原生记录不可达的根因是 `callId` 关联**：记录表在 `expandAssistant` 里把助手条目与工具行**一起**产出，用的是**块级 `callId`**；而审批携带的 `callId` 在**子调用（PTC）**情形下指向子工具行的 `sub.callId`，两者对不上。因此按 `callId` 就地插入审批行这一分支**从未命中**（实测行序 `工具 run_code → 子工具 pwsh → 审批 → 上下文`）。客户端快照里确实存在能匹配的数据（自有视图就靠它算等式），缺的是**在记录表组装自己的记录时做那一步关联**——那一步在仓库外无法可靠插入。
- **时长条拆不开**：记录表 UI 本来不渲染任何时长文本（实测扫描 39 个元素，时长正则零命中），`timeSeconds` 只反映在时间线条的段宽上，而段没有 `title` / `aria-label`。因此「工具段是否只含净执行」在记录表外既无法证实也无法证伪；相应验收判据落在**自有视图的等式**上，不是落在段宽上。
- **这一项只能在宿主内部实现**：缺的那一步（在记录表组装自己的记录时按块级 `callId` 关联审批）在仓库外无法可靠插入。本插件不为此保留任何探测或降级开关——宿主哪天把审批做成记录表里的一等记录，本插件是否接入届时重新评估。

## 测试与探针

```powershell
npm test                                           # 全部测试（含宿主接线；宿主不可解析时相关用例自动跳过）
npm run test:offline                               # 只跑离线单测，不注册宿主解析钩子
npm run check                                      # 语法自检：lib/** 全部模块 + client.js + typert.host.js
npm run probe:typert                               # 离线校验 ./typert 清单
npm run probe:llm                                  # 协议探针：两轮 tool_calls 往返（无凭据/断网时优雅跳过）
npm run probe:reviewer                             # 真实调用链：用真实模型跑一次完整审查循环（--model/--effort/--max-tokens）
npm run probe:budget                               # 输出预算：max_tokens × 档位 对正文/思考 token 的影响（见上文「输出预算」）
```

`npm test` 默认带 `--import ./tools/_host-hooks.mjs`：宿主接线用例需要解析 `@deepseek-ai/*`，解析不到时它们会**自我跳过**——**别把跳过当成通过**。锚点（宿主安装树）由 `tools/_host-resolve.mjs` 解析，取值与优先级见 `tools/local-config.mjs`：本机配置的 `hostModules`（环境变量 `DSAFM_HOST_MODULES` 可覆盖；配置形状见 `tools/local-config.example.mjs`）→ `$DSH_HOME/profiles/node_modules` → 全局安装树；都探不到时按文档化跳过。`test/host-tree.test.mjs` 常驻守卫锚点树与锁定版本一致，锚点指错版本即红（红＝测试失败）。沙箱拦 per-file 子进程时用等价的 `node --import ./tools/_host-hooks.mjs --test --experimental-test-isolation=none "test/*.test.mjs"`。

LLM 探针从 `$DSH_HOME/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY` 读取凭据，任何输出都不含密钥；凭据缺失或网络不可达时打印 `RESULT: SKIP — 未验证` 并以退出码 0 结束。

设置界面有一条**离线**回归：`test/fixtures/settings-dom-dump.txt` 是设置详情页的 DOM 与计算样式夹具，`test/settings-dom-dump.test.mjs` 拿它当常驻断言（结构回潮、取值与生效值脱钩、样式漂移都会先在这里红）。夹具是快照，宿主升级后需重新采集。

## 回滚

**新机制（0.3.0 起）下卸载零残留，一条命令**：

```powershell
dsh plugin --profile web remove dsh-approve-for-me
```

预设档随包自带的 bundle patch 走——卸载后层即消失，profile 的 `cordis.patch.yml` 全程未被写过、`dsh.profile.bundles` 与 `node_modules` 由宿主清干净；重启宿主，权限选择器回到基线三档。已实测演练（干净 profile 装卸一轮：patch 字节不变、组合层从四档回到三档、宿主装载无告警）。

两点补充：

1. **预设残留防护**：宿主设置界面改「默认预设」时会把当时生效的预设表（装着本包时＝四档）连同所选默认档写进 profile 层的 permission 覆盖行——**无论默认档选的是谁**。插件的卸载防护会在**交互宿主上移除/停用本包时**自动做贡献级清理：删掉覆盖行里的「自动审批」条目；若默认档正指着它（悬空）也一并删掉（否则卸载后整行装载失败、所有会话不可用）。清理后行去留看形态：没有仍有效的默认选择且行内只剩三标准档 → 整行删除＝恢复继承；你已把默认档切回标准档或行内有自定义条目 → 行保留、你的选择与自定义无损（等价于本包从未存在时设置写出的形态）。两条路径防护代码不可达，补救各一句：**服务实例先停机再 remove** → 停机后、remove 前先跑 `node <安装目录>/tools/permission-preset.mjs --restore-inherit`（包还在、命令可用；忘了跑的话，卸载前把默认预设切回任一标准档也能避免悬空，被拖入的条目则需按下一句处理）；**手删包目录 / kill -9**（CLI 已不可用）→ 手工删掉 profile `cordis.patch.yml` 里 `- id: permission` 覆盖行中的 `auto-approve:` 条目块（或整行，若默认档悬空），或重装本包后再跑上面的命令。
2. **旧机制残留**（0.2.0 及更早装的）：那时的 `--init-row` / `--apply` 往 profile 层写过 permission 行重述。升级到 0.3.0 后它仍在（用户层优先于包层），且会**遮蔽**包内四档——组合结果仍是旧的三档、下拉里见不到「自动审批」。`--revert` 只回收 `auto-approve` 条目、不删重述；要**回到纯 bundle 形态**（四档随包生效）用 `node <安装目录>/tools/permission-preset.mjs --restore-inherit`：删除 permission 覆盖行整行（含 `--init-row` 的注释块，模板往返零字节差；行内若有本脚本不认识的自定义键/取值会拒绝代删并提示手工处理；幂等）。脚本保留作存量清理通道，新部署不再需要。

插件自己的数据落在 `$DSH_HOME/approve-for-me/`（`session-models.json`、`reviews/*.jsonl`），卸载不会删它，按需手工清理；它们不属于部署方配置。

## 许可

MIT —— 版权行见 [`LICENSE`](LICENSE)。

本仓部分内容源自 [OpenAI Codex](https://github.com/openai/codex)（Apache-2.0）：英文 Guardian 系统提示模板、英文拒绝指令与租户策略文件为逐字取用，输出契约等少量固定句为同源改写——逐项清单与许可链接见 [`NOTICE`](NOTICE)。

## 更多文档

| 想知道 | 看 |
|---|---|
| 本插件**必须**做什么：不可裁剪条目与逐条可失败判据 | [`docs/requirements.md`](docs/requirements.md) |
| 它**怎么实现**、为什么这么定（含被否掉的方案与理由） | [`docs/design.md`](docs/design.md) |
| 版本变更 | [`CHANGELOG.md`](CHANGELOG.md) |
| 公开面的内容边界规则与开发/测试指南（不接受外部 PR） | [`CONTRIBUTING.md`](CONTRIBUTING.md) |

本仓以 `v0.2.0` 为首个公开发布版本。开发期的逐轮审查报告、验证证据与本机部署配置不随仓发布；上面这几份是仅有的对外文档，且各自自包含——所依赖的事实都写在文档内部（外部依据给到上游包的 `文件:行号` 或公开 URL），不需要读者去别处找。
