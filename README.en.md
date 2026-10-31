# dsh-approve-for-me

[中文](<README.md>) · English

When an Agent requests broader sandbox permissions, this plugin reviews whether to allow that operation. It runs inside DeepSeek Harness (DSH), the application that runs the Agent.

An independent language model reviews the operation and the user's authorization. Read-only tools let the reviewer check local evidence.

This is a third-party community plugin, unaffiliated with DeepSeek.

## Compatibility

| Component | Current requirement |
| --- | --- |
| Plugin version | `0.2.2+dsh.0.2.1-rc` |
| DSH compatibility line | `0.2.1-rc`; currently admits `0.2.1-rc.1`, `0.2.1-rc.2`, `0.2.1-rc.3`, `0.2.1-rc.4`, and `0.2.1-rc.5` |
| Plugin Node declaration | `>=20`; this is not the minimum for the complete host |
| Recommended toolchain | Node 24, used for this project's development and CI |

The host must supply `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-typert-protocol` at its own RC version from the same host installation tree. See the [user reference](<docs/user-reference.en.md#known-issues>) for the actual verification coverage.

## Installation

Ask the maintainer for an actual `.tgz` artifact or its matching complete source directory. Before installation, verify its full version, matching host, and supplied artifact or revision identity.

Before installing:

1. If this plugin is already installed, turn takeover off and switch the host default permission preset and active sessions to a standard preset, such as Workspace write.
2. Wait for host tasks to finish or stop them safely. The restart after installation interrupts running work. For a service deployment, restart from a management terminal outside the service's process tree.

The host installation channel needs pnpm. Check with `corepack pnpm --version`. If unavailable, ask the deployment administrator to prepare pnpm for that host first.

Replace the placeholder with the **absolute path of the real artifact supplied by the maintainer**, keeping the quotes:

```powershell
dsh plugin --profile web add "<absolute-path-to-artifact.tgz>"
```

For source-directory dependencies, installation, and updates, see the [installation reference](<docs/user-reference.en.md#installation>). Restart the host safely after installation, then reload the page.

### First checks

1. Open `dsh-approve-for-me` under Plugins → Installed and verify its full version.
2. Confirm that the details page has a settings form.
3. Find “自动审批” (`auto-approve`) in the session permission list. This is the plugin's Auto approval preset, not the host's “Auto review” (`auto`). Keep a standard preset selected.
4. Check that an ordinary session works. If settings or presets are missing, follow [troubleshooting](<docs/user-reference.en.md#troubleshooting>); do not widen version requirements to force loading.

An installation command succeeding does not establish that automatic approval is active. Complete the setup under “Settings and use” below, then confirm approval and records with a harmless escalation.

## Before enabling

- Only covered sandbox-escalation requests are reviewed. Operations under Full access that do not trigger approval are outside this protection.
- An approval covers one operation only. Repeating the same command still needs a valid approval for that new operation.
- Models can misjudge risk or be affected by prompt injection. Keep the sandbox, back up important data, and narrow the covered tools, permission presets, and escalation ceiling to the task.
- Arguments, file contents, and tool results are evidence, not authorization by themselves. State the intended targets and permitted side effects explicitly.
- Built-in dangerous-command checks run whenever takeover applies. Clearing custom `denyPatterns` does not disable them. Timeouts, unavailable models, and unusable conclusions reject by default. See [results and new requests](<docs/user-reference.en.md#results>).
- Read-only evidence collection can send local content to the configured model provider. Redaction recognizes only limited patterns. Check storage permissions before enabling full-text records too.

## Settings and use

1. On the plugin details page, choose the reviewer model, covered tools, and permission ceiling, then save.
2. Change Mode to “Rule check + LLM review” and save.
3. Select the “自动审批” (`auto-approve`) preset in a session that needs automatic approval. Installation does not make it the default.
4. Try a harmless operation that genuinely needs escalation. In the session's Review log, check the final outcome, reason, and actual model. Do not test checks with dangerous actions.

Saving requires a host-local loopback entry, such as `127.0.0.1` or `localhost`. Failed saves retain the draft; leaving the page discards unsaved edits. Reset to default for one field also needs Save. See [settings and reset](<docs/user-reference.en.md#settings>).

Main sessions show a human card during review by default, so you may answer first. This differs from the fallback after review, which defaults off and needs `fallback=ask`. Delegated subagents have no human channel; user-forked sessions are treated as main sessions.

## Before disabling or uninstalling

Turn takeover off, then switch the host default permission preset and sessions you want to keep using to standard presets. Back up configuration and needed records before disabling or removing the plugin.

The host may retain the “自动审批” (`auto-approve`) entry in user configuration. Its presence does not mean the plugin is still running. Removing the entry while retaining a default reference to it can prevent permission settings from loading. Follow [disabling, removal, and recovery](<docs/user-reference.en.md#uninstall>).

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
