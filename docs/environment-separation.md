# Environment Separation: prod / passive / dev

How to run multiple Claude Code sessions with the `slack-channel` MCP
server without crossing wires between **production Slack traffic**,
**execution-only work**, and **dev-app testing**.

## Why three modes

The slack-channel bridge holds a single Slack Socket Mode connection.
Running two bridge-enabled sessions against the same workspace causes
Slack to load-balance inbound events across the connected clients —
each session receives only a fraction, and per-thread context bounces.
The on-disk state (`~/.claude/channels/slack/{access.json,sessions/,audit.log,.env}`)
is also single-writer; concurrent processes can corrupt the audit chain.

Three roles with disjoint state directories:

| mode | env vars | state dir | Slack edge | role |
|---|---|---|---|---|
| **prod bridge** | (none) | `~/.claude/channels/slack` | owns prod Socket Mode | Hikaru ↔ Slack window |
| **passive execution** | `SLACK_BRIDGE_DISABLE=1` + `SLACK_STATE_DIR=~/.claude/channels/slack-passive` | `slack-passive/` (auto-created, placeholder `.env`) | none | impl / test / PR; Slack tools disabled |
| **dev bridge** | `SLACK_STATE_DIR=~/.claude/channels/slack-dev` | `slack-dev/` | owns dev Slack app's Socket Mode | feature dev with throwaway tokens |

### Why passive needs its own state dir

`server.ts` reads `.env` and validates Slack token format **at boot,
before** the `SLACK_BRIDGE_DISABLE=1` short-circuit. A session that
sets only `SLACK_BRIDGE_DISABLE=1` would still open the prod
`~/.claude/channels/slack/.env` to satisfy the boot-time check. The
passive launcher therefore also points `SLACK_STATE_DIR` at a
dedicated `~/.claude/channels/slack-passive/` and auto-creates a
placeholder `.env` (`xoxb-disabled` / `xapp-disabled`) on first run.
Passive mode never opens Socket Mode, so the placeholder tokens are
never transmitted; their only job is to satisfy the boot-time
prefix check.

## Invariants

1. **At most one bridge-enabled session per Slack workspace.** Two
   sessions both holding Socket Mode against the same app race for
   inbound events; one session silently drops some.
2. **Passive execution sessions never hold Slack edge AND never read
   or write prod state.** They use a dedicated
   `~/.claude/channels/slack-passive/` state dir with placeholder
   tokens (auto-provisioned by the launcher). Slack tool calls return
   `isError` stubs; route replies via the handoff filesystem channel,
   GitHub Issues, or by asking the prod bridge owner to relay.
3. **Dev sessions never read or write prod state.** Separate state
   dir, separate Slack app, separate `.env` / `access.json` /
   `sessions/` / `audit.log`. Sharing risks dev errors landing in the
   prod audit log (or vice-versa).

## Launchers

| script | mode | how it works |
|---|---|---|
| [`scripts/start-bridge-prod.ps1`](../scripts/start-bridge-prod.ps1) | prod bridge | clears any inherited `SLACK_BRIDGE_DISABLE` / `SLACK_STATE_DIR`; spawns plain `claude` so server.ts uses the default state dir |
| [`scripts/start-exec-passive.ps1`](../scripts/start-exec-passive.ps1) | passive execution | sets `SLACK_BRIDGE_DISABLE=1` and `SLACK_STATE_DIR=~/.claude/channels/slack-passive`; auto-creates the dir + placeholder `.env` (fake `xoxb-disabled` / `xapp-disabled` tokens) on first run; server.ts boots passive (no Socket Mode, no journal, no supervisor) |
| [`scripts/start-bridge-dev.ps1`](../scripts/start-bridge-dev.ps1) | dev bridge | sets `SLACK_STATE_DIR=~/.claude/channels/slack-dev`; refuses to launch until dev state dir is provisioned (skeleton — see TODO block in script) |
| [`scripts/claude-bridge-disabled.ps1`](../scripts/claude-bridge-disabled.ps1) | passive (legacy alias) | thin wrapper that forwards to `start-exec-passive.ps1`; preserved for muscle memory and existing scripted invocations |

All scripts pass `$ClaudeArgs` through to `claude`, e.g.
`./scripts/start-exec-passive.ps1 -- --resume`.

## Operator workflow

### Prod bridge (Hikaru's mobile / Slack window)

```pwsh
.\scripts\start-bridge-prod.ps1
```

This must be the only bridge-enabled session for the prod workspace.
On startup, server.ts uses the default state dir
(`~/.claude/channels/slack`) and announces its Socket Mode connection.

### Passive execution (Codex, Claude Code execution role, etc.)

```pwsh
.\scripts\start-exec-passive.ps1
```

Default for any session whose job is implementation, test, or PR — not
Slack I/O. The launcher sets `SLACK_BRIDGE_DISABLE=1` **and**
`SLACK_STATE_DIR=~/.claude/channels/slack-passive`, then auto-creates
the dir + placeholder `.env` if missing. server.ts reads `.env` at
boot (before the passive-mode short-circuit), so the dedicated state
dir is what keeps the prod `.env` / `access.json` / `sessions/` /
`audit.log` untouched. After boot, server.ts logs the passive-mode
banner and tool calls return `isError` stubs; the placeholder tokens
are never sent over the wire because passive mode never opens Socket
Mode.

In a passive session:

- Slack tool calls return `isError` stubs (no inbound, no outbound)
- Prod state dir (`~/.claude/channels/slack/`) is never opened —
  read or written
- Reach Hikaru / consultation session via the handoff filesystem
  channel or GitHub Issue threads
- If a Slack reply is genuinely needed, route via the prod bridge
  owner or the consultation session that holds the Slack edge

### Dev bridge (feature work against a throwaway Slack app)

Skeleton — requires provisioning before first use. See the TODO block
inside `scripts/start-bridge-dev.ps1`:

1. Create a separate dev Slack app (separate workspace, **or** the
   same workspace with a clearly-named `-dev` app), generate fresh
   `xoxb-` / `xapp-` tokens
2. `New-Item -ItemType Directory -Force -Path ~/.claude/channels/slack-dev`
3. Write `~/.claude/channels/slack-dev/.env` with the dev tokens
   (restrict to user, equivalent of `chmod 0o600`)
4. Optionally seed `~/.claude/channels/slack-dev/access.json` with a
   minimal allowlist for the dev workspace (keep disjoint from prod)

Then:

```pwsh
.\scripts\start-bridge-dev.ps1
```

Never copy `.env` / `access.json` / `sessions/` / `audit.log` from the
prod state dir into the dev state dir.

## Why a wrapper instead of `.claude/settings.local.json` env

`.claude/settings.local.json` should propagate `env` entries to spawned
MCP child processes (per Claude Code's update-config semantics). If
that propagation works in your build, you can express prod / passive /
dev mode by setting the env vars in three different `settings.local.json`
files in three different project roots.

The PowerShell wrappers are the deterministic fallback — they set the
environment in the shell that spawns `claude`, observable in
`Get-ChildItem Env:`, propagating regardless of whether the Claude Code
build forwards `settings.local.json.env` correctly. They also handle
the first-run provisioning (creating the passive state dir + placeholder
`.env`) that a settings file alone cannot.

Either path produces the same end state: `process.env` in `server.ts`
has the right `SLACK_BRIDGE_DISABLE` / `SLACK_STATE_DIR` value at boot,
and the matching state dir exists with the expected files.

## Inbound auto-processing (separate concern)

The prod bridge delivers each inbound DM to Claude Code via an MCP
notification. MCP notifications do **not** auto-wake an idle Claude
Code session — the message lands in the session context but no
response is generated until a user turn fires. For a small set of
allowlisted DM prefixes (`[abort-test]`, `[abort cleanup]`, `[abort]`,
`status?`, `prs?`) we run a separate watcher that bypasses Claude
Code entirely. See [`inbound-auto-processing.md`](inbound-auto-processing.md)
for the architecture, configuration, and end-to-end verification.

The watcher uses Web API only (no Socket Mode), so it is **safe to
run alongside `start-bridge-prod.ps1`** and obeys invariant 1.

## Compatibility

- `scripts/claude-bridge-disabled.ps1` is preserved as an alias that
  forwards all arguments unchanged to `scripts/start-exec-passive.ps1`.
  Existing scripted invocations keep working; new work should call
  `start-exec-passive.ps1` directly.
- Per-machine `.codex/config.toml` / `.claude/settings.local.json`
  entries that set `SLACK_BRIDGE_DISABLE=1` apply the passive flag,
  but they do **not** redirect `SLACK_STATE_DIR`. server.ts reads
  `.env` (under the default state dir) before the passive-mode
  short-circuit, so a session that relies on `SLACK_BRIDGE_DISABLE=1`
  alone will read the prod `.env`. To keep prod state untouched
  through local config, set both env vars (and pre-provision
  `~/.claude/channels/slack-passive/.env`); otherwise, use
  `start-exec-passive.ps1` which handles both.
