#!/usr/bin/env bun
/**
 * scripts/pickup-from-execute.ts
 *
 * Consult-side CLI for the `handoff/from-execute/` inbox
 * (bd ccsc-consult-inbox-pickup).
 *
 * Subcommands (symmetric to `pickup-to-execute.ts`):
 *
 *   list                       Print pending consult-inbox entries
 *   show     <id-or-filename>  Print the resolved entry to stdout
 *   claim    <id-or-filename>  Atomically move into the processed dir
 *   wait                       Wait until one entry appears, claim it, then print
 *   help                       Usage
 *
 * The CLI is discovery + claim only. The actual reply to a consult
 * inbox entry (= human handoff, Slack message, follow-up assignment) is
 * the consult session's responsibility. After claiming, write any
 * reply file under the appropriate handoff dir per the
 * inter-session-protocol.
 *
 * Safety:
 *   - If `handoff/abort-lv2` is present, all subcommands exit non-zero.
 *     The abort flag is shared with the executor pickup; halting one
 *     halts both. This is documented in
 *     `docs/consult-pickup-runbook.md`.
 *   - claim / wait use `renameSync` for atomic single-consumer semantics.
 *   - show and list are read-only.
 *   - wait claims one entry then exits — it does not run as a daemon.
 *   - No Slack API call, no DB, no destructive delete outside the
 *     claim move (which is a relocation, not a deletion).
 *   - `type: done` entries (= watcher-relay territory) are excluded
 *     from listing, so we never race the watcher.
 */

import {
  ABORT_FLAG_PATH,
  assignmentBodyForDisplay,
  type ConsultInboxEntry,
  claimInboxEntry,
  FROM_EXECUTE_DIR,
  FROM_EXECUTE_PROCESSED_DIR,
  formatInboxSummary,
  isAbortFlagPresent,
  listPendingInbox,
  resolveInboxEntry,
} from './lib/from-execute-pickup'

export const DEFAULT_WAIT_POLL_MS = 5000
export const MIN_WAIT_POLL_MS = 1000
export const MAX_WAIT_POLL_MS = 60000

export interface WaitOptions {
  pollMs: number
  timeoutMs: number | null
}

const USAGE = [
  'Usage:',
  '  bun scripts/pickup-from-execute.ts list',
  '  bun scripts/pickup-from-execute.ts show  <id-or-filename>',
  '  bun scripts/pickup-from-execute.ts claim <id-or-filename>',
  '  bun scripts/pickup-from-execute.ts wait [--poll-ms <ms>] [--timeout-ms <ms>]',
  '  bun scripts/pickup-from-execute.ts help',
  '',
  `Inbox:     ${FROM_EXECUTE_DIR}`,
  `Processed: ${FROM_EXECUTE_PROCESSED_DIR}`,
  `Abort:     ${ABORT_FLAG_PATH}`,
].join('\n')

function exitErr(msg: string, code = 1): never {
  process.stderr.write(`${msg}\n`)
  process.exit(code)
}

function abortGate(): void {
  if (isAbortFlagPresent()) {
    exitErr(
      '[pickup-from-execute] abort flag present at ' +
        ABORT_FLAG_PATH +
        ' — refusing to start work. Run [abort cleanup] in Slack DM before retrying.',
      2,
    )
  }
}

function parseIntegerMs(raw: string | undefined, flag: string): number {
  if (raw === undefined || raw.length === 0) {
    throw new Error(`${flag} requires a millisecond value`)
  }
  const n = Number(raw)
  if (!Number.isInteger(n) || !Number.isFinite(n)) {
    throw new Error(`${flag} must be an integer millisecond value`)
  }
  return n
}

function parsePollMs(raw: string | undefined, flag: string): number {
  const n = parseIntegerMs(raw, flag)
  if (n < MIN_WAIT_POLL_MS || n > MAX_WAIT_POLL_MS) {
    throw new Error(`${flag} must be between ${MIN_WAIT_POLL_MS} and ${MAX_WAIT_POLL_MS}`)
  }
  return n
}

function parseTimeoutMs(raw: string | undefined, flag: string): number {
  const n = parseIntegerMs(raw, flag)
  if (n < 0) {
    throw new Error(`${flag} must be 0 or greater`)
  }
  return n
}

/**
 * Parse `wait` flags. Kept identical in shape and validation to the
 * executor-side `parseWaitOptions` so the two CLIs behave the same
 * under the same flags. Exported for tests.
 */
export function parseWaitOptions(args: string[]): WaitOptions {
  const opts: WaitOptions = { pollMs: DEFAULT_WAIT_POLL_MS, timeoutMs: null }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--poll-ms') {
      i += 1
      opts.pollMs = parsePollMs(args[i], '--poll-ms')
    } else if (arg.startsWith('--poll-ms=')) {
      opts.pollMs = parsePollMs(arg.slice('--poll-ms='.length), '--poll-ms')
    } else if (arg === '--timeout-ms') {
      i += 1
      opts.timeoutMs = parseTimeoutMs(args[i], '--timeout-ms')
    } else if (arg.startsWith('--timeout-ms=')) {
      opts.timeoutMs = parseTimeoutMs(arg.slice('--timeout-ms='.length), '--timeout-ms')
    } else {
      throw new Error(`unknown wait option: ${arg}`)
    }
  }
  return opts
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function printEntryDetails(entry: ConsultInboxEntry, pathLabel: string): void {
  process.stdout.write(`${pathLabel}\n# correlation_id: ${entry.correlation_id}\n`)
  process.stdout.write(`# type: ${entry.type}\n`)
  if (entry.from) process.stdout.write(`# from: ${entry.from}\n`)
  if (entry.to) process.stdout.write(`# to: ${entry.to}\n`)
  if (entry.in_reply_to) process.stdout.write(`# in_reply_to: ${entry.in_reply_to}\n`)
  if (entry.related_task) process.stdout.write(`# related_task: ${entry.related_task}\n`)
  if (entry.requires_human) process.stdout.write(`# requires_human: ${entry.requires_human}\n`)
  if (entry.consult_id) process.stdout.write(`# consult_id: ${entry.consult_id}\n`)
  if (entry.created) process.stdout.write(`# created: ${entry.created}\n`)
}

function printClaimedEntry(entry: ConsultInboxEntry, dest: string): void {
  printEntryDetails(entry, `# claimed: ${dest}`)
  // Consult session next-action hint. Unlike the executor side this
  // is NOT a strict file-naming protocol (the consult role's reply
  // shape depends on the entry type), so we surface the choices
  // instead of prescribing a single filename.
  process.stdout.write(
    `${[
      '# next: read the body, decide the consult response.',
      '#       - reply to executor → write under handoff/to-execute/ (type: assign)',
      '#       - escalate to Hikaru → write under handoff/pending-human/ (requires_human: true)',
      '#       - dialog continuation → write under handoff/from-consult/',
      `#       Reference the entry above via in_reply_to: ${entry.correlation_id}.`,
    ].join('\n')}\n`,
  )
  process.stdout.write(`---\n${assignmentBodyForDisplay(entry.body)}\n`)
}

function claimAndPrint(entry: ConsultInboxEntry): void {
  let dest: string
  try {
    dest = claimInboxEntry(entry, FROM_EXECUTE_PROCESSED_DIR)
  } catch (e) {
    exitErr(
      '[pickup-from-execute] claim failed (likely already claimed by another consult session): ' +
        (e instanceof Error ? e.message : String(e)),
      3,
    )
  }
  printClaimedEntry(entry, dest)
}

function cmdList(): void {
  abortGate()
  const r = listPendingInbox(FROM_EXECUTE_DIR)
  if (r.entries.length === 0) {
    process.stdout.write(`(no pending consult inbox entries under ${FROM_EXECUTE_DIR})\n`)
  } else {
    for (const entry of r.entries) {
      process.stdout.write(`${formatInboxSummary(entry)}\n`)
    }
  }
  const tail: string[] = []
  if (r.malformed_count > 0) tail.push(`malformed: ${r.malformed_count}`)
  if (r.skipped_non_target_count > 0)
    tail.push(`non-target: ${r.skipped_non_target_count} (= e.g. type=done, inspect manually)`)
  if (tail.length > 0) {
    process.stderr.write(`# ${tail.join(', ')}\n`)
  }
}

function cmdShow(identifier: string | undefined): void {
  if (!identifier) exitErr(`[pickup-from-execute] show requires <id-or-filename>\n${USAGE}`)
  abortGate()
  const r = listPendingInbox(FROM_EXECUTE_DIR)
  const found = resolveInboxEntry(r.entries, identifier as string)
  if (found.kind === 'none') {
    exitErr(
      '[pickup-from-execute] no pending consult inbox entry matches "' +
        identifier +
        '" (run list to see candidates)',
    )
  }
  if (found.kind === 'ambiguous') {
    const names = found.matches.map((m) => `  ${m.filename}  ${m.correlation_id}`).join('\n')
    exitErr(
      '[pickup-from-execute] "' +
        identifier +
        '" matches multiple entries:\n' +
        names +
        '\nNarrow the input.',
    )
  }
  const entry = found.entry
  printEntryDetails(entry, `# ${entry.filename}`)
  process.stdout.write(`# path: ${entry.path}\n`)
  process.stdout.write(`---\n${assignmentBodyForDisplay(entry.body)}\n`)
}

function cmdClaim(identifier: string | undefined): void {
  if (!identifier) exitErr(`[pickup-from-execute] claim requires <id-or-filename>\n${USAGE}`)
  abortGate()
  const r = listPendingInbox(FROM_EXECUTE_DIR)
  const found = resolveInboxEntry(r.entries, identifier as string)
  if (found.kind === 'none') {
    exitErr(
      '[pickup-from-execute] no pending consult inbox entry matches "' +
        identifier +
        '" (run list to see candidates)',
    )
  }
  if (found.kind === 'ambiguous') {
    const names = found.matches.map((m) => `  ${m.filename}  ${m.correlation_id}`).join('\n')
    exitErr(
      '[pickup-from-execute] "' +
        identifier +
        '" matches multiple entries:\n' +
        names +
        '\nNarrow the input.',
    )
  }
  claimAndPrint(found.entry)
}

async function cmdWait(args: string[]): Promise<void> {
  let opts: WaitOptions
  try {
    opts = parseWaitOptions(args)
  } catch (e) {
    exitErr(`[pickup-from-execute] ${e instanceof Error ? e.message : String(e)}\n${USAGE}`)
  }

  const startedAt = Date.now()
  process.stderr.write(
    '[pickup-from-execute] waiting for consult inbox entries under ' +
      FROM_EXECUTE_DIR +
      ' (poll=' +
      opts.pollMs +
      'ms timeout=' +
      (opts.timeoutMs === null ? 'forever' : `${opts.timeoutMs}ms`) +
      ')\n',
  )

  for (;;) {
    abortGate()
    const r = listPendingInbox(FROM_EXECUTE_DIR)
    if (r.entries.length > 0) {
      claimAndPrint(r.entries[0])
      return
    }

    if (opts.timeoutMs !== null) {
      const elapsed = Date.now() - startedAt
      if (elapsed >= opts.timeoutMs) {
        process.stdout.write(
          `(no pending consult inbox entries under ${FROM_EXECUTE_DIR} before timeout)\n`,
        )
        return
      }
      await sleep(Math.min(opts.pollMs, opts.timeoutMs - elapsed))
    } else {
      await sleep(opts.pollMs)
    }
  }
}

async function main(): Promise<void> {
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
    case 'wait':
      await cmdWait(args.slice(1))
      break
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(`${USAGE}\n`)
      break
    default:
      exitErr(`[pickup-from-execute] unknown command: ${cmd}\n${USAGE}`)
  }
}

if (import.meta.main) {
  main().catch((e) => {
    exitErr(`[pickup-from-execute] unexpected error: ${e instanceof Error ? e.message : String(e)}`)
  })
}
