# 参与指南

**接受 issue，不接受外部 PR。** 本仓个人维护、按精力更新——issue 欢迎报问题、提场景与想法，但不保证响应与修复时间。想改代码请 fork 后在自己的分支上维护，本仓不合并外部改动。下面的运行与验证信息供 fork 维护者和想复现问题的人使用。

## 报 issue

- 给出最小可复现信息：宿主版本、本插件版本（或提交）、权限预设与相关配置片段——**先抹掉凭据与本机路径**。
- 审计行（`[approve-for-me]` 写宿主 stderr 的单行）是最有用的证据，贴涉事那几行即可，`decision` / `reason` 字段足以定位大多数行为问题。
- 安全相关的发现同样按普通 issue 提（本仓不设漏洞管理流程）；不要贴真实凭据、真实会话内容或他人部署的地址。
- 不承诺修复时间；提之前可先对照 `docs/design.md` §13.14 的已知遗留缺陷，避免重复。

## 环境准备（fork / 复现用）

- Node.js（本仓在 Node 24 上开发；`node:test` + ESM，无构建步骤）
- 一份可用的 DeepSeek Harness 部署（跑真实审查调用链时才需要）
- 克隆后：

```powershell
git clone https://github.com/MC5Spear/dsh-approve-for-me.git
cd dsh-approve-for-me
npm install --omit=dev
```

**宿主解析锚点**：宿主接线用例需要解析 `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-typert-protocol`、`@deepseek-ai/cordis` 等同版包（本包按 peer 钉版）。两种给法：

1. 在克隆目录里显式装同版宿主包（CI 走这条）：
   `npm install --no-save @deepseek-ai/cordis@4.0.4 @deepseek-ai/dsh-llm@0.2.0-rc.2 @deepseek-ai/dsh-typert-protocol@0.2.0-rc.2 @deepseek-ai/schemastery@3.18.4`
2. 指向一份已存在的宿主安装树：环境变量 `DSAFM_HOST_MODULES=<宿主安装目录>\node_modules`（取值顺序与配置文件形状见 `tools/local-config.mjs` 与 `tools/local-config.example.mjs`）。

两条都不可用时，宿主接线用例会**自我跳过**——`npm run test:offline` 则是完全不注册宿主钩子的形态。

## 测试与探针

```powershell
npm test                    # 全部用例（含宿主接线；宿主不可解析时相关用例自跳过）
npm run test:offline        # 只跑离线单测
npm run check               # 语法自检：lib/** + client.js + typert.host.js
npm run probe:typert        # 离线校验 ./typert 清单
```

- **跳过不等于通过**：看到 `# skip` 先确认是环境缺失还是真的没跑。
- 沙箱环境拦 per-file 子进程时，用等价形态：
  `node --import ./tools/_host-hooks.mjs --test --experimental-test-isolation=none "test/*.test.mjs"`

| 探针 | 需要什么 |
| --- | --- |
| `npm run probe:typert` | 离线（校验 `./typert` 清单与实现一致） |
| `npm run probe:llm`（`tools/probe-llm-tools.mjs`） | 离线（无凭据/断网时优雅跳过，打印 `RESULT: SKIP — 未验证`） |
| `npm run probe:reviewer`（`tools/probe-reviewer-live.mjs`） | 需要真实 LLM 凭据（从 `$DSH_HOME/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY` 读，输出不含密钥） |

涉及真实实例的端到端验证请在你**自己的实例**上跑。那类取证工具（`tools/browser-shot.mjs` 浏览器驱动、`tools/probe-rpc.mjs` 实例 RPC 探针、`tools/probe-composer-dom.mjs` 页面结构探针等）**随本仓发布**：接入坐标（实例地址、token 文件、浏览器路径、输出目录）一律经 `tools/local-config.mjs` 给定或显式传参，脚本不含机器事实，可在你自己的实例上排障取证；**运行产物**（截图、DOM 转储、步骤场景）落在本机配置的输出目录，不进提交。

## 本仓自身约定（fork 维护者参考）

**内容边界**——本仓把「公开面」与「本机平面」分得很清，动这份代码前先想归属：

- **① git 跟踪面只含**：产品代码、测试与工具、对外文档（README / CHANGELOG / CONTRIBUTING）、需求稿（`docs/requirements.md`）、设计稿（`docs/design.md`）。其余一切——事实登记簿、过程稿、验证证据、本机部署脚本与本机配置、一次性工作区——一律放在仓库根的 `.local/` 下（**不被 git 跟踪**），不得提交。
- **② 需求稿与设计稿自包含**：所依赖的事实直接写在文档内部。**允许引用**公开仓内的文件、上游公开包的源码（`文件:行号`）、公开 URL；**禁止引用**任何未随仓公开的内容——内部事实/问题编号、内部过程稿文件名、历史运行产物、本机路径与实例。
- **③ 脚本里不写机器事实**：宿主安装树锚点、实例 URL、token 文件、浏览器路径、输出目录等一律经 `tools/local-config.mjs` 读取（本机配置放 `.local/config.mjs`，形状见 `tools/local-config.example.mjs`），或用对应环境变量临时覆盖。源码里出现 `.local/` 字面（配置加载器与其示例除外）同样算违规。

判据是一条命令，它同时跑在 CI 里：

```powershell
npm run check:public-surface     # 结构 / 本机指纹 / 内部引用，三类判据零命中即绿
```

**改动纪律**：影响判决路径的改动必须带可失败判据（把实现改回错误形态、对应断言必须红，再还原复绿）；安全语义（判决路径、fail-open 可能、凭据/路径处理）的事实记载在 README「先读这一节」与 `docs/design.md` §13.14，改动时两处跟着更新；真实凭据、真实会话内容与本机路径不进提交，测试夹具用假值（如 `sk-abc12345`）。

**代码约定**：

- **不新增运行时依赖**：运行时依赖只有 `zod`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-typert-protocol`（peer：`@deepseek-ai/cordis`）。
- **不修改宿主文件、不打源码补丁**——这是本项目的立场。
- `client.js` 是宿主加载器用的工厂式 CJS（`window.__ModuleLoader__.load({ id, factory })`，`factory(require)`，`require('react')` 由加载器提供），**没有 JSX、没有构建步骤**；改它时保持这个形态。
- 新增配置字段：在 `lib/config.js` 的 `Config` 里声明，需要热改就加 `.volatile()`（`@deepseek-ai/schemastery` ≥ 3.18.4），界面文案进 `lib/agent-texts.js` 的中英字典（缺键即抛错，不静默回退），并在 `test/config.test.mjs` / `test/agent-texts.test.mjs` 补用例。
- 面向模型的文案（系统提示、注入文本）改动请**逐字节**核对是否影响既有判据：本仓有冻结断言守着不可变块。
- 中文文档与注释保持本仓既有术语；改行为时同步更新 README 里对应的用户可见说明。
- **注释里的编号（`R##` / `F##` / `ISS-##` / `§x.y`）来自开发期的设计与事实账本，那份账本不随本仓发布**——它们是可追溯性标记，读代码时无视即可；新增注释不必沿用这套编号。

**运行真机的经验**（不是硬性要求）：

- **别重启正在工作的实例**。宿主服务默认会清理整棵进程树：从服务自身进程树内发起的重启会把自己一起杀掉、服务停在停止态。重启命令要在服务进程树之外执行。
- 建议备两个 profile（或两个实例）：一个跑日常开发与探针，一个做端到端验证。插件 host 半边改动要重启宿主才装载，client 半边随页面加载生效——两条调用链分开验，省得互相干扰。
- 端到端结论（「真的自动放行了」）必须来自真机实测 + 审计行，不能由单测代替；单测证明的是分支正确性，不是宿主接线正确性。
