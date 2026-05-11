/**
 * scripts/executor-relay.ts
 *
 * Executor completion relay (bd ccsc-sbf Phase 1).
 *
 * Passive-execution sessions cannot post to Slack themselves. They
 * write a done file under `handoff/from-execute/` matching the
 * `done-<created-iso-no-colon>-<done_id>.md` pattern, and the watcher
 * picks it up on the next sweep, posts a short completion notice to
 * Hikaru's DM, and atomically moves the file into the existing
 * `from-execute/processed/` archive.
 *
 * Pure module — all functions are testable without I/O except for the
 * explicit filesystem helpers (`listDoneEntries`, `archiveDoneFile`).
 * The inbound-watcher's main loop calls these from a new sweep added
 * after the existing dispatch sweep.
 *
 * Frontmatter parsing reuses the watcher's flat YAML helper
 * (`parseFrontmatterFile`) so no new YAML dependency is added.
 *
 * Out of scope (per ccsc-sbf): non-done types in `from-execute/` (=
 * `result` / `propose` / `progress` / `ask` are handled elsewhere by
 * the consultation coordinator and MUST NOT be touched here).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { detectToken, type Frontmatter, parseFrontmatterFile } from './inbound-watcher'

// Hardcoded absolute dirs. The executor side writes drafts into
// EXECUTOR_DONE_DIR; the watcher moves successfully-relayed files
// into EXECUTOR_DONE_PROCESSED_DIR. NOT env-configurable.
export const EXECUTOR_DONE_DIR = '/home/hikaru/projects/hikaru-agent-knowledge/handoff/from-execute'
export const EXECUTOR_DONE_PROCESSED_DIR =
  '/home/hikaru/projects/hikaru-agent-knowledge/handoff/from-execute/processed'

/**
 * Sliding window for done_id deduplication. A done file processed
 * within the past 5 minutes is treated as already-relayed even if it
 * is somehow re-presented (= Slack API succeeded but archive failed
 * on a previous tick, then the watcher restarted). The window is
 * advisory — the authoritative source of truth that a file has been
 * relayed is the file's location (= moved into `processed/`).
 */
export const DONE_DEDUP_WINDOW_MS = 5 * 60_000

/** Filename pattern the sweep looks for in EXECUTOR_DONE_DIR. */
export const DONE_FILENAME_PATTERN = /^done-.+\.md$/

export type DoneStatus = 'complete' | 'blocked' | 'failed'

const KNOWN_DONE_STATUSES: ReadonlySet<DoneStatus> = new Set(['complete', 'blocked', 'failed'])

function isDoneStatus(s: unknown): s is DoneStatus {
  return typeof s === 'string' && KNOWN_DONE_STATUSES.has(s as DoneStatus)
}

/**
 * Subset of frontmatter fields the relay reads.
 *
 * - `type` MUST equal "done" (other types are out of scope and left
 *   for the consultation coordinator)
 * - `done_id` / `summary` / `status` are required
 * - `related_bd` / `related_pr` / `executor_session` are optional
 * - `needs_review` toggles the "review 待ち" suffix in the Slack
 *   notice. Treated as false when missing.
 */
export interface DoneEntry {
  path: string
  type: 'done'
  done_id: string
  status: DoneStatus
  summary: string
  created_at?: string
  related_bd?: string
  related_pr?: string
  executor_session?: string
  needs_review: boolean
  body: string
}

/**
 * Validate + interpret a parsed frontmatter as a DoneEntry. Returns
 * null when the file is not for this relay (= type !== "done") OR
 * when required fields are missing / malformed. The caller logs the
 * path on null and leaves the file in place — the executor is
 * expected to inspect and re-write.
 */
export function interpretDoneEntry(path: string, fm: Frontmatter, body: string): DoneEntry | null {
  if (fm.type !== 'done') return null
  const done_id = fm.done_id
  if (typeof done_id !== 'string' || done_id.length === 0) return null
  const status = fm.status
  if (!isDoneStatus(status)) return null
  const summary = fm.summary
  if (typeof summary !== 'string' || summary.length === 0) return null

  // needs_review is permissive: any of the falsey tokens count as
  // false; any other string counts as true. Bare `true` / `false` are
  // stored as strings by parseFrontmatterFile (since the parser only
  // recognises numbers and quoted strings).
  let needs_review = false
  const nr = fm.needs_review
  if (typeof nr === 'string') {
    const lower = nr.trim().toLowerCase()
    needs_review = lower === 'true' || lower === '1' || lower === 'yes'
  }

  return {
    path,
    type: 'done',
    done_id,
    status,
    summary,
    created_at: typeof fm.created_at === 'string' ? fm.created_at : undefined,
    related_bd:
      typeof fm.related_bd === 'string' && fm.related_bd.length > 0 ? fm.related_bd : undefined,
    related_pr:
      typeof fm.related_pr === 'string' && fm.related_pr.length > 0 ? fm.related_pr : undefined,
    executor_session:
      typeof fm.executor_session === 'string' && fm.executor_session.length > 0
        ? fm.executor_session
        : undefined,
    needs_review,
    body,
  }
}

/**
 * List parseable done entries in `dir`. Non-`done-*.md` files are
 * skipped (the dir also holds the existing `result` / `propose` /
 * `progress` / `ask` files plus the `processed/` archive
 * sub-directory, which we MUST NOT touch).
 *
 * Files matching `done-*.md` but missing required fields or with a
 * wrong `type` are silently skipped from the dispatch set — but the
 * caller (the watcher sweep) can detect the difference between
 * "non-done filename" and "malformed done file" via `isMalformedDoneFile`
 * so a Slack notice / log warning can be emitted only on the second
 * case.
 */
export function listDoneEntries(dir: string): DoneEntry[] {
  if (!existsSync(dir)) return []
  const entries: DoneEntry[] = []
  for (const name of readdirSync(dir)) {
    if (!DONE_FILENAME_PATTERN.test(name)) continue
    const path = join(dir, name)
    let content: string
    try {
      content = readFileSync(path, 'utf-8')
    } catch {
      continue
    }
    const parsed = parseFrontmatterFile(content)
    if (!parsed) continue
    const entry = interpretDoneEntry(path, parsed.fm, parsed.body)
    if (entry) entries.push(entry)
  }
  return entries
}

/**
 * Detect filenames that look like done files but failed to interpret
 * (= malformed; missing required field, wrong type, parse error).
 * The watcher logs these and leaves the file in place per ccsc-sbf
 * "malformed file は notify せず log + file 残置".
 */
export function listMalformedDoneFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const malformed: string[] = []
  for (const name of readdirSync(dir)) {
    if (!DONE_FILENAME_PATTERN.test(name)) continue
    const path = join(dir, name)
    let content: string
    try {
      content = readFileSync(path, 'utf-8')
    } catch {
      malformed.push(path)
      continue
    }
    const parsed = parseFrontmatterFile(content)
    if (!parsed) {
      malformed.push(path)
      continue
    }
    const entry = interpretDoneEntry(path, parsed.fm, parsed.body)
    if (!entry) malformed.push(path)
  }
  return malformed
}

/**
 * Token guard: refuse to relay a done file whose summary or body
 * contains a raw secret pattern. Returns the matched pattern name
 * (e.g. "xoxb") or null. Reuses inbound-watcher's TOKEN_PATTERNS to
 * keep one source of truth.
 */
export function detectTokenInDoneEntry(entry: DoneEntry): string | null {
  return detectToken(`${entry.summary}\n${entry.body}`)
}

/**
 * Build the Slack-side completion notice. Optional fields are
 * omitted when empty so the message stays compact.
 *
 * Format (per ccsc-sbf "Watcher subroutine" #4):
 *   ✅ 実行役完了: <summary>
 *     bd:     <related_bd>        (omitted when missing)
 *     PR:     <related_pr>        (omitted when missing)
 *     status: <status>
 *     done_id: <done_id>
 *     [review 待ち]                (only when needs_review === true)
 */
export function formatDoneNotification(entry: DoneEntry): string {
  const lines = [`✅ 実行役完了: ${entry.summary}`]
  if (entry.related_bd) lines.push(`  bd:     ${entry.related_bd}`)
  if (entry.related_pr) lines.push(`  PR:     ${entry.related_pr}`)
  lines.push(`  status: ${entry.status}`)
  lines.push(`  done_id: ${entry.done_id}`)
  if (entry.needs_review) lines.push(`  [review 待ち]`)
  return lines.join('\n')
}

/**
 * Sliding-window dedup. Returns true when the watcher has relayed the
 * same done_id within the past DONE_DEDUP_WINDOW_MS. Authoritative
 * dedup is the archive move (= once the file is in `processed/` it is
 * no longer listed by listDoneEntries), but this advisory window
 * covers the race where Slack post succeeded yet archive failed.
 *
 * `recentlyRelayed` is a Map of done_id -> wall-clock ms when the
 * relay completed. Entries older than DONE_DEDUP_WINDOW_MS are
 * cleaned by the caller via pruneRecentlyRelayed.
 */
export function isRecentlyRelayed(
  recentlyRelayed: Map<string, number>,
  doneId: string,
  now: number,
  windowMs: number = DONE_DEDUP_WINDOW_MS,
): boolean {
  const relayedAt = recentlyRelayed.get(doneId)
  if (relayedAt === undefined) return false
  return now - relayedAt < windowMs
}

/**
 * Remove entries older than the dedup window from the recently-relayed
 * map. Returns the list of pruned done_ids (caller may log if it
 * cares).
 */
export function pruneRecentlyRelayed(
  recentlyRelayed: Map<string, number>,
  now: number,
  windowMs: number = DONE_DEDUP_WINDOW_MS,
): string[] {
  const pruned: string[] = []
  for (const [doneId, relayedAt] of recentlyRelayed.entries()) {
    if (now - relayedAt >= windowMs) {
      recentlyRelayed.delete(doneId)
      pruned.push(doneId)
    }
  }
  return pruned
}

/**
 * Atomically move a done file from EXECUTOR_DONE_DIR into
 * EXECUTOR_DONE_PROCESSED_DIR. Creates the processed dir on first
 * use (idempotent). Uses `renameSync` which is atomic within the
 * same filesystem.
 */
export function archiveDoneFile(
  srcPath: string,
  processedDir: string = EXECUTOR_DONE_PROCESSED_DIR,
): string {
  mkdirSync(processedDir, { recursive: true })
  const base = srcPath.split('/').pop() ?? ''
  const dest = join(processedDir, base)
  renameSync(srcPath, dest)
  return dest
}
