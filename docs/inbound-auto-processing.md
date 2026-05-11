# Inbound Auto-Processing

How a small set of allowlisted Slack DM prefixes are processed
immediately, without waking Claude Code.

## Why this exists

`server.ts` delivers each inbound DM to Claude Code via an MCP
notification (`notifications/claude/channel`, fired from
`deliverEvent` near the end of `handleMessage`). MCP notifications
are server-initiated and one-way: the message lands in the receiving
Claude Code session as a `<channel source="slack" ...>` tag in its
context, but **Claude Code does not generate a response without a
user turn**. An idle session stays idle.

For twelve specific prefixes — `[abort-test]`, `[abort]`,
`[abort cleanup]`, `[codex-review]`, `/new-project`, `[新規]`,
`OK`, `approve <draft-id>`, `cancel <draft-id>`, `pending?`,
`status?`, and `prs?` — we want immediate scripted responses. A
separate watcher process polls Slack Web API directly and replies
via `chat.postMessage`. Claude Code is bypassed entirely.

`[codex-review]` performs a queue WRITE only; the actual Codex review
/ merge stays human-gated (Phase 1 of the codex-review-queue design).

`/new-project` and `[新規]` (= aliases) write a project-request file
to `handoff/project-requests/` (Phase 1 of the new-project-bootstrap
design, bd `ccsc-54g`). Repo creation / Codex brief / approved
dispatch are Phase 2+ and NOT triggered here.

`OK` / `approve <id>` / `cancel <id>` / `pending?` are the **Phase 1
approved Codex outbox dispatch** path: Codex writes drafts under
`handoff/from-codex/`, Hikaru approves via Slack, and the watcher
dispatches the body to a target Slack channel after a 5s grace
window. See [`approved-dispatch.md`](approved-dispatch.md) for the
full state machine, frontmatter shape, and grace / abort interaction.

The watcher does **not** implement Block Kit confirmations or
multi-step approval; bare `OK` requires three independent conditions
(unique pending + TTL + thread match) to gate the action.

### `/new-project` + `[新規]` request queue (bd ccsc-54g)

Inbound `/new-project <body>` (case-insensitive) or `[新規] <body>`
(Japanese alias) writes a flat YAML frontmatter file to

```
/home/hikaru/projects/hikaru-agent-knowledge/handoff/project-requests/
```

with `type: project-request`, a fresh ULID `request_id`,
`status: drafting`, the Slack `chat_id` / `message_id` / `thread_ts`
of the originating message, `raw_prefix` (`/new-project` or
`[新規]`), and brief fields (`project_name` / `project_type`) set to
`null` for Phase 2 (Codex brief) to fill in. The body of the Slack
message is transcribed verbatim (less the prefix and one optional
space separator) into the file body.

The watcher then posts a Slack ack reply in the same thread:

```
📋 project request 起票済
  id: <request_id>
  status: drafting
  次: Codex の brief 起草を待つ (= Phase 2)
```

Phase 1 deliberately stops here. Repo creation (`gh repo create`),
Codex brief generation, approved dispatch entry, and the executor
initial PR all live in later phases and are NOT triggered by this
prefix.

Failure modes:

- **abort flag present**: skip + reply (= existing flag semantics
  honoured, no exceptions).
- **empty body** (= prefix only): reply prompt asking for at least
  one line of content; no queue write.
- **body > 8 KB**: UTF-8-safe truncate at 8192 bytes; ack flags
  the truncation.
- **token-like content** (= `Bearer ` / `xoxb-` / `xapp-` / `sk-` /
  `ghp_` / `ghs_`): sanitize with `[REDACTED:<name>]` before writing,
  ack flags which patterns fired. The raw secret never reaches the
  queue file or the Slack ack.
- **same Slack `message_id` already queued**: idempotent no-op
  reply (= covers re-presentation after a watcher restart with an
  earlier `lastTs`).
- **mkdir / write failure**: reply with the error message, no
  retry (= Hikaru is expected to re-send when the cause is fixed).

The file is written via tmp-then-rename for atomicity, matching the
existing `from-execute/processed/` archive convention.

### Project channel model Phase 1 (bd ccsc-l34)

Phase 1 of the project-channel-model design wires two pieces:

**A. Queue file schema extension.** Each `/new-project` / `[新規]`
write now includes 7 additional flat-YAML fields alongside the
ccsc-54g fields, so Phase 2 (manual brief) and Phase 3 (repo create)
have a place to record channel state and template provenance:

```yaml
# === project channel model (Phase 1 = all null/default; Phase 2+ fills them) ===
project_channel_id: null            # Slack channel id (C...) — filled by Phase 2 after Hikaru manually creates `proj-<name>`
project_channel_name: null          # `proj-<project_name>` — filled by Phase 2
source_channel_id: <inbound chat_id>  # re-tag of `slack_chat_id` under the channel-model namespace
source_channel_type: dm | project-channel | unknown
                                    # D... → "dm" / C... → "project-channel" / else → "unknown"
template_source: blank              # `blank` default; Phase 2 brief may switch to `tracaverse` / other
reference_repo: null                # e.g. `4466hikaru/tracaverse` — filled by Phase 2
target_repo_name: null              # derived from `project_name` — filled by Phase 2
```

`source_channel_type` is derived from the chat_id's first character
(`D` = DM, `C` = project channel, anything else = `unknown`). No
`conversations.info` API call is made — Phase 2/B may refine via a
queue-side `project_channel_id` registry. When the value is
`unknown` the ack reply appends one extra line asking Hikaru to
verify.

The existing flat-YAML parser is forward-compatible — old queue files
without these 7 fields parse without error, and the channel handlers
only read what they need.

**B. Project-channel inbound routing.** The dispatch layer learns
six mutually-exclusive routing decisions, returned by the pure
helper `routeInboundMessage(text, chatId)`. Decisions are evaluated
**in this priority order** so the emergency `[abort]` signal cannot
be silently dropped on an unrecognized channel:

1. `dm-passthrough` (DM)
2. `channel-abort` (= **ANY non-DM** with `[abort]`)
3. `unknown-channel-noop` (= `G...` / empty / malformed AND not `[abort]`)
4. `channel-warn` / `channel-passthrough` / `channel-noop` (= `C...` only)

| decision | trigger | action |
|---|---|---|
| `dm-passthrough` | `chat_id` is DM | existing dispatch path (regression-free) |
| `channel-abort` | **any non-DM** chat_id (`C...` / `G...` / empty / malformed) + `[abort]` (exact, case-insensitive) | touch `handoff/abort-lv2` + reply in channel (when replyable) + dual-notify Hikaru's DM |
| `channel-warn` | `chat_id` is `C...` (project-channel) + non-emergency ops prefix (13 listed) | 1-line warning, redirect user to DM, log; no handler/subagent fires |
| `channel-passthrough` | `chat_id` is `C...` + post-through verb (`approve` / `approve-impl` / `cancel` / `cancel-impl` / `OK`) | silent — consultation session reads via MCP |
| `channel-noop` | `chat_id` is `C...` + anything else | silent (no watcher action) |
| `unknown-channel-noop` | `chat_id` is `G...` / empty / malformed **AND** text is NOT `[abort]` | silent + log at dispatch layer |

Why the priority pin: an operator typing `[abort]` from an
unrecognized channel (group DM, malformed id, etc.) must still
trigger the global stop. The DM leg of the dual notify is
unconditional (we own that channel) so Hikaru sees the event even
when the source channel is not replyable — but `handoff/abort-lv2`
gets touched in any case. Codex review on PR #9 flagged the earlier
ordering (`unknown-channel-noop` before `[abort]`) as a merge
blocker for exactly this reason; the corrected priority is pinned by
unit tests so it cannot regress.

The non-emergency ops set covers:
`[abort-test]` / `[abort cleanup]` / `[codex-review]` /
`[整理]` / `[tech]` / `[product]` / `[bizdev]` /
`[marketing]` / `[ops]` / `[brainstorm]` /
`status?` / `prs?` / `pending?`. `[abort-test]` and
`[abort cleanup]` stay DM-only by design (= safer to make the user
acknowledge they're in the right context). On a `C...` channel they
fall into `channel-warn`; on a `G...`/malformed channel they fall to
`unknown-channel-noop` (silent) since the `[abort]` exception only
matches the exact `[abort]` prefix, not the longer `[abort-*]` /
`[abort cleanup]` siblings.

Phase 1 production polling stays DM-only, so every real-world call
returns `dm-passthrough` today. The channel-handler code is exercised
via unit tests and is ready for Phase 2 multi-channel polling to
flip on. The `[abort]` flag-file mechanism itself
(`handoff/abort-lv2`) is unchanged — the channel branch is a thin
wrapper that touches the same path the DM `[abort]` handler touches,
then layers the dual notify.

### Project channel registry loader (bd ccsc-a04, Phase 2A)

`scripts/lib/project-channel-registry.ts` exports
`loadActiveProjectChannels(queueDir)` — a pure function that scans
the `/new-project` queue dir and returns the list of project
channels currently considered **active**:

```
/home/hikaru/projects/hikaru-agent-knowledge/handoff/project-requests/
```

The loader is the authoritative entry point for "which Slack
channels does the watcher need to know about?" The queue file
frontmatter (set by `ccsc-54g` / extended in `ccsc-l34`) is the
single source of truth — no secondary registry / DB is consulted.

```typescript
interface ActiveProjectChannel {
  request_id: string
  project_channel_id: string         // C... non-empty (guaranteed)
  project_channel_name: string | null
  project_channel_status: string | null  // never "archived"|"cancelled"|"failed"
  created_at: string
  source_path: string                // debug only
}

interface RegistryLoadResult {
  active: ActiveProjectChannel[]
  malformed_count: number            // parse failure + non-`C...` id
  duplicate_skip_count: number       // same channel id covered by newer file
  total_files: number
}
```

**Active criteria** (= a queue file appears in `active` iff all hold):

- `project_channel_id` is a non-empty string starting with `C` (=
  Slack channel id heuristic; `D` / `G` / other prefixes are
  rejected as malformed). Null / missing / empty is the expected
  *not-yet-active* state — it is NOT counted as malformed because
  Phase 1 queue files write `null` until Hikaru creates the
  channel manually.
- `project_channel_status` is NOT `archived` / `cancelled` /
  `failed`. `pending` / `active` / null are all kept (= the id
  presence is what makes a channel pollable; the status field
  tracks the Phase 2 brief workflow separately).

**Duplicate handling.** When two queue files share the same
`project_channel_id`, the one with the latest `created_at` wins;
others are dropped and counted in `duplicate_skip_count`. Ties on
`created_at` (= both missing) fall back to alphabetical filename
order so the result is deterministic across platforms.

**Contracts.** The loader is side-effect-free (no Slack API call,
no state-file write, no caching across invocations) and never
throws — failures surface via the numeric counters so the caller
can log / alert without trying to introspect exceptions.

**Phase 2A only.** This module is loader-only. The watcher polling
loop does NOT call `loadActiveProjectChannels` yet — Phase 2B
(multi-channel polling + per-channel `last-ts` persistence) and
Phase 2C (route wire-up of `routeInboundMessage` into the loop)
will land in separate bd issues / PRs. Until then this file is
dead code in production and is exercised only by unit tests.

### Executor completion relay (bd ccsc-sbf)

Passive-execution Claude sessions cannot post to Slack themselves
(no MCP `reply`, no bridge ownership). They drop a `done-*.md` file
into

```
/home/hikaru/projects/hikaru-agent-knowledge/handoff/from-execute/
```

with a flat YAML frontmatter — `type: done`, `done_id`,
`status: complete|blocked|failed`, `summary`, and optional
`related_bd` / `related_pr` / `executor_session` / `needs_review` —
and the watcher relays the body to Hikaru's main DM as
`✅ 実行役完了: <summary>` on the next sweep, then atomically moves
the file into `handoff/from-execute/processed/`. The dedup key is
`done_id` (5-minute sliding window covers the rare race where Slack
post succeeded but archive failed). Files matching `done-*.md` but
failing interpret are logged and left in place. Other types in the
same dir (`result` / `propose` / `progress` / `ask` for the
consultation coordinator) are not touched by this relay. Token guard
runs on `summary + body` before relay; raw secret hits log + skip.

### Mobile Codex Relay Phase 1 (bd ccsc-nwm)

Hikaru がスマホ / G2 / Slack DM から自然文で投げた相談を、コピペなしで
Codex に届けるための watcher 拡張。3 stream の delta:

**A. DM 自然文 → consult queue write.** 既存 reserved prefix (= `status?`
/ `prs?` / `pending?` / `[abort*]` / `[tech]` ... / `[新規]` / `[実行]` /
`[codex-review]` / `approve <id>` / `cancel <id>` 等) と match しない、
かつ bare token (= `OK`、`approve` 単独 等) でもない DM は `consult-
request` と判定。5+ char で `handoff/codex-consult-queue/<id>.md` に flat
YAML frontmatter で起票。短文 (5-14 char) は `risk_guess: ambiguous` を
立てる、空 / 1-4 char は ignore。

同 thread (= `slack_thread_ts` 一致) に **active な** consult queue
file (= `status: pending` または `planned`) があれば、新規 file は作らず
継続発話として `## continuation log` セクションに追記する (= terminal
status のときだけ新規起票)。idempotency は `slack_message_id` 一致で
no-op。token 検出時は body を `[REDACTED:...]` に置換し ack に名前のみ
通知 (= raw 値は queue file / Slack / log のいずれにも残さない)。

**B. `handoff/from-codex/` polling → Slack thread reply.** Codex が手動
で書く `type: codex-plan` + `status: ready` の plan file を polling tick
で scan、approved-dispatch outbox draft (= `draft_id` 持ち) とは
`type: codex-plan` で区別。short format (= 500-1000 char、3 ブロック)
を組み立てて `slack_chat_id` + `slack_thread_ts` 同 thread に reply、
post 成功で plan file `status: acknowledged` + 紐づく consult queue
`status: planned` + `codex_plan_ref` 同期更新。post 失敗時は file 不変
で次 sweep retry、5-min sliding window で plan_id dedup。

**C. Hikaru thread reply parse.** consult queue が `planned` な thread
への Hikaru thread reply は consult reply parser で解釈:

| 入力 | 結果 | reply |
|---|---|---|
| `approve <consult_id>` (= exact match) | `status: approved` | `✅ approved` |
| 自然文 imperative (= `進めて` / `OK 進めて` / `やってください` / `実行して`) | 同上 | 同上 |
| `abort <consult_id>` / `やめて` / `中止` / `cancel` (bare) | `status: cancelled` | `❌ cancelled` |
| permissive (= bare `OK` / `approve してよい` / `任せる`) | **status 変更せず** | confirm prompt (= imperative directive を要求) |
| consult_id mismatch (= `approve OTHER`) | status 変更せず | 「`approve <thread の consult_id>` で再返信」 |
| 自然文 (= 5+ char、上記いずれにも match しない) | `continuation log` 追記 + `status: pending` に戻す | 「修正受領、Codex に再起草要請」 |
| 空 / 4 char 以下 fragment | none (= 無視) | (なし) |

permissive の status 据置 + confirm prompt は `feedback_no_merge_by_claude.md`
の "imperative directive 必須" ルールを Phase 1 で適用したもの。bare `OK`
で勝手に approved に進めない。

**Phase 1 で実装しない** (= 別 Phase 設計):
- Codex side の automation polling (= Codex が queue を自動 pick + plan
  起草、Phase 2)
- `approved` → executor / approved-dispatch outbox への接続 (= Phase 3、
  本 Phase 1 では `status: approved` の queue file を残すまで)
- G2 / mobile 短文 UX の復唱 phrase (= Phase 4)
- project channel 経由の consult (= 本 Phase 1 は DM 限定、`source_channel_type`
  は記録のみ)

`[abort]` flag ON 中は本 Phase 1 の全 subroutine (= consult queue write
/ plan reply sweep / consult reply parse) も停止 (= 既存 flag 尊重)。

### Thread-reply polling (bd ccsc-v5m)

`conversations.history` only returns top-level DM messages, so a
Slack reply typed INSIDE a thread the watcher previously posted into
would never reach `handleApprove` / `handleCancel`. The watcher
maintains a small in-memory tracker of every threadTs it has replied
into (persisted to `$SLACK_STATE_DIR/inbound-watcher.active-threads.json`,
15-minute TTL) and polls each tracked thread via
`conversations.replies` on every main-loop tick.

Thread-reply polling **only fires the approved-dispatch verbs**
(`OK` / `approve` / `cancel` / `pending?`). `[abort]` /
`[abort-test]` / `[abort cleanup]` / `[codex-review]` / `status?` /
`prs?` stay main-DM-only to prevent thread-injection misfire. The
sender gate is unchanged — dispatch verbs are Hikaru-only regardless
of whether the message arrives via main DM or thread reply.

## Architecture

```
                Slack workspace
                       ↕
            ┌──────────┴──────────┐
            │                     │
   Socket Mode (single)     Web API only:
   (prod bridge owner)      conversations.history (poll)
            │               chat.postMessage (reply)
            ↓                     │
   server.ts                      ↓
   - inbound DM → MCP      inbound-watcher (separate process)
     notification           - polls 6 prefix triggers
   - delivered to Claude    - runs scripted handler
     Code (idle => no       - replies in-thread
     auto-wake)             - never opens Socket Mode
```

The watcher and the prod bridge share the same bot token (read from
`$SLACK_STATE_DIR/.env`). Slack accepts concurrent Web API calls
under a single bot identity. The watcher does **not** open Socket
Mode, so the prod bridge keeps its singular connection.

## Allowlisted triggers

| trigger | action | reply (success path) |
|---|---|---|
| `[abort-test]` | `touch` + verify + `rm -f` + verify-absent on the abort flag | `abort-test 完了、cleanup OK` |
| `[abort]` | `touch` + verify on the abort flag (**create / raise**) | `abort flag created at <path>` |
| `[abort cleanup]` | `rm -f` + verify-absent on the abort flag | `abort cleanup OK` |
| `[codex-review]` | parse args (3 forms), reject token-like raw secrets, write/update YAML frontmatter file in the codex-review queue dir | `Codex review queue に登録済み (key=<...>, queue size: N)` |
| `/new-project <body>` | strip prefix + one optional space, truncate to 8 KB, sanitize token-like content, write `type: project-request` frontmatter file in `handoff/project-requests/` | `📋 project request 起票済\n  id: <ulid>\n  status: drafting\n  次: Codex の brief 起草を待つ (= Phase 2)` |
| `[新規] <body>` | Japanese alias of `/new-project`; same handler, `raw_prefix: "[新規]"` recorded | same as above |
| `OK` | resolve unique pending Codex outbox draft (3 conditions), flip status to `approved` | `approved <id>, dispatch 中 (grace 5000ms)` or candidate list / `OK: no pending` |
| `approve <draft-id>` | explicit approve of a specific outbox draft (idempotent) | `approved <id>, dispatch 中 (grace ...)` or `approve: <id> not found / already <status>` |
| `cancel <draft-id>` | cancel pending draft, or approved draft within 5s grace | `cancelled <id>` or `cancel: too late, <id> already sent` |
| `pending?` | list up to 5 pending Codex outbox drafts (oldest first) | `pending:\n  <id>: <summary>\n ...` |
| `status?` | report watcher / abort-flag / open PR count / blocker | 5-line status text |
| `prs?` | run `gh pr list --state open` against the 3 active repos and merge results | formatted PR list, max 5 entries total |

Prefix matching is `startsWith` after **trimming leading whitespace
and lowercasing the input** (PR #8 Slack ops convention:
case-insensitive). `[ABORT-TEST]` / `[Abort-Test]` / `[abort-test]`
all resolve to the same canonical lowercase trigger. **Order
matters**: `[abort cleanup]` is checked before `[abort]` so the
longer prefix wins on a message like `[abort cleanup] foo`. The
`TRIGGERS` array order **and** the `routeTrigger` mapping are pinned
by `scripts/inbound-watcher.test.ts` so the `[abort]` /
`[abort cleanup]` semantics cannot accidentally flip back to the
v1-PR-#2 buggy alias-to-cleanup behavior.

### `[abort]` vs `[abort cleanup]` (do not confuse)

- `[abort]` **raises** the flag. It is the operational "halt" command.
  Idempotent: if the flag is already present, the handler replies
  `no-op` and does nothing.
- `[abort cleanup]` **removes** the flag. It is the recovery command.
  Idempotent: if the flag is absent, the handler replies
  `nothing to do`.
- `[abort-test]` exercises both, leaving the flag absent on success.

### Active repos surveyed by `prs?` and `status?`

```
4466hikaru/hikaru-agent-knowledge
4466hikaru/birth-kaitori
4466hikaru/claude-code-slack-channel
```

`prs?` lists at most **5 PRs total** across the three repos (in the
listed order). If more are open, the handler appends `(+N more)`. If
`gh` errors on a repo, the watcher reports the partial result with a
warning line.

## `[codex-review]` queue (Phase 1)

Implements the Phase 1 spec from bd issue `ccsc-9hm`. The watcher
parses the message body, refuses any token-like raw secret, then
writes a YAML frontmatter file to the **absolute** queue directory
(creates the dir on first write):

```
/home/hikaru/projects/hikaru-agent-knowledge/handoff/codex-review-queue/
```

### Three forms (case-insensitive prefix and keys)

```
[codex-review] pr=<github-pr-url> [role=<role>] summary=<text>
[codex-review] issue=<github-issue-url> [role=<role>] summary=<text>
[codex-review] repo=<owner/repo> pr=<number> [role=<role>] summary=<text>
```

- Exactly one space between the prefix and the args.
- `summary=` is always last; everything to end of line is the summary
  text (free-form, may contain spaces).
- The three forms are exclusive (e.g. `pr=` and `issue=` together is
  invalid).
- Optional `role=hikaru|consultant|executor|agent` (case-insensitive
  value). Invalid role -> format error. If omitted, the handler
  derives the role from the sender: `hikaru` when sender ==
  `hikaruUserId`, `agent` otherwise.
- Slack mrkdwn auto-link wraps URLs as `<url>` (and optionally
  `<url|display>`) when fetched via `conversations.history`. The
  parser strips the wrapper before applying the URL regex, so both
  raw and wrapped forms work. Whitespace inside `<...>` is also
  preserved during tokenization (display text may contain spaces).
- Unknown keys are rejected with format error.

### Frontmatter (8 required fields + Slack metadata)

```yaml
---
created_at: "2026-05-10T01:23:45.123Z"
source: "slack"
repo: "4466hikaru/birth-kaitori"
sender_role: "Hikaru"
sender_id: "U..."
chat_id: "D..."
message_ts: "1778318503.692249"
summary: "1-line free text"
status: "pending"
priority: "P3"
pr_number: 12          # form A / C only
# issue_url: "..."     # form B only (mutually exclusive with pr_number)
---
```

`pr_number` and `issue_url` are mutually exclusive (one of them is
required, never both). The Slack metadata (`sender_id` / `chat_id` /
`message_ts`) is recorded for audit and dedup-authorization but
contains no token / secret material.

### Token reject (Phase 1: reject-only, no masking)

If the message text matches any of the following patterns, the
watcher refuses to enqueue and replies with a format error. The
patterns are intentionally length-bound to avoid false positives on
common short words:

| pattern | example trigger |
|---|---|
| `xoxb-` | `xoxb-XXXXXXXXXXXXXXXXXXXX` |
| `xapp-` | `xapp-XXXXXXXXXXXXXXXXXXXX` |
| `sk-` (case-insensitive) | `sk-XXXXXXXXXXXXXXXXXXXX` |
| `Bearer ` (case-insensitive, ≥16 char body) | `Bearer XXXXXXXXXXXXXXXX` |
| `ghp_` | `ghp_XXXXXXXXXXXXXXXXXXXX` |
| `ghs_` | `ghs_XXXXXXXXXXXXXXXXXXXX` |

Masking (= scrub then enqueue) is **deferred to Phase 2 by design**
to keep the surface small and the failure mode unambiguous.

### Idempotent update

The dedup key for a request is:

- `<repo>#pr-<n>` for Form A (pr URL) and Form C (repo + pr number)
- `<repo>#issue-<n>` for Form B (issue URL)

If a queue entry with the same key already exists:

- Allowed updaters: the original sender's Slack `user_id` (recorded
  in the existing file's `sender_id` field) **or** the configured
  `hikaruUserId`. Any other sender gets a format error.
- The existing file is updated in place: `summary`, `message_ts` are
  refreshed and `status` is reset to `pending`. The original
  `created_at`, `sender_id`, `sender_role`, and any body content are
  preserved. The filename does not change.

If no entry exists yet, a new file is written with the canonical
filename:

```
<created_at-iso-no-colon>-<repo-with-/-replaced-by-_>-pr<n>.md
<created_at-iso-no-colon>-<repo-with-/-replaced-by-_>-issue<n>.md
```

(no `:` `*` `?` `<` `>` `|` `"` so the name is valid on Windows.)

### Queue size cap

- **> 20 active entries (= status `pending` or `blocked`)** → warning
  appended to the Slack reply (`⚠️ size > 20`). Entry is still
  written.
- **≥ 50 active entries** → reject. New entry is **not** written and
  the watcher replies with a format error explaining the cap.
- `reviewed` entries do not count toward the cap (= they are removed
  from the active queue).

## Authorization

The watcher gates per-trigger:

- **Hikaru-only**: `[abort-test]` / `[abort]` / `[abort cleanup]` /
  `status?` / `prs?`. The Slack `user` field must equal the
  configured `hikaruUserId`.
- **Allowlist (`codexReviewSenderUserIds`, default `[hikaruUserId]`)**:
  `[codex-review]` only. Lets the prod bridge bot, consultant
  session, executor session, etc. push completion reports directly
  to the queue without going through Hikaru's account.

All other senders are silently ignored at the gate. The watcher does
**not** consult the prod bridge's `access.json` allowlist — it has
its own narrow, hardcoded authorization scope.

## Destructive ops

The watcher manipulates exactly **one path**:

```
/home/hikaru/projects/hikaru-agent-knowledge/handoff/abort-lv2
```

Hardcoded as `const ABORT_FLAG` in
[`scripts/inbound-watcher.ts`](../scripts/inbound-watcher.ts), **not**
overridable from config or env. Operations on this path:

| trigger | op |
|---|---|
| `[abort]` | `touch` (write — create the flag) |
| `[abort-test]` | `touch` then `rm -f` (write + remove, paired) |
| `[abort cleanup]` | `rm -f` (remove the flag) |

No other rm, no `rm -rf`, no other writes, no other paths reachable
from any trigger.

The `[codex-review]` queue is a **separate write-only** location:

```
/home/hikaru/projects/hikaru-agent-knowledge/handoff/codex-review-queue/
```

The watcher only **writes** queue files there (creates new or
in-place updates existing). It never `rm`s or otherwise deletes from
this directory; lifecycle of `reviewed` entries is out of scope for
the watcher (Phase 3 of the codex-review-queue design).

## Configuration

Create `$SLACK_STATE_DIR/inbound-watcher.config.json` (default
`~/.claude/channels/slack/inbound-watcher.config.json`):

```json
{
  "hikaruUserId": "U01234567",
  "hikaruDmChannel": "D01234567",
  "pollIntervalMs": 5000,
  "codexReviewSenderUserIds": ["U01234567", "U_BRIDGE_BOT"]
}
```

| field | required | notes |
|---|---|---|
| `hikaruUserId` | yes | `U…` Slack user id of the only allowed sender for the Hikaru-only triggers |
| `hikaruDmChannel` | yes | `D…` Slack DM channel id (find via Slack UI, or `conversations.list types=im`) |
| `pollIntervalMs` | no | poll cadence; must be in `[3000, 60000]` |
| `codexReviewSenderUserIds` | no | extra Slack `U…` ids allowed to use **`[codex-review]`** (defaults to `[hikaruUserId]`). Validated `^U[A-Z0-9]+$` per entry. The 5 Hikaru-only triggers ignore this list. |

Out-of-range or non-finite `pollIntervalMs` (anything outside
`[3000, 60000]`, `NaN`, or infinity) is replaced with the default
`5000` and a stderr warning is logged. See `clampPollInterval` in
the script.

The watcher loads its bot token from `$SLACK_STATE_DIR/.env`
(`SLACK_BOT_TOKEN=…`) — the prod bridge's `.env`, read-only.

## Run

The watcher is a Bun TypeScript script. The hardcoded `ABORT_FLAG`
path is WSL-style (`/home/hikaru/...`), so launch from WSL where that
path resolves natively:

```bash
bun scripts/inbound-watcher.ts
```

State files written to `$SLACK_STATE_DIR/`:

| file | purpose |
|---|---|
| `inbound-watcher.config.json` | required config (see above) |
| `inbound-watcher.last-ts` | persists last-seen Slack `ts` so polls don't replay history on restart |
| `inbound-watcher.pid` | single-instance lockfile; refuses to start if another watcher is already running |

Stop with Ctrl-C. The loop exits between polls (latency up to one
`pollIntervalMs`).

Run alongside the prod bridge — they don't conflict.

## End-to-end verification

1. Start the prod bridge (Windows PowerShell):
   ```pwsh
   .\scripts\start-bridge-prod.ps1
   ```
2. Provision the watcher config (one-time): write
   `~/.claude/channels/slack/inbound-watcher.config.json` with your
   `hikaruUserId` and `hikaruDmChannel`.
3. In WSL, start the watcher:
   ```bash
   bun scripts/inbound-watcher.ts
   ```
   Expected stdout (single line):
   `[watcher] starting; channel=D... sender=U... pollMs=5000 lastTs=...`
4. From Slack DM, send: `[abort-test]`. Within `pollIntervalMs` the
   watcher logs `[watcher] trigger=[abort-test] ...` and replies in
   the DM thread `abort-test 完了、cleanup OK`. Verify cleanup:
   ```bash
   test ! -e /home/hikaru/projects/hikaru-agent-knowledge/handoff/abort-lv2 && echo OK
   ```
5. From Slack DM, send: `[abort]`. Watcher replies
   `abort flag created at /home/hikaru/.../abort-lv2`. Verify:
   ```bash
   test -e /home/hikaru/projects/hikaru-agent-knowledge/handoff/abort-lv2 && echo OK
   ```
6. From Slack DM, send: `[abort cleanup]`. Watcher replies
   `abort cleanup OK`. Verify:
   ```bash
   test ! -e /home/hikaru/projects/hikaru-agent-knowledge/handoff/abort-lv2 && echo OK
   ```
7. From Slack DM, send: `status?`. Watcher replies with 5 lines:
   `watcher: alive`, `abort flag: absent (or PRESENT) (...)`,
   `open PRs: <count>` or `unknown (gh error...)`, `blocker: unknown`.
8. From Slack DM, send: `prs?`. Watcher replies with up to 5 open PRs
   tagged `[hikaru-agent-knowledge]` / `[birth-kaitori]` /
   `[claude-code-slack-channel]`, with `(+N more)` appended if there
   are more.
9. From Slack DM, send:
   ```
   [codex-review] pr=https://github.com/4466hikaru/birth-kaitori/pull/12 summary=verify
   ```
   Watcher replies `Codex review queue に登録済み (key=4466hikaru/birth-kaitori#pr-12, queue size: 1)`.
   Verify the queue file exists:
   ```bash
   ls -la /home/hikaru/projects/hikaru-agent-knowledge/handoff/codex-review-queue/
   ```
   Re-send the same message → watcher replies `更新済み (...)` and the
   file count does not increase. Send a malformed `[codex-review] foo
   summary=bad` → watcher replies with a `format error: ...` line and
   no file is written.

If any step fails, capture watcher stdout and `cat
$SLACK_STATE_DIR/inbound-watcher.last-ts` and route via handoff /
Issue.

## Limitations / non-goals

- **Not a general Slack-driven Claude trigger.** Only the 6
  allowlisted prefixes are handled; arbitrary text is ignored.
- **`[codex-review]` is queue-write only (Phase 1).** The watcher
  does not run the actual Codex review or auto-merge. Codex
  automation, PR auto-pickup, `status?` pending-count integration,
  `reviewed` archive lifecycle, and token masking are explicitly
  Phase 2/3 follow-ups.
- **No approved-dispatch (yet).** Triggers run immediately under the
  hardcoded authorization. There is no Block Kit confirm step.
- **Watcher actions are not in `audit.log`.** The bridge's
  hash-chained audit log (`journal.ts`) only records the bridge's own
  events. The watcher logs to its own stdout and the Slack thread —
  treat those as the trail.
- **`status?` blocker is `unknown`.** No detection mechanism is
  implemented in this iteration. Blocker reporting will be added when
  a clear signal source exists (= a follow-up).
- **WSL-only host.** The hardcoded abort-flag path assumes WSL
  semantics. Running the watcher on Windows native is not in scope
  for this iteration.
- **Polling, not push.** Latency is bounded by `pollIntervalMs`
  (default 5 s; clamped to `[3000, 60000]`).
