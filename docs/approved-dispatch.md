# Approved Codex → Claude Outbox Dispatch (Phase 1)

How drafts written by Codex into the outbox get explicitly approved by
Hikaru and dispatched into Slack. Phase 1 implementation per bd issue
[`ccsc-81q`](https://github.com/4466hikaru/claude-code-slack-channel/issues/18).

## Why a separate path from `[codex-review]`

`[codex-review]` (Phase 1 inbound queue) is **write-only into**
`handoff/codex-review-queue/` — Hikaru sends a Slack DM and a queue
entry is created.

`[approved-dispatch]` (this feature) is **send-out** from
`handoff/from-codex/` — Codex writes a draft, Hikaru approves it via
Slack, the watcher relays the body to a target Slack channel after a
short grace period.

The two paths use different directories, different Slack triggers, and
have different sender allowlists. They do not interact.

## Outbox directory

**Absolute path** (hardcoded, not env-configurable in production):

```
/home/hikaru/projects/hikaru-agent-knowledge/handoff/from-codex/
```

Codex writes one draft per file with a YAML frontmatter and a
free-text body that becomes the dispatched Slack message.

## Frontmatter (flat, watcher-parseable)

```yaml
---
created_at: "2026-05-10T01:00:00.000Z"
source: "codex"
target_role: "consultant"          # consultant | executor
target_channel: "slack_dm"          # slack_dm | handoff
priority: "normal"                  # normal | urgent
draft_id: "01HXY..."                # ULID — idempotency key
status: "pending"                   # pending | approved | sent | failed | cancelled
approval_required: "true"
slack_chat_id: "D..."               # Slack DM / channel id
slack_thread_ts: "1.1"              # required for bare-`OK` thread match
ttl: "30m"                          # accepted units: ms | s | m | h
---
<body lines that become the dispatched message>
```

The watcher's parser is the same flat key/value reader used elsewhere
(`scripts/inbound-watcher.ts` / `parseFrontmatterFile`). No new YAML
dependency is added. Files that miss required fields (`draft_id`,
`status`, `created_at`) are silently skipped — the watcher never
crashes on a malformed draft.

## State machine

```
              [Slack OK / approve <id>]
   pending ─────────────────────────────►  approved
      │                                       │
      │ (TTL expires)                          │ (cancel within 5s grace)
      ├──────────────► cancelled  ◄────────────┤
      │                                       │
      │ (cancel)                               │ (5s grace + abort flag absent)
      └──────────────► cancelled               │
                                                ▼
                                              sent / failed
```

- `pending → approved` is set by the bare `OK` resolver or the
  explicit `approve <draft-id>` handler.
- `approved → sent` is performed by `dispatchSweep()` once the 5-second
  grace window has elapsed AND the abort flag is absent. The dispatch
  posts `body` to `slack_chat_id` (optionally in `slack_thread_ts`).
- `approved → cancelled` is allowed only inside the grace window.
  Outside the window the cancel handler returns "too late".
- `pending → cancelled` happens when TTL expires (auto-sweep) or
  Hikaru sends `cancel <draft-id>`.
- `sent` / `failed` / `cancelled` are terminal — subsequent OK /
  approve / cancel return idempotent no-op replies.

## Authorization

Per-trigger gate (`isAllowedSender`):

| trigger | who can send |
|---|---|
| `OK` / `approve` / `cancel` / `pending?` | **Hikaru only** (not on the codex-review allowlist) |
| `[codex-review]` | Hikaru + `codexReviewSenderUserIds` |
| Other 5 triggers | Hikaru only |

## Slack trigger reference

| trigger | shape | reply (success) | reply (rejection) |
|---|---|---|---|
| `OK` | bare 2-letter word, requires word boundary | `approved <draft-id>, dispatch 中 (grace 5000ms)` | `OK ambiguous (<reason>): use approve <draft-id> from below: ...` (with up to 5 candidates) or `OK: no pending drafts.` |
| `approve <draft-id>` | verb + ULID-ish token | `approved <id>, dispatch 中 (grace ...)` | `approve: <id> not found / already <status>` |
| `cancel <draft-id>` | verb + token | `cancelled <id>` (within grace) or `cancelled <id> (within grace)` | `cancel: too late, <id> already sent` / `cancel: <id> grace expired (will dispatch on next sweep)` |
| `pending?` | suffix `?` | `pending:\n  <id>: <summary>\n  ...` (max 5) | `pending: (no pending drafts)` |

`OK` requires **all three** conditions to approve:

1. Exactly 1 pending draft in the outbox.
2. That draft is within its TTL.
3. Its `slack_thread_ts` matches the Slack thread the OK was sent in.

If any condition fails, the watcher replies with the candidate list
and asks for an explicit `approve <draft-id>`. There is no
"oldest-wins" auto-approval.

## Idempotency

The `draft_id` (ULID) is the dedup key. Approve / cancel are
idempotent at the granularity of the entry's current state:

- approve a `pending` → flips to `approved`
- approve an `approved` → no-op + warn reply
- approve a `sent` / `cancelled` / `failed` → warn reply, no transition
- cancel rules are symmetric

Duplicate `draft_id` files are detected by `findDuplicateDraftIds` and
logged to stderr. Phase 1 keeps both files (the watcher does not
delete; that is Phase 3 archive work).

## Abort flag interaction

If `/home/hikaru/projects/hikaru-agent-knowledge/handoff/abort-lv2`
exists at sweep time:

- **Pending** drafts continue to be received and can transition to
  `approved` normally — the abort flag does not block approval.
- **Approved** drafts are **held** (not dispatched). They remain in
  `approved` status. When `[abort cleanup]` removes the flag, the
  next sweep dispatches them (provided they have not exceeded their
  TTL since approval — TTL applies to pending only, so approved
  entries dispatch unconditionally once the abort clears).

This matches `bd ccsc-81q` D5: "abort 解除後 (`[abort cleanup]`) は保留
中の `approved` を順次 dispatch".

## Operational ops

- **Run** the watcher as before (`bun scripts/inbound-watcher.ts`); the
  outbox sweep is integrated into the main poll loop. No separate
  daemon.
- **Codex side**: write `<draft-id>.md` files into the outbox dir with
  the schema above. The watcher picks them up on the next sweep
  (≤ `pollIntervalMs`).
- **Hikaru side**: send `OK` / `approve <id>` / `cancel <id>` /
  `pending?` from the configured Slack DM channel.
- **Audit trail**: each transition rewrites the file in place,
  preserving `created_at` / `draft_id` / `body` and adding
  `approved_at` / `cancelled_at` / `sent_at` / `failed_at` /
  `failure_reason` as appropriate.

## Limitations / non-goals (Phase 1)

- **No multi-user approval**: single Hikaru only.
- **No G2 UI integration**: that is `docs/g2-codex-control-mvp.md`
  scope; this feature is the bridge-side receiver only.
- **No automatic Codex review**: Codex actions stay manually triggered.
- **No `status?` outbox count**: deferred to Phase 2.
- **No archive automation**: `sent` / `cancelled` / `failed` files
  remain in the outbox dir until manual cleanup. Phase 3 will move
  them to `processed/`.
- **No failure replay**: `failed` is terminal in Phase 1; Phase 3 may
  add automatic retry.
