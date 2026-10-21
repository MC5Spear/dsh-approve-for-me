# 参与指南

**接受 issue，不接受外部 PR。** 本仓个人维护、按精力更新——issue 欢迎报问题、描述使用场景与提出想法，但不保证响应与修复时间。想改代码请 fork 后在自己的分支上维护，本仓不合并外部改动。下面的运行与验证信息供 fork 维护者和想复现问题的人使用。

## 报 issue

- 给出最小可复现信息：宿主版本、本插件版本（或提交）、权限预设与相关配置片段——**先抹掉凭据与本机路径**。
- 审计行（`[approve-for-me]` 写宿主 stderr 的单行）是最有用的证据，贴涉事那几行即可，`decision` / `reason` 字段足以定位大多数行为问题。
- 安全相关的发现同样按普通 issue 提（本仓不设漏洞管理流程）；不要贴真实凭据、真实会话内容或他人部署的地址。
- 不承诺修复时间；提之前可先核对[使用说明](<README.md>)中的已知边界，以及[设计的当前实施与验证待办](<docs/design.md#11-当前实施与验证待办>)，避免把尚未完成的目标当成已交付行为。

## 环境准备（fork / 复现用）

- Node.js（本仓在 Node 24 上开发；`node:test` + ESM，无构建步骤）
- 一份可用的 DeepSeek Harness 部署（跑真实审查调用链时才需要）
- 克隆后：

```powershell
git clone https://github.com/MC5Spear/dsh-approve-for-me.git
cd dsh-approve-for-me
npm install --omit=dev
```

**宿主解析锚点**：宿主接线用例需要解析六份同版包——`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-typert-protocol`、`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`，加上套件实际 import 的 `@deepseek-ai/dsh-client-ui-primitives` 与 `@deepseek-ai/dsh-session-format-v3-to-v4`（后两包不在本包依赖图内；六包齐备时 `test/client-primitives.test.mjs` 与 `test/v4-source.test.mjs` 才不按「不可解析」自跳过）。两种给法：

1. 在克隆目录里显式安装同版宿主包。宿主和 cordis 版本取[当前兼容基准](<docs/requirements.md#13-当前兼容基准>)，其他依赖取项目已声明的约束；将下列占位符替换为满足约束的实际版本，不直接执行占位命令：

   ```powershell
   npm install --no-save @deepseek-ai/cordis@<cordis版本> @deepseek-ai/dsh-llm@<宿主版本> @deepseek-ai/dsh-typert-protocol@<宿主版本> @deepseek-ai/schemastery@<项目依赖版本> @deepseek-ai/dsh-client-ui-primitives@<宿主版本> @deepseek-ai/dsh-session-format-v3-to-v4@<宿主版本>
   ```
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

运行真实模型探针前，确认允许读取所用实例的凭据并向配置的供应商端点发送请求；不要在未获授权的实例上执行。无凭据或断网时的跳过不是离线协议验证。

| 探针 | 需要什么 |
| --- | --- |
| `npm run probe:typert` | 离线（校验 `./typert` 清单与实现一致） |
| `npm run probe:llm`（`tools/probe-llm-tools.mjs`） | 需要网络和用户提供的 LLM 凭据；无凭据或网络不可达时打印 `RESULT: SKIP — 未验证`，跳过不算通过 |
| `npm run probe:reviewer`（`tools/probe-reviewer-live.mjs`） | 需要真实 LLM 凭据（从 `$DSH_HOME/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY` 读，输出不含密钥） |

涉及真实实例的端到端验证请在你**自己的实例**上跑。那类取证工具（`tools/browser-shot.mjs` 浏览器驱动、`tools/probe-rpc.mjs` 实例 RPC 探针、`tools/probe-composer-dom.mjs` 页面结构探针等）**随本仓发布**：接入坐标（实例地址、token 文件、浏览器路径、输出目录）一律经 `tools/local-config.mjs` 给定或显式传参，脚本不含机器事实，可在你自己的实例上排障取证；**运行产物**（截图、DOM 转储、步骤脚本）落在本机配置的输出目录，不进提交。

## 本仓自身约定（fork 维护者参考）

**公开内容边界**：

- **① 本公开仓只含**：产品代码、测试与工具、对外文档、需求与设计。机器配置、开发过程材料与验证产物不提交到本公开仓。
- **② 需求与设计分工**：需求定义产品行为、默认值、边界和验收结果；设计定义机制与验证方法，两者允许彼此引用。不依赖其他文档或外部资料补齐必要正文；源码与测试定位只作核验。按主题直接更新，不保留相反版本和完成流水账。增补章节供短期迭代，维护者定期归并。
- **③ 脚本里不写机器事实**：宿主安装树锚点、实例 URL、token 文件、浏览器路径、输出目录等一律经 `tools/local-config.mjs` 读取（本机配置放 `.local/config.mjs`，形状见 `tools/local-config.example.mjs`），或用对应环境变量临时覆盖。源码里出现 `.local/` 字面（配置加载器与其示例除外）同样算违规。

判据是一条命令，它同时跑在 CI 里：

```powershell
npm run check:public-surface     # 结构 / 本机指纹 / 内部引用，三类判据零命中即绿（绿＝测试通过）
```

**改动纪律**：影响判决路径的改动必须带能检出退化的验证；需求变动先修正对应主题，设计和使用说明随后同步。未实施或未验收的事项不能因文档已写而宣称完成。真实凭据、真实会话内容与本机路径不进提交，测试夹具用假值（如 `sk-abc12345`）。

**代码约定**：

- 不随意新增运行时依赖；当前声明以 `package.json` 的 dependencies 与 peerDependencies 为准（运行依赖含 `zod`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-typert-protocol`；peer：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-typert-protocol`）。实现调整后按实际用途核对依赖，不因某个包存在就保留不需要的功能。
- 不修改宿主源码、不打源码补丁。当前产品合同不提供插件侧用户 YAML 解析或自动清理；卸载残留风险须如实说明，不能降低用户配置保全要求。
- `client.js` 是宿主加载器用的工厂式 CJS（`window.__ModuleLoader__.load({ id, factory })`，`factory(require)`，`require('react')` 由加载器提供），**没有 JSX、没有构建步骤**；改它时保持这个形态。
- 新增配置字段：在 `lib/config.js` 的 `Config` 里声明，需要热改就加 `.volatile()`（`@deepseek-ai/schemastery` ≥ 3.18.4），并在 `test/config.test.mjs` 补解析用例。界面文案分两处维护：设置卡、composer 等客户端界面文案进 `client.js` 内的中英字典（`test/client.test.mjs` 守字典齐备与双语同步）；面向模型的文案见下一条的 `lib/agent-texts.js`（缺键即抛错，不静默回退，`test/agent-texts.test.mjs` 补用例）。
- 面向模型的文案（系统提示、注入文本）改动请**逐字节**核对是否影响既有判据：本仓有冻结断言守着不可变块。
- 中文文档与注释保持本仓既有术语；改行为时同步更新 README 里对应的用户可见说明。
- 代码注释的编号与章节引用以 docs 的现行 § 章节号为准。维护代码时使用稳定主题定位，不能据旧注释恢复已取消的机制，也不新增按修复批次编号的引用。

**运行真机的经验**（不是硬性要求）：

- **别重启正在工作的实例**。宿主服务默认会清理整棵进程树：从服务自身进程树内发起的重启会把自己一起杀掉、服务停在停止态。重启命令要在服务进程树之外执行。
- 建议备两个 profile（或两个实例）：一个跑日常开发与探针，一个做端到端验证。插件宿主侧改动要重启宿主才装载，客户端侧随页面加载生效——两条调用链分开验，省得互相干扰。
- 端到端结论（「真的自动放行了」）必须来自真机实测 + 审计行，不能由单测代替；单测证明的是分支正确性，不是宿主接线正确性。
