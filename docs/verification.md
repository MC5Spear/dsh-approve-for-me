# 验证说明

本文说明怎样运行源码检查与诊断工具。先按风险选择方法，再准备目标与授权。产品应满足的结果见[需求第 9 章](<requirements.md#9-验收标准>)；机制依据见[设计](<design.md>)。

以下工具路径均相对完整源码根目录。安装包带有本文，但没有带齐 `tools/`、`test/` 和 CI 文件。请从与安装件匹配的源码取得这些目录，再在源码根目录运行。源码准备见[参与指南](<../CONTRIBUTING.md>)。

## 1. 先选择风险最小的方法

| 类别 | 读取与写入 | 网络、凭据和授权 |
| --- | --- | --- |
| 静态检查与模块测试 | 读源码；测试可创建临时文件、链接、工作者或子进程。两条整套测试命令还包含下面的浏览器布局测试。 | 不调用模型、不连接运行中的 DSH。依赖安装另需包源网络权限。 |
| 测试套件内的浏览器布局测量 | `npm test` 和 `npm run test:offline` 均可能自动启动无头 Edge，写临时 HTML/profile，打开本机 CDP 调试端口。 | 运行整套测试前须允许启动专用浏览器和本机端口通信。它测静态夹具，不是实际 DSH 页面或视觉验收。 |
| 实际包检查 | 读源码，创建 tgz、解包目录；结束后清理自身临时目录。npm 还可能写缓存和日志。 | 不安装插件、不启动宿主或模型、不发布。 |
| 宿主包接线 | 在当前进程导入匹配宿主包，测试使用替身。 | 不等于连接运行中的 DSH；补装宿主包需访问包源。 |
| 日志与记录诊断 | 读指定 home、会话正文、工具参数和结果；部分工具另写明文报告。 | 先取得这些数据的读取授权；输出可能含私密内容。 |
| 实例 RPC 查询 | 读启动 token，与目标实例交换认证 cookie，查询状态与目录。 | 需要明确的实例查询和凭据读取授权。 |
| 浏览器交互 | 启动或附加浏览器，读页面、截图、写本机产物；步骤可保存设置、发消息或执行页面表达式。 | 需要对整个步骤脚本授权；发消息可能启动模型或工具。 |
| 真实模型探针 | 读指定 home 的模型凭据；发送提示和可能的本地取证内容。 | 会联网，可能计费。先确认账户、端点、模型和数据范围。 |
| 存储写入探针 | 向 reviews 写记录，可能轮转或淘汰正常记录。 | 只对隔离 home 的复制数据运行，不对原数据试写。 |

不要把“工具名含 probe”“只读”或“退出码为 0”当作安全与通过结论。先读本页对应分类和工具参数；遇到未获准的目标、读取或写入就停止。

## 2. 准备环境并确认目标

### 2.1 Node.js 与依赖

推荐使用 Node.js 24。包声明的运行下界是 Node.js 20，但浏览器工具使用全局 `WebSocket`，日志工具使用 `node:zlib` 的 Zstandard 接口；旧 Node 版本不一定具有这些接口。CI 配置覆盖 Node.js 22 与 24，执行结果需另看本次日志。

在已核对身份的源码中先运行：

```powershell
node --version
npm ci --omit=dev --no-audit --no-fund
```

依赖安装需要联网，会写依赖目录和 npm 缓存。不要在待保护的部署目录中准备开发依赖。

实际包检查还需要 PATH 中可调用的 `tar`。缺少 npm 或 tar，或沙箱阻止启动时，记录为未执行；命令实际执行后失败，记录为失败。

### 2.2 本机配置

源码中的 `tools/local-config.example.mjs` 说明配置形状，`tools/local-config.mjs` 负责加载。可通过环境变量提供 `DSAFM_HOST_MODULES`、`DSAFM_BROWSER_PATH`、`DSAFM_OUTPUT_DIR` 等值，或在被忽略的 `.local/config.mjs` 中声明。该配置是可执行 JavaScript；只使用自己信任的配置文件，不加载别人交来的未知文件。

一般字段按环境变量、配置文件、缺失顺序解析。实例目标另有优先顺序：

1. 工具显式 URL/token 参数或调用方显式实例名优先。显式指名只认该名，找不到不回落默认。
2. 未指名时，先取具名默认实例。`DSAFM_INSTANCE` 优先于配置文件的 `defaultInstance`。
3. 只有具名默认不存在时，才用匿名 `DSAFM_INSTANCE_URL` 与 `DSAFM_TOKEN_FILE`。

**只设置匿名 URL 不会覆盖已声明的具名默认。** 切换目标时，使用明确的工具参数，或选定正确的具名实例。按名覆盖变量为 `DSAFM_<实例名大写>_URL` 和 `DSAFM_<实例名大写>_TOKEN_FILE`；名称中的连续非字母数字字符归为一个下划线。具名环境变量只覆盖配置文件里已声明的实例，不能单独创建新名字。

显式 `--url` 和 `--token-file` 各自覆盖对应字段。不要只覆盖 URL 却意外沿用另一实例的 token。连接前核对打印的 URL 与 token 文件名；两者不是预期配对就停止。输出目标标识不是交互式确认，脚本打印后会继续，不能靠事后看日志阻止误连。

### 2.3 home 与隔离

`DSH_HOME` 与上述实例 URL 是不同配置。日志和凭据工具通常取 `DSH_HOME`，未设置时回落到 `~/.dsh`。改变 URL 不会改变日志、凭据或存储目标。

运行前明确设置本次授权的 home。使用复制数据时，选择新建的独立目录，核实其中没有指回原 home 的符号链接、联结点或共享记录目录。数据与测试安装都应属于该隔离环境。

真实宿主验证只在获准的自建实例中执行。使用独立 home、profile、端口、工作区和输出目录，不连接正在工作的实例，不改宿主源码。重启会中断任务；先等任务结束或安全停止，再从被重启服务的进程树之外操作。

## 3. 静态、模块与包检查

**整套测试可能自动启动浏览器。** `npm test` 与 `npm run test:offline` 都会枚举 `test/map-layout.test.mjs`。先确认允许启动专用 Edge、写临时目录及进行本机 CDP 通信，再运行这两条命令。具体前提和清理见本节“测试套件中的隔离浏览器布局测量”。不允许这些操作时，不运行整套命令；只执行获准的指定用例，并把未执行范围列出。

```powershell
npm run check
npm run check:public-surface
npm run check:docs
npm run probe:typert
npm run test:offline
npm test
npm run check:docs:pack
```

| 命令 | 证明范围与结果 |
| --- | --- |
| `check` | 对 `lib/` 内 JS/MJS、`client.js`、`typert.host.js` 逐个执行 `node --check`。会派生检查进程；语法正确不证明行为正确。 |
| `check:public-surface` | 只读检查公开内容结构、本机指纹和内部引用。优先枚举 Git 跟踪文件，Git 不可用时遍历回退；以日志打印的枚举范围解释结果。未暂存新文件不一定进入 Git 枚举。 |
| `check:docs` | 只读检查当前源码的配置、版本、文件与片段链接。不联网、不写文件；它不能证明说明易懂或安装地址可取。 |
| `probe:typert` | 在当前进程导入协议声明，检查清单、codec 和 invocation 形状。通过时打印 `PASS`；失败退出非零。不连接实例，不证明真实加载。 |
| `test:offline` | 不注册宿主解析钩子，仍枚举 `test/*.test.mjs`，包括可能自动启动 Edge 的布局用例。部分用例按缺包跳过；宿主版本守卫等用例直接解析包，缺包可失败。不能保证空宿主环境下全套通过。 |
| `test` | 注册宿主解析钩子后枚举同一组测试，也包括浏览器布局用例。使用宿主包、替身和静态布局夹具，不是全功能真实宿主或视觉验收。 |
| `check:docs:pack` | 等价于 `node tools/check-docs.mjs --pack`。真实运行 `npm pack --ignore-scripts`，在唯一临时目录解包并检查，结束后只清自身产物。npm 可能另写缓存和日志；不发布包。 |

已解包产物也可只读检查：

```powershell
node tools/check-docs.mjs --package "<已解包的package目录>"
```

替换占位路径后运行。该方式会与当前源码基准核对元数据、应有文件和包内链接，不改解包目录。`--pack` 与 `--package` 互斥。工具缺失、沙箱拒绝或命令未启动时，记录为未执行，不记通过。

测试可能创建真文件、链接、工作者和子进程。只允许在自有测试目录中运行，结束后检查清理情况。沙箱拒绝子进程时，先保留具体错误。可使用同进程隔离方式重跑；它改变测试运行形态，报告中写明：

```powershell
node --import ./tools/_host-hooks.mjs --test --experimental-test-isolation=none "test/*.test.mjs"
```

### 测试套件中的隔离浏览器布局测量

`test/map-layout.test.mjs` 从 `client.js` 取得样式，生成本地静态 HTML 夹具，在无头 Edge 中测量控件矩形和滚动范围。它不连接运行中的 DSH、不调用模型，也不证明真实宿主交互或视觉效果。

这项用例有独立的浏览器选择方式，不读取 `DSAFM_BROWSER_PATH`。它按顺序检查 Windows 常见安装位置：

```text
C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe
C:/Program Files/Microsoft/Edge/Application/msedge.exe
```

运行时必须有全局 `WebSocket`，并允许创建浏览器子进程、本机 HTTP/WebSocket 连接和调试端口。没有全局 `WebSocket`，或两个位置都找不到 Edge 时，该项明确跳过。已经找到 Edge 后，启动、CDP 连接或测量失败均算失败，不作为缺环境跳过。跳过不表示布局已通过。

用例在系统临时目录写 `dsafm-map-layout-<宽度>-<进程号>.html`，并创建 `dsafm-map-layout-profile-<宽度>-<进程号>` 专用 profile。收尾尝试结束浏览器根进程，再删除这两个本次路径；文件占用、异常或中断可能留下子进程和目录。结束后核对本次进程号、专用 profile 和临时文件，只清理能确认为本次创建的资源。不要按浏览器名称批量结束他人进程。

### 3.1 准备宿主解析树

完整宿主接线测试需要以下包可解析：

- `@deepseek-ai/dsh-llm@0.2.1-rc.2`
- `@deepseek-ai/dsh-typert-protocol@0.2.1-rc.2`
- `@deepseek-ai/cordis` 满足 `~4.0.4`
- `@deepseek-ai/schemastery` 满足 `^3.18.4`
- `@deepseek-ai/dsh-client-ui-primitives@0.2.1-rc.2`
- `@deepseek-ai/dsh-session-format-v3-to-v4@0.2.1-rc.2`

后两包是测试额外读取的宿主制品，不在本插件依赖图内。还需可解析的 zod。CI 当前补装 cordis `4.0.5`、schemastery `3.18.5`。

可以指向已有匹配安装树，也可在独立目录安装：

```powershell
npm install --prefix "<独立依赖目录>" --no-save --no-package-lock --no-audit --no-fund @deepseek-ai/cordis@4.0.5 @deepseek-ai/dsh-llm@0.2.1-rc.2 @deepseek-ai/dsh-typert-protocol@0.2.1-rc.2 @deepseek-ai/schemastery@3.18.5 @deepseek-ai/dsh-client-ui-primitives@0.2.1-rc.2 @deepseek-ai/dsh-session-format-v3-to-v4@0.2.1-rc.2 zod@4.4.3
$env:DSAFM_HOST_MODULES = "<独立依赖目录>\node_modules"
```

此步骤联网并写目标目录。完成后不要把独立依赖目录提交。解析钩子按本机 `hostModules`、`<DSH_HOME>/profiles/node_modules`、Windows npm 全局 DSH 依赖树尝试候选。候选须能读取 zod 和带 `.volatile()` 的 schemastery；没有可用候选时交回 Node 默认解析。目录存在不代表它会被选中。

宿主版本守卫核对两个精确宿主包的实际版本及同树来源。缺包、错版和混树都要处理。部分缺包跳过不能代替守卫，也不能用不相干宿主树的通过结果证明当前适配线。

`tools/probe-tool-visibility.mjs` 还需 `@deepseek-ai/dsh-scope` 与 `@deepseek-ai/dsh-tools`。它在离线进程中建立上下文和临时工具注册，打印可见性读数，不操作运行中的实例；结束时释放注册和作用域。其读数不是当前部署工具目录的完整证明。

## 4. 日志与记录诊断

**读取前先取得会话内容授权。** 这些工具虽不修改源日志，仍会解压和读取用户消息、助手消息、工具参数及结果。输出通常没有完整脱敏，截图、命令行、终端日志和报告都可能泄露内容。不要把原始输出直接贴到 issue。

多数 home 诊断工具不接收实例 URL，取 `DSH_HOME` 或默认 home。先设置隔离复制数据的路径，再运行所需工具：

```powershell
$env:DSH_HOME = "<获准读取的隔离home>"
node tools/probe-sessions.mjs --events approval
node tools/probe-review-coverage.mjs
node tools/probe-approval-coverage.mjs
```

### 4.1 选择哪个工具

| 源码路径 | 输入、行为与边界 |
| --- | --- |
| `tools/probe-sessions.mjs` | `<检索词> [每会话行数]` 打印命中样本；`--events [类型过滤]` 统计事件并附样本。打印 home，每会话取数值最高代日志。 |
| `tools/probe-review-coverage.mjs` | 读取会话日志和 reviews 行数。`MISSING` 是调查线索，不是自动验证结论；有缺口仍可能退出 0。 |
| `tools/probe-approval-coverage.mjs` | 同样核对覆盖，可加 `--trace-epoch <ISO8601>`。起点必须有该部署的证据；未给起点不豁免早期空记录。缺口仍可能退出 0。 |
| `tools/probe-r28-zh-inject.mjs` | `<包含会话目录的路径> <sessionId>`，读取该目录各代日志，按消息 id 去重，打印注入首行、语言标记与字节数。不是每会话只取最高代，也不把消息数当审批数。 |
| `tools/probe-stderr-shapes.mjs` | 从最高代日志统计特定工具的 stderr 首行形态。工具名单是近似分类，不是权限依据。 |
| `tools/probe-session-records.mjs` | `<sessionId> [...]`，从指定 home 的 `profiles/web/node_modules/dsh-approve-for-me/lib/trace-store.js` 导入已部署存储，比较原始行与 `list()`；读取部署代码和记录。 |
| `tools/probe-find-session.mjs` | `<会话名片段> [...]`，按目录名找 reviews，打印记录摘要。 |
| `tools/probe-search-sessions.mjs` | `<片段> [--context N]`，打印正文附近样本。取枚举到的首个匹配日志，不保证最高代。 |
| `tools/probe-call-detail.mjs` | `<sessionId> <callId>`，打印调用、审批、结果和权限事件。多代时取最后枚举项，不保证数值最高代。 |
| `tools/probe-approved-but-denied.mjs` | 按 callId 找审批请求与拒绝文字样本。出现过请求不等于曾批准；拒绝文字只是诊断线索。 |
| `tools/probe-denied-without-approval.mjs` | 查所选日志中同 callId 未见审批请求的拒绝。结构化标记与疑似文本分开；不能据此认定工具没有升权路径。 |
| `tools/probe-denial-signals.mjs` | 统计错误候选信号，静态工具名单不能代替当时宿主 schema。 |
| `tools/probe-exec-denied.mjs` | `[--max N]`，打印进程创建被拒的命令及结果样本；权限状态是会话末值，不是失败时刻值。 |
| `tools/probe-exec-denied-timeline.mjs` | `[--max N]`，按事件顺序取失败时刻的权限状态，仍须核对日志完整性。 |
| `tools/e2e-decode.mjs`、`tools/e2e-tools.mjs` | 传具体日志文件最可靠；传目录时按文件名字典序选最后项，不保证数值最高代。前者打印身份和事件概览，后者打印工具详情。 |

上述 `probe-approved-but-denied`、`probe-denied-without-approval`、`probe-denial-signals` 和两个 `probe-exec-denied` 工具取枚举首个匹配日志，也不保证最高代。不要用这些统计代替当前代完整审计。没有命中可能是取样、代数、截断、解析或读取失败，不自动表示问题不存在。

共用读取器 `tools/session-log.mjs` 支持 `session.jsonl.zstd` 和 `session.vN.jsonl.zstd`。共用的当前代枚举按数值取最高代，事件解析支持直接事件、`event` 信封和一行多事件数组；旧诊断脚本不一定调用这两项共用功能。

### 4.2 会写明文报告的日志工具

- `tools/diag-zstd.mjs <源日志> <输出文件>` 会将解压明文写到指定位置，并打印样本。它使用按魔数切帧的诊断算法，不等于共用容器读取器的完整验证。检查失败帧读数，不能只看生成了文件。
- `tools/probe-r33-zh-bytes.mjs <源日志> <审计injectBytes> [输出文件]` 会打印并保存中文允许通知、命令和理由。显式输出路径优先，其次是配置输出目录，最后是当前目录。`injectBytes<=0` 时跳过字节对账；即使其他断言通过，也没有验证这一项。
- `tools/build-dom-dump.mjs <result.json> <css结果或-> <输出文件> ...` 读浏览器步骤结果并写文本证据。它依赖特定步骤索引和数据结构，不是任意 JSON 都能生成有效证据。生成动作本身不能证明新页面已测过。

运行前选择安全的新文件名，避免覆盖已有报告。不要把明文写入公开源码。分享前人工脱敏；完成调查后，只清理本次生成的报告，不删源日志或他人材料。

## 5. 实例 RPC 查询

`tools/probe-rpc.mjs` 用启动 token 换 cookie，读取模型目录、会话状态、权限预设、待审批状态及推理强度。它不调用保存或发送消息端点，不改插件配置；认证仍会与实例交互。

```powershell
node tools/probe-rpc.mjs --url "<自建实例URL>" --token-file "<该实例启动token文件>" --session "<测试会话id>"
```

不提供 `--session` 时按空会话上下文查询，不等于某个活会话已经验证。token 文件须含 `token=` 行。输出还会打印目录、状态和 token 文件路径，分享前删除机器与账户信息。

RPC 正常只说明这些端点在该目标可读，不能证明页面、设置写入、审批执行或模型安全正确。

## 6. 浏览器交互与视觉核对

`tools/browser-shot.mjs` 使用本机 Edge/Chromium 和 CDP，不下载浏览器。配置浏览器路径和输出目录后，可运行：

```powershell
node tools/browser-shot.mjs --url "<自建实例URL>" --token-file "<对应token文件>" --out "<本次独立输出目录>" --dump
```

`--dump` 读取当前页面文本与可点击元素，也可能显示私密会话内容。完整页面和 DOM 导出需要同等隐私授权。

执行 `--script <步骤JSON>` 前，完整阅读步骤：

- `click` 使用字符串文本，`clickSelector` 按选择器点击。它们可能点到保存、删除或其他写入按钮。
- `send` 填入输入框；`enter`、`clickSend` 可能真正发送，触发模型、计费和工具执行。
- `eval` 执行页面 JavaScript，可以写配置和存储，不是只读表达式限制。
- `shot`、`shotClip`、`html`、`--result` 写本机文件。HTML 与文本可能包含正文、地址和配置。

默认视口为 1280×1600，设备缩放取 2；这些是工具设置，不代表实际显示器。默认总预算为 150000 毫秒，可用 `--budget` 调整。单步失败会记录后继续，最后可能打印 `RESULT: PARTIAL`，而进程仍退出 0。逐步检查结果，不因文件生成或退出码 0 宣称通过。

### 浏览器清理风险

启动模式创建专用临时 profile。工具尝试关闭浏览器并删除该目录；`--keep` 保留 profile。崩溃、看护超时或进程占用可能留下目录或子进程，结束后要核查，只清理本次自有资源。

`--cdp <端口>` 附加模式也会在收尾发送 `Browser.close`，会关闭所附浏览器及其页面。只附加本次专用浏览器，不能连用户日常浏览器或共享 CDP。不要按浏览器进程名批量结束他人进程。

`tools/probe-composer-dom.mjs [url] [token-file]` 会启动专用浏览器、点击会话和轨迹页签、读取 DOM 并截图。`PROBE_SESSION` 按标题片段选择，未命中会退到首项，不是精确会话 ID。仅在装有自有测试会话的隔离实例中运行。`PROBE_SHOT` 可指定截图位置；否则取配置输出目录或 `shots`。同样核查自有进程和 profile 是否清理。

### 怎样证明界面可用

在真实目标宿主中检查，不用旧截图或静态 DOM 夹具替代：

1. 确认包详情页、设置表单、会话模型控件、审批卡片和记录视图真实加载。
2. 在中英两语、浅深两主题检查名称、常驻风险、帮助入口、保存与失败处理。
3. 实际执行暂存、不保存离开、单字段恢复、保存和重开回读；确认下一请求使用新值，在途请求保持旧快照。
4. 用计算样式和矩形核对点击区、对比度、宽度与遮挡，再由具备视觉判断能力的人或代理读取当前原图。
5. 说明按钮至少 24×24 CSS 像素，对比度至少 4.5:1；鼠标、Enter 和空格均可开合，且不改草稿和常驻提醒。
6. 模型映射表核对两种作用范围、列表与自定义输入往返、完整模型 id、焦点、保存和目录缺项值。窄视口及窄容器分别检查。
7. 审批状态和记录核对真实结果、缺段原因及模型结论与最终结果的角色标签。保存失败、模型故障、队列、超时与取消分别验证。

具体布局机制及已知限制见[设计](<design.md>)，验收结果仍以需求为准。页签随插件或宿主语言均按当前批准范围判断，不以某一采集脚本的旧文案要求扩张产品合同。

## 7. 真实模型探针

这些探针会读取 `$DSH_HOME/.credentials.yaml`。未设置 home 时取 `~/.dsh`。凭据读取器只支持 `refs` 下的简单 `KEY: value`，不代表支持完整 YAML 语法。不要打印密钥，也不要把凭据文件复制进源码。

设置自定义端点前核对所有者。`DEEPSEEK_BASE_URL` 或 `ZAI_BASE_URL` 的值决定密钥和提示发送到哪里。使用自己获准的账户、明确模型和费用预算，不因脚本默认值就推定获得授权。

| 命令或源码路径 | 读取与实际证明范围 |
| --- | --- |
| `npm run probe:llm` | 读取 `refs.DEEPSEEK_API_KEY`，默认请求 DeepSeek 兼容端点。`DSAFM_PROBE_MODEL` 可选模型。用合成工具结果验证两轮 tool_calls 往返，不真的读该工具声称检查的文件。最终只检查非空正文，`outcome=no` 也可 PASS；不是严格审查结论验证。 |
| `npm run probe:reviewer` | 同一 DeepSeek 凭据，运行本地审查循环及只读取证封装。支持 `--model`、`--effort`、`--max-tokens`、`--max-tool-steps`。工具以当前工作目录为相对路径基准，但允许受限制的工作区外读取；使用隔离文件环境，避免模型读取并外送无关文件。有效 allow 或 deny 均可 PASS，不证明判断安全，也不是宿主审批端到端验证。 |
| `npm run probe:budget` | 同一 DeepSeek 凭据，按 `--model`、`--max` 与 `--effort` 遍历预算组合。默认 3 个预算×2 个强度，会多次调用。至少一组有响应就可 PASS，须逐组检查失败和正文情况。 |
| `tools/probe-zai-reviewer.mjs` | 读取 `refs.ZAI_API_KEY`，默认 zai 端点；`PROBE_MODEL`、`PROBE_EFFORT` 可覆盖。仅统计文本和工具调用增量，不执行返回的工具。PASS 表示有内容，不表示 JSON 合法或安全判断通过。 |

DeepSeek 探针默认端点为 `https://api.deepseek.com`，zai 为 `https://api.z.ai/api/paas/v4`。默认模型候选与诊断档位由各脚本定义，不能当作插件默认配置或当前可用模型保证。

无凭据的 `probe:llm`、`probe:reviewer` 和 zai 探针可打印 SKIP 并退出 0；预算探针无凭据或全失败退出 2。`probe:llm` 网络不可达也可 SKIP。模型故障、认证被拒与格式失败按具体输出记录，不把跳过说成通过。

## 8. 存储写入探针：只能用隔离复制数据

`tools/probe-store-write.mjs` 从指定 home 的 `profiles/web/node_modules/dsh-approve-for-me/lib/trace-store.js` 导入存储实现，向该 home 的 `approve-for-me/reviews` 写 `probe-store-write.jsonl`。它不是无副作用健康检查。

创建新会话文件可能触发正常会话文件淘汰。若已有同名文件，追加和轮转可能改变它；最后脚本会删除整个同名探针文件。删除该文件不能恢复已经淘汰的其他记录，也不能证明原数据未受影响。中途异常还可能跳过末尾删除。

运行前：

1. 取得复制、读取和修改测试数据的授权。原数据先备份，且不作为运行目标。
2. 新建独立 home，只放入获准的复制数据与匹配版本的测试安装。确认路径没有链接回原目录。
3. 确保复制目录中不存在需要保留的 `probe-store-write.jsonl`。检查预期 reviews 目录存在，并记录副本操作前文件清单。
4. 停止使用这个隔离记录目录的其他写者。一个记录目录不支持多进程并发写入。
5. 明确设置 `DSH_HOME`，再运行：

   ```powershell
   $env:DSH_HOME = "<本次隔离home>"
   node tools/probe-store-write.mjs
   ```

检查 `record()`、文件、行数和 `list()` 读数，并比较复制数据前后清单。工具没有完整自动 PASS 判据。它只调查该部署存储能否写读，不证明审批或长期容量完整通过。结束后仅删除本次隔离副本和产物；不把写过的复制记录覆盖回原 home。

## 9. 真实宿主验收与交接

以同一候选身份运行验收，记录 DSH 版本、插件完整版本、源码提交或快照标识、包校验信息、方法和配置。静态、模块、宿主包接线、真实宿主、模型、视觉与发布结论分开写。

真实宿主至少验证：自动允许后工具实际执行、安全拒绝、需要的人工与超时路径、设置保存后下一请求生效、委派子代理接管。危险操作只用无害替身，验证模型安全时也不得执行危险候选。

安装、停用和卸载通过宿主正式通道完成。使用隔离配置副本，分开检查没有用户设置写入与已有用户设置持久化两种情况。核对三个标准权限档、插件预设、配置保全、卸载后冷启动，以及[用户参考](<user-reference.md>)中的备份、残留与恢复步骤。安装时两枚宿主 peer 不应在 profile 中另落实体；暖包缓存、长 profile 路径和同 home 二次装卸仍需按设计验证，不能从 peer 声明推断已经通过。

结束时：

- 逐项报告通过、失败、跳过、未执行及原因。保留完整计数与非零退出码，不仅摘录最后一行。
- 对照需求列未验证项，不把文档写完、工具返回或旧证据当成当前通过。
- 将必要证据脱敏后交给审查者。原始会话和凭据不进公开提交。
- 关闭本次自建实例和专用浏览器，检查自有子进程、profile、临时目录与报告。清理只限本次资源。
- 未获发布授权时，不推送、不创建或移动标签、不创建 Release、不发布包。目标标签和本地安装成功不等于已发布。
