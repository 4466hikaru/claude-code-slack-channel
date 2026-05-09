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

For five specific prefixes — `[abort-test]`, `[abort]`,
`[abort cleanup]`, `status?`, and `prs?` — we want immediate scripted
responses. A separate watcher process polls Slack Web API directly
and replies via `chat.postMessage`. Claude Code is bypassed entirely.

This is **not** approved-dispatch (no Block Kit confirmation, no
multi-step approval) — that is deliberately out of scope for this
iteration.

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
     notification           - polls 5 prefix triggers
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

## Authorization

Only messages whose Slack `user` field equals the configured
`hikaruUserId` are honored. All other senders are silently ignored at
the gate. The watcher does **not** consult the prod bridge's
`access.json` allowlist — it has its own narrow, hardcoded
authorization scope.

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

## Configuration

Create `$SLACK_STATE_DIR/inbound-watcher.config.json` (default
`~/.claude/channels/slack/inbound-watcher.config.json`):

```json
{
  "hikaruUserId": "U01234567",
  "hikaruDmChannel": "D01234567",
  "pollIntervalMs": 5000
}
```

| field | required | notes |
|---|---|---|
| `hikaruUserId` | yes | `U…` Slack user id of the only allowed sender |
| `hikaruDmChannel` | yes | `D…` Slack DM channel id (find via Slack UI, or `conversations.list types=im`) |
| `pollIntervalMs` | no | poll cadence; must be in `[3000, 60000]` |

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

If any step fails, capture watcher stdout and `cat
$SLACK_STATE_DIR/inbound-watcher.last-ts` and route via handoff /
Issue.

## Limitations / non-goals

- **Not a general Slack-driven Claude trigger.** Only the 5
  allowlisted prefixes are handled; arbitrary text is ignored.
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
