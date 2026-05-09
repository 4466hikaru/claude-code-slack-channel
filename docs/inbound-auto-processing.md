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

Hikaru wants `[abort-test]`, `[abort]`, `[abort cleanup]`, `status?`,
and `prs?` to be processed immediately. For these specific prefixes
we run a separate watcher process that polls Slack Web API directly
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

| trigger | action | reply |
|---|---|---|
| `[abort-test]` | `touch` + verify + `rm -f` cycle on the abort flag | `abort-test 完了、cleanup OK` (or specific failure message) |
| `[abort cleanup]` | `rm -f` on the abort flag (if present) | `abort cleanup OK` (or `nothing to do`) |
| `[abort]` | alias for `[abort cleanup]` | same as `[abort cleanup]` |
| `status?` | report watcher / state dir / abort-flag presence | multi-line status text |
| `prs?` | run `gh pr list --repo 4466hikaru/claude-code-slack-channel --state open` | formatted PR list |

Prefix matching is `startsWith` after trimming leading whitespace.
Order is significant: `[abort cleanup]` is checked before `[abort]`
so the longer prefix wins.

## Authorization

Only messages whose Slack `user` field equals the configured
`hikaruUserId` are honored. All other senders are silently ignored at
the gate. The watcher does **not** consult the prod bridge's
`access.json` allowlist — it has its own narrow, hardcoded
authorization scope.

## Destructive ops

The watcher's only authorized destructive operation is `rm -f` on
this exact path:

```
/home/hikaru/projects/hikaru-agent-knowledge/handoff/abort-lv2
```

Hardcoded as a `const ABORT_FLAG` in
[`scripts/inbound-watcher.ts`](../scripts/inbound-watcher.ts), **not**
overridable from config or env. No other rm, no `rm -rf`, no other
destructive ops are reachable from any trigger.

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
| `pollIntervalMs` | no | poll cadence; defaults to `5000` |

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
4. From Slack DM, send: `[abort-test]`
5. Within `pollIntervalMs`, the watcher logs:
   ```
   [watcher] trigger=[abort-test] ts=... thread=...
   ```
   And replies in the DM thread:
   ```
   abort-test 完了、cleanup OK
   ```
6. Verify cleanup — the abort flag must not exist:
   ```bash
   test ! -e /home/hikaru/projects/hikaru-agent-knowledge/handoff/abort-lv2 && echo OK
   ```

If step 5 doesn't fire, capture watcher stdout and `cat
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
- **WSL-only host.** The hardcoded abort-flag path assumes WSL
  semantics. Running the watcher on Windows native is not in scope
  for this iteration.
- **Polling, not push.** Latency is bounded by `pollIntervalMs`
  (default 5 s).
