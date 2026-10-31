# dsh-approve-for-me

[中文](<README.md>) · English

dsh-approve-for-me is an automatic approval plugin for DeepSeek Harness (DSH). When the acting Agent requests broader sandbox permissions, the plugin calls a model to assess the operation's risk and the user's authorization. Eligible operations can be approved without asking the user each time.

Review runs independently of the acting Agent's session, with read-only tools available to check local evidence. The plugin preserves DSH's sandbox restrictions, and each approval applies to one operation only.

This is a third-party community plugin, unaffiliated with DeepSeek.

## Compatibility

| Component | Current requirement |
| --- | --- |
| Plugin version | `0.2.2+dsh.0.2.1-rc` |
| DSH compatibility line | `0.2.1-rc`; supported versions are `0.2.1-rc.1`, `0.2.1-rc.2`, `0.2.1-rc.3`, `0.2.1-rc.4`, and `0.2.1-rc.5` |
| Plugin Node declaration | `>=20`; this is not the minimum for the complete host |
| Recommended toolchain | Node 24, used for this project's development and CI |

DSH supplies the two host interface packages, `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-typert-protocol`. Both must match its RC version and come from the same DSH installation; do not install a separate, mismatched copy for the plugin. See the [user reference](<docs/user-reference.en.md#known-issues>) for tested platforms and features.

## Installation

Get the source from the [GitHub repository](https://github.com/MC5Spear/dsh-approve-for-me) and create an installation package locally. This adaptation line uses `adapt/dsh-0.2.1`. Check the versions above and record the source revision with `git rev-parse HEAD` for updates, rollback, and troubleshooting.

Before installing:

1. If the plugin is already installed, set Mode to “Do not take over” (`mode=off`) in its settings and save. Switch the host default permission preset and active sessions to a standard preset, such as Workspace write.
2. Wait for host tasks to finish or stop them safely. The restart after installation interrupts running work. For a service deployment, restart from a management terminal outside the service's process tree.

The host installation channel needs pnpm. Check with `corepack pnpm --version`. If unavailable, ask the deployment administrator to prepare pnpm for that host first.

First confirm the target DSH profile: the named deployment configuration loaded by that instance. Check its startup command or ask the deployment administrator. The example uses `web`; replace it if the target uses another profile.

With Git, Node.js, and npm available, obtain the source in a separate deployment directory and create a package:

```powershell
git clone --branch adapt/dsh-0.2.1 https://github.com/MC5Spear/dsh-approve-for-me.git
cd dsh-approve-for-me
git rev-parse HEAD
$package = (npm pack --ignore-scripts --json | ConvertFrom-Json)[0]
if ($LASTEXITCODE -ne 0) { throw "npm pack failed" }
dsh plugin --profile web add (Join-Path $PWD.Path $package.filename)
```

`npm pack` creates a `.tgz` in the current directory. The commands use its filename automatically, with no path placeholder to fill in. No prior development-dependency installation or product build is needed.

For source-directory dependencies, installation, and updates, see the [installation reference](<docs/user-reference.en.md#installation>). Restart the host safely after installation, then reload the page.

### First checks

1. Open `dsh-approve-for-me` under Plugins → Installed and verify its full version.
2. Confirm that the details page has a settings form.
3. Find “自动审批” (`auto-approve`) in the session permission list. This is the plugin's Auto approval preset, not the host's “Auto review” (`auto`). Keep a standard preset selected.
4. Check that an ordinary session works. If settings or presets are missing, follow [troubleshooting](<docs/user-reference.en.md#troubleshooting>); do not widen version requirements to force loading.

An installation command succeeding does not establish that automatic approval is active. Complete the setup under “Settings and use” below, then confirm approval and records with a harmless escalation.

## Before enabling

- The plugin handles sandbox-escalation requests only for selected sessions and tools; this is called takeover below. Full-access operations that do not trigger approval are outside its protection.
- An approval covers one operation only. Repeating the same command still needs a valid approval for that new operation.
- Models can misjudge risk or be affected by prompt injection. Keep the sandbox, back up important data, and narrow the covered tools, permission presets, and escalation ceiling to the task.
- Arguments, file contents, and tool results are evidence, not authorization by themselves. State the intended targets and permitted side effects explicitly.
- Built-in dangerous-command checks run whenever takeover applies. Clearing custom `denyPatterns` does not disable them. Timeouts, unavailable models, and unusable conclusions reject by default. See [results and new requests](<docs/user-reference.en.md#results>).
- Read-only evidence collection can send local content to the configured model provider. Redaction recognizes only limited patterns. Check storage permissions before enabling full-text records too.

## Settings and use

Open settings from the machine running DSH, using `127.0.0.1` or `localhost`. If a remote entry is read-only, use local management access.

1. Open Plugins → Installed → `dsh-approve-for-me`. Choose the default reviewer model, tools to cover, and highest permission the plugin may approve, then save.
2. Change Mode to “Rule check + LLM review” and save.
3. Select the “自动审批” (`auto-approve`) preset in a session that needs automatic approval. Installation does not make it the default.
4. Try a harmless operation that genuinely needs escalation. In the session's Review log, check the final outcome, reason, and actual model. Do not test checks with dangerous actions.

Failed saves retain the draft; leaving the page discards unsaved edits. Reset to default for one field also needs Save. See [settings and reset](<docs/user-reference.en.md#settings>).

Main sessions show an approval card during automatic review by default. Select Reject or Allow once to decide before the review finishes. To also hand an unsuccessful review to a human, set `fallback=ask`; otherwise it rejects by default. Delegated subagents do not offer human approval; sessions forked by the user retain it.

## Before disabling or uninstalling

Save Mode as “Do not take over” (`mode=off`), then switch the DSH default permission preset and sessions you want to keep using to standard presets. Back up configuration and needed records before disabling or removing the plugin.

The host may retain the “自动审批” (`auto-approve`) entry in user configuration. Its presence does not mean the plugin is still running. If the default preset is still Auto approval when its configuration entry is removed, permission settings may fail to load. Follow [disabling, removal, and recovery](<docs/user-reference.en.md#uninstall>).

## User documentation

| Task | Entry |
| --- | --- |
| Install, update, and confirm loading | [Installation reference](<docs/user-reference.en.md#installation>) |
| Settings, model selection, and every field | [Complete user reference](<docs/user-reference.en.md>) |
| Understand results, false denials, or model errors | [Results and new requests](<docs/user-reference.en.md#results>) |
| Evidence, records, and privacy | [Evidence and records](<docs/user-reference.en.md#evidence-records>) |
| Troubleshoot, disable, remove, or recover | [Troubleshooting](<docs/user-reference.en.md#troubleshooting>) · [Removal and recovery](<docs/user-reference.en.md#uninstall>) |

## License

The project uses the MIT license; see [the license](<LICENSE>). Some review templates, rejection instructions, and policies come from or are adapted from OpenAI Codex. See [third-party notices](<NOTICE>) and the [Apache-2.0 license](<LICENSES/Apache-2.0.txt>) for attribution and licensing details.
