# Claude Good / More Feedback Protocol

Use this protocol when a Claude Code executor or consultant produces weak output.
The dispatcher must not silently take over the work unless there is an urgent user-facing
incident or a production safety risk.

The purpose is to turn low-quality agent output into a reusable correction loop.

## When To Write Feedback

Write a feedback note when any of these happen:

- Claude claims work but does not produce the required done file.
- Claude opens a PR that misses explicit acceptance criteria.
- Claude reports completion without verification evidence.
- Claude scope-drifts into files or behavior outside the assignment.
- Claude leaves a window idle outside the expected pickup wait command.
- Codex has to rescue the task by doing implementation work Claude should have done.
- The same class of mistake happens twice in one day.

## Where To Write It

For persistent project learning, write the note under the knowledge repo:

```text
/home/hikaru/projects/hikaru-agent-knowledge/handoff/from-codex/agent-feedback/
```

Recommended filename:

```text
claude-good-more-<yyyy-mm-ddThhmm>-<project-or-task>.md
```

If the feedback is also an immediate correction task, create a separate
`handoff/to-execute/*.md` assignment that references the feedback note.

## Required Shape

```markdown
# Claude Good / More: <task name>

## Context

- Agent role:
- Claimed assignment:
- Output artifact:
- Reviewer:
- Decision: accepted / needs follow-up / blocked / rejected

## Good

- What was useful, correct, or reusable.
- What should be preserved in the next iteration.

## More

- What was missing or wrong.
- Which acceptance criterion was not satisfied.
- Which operating rule was violated.

## Evidence

- PR URL, commit, diff path, done file, log, or command output summary.

## Next

- Exact correction task.
- Expected artifact.
- Verification command or review gate.
- Whether Claude should continue, retry, or return to wait mode.

## Dispatcher Note

- Did Codex take work back? Why?
- Was taking work back justified by safety/urgency, or should it have been reassigned?
```

## Dispatcher Rules

1. Do not call Claude "bad" as a final state. Convert the issue into `More` and `Next`.
2. Do not fix Claude's miss locally before giving Claude one specific correction attempt,
   unless the user is blocked or production safety is at risk.
3. If Codex takes work back, record why that was better than reassigning.
4. If the same agent misses the same rule twice, narrow its next assignment instead of
   broadening the task.
5. A Good / More note is not a replacement for the required done file or PR review.
6. Feedback should be short enough that Claude can act on it without rereading the whole
   session.

## Good Examples

- "The UI diff was narrow and matched the requested page."
- "The PR included a useful manual test note."
- "The task stayed out of production data."

## More Examples

- "The done file was missing, so Slack completion relay could not fire."
- "The count query used the first 1000 rows instead of an exact count."
- "The PR did not include the requested customer-visible route."
- "The agent left wait mode after one claim and did not return to pickup."

## Next Examples

- "Add the missing done file with `related_pr` and verification summary, then return to
  `pickup-to-execute wait --poll-ms 5000`."
- "Patch the count query to use Supabase exact head count, run `tsc` and build, then
  update the PR."
- "Draft a second task packet for the customer-side route; do not edit code."
