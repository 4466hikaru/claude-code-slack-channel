#!/usr/bin/env bun
/**
 * scripts/pickup-to-execute.ts
 *
 * Executor-side CLI for the `handoff/to-execute/` inbox (bd ccsc-cw1).
 *
 * Subcommands:
 *
 *   list                       Print pending assignments (one per line)
 *   show     <id-or-filename>  Print the resolved assignment to stdout
 *   claim    <id-or-filename>  Atomically move into `processed/` and print
 *   help                       Usage
 *
 * The CLI is **discovery + claim only**. The actual implementation of
 * an assignment is the executor session's responsibility (= read the
 * body printed by `show` / `claim`, do the work, write a
 * `done-*.md` per the existing relay format).
 *
 * Safety:
 *   - If `handoff/abort-lv2` is present, ALL subcommands exit non-zero
 *     with a clear "abort flag present" message. The CLI never starts
 *     work under abort.
 *   - `claim` uses `renameSync` for atomic single-consumer semantics
 *     (= two executors racing to claim the same assignment: the
 *     loser sees ENOENT and reports "already claimed").
 *   - `show` and `list` are read-only.
 *   - No Slack API call, no DB, no destructive delete outside the
 *     claim move (= which is a relocation, not a delete).
 */

import {
  ABORT_FLAG_PATH,
  assignmentBodyForDisplay,
  claimAssignment,
  formatAssignmentSummary,
  isAbortFlagPresent,
  listPendingAssignments,
  recommendedDoneFilename,
  resolveAssignment,
  TO_EXECUTE_DIR,
  TO_EXECUTE_PROCESSED_DIR,
} from './lib/to-execute-pickup'

const USAGE = `Usage:
  bun scripts/pickup-to-execute.ts list
  bun scripts/pickup-to-execute.ts show  <id-or-filename>
  bun scripts/pickup-to-execute.ts claim <id-or-filename>
  bun scripts/pickup-to-execute.ts help

Inbox:     ${TO_EXECUTE_DIR}
Processed: ${TO_EXECUTE_PROCESSED_DIR}
Abort:     ${ABORT_FLAG_PATH}`

function exitErr(msg: string, code = 1): never {
  process.stderr.write(`${msg}\n`)
  process.exit(code)
}

function abortGate(): void {
  if (isAbortFlagPresent()) {
    exitErr(
      `[pickup] abort flag present at ${ABORT_FLAG_PATH} — refusing to start work. Run [abort cleanup] in Slack DM before retrying.`,
      2,
    )
  }
}

function cmdList(): void {
  abortGate()
  const r = listPendingAssignments(TO_EXECUTE_DIR)
  if (r.entries.length === 0) {
    process.stdout.write(`(no pending assignments under ${TO_EXECUTE_DIR})\n`)
  } else {
    for (const entry of r.entries) {
      process.stdout.write(`${formatAssignmentSummary(entry)}\n`)
    }
  }
  const tail: string[] = []
  if (r.malformed_count > 0) tail.push(`malformed: ${r.malformed_count}`)
  if (r.skipped_non_assign_count > 0) tail.push(`non-assign: ${r.skipped_non_assign_count}`)
  if (tail.length > 0) {
    process.stderr.write(`# ${tail.join(', ')} (= inspect manually)\n`)
  }
}

function cmdShow(identifier: string | undefined): void {
  if (!identifier) exitErr(`[pickup] show requires <id-or-filename>\n${USAGE}`)
  abortGate()
  const r = listPendingAssignments(TO_EXECUTE_DIR)
  const found = resolveAssignment(r.entries, identifier as string)
  if (found.kind === 'none') {
    exitErr(
      `[pickup] no pending assignment matches "${identifier}" (run \`list\` to see candidates)`,
    )
  }
  if (found.kind === 'ambiguous') {
    const names = found.matches.map((m) => `  ${m.filename}  ${m.correlation_id}`).join('\n')
    exitErr(`[pickup] "${identifier}" matches multiple assignments:\n${names}\nNarrow the input.`)
  }
  const entry = found.entry
  process.stdout.write(`# ${entry.filename}\n# correlation_id: ${entry.correlation_id}\n`)
  if (entry.risk_level) process.stdout.write(`# risk_level: ${entry.risk_level}\n`)
  if (entry.dev_verification) {
    process.stdout.write(`# dev_verification: ${entry.dev_verification}\n`)
  }
  if (entry.prod_gate) process.stdout.write(`# prod_gate: ${entry.prod_gate}\n`)
  if (entry.priority) process.stdout.write(`# priority: ${entry.priority}\n`)
  if (entry.repo) process.stdout.write(`# repo: ${entry.repo}\n`)
  if (entry.branch) process.stdout.write(`# branch: ${entry.branch}\n`)
  if (entry.pr_title) process.stdout.write(`# pr_title: ${entry.pr_title}\n`)
  if (entry.consult_id) process.stdout.write(`# consult_id: ${entry.consult_id}\n`)
  if (entry.codex_plan_ref) {
    process.stdout.write(`# codex_plan_ref: ${entry.codex_plan_ref}\n`)
  }
  process.stdout.write(`# path: ${entry.path}\n`)
  process.stdout.write(`---\n${assignmentBodyForDisplay(entry.body)}\n`)
}

function cmdClaim(identifier: string | undefined): void {
  if (!identifier) exitErr(`[pickup] claim requires <id-or-filename>\n${USAGE}`)
  abortGate()
  const r = listPendingAssignments(TO_EXECUTE_DIR)
  const found = resolveAssignment(r.entries, identifier as string)
  if (found.kind === 'none') {
    exitErr(
      `[pickup] no pending assignment matches "${identifier}" (run \`list\` to see candidates)`,
    )
  }
  if (found.kind === 'ambiguous') {
    const names = found.matches.map((m) => `  ${m.filename}  ${m.correlation_id}`).join('\n')
    exitErr(`[pickup] "${identifier}" matches multiple assignments:\n${names}\nNarrow the input.`)
  }
  const entry = found.entry
  let dest: string
  try {
    dest = claimAssignment(entry, TO_EXECUTE_PROCESSED_DIR)
  } catch (e) {
    exitErr(
      `[pickup] claim failed (likely already claimed by another executor): ${
        e instanceof Error ? e.message : String(e)
      }`,
      3,
    )
  }
  const doneId = entry.related_task ?? entry.correlation_id
  const suggestedDone = recommendedDoneFilename(doneId)
  process.stdout.write(`# claimed: ${dest}\n# correlation_id: ${entry.correlation_id}\n`)
  if (entry.risk_level) process.stdout.write(`# risk_level: ${entry.risk_level}\n`)
  if (entry.dev_verification) {
    process.stdout.write(`# dev_verification: ${entry.dev_verification}\n`)
  }
  if (entry.prod_gate) process.stdout.write(`# prod_gate: ${entry.prod_gate}\n`)
  if (entry.priority) process.stdout.write(`# priority: ${entry.priority}\n`)
  process.stdout.write(
    `# next: write the result to handoff/from-execute/${suggestedDone}\n` +
      `#       with frontmatter type: "done", done_id: "${doneId}",\n` +
      `#       status: "complete"|"blocked"|"failed", summary: <one line>\n` +
      `#       needs_review: "true"|"false", related_bd: "${entry.related_task ?? ''}".\n`,
  )
  process.stdout.write(`---\n${assignmentBodyForDisplay(entry.body)}\n`)
}

// --- entrypoint ------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2)
  const cmd = args[0] ?? 'help'
  switch (cmd) {
    case 'list':
      cmdList()
      break
    case 'show':
      cmdShow(args[1])
      break
    case 'claim':
      cmdClaim(args[1])
      break
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(`${USAGE}\n`)
      break
    default:
      exitErr(`[pickup] unknown command: ${cmd}\n${USAGE}`)
  }
}

if (import.meta.main) {
  main()
}
