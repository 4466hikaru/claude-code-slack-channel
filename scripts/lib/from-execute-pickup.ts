/**
 * scripts/lib/from-execute-pickup.ts
 *
 * Consult-side pickup helpers (bd ccsc-consult-inbox-pickup).
 *
 * Symmetric to `to-execute-pickup.ts`: the executor writes inter-session
 * inbox files into `handoff/from-execute/` (`type: result | propose |
 * ask | progress`) which the consult role should drain. Until this
 * module existed, the consult session only saw them when Hikaru pasted a
 * path. This module gives a passive consult session a way to:
 *
 *   - list pending consult-inbox entries (= top-level `.md` in
 *     `from-execute/` whose `type` is one of the recognised consult
 *     verbs, NOT yet moved to the consult-side processed dir)
 *   - claim one atomically (= renameSync into
 *     `handoff/processed/from-execute/`, per `handoff/README.md`)
 *   - resolve an entry by either filename or `correlation_id`
 *
 * Pure FS only — no Slack API call, no DB, no destructive delete
 * outside the claim move. The single source of truth that an entry is
 * "in progress / done from the consult role's perspective" is the
 * file's location in the processed dir; double-pickup is prevented by
 * `renameSync` being atomic on the same filesystem.
 *
 * Out of scope:
 *   - `type: done` files in `from-execute/` are handled by the
 *     watcher's executor-relay (it relays them to Slack and moves them
 *     into `from-execute/processed/`). This module deliberately
 *     classifies them as `skipped_non_target` so the consult CLI does
 *     not race the watcher.
 *   - We DO NOT touch `handoff/from-execute/processed/` — that dir
 *     belongs to the watcher's relay layer. The consult-claim
 *     destination is the separate `handoff/processed/from-execute/`
 *     path documented in `handoff/README.md`.
 *
 * Shared helpers (`isAbortFlagPresent`, `recommendedDoneFilename`,
 * `containsTokenLike`, `assignmentBodyForDisplay`) are re-exported
 * from `to-execute-pickup.ts`. The executor-side pickup intentionally
 * stays the canonical home for those — this module's import does NOT
 * mutate it.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { basename, join } from 'node:path'
import { type Frontmatter, parseFrontmatterFile } from './frontmatter'
import {
  ABORT_FLAG_PATH,
  assignmentBodyForDisplay,
  containsTokenLike,
  isAbortFlagPresent,
  recommendedDoneFilename,
  safeDoneIdForFilename,
} from './to-execute-pickup'

// Re-export the shared safety / display helpers so the CLI can import
// everything it needs from one module (= one less cross-import for
// callers, no behavioural change for the executor-side module).
export {
  ABORT_FLAG_PATH,
  assignmentBodyForDisplay,
  containsTokenLike,
  isAbortFlagPresent,
  recommendedDoneFilename,
  safeDoneIdForFilename,
}

/**
 * Inbox for executor → consult messages. Watcher relays `done` files
 * out of this same dir; we coexist with it by only claiming the
 * non-`done` types listed in `RECOGNISED_TYPES`.
 */
export const FROM_EXECUTE_DIR = '/home/hikaru/projects/hikaru-agent-knowledge/handoff/from-execute'

/**
 * Where claimed consult inbox entries are moved. Per
 * `handoff/README.md` the consult-side processed dir is
 * `handoff/processed/from-execute/` — separate from the watcher's
 * `handoff/from-execute/processed/` which stores relayed `done` files.
 * Created lazily on first claim (`mkdirSync recursive`).
 */
export const FROM_EXECUTE_PROCESSED_DIR =
  '/home/hikaru/projects/hikaru-agent-knowledge/handoff/processed/from-execute'

/**
 * Frontmatter `type` values the consult role wants to pick up. Per the
 * assignment scope: `result | propose | ask | progress`.
 *
 * `done` is intentionally OUT — those belong to the watcher's
 * executor-relay path and get moved into `from-execute/processed/`.
 * Other unknown types are classified as `skipped_non_target` so the
 * CLI surfaces them in stderr without crashing.
 */
export const RECOGNISED_INBOX_TYPES = ['result', 'propose', 'ask', 'progress'] as const
export type InboxType = (typeof RECOGNISED_INBOX_TYPES)[number]

/** Filename pattern. Top-level `.md` only — sub-dirs (`processed/`) are excluded by readdirSync depth. */
const INBOX_FILENAME_PATTERN = /^.+\.md$/

/**
 * One pending consult-inbox entry. Mirrors `AssignmentEntry` in
 * `to-execute-pickup.ts` but surfaces consult-relevant frontmatter
 * fields (the inter-session-protocol uses `from`, `to`, `in_reply_to`,
 * `related_task`, `requires_human`). Unknown frontmatter is kept in
 * `fm` so the CLI can still print it.
 */
export interface ConsultInboxEntry {
  path: string
  filename: string
  type: InboxType
  correlation_id: string
  from: string | null
  to: string | null
  in_reply_to: string | null
  related_task: string | null
  requires_human: string | null
  created: string | null
  consult_id: string | null
  fm: Frontmatter
  body: string
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function isRecognisedType(v: unknown): v is InboxType {
  return typeof v === 'string' && (RECOGNISED_INBOX_TYPES as readonly string[]).includes(v)
}

/**
 * Validate + normalise a parsed frontmatter into a `ConsultInboxEntry`.
 * Returns null when the file is not a recognised consult inbox entry
 * (= `type` not in `RECOGNISED_INBOX_TYPES`) OR required fields are
 * missing.
 *
 * Required: a recognised `type` AND a non-empty `correlation_id`. All
 * other fields are optional and surface as `null` when absent.
 *
 * Why correlation_id is required: the inter-session-protocol pins each
 * inbox entry to a correlation chain. An entry without one cannot be
 * matched back to the originating task, so claiming it would lose the
 * causal trail. Files like that are classified `malformed` so the
 * operator sees them in stderr instead of silently claiming them.
 */
export function interpretInboxEntry(
  path: string,
  fm: Frontmatter,
  body: string,
): ConsultInboxEntry | null {
  if (!isRecognisedType(fm.type)) return null
  const correlation_id = fm.correlation_id
  if (typeof correlation_id !== 'string' || correlation_id.length === 0) return null
  return {
    path,
    filename: basename(path),
    type: fm.type,
    correlation_id,
    from: asString(fm.from),
    to: asString(fm.to),
    in_reply_to: asString(fm.in_reply_to),
    related_task: asString(fm.related_task),
    requires_human: asString(fm.requires_human),
    created: asString(fm.created),
    consult_id: asString(fm.consult_id),
    fm,
    body,
  }
}

/**
 * Aggregate result of scanning `dir`. Counters mirror the executor-side
 * vocabulary so an operator can compare `pickup-from-execute list`
 * output against `pickup-to-execute list` side-by-side.
 *
 *   - `entries` = ready to claim
 *   - `malformed_count` = files that looked like `.md` but failed
 *     `parseFrontmatterFile`, OR a recognised type with missing
 *     correlation_id
 *   - `skipped_non_target_count` = `.md` files whose `type` was not in
 *     `RECOGNISED_INBOX_TYPES` (e.g. `done`, `verification-result`,
 *     or a future workflow). NOT an error.
 */
export interface ConsultInboxListResult {
  entries: ConsultInboxEntry[]
  malformed_count: number
  skipped_non_target_count: number
  total_files: number
}

/**
 * List pending consult-inbox entries in `dir`. Only top-level `.md`
 * files are inspected — sub-directories (notably `processed/` used by
 * the watcher) are skipped by `readdirSync` depth.
 *
 * Returns `{ entries: [], ... }` when the dir does not exist (= no
 * inbox yet, not an error).
 *
 * Entries are sorted by filename for deterministic, chronological
 * iteration — filenames typically carry a UTC timestamp prefix.
 */
export function listPendingInbox(dir: string = FROM_EXECUTE_DIR): ConsultInboxListResult {
  const result: ConsultInboxListResult = {
    entries: [],
    malformed_count: 0,
    skipped_non_target_count: 0,
    total_files: 0,
  }
  if (!existsSync(dir)) return result

  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return result
  }
  names.sort()

  for (const name of names) {
    if (!INBOX_FILENAME_PATTERN.test(name)) continue
    const path = join(dir, name)
    result.total_files += 1

    let content: string
    try {
      content = readFileSync(path, 'utf-8')
    } catch {
      result.malformed_count += 1
      continue
    }

    const parsed = parseFrontmatterFile(content)
    if (!parsed) {
      result.malformed_count += 1
      continue
    }

    const entry = interpretInboxEntry(path, parsed.fm, parsed.body)
    if (!entry) {
      if (isRecognisedType(parsed.fm.type)) {
        // Recognised type but missing required field (= correlation_id).
        result.malformed_count += 1
      } else {
        result.skipped_non_target_count += 1
      }
      continue
    }
    result.entries.push(entry)
  }

  return result
}

/**
 * Resolve a consult-supplied identifier to one of the listed entries.
 * Resolution policy mirrors `resolveAssignment` exactly:
 *
 *   1. exact filename ("2026-05-13T0250-codex-consult-...md")
 *   2. exact basename without ".md"
 *   3. exact correlation_id ("codex-consult-...-20260513")
 *   4. unique substring of filename OR correlation_id
 *
 * Ambiguous matches return the candidates so the CLI can show them
 * instead of guessing.
 */
export type ResolveInboxResult =
  | { kind: 'found'; entry: ConsultInboxEntry }
  | { kind: 'none' }
  | { kind: 'ambiguous'; matches: ConsultInboxEntry[] }

export function resolveInboxEntry(
  entries: readonly ConsultInboxEntry[],
  identifier: string,
): ResolveInboxResult {
  if (typeof identifier !== 'string' || identifier.length === 0) return { kind: 'none' }
  const id = identifier.trim()

  const exactFilename = entries.find((e) => e.filename === id)
  if (exactFilename) return { kind: 'found', entry: exactFilename }

  const exactStem = entries.find((e) => e.filename === `${id}.md`)
  if (exactStem) return { kind: 'found', entry: exactStem }

  const exactCorr = entries.find((e) => e.correlation_id === id)
  if (exactCorr) return { kind: 'found', entry: exactCorr }

  const matches = entries.filter((e) => e.filename.includes(id) || e.correlation_id.includes(id))
  if (matches.length === 0) return { kind: 'none' }
  if (matches.length === 1) return { kind: 'found', entry: matches[0] }
  return { kind: 'ambiguous', matches }
}

/**
 * Atomically claim a consult inbox entry by moving its file into
 * `processedDir`. Returns the destination path. Throws on filesystem
 * error (= caller logs + treats as "already claimed by another consult
 * session" — `renameSync` on the loser side fails with ENOENT because
 * the file moved). The processed dir is created lazily.
 *
 * The function does NOT mutate the frontmatter; the file is moved
 * byte-for-byte. The consult session reads it in place, then writes
 * its own reply (or human-facing summary) as a new file under the
 * appropriate handoff dir per the inter-session-protocol.
 */
export function claimInboxEntry(
  entry: ConsultInboxEntry,
  processedDir: string = FROM_EXECUTE_PROCESSED_DIR,
): string {
  mkdirSync(processedDir, { recursive: true })
  const dest = join(processedDir, entry.filename)
  renameSync(entry.path, dest)
  return dest
}

/**
 * Format a one-line preview of an inbox entry for the CLI `list`
 * output. Format:
 *
 *   <filename>  [type=<>] [from=<>] [reply=<in_reply_to>] <correlation_id> — <first body line>
 *
 * Optional tags are omitted when null. Body preview is the first
 * non-blank non-heading line, truncated to `maxBodyChars`. Token-like
 * bodies are hidden, matching the executor-side display redaction.
 */
export function formatInboxSummary(entry: ConsultInboxEntry, maxBodyChars = 80): string {
  const parts: string[] = [entry.filename]
  const tags: string[] = []
  tags.push(`type=${entry.type}`)
  if (entry.from) tags.push(`from=${entry.from}`)
  if (entry.in_reply_to) tags.push(`reply=${entry.in_reply_to}`)
  if (entry.requires_human === 'true') tags.push('requires_human')
  parts.push(`[${tags.join(' ')}]`)
  parts.push(entry.correlation_id)
  const firstBodyLine = entry.body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('#'))
  if (firstBodyLine) {
    const safeLine = containsTokenLike(firstBodyLine)
      ? '[inbox line hidden: token-like secret detected]'
      : firstBodyLine
    const trimmed =
      safeLine.length > maxBodyChars ? `${safeLine.slice(0, maxBodyChars)}…` : safeLine
    parts.push(`— ${trimmed}`)
  }
  return parts.join('  ')
}
