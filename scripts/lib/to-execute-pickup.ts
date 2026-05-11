/**
 * scripts/lib/to-execute-pickup.ts
 *
 * Executor-side pickup helpers (bd ccsc-cw1).
 *
 * The bridge watcher writes `type: assign` markdown files into
 * `handoff/to-execute/`. Until now an executor session only saw them
 * if Hikaru manually pasted the path. This module gives a passive
 * executor session a way to:
 *
 *   - list pending assignments (= top-level `.md` in to-execute/,
 *     `type: assign`, NOT yet moved to `processed/`)
 *   - claim one atomically (= renameSync into `processed/<basename>`)
 *   - resolve an assignment by either filename or `correlation_id`
 *
 * Pure FS only — no Slack API call, no DB, no destructive delete
 * outside the claim move. The single source of truth that an
 * assignment is "in progress / done" is the file's location in
 * `processed/`; double-pickup is prevented by `renameSync` being
 * atomic on the same filesystem.
 *
 * The actual execution of the assignment body (= code changes, PR,
 * etc.) is the executor session's responsibility. This module only
 * handles discovery + claim mechanics.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { basename, join } from 'node:path'
import { type Frontmatter, parseFrontmatterFile } from './frontmatter'

/** Hardcoded absolute path of the to-execute inbox. */
export const TO_EXECUTE_DIR = '/home/hikaru/projects/hikaru-agent-knowledge/handoff/to-execute'

/** Where claimed assignments are moved. Created lazily on first claim. */
export const TO_EXECUTE_PROCESSED_DIR =
  '/home/hikaru/projects/hikaru-agent-knowledge/handoff/to-execute/processed'

/** Abort flag — when present, this module's CLI / callers MUST halt. */
export const ABORT_FLAG_PATH = '/home/hikaru/projects/hikaru-agent-knowledge/handoff/abort-lv2'

/** Returns true when the global abort flag exists. */
export function isAbortFlagPresent(): boolean {
  return existsSync(ABORT_FLAG_PATH)
}

/** Filename pattern for assignments. Top-level `.md` only — `processed/` is excluded by readdirSync depth. */
const ASSIGNMENT_FILENAME_PATTERN = /^.+\.md$/

const TOKEN_LIKE_PATTERNS: readonly RegExp[] = [
  /\bxox[baprs]-[A-Za-z0-9-]+/i,
  /\bxapp-[A-Za-z0-9-]+/i,
  /\bgh[pousr]_[A-Za-z0-9_]+/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
]

/**
 * One pending assignment in the inbox. All optional frontmatter
 * fields are surfaced for the CLI's `list` output; the body is kept
 * untrimmed so a downstream `cat`-style display gets the original
 * content.
 */
export interface AssignmentEntry {
  path: string
  filename: string
  correlation_id: string
  related_task: string | null
  risk_level: string | null
  dev_verification: string | null
  prod_gate: string | null
  priority: string | null
  repo: string | null
  branch: string | null
  pr_title: string | null
  consult_id: string | null
  codex_plan_ref: string | null
  slack_origin_chat_id: string | null
  slack_origin_thread_ts: string | null
  requires_human: string | null
  fm: Frontmatter
  body: string
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * Validate + normalize a parsed frontmatter into an `AssignmentEntry`.
 * Returns null when the file is not an assignment (= `type !== 'assign'`)
 * OR required fields are missing.
 *
 * Required: `type === 'assign'` AND a non-empty `correlation_id`. All
 * other fields are optional and surface as `null` when absent.
 *
 * Designed so that adding new optional frontmatter fields in the
 * bridge (= future Codex automation) does NOT require updating this
 * parser to keep parsing legacy assignments cleanly.
 */
export function interpretAssignment(
  path: string,
  fm: Frontmatter,
  body: string,
): AssignmentEntry | null {
  if (fm.type !== 'assign') return null
  const correlation_id = fm.correlation_id
  if (typeof correlation_id !== 'string' || correlation_id.length === 0) return null
  return {
    path,
    filename: basename(path),
    correlation_id,
    related_task: asString(fm.related_task),
    risk_level: asString(fm.risk_level),
    dev_verification: asString(fm.dev_verification),
    prod_gate: asString(fm.prod_gate),
    priority: asString(fm.priority),
    repo: asString(fm.repo),
    branch: asString(fm.branch),
    pr_title: asString(fm.pr_title),
    consult_id: asString(fm.consult_id),
    codex_plan_ref: asString(fm.codex_plan_ref),
    slack_origin_chat_id: asString(fm.slack_origin_chat_id),
    slack_origin_thread_ts: asString(fm.slack_origin_thread_ts),
    requires_human: asString(fm.requires_human),
    fm,
    body,
  }
}

/**
 * Aggregate result of scanning `dir`. The caller drives:
 *   - `entries` = ready to claim
 *   - `malformed_count` = files that looked like `.md` but failed
 *     `parseFrontmatterFile` (= operator inspection prompt)
 *   - `skipped_non_assign_count` = `.md` files whose `type` was not
 *     `assign` (= coexist cleanly, not an error)
 */
export interface AssignmentListResult {
  entries: AssignmentEntry[]
  malformed_count: number
  skipped_non_assign_count: number
  total_files: number
}

/**
 * List pending assignments in `dir`. Only top-level `.md` files are
 * inspected (= the `processed/` subdir is naturally excluded because
 * `readdirSync` is non-recursive by default).
 *
 * Returns `{ entries: [], ... }` when the dir does not exist (= no
 * inbox yet, not an error).
 *
 * Entries are sorted by filename for deterministic, chronological
 * iteration (= filenames carry a UTC timestamp prefix).
 */
export function listPendingAssignments(dir: string = TO_EXECUTE_DIR): AssignmentListResult {
  const result: AssignmentListResult = {
    entries: [],
    malformed_count: 0,
    skipped_non_assign_count: 0,
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
    if (!ASSIGNMENT_FILENAME_PATTERN.test(name)) continue
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

    const entry = interpretAssignment(path, parsed.fm, parsed.body)
    if (!entry) {
      // Could be a non-assign type sharing the inbox (= future
      // workflows), or assign with missing required fields. We don't
      // distinguish those here on purpose — the caller's "malformed"
      // counter remains specific to parse failures.
      if (parsed.fm.type !== 'assign') {
        result.skipped_non_assign_count += 1
      } else {
        result.malformed_count += 1
      }
      continue
    }
    result.entries.push(entry)
  }

  return result
}

/**
 * Resolve an executor-supplied identifier to one of the listed
 * entries. Accepts:
 *
 *   - exact filename ("2026-05-11T1635-ccsc-cw1.md")
 *   - exact basename without ".md"
 *   - exact correlation_id ("bd-ccsc-cw1")
 *   - unique substring of either (= convenience for partial IDs)
 *
 * Returns `null` when no match, throws-style ambiguity by returning
 * `{ kind: 'ambiguous', matches }` so the CLI can show the candidates
 * instead of guessing.
 */
export type ResolveResult =
  | { kind: 'found'; entry: AssignmentEntry }
  | { kind: 'none' }
  | { kind: 'ambiguous'; matches: AssignmentEntry[] }

export function resolveAssignment(
  entries: readonly AssignmentEntry[],
  identifier: string,
): ResolveResult {
  if (typeof identifier !== 'string' || identifier.length === 0) return { kind: 'none' }
  const id = identifier.trim()

  // 1. Exact filename match (= most specific).
  const exactFilename = entries.find((e) => e.filename === id)
  if (exactFilename) return { kind: 'found', entry: exactFilename }

  // 2. Exact basename (no .md) match.
  const exactStem = entries.find((e) => e.filename === `${id}.md`)
  if (exactStem) return { kind: 'found', entry: exactStem }

  // 3. Exact correlation_id match.
  const exactCorr = entries.find((e) => e.correlation_id === id)
  if (exactCorr) return { kind: 'found', entry: exactCorr }

  // 4. Substring fallback (= filename OR correlation_id).
  const matches = entries.filter((e) => e.filename.includes(id) || e.correlation_id.includes(id))
  if (matches.length === 0) return { kind: 'none' }
  if (matches.length === 1) return { kind: 'found', entry: matches[0] }
  return { kind: 'ambiguous', matches }
}

/**
 * Atomically claim an assignment by moving its file into
 * `processedDir`. Returns the destination path. Throws on filesystem
 * error (= caller logs + treats as "already claimed by someone
 * else" — the typical race is two executors trying to claim at the
 * same time, and `renameSync` on the loser side fails with ENOENT
 * because the file moved). Caller-visible behavior: try / catch and
 * report.
 *
 * The processed dir is created lazily (`mkdirSync recursive`).
 *
 * The function does NOT mutate the frontmatter; the file is moved
 * byte-for-byte. The executor reads it in place, then writes its
 * completion as a `done-*.md` per the existing relay format.
 */
export function claimAssignment(
  entry: AssignmentEntry,
  processedDir: string = TO_EXECUTE_PROCESSED_DIR,
): string {
  mkdirSync(processedDir, { recursive: true })
  const dest = join(processedDir, entry.filename)
  renameSync(entry.path, dest)
  return dest
}

export function containsTokenLike(text: string): boolean {
  return TOKEN_LIKE_PATTERNS.some((pattern) => pattern.test(text))
}

export function assignmentBodyForDisplay(body: string): string {
  if (!containsTokenLike(body)) return body
  return '[assignment body hidden: token-like secret detected; inspect the claimed file directly and report a blocker without exposing the secret]\n'
}

/**
 * Format a one-line preview of an assignment for the CLI `list`
 * output. Format:
 *
 *   <filename>  [risk=<>] [gate=<>] [prio=<>] <correlation_id> — <first body line>
 *
 * Optional fields are omitted when null. The body preview is the
 * first non-blank line, truncated to `maxBodyChars`.
 */
export function formatAssignmentSummary(entry: AssignmentEntry, maxBodyChars = 80): string {
  const parts: string[] = [entry.filename]
  const tags: string[] = []
  if (entry.risk_level) tags.push(`risk=${entry.risk_level}`)
  if (entry.prod_gate) tags.push(`gate=${entry.prod_gate}`)
  if (entry.priority) tags.push(`prio=${entry.priority}`)
  if (tags.length > 0) parts.push(`[${tags.join(' ')}]`)
  parts.push(entry.correlation_id)
  const firstBodyLine = entry.body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('#'))
  if (firstBodyLine) {
    const safeLine = containsTokenLike(firstBodyLine)
      ? '[assignment line hidden: token-like secret detected]'
      : firstBodyLine
    const trimmed =
      safeLine.length > maxBodyChars ? `${safeLine.slice(0, maxBodyChars)}…` : safeLine
    parts.push(`— ${trimmed}`)
  }
  return parts.join('  ')
}

/**
 * Build the recommended `done-*.md` filename for the executor's
 * completion report. Mirrors the existing executor-relay convention
 * (`done-<UTC yyyy-mm-ddThhmm>-<done_id>.md`). Caller may override
 * `now` for tests.
 */
export function safeDoneIdForFilename(doneId: string): string {
  return doneId.replace(/[^A-Za-z0-9_.-]/g, '_')
}

export function recommendedDoneFilename(doneId: string, now: Date = new Date()): string {
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, '0')
  const d = String(now.getUTCDate()).padStart(2, '0')
  const hh = String(now.getUTCHours()).padStart(2, '0')
  const mi = String(now.getUTCMinutes()).padStart(2, '0')
  return `done-${y}-${m}-${d}T${hh}${mi}-${safeDoneIdForFilename(doneId)}.md`
}
