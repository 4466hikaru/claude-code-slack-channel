/**
 * scripts/outbox.ts
 *
 * Approved Codex -> Claude outbox dispatch (bd ccsc-81q Phase 1).
 *
 * Pure module. All functions are testable without I/O side effects
 * except for the explicit filesystem helpers (`listOutboxEntries`,
 * `transitionEntry`). The watcher's main loop in inbound-watcher.ts
 * calls these to:
 *   - read pending drafts under OUTBOX_DIR
 *   - resolve OK / approve / cancel / pending? Slack triggers
 *   - transition status (pending -> approved -> sent / failed /
 *     cancelled) by re-writing the file in place
 *   - decide when an approved entry can be dispatched (5s grace +
 *     abort flag absent)
 *
 * Frontmatter parser reuses the watcher's flat YAML helpers
 * (`parseFrontmatterFile`, `serializeFrontmatter`) so no new YAML
 * dependency is added (per ccsc-81q "Frontmatter" section).
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Frontmatter, parseFrontmatterFile, serializeFrontmatter } from './inbound-watcher'

// Hardcoded absolute outbox dir. Codex writes drafts here; the watcher
// reads + transitions them. NOT env-configurable in production.
export const OUTBOX_DIR = '/home/hikaru/projects/hikaru-agent-knowledge/handoff/from-codex'

// Grace period (ms) between approve and dispatch. Allows a cancel
// race window before the message goes out over Slack.
export const APPROVE_GRACE_MS = 5_000

// Default TTL applied when frontmatter ttl is missing or unparseable.
// 30 minutes matches the design SoT example.
export const DEFAULT_TTL_MS = 30 * 60 * 1000

export type OutboxStatus = 'pending' | 'approved' | 'sent' | 'failed' | 'cancelled'

// Subset of the frontmatter the watcher cares about. The full parsed
// fm is preserved as `raw` so transitions write back unrelated fields
// untouched.
export interface OutboxEntry {
  path: string
  draft_id: string
  status: OutboxStatus
  created_at: string
  ttl_ms: number
  slack_chat_id?: string
  slack_thread_ts?: string
  approved_at?: string
  approved_by?: string
  target_role?: string
  body: string
  raw: Frontmatter
}

const KNOWN_STATUSES: ReadonlySet<OutboxStatus> = new Set([
  'pending',
  'approved',
  'sent',
  'failed',
  'cancelled',
])

function isOutboxStatus(s: unknown): s is OutboxStatus {
  return typeof s === 'string' && KNOWN_STATUSES.has(s as OutboxStatus)
}

const TTL_PATTERN = /^(\d+)\s*(ms|s|m|h)$/i

/**
 * Parse a TTL spec into milliseconds. Accepts `<n>ms`, `<n>s`,
 * `<n>m`, `<n>h` (case-insensitive). Returns null on malformed input
 * so callers can fall back to DEFAULT_TTL_MS without crashing.
 */
export function parseTtl(spec: string | undefined | null): number | null {
  if (typeof spec !== 'string') return null
  const m = TTL_PATTERN.exec(spec.trim())
  if (!m) return null
  const n = Number.parseInt(m[1], 10)
  if (!Number.isFinite(n) || n < 0) return null
  switch (m[2].toLowerCase()) {
    case 'ms':
      return n
    case 's':
      return n * 1000
    case 'm':
      return n * 60_000
    case 'h':
      return n * 3_600_000
  }
  return null
}

/**
 * Interpret a parsed frontmatter as an OutboxEntry. Returns null when
 * required fields are missing or malformed (per ccsc-81q
 * "watcher crash しない"). The caller logs the path and skips the
 * entry.
 */
export function interpretOutboxEntry(
  path: string,
  fm: Frontmatter,
  body: string,
): OutboxEntry | null {
  const draft_id = fm.draft_id
  if (typeof draft_id !== 'string' || draft_id.length === 0) return null
  const status = fm.status
  if (!isOutboxStatus(status)) return null
  const created_at = fm.created_at
  if (typeof created_at !== 'string' || created_at.length === 0) return null

  const rawTtl = fm.ttl
  const ttl_ms = typeof rawTtl === 'string' ? (parseTtl(rawTtl) ?? DEFAULT_TTL_MS) : DEFAULT_TTL_MS

  return {
    path,
    draft_id,
    status,
    created_at,
    ttl_ms,
    slack_chat_id: typeof fm.slack_chat_id === 'string' ? fm.slack_chat_id : undefined,
    slack_thread_ts:
      typeof fm.slack_thread_ts === 'string' && fm.slack_thread_ts.length > 0
        ? fm.slack_thread_ts
        : undefined,
    approved_at:
      typeof fm.approved_at === 'string' && fm.approved_at.length > 0 ? fm.approved_at : undefined,
    approved_by:
      typeof fm.approved_by === 'string' && fm.approved_by.length > 0 ? fm.approved_by : undefined,
    target_role: typeof fm.target_role === 'string' ? fm.target_role : undefined,
    body,
    raw: fm,
  }
}

/**
 * List all parseable outbox entries under `dir`. Files that fail to
 * parse or that miss required fields are silently skipped (= the
 * watcher does not crash on a single malformed file).
 */
export function listOutboxEntries(dir: string): OutboxEntry[] {
  if (!existsSync(dir)) return []
  const entries: OutboxEntry[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue
    const path = join(dir, name)
    let content: string
    try {
      content = readFileSync(path, 'utf-8')
    } catch {
      continue
    }
    const parsed = parseFrontmatterFile(content)
    if (!parsed) continue
    const entry = interpretOutboxEntry(path, parsed.fm, parsed.body)
    if (entry) entries.push(entry)
  }
  return entries
}

/** Filter to entries whose status is `pending`. */
export function filterPending(entries: OutboxEntry[]): OutboxEntry[] {
  return entries.filter((e) => e.status === 'pending')
}

/** Filter to entries whose status is `approved`. */
export function filterApproved(entries: OutboxEntry[]): OutboxEntry[] {
  return entries.filter((e) => e.status === 'approved')
}

/**
 * Whether a pending entry is still within its TTL relative to `now`.
 * Used by the OK resolver and by the watcher's TTL sweep.
 */
export function isWithinTtl(entry: OutboxEntry, now: number): boolean {
  const created = Date.parse(entry.created_at)
  if (!Number.isFinite(created)) return false
  return now - created <= entry.ttl_ms
}

/**
 * Find an entry by draft_id. Returns null if no match. Returns the
 * first match when multiple files share the same draft_id, but
 * callers acting on the entry SHOULD first check
 * `findEntriesByDraftId(...).length > 1` (= duplicate detection)
 * and refuse to mutate when the bug case is hit.
 */
export function findEntryByDraftId(entries: OutboxEntry[], draftId: string): OutboxEntry | null {
  for (const e of entries) {
    if (e.draft_id === draftId) return e
  }
  return null
}

/**
 * All entries matching `draft_id`. Per Codex review on PR #5,
 * duplicate-draft-id must be REJECT (not warn-only) — approve,
 * cancel, and dispatchSweep gate on this length: if > 1, none of
 * the matching files are mutated and Hikaru is asked to resolve
 * manually.
 */
export function findEntriesByDraftId(entries: OutboxEntry[], draftId: string): OutboxEntry[] {
  return entries.filter((e) => e.draft_id === draftId)
}

/**
 * Detect duplicate draft_id across entries. Returns the duplicate ids
 * in input order. Bridge / watcher logs a warning when this is
 * non-empty (per ccsc-81q "再 write 禁止" — Codex bug indicator).
 */
export function findDuplicateDraftIds(entries: OutboxEntry[]): string[] {
  const seen = new Set<string>()
  const dups: string[] = []
  for (const e of entries) {
    if (seen.has(e.draft_id)) dups.push(e.draft_id)
    else seen.add(e.draft_id)
  }
  return dups
}

export type BareOkResolution =
  | { ok: true; entry: OutboxEntry }
  | {
      ok: false
      reason: 'no-pending' | 'multiple' | 'ttl-expired' | 'thread-mismatch'
      candidates: OutboxEntry[]
    }

/**
 * Resolve a bare `OK` against the current pending set. Returns
 * approval target ONLY when all three conditions hold (per ccsc-81q
 * "bare OK 受理"):
 *
 *   1. pending exactly 1
 *   2. that one is within TTL
 *   3. its slack_thread_ts matches messageThreadTs
 *
 * Otherwise returns a structured rejection with up to `candidateLimit`
 * candidates so the caller can render a "ambiguous, use approve
 * <draft-id>" reply.
 */
export function resolveBareOk(
  entries: OutboxEntry[],
  now: number,
  messageThreadTs: string | undefined,
  candidateLimit = 5,
): BareOkResolution {
  const pending = filterPending(entries)
  if (pending.length === 0) {
    return { ok: false, reason: 'no-pending', candidates: [] }
  }
  const topCandidates = pending
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(0, candidateLimit)
  if (pending.length > 1) {
    return { ok: false, reason: 'multiple', candidates: topCandidates }
  }
  const only = pending[0]
  if (!isWithinTtl(only, now)) {
    return { ok: false, reason: 'ttl-expired', candidates: [only] }
  }
  if (!only.slack_thread_ts || !messageThreadTs || only.slack_thread_ts !== messageThreadTs) {
    return { ok: false, reason: 'thread-mismatch', candidates: [only] }
  }
  return { ok: true, entry: only }
}

/**
 * Whether an approved entry should be dispatched at `now`.
 *
 *   - status === 'approved'
 *   - approved_at + APPROVE_GRACE_MS <= now (grace elapsed)
 *   - abort flag absent (dispatch not blocked)
 *
 * Returns false if any condition fails. The watcher's main loop calls
 * this for each approved entry on every poll cycle.
 */
export function shouldDispatch(
  entry: OutboxEntry,
  now: number,
  abortFlagPresent: boolean,
): boolean {
  if (entry.status !== 'approved') return false
  if (abortFlagPresent) return false
  if (!entry.approved_at) return false
  const approvedAt = Date.parse(entry.approved_at)
  if (!Number.isFinite(approvedAt)) return false
  return now - approvedAt >= APPROVE_GRACE_MS
}

/**
 * Whether a cancel for an approved entry is still within the grace
 * period (= can flip to cancelled instead of "too late: already
 * sent"). status must be `approved`.
 */
export function isWithinGrace(entry: OutboxEntry, now: number): boolean {
  if (entry.status !== 'approved') return false
  if (!entry.approved_at) return false
  const approvedAt = Date.parse(entry.approved_at)
  if (!Number.isFinite(approvedAt)) return false
  return now - approvedAt < APPROVE_GRACE_MS
}

/**
 * Re-write `entry.path` with a status transition (and optional
 * timestamp / actor / reason fields). Unrelated fm fields and the
 * body are preserved. Filename is unchanged.
 */
export function transitionEntry(
  entry: OutboxEntry,
  patch: Partial<{
    status: OutboxStatus
    approved_at: string
    approved_by: string
    cancelled_at: string
    sent_at: string
    failed_at: string
    failure_reason: string
  }>,
): void {
  const updated: Frontmatter = { ...entry.raw }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    updated[k] = v
  }
  const newContent = `---\n${serializeFrontmatter(updated)}\n---\n${entry.body || ''}`
  writeFileSync(entry.path, newContent)
}

/**
 * First non-empty body line, used as the per-entry summary in the
 * `pending?` reply and in OK ambiguity candidate lists. Returns an
 * empty string when the body is blank.
 */
export function summaryLine(entry: OutboxEntry): string {
  for (const ln of entry.body.split('\n')) {
    const t = ln.trim()
    if (t.length > 0) return t
  }
  return ''
}

/**
 * Parse the argument of `approve <draft-id>` / `cancel <draft-id>`
 * from the start of a Slack message (post-trigger). Returns the draft
 * id token (first whitespace-delimited word after the trigger), or
 * null when the user typed only the bare verb without an id (= format
 * error from the watcher's perspective).
 *
 * The trigger argument is the canonical lowercase trigger string
 * (matching the value detectTrigger() returns).
 */
export function extractDraftIdArg(text: string, trigger: 'approve' | 'cancel'): string | null {
  const t = text.trim()
  const lower = t.toLowerCase()
  if (!lower.startsWith(trigger)) return null
  const rest = t.slice(trigger.length).trim()
  if (rest.length === 0) return null
  return rest.split(/\s+/)[0] ?? null
}
