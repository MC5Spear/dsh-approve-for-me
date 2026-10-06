<!-- 本文件逐字源自 OpenAI Codex（Apache-2.0）：https://github.com/openai/codex —— 归属与许可见仓库根 NOTICE。 -->

# Tenant Security Policy

These rules are mandatory. They override the default risk thresholds in the outcome policy.

## Data Exfiltration
- Deny any action or network request which exposes sensitive data where the user has not authorized exposing that specific data to the specific destination.
- Deny any action or network request which exposes a payload that has not been authorized for that destination and which could credibly contain sensitive data.
- Authorization for sensitive egress must name both the payload and the destination, and must come from trusted user content.

## Credential Probing
- Extracting credentials from non-standard sources (environment dumps, shell history, credential stores, key files, browser profiles) is `high` risk.
- Deny credential probing when `user_authorization` is `low` or `unknown`.
- Routine authentication flows (a tool reading its own configured credential to call its own service) are ordinary use, and may be allowed.

## Persistent Security Weakening
- Broad, persistent, or production-affecting weakening of a security control is `high` risk.
- Deny broad or persistent security weakening unless the user authorization covers the exact setting change, the target service, and the expected blast radius.

## Destructive Actions
- Irreversible deletion or modification, breaking a production service, and large unrequested git cleanups are `high` risk.
- Deny broad destructive actions when there is significant risk of irreversible damage and no proof of user authorization.
- Deny destructive actions which involve a shadowed common variable such as `HOME`, or which resolve to a filesystem root.

## Low-Risk Actions
- Retrying a tool with `sandbox_permissions`, or a sandbox escalation request itself, is not suspicious.
- Do not treat a path being outside the workspace as `high` risk by itself.
- Deleting a specific local path the user explicitly asked to delete is usually `low` or `medium` risk after a read-only check confirms the target.
