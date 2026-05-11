# Executor to-execute pickup runbook (bd ccsc-cw1)

Lightweight CLI for the executor session to discover and claim
`handoff/to-execute/*.md` `type: assign` files without Hikaru
manually copying paths.

This is the **smallest safe** path that closes the gap between the
watcher writing `to-execute/<dispatch>.md` and an executor session
acting on it. Anything heavier (= persistent daemon, automatic
pickup loop, multi-executor coordination) is deliberately **out of
scope** here. Phase 2+ may build on top.

## Where things live

| path | role |
|---|---|
| `/home/hikaru/projects/hikaru-agent-knowledge/handoff/to-execute/` | inbox — bridge watcher writes `type: assign` files here |
| `/home/hikaru/projects/hikaru-agent-knowledge/handoff/to-execute/processed/` | archive — claimed assignments are moved here, never deleted |
| `/home/hikaru/projects/hikaru-agent-knowledge/handoff/from-execute/done-*.md` | completion — executor writes this, the watcher relays to Slack |
| `/home/hikaru/projects/hikaru-agent-knowledge/handoff/abort-lv2` | global abort flag — when present, this CLI refuses every command |

The CLI itself: `scripts/pickup-to-execute.ts` (in this repo, run via Bun).

## Quick start

```bash
cd /home/hikaru/projects/claude-code-slack-channel

# what is pending?
bun scripts/pickup-to-execute.ts list

# inspect (read-only) without claiming
bun scripts/pickup-to-execute.ts show <id-or-filename>

# atomically claim — moves file to processed/ and prints the body
bun scripts/pickup-to-execute.ts claim <id-or-filename>

# wait until one assignment appears, claim one, then exit
bun scripts/pickup-to-execute.ts wait --poll-ms 5000

# smoke: check once without waiting
bun scripts/pickup-to-execute.ts wait --timeout-ms 0
```

`<id-or-filename>` accepts any of:

- exact filename (`2026-05-11T1635-ccsc-cw1.md`)
- exact basename without `.md` (`2026-05-11T1635-ccsc-cw1`)
- exact `correlation_id` (`bd-ccsc-cw1`)
- unique substring of either (= `cw1`)

Ambiguous substrings print the candidate list to stderr and exit
non-zero — narrow the input before retrying.

## Wait mode

Use wait mode when an execution-role session should block until the
next assignment arrives instead of asking Hikaru to tell it when to run
list again:

```bash
bun scripts/pickup-to-execute.ts wait --poll-ms 5000
```

wait checks the abort flag on every poll. When the first valid
assignment appears, it atomically claims that single assignment, prints
the same body and done-file guidance as claim, then exits. It does not
loop forever after claiming, and it never executes the assignment body.

Useful options:

- --poll-ms <ms>: polling cadence, allowed range 1000-60000, default 5000
- --timeout-ms <ms>: stop waiting after this long; 0 means one immediate check

Example smoke check:

```bash
bun scripts/pickup-to-execute.ts wait --timeout-ms 0
```

## Lifecycle of one assignment

1. **Slack natural-language consult** → consult queue (bd ccsc-nwm
   Phase 1)
2. **Codex** writes a `codex-plan` file
3. **Hikaru** replies `進めて` / `approve <consult_id>` in the same
   Slack thread
4. **Watcher** writes `handoff/to-execute/<dispatch>.md` with
   `type: assign`, `correlation_id`, `risk_level`, `dev_verification`,
   `prod_gate`, plus the resolved Codex plan body
5. **Executor session** runs `bun scripts/pickup-to-execute.ts list`
   → sees pending dispatches
6. **Executor session** runs `... claim <id>` → file atomically
   moves to `processed/`, body printed to stdout
7. **Executor session** performs the work (= code change / PR / etc.)
   per the assignment's plan, honouring `risk_level` and `prod_gate`
8. **Executor session** writes `handoff/from-execute/done-<UTC
   yyyy-mm-ddThhmm>-<done_id>.md` (= the CLI prints a recommended
   filename + frontmatter template)
9. **Watcher** picks up the done file and relays a Slack completion
   notice (bd ccsc-sbf executor completion relay)

## Single-consumer safety

`claim` uses `renameSync` which is atomic within the same
filesystem. Two executor sessions racing to claim the same file:
the loser sees `ENOENT` and the CLI reports
"likely already claimed by another executor" with exit code 3. The
file is never duplicated, never partially moved.

If an executor session **crashes after claim but before writing the
done file**, the assignment sits in `processed/` with no
completion. Manual recovery: move the file back to the top-level
`to-execute/` with `mv`, then re-run `claim`. (Phase 1 deliberately
does not automate recovery — operators are the source of truth.)

## Abort flag interaction

The CLI checks `handoff/abort-lv2` at the start of every command
(including `list` and `show`). When present, the CLI exits with
code 2 and the message:

```
[pickup] abort flag present at /home/hikaru/projects/hikaru-agent-knowledge/handoff/abort-lv2 — refusing to start work.
```

This matches the existing watcher / consult-relay / executor-relay
convention — `[abort cleanup]` in Slack DM removes the flag and
all subroutines resume on the next watcher tick.

## What the CLI does NOT do

- ❌ run the assignment body as code (= no `eval`, no shell of body
  contents; the body is plain Markdown for the executor to read)
- ❌ post to Slack (= the watcher's relay handles Slack on the
  done-file side)
- ❌ touch production / Supabase / Vercel / DB
- ❌ read or write `.env`, secrets, tokens
- ✅ redact token-like assignment body content from stdout; if this happens, inspect the claimed file carefully and report a blocker without exposing the secret
- ❌ delete the assignment file (= moves to `processed/` only)
- ❌ make GitHub API calls (= no PR creation, no merge)
- ✅ wait for the next assignment and claim one file when the executor explicitly runs wait
- ❌ run as a persistent daemon after claim (= wait exits after claiming one assignment)

If the assignment body asks for something this CLI doesn't do, the
executor session performs it as a separate, audited step.

## Done file contract (= from-execute relay)

After completing the work, write:

```
handoff/from-execute/done-<UTC yyyy-mm-ddThhmm>-<done_id>.md
```

Frontmatter (all values are double-quoted strings):

```yaml
---
type: "done"
done_id: "<related_task or correlation_id from the assignment>"
status: "complete"   # or "blocked" / "failed"
summary: "<one-line result>"
needs_review: "true"  # or "false"
related_bd: "<bd issue id if applicable>"
related_pr: "<PR URL if created>"
---

<free-form body — short report, links, blockers>
```

The CLI's `claim` command prints the suggested filename + minimum
frontmatter as a `# next:` comment block so the executor can copy /
adapt directly.

## Testing

- Unit tests: `bun test scripts/lib/to-execute-pickup.test.ts`
- Full suite: `bun test scripts/`
- Type check: `bun x tsc --noEmit`

All FS operations in tests use `mkdtempSync` temp dirs; no production
path is touched.

## Future work (out of scope for Phase 1)

- long-running daemon / service wrapper around wait mode
- multi-executor coordination (= explicit "claimed by <session>"
  marker instead of relying on `renameSync` race semantics)
- automatic re-queue when a claim has been in `processed/` for a
  long time without a matching `done-*.md`
- assignment expiry / TTL (= currently assignments live forever in
  the inbox or processed dir)
