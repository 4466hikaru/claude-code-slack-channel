/**
 * scripts/thread-tracker.ts
 *
 * State helpers for the inbound watcher's "active thread" tracker
 * (bd ccsc-v5m).
 *
 * `conversations.history` only returns top-level DM messages, so a
 * Slack reply inside a thread the watcher had previously posted into
 * never reaches the watcher via the main poll. Per Hikaru's runtime
 * test on PR #5, `approve runtime-test-003` sent inside the thread
 * that received the `pending?` reply was silently dropped.
 *
 * Solution: the watcher records every threadTs it has replied into,
 * keeps a small map with a short TTL, and polls each thread with
 * `conversations.replies` on every main-loop tick. New messages in
 * each tracked thread feed the regular trigger detection pipeline,
 * but the watcher restricts the set of triggers it acts on to the
 * approved-dispatch verbs only (`OK` / `approve` / `cancel` /
 * `pending?`) so a thread-injected `[abort]` cannot misfire.
 *
 * This module is pure (no Slack I/O). The watcher integrates the
 * helpers in `inbound-watcher.ts`.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * One tracked thread. `lastSeenTs` is the most recent message ts the
 * watcher has already processed in this thread (so the next poll
 * filters anything <= it). `expiresAt` is a wall-clock ms deadline
 * past which the entry is pruned to bound memory + Slack API usage.
 */
export interface ActiveThread {
  lastSeenTs: string
  expiresAt: number
}

export type ActiveThreadMap = Map<string, ActiveThread>

/**
 * Default TTL for an active thread entry: 15 minutes. Bare-OK / approve
 * usually follow a `pending?` within seconds, so 15 min has plenty of
 * headroom while keeping stale memory bounded.
 */
export const ACTIVE_THREAD_TTL_MS = 15 * 60_000

/**
 * Filename (under $SLACK_STATE_DIR) where the active-thread map is
 * persisted. Lets the watcher resume thread-reply polling across
 * restarts without losing in-flight threads.
 */
export const ACTIVE_THREADS_FILE_NAME = 'inbound-watcher.active-threads.json'

/**
 * Load the persisted map. Missing file or unparseable JSON returns an
 * empty map (= watcher is resilient to a corrupted state file; worst
 * case is the in-flight threads stop receiving polls until the next
 * watcher reply records a new entry).
 */
export function loadActiveThreads(path: string): ActiveThreadMap {
  if (!existsSync(path)) return new Map()
  try {
    const obj = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, ActiveThread>
    if (!obj || typeof obj !== 'object') return new Map()
    const map: ActiveThreadMap = new Map()
    for (const [k, v] of Object.entries(obj)) {
      if (
        v &&
        typeof v.lastSeenTs === 'string' &&
        typeof v.expiresAt === 'number' &&
        Number.isFinite(v.expiresAt)
      ) {
        map.set(k, { lastSeenTs: v.lastSeenTs, expiresAt: v.expiresAt })
      }
    }
    return map
  } catch {
    return new Map()
  }
}

/**
 * Persist the map. Serializes entries in insertion order; readers do
 * not depend on order.
 */
export function saveActiveThreads(path: string, map: ActiveThreadMap): void {
  const obj: Record<string, ActiveThread> = {}
  for (const [k, v] of map.entries()) {
    obj[k] = { lastSeenTs: v.lastSeenTs, expiresAt: v.expiresAt }
  }
  writeFileSync(path, JSON.stringify(obj, null, 2))
}

/**
 * Remove entries whose `expiresAt` is in the past (relative to `now`).
 * Returns the list of removed thread ids so the caller can log if
 * needed. Mutates the map in place.
 */
export function pruneStaleThreads(map: ActiveThreadMap, now: number): string[] {
  const removed: string[] = []
  for (const [k, v] of map.entries()) {
    if (v.expiresAt <= now) {
      map.delete(k)
      removed.push(k)
    }
  }
  return removed
}

/**
 * Record (or refresh) an active thread the watcher has just replied
 * into. If the thread is already tracked, the cursor is preserved and
 * only the TTL is extended.
 */
export function recordReply(
  map: ActiveThreadMap,
  threadTs: string,
  now: number,
  ttlMs: number = ACTIVE_THREAD_TTL_MS,
): void {
  const existing = map.get(threadTs)
  map.set(threadTs, {
    lastSeenTs: existing?.lastSeenTs ?? threadTs,
    expiresAt: now + ttlMs,
  })
}

/**
 * Advance a tracked thread's cursor to `newLastSeenTs` (only when the
 * thread is still tracked). No-op if the thread has been pruned.
 */
export function updateLastSeen(
  map: ActiveThreadMap,
  threadTs: string,
  newLastSeenTs: string,
): void {
  const existing = map.get(threadTs)
  if (existing) {
    existing.lastSeenTs = newLastSeenTs
  }
}

/**
 * Whether a single message returned by `conversations.replies` should
 * be evaluated by the watcher. Rejects:
 *
 *   - missing text or ts
 *   - the thread root itself (= ts === threadTs, returned by Slack
 *     even though we already saw it via main poll)
 *   - older-or-equal-to cursor (= already processed)
 *
 * Returns true when the message is a NEW reply worth trigger-detecting
 * downstream.
 */
export function shouldProcessThreadMessage(
  msg: { ts?: string; text?: string },
  threadTs: string,
  lastSeenTs: string,
): boolean {
  if (typeof msg.text !== 'string') return false
  if (typeof msg.ts !== 'string') return false
  if (msg.ts === threadTs) return false
  // Slack ts strings are zero-padded fixed-width fixed-decimal ("epoch.us"),
  // so lexicographic comparison matches numeric ordering.
  if (msg.ts <= lastSeenTs) return false
  return true
}
