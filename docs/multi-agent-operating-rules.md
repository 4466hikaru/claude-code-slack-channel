# Codex / Claude Multi-Agent Operating Rules

This document is the operating contract for using Codex as dispatcher and Claude Code
sessions as worker/consultant capacity.

The goal is simple: no paid agent window should be idle by accident, and no claimed
task should be treated as complete until a reviewable artifact exists.

## Roles

| role | owner | normal state | responsibility |
|---|---|---|---|
| Dispatcher | Codex | talking with Hikaru, inspecting queues, reviewing outputs | decide priorities, split work, assign tasks, review/merge/report |
| Executor | Claude Code | `pickup-to-execute wait --poll-ms 5000` or claimed task | implement scoped code/doc changes, run gates, create PR/done file |
| Consultant | Claude Code | `pickup-from-hikaru wait --poll-ms 5000` or claimed consult | organize Hikaru notes, draft task packets, research/design, do not merge |

Only Codex decides task priority and whether something moves to implementation.
Claude can propose work, but Codex owns dispatch and review.

## Non-Negotiable Rules

1. A Claude window is useful only in one of these states:
   - waiting in the correct pickup command
   - actively working on a claimed assignment
   - blocked with a written blocker artifact
2. A Claude assignment is not complete until it has one of:
   - a `handoff/from-execute/done-*.md` file
   - a PR plus the required done file
   - a blocked/failed done file explaining the stop condition
3. Codex must not assume "claimed" means "working well". Codex checks for:
   - processed assignment with no matching done file
   - stale PR with no new commit after feedback
   - Claude sitting outside `wait --poll-ms 5000`
4. Before Codex starts a local task expected to take more than 10 minutes, Codex should
   either assign a parallel task to idle Claude capacity or explicitly say why not.
5. Claude never gets vague work. Every task packet must include scope, non-goals,
   acceptance criteria, verification commands, and expected artifact path.
6. Claude does not touch production, secrets, `.env*`, Supabase production data, Vercel
   production, or merges unless the assignment explicitly says so and Hikaru has allowed it.
7. If Claude misses a mandatory artifact, scope-drifts, fabricates completion, or needs
   repeated rescue, Codex reports that as an agent-quality issue instead of hiding it.
8. Codex must not silently take work back from Claude because output quality is low.
   The default response is to write Good / More feedback and send one specific correction
   assignment back to Claude.

## Task Packet Minimum

Every `handoff/to-execute/*.md` assignment should include:

| field | requirement |
|---|---|
| goal | one concrete outcome, not a broad theme |
| repo / branch | exact repo path and expected branch/worktree |
| write scope | files or modules Claude may edit |
| non-goals | what must not be changed |
| acceptance | what must be true before done |
| verification | commands to run, or explicit reason if skipped |
| deliverable | PR URL, patch summary, done file path, or design doc path |
| risk gate | prod/data/security constraints |

If the task cannot fit this shape, it is still a consult/design task, not an executor task.

## Default Work Split

When there are two Claude windows available:

| situation | Executor | Consultant |
|---|---|---|
| active site bug | implement narrow fix | inspect edge cases / draft test plan |
| feature build | implement slice A | specify slice B or review UX/data risk |
| unclear product idea | wait | turn notes into task packets |
| Codex busy reviewing PR | continue next scoped implementation | collect pending notes and dependencies |
| no urgent implementation | pick next ready issue | backlog grooming / research |

The consultant should become executor #2 only when the task is already concrete and the
write scopes are disjoint.

## Codex Health Check Loop

Codex should run this check whenever the user asks "動いてる?" or before a long local run:

```bash
ps aux | grep -E 'pickup-to-execute|pickup-from-hikaru|inbound-watcher' | grep -v grep
find /home/hikaru/projects/hikaru-agent-knowledge/handoff/to-execute/processed -maxdepth 1 -type f -mmin -30
find /home/hikaru/projects/hikaru-agent-knowledge/handoff/from-execute -maxdepth 1 -type f -name 'done-*.md' -mmin -30
```

Expected interpretation:

- pickup process present: window is waiting or has just claimed work
- processed assignment exists but no done file: work is in-flight or stuck
- done file exists: completion can be relayed/reviewed
- no pickup process: the window is not useful and must be restarted or given the wait command

## Review Contract

Codex reviews Claude outputs before treating them as usable:

1. Check the claimed assignment against the final diff/doc.
2. Check for missing done file or malformed frontmatter.
3. Run or inspect verification results.
4. For PRs, review the actual diff and CI state.
5. If acceptable, merge or report depending on the assignment.
6. If not acceptable, send a specific follow-up assignment, not vague feedback.

## Good / More Feedback Loop

When Claude output is weak, Codex acts as a playing manager, not a replacement worker.
The default sequence is:

1. Identify the miss against the original assignment.
2. Write a Good / More feedback note using `docs/claude-good-and-more-feedback.md`.
3. Send Claude a narrow correction assignment that references the note.
4. Re-review the correction.
5. Only take the work back locally if the user is blocked, the task is urgent, or there is
   a production/data safety risk.

Good / More means:

- Good: what was useful and should be preserved
- More: what was missing, risky, or below contract
- Next: the exact correction artifact expected from Claude

If Codex takes work back, it must record why reassignment was not the better move.

## Reporting To Hikaru

Codex should report these plainly:

- which windows are active
- what each one is doing
- which PRs/docs were produced
- what was merged or left unmerged
- whether Claude quality was good, mediocre, or bad
- what Hikaru needs to do, if anything

Do not say "Claude is working" unless there is process evidence, a claimed assignment, or
recent output.

## After Reboot

A Windows/WSL reboot invalidates assumptions. Codex must verify and restart:

1. inbound watcher
2. Windows Slack bridge
3. Claude executor wait loop
4. Claude consultant wait loop
5. bd/Dolt health if this repo is being edited

If bd is broken, Codex may continue urgent operational docs/code, but must report that
bd tracking could not be updated and avoid pretending the issue tracker was used.
