# User reference

[中文](<user-reference.md>) · [English home](<../README.en.md>)

This reference covers installation, settings, approval results, failures, and removal. DSH is the host application that loads the plugin and runs the acting Agent. The reviewer model independently decides whether to allow this particular escalation.

<a id="known-issues"></a>
## Scope and protection boundary

Review covers only sandbox-escalation requests inside the coverage; see [section 2](<#coverage>) for the coverage and its exceptions. Operations under Full access that do not trigger approval are outside this protection.

The read-only evidence tools deny credential-like files and directories in both literal and real path forms, and browser canonical stores (the `User Data` layout of Edge and Chrome, the `Profiles` layout of Firefox, covering login and cookie databases) are denied the same way; `grep` states its actual coverage when the directory budget is exhausted; renamed copies and hard links are not covered.

The current delivery is verified on Windows with DSH `0.2.1-rc.2`; other platforms and host versions are not verified. Before deploying to those environments, choose and run the relevant checks in the [verification guide](<verification.md>).

Do not test problems with real secrets or dangerous commands.

<a id="installation"></a>
## 1. Obtain an artifact, install, and update

### 1.1 Version and environment

| Component | Current requirement |
| --- | --- |
| Plugin version | `0.2.2+dsh.0.2.1-rc.2` |
| DSH host | Exactly `0.2.1-rc.2` |
| Plugin Node declaration | `>=20` |
| Recommended toolchain | Node 24, used in this project's development and CI |
| Host installer | pnpm; check with `corepack pnpm --version` |

The plugin's Node declaration does not establish that the complete host works on Node 20. Also meet the requirements of the host and its dependencies. This reference does not infer the complete host minimum. Ask the maintainer about verification before relying on another platform or Node version.

The `+dsh.0.2.1-rc.2` part identifies the intended host. Ordinary semantic-version comparisons ignore this build metadata, so they cannot select host compatibility for you. The host also checks the plugin's exact host requirement. Do not widen declarations or use a version exemption to force loading.

When obtaining source or an artifact, check the full version and matching host. An adaptation branch identifies the intended host line, but its contents can move. For reproducibility, retain the revision or artifact identity actually supplied by the maintainer. Different builds can carry the same package version; the version does not replace a delivery identity.

### 1.2 Install a supplied artifact

Ask the maintainer for an actual `.tgz` or its matching complete source. Check the package name, full version above, intended host, and delivery identity. The commands below use that delivered file or directory.

**Restarting interrupts running work.** Before installation or update, wait for tasks to finish or stop them safely. If the plugin is installed, first save `mode=off` and switch default and active-session permission presets to standard ones. Restart service deployments from outside the service process tree.

Replace the placeholder with the absolute path of the real artifact, keeping the quotes:

```powershell
dsh plugin --profile web add "<absolute-path-to-artifact.tgz>"
```

The example uses the `web` profile: a named host deployment configuration. For another profile, replace `web` with its actual name and confirm that it loads the Web interface and required host services. The installation channel installs the package and its direct dependencies into that profile. The matching host supplies the host integration packages.

### 1.3 Install a supplied source directory

Use a separate complete source directory, not a working tree being edited for stable deployment. It must contain package declarations, host and client entries, installation declarations, and security policies.

A directory link resolves direct dependencies from the source directory. The following prepares this plugin's direct dependencies without automatically installing its host peer packages. Replace both path placeholders with the same real source directory:

```powershell
cd "<absolute-source-directory>"
npm install --omit=dev --legacy-peer-deps
dsh plugin --profile web add "<absolute-source-directory>"
```

Here `--legacy-peer-deps` prevents npm from automatically installing host peer packages. It does not establish that the plugin loaded and does not replace the host installation channel. Runtime still requires DSH `0.2.1-rc.2` to supply `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-typert-protocol` from its own installation tree, along with `@deepseek-ai/cordis` satisfying `~4.0.4`. The preceding npm step prepares this plugin's direct dependencies.

Do not assume host packages in an existing source `node_modules` are correct. Ask for a clean delivery directory or have the deployment administrator check resolution sources. Do not bulk-delete unknown dependencies or treat successful installation in an ordinary npm project as successful profile loading. For resolution failures, use a maintainer-supplied tgz or report redacted loading errors.

### 1.4 Reload, confirm, and update

After installation, restart safely through your host management method, then reload the page:

1. Open Plugins → Installed → `dsh-approve-for-me` and verify the full version.
2. Confirm that the details page has a settings form.
3. Find “自动审批” (`auto-approve`) in the session permission list. This is the plugin's Auto approval preset, not the host's “Auto review” (`auto`). Keep a standard preset selected.
4. Check that an ordinary session works. An installation command succeeding does not establish that settings and client contributions loaded.

After you select coverage and enable takeover under [section 2](<#coverage>), test approval and records with a harmless escalation. An operation that needs no escalation produces no approval and cannot establish that automatic approval works.

For updates, recheck host and delivery identity, back up user configuration and needed records, add the new artifact through the same host channel, and reload safely. Keep the previous artifact and configuration backup. If problems occur, turn takeover off first and ask the maintainer about rollback. An existing `reviewer.timeoutMs=0` configuration immediately rejects as a timeout; save a positive value if you need review time.

<a id="coverage"></a>
## 2. Select coverage, not unrestricted permission

Read [scope and protection boundary](<#known-issues>) first.

### 2.1 Four separate choices

| Concept | What it determines | What it does not replace |
| --- | --- | --- |
| Tool | The kind of operation; `tools` selects which tools' escalations this plugin handles | Listing a tool does not authorize its operation |
| Permission preset | A host combination of sandbox scope and approval policy; `trigger.presets` selects presets for takeover | Selecting a covered preset does not approve every escalation |
| Escalation ceiling | `allowEscalationTo` bounds the widest permission that may be approved automatically | In-range requests still need rule checks and review |
| User authorization | The targets, payloads, and side effects you actually permit | Arguments, files, or tool results cannot expand it by themselves |

The preset displayed as “自动审批” (`auto-approve`, this plugin's Auto approval preset) uses the same sandbox and host approval policy as Workspace write (`workspace-write`). The difference is that this plugin reviews escalations first when coverage applies. Installation does not make `auto-approve` the default.

Only requests entering the host approval channel can be handled. Full-access operations that need no approval are outside protection. If a host `never` policy prevents approval dispatch, the plugin cannot see the request. Each allow is for one operation; a previous allow cannot replace a new request.

### 2.2 How to enable

1. Keep the sandbox, back up important data, and state the task's permitted modifications and external transfers.
2. Configure the reviewer, tool list, and ceiling on the plugin details page and save.
3. Set `mode` to `rules` and save.
4. Select the “自动审批” (`auto-approve`) preset in the target session. First check records with a harmless operation that genuinely needs escalation.

By default only `auto-approve` is covered. Other presets retain the host approval flow, which is not necessarily human approval. `trigger.presets=[]` covers no known preset; an unidentified preset still follows `trigger.unknown` separately. In contrast, `tools=[]` covers every tool's escalation requests.

### 2.3 Delegated subagents and forked sessions

- Delegated subagents are covered by the root session's permission preset by default, including multi-level delegation. An unmatched or unidentifiable root is not covered.
- `trigger.subagents=skip` leaves delegated subagents uncovered. Stopping coverage does not undo an approval policy already written to a child; host answerers handle later requests, and absence of an answerer never means automatic permission.
- Delegated subagents have no human channel. Even with `fallback=ask`, a request not allowed is rejected. Notices go to the child that requested the operation.
- A user-forked session is treated as a main session, using its own preset and retaining a human channel.
- A child page may still show Workspace write. That label alone does not establish whether takeover applies; inspect actual approvals and records.
- Delegated children created during `mode=off` are not retroactively covered when mode is enabled again. If automatic approval is needed, enable takeover first, then create a new delegated task.

<a id="settings"></a>
## 3. Edit, save, and reset settings

Open Plugins → Installed → this package's details page. Its form is shown directly. Details next to each field expands help without changing a draft.

Saving requires a host-local loopback entry such as `127.0.0.1` or `localhost`. If a remote entry is read-only, use local management or ask the deployment administrator to edit that profile's user configuration. Read access does not imply write access.

### 3.1 Save and reset one field

1. Edit the fields. This changes only the draft; requests still use effective values.
2. Check validation messages and millisecond-to-seconds readouts, then select Save.
3. Confirm success and updated effective values before issuing another request.

Set individually means the user layer explicitly contains the field, even when it equals the default. Reset to default stages removal of that user override and **still needs Save**. It reveals the lower composition layer's value, or the factory default if that layer also leaves it unset. There is no global reset button.

Failed saves retain the draft. First copy any needed draft securely, then repair connection or validation problems and retry. Do not record credentials. Leaving the page discards unsaved edits. Save is disabled for no changes, invalid values, or a save in progress.

The review and human wait fields show Effective and Draft values converted to seconds. Storage remains milliseconds. An empty numeric draft can remove the user override; an invalid readout shows `—`, not an effective value of zero.

### 3.2 Configuration entry and timing

The settings namespace is `approve-for-me`. Fields without a control are managed by the deployment administrator through profile user configuration. It is normally `profiles/<profile-name>/cordis.patch.yml` under the host data directory. Back up before editing and avoid concurrent writes from the settings page.

This is a configuration-row example, not a replacement for the whole file. Preserve existing rows and unrelated fields; merge only the intended values:

```yaml
- id: approve-for-me
  name: dsh-approve-for-me
  config:
    mode: off
```

Partial configuration sections retain defaults for omitted members. An empty array or dictionary does not universally mean unlimited.

Section 5 identifies the page entry and update method separately:

- **A: Page save.** No restart is needed after saving; subsequent requests use the new value.
- **B: Host live update.** The configuration supports host updates without remounting, but this plugin's page has no control for the field. Subsequent requests use the new value after applying it through the host configuration channel. Hand-edited files still need the host's apply procedure.
- **C: Host reload.** Ordinary configuration changes take effect after the host reloads the plugin. Handle active tasks before reload or restart.

Page editability and live-update eligibility are different. Requests already reviewing or queued retain their entry-time configuration, directory, and capture plan. Redaction is an exception: notices, audit, and record outlets use their effective redaction list when sending or writing. UI language changes apply on the next render.

Invalid types, enums, numbers, or duplicate mapping conditions produce visible errors. Resaving the same invalid value is not a repair. If loading has failed and the form is unavailable, correct configuration and reload safely.

<a id="models"></a>
## 4. Select a reviewer model

### 4.1 Selection order and unavailable choices

Order: **session choice → mapping by the acting Agent's model → global default**.

An unavailable session or mapping target goes directly to the global default. It does not try another rule or an intermediate layer. An empty global default uses the acting Agent's current model, but in a separate review call independent of that Agent's session. A configured but unavailable global default is a model failure. So is an unavailable acting model when following it. The plugin does not select an arbitrary replacement.

Global model problems appear at the top of settings, rule problems at the mapping row, and session-choice problems beside the session control. Check the provider, model, and actual fallback shown there. A readable model catalog establishes neither working credentials nor remote service availability. For persistent failures, turn takeover off and repair model configuration instead of making repeated requests.

Once a session has an id, it can select a reviewer before its first message. The control follows takeover state, hides with `mode=off`, and returns when enabled; it remains visible if the host supplies no takeover state. Clearing a session choice uses the mapping or global default. Failed writes retain the previous choice. Turning takeover off does not clear saved choices.

Prefer a complete `provider/model` reference. The first slash separates provider id; remaining slashes belong to the model id. Configuration also accepts a bare model id, using the acting Agent's provider, or the first registered provider if no parent provider is available. Use complete references to avoid unintended provider resolution.

Effort is model-specific. If unspecified, use `low` when supported, otherwise leave it to the model default. An explicitly unsupported effort is omitted and recorded as degraded. Reasoning may consume a small output-token cap before producing a conclusion; one model's useful cap is not a guarantee for another.

### 4.2 Structured mappings

Each row contains scope, the acting Agent's complete model id, the reviewer reference, and effort.

```json
{
  "parent": { "provider": null, "model": "<complete-acting-model-id>" },
  "choice": { "model": "<provider>/<reviewer-model-id>", "effort": "" }
}
```

Replace placeholders before saving. `parent.provider=null` means any provider; a nonempty string means a specific provider. `parent.model` is always the complete bare model id and is never split on slashes.

Specific-provider rules precede any-provider rules. One rule is allowed per condition. Leading and trailing whitespace is trimmed, and an empty provider means any provider. Duplicate conditions block saving and loading. A matched rule with an empty target is an unavailable candidate and goes directly to the global default.

### 4.3 Preserve and confirm legacy keys

`reviewer.byParentModel` remains a compatible input. Lookup order is structured exact rules, structured generic rules, a legacy complete-model-id key, then a legacy full-reference key with its first provider segment removed.

- A bare-model-id legacy key matches any provider. It stays in the legacy dictionary when untouched.
- Slash-containing keys ask for confirmation: did the key mean any provider with a model id containing slashes, or a specific provider and its model id? The catalog can help check but cannot establish original intent.
- Until confirmed, a key keeps its original value and compatible lookup behavior. It is not rewritten automatically. Only confirmation or editing moves that row to structured rules; the same new rule is not saved in both formats.
- Multiple legacy full references that normalize to one model can be used when their choices agree. Conflicting aliases are not used; the mapping is treated as unmatched and the conflict is logged.
- Resetting the mapping field removes user overrides for both structured rules and the legacy dictionary after Save. First check that the lower layer contains the values you intend to restore.

<a id="configuration"></a>
## 5. Every configuration field

Each row distinguishes accepted configuration ranges from special runtime handling. Numeric range codes used in the tables are defined here:

- **N:** a non-negative integer; the configuration schema adds no numeric upper bound. This does not mean unlimited resources.
- **S:** a safe integer from `0` through `9007199254740991`. These fields have schema range N, with an additional S check when read at runtime.
- **T:** an integer from `0` through `2147483647`, in milliseconds.

“—” means no unit or not applicable. Unless stated otherwise, only omission supplies a default; invalid values are not omission. See the adjacent [timing definitions](<#settings>) for A, B, and C. “Legacy row” means a compatible row in the mapping table, not a separate dictionary editor.

### 5.1 Coverage and human handling

| Field | Type | Default | Range | Unit | Zero or empty | Page | Effective |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `enabled` | boolean | `true` | `true` / `false` | — | `false` registers neither answerer nor child coverage | No | C |
| `mode` | string | `"rules"` | `rules` / `off` | — | `off` leaves requests to the host flow | Yes | A |
| `tools` | string[] | `[]` | Array of tool names | — | Empty covers every tool's escalations | Yes | A |
| `allowEscalationTo` | string | `"danger-full-access"` | `workspace-write` / `danger-full-access` | — | Empty enum invalid | Yes | A |
| `denyPatterns` | string[] | `[]` | Array of regex strings | — | Empty disables custom text rules, not built-in checks | Yes | A |
| `unknownSubject` | string | `"reject"` | `reject` / `review` | — | Empty invalid; unknown actions reject by default | Yes | A |
| `fallback` | string | `"reject"` | `reject` / `ask` | — | Empty invalid; `ask` applies only to paths with a human channel | Yes | A |
| `trigger.presets` | string[] | `["auto-approve"]` | Array of permission preset ids | — | Empty covers no known preset; unknowns follow the next field | Yes | A |
| `trigger.unknown` | string | `"skip"` | `skip` / `review` | — | Empty invalid; `skip` keeps the host flow | Yes | A |
| `trigger.subagents` | string | `"review"` | `review` / `skip` | — | Empty invalid | No | B; new child coverage and subsequent checks |
| `trigger.auditEverySkip` | boolean | `false` | `true` / `false` | — | `false` reduces repeated preset-skip logging | Yes | A |
| `human.timeoutMs` | integer | `300000` | T | ms | Human timing requires `fallback=ask`; `0` exhausts the human budget immediately, not endless waiting | Yes | A |
| `human.timeoutFrom` | string | `"request"` | `request` / `handoff` | — | Empty invalid | Yes | A |

`unknownSubject=review` submits recovered parameters with explicit missing-evidence markers; missing does not mean safe.

Human timing is enabled only with `fallback=ask`. `request` starts at request entry, so assembly and queue waits also consume the human budget. If a card is already visible during review, expiry of that budget can settle the approval first. `handoff` starts timing only at actual human handoff.

Showing a card during review does not enable human timing. With `fallback=reject`, you may still answer first on a visible card, but `human.timeoutMs` does not apply. Setting it to `0` does not immediately reject on a human deadline.

### 5.2 Model and evidence calls

| Field | Type | Default | Range | Unit | Zero or empty | Page | Effective |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `reviewer.model` | string or ModelChoice | `""` | Reference or `{model, effort}`; members are strings, each defaulting to empty | — | Empty means unset global default; falling to this layer follows the acting Agent | Yes | A |
| `reviewer.parentModelRules` | object[] | `[]` | Structured rules; see section 4 and members below | — | Empty has no structured mapping | Yes | A |
| `reviewer.byParentModel` | object | `{}` | Legacy dictionary of string keys to ModelChoice | — | Empty has no legacy mapping; untouched keys are not migrated | Legacy row | A; confirmed or edited legacy rows become structured rules |
| `reviewer.timeoutMs` | integer | `90000` | T | ms | `0` immediately rejects as timeout without starting an attempt | Yes | A |
| `reviewer.maxTokens` | integer | `0` | schema N; runtime S | token | `0` sends no cap; model or provider default applies | Yes | A |
| `reviewer.temperature` | number | `0` | Finite `[0,2]` | — | `0` is a valid temperature, not omission | No | B |
| `reviewer.maxToolSteps` | integer | `4` | schema N; runtime S | Tool rounds | `0` provides no evidence tools and requests a direct conclusion | No | B |
| `reviewer.toolTimeoutMs` | integer | `5000` | T | ms | `0` immediately times out each tool call, returning evidence failure | No | B |

ModelChoice is either a model-reference string or `{"model":"provider/model","effort":""}`. Structured-rule members:

| Member | Type and omitted default | Requirement |
| --- | --- | --- |
| `parent.provider` | string or null, default `null` | Empty or whitespace means any provider; nonempty strings are trimmed |
| `parent.model` | string, schema default `""` | An actual rule must be nonempty; complete bare id, preserving internal slashes |
| `choice.model` | string, default `""` | Target reference; empty triggers unavailable-candidate fallback |
| `choice.effort` | string, default `""` | Empty selects automatically; unsupported explicit values are omitted and logged |

The review limit includes assembly: reading configuration, selecting a model, recovering arguments, and collecting context. Internal retries get no new budget. Queuing has a separate limit and does not consume the review budget. At most two attempts run: the first plus one retry. Truncated output, unavailable model resolution, and assembly errors are not internally retried. When tool rounds are exhausted, one further conclusion request is made without tools.

### 5.3 Context and redaction

| Field | Type | Default | Range | Unit | Zero or empty | Page | Effective |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `context.maxTranscriptBytes` | integer | `24576` | N | UTF-8 bytes | `0` does not trim total context | No | C |
| `context.maxEntryBytes` | integer | `4096` | N | UTF-8 bytes | `0` does not trim each entry; also used for standalone arguments and summaries | No | C |
| `context.maxEntries` | integer | `40` | N | Events | `0` deliberately takes no context; real action arguments are still sent separately | No | C |
| `context.includeToolResults` | boolean | `true` | `true` / `false` | — | `false` omits tool results from context | No | C |
| `context.redactPatterns` | string[] | six default rules | Array of regex strings | — | Configuration replaces the whole list; empty disables masking | No | C; outlet exception in section 3 |

<a id="redaction-defaults"></a>
The six default redaction rules below replace matches with `[redacted]` in this order. Plain expressions ignore case; `/source/flags` uses explicit flags, adding a global flag for replacement. Uncompilable entries are skipped and do not protect content.

```text
(?<![A-Za-z0-9_\-])sk-[A-Za-z0-9_\-]{8,}
\bBearer\s+[A-Za-z0-9._\-]{8,}
\b(password|passwd|token|api_key|apikey|secret)\s*[=:]\s*[^\s"'`]+
-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----
Authorization:\s*[^\r\n]+
://[^/\s:@]+:[^/\s:@]+@
```

These recognize some keys, Bearer values, password-like assignments, private-key blocks, authorization headers, and connection-string credentials. They can miss secrets. Review inputs, tool results, notices, and records may contain private data. Restrict local access and redact manually before sharing. Over-budget context and arguments preserve ends around a missing-content marker; with a tiny positive budget, the complete marker itself may exceed the nominal cap.

### 5.4 Concurrency, queuing, and cooldown

| Field | Type | Default | Range | Unit | Zero or empty | Page | Effective |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `concurrency.max` | integer | `2` | N | Global simultaneous reviews | `0` admits no review; queued requests end at their wait limit | No | C |
| `concurrency.queueMax` | integer | `8` | N | Global queued requests | `0` permits no waiting; immediately runnable requests can still run | No | C |
| `concurrency.queueTimeoutMs` | integer | `30000` | T | ms | `0` expires immediately when waiting is needed | No | C |
| `breaker.consecutiveDenials` | integer | `3` | N | Consecutive denials or errors | `0` meets the threshold after every recorded review, including allow | No | C |
| `breaker.windowSize` | integer | `50` | N | Recent review results | `0` retains no window count; the consecutive threshold still applies | No | C |
| `breaker.windowDenials` | integer | `10` | N | Denials or errors in window | `0` meets the window threshold after every recorded result | No | C |
| `breaker.cooldownMs` | integer | `600000` | T | ms | `0` ends cooldown and clears counts at the next check | No | C |

Reviews in one session are always serial. There are no per-model or per-session concurrency controls. Reaching either threshold opens cooldown; models are not called during it. `allow` clears the consecutive count; `deny` and review errors count. Internal attempts count as one task. Scheduling failures before review, cooldown rejection, and aborted reviews superseded by human action or cancellation do not count. Assembly and review timeouts do count.

There is currently no cooldown badge or manual-clear button. Identify it from the error and logs, wait for expiry, then request again. Do not retry immediately in a loop. Ordinary reload constructs a new scheduler and clears counts, but do not interrupt active tasks merely to clear cooldown.

### 5.5 Audit, notices, and records

| Field | Type | Default | Range | Unit | Zero or empty | Page | Effective |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `audit.enabled` | boolean | `true` | `true` / `false` | — | `false` disables stderr audit, not review records | No | C |
| `audit.includePrompt` | boolean | `false` | `true` / `false` | — | `false` adds no prompt audit line | No | C |
| `audit.includeRaw` | boolean | `false` | `true` / `false` | — | `false` adds no raw-output audit line | No | C |
| `audit.maxLineBytes` | integer | `4096` | N | UTF-8 bytes | `0` reduces audit content to an empty line, not unlimited length | No | C |
| `ui.inject` | string | `"all"` | `all` / `reject` / `off` | — | `off` sends no Agent notice; records remain separate | Yes | A |
| `ui.injectMaxBytes` | integer | `2048` | schema N; runtime S | UTF-8 bytes | `0` does not trim a notice | Yes | A |
| `ui.humanCardDuringReview` | boolean | `true` | `true` / `false` | — | `false` shows a card only on actual human handoff | Yes | A |
| `ui.trace.ownView` | boolean | `true` | `true` / `false` | — | `false` disables the plugin record view | No | B |
| `ui.trace.turnSummary` | boolean | `true` | `true` / `false` | — | `false` hides per-turn timing comparison | No | B |
| `ui.trace.legacyRow` | boolean | `false` | `true` / `false` | — | Approximate trajectory row defaults off | No | B |
| `ui.trace.capture` | string | `"summary"` | `off` / `summary` / `full` | — | `off` skips full-text details but retains outcomes, reasons, action/context summaries, and evidence-tool status summaries; these may contain secrets. It neither stops content recording nor clears history | No | B; capture plans for later requests |
| `ui.trace.maxRecords` | integer | `200` | N | Stored rows in the per-session read-back window | `0` actually falls back to `200`, not empty or unlimited | No | C |
| `ui.trace.maxBytes` | integer | `8192` | N | UTF-8 bytes per full field | `0` actually falls back to `8192`, not untrimmed | No | C |

`ui.inject=all` notifies allows, denials, timeouts, and failures; `reject` sends only the last three. Skipped requests, cancellation, and direct human answers do not add a model-conclusion notice.

Audit lines have another fixed limit: reasons are at most 200 JavaScript string characters. Over-budget lines first lose their reason, then become compact lines; tiny caps can remove even the truncation marker. Prompt and raw-output audit switches do not bypass this trimming. For subsequent full-text material use `ui.trace.capture=full`, after assessing privacy. Tiny positive notice budgets can be exceeded by a complete truncation marker. Notice length is not record retention capacity.

### 5.6 Two independent language switches

| Field | Type | Default | Range | Unit | Zero or empty | Page | Effective |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `language.ui` | string | `"auto"` | `auto` / `zh` / `en` | — | Empty invalid; auto follows the host | Yes | A; next UI render |
| `language.agent` | string | `"en"` | `zh` / `en` | — | Empty invalid | Yes | A; subsequent reviews and notices |

UI language does not change model-facing language. `language.agent` controls system prompts, policies, evidence explanations, tool descriptions and result explanations, round guidance, and Agent notices. Model references, tool names, and host catalog data retain their values. The fixed stderr format does not switch language.

<a id="results"></a>
## 6. Read results and handle denials or failures

The approval card retains the command and Reject / Allow once buttons. Automatic review shows its state and countdown. Human handoff says Waiting for your decision; this is not yet a final rejection. If the state channel is unavailable, the original host card is shown without an invented state.

| Result or cause | Meaning | Next action |
| --- | --- | --- |
| Allowed | This operation is approved and the Agent can proceed | Inspect the tool result for execution success; approval itself is not successful execution |
| Built-in or custom rule hit | No model review; neither model nor human can override | Check the hit location. Remove an incidental text hit or choose a materially safer action as described below, then request again |
| Escalation above ceiling | Requested permissions exceed configuration | Prefer less permission. If necessary, the user reviews the risk, adjusts the ceiling, and requests again |
| Action cannot be identified | Default `unknownSubject=reject` rejects directly | Have the Agent supply verifiable real arguments, target, and working directory in a new request |
| Model safety denial | Review concluded this action should not be allowed | Use a materially safer alternative. If the original is needed, inform the user of the risk and obtain explicit authorization before requesting again; rule checks still apply |
| Assembly, queue, or review timeout | No usable conclusion within the limit, not a danger verdict | Check the named budget and model state. Request again after repair; if human fallback is available and enabled, decide through the card |
| Model or channel failure | No safety conclusion; examples include unavailable models, empty/truncated output, full queue, or cooldown | Repair the stated cause. Stop repeated requests on persistent failure and report; wait during cooldown |
| Human timeout | Human waiting expired without a completed answer and rejected | Confirm the task is still needed before making a new request |
| Human answer or cancellation | The human result is used, or this request ends | Do not expect a late model result to reverse it; request again for any new operation |

When a human card is already visible, you can answer before settlement. Default `ui.humanCardDuringReview=true` is compatible with default `fallback=reject`: one controls cards during review; the other controls handoff after review did not allow. Direct rule rejections and delegated children have no human fallback.

A request has one final outcome. Late clicks and model results cannot change it. If an old card remains, check the record instead of treating it as a new authorization entry. After safety denial, do not use equivalent commands, indirect execution, or different tools to achieve the same dangerous result.

<a id="command-checks"></a>
### 6.1 Built-in dangerous-command checks

These apply only to covered escalations and cannot be disabled separately. They inspect command text and extractable wrapper contents, not the full semantics of all parameters.

| Common matched form | Response |
| --- | --- |
| PowerShell `Remove-Item` and aliases `rm`, `ri`, `del`, `erase`, `rd`, `rmdir` with `-Recurse` or recognized abbreviations; POSIX `rm` with both recursion and force; CMD `del /f`, `erase /f`, `rd /s /q`, `rmdir /s /q` | Check targets and backups. Use a materially safer operation, such as moving to a recovery location, then request again |
| A forced or recursive delete whose target uses variables, command substitution, home expansion, or other runtime evaluation, or has no target | Establish the real target and request using a literal path. If the first row still matches, also change the operation |
| `mshta` or `rundll32 url.dll,FileProtocolHandler` with an http/https address | Let the user verify and open the address, or retrieve content locally for review before handling it |

`rm -r` matches the PowerShell `-Recurse` abbreviation even in POSIX commands or `git rm -r`. Some quoted flags, abbreviations, and wrappers also match. Assigning a literal to a variable earlier in a script still leaves a variable delete target treated as uncertain.

Quotations, search strings, and commit messages inside command text can cause false hits, including a command merely describing the dangerous form. Separate explanatory fields are outside this built-in command check, but may still match custom text rules.

For a false denial, inspect the reported location. Removing an incidental phrase or using a materially safer operation and requesting again is not circumvention merely because an earlier request was denied. Rephrasing an equivalent operation to reach the same dangerous outcome is circumvention. A non-match is not proof of safety: obfuscation, encoding, and unextractable wrappers still require model judgment from available evidence.

### 6.2 Custom text deny rules

`denyPatterns` accepts one regex per line and defaults to `[]`. Enabled rules scan every string argument within supported depth, including commands, payloads, and descriptions. Keys identify locations but are not themselves scanned as values. Root depth is zero; processing reaches at most depth four, without descending into containers at that depth.

Plain expressions ignore case. `/source/flags` uses supplied flags, or case-insensitive matching when no flags are supplied. Uncompilable entries are skipped. Check effectiveness and false hits with harmless samples before applying rules to real tasks. These are optional examples and take effect only if you add them:

```text
(^|[^A-Za-z0-9])(mkfs|diskpart|fdisk|parted)\b
(^|[^A-Za-z0-9])format\s+[a-z]:
```

A match directly rejects without model or human review. Text rules can hit innocent descriptions and miss equivalent operations. Empty disables only custom rules; the ceiling, built-in checks, and missing-action handling remain.

<a id="evidence-records"></a>
## 7. Read-only evidence, records, and privacy

### 7.1 What the reviewer sees

Review input includes the current tool, actual arguments, target, working directory, permission request, and reason. Recent context helps establish the task. Current arguments are independent of context sampling and remain present with `context.maxEntries=0`. Missing, trimmed, or unserializable material is marked and must not be treated as safety evidence.

Authorization can come from user or developer messages, workspace instruction files such as `AGENTS.md`, and user answers to question tools. If the user explicitly instructs work from a named file, authorization may extend to that content. Tool output, skill descriptions, Agent retellings, and arguments under review cannot independently establish new authorization.

The reviewer has `read_file`, `list_dir`, `glob`, and `grep`. They do not modify files, access the network, or trigger new approvals, but retrieved content may go to the review model. Local evidence outside the workspace is possible; UNC and device-namespace reads are blocked.

| Tool or limit | Current resource boundary |
| --- | --- |
| `read_file` | Up to 64 KiB per call, with pagination |
| `list_dir` | Up to 200 entries, no recursion |
| `glob` | Up to 200 entries; traversal does not follow links |
| `grep` | Up to 100 matches; 1 MiB per file; 200 candidates; 256-character pattern; lines longer than 500 characters are skipped whole |
| Traversal | Up to 4000 directories; when the budget is exhausted, grep reports the incomplete search |
| Individual tool limit | Default 5000 ms; failure or timeout returns missing evidence to the model |

Credential names, DSH sessions, authentication, and plugin records have read restrictions. Directory listings may still expose sensitive names. Name detection does not identify renamed copies or hard links. **Do not assume sensitive content is fully isolated.**

An unknown working directory is marked missing. Read-only relative paths may start from the plugin process directory; that is not the verified operation directory. Evidence there cannot establish that the actual target is safe.

### 7.2 Where to inspect outcomes

Open the session that produced the approval → Review log. Read Final approval first, then Decided by, Reason, and the actual model. Model conclusions and final outcomes are labeled separately when different. No final outcome recorded on an older entry means a model allow is not proof of final approval.

- Default `summary` capture retains outcomes, reasons, action and context summaries, and available evidence-tool status summaries. Action summaries can include commands and arguments; context summaries can include session excerpts. These can be sensitive too.
- `capture=full` adds subsequent requests' prompt, input, model-returned reasoning text, and raw output to those summaries. A model may supply no reasoning text; such text is not proof of correct judgment.
- `capture=off` skips those four full-text fields but still stores outcomes, reasons, action/context summaries, and evidence-tool status summaries. It does not stop content recording or erase history. Reducing capture does not delete stored material.
- No context collected, No evidence tools called, Not provided by the model, Full-text capture was off, and Not recorded for this approval describe different absences. Enabling full capture cannot fill earlier gaps.
- Linked tool records show Tool total = exec + approval. Approval is split into queue, review, and human waiting; missing values show `—`, not estimated timings.

Records and notices are redacted before trimming but can still contain secrets. Restrict the storage location before enabling full capture and manually redact reasons, screenshots, and logs before sharing.

### 7.3 Retention, backups, and write failure

The plugin data directory is `$DSH_HOME/approve-for-me/`, or `~/.dsh/approve-for-me/` when unset. Session choices are in `session-models.json`; records are stored per session at `reviews/<session-id>.jsonl`. Uninstall preserves them by default.

Three different limits apply to records:

1. `ui.trace.maxRecords` is the per-session read-back window, normally the latest 200 stored records. Earlier rows leaving the view are not necessarily deleted from disk at that point.
2. A session file exceeding four times the window is rewritten to keep only one latest window. Earlier records are deleted then. One approval can create both review and final-settlement rows, so stored row count is not approval count.
3. At most 50 session files are kept. This is fixed, not a configurable field. The oldest file is removed on overflow. Session model choices separately have a fixed 200-entry limit, evicting the least recently updated.

For long-term retention, back up securely before rotation. Give multiple host instances separate data directories; do not share one records directory. Forked sessions show only their own approvals, not inherited records.

A Record read failed or incomplete message does not establish that no approval occurred. Failed writes may survive only in memory and disappear on restart. Save needed visible summaries and existing logs securely before reporting; do not delete files first. Restart can read back the remaining disk window, not data never written or already evicted.

Host stderr contains `[approve-for-me]` audit lines. One approval may have several stages; retain related lines for diagnosis. A trimmed audit excerpt is not a complete original input.

<a id="troubleshooting"></a>
## 8. Troubleshooting and help

| Symptom | First check | Next action |
| --- | --- | --- |
| Settings and “自动审批” (`auto-approve`) are both absent | Full plugin version, exact host version, enabled state | After tasks finish, reload safely and refresh the page. Inspect `skipping profile bundle "dsh-approve-for-me"` or other loading errors and use a matching version |
| Save fails or settings are read-only | Local loopback access and valid fields | Retain the draft; fix access or validation and save again. For failed configuration loading, ask an administrator to repair and reload |
| Session reviewer control is absent | Session id, `mode=off`, and coverage | The control is hidden while `mode=off`. After takeover is enabled, check coverage; do not widen permissions just to show the control |
| An operation rejects immediately | Rule, ceiling, missing action, or model judgment | Follow section 6. Emptying custom rules does not disable built-in checks |
| Unavailable model, empty/truncated output, or repeated timeouts | The chosen model and fallback, zero budgets, cooldown | Turn takeover off and repair model or budget. Wait during cooldown. Stop repeated requests and report persistent failure |
| Search is empty | Skipped candidates, truncation, or evidence failure | Empty does not prove a complete no-match search or safety; check the incomplete-search notice before concluding |
| Records are missing | Producing session, capture level, I/O errors, and rotation | Preserve evidence before reporting. Do not delete records to “repair” the issue |
| Permission row is absent or logs say `unknown preset` | Default still references a missing `auto-approve` | Restore the reference or backup under the next section; do not delete all configuration |

For help, submit a [project issue](https://github.com/MC5Spear/dsh-approve-for-me/issues) with full plugin version and delivery identity, host and Node versions, platform, reproduction steps, redacted configuration, and related audit lines or screenshots. Remove credentials, private paths, session content, and token-bearing URLs. Redact security reports too; do not reproduce with real dangerous operations.

<a id="uninstall"></a>
## 9. Disable, uninstall, and recover

### 9.1 Stop takeover and retain recovery material

1. Set `mode=off` and save to stop taking new requests. Existing queued or reviewing requests may continue with their snapshots; confirm tasks have finished or stop them safely.
2. Back up profile user configuration under `profiles/<profile-name>/` in the host data directory, along with any plugin records you need.
3. Switch the host default permission preset and sessions you will continue to a standard preset, usually Workspace write. Do this before removing a preset entry.
4. To disable only, use the host plugin management control. To uninstall, use the command below; replace `web` for another profile.

```powershell
dsh plugin --profile web remove dsh-approve-for-me
```

Restart safely using host management, then reload the page. Confirm the plugin is disabled or removed, standard presets are selectable, and ordinary sessions work. Restart services from outside their process tree. Deleting a source link is not a formal uninstall.

### 9.2 Recognize the two retained-configuration cases

Changing the default permission preset in host settings while this plugin is installed makes the host save a snapshot of the whole preset table into user configuration. The plugin does not automatically clean user YAML. An installation that never changed the default does not create that user-layer entry.

| Case | Symptoms and effect | Action |
| --- | --- | --- |
| User configuration still contains `auto-approve` | “自动审批” (`auto-approve`) remains visible and selectable after plugin removal. It behaves as ordinary Workspace write, without this plugin's review | Choose a standard preset. For complete cleanup, remove only this entry as described below |
| Default still names `auto-approve`, but the table no longer contains it | Permission settings cannot load: the Permission row disappears, the preset catalog is unavailable, and logs say `unknown preset`. Sessions can still be created | Restore the backup, or change `defaultPreset` in the same configuration to an existing standard preset, such as `workspace-write` |

A visible entry does not mean the plugin is still running. Do not remove the entry merely to hide it while leaving an invalid default reference.

### 9.3 Remove only the plugin entry and recover failures

Before editing, stop the host or establish that no settings writes are underway, and retain a backup. Settings writes persist immediately; do not edit concurrently.

1. Confirm the default is a standard preset. If settings work, use Open configuration file in the settings-page header to locate the real user file. Otherwise, have the administrator locate `profiles/<profile-name>/cordis.patch.yml`.
2. In the `- id: permission` row's `config.presets`, remove only `auto-approve:` and its indented children. Preserve all other presets, default selection, and unrelated rows.
3. Start or reload safely. Confirm permission settings, standard presets, and sessions work.
4. If this fails, restore the backup first. If an invalid default reference is confirmed, set `defaultPreset` to an existing standard preset. Do not delete the whole user configuration.

If unsure of the edit scope, settings remain unavailable, or recovery fails, retain the backup and redacted host logs for the maintainer. Do not keep trying bulk configuration deletion.

### 9.4 Removing plugin data

Disabling or uninstalling preserves `$DSH_HOME/approve-for-me/`, or `~/.dsh/approve-for-me/` when `DSH_HOME` is unset. To erase it deliberately, stop every host using that directory and back it up first, then delete only that plugin data directory. Review records and session model choices are lost together; uninstall cannot restore them.

## License

See the [MIT license](<../LICENSE>), [third-party notices](<../NOTICE>), and [Apache-2.0 license](<../LICENSES/Apache-2.0.txt>).
