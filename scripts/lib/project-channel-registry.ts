/**
 * scripts/lib/project-channel-registry.ts
 *
 * Project channel registry loader (bd ccsc-a04, Phase 2A of the
 * project channel model).
 *
 * Scans the queue directory written by the `/new-project` / `[新規]`
 * handler (bd ccsc-54g, schema extended in ccsc-l34) and returns the
 * list of project channels considered **active** — i.e. those that
 * have a Slack channel id filled in and are not in a terminal state.
 *
 * Scope is intentionally narrow: this is **loader only**. The
 * watcher polling loop does NOT call this module yet (= Phase 2B
 * wires multi-channel polling, Phase 2C wires the route handler).
 * Until then this file is dead code in production and is exercised
 * only by unit tests.
 *
 * Hard contracts:
 *
 * - **Pure function.** No filesystem writes, no Slack API calls, no
 *   state-file mutation, no caching across calls. Re-scans every
 *   invocation so the caller controls the refresh cadence.
 * - **Never throws.** Failures (missing dir, parse error, bad id,
 *   duplicate channel id) are surfaced via numeric counters on the
 *   returned `RegistryLoadResult`. The caller is expected to log /
 *   fall back gracefully — silent failure is not an option for the
 *   consumer (Phase 2B), so the loader hands the counters up
 *   instead of swallowing them.
 * - **Sourced from queue file frontmatter.** The Phase 1 schema
 *   (ccsc-l34) is the authoritative source of channel state; no
 *   secondary registry / database is consulted.
 * - **Backward compatible.** Old queue files written before the
 *   channel fields existed (= Phase 0 / pre-ccsc-l34) parse cleanly
 *   and are simply not active.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatterFile } from './frontmatter'

/**
 * One entry in the active-channel list. `project_channel_id` is
 * guaranteed to be a non-empty `C...` string (= the Slack channel id
 * heuristic); the loader rejects anything else as malformed before
 * an entry reaches this list.
 */
export interface ActiveProjectChannel {
  /** ULID from the queue file (= `request_id` in the frontmatter). */
  request_id: string
  /** Slack channel id, `C...` prefix, non-empty. */
  project_channel_id: string
  /** `proj-<project_name>` or null when Phase 2 has not filled it yet. */
  project_channel_name: string | null
  /**
   * `pending` / `active` / null when no explicit status field is
   * set. `archived` / `cancelled` / `failed` are filtered out before
   * the entry reaches this list, so they never appear here.
   */
  project_channel_status: string | null
  /** ISO datetime from the queue file. May be empty when missing. */
  created_at: string
  /** Absolute path to the source queue file (debug-only). */
  source_path: string
}

/**
 * Aggregate return type. The counters let the caller log / alert
 * without re-scanning the directory. `active` is sorted by
 * `created_at` ascending (oldest first) for stable iteration; ties
 * fall back to the source filename.
 */
export interface RegistryLoadResult {
  active: ActiveProjectChannel[]
  /** Files that failed parse OR had a non-`C...` channel id. */
  malformed_count: number
  /** Files dropped because a newer entry covered the same channel id. */
  duplicate_skip_count: number
  /** Total `.md` files inspected (= parseable + malformed). */
  total_files: number
}

/**
 * Terminal statuses that exclude a queue file from the active set
 * even when its `project_channel_id` is filled in. `pending` /
 * `active` / null are NOT in this set — `pending` queues are still
 * polled because the id is what matters for routing; the status
 * field tracks the Phase 2 manual brief workflow, not the channel's
 * actual existence.
 */
const TERMINAL_PROJECT_CHANNEL_STATUSES: ReadonlySet<string> = new Set([
  'archived',
  'cancelled',
  'failed',
])

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function asStringOrEmpty(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * Compare two ISO-8601 datetimes as numeric ms. Missing / unparseable
 * values are treated as the epoch (`0`) so they always lose to a
 * well-formed timestamp during deduplication, falling back to file-
 * order tie-breaks.
 */
function createdAtMs(s: string): number {
  if (s.length === 0) return 0
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : 0
}

/**
 * Load active project channels from `queueDir`. See file-level JSDoc
 * for the full contract.
 *
 * @param queueDir Absolute path to the project-requests queue dir.
 *   Typically `/home/hikaru/projects/hikaru-agent-knowledge/handoff/project-requests/`.
 */
export function loadActiveProjectChannels(queueDir: string): RegistryLoadResult {
  const result: RegistryLoadResult = {
    active: [],
    malformed_count: 0,
    duplicate_skip_count: 0,
    total_files: 0,
  }

  if (!existsSync(queueDir)) return result

  let names: string[]
  try {
    names = readdirSync(queueDir)
  } catch {
    // The dir existed at the existsSync check but is unreadable now
    // (= race / permission). Treat as empty rather than throwing.
    return result
  }
  // Sort alphabetically so the dedup tie-break (= "last in iteration
  // wins" when created_at is missing on both sides) is deterministic
  // across platforms / filesystems. readdirSync order is not
  // guaranteed on Linux ext4.
  names.sort()

  // First pass: parse every .md file and keep parseable + active
  // candidates. Defer dedup to a second pass so we can pick the
  // newest entry per channel id.
  const candidates: ActiveProjectChannel[] = []

  for (const name of names) {
    if (!name.endsWith('.md')) continue
    result.total_files += 1
    const path = join(queueDir, name)

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

    const fm = parsed.fm
    // Non-project-request files in the same dir are not interesting
    // and not malformed — they belong to other workflows (none today,
    // but the dir is shared with future flows).
    if (fm.type !== 'project-request') continue

    const project_channel_id_raw = fm.project_channel_id
    // Phase 1 queue files write `project_channel_id: null` until
    // Hikaru manually creates the channel and Phase 2 fills the id.
    // Null / missing / empty is the expected non-active state — not
    // malformed.
    if (project_channel_id_raw === null || project_channel_id_raw === undefined) continue
    if (typeof project_channel_id_raw !== 'string' || project_channel_id_raw.length === 0) {
      // Wrong type / empty string falls through the normal "not yet
      // active" path. We deliberately do NOT count this as malformed
      // because backward-compat schema may have the field absent or
      // explicitly null.
      continue
    }
    if (!project_channel_id_raw.startsWith('C')) {
      // The id is set but does not match the Slack channel-id
      // heuristic (= must start with `C`). This is a Phase 1 schema
      // violation, count as malformed.
      result.malformed_count += 1
      continue
    }

    const status = asString(fm.project_channel_status)
    if (status !== null && TERMINAL_PROJECT_CHANNEL_STATUSES.has(status)) {
      // archived / cancelled / failed — skip but not malformed.
      continue
    }

    candidates.push({
      request_id: asStringOrEmpty(fm.request_id),
      project_channel_id: project_channel_id_raw,
      project_channel_name: asString(fm.project_channel_name),
      project_channel_status: status,
      created_at: asStringOrEmpty(fm.created_at),
      source_path: path,
    })
  }

  // Dedup by project_channel_id, keeping the newest `created_at`. On
  // a tie (= equal ms) the candidate that appears later in
  // readdirSync order wins, which is filesystem-defined but stable
  // within a single load.
  const byChannelId = new Map<string, ActiveProjectChannel>()
  for (const c of candidates) {
    const prev = byChannelId.get(c.project_channel_id)
    if (!prev) {
      byChannelId.set(c.project_channel_id, c)
      continue
    }
    const prevMs = createdAtMs(prev.created_at)
    const curMs = createdAtMs(c.created_at)
    if (curMs >= prevMs) {
      byChannelId.set(c.project_channel_id, c)
    }
    result.duplicate_skip_count += 1
  }

  result.active = Array.from(byChannelId.values()).sort((a, b) => {
    const aMs = createdAtMs(a.created_at)
    const bMs = createdAtMs(b.created_at)
    if (aMs !== bMs) return aMs - bMs
    // Tie-break on source path so the sort is deterministic across
    // platforms with stable filesystem iteration order.
    return a.source_path.localeCompare(b.source_path)
  })

  return result
}
