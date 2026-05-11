#!/usr/bin/env bun

/**
 * scripts/inbound-watcher.ts
 *
 * Why this exists
 * ---------------
 * server.ts delivers each inbound DM to Claude Code via an MCP
 * notification (`notifications/claude/channel`, fired from the deliver
 * branch of handleMessage). MCP notifications are server-initiated and
 * one-way: the message lands in the receiving Claude Code session as a
 * <channel source="slack" ...> tag in its context, but Claude does NOT
 * generate a response without a separate user turn. An idle session
 * stays idle. For a small allowlisted set of prefixes we want
 * immediate scripted responses; this watcher polls Slack Web API
 * directly and replies via chat.postMessage, bypassing Claude Code.
 *
 * Coexistence with the prod bridge
 * --------------------------------
 * The watcher does NOT open Socket Mode (the prod bridge owns the
 * singular connection). Both processes share the bot token (read from
 * $SLACK_STATE_DIR/.env on the watcher's side); concurrent Web API
 * calls under a single bot identity are fine on Slack's side.
 *
 * Allowlisted triggers (case-insensitive prefix match per the PR #8
 * Slack ops convention; the canonical lowercase form below is what is
 * returned to callers regardless of how the user typed it)
 *   [abort-test]    -> touch + verify + rm -f + verify cycle on the
 *                      abort flag; reply "abort-test 完了、cleanup OK"
 *   [abort]         -> touch + verify on the abort flag (CREATE);
 *                      reply with the flag path. NOTE: this raises the
 *                      abort flag, it does NOT clean up. Cleanup is the
 *                      separate [abort cleanup] command.
 *   [abort cleanup] -> rm -f + verify-absent on the abort flag; reply
 *   [codex-review]  -> parse args (3 forms: pr=<url>, issue=<url>,
 *                      repo=<owner/repo> pr=<number>) + summary=<text>;
 *                      reject token-like raw secrets; write/update YAML
 *                      frontmatter file under the absolute queue dir
 *                      `/home/hikaru/projects/hikaru-agent-knowledge/handoff/codex-review-queue/`;
 *                      cap pending+blocked at 50, warn above 20.
 *                      Phase 1 = queue WRITE only. Codex automation /
 *                      review / merge are out of scope for this Phase.
 *   ok              -> approved Codex outbox dispatch (bd ccsc-81q
 *                      Phase 1): bare `OK` approves the unique pending
 *                      draft IFF (1) exactly 1 pending, (2) within TTL,
 *                      (3) Slack thread matches. Otherwise replies
 *                      with the candidate list and asks for explicit
 *                      `approve <draft-id>`.
 *   approve <id>    -> explicit approve of a specific draft. Always
 *                      accepted, ambiguity-free; idempotent.
 *   cancel <id>     -> cancel a pending draft, or an approved draft
 *                      still inside the 5s grace window. After grace
 *                      / sent: reply "too late".
 *   pending?        -> list up to 5 pending drafts (oldest first)
 *                      with their summary first lines.
 *   status?         -> watcher alive / abort-flag presence / open PR
 *                      count across the 3 active repos / blocker
 *                      (`unknown` until a detection mechanism exists)
 *   prs?            -> top open PRs across the 3 active repos
 *                      (max 5 total)
 *
 * On every main-loop tick the watcher also runs a dispatch sweep
 * (`dispatchSweep`): pending entries past TTL auto-cancel; approved
 * entries past the 5s grace window dispatch over Slack Web API to
 * their `slack_chat_id` (held while the abort flag is present).
 *
 * Thread-reply polling (bd ccsc-v5m): in addition to the main DM
 * `conversations.history` poll, the watcher tracks every threadTs
 * it has replied into and polls each via `conversations.replies`
 * on every tick. Thread replies fire ONLY the approved-dispatch
 * verbs (`OK` / `approve` / `cancel` / `pending?`) — `[abort]` /
 * `[codex-review]` / `status?` / `prs?` stay main-DM-only to prevent
 * thread-injection misfire. Active threads have a 15-minute TTL and
 * are persisted to `$SLACK_STATE_DIR/inbound-watcher.active-threads.json`
 * so the watcher resumes thread tracking across restarts.
 *
 * Handler routing is pinned by routeTrigger() + the test file so that
 * the [abort] / [abort cleanup] semantics cannot accidentally flip.
 *
 * Authorization: per-trigger gate.
 *   - `[abort-test]` / `[abort]` / `[abort cleanup]` / `status?` /
 *     `prs?` are Hikaru-only (sender must equal `hikaruUserId`).
 *   - `[codex-review]` accepts any sender on the allowlist
 *     `codexReviewSenderUserIds` (default `[hikaruUserId]`). This
 *     lets bot / consultant / executor sessions push completion
 *     reports to the queue without going through Hikaru's account.
 *   Other senders are silently ignored at the gate.
 *
 * Destructive ops: the watcher manipulates ONE flag path only:
 *   /home/hikaru/projects/hikaru-agent-knowledge/handoff/abort-lv2
 * It is touched by [abort] and [abort-test] (write), and removed by
 * [abort cleanup] and [abort-test] (rm -f). The path is a const, not
 * overridable from config or env. The codex-review queue dir is a
 * separate write-only path (no rm).
 *
 * State files (in $SLACK_STATE_DIR)
 *   inbound-watcher.config.json   required: { hikaruUserId, hikaruDmChannel, pollIntervalMs?, codexReviewSenderUserIds? }
 *   inbound-watcher.last-ts       persisted last-seen Slack ts
 *   inbound-watcher.pid           single-instance lockfile
 *
 * Stop with Ctrl-C; the loop exits between polls (latency up to one
 * pollIntervalMs).
 */

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { WebClient } from '@slack/web-api'
import {
  archiveDoneFile,
  detectTokenInDoneEntry,
  EXECUTOR_DONE_DIR,
  formatDoneNotification,
  isRecentlyRelayed,
  listDoneEntries,
  listMalformedDoneFiles,
  pruneRecentlyRelayed,
} from './executor-relay'
import {
  APPROVE_GRACE_MS,
  extractDraftIdArg,
  filterApproved,
  filterPending,
  findDuplicateDraftIds,
  findEntriesByDraftId,
  findEntryByDraftId,
  isWithinGrace,
  isWithinTtl,
  listOutboxEntries,
  OUTBOX_DIR,
  type OutboxEntry,
  resolveBareOk,
  shouldDispatch,
  summaryLine,
  transitionEntry,
} from './outbox'
import {
  ACTIVE_THREADS_FILE_NAME,
  type ActiveThreadMap,
  loadActiveThreads,
  pruneStaleThreads,
  recordReply as recordThreadReply,
  saveActiveThreads,
  shouldProcessThreadMessage,
  updateLastSeen as updateThreadCursor,
} from './thread-tracker'

// --- constants --------------------------------------------------------

const STATE_DIR = process.env.SLACK_STATE_DIR || join(homedir(), '.claude', 'channels', 'slack')
const ENV_FILE = join(STATE_DIR, '.env')
const CONFIG_FILE = join(STATE_DIR, 'inbound-watcher.config.json')
const LAST_TS_FILE = join(STATE_DIR, 'inbound-watcher.last-ts')
const LOCK_FILE = join(STATE_DIR, 'inbound-watcher.pid')
const ACTIVE_THREADS_FILE = join(STATE_DIR, ACTIVE_THREADS_FILE_NAME)

/**
 * Subset of triggers that thread replies are allowed to fire. Per
 * bd ccsc-v5m: main DM polling stays open to all 10 triggers, but
 * thread reply polling restricts to the approved-dispatch verbs so a
 * thread-injected `[abort]` cannot misfire. `[codex-review]` also
 * stays main-DM-only (bot reply with that prefix would otherwise
 * loop back through itself in a thread).
 */
const THREAD_REPLY_TRIGGERS: ReadonlySet<string> = new Set(['ok', 'approve', 'cancel', 'pending?'])

// Hardcoded: the single destructive target the watcher is authorized
// to manipulate. Not env-configurable by design.
const ABORT_FLAG = '/home/hikaru/projects/hikaru-agent-knowledge/handoff/abort-lv2'

// Hardcoded absolute path of the codex-review queue dir (Phase 1 spec
// from bd ccsc-9hm). Created on first write, never removed by the
// watcher. NOT env-configurable in production.
const CODEX_REVIEW_QUEUE_DIR =
  '/home/hikaru/projects/hikaru-agent-knowledge/handoff/codex-review-queue'

// Hardcoded absolute path of the new-project request queue dir (bd
// ccsc-54g Phase 1). Created on first write, never removed by the
// watcher. NOT env-configurable in production.
export const PROJECT_REQUESTS_DIR =
  '/home/hikaru/projects/hikaru-agent-knowledge/handoff/project-requests'

// Cap on the body bytes the watcher will write into a project-request
// queue file. Excess body is truncated and the ack flags it.
export const NEW_PROJECT_BODY_MAX_BYTES = 8192

// Queue size caps for [codex-review]. Counts pending + blocked entries
// only (reviewed entries are excluded by countActiveEntries()).
const MAX_QUEUE_PENDING = 50
const WARN_QUEUE_PENDING = 20

// Allowed values for the optional `role=` argument on [codex-review].
// `hikaru` is the implicit default when sender == hikaruUserId; `agent`
// is the implicit default for any other allowlisted sender.
const ALLOWED_ROLES = new Set(['hikaru', 'consultant', 'executor', 'agent'])

// Repos surveyed by `prs?` and `status?`. Order is the listing order
// in `prs?` output. Total result rows are capped at PR_LIMIT.
const PR_REPOS = [
  '4466hikaru/hikaru-agent-knowledge',
  '4466hikaru/birth-kaitori',
  '4466hikaru/claude-code-slack-channel',
] as const
const PR_LIMIT = 5

// Poll interval bounds in milliseconds. Anything outside [MIN, MAX] or
// non-finite is replaced with DEFAULT (with a stderr warning). See
// clampPollInterval().
const POLL_MS_DEFAULT = 5000
const POLL_MS_MIN = 3000
const POLL_MS_MAX = 60000

// --- triggers (exported for testing) ----------------------------------

export const TRIGGERS = [
  '[abort-test]',
  '[abort cleanup]',
  '[abort]',
  '[codex-review]',
  '[新規]',
  '/new-project',
  'approve',
  'cancel',
  'ok',
  'pending?',
  'status?',
  'prs?',
] as const
export type Trigger = (typeof TRIGGERS)[number]

export type TriggerAction =
  | 'abort-test'
  | 'abort-create'
  | 'abort-cleanup'
  | 'codex-review-queue'
  | 'new-project-queue'
  | 'dispatch-ok'
  | 'dispatch-approve'
  | 'dispatch-cancel'
  | 'dispatch-pending'
  | 'status'
  | 'prs'

/**
 * Detect the trigger prefix at the start of a message body.
 *
 * Case-insensitive (PR #8 Slack ops convention): the input text is
 * lowercased before comparison, but the returned value is always the
 * canonical lowercase Trigger from TRIGGERS, so callers see the same
 * string regardless of how the user typed it (`[ABORT-TEST]`,
 * `[Abort-Test]`, and `[abort-test]` all resolve to `[abort-test]`).
 *
 * Order matters: '[abort cleanup]' is checked before '[abort]' so the
 * longer prefix wins on a message like "[abort cleanup] foo".
 */
export function detectTrigger(text: string): Trigger | null {
  const t = text.trim().toLowerCase()
  for (const trig of TRIGGERS) {
    if (!t.startsWith(trig)) continue
    // For triggers ending in a letter (= bare-word commands like `ok`,
    // `approve`, `cancel`), require a word boundary so "okay" or
    // "approver" do not accidentally trigger. Bracketed and `?`-suffixed
    // triggers are self-terminating and skip this check.
    const lastCh = trig[trig.length - 1]
    if (/[a-z]/i.test(lastCh)) {
      const nextCh = t[trig.length]
      if (nextCh !== undefined && /[a-z0-9_-]/i.test(nextCh)) continue
    }
    return trig
  }
  return null
}

/**
 * Map a trigger to its action name. Pinned by tests so the
 * [abort] / [abort cleanup] semantics cannot accidentally flip back to
 * the buggy alias-to-cleanup behavior, and so [codex-review] always
 * routes to the queue-write handler.
 *
 *   [abort]         => abort-create        (touch the flag)
 *   [abort cleanup] => abort-cleanup       (rm -f the flag)
 *   [abort-test]    => abort-test          (touch + verify + rm cycle)
 *   [codex-review]  => codex-review-queue  (queue file write)
 */
export function routeTrigger(trigger: Trigger): TriggerAction {
  switch (trigger) {
    case '[abort-test]':
      return 'abort-test'
    case '[abort]':
      return 'abort-create'
    case '[abort cleanup]':
      return 'abort-cleanup'
    case '[codex-review]':
      return 'codex-review-queue'
    case '[新規]':
    case '/new-project':
      return 'new-project-queue'
    case 'ok':
      return 'dispatch-ok'
    case 'approve':
      return 'dispatch-approve'
    case 'cancel':
      return 'dispatch-cancel'
    case 'pending?':
      return 'dispatch-pending'
    case 'status?':
      return 'status'
    case 'prs?':
      return 'prs'
  }
}

/**
 * Clamp pollIntervalMs to [POLL_MS_MIN, POLL_MS_MAX]. Anything outside
 * the range, undefined, or non-finite falls back to POLL_MS_DEFAULT
 * (with a stderr warning when out-of-range).
 */
export function clampPollInterval(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return POLL_MS_DEFAULT
  }
  if (raw < POLL_MS_MIN) {
    console.warn(
      `[watcher] pollIntervalMs=${raw} below min ${POLL_MS_MIN}; using default ${POLL_MS_DEFAULT}`,
    )
    return POLL_MS_DEFAULT
  }
  if (raw > POLL_MS_MAX) {
    console.warn(
      `[watcher] pollIntervalMs=${raw} above max ${POLL_MS_MAX}; using default ${POLL_MS_DEFAULT}`,
    )
    return POLL_MS_DEFAULT
  }
  return raw
}

// --- token detect (Phase 1: reject-only, no masking) ------------------

/**
 * Token-like patterns the watcher refuses to enqueue. Phase 1 is
 * reject-only by design (= avoid storing or echoing secrets). Masking
 * is deferred to Phase 2.
 *
 * Length thresholds are heuristics to avoid false positives on common
 * short words (e.g. "Bearer in mind").
 */
const TOKEN_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'xoxb', pattern: /\bxoxb-[A-Za-z0-9-]{20,}/ },
  { name: 'xapp', pattern: /\bxapp-[A-Za-z0-9-]{20,}/ },
  { name: 'sk', pattern: /\bsk-[A-Za-z0-9_-]{20,}/i },
  { name: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i },
  { name: 'ghp', pattern: /\bghp_[A-Za-z0-9]{20,}/ },
  { name: 'ghs', pattern: /\bghs_[A-Za-z0-9]{20,}/ },
]

/**
 * Detect a token-like raw secret in the input. Returns the matched
 * pattern name (e.g. "xoxb", "bearer") or null. The watcher rejects
 * any input that matches and replies with format error.
 */
export function detectToken(text: string): string | null {
  for (const { name, pattern } of TOKEN_PATTERNS) {
    if (pattern.test(text)) return name
  }
  return null
}

/**
 * Split the head args of a `[codex-review]` message on whitespace,
 * but treat `<...>` as a single token so a Slack mrkdwn auto-link
 * with a display text (e.g. `<https://x/y|PR #1>`) is not broken
 * mid-URL on the embedded space.
 *
 * Empty tokens (= consecutive whitespace) are dropped.
 */
function tokenizeHeadArgs(s: string): string[] {
  const tokens: string[] = []
  let cur = ''
  let inAngle = false
  for (const ch of s) {
    if (ch === '<') {
      inAngle = true
      cur += ch
    } else if (ch === '>') {
      inAngle = false
      cur += ch
    } else if (!inAngle && /\s/.test(ch)) {
      if (cur.length > 0) {
        tokens.push(cur)
        cur = ''
      }
    } else {
      cur += ch
    }
  }
  if (cur.length > 0) tokens.push(cur)
  return tokens
}

/**
 * Strip Slack mrkdwn URL auto-link wrappers from a value.
 *
 * Slack's mrkdwn renders any URL in a message as a clickable link and
 * stores it as `<url>` (or `<url|display text>`) when fetched via
 * conversations.history. The watcher's parser must accept both the
 * raw URL and the wrapped form so a `[codex-review] pr=https://...`
 * message survives the round trip through Slack regardless of who
 * typed it.
 *
 * Only values that look like a wrapped URL (`<http://...>` or
 * `<https://...>`, optionally with `|display`) are unwrapped. Other
 * values pass through unchanged so non-URL inputs (e.g. Form C's
 * `repo=owner/name`, `pr=5`) are not affected.
 */
export function stripSlackLinkWrap(s: string): string {
  if (/^<https?:\/\/[^>|\s]+(\|[^>]*)?>$/.test(s)) {
    const inner = s.slice(1, -1)
    const pipeIdx = inner.indexOf('|')
    return pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner
  }
  return s
}

// --- [codex-review] parser (exported for testing) ---------------------

export type CodexReviewParsed =
  | {
      form: 'pr-url'
      repo: string
      pr_number: number
      summary: string
      role?: string
    }
  | {
      form: 'issue-url'
      repo: string
      issue_url: string
      issue_number: number
      summary: string
      role?: string
    }
  | {
      form: 'repo-pr'
      repo: string
      pr_number: number
      summary: string
      role?: string
    }

export type CodexReviewError = { error: string }

/**
 * Parse the body of a `[codex-review]` Slack DM. Returns either a
 * structured result (one of three forms) or an error. The caller is
 * responsible for token detection and queue interaction.
 *
 * Forms (case-insensitive prefix and keys; values keep case):
 *   [codex-review] pr=<github-pr-url> summary=<text>
 *   [codex-review] issue=<github-issue-url> summary=<text>
 *   [codex-review] repo=<owner/repo> pr=<number> summary=<text>
 *
 * Rules:
 *   - Exactly one space between the prefix and the args.
 *   - `summary=` is always last; everything to end of line is the
 *     summary text (free-form, may contain spaces).
 *   - The three forms are exclusive (e.g. `pr=` and `issue=` together
 *     is invalid).
 *   - Optional `role=hikaru|consultant|executor|agent` (case-
 *     insensitive value). Invalid role -> error. Default sender_role
 *     resolution lives in the handler (hikaru if sender is the
 *     configured hikaruUserId, agent otherwise).
 *   - Unknown keys are an error.
 */
export function parseCodexReview(text: string): CodexReviewParsed | CodexReviewError {
  const trimmed = text.trim()
  // Case-insensitive prefix detection but keep original casing for
  // value extraction.
  const lowered = trimmed.toLowerCase()
  const prefix = '[codex-review] '
  if (!lowered.startsWith(prefix)) {
    return { error: 'missing [codex-review] prefix or no space after it' }
  }
  const args = trimmed.slice(prefix.length)

  // Locate `summary=` (case-insensitive) — it splits head args from
  // free-text body.
  const loweredArgs = args.toLowerCase()
  const summaryIdx = loweredArgs.indexOf('summary=')
  if (summaryIdx < 0) {
    return { error: 'missing summary= field' }
  }
  const headPart = args.slice(0, summaryIdx).trim()
  const summary = args.slice(summaryIdx + 'summary='.length).trim()
  if (!summary) {
    return { error: 'empty summary= value' }
  }

  // Parse head part as space-separated key=value pairs. Slack mrkdwn
  // can wrap URLs as `<url|display text>` where the display text may
  // contain whitespace, so a naive `.split(/\s+/)` would break the
  // token mid-URL. Tokenize while respecting `<...>` boundaries.
  const kvs: Record<string, string> = {}
  for (const tok of tokenizeHeadArgs(headPart)) {
    const eq = tok.indexOf('=')
    if (eq < 0) {
      return { error: `unknown token (no =): ${tok}` }
    }
    const k = tok.slice(0, eq).toLowerCase()
    const v = tok.slice(eq + 1)
    if (Object.hasOwn(kvs, k)) {
      return { error: `duplicate key: ${k}` }
    }
    kvs[k] = v
  }

  // Validate keys.
  const allowedKeys = new Set(['pr', 'issue', 'repo', 'role'])
  for (const k of Object.keys(kvs)) {
    if (!allowedKeys.has(k)) {
      return { error: `unknown key: ${k}` }
    }
  }

  // Optional `role=` validation. Lowercase the value so the canonical
  // form goes into the parsed result and downstream frontmatter.
  let role: string | undefined
  if ('role' in kvs) {
    const r = kvs.role.toLowerCase()
    if (!ALLOWED_ROLES.has(r)) {
      return {
        error: `invalid role=${kvs.role} (allowed: ${[...ALLOWED_ROLES].join(', ')})`,
      }
    }
    role = r
  }

  const hasPr = 'pr' in kvs
  const hasIssue = 'issue' in kvs
  const hasRepo = 'repo' in kvs

  // Exclusivity: issue= cannot combine with pr= or repo=.
  if (hasIssue && (hasPr || hasRepo)) {
    return { error: 'issue= cannot be combined with pr= or repo=' }
  }

  // Form B: issue=<github-issue-url> alone. Slack mrkdwn auto-link
  // wraps URLs as <url>; strip first so the same regex matches both
  // raw and wrapped forms.
  if (hasIssue) {
    const issueUrl = stripSlackLinkWrap(kvs.issue)
    const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:[?#].*)?$/.exec(issueUrl)
    if (!m) {
      return {
        error: 'issue= must be a GitHub issue URL (https://github.com/<owner>/<repo>/issues/<n>)',
      }
    }
    return {
      form: 'issue-url',
      repo: `${m[1]}/${m[2]}`,
      issue_url: issueUrl,
      issue_number: Number.parseInt(m[3], 10),
      summary,
      role,
    }
  }

  // Form C: repo=<owner/repo> + pr=<number>.
  if (hasRepo) {
    if (!hasPr) {
      return { error: 'repo= requires pr=<number>' }
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(kvs.repo)) {
      return { error: 'repo= must be <owner>/<name>' }
    }
    if (!/^\d+$/.test(kvs.pr)) {
      return { error: 'with repo=, pr= must be numeric' }
    }
    return {
      form: 'repo-pr',
      repo: kvs.repo,
      pr_number: Number.parseInt(kvs.pr, 10),
      summary,
      role,
    }
  }

  // Form A: pr=<github-pr-url> alone. Strip Slack mrkdwn auto-link
  // wrappers (<url> or <url|display>) before matching the URL regex
  // so the same parser works for human typists and Slack-rendered
  // messages.
  if (hasPr) {
    const prUrl = stripSlackLinkWrap(kvs.pr)
    const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[?#].*)?$/.exec(prUrl)
    if (!m) {
      return {
        error:
          'pr= must be a GitHub PR URL (https://github.com/<owner>/<repo>/pull/<n>) or paired with repo=<owner/repo>',
      }
    }
    return {
      form: 'pr-url',
      repo: `${m[1]}/${m[2]}`,
      pr_number: Number.parseInt(m[3], 10),
      summary,
      role,
    }
  }

  return { error: 'no pr= / issue= / repo= field provided' }
}

/**
 * Compute the dedup key for a parsed codex-review entry.
 * Same key => same logical PR/Issue.
 *
 *   pr forms (Form A or C) => "<repo>#pr-<n>"
 *   issue form (Form B)    => "<repo>#issue-<n>"
 */
export function computeQueueKey(parsed: CodexReviewParsed): string {
  if (parsed.form === 'issue-url') {
    return `${parsed.repo}#issue-${parsed.issue_number}`
  }
  return `${parsed.repo}#pr-${parsed.pr_number}`
}

/**
 * Build the queue filename. ISO timestamp has its `:` and `.` replaced
 * by `-` so the filename is valid on Windows (no `:` `*` `?` `<` `>`
 * `|` `"`). Repo's `/` becomes `_` so the filename has no path
 * separator.
 */
export function queueFilenameFor(createdAt: Date, parsed: CodexReviewParsed): string {
  const iso = createdAt.toISOString().replace(/[:.]/g, '-')
  const repoSafe = parsed.repo.replace(/\//g, '_')
  const idPart =
    parsed.form === 'issue-url'
      ? `${repoSafe}-issue${parsed.issue_number}`
      : `${repoSafe}-pr${parsed.pr_number}`
  return `${iso}-${idPart}.md`
}

// --- frontmatter (exported for testing) -------------------------------

export type FrontmatterValue = string | number | null
export type Frontmatter = Record<string, FrontmatterValue>

/**
 * Serialize a flat key/value map to YAML-ish frontmatter (one line per
 * key, double-quoted strings with backslash escapes for `\`, `"`,
 * `\n`, `\r`). Numbers and `null` are emitted bare.
 *
 * Intentionally minimal — the watcher controls both ends, so we don't
 * pull a YAML lib for nested structures we don't use.
 */

/**
 * Escape a string for the double-quoted YAML scalar form we emit.
 * Order matters: backslash MUST be escaped first so the backslash
 * introduced by subsequent escapes (`\"`, `\n`, `\r`) is not
 * re-escaped.
 */
export function escapeYamlString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')
}

/**
 * Inverse of escapeYamlString. Single-pass to avoid the order trap of
 * a multi-replace pipeline (the prior multi-replace would corrupt a
 * literal `\n` (= backslash + n in the source string) by treating it
 * as an escape after the leading backslash had already been doubled).
 *
 * Recognized escapes: `\\\\` -> `\`, `\\"` -> `"`, `\\n` -> newline,
 * `\\r` -> CR. Unknown escapes (`\\x`) are passed through verbatim
 * (= `\\x` stays `\\x` in the decoded string), so an unrecognized
 * escape never silently loses the leading backslash.
 */
export function unescapeYamlString(s: string): string {
  let out = ''
  let i = 0
  while (i < s.length) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const next = s[i + 1]
      if (next === '\\') out += '\\'
      else if (next === '"') out += '"'
      else if (next === 'n') out += '\n'
      else if (next === 'r') out += '\r'
      else out += `\\${next}` // unknown escape: keep verbatim (no silent drop)
      i += 2
    } else {
      out += s[i]
      i++
    }
  }
  return out
}

export function serializeFrontmatter(fm: Frontmatter): string {
  const lines: string[] = []
  for (const [k, v] of Object.entries(fm)) {
    if (v === null) {
      lines.push(`${k}: null`)
    } else if (typeof v === 'number') {
      lines.push(`${k}: ${v}`)
    } else {
      lines.push(`${k}: "${escapeYamlString(v)}"`)
    }
  }
  return lines.join('\n')
}

/**
 * Parse a `---\n<frontmatter>\n---\n<body>` file. Mirrors the shape
 * serializeFrontmatter() emits. Unknown YAML constructs (lists, nested
 * maps) are not supported by design.
 */
export function parseFrontmatterFile(content: string): { fm: Frontmatter; body: string } | null {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content)
  if (!m) return null
  const fm: Frontmatter = {}
  for (const line of m[1].split('\n')) {
    const lineMatch = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line)
    if (!lineMatch) continue
    const k = lineMatch[1]
    const raw = lineMatch[2].trim()
    if (raw === 'null') {
      fm[k] = null
    } else if (/^-?\d+$/.test(raw)) {
      fm[k] = Number.parseInt(raw, 10)
    } else if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      fm[k] = unescapeYamlString(raw.slice(1, -1))
    } else {
      fm[k] = raw
    }
  }
  return { fm, body: m[2] ?? '' }
}

// --- queue file ops (exported for testing, take queueDir param) -------

export interface QueueEntry {
  path: string
  fm: Frontmatter
  body: string
}

/**
 * List all parseable .md entries under queueDir. Returns an empty
 * array if the dir does not exist (= "no queue yet" = 0 entries).
 */
export function listQueueEntries(queueDir: string): QueueEntry[] {
  if (!existsSync(queueDir)) return []
  const out: QueueEntry[] = []
  for (const name of readdirSync(queueDir)) {
    if (!name.endsWith('.md')) continue
    const path = join(queueDir, name)
    let content: string
    try {
      content = readFileSync(path, 'utf-8')
    } catch {
      continue
    }
    const parsed = parseFrontmatterFile(content)
    if (parsed) out.push({ path, fm: parsed.fm, body: parsed.body })
  }
  return out
}

/**
 * Recover the dedup key from a stored frontmatter. Returns null if the
 * frontmatter does not have enough info to compute a key.
 */
export function entryKey(fm: Frontmatter): string | null {
  const repo = fm.repo
  if (typeof repo !== 'string') return null
  if (typeof fm.pr_number === 'number') return `${repo}#pr-${fm.pr_number}`
  if (typeof fm.issue_url === 'string') {
    const m = /\/issues\/(\d+)(?:[?#].*)?$/.exec(fm.issue_url)
    if (m) return `${repo}#issue-${m[1]}`
  }
  return null
}

/**
 * Find an entry with the given dedup key. Returns null if no match.
 */
export function findEntryByKey(queueDir: string, key: string): QueueEntry | null {
  for (const e of listQueueEntries(queueDir)) {
    if (entryKey(e.fm) === key) return e
  }
  return null
}

/**
 * Count entries whose status is `pending` or `blocked`. Reviewed
 * entries are excluded from the queue size cap.
 */
export function countActiveEntries(entries: QueueEntry[]): number {
  let n = 0
  for (const e of entries) {
    const s = e.fm.status
    if (s === 'pending' || s === 'blocked') n++
  }
  return n
}

// --- /new-project queue helpers (bd ccsc-54g Phase 1) ----------------

/**
 * Canonical /new-project trigger forms. Used to type-guard handler
 * branches and to distinguish the slash form from the Japanese alias
 * when recording `raw_prefix` in the queue file.
 */
export type NewProjectTrigger = '/new-project' | '[新規]'

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' as const

/**
 * Encode `time` (ms) as `length` Crockford-base32 chars, MSB-first.
 * length=10 covers ~ year 10889 for ms timestamps, matching ULID.
 */
export function encodeTimeBase32(time: number, length: number): string {
  let t = time
  const chars: string[] = []
  for (let i = 0; i < length; i++) {
    chars.unshift(ULID_ALPHABET[t % 32])
    t = Math.floor(t / 32)
  }
  return chars.join('')
}

/**
 * Encode `bytes` as `length` Crockford-base32 chars (5 bits / char).
 * Caller supplies enough random bytes (length * 5 / 8 rounded up).
 */
export function encodeRandomBase32(bytes: Uint8Array, length: number): string {
  let bits = 0
  let value = 0
  let out = ''
  for (let i = 0; i < bytes.length && out.length < length; i++) {
    value = (value << 8) | bytes[i]
    bits += 8
    while (bits >= 5 && out.length < length) {
      out += ULID_ALPHABET[(value >>> (bits - 5)) & 0x1f]
      bits -= 5
    }
  }
  if (out.length < length && bits > 0) {
    out += ULID_ALPHABET[(value << (5 - bits)) & 0x1f]
  }
  while (out.length < length) out += '0'
  return out
}

/**
 * Generate a 26-char Crockford-base32 ULID (10 time + 16 random).
 * `now` defaults to `Date.now()`; `randomBytes` defaults to 10 bytes
 * from `crypto.getRandomValues`. Both are injectable for tests.
 */
export function generateUlid(now: number = Date.now(), randomBytes?: Uint8Array): string {
  const t = encodeTimeBase32(now, 10)
  let r = randomBytes
  if (!r) {
    r = new Uint8Array(10)
    if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
      crypto.getRandomValues(r)
    } else {
      for (let i = 0; i < 10; i++) r[i] = Math.floor(Math.random() * 256)
    }
  }
  return t + encodeRandomBase32(r, 16)
}

/**
 * Strip the `/new-project` or `[新規]` prefix from the start of the
 * message, preserving the original case of the body (= detectTrigger
 * only lowercases for matching; the actual body must keep user case).
 * One leading space after the prefix is treated as a cosmetic
 * separator and dropped. Newlines / tabs after the prefix are kept
 * (they are part of the body).
 */
export function extractNewProjectBody(text: string, prefix: NewProjectTrigger): string {
  const trimmed = text.trimStart()
  const lower = trimmed.toLowerCase()
  if (!lower.startsWith(prefix)) return ''
  const rest = trimmed.slice(prefix.length)
  return rest.startsWith(' ') ? rest.slice(1) : rest
}

/**
 * Truncate a string to at most `maxBytes` bytes when encoded as UTF-8,
 * cutting on a valid UTF-8 boundary so the result is well-formed. The
 * caller flags the user that truncation happened.
 */
export function truncateBodyUtf8(
  body: string,
  maxBytes: number,
): { body: string; truncated: boolean } {
  const buf = Buffer.from(body, 'utf-8')
  if (buf.byteLength <= maxBytes) return { body, truncated: false }
  let cut = maxBytes
  while (cut > 0) {
    const candidate = buf.subarray(0, cut).toString('utf-8')
    if (!candidate.endsWith('�')) return { body: candidate, truncated: true }
    cut--
  }
  return { body: '', truncated: true }
}

/**
 * Replace every token-like substring (matching TOKEN_PATTERNS) with
 * `[REDACTED:<name>]`. Returns the sanitized body and the list of
 * pattern names that fired (deduped, insertion order). The watcher
 * uses the names to flag the user in the ack reply without echoing
 * the raw secret.
 */
export function sanitizeTokens(body: string): { body: string; redactedNames: string[] } {
  let result = body
  const names: string[] = []
  for (const { name, pattern } of TOKEN_PATTERNS) {
    const reGlobal = new RegExp(
      pattern.source,
      pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
    )
    if (reGlobal.test(result)) {
      names.push(name)
      result = result.replace(reGlobal, `[REDACTED:${name}]`)
    }
  }
  return { body: result, redactedNames: names }
}

/**
 * Compose the queue filename for a project request:
 *   `<created-iso-no-colon>-<request_id>.md`
 *
 * Example: `2026-05-12T0945-01HXY01NEWPROJ0ABC123.md`. Matches the
 * filename convention of `from-execute/done-*.md` archive.
 */
export function projectRequestFilename(createdAt: Date, requestId: string): string {
  const yyyy = createdAt.getUTCFullYear()
  const mm = String(createdAt.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(createdAt.getUTCDate()).padStart(2, '0')
  const hh = String(createdAt.getUTCHours()).padStart(2, '0')
  const mi = String(createdAt.getUTCMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}T${hh}${mi}-${requestId}.md`
}

/**
 * List parseable project-request entries in `dir`. Filters by
 * `type: project-request` so any unrelated files in the dir are
 * ignored. Returns an empty array if the dir does not exist.
 */
export function listProjectRequestEntries(dir: string): QueueEntry[] {
  if (!existsSync(dir)) return []
  const out: QueueEntry[] = []
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
    if (parsed.fm.type !== 'project-request') continue
    out.push({ path, fm: parsed.fm, body: parsed.body })
  }
  return out
}

/**
 * Idempotency check: was a project-request already queued for this
 * Slack `message_id`? Returns the entry if so, null otherwise. The
 * handler uses this to skip duplicate writes when the same message
 * is re-presented by `conversations.history` (e.g. after a watcher
 * restart with an earlier `lastTs`).
 */
export function findProjectRequestByMessageId(dir: string, messageId: string): QueueEntry | null {
  if (messageId.length === 0) return null
  for (const e of listProjectRequestEntries(dir)) {
    if (e.fm.slack_message_id === messageId) return e
  }
  return null
}

// --- config -----------------------------------------------------------

interface Config {
  hikaruUserId: string
  hikaruDmChannel: string
  pollIntervalMs?: number
  /**
   * Per-trigger allowlist for [codex-review] sender. Defaults to
   * [hikaruUserId]. Add Claude Bridge bot user_id, consultant /
   * executor session user_ids here so completion reports can post
   * directly to the queue without going through Hikaru's account.
   * The other 5 prefixes remain Hikaru-only regardless of this list.
   */
  codexReviewSenderUserIds?: string[]
}

function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE)) {
    console.error(`[watcher] missing config: ${CONFIG_FILE}`)
    console.error(
      '[watcher] expected JSON: { "hikaruUserId": "U...", "hikaruDmChannel": "D...", "pollIntervalMs": 5000, "codexReviewSenderUserIds": ["U..."] }',
    )
    process.exit(1)
  }
  const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Config
  if (!/^U[A-Z0-9]+$/.test(raw.hikaruUserId)) {
    throw new Error(`Invalid hikaruUserId in config: ${raw.hikaruUserId}`)
  }
  if (!/^D[A-Z0-9]+$/.test(raw.hikaruDmChannel)) {
    throw new Error(`Invalid hikaruDmChannel in config: ${raw.hikaruDmChannel}`)
  }
  if (raw.codexReviewSenderUserIds !== undefined) {
    if (!Array.isArray(raw.codexReviewSenderUserIds)) {
      throw new Error('codexReviewSenderUserIds must be a string array')
    }
    for (const u of raw.codexReviewSenderUserIds) {
      if (typeof u !== 'string' || !/^U[A-Z0-9]+$/.test(u)) {
        throw new Error(`Invalid user id in codexReviewSenderUserIds: ${u}`)
      }
    }
  }
  return raw
}

/**
 * Per-trigger sender gate. Only `[codex-review]` consults the
 * `codexReviewAllowlist`; every other trigger is Hikaru-only.
 *
 * The allowlist for `[codex-review]` is the resolved list (= the
 * caller is expected to fall the config's optional list back to
 * `[hikaruUserId]`). Returns false for any non-string userId so the
 * gate is closed by default for malformed Slack payloads.
 */
export function isAllowedSender(
  userId: string | undefined,
  trigger: Trigger,
  hikaruUserId: string,
  codexReviewAllowlist: readonly string[],
): boolean {
  if (typeof userId !== 'string' || userId.length === 0) return false
  if (trigger === '[codex-review]') {
    return codexReviewAllowlist.includes(userId)
  }
  return userId === hikaruUserId
}

function loadBotToken(): string {
  if (!existsSync(ENV_FILE)) {
    throw new Error(`Missing .env at ${ENV_FILE}`)
  }
  const content = readFileSync(ENV_FILE, 'utf-8')
  for (const line of content.split('\n')) {
    const m = /^SLACK_BOT_TOKEN=(.+)$/.exec(line.trim())
    if (m) return m[1]
  }
  throw new Error(`SLACK_BOT_TOKEN not found in ${ENV_FILE}`)
}

// --- gh helpers -------------------------------------------------------

interface PrSummary {
  repo: string
  number: number
  title: string
  url: string
}

type PrListResult = { ok: true; prs: PrSummary[] } | { ok: false; error: string }

function listOpenPrs(repo: string): PrListResult {
  try {
    const out = execFileSync(
      'gh',
      [
        'pr',
        'list',
        '--repo',
        repo,
        '--state',
        'open',
        '--json',
        'number,title,url',
        '--limit',
        String(PR_LIMIT),
      ],
      { encoding: 'utf-8' },
    )
    const arr = JSON.parse(out) as Array<{
      number: number
      title: string
      url: string
    }>
    return { ok: true, prs: arr.map((p) => ({ repo, ...p })) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// --- single-instance lock --------------------------------------------

function acquireLock(): void {
  if (existsSync(LOCK_FILE)) {
    const oldPid = Number.parseInt(readFileSync(LOCK_FILE, 'utf-8').trim(), 10)
    if (Number.isFinite(oldPid)) {
      try {
        process.kill(oldPid, 0)
        console.error(
          `[watcher] another watcher already running (pid ${oldPid}). Refusing to start.`,
        )
        process.exit(1)
      } catch {
        console.warn(`[watcher] stale pid file (pid ${oldPid} not running); cleaning up.`)
      }
    }
  }
  writeFileSync(LOCK_FILE, String(process.pid))
  process.on('exit', () => {
    try {
      unlinkSync(LOCK_FILE)
    } catch {
      // best effort
    }
  })
}

// --- main loop --------------------------------------------------------

interface SlackMessage {
  user?: string
  text?: string
  ts?: string
  thread_ts?: string
}

const FORMAT_HINT =
  'Expected: `[codex-review] pr=<github-pr-url> summary=<text>` or `issue=<url>` or `repo=<owner/repo> pr=<n>`'

async function main(): Promise<void> {
  acquireLock()
  const config = loadConfig()
  const slack = new WebClient(loadBotToken())
  const pollIntervalMs = clampPollInterval(config.pollIntervalMs)
  // Resolve the [codex-review] sender allowlist once at startup. Other
  // triggers ignore this list and stay Hikaru-only via isAllowedSender.
  const codexReviewAllowlist = config.codexReviewSenderUserIds ?? [config.hikaruUserId]

  let lastTs = existsSync(LAST_TS_FILE)
    ? readFileSync(LAST_TS_FILE, 'utf-8').trim()
    : String(Math.floor(Date.now() / 1000))

  // Active thread tracker (bd ccsc-v5m). Loaded once at startup and
  // re-saved on every reply / thread sweep so the watcher resumes
  // tracking after a restart.
  const activeThreads: ActiveThreadMap = loadActiveThreads(ACTIVE_THREADS_FILE)
  pruneStaleThreads(activeThreads, Date.now())

  // Executor completion relay dedup window (bd ccsc-sbf). RAM only —
  // the authoritative source of truth that a done file has been relayed
  // is the file's location (= once moved into `processed/`, it is no
  // longer listed by `listDoneEntries`). This map covers the rare race
  // where Slack post succeeded but archive failed; it expires entries
  // older than DONE_DEDUP_WINDOW_MS on each sweep.
  const recentlyRelayed = new Map<string, number>()

  console.log(
    `[watcher] starting; channel=${config.hikaruDmChannel} sender=${config.hikaruUserId} codexAllow=[${codexReviewAllowlist.join(',')}] pollMs=${pollIntervalMs} lastTs=${lastTs} activeThreads=${activeThreads.size}`,
  )

  async function reply(text: string, threadTs: string): Promise<void> {
    await slack.chat.postMessage({
      channel: config.hikaruDmChannel,
      text,
      thread_ts: threadTs,
      unfurl_links: false,
      unfurl_media: false,
    })
    // Track every thread the watcher replies into so follow-up Slack
    // replies (e.g. `approve <id>` typed inside a `pending?` thread)
    // are picked up by the thread-reply sweep. Refresh TTL on each
    // reply.
    recordThreadReply(activeThreads, threadTs, Date.now())
    try {
      saveActiveThreads(ACTIVE_THREADS_FILE, activeThreads)
    } catch (e) {
      console.error(
        `[watcher] saveActiveThreads error: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }

  async function handleAbortTest(threadTs: string): Promise<void> {
    if (existsSync(ABORT_FLAG)) {
      await reply(
        `abort-test pre-check failed: flag already present at ${ABORT_FLAG}. Run [abort cleanup] first.`,
        threadTs,
      )
      return
    }
    execFileSync('touch', [ABORT_FLAG])
    if (!existsSync(ABORT_FLAG)) {
      await reply('abort-test: touch did not create the flag (unexpected).', threadTs)
      return
    }
    execFileSync('rm', ['-f', ABORT_FLAG])
    if (existsSync(ABORT_FLAG)) {
      await reply('abort-test: rm did not remove the flag (unexpected).', threadTs)
      return
    }
    await reply('abort-test 完了、cleanup OK', threadTs)
  }

  async function handleAbortCreate(threadTs: string): Promise<void> {
    if (existsSync(ABORT_FLAG)) {
      await reply(`abort: flag already present at ${ABORT_FLAG}, no-op.`, threadTs)
      return
    }
    execFileSync('touch', [ABORT_FLAG])
    if (!existsSync(ABORT_FLAG)) {
      await reply('abort: touch did not create the flag (unexpected).', threadTs)
      return
    }
    await reply(`abort flag created at ${ABORT_FLAG}`, threadTs)
  }

  async function handleAbortCleanup(threadTs: string): Promise<void> {
    if (!existsSync(ABORT_FLAG)) {
      await reply(`abort cleanup: no flag at ${ABORT_FLAG}, nothing to do.`, threadTs)
      return
    }
    execFileSync('rm', ['-f', ABORT_FLAG])
    if (existsSync(ABORT_FLAG)) {
      await reply('abort cleanup: rm did not remove the flag (unexpected).', threadTs)
      return
    }
    await reply('abort cleanup OK', threadTs)
  }

  async function handleStatus(threadTs: string): Promise<void> {
    let prCount = 0
    let prError = false
    for (const repo of PR_REPOS) {
      const r = listOpenPrs(repo)
      if (r.ok) prCount += r.prs.length
      else prError = true
    }
    const prLine = prError
      ? 'unknown (gh error on at least one repo)'
      : `${prCount} (across hikaru-agent-knowledge, birth-kaitori, claude-code-slack-channel)`
    const lines = [
      'status:',
      '  watcher:    alive',
      `  abort flag: ${existsSync(ABORT_FLAG) ? 'PRESENT' : 'absent'} (${ABORT_FLAG})`,
      `  open PRs:   ${prLine}`,
      '  blocker:    unknown (no detection mechanism implemented in watcher)',
    ]
    await reply(lines.join('\n'), threadTs)
  }

  async function handlePrs(threadTs: string): Promise<void> {
    const all: PrSummary[] = []
    let errorRepo = ''
    let errorMsg = ''
    for (const repo of PR_REPOS) {
      const r = listOpenPrs(repo)
      if (r.ok) {
        all.push(...r.prs)
      } else if (!errorRepo) {
        errorRepo = repo
        errorMsg = r.error
      }
    }
    if (all.length === 0) {
      const baseMsg =
        'prs: (no open PRs across hikaru-agent-knowledge / birth-kaitori / claude-code-slack-channel)'
      await reply(
        errorRepo ? `${baseMsg}\n  warning: gh error on ${errorRepo}: ${errorMsg}` : baseMsg,
        threadTs,
      )
      return
    }
    const shown = all.slice(0, PR_LIMIT)
    const lines = shown.map(
      (p) => `  [${p.repo.replace('4466hikaru/', '')}] #${p.number} ${p.title} — ${p.url}`,
    )
    if (all.length > PR_LIMIT) {
      lines.push(`  (+${all.length - PR_LIMIT} more)`)
    }
    if (errorRepo) {
      lines.push(`  warning: gh error on ${errorRepo}: ${errorMsg}`)
    }
    await reply(`prs (open, max ${PR_LIMIT} across 3 repos):\n${lines.join('\n')}`, threadTs)
  }

  async function handleCodexReview(msg: SlackMessage, threadTs: string): Promise<void> {
    const text = typeof msg.text === 'string' ? msg.text : ''
    const ts = typeof msg.ts === 'string' ? msg.ts : ''
    const userId = typeof msg.user === 'string' ? msg.user : ''

    // 1. Token detect first — short-circuit before any parsing or
    // filesystem touch so secrets never get written or echoed.
    const tokenName = detectToken(text)
    if (tokenName) {
      await reply(
        `format error: token-like raw secret detected (pattern=${tokenName}); strip secrets and retry. ${FORMAT_HINT}`,
        threadTs,
      )
      return
    }

    // 2. Parse.
    const parsed = parseCodexReview(text)
    if ('error' in parsed) {
      await reply(`format error: ${parsed.error}. ${FORMAT_HINT}`, threadTs)
      return
    }

    const key = computeQueueKey(parsed)

    // Ensure queue dir exists (created on first write only).
    try {
      mkdirSync(CODEX_REVIEW_QUEUE_DIR, { recursive: true })
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      await reply(`[codex-review] failed to ensure queue dir: ${m}`, threadTs)
      return
    }

    // 3. Idempotent update path.
    const existing = findEntryByKey(CODEX_REVIEW_QUEUE_DIR, key)
    if (existing) {
      const existingSenderId = existing.fm.sender_id
      const allowed =
        (typeof existingSenderId === 'string' && existingSenderId === userId) ||
        userId === config.hikaruUserId
      if (!allowed) {
        await reply(
          `format error: only the original sender or Hikaru can update an existing queue entry`,
          threadTs,
        )
        return
      }
      const updated: Frontmatter = { ...existing.fm }
      updated.summary = parsed.summary
      updated.message_ts = ts
      updated.status = 'pending'
      // role= on update is honored as an explicit re-classification.
      // Without it the existing sender_role is preserved.
      if (parsed.role) {
        updated.sender_role = parsed.role
      }
      const newContent = `---\n${serializeFrontmatter(updated)}\n---\n${existing.body || ''}`
      writeFileSync(existing.path, newContent)
      const entries = listQueueEntries(CODEX_REVIEW_QUEUE_DIR)
      const active = countActiveEntries(entries)
      let line = `Codex review queue 更新済み (key=${key}, queue size: ${active})`
      if (active > WARN_QUEUE_PENDING) {
        line += ` ⚠️ size > ${WARN_QUEUE_PENDING}`
      }
      await reply(line, threadTs)
      return
    }

    // 4. New entry: enforce size cap.
    const beforeEntries = listQueueEntries(CODEX_REVIEW_QUEUE_DIR)
    const beforeActive = countActiveEntries(beforeEntries)
    if (beforeActive >= MAX_QUEUE_PENDING) {
      await reply(
        `format error: queue is full (${beforeActive} >= ${MAX_QUEUE_PENDING}); resolve some entries before adding more`,
        threadTs,
      )
      return
    }

    // 5. Write the new entry. Sender role precedence: explicit
    //    role= argument wins; otherwise derive from the sender
    //    (hikaruUserId -> "hikaru", any other allowlisted sender ->
    //    "agent"). All values come from the ALLOWED_ROLES set so the
    //    field is bounded.
    const createdAt = new Date()
    const senderRole = parsed.role ?? (userId === config.hikaruUserId ? 'hikaru' : 'agent')
    const fm: Frontmatter = {
      created_at: createdAt.toISOString(),
      source: 'slack',
      repo: parsed.repo,
      sender_role: senderRole,
      sender_id: userId,
      chat_id: config.hikaruDmChannel,
      message_ts: ts,
      summary: parsed.summary,
      status: 'pending',
      priority: 'P3',
    }
    if (parsed.form === 'issue-url') {
      fm.issue_url = parsed.issue_url
    } else {
      fm.pr_number = parsed.pr_number
    }
    const filename = queueFilenameFor(createdAt, parsed)
    const path = join(CODEX_REVIEW_QUEUE_DIR, filename)
    const content = `---\n${serializeFrontmatter(fm)}\n---\n`
    writeFileSync(path, content)

    const newActive = beforeActive + 1
    let line = `Codex review queue に登録済み (key=${key}, queue size: ${newActive})`
    if (newActive > WARN_QUEUE_PENDING) {
      line += ` ⚠️ size > ${WARN_QUEUE_PENDING}`
    }
    await reply(line, threadTs)
  }

  // --- /new-project request queue (bd ccsc-54g Phase 1) -------------

  /**
   * Handle the `/new-project` and `[新規]` prefixes. Writes a flat
   * YAML frontmatter file under PROJECT_REQUESTS_DIR with status
   * `drafting` and posts a Slack ack. The handler does NOT dispatch
   * Codex, does NOT create a repo, and does NOT alter approved
   * dispatch / executor relay state. Phase 2+ pick up the queue
   * file from there.
   *
   * Failure modes:
   * - abort flag present → skip + reply (= existing flag semantics)
   * - empty body (= prefix only) → reply prompt, no queue write
   * - body > NEW_PROJECT_BODY_MAX_BYTES → truncate, ack flags it
   * - body has token-like content → sanitize before write, ack flags it
   * - same Slack message_id already queued → no-op idempotent reply
   * - mkdir / write failure → reply error, no retry
   */
  async function handleNewProjectRequest(msg: SlackMessage, threadTs: string): Promise<void> {
    if (existsSync(ABORT_FLAG)) {
      await reply(
        `[new-project] abort flag present at ${ABORT_FLAG}; queue write skipped.`,
        threadTs,
      )
      return
    }

    const text = typeof msg.text === 'string' ? msg.text : ''
    const ts = typeof msg.ts === 'string' ? msg.ts : ''
    const trig = detectTrigger(text)
    if (trig !== '[新規]' && trig !== '/new-project') return
    const rawPrefix: NewProjectTrigger = trig

    const body0 = extractNewProjectBody(text, rawPrefix)
    if (body0.trim().length === 0) {
      await reply(
        `[new-project] 本文が空です。例: \`/new-project <project の概要 1 行以上>\``,
        threadTs,
      )
      return
    }

    const { body: bodyTrunc, truncated } = truncateBodyUtf8(body0, NEW_PROJECT_BODY_MAX_BYTES)
    const { body: bodyClean, redactedNames } = sanitizeTokens(bodyTrunc)

    try {
      mkdirSync(PROJECT_REQUESTS_DIR, { recursive: true })
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      await reply(`[new-project] queue dir 作成失敗: ${m}`, threadTs)
      return
    }

    const existing = findProjectRequestByMessageId(PROJECT_REQUESTS_DIR, ts)
    if (existing) {
      const existingId = typeof existing.fm.request_id === 'string' ? existing.fm.request_id : '?'
      await reply(
        `[new-project] 既に queue 起票済 (id=${existingId}, slack_message_id=${ts})、no-op.`,
        threadTs,
      )
      return
    }

    const createdAt = new Date()
    const requestId = generateUlid(createdAt.getTime())
    const fm: Frontmatter = {
      type: 'project-request',
      request_id: requestId,
      created_at: createdAt.toISOString(),
      source: 'desktop-slack',
      requester: 'hikaru',
      status: 'drafting',
      slack_chat_id: config.hikaruDmChannel,
      slack_message_id: ts,
      slack_thread_ts: threadTs,
      raw_prefix: rawPrefix,
      project_name: null,
      project_type: null,
      target_visibility: 'private',
      out_of_scope_inherits: 'true',
    }

    const filename = projectRequestFilename(createdAt, requestId)
    const path = join(PROJECT_REQUESTS_DIR, filename)
    const content = `---\n${serializeFrontmatter(fm)}\n---\n${bodyClean}`
    const tmpPath = `${path}.tmp.${process.pid}`
    try {
      writeFileSync(tmpPath, content)
      renameSync(tmpPath, path)
    } catch (e) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // tmp file may not exist if writeFileSync failed before creating it
      }
      const m = e instanceof Error ? e.message : String(e)
      await reply(`[new-project] queue 起票 NG (bridge log 確認要): ${m}`, threadTs)
      console.error(`[watcher] new-project queue write failed: ${m}`)
      return
    }

    const ackLines = [
      '📋 project request 起票済',
      `  id: ${requestId}`,
      '  status: drafting',
      '  次: Codex の brief 起草を待つ (= Phase 2)',
    ]
    if (truncated) {
      ackLines.push(
        `  ⚠ 本文 ${NEW_PROJECT_BODY_MAX_BYTES} byte 超を truncate、続報は別 message で`,
      )
    }
    if (redactedNames.length > 0) {
      ackLines.push(`  ⚠ token-like 検出 (${redactedNames.join(',')})、sanitize 済`)
    }
    await reply(ackLines.join('\n'), threadTs)
  }

  // --- approved Codex outbox dispatch (bd ccsc-81q Phase 1) ---------

  // Render a candidate / pending line. Includes the Slack target so
  // Hikaru can see WHERE a dispatch will go BEFORE typing OK / approve
  // (per Codex review on PR #5: target visibility before approval).
  function renderEntryLine(entry: OutboxEntry): string {
    const sum = summaryLine(entry) || '(no summary)'
    const target = entry.slack_chat_id ?? '(no chat_id)'
    return `  ${entry.draft_id}: ${sum} -> ${target}`
  }

  async function handleOk(msg: SlackMessage, threadTs: string): Promise<void> {
    const now = Date.now()
    const userId = typeof msg.user === 'string' ? msg.user : 'hikaru'
    const entries = listOutboxEntries(OUTBOX_DIR)
    const dups = findDuplicateDraftIds(entries)
    if (dups.length > 0) {
      console.warn(`[watcher] outbox duplicate draft_id: ${dups.join(', ')}`)
    }
    const messageThreadTs = (msg.thread_ts as string | undefined) ?? msg.ts
    const result = resolveBareOk(entries, now, messageThreadTs)
    if (!result.ok) {
      if (result.reason === 'no-pending') {
        await reply('OK: no pending drafts.', threadTs)
        return
      }
      const candLines = result.candidates.map((c) => renderEntryLine(c))
      await reply(
        `OK ambiguous (${result.reason}): use \`approve <draft-id>\` from below:\n${candLines.join('\n')}`,
        threadTs,
      )
      return
    }
    // Refuse to approve when the same draft_id appears in multiple
    // files (= Codex side bug indicator). Per Codex review, both
    // duplicates stay untouched and Hikaru is asked to resolve.
    if (findEntriesByDraftId(entries, result.entry.draft_id).length > 1) {
      await reply(
        `OK refused: draft_id ${result.entry.draft_id} has duplicate files in the outbox; manual cleanup required (no transition).`,
        threadTs,
      )
      return
    }
    transitionEntry(result.entry, {
      status: 'approved',
      approved_at: new Date(now).toISOString(),
      approved_by: userId,
    })
    const target = result.entry.slack_chat_id ?? '(no chat_id)'
    await reply(
      `approved ${result.entry.draft_id} -> ${target}, dispatch 中 (grace ${APPROVE_GRACE_MS}ms)`,
      threadTs,
    )
  }

  async function handleApprove(msg: SlackMessage, threadTs: string): Promise<void> {
    const text = typeof msg.text === 'string' ? msg.text : ''
    const draftId = extractDraftIdArg(text, 'approve')
    if (!draftId) {
      await reply('format error: expected `approve <draft-id>`', threadTs)
      return
    }
    const userId = typeof msg.user === 'string' ? msg.user : 'hikaru'
    const now = Date.now()
    const entries = listOutboxEntries(OUTBOX_DIR)
    const target = findEntryByDraftId(entries, draftId)
    if (!target) {
      await reply(`approve: draft_id ${draftId} not found in outbox`, threadTs)
      return
    }
    // Duplicate gate (Codex review on PR #5).
    if (findEntriesByDraftId(entries, draftId).length > 1) {
      await reply(
        `approve refused: draft_id ${draftId} has duplicate files in the outbox; manual cleanup required (no transition).`,
        threadTs,
      )
      return
    }
    switch (target.status) {
      case 'pending': {
        // TTL gate (Codex review on PR #5: bare-OK already checks
        // TTL via resolveBareOk; explicit approve must too).
        if (!isWithinTtl(target, now)) {
          transitionEntry(target, {
            status: 'cancelled',
            cancelled_at: new Date(now).toISOString(),
            failure_reason: 'ttl-expired',
          })
          await reply(
            `approve: ${draftId} ttl expired -> transitioned to cancelled (no dispatch)`,
            threadTs,
          )
          return
        }
        transitionEntry(target, {
          status: 'approved',
          approved_at: new Date(now).toISOString(),
          approved_by: userId,
        })
        const dispatchTarget = target.slack_chat_id ?? '(no chat_id)'
        await reply(
          `approved ${draftId} -> ${dispatchTarget}, dispatch 中 (grace ${APPROVE_GRACE_MS}ms)`,
          threadTs,
        )
        return
      }
      case 'approved':
        await reply(`approve: ${draftId} is already approved (idempotent no-op)`, threadTs)
        return
      case 'sent':
        await reply(`approve: ${draftId} already sent`, threadTs)
        return
      case 'cancelled':
      case 'failed':
        await reply(`approve: ${draftId} is ${target.status}, cannot approve`, threadTs)
        return
    }
  }

  async function handleCancel(msg: SlackMessage, threadTs: string): Promise<void> {
    const text = typeof msg.text === 'string' ? msg.text : ''
    const draftId = extractDraftIdArg(text, 'cancel')
    if (!draftId) {
      await reply('format error: expected `cancel <draft-id>`', threadTs)
      return
    }
    const now = Date.now()
    const entries = listOutboxEntries(OUTBOX_DIR)
    const target = findEntryByDraftId(entries, draftId)
    if (!target) {
      await reply(`cancel: draft_id ${draftId} not found in outbox`, threadTs)
      return
    }
    // Duplicate gate (Codex review on PR #5): refuse to cancel when
    // multiple files share the draft_id, so neither file is silently
    // mutated under the bug case.
    if (findEntriesByDraftId(entries, draftId).length > 1) {
      await reply(
        `cancel refused: draft_id ${draftId} has duplicate files in the outbox; manual cleanup required (no transition).`,
        threadTs,
      )
      return
    }
    switch (target.status) {
      case 'pending': {
        transitionEntry(target, {
          status: 'cancelled',
          cancelled_at: new Date(now).toISOString(),
        })
        await reply(`cancelled ${draftId}`, threadTs)
        return
      }
      case 'approved': {
        if (isWithinGrace(target, now)) {
          transitionEntry(target, {
            status: 'cancelled',
            cancelled_at: new Date(now).toISOString(),
          })
          await reply(`cancelled ${draftId} (within grace)`, threadTs)
        } else {
          await reply(
            `cancel: too late, ${draftId} grace expired (will dispatch on next sweep)`,
            threadTs,
          )
        }
        return
      }
      case 'sent':
        await reply(`cancel: too late, ${draftId} already sent`, threadTs)
        return
      case 'cancelled':
      case 'failed':
        await reply(`cancel: ${draftId} is already ${target.status}`, threadTs)
        return
    }
  }

  async function handlePending(_msg: SlackMessage, threadTs: string): Promise<void> {
    const entries = listOutboxEntries(OUTBOX_DIR)
    const pending = filterPending(entries)
      .slice()
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(0, 5)
    if (pending.length === 0) {
      await reply('pending: (no pending drafts)', threadTs)
      return
    }
    const lines = ['pending:']
    for (const e of pending) {
      lines.push(renderEntryLine(e))
    }
    // Surface duplicate-draft-id state in the pending? reply so Hikaru
    // sees the bug condition before typing OK / approve.
    const dups = findDuplicateDraftIds(entries)
    if (dups.length > 0) {
      lines.push(`  ⚠️ duplicate draft_id detected: ${dups.join(', ')} (manual cleanup required)`)
    }
    await reply(lines.join('\n'), threadTs)
  }

  /**
   * Outbox sweep: TTL-expire pending entries and dispatch approved
   * entries past the grace period (when the abort flag is absent).
   * Called once per main-loop tick after the inbound poll. Errors
   * during dispatch are logged + the entry transitions to `failed`.
   */
  async function dispatchSweep(): Promise<void> {
    const now = Date.now()
    const entries = listOutboxEntries(OUTBOX_DIR)
    const abortFlagPresent = existsSync(ABORT_FLAG)

    // Compute duplicate draft_ids once per sweep so each transition
    // can refuse to act on the bug case (per Codex review on PR #5:
    // duplicates are REJECT, not warn-only).
    const dupIds = new Set(findDuplicateDraftIds(entries))
    if (dupIds.size > 0) {
      console.warn(
        `[watcher] outbox sweep: skipping duplicate draft_id(s) ${[...dupIds].join(', ')} (manual cleanup required)`,
      )
    }

    // 1. TTL-expire pending entries.
    for (const e of filterPending(entries)) {
      if (dupIds.has(e.draft_id)) continue
      if (!isWithinTtl(e, now)) {
        transitionEntry(e, {
          status: 'cancelled',
          cancelled_at: new Date(now).toISOString(),
          failure_reason: 'ttl-expired',
        })
        console.log(`[watcher] outbox auto-cancel ttl-expired: ${e.draft_id}`)
      }
    }

    // 2. Dispatch approved entries that cleared the grace period.
    //    Abort flag holds dispatch (entries stay in `approved` until
    //    the abort is cleared and a later sweep picks them up).
    for (const e of filterApproved(entries)) {
      if (dupIds.has(e.draft_id)) continue
      if (!shouldDispatch(e, now, abortFlagPresent)) continue
      if (!e.slack_chat_id) {
        transitionEntry(e, {
          status: 'failed',
          failed_at: new Date(now).toISOString(),
          failure_reason: 'missing slack_chat_id',
        })
        console.error(`[watcher] outbox dispatch failed: ${e.draft_id} missing slack_chat_id`)
        continue
      }
      try {
        await slack.chat.postMessage({
          channel: e.slack_chat_id,
          text: e.body || `(empty draft ${e.draft_id})`,
          ...(e.slack_thread_ts ? { thread_ts: e.slack_thread_ts } : {}),
          unfurl_links: false,
          unfurl_media: false,
        })
        transitionEntry(e, {
          status: 'sent',
          sent_at: new Date(now).toISOString(),
        })
        console.log(`[watcher] outbox dispatched: ${e.draft_id}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        transitionEntry(e, {
          status: 'failed',
          failed_at: new Date(now).toISOString(),
          failure_reason: msg,
        })
        console.error(`[watcher] outbox dispatch failed: ${e.draft_id} ${msg}`)
      }
    }
  }

  async function dispatch(trigger: Trigger, msg: SlackMessage, threadTs: string): Promise<void> {
    switch (routeTrigger(trigger)) {
      case 'abort-test':
        await handleAbortTest(threadTs)
        break
      case 'abort-create':
        await handleAbortCreate(threadTs)
        break
      case 'abort-cleanup':
        await handleAbortCleanup(threadTs)
        break
      case 'codex-review-queue':
        await handleCodexReview(msg, threadTs)
        break
      case 'new-project-queue':
        await handleNewProjectRequest(msg, threadTs)
        break
      case 'dispatch-ok':
        await handleOk(msg, threadTs)
        break
      case 'dispatch-approve':
        await handleApprove(msg, threadTs)
        break
      case 'dispatch-cancel':
        await handleCancel(msg, threadTs)
        break
      case 'dispatch-pending':
        await handlePending(msg, threadTs)
        break
      case 'status':
        await handleStatus(threadTs)
        break
      case 'prs':
        await handlePrs(threadTs)
        break
    }
  }

  async function poll(): Promise<void> {
    const result = await slack.conversations.history({
      channel: config.hikaruDmChannel,
      oldest: lastTs,
      inclusive: false,
      limit: 50,
    })
    // conversations.history returns newest-first; flip to chronological.
    const messages = (result.messages ?? []).slice().reverse()
    for (const msg of messages) {
      if (typeof msg.text !== 'string' || typeof msg.ts !== 'string') continue
      const trig = detectTrigger(msg.text)
      if (!trig) continue
      // Per-trigger sender gate. [codex-review] uses the resolved
      // codexReviewAllowlist; everything else stays Hikaru-only.
      if (
        !isAllowedSender(
          msg.user as string | undefined,
          trig,
          config.hikaruUserId,
          codexReviewAllowlist,
        )
      ) {
        continue
      }
      const threadTs = (msg.thread_ts as string | undefined) ?? msg.ts
      console.log(`[watcher] trigger=${trig} ts=${msg.ts} sender=${msg.user} thread=${threadTs}`)
      try {
        await dispatch(trig, msg as SlackMessage, threadTs)
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e)
        console.error(`[watcher] handler ${trig} failed:`, errMsg)
        try {
          await reply(`[watcher] handler error for ${trig}: ${errMsg}`, threadTs)
        } catch {
          // best effort
        }
      }
    }
    if (messages.length > 0) {
      const newest = messages[messages.length - 1].ts
      if (typeof newest === 'string') {
        lastTs = newest
        writeFileSync(LAST_TS_FILE, lastTs)
      }
    }
  }

  /**
   * Thread-reply sweep (bd ccsc-v5m). For every active thread the
   * watcher previously replied into, poll `conversations.replies`
   * since the per-thread cursor. New replies feed `dispatch()` ONLY
   * when the detected trigger is in `THREAD_REPLY_TRIGGERS` and the
   * sender is allowed by the per-trigger gate (Hikaru-only for
   * dispatch verbs). Bot self-replies are filtered by the same gate.
   *
   * Stale threads are pruned first to bound API usage.
   */
  async function pollThreadReplies(): Promise<void> {
    const now = Date.now()
    const removed = pruneStaleThreads(activeThreads, now)
    if (removed.length > 0) {
      console.log(`[watcher] thread tracker pruned stale: ${removed.join(',')}`)
    }
    if (activeThreads.size === 0) return

    let mutated = false
    // Snapshot keys to avoid mutation-during-iteration if a sweep ends
    // up modifying activeThreads via reply().
    const threadIds = Array.from(activeThreads.keys())
    for (const threadTs of threadIds) {
      const state = activeThreads.get(threadTs)
      if (!state) continue
      let result: Awaited<ReturnType<typeof slack.conversations.replies>>
      try {
        result = await slack.conversations.replies({
          channel: config.hikaruDmChannel,
          ts: threadTs,
          oldest: state.lastSeenTs,
          limit: 50,
        })
      } catch (e) {
        console.error(
          `[watcher] conversations.replies error thread=${threadTs}: ${e instanceof Error ? e.message : String(e)}`,
        )
        continue
      }
      const replies = result.messages ?? []
      // conversations.replies returns the root first, then children
      // chronologically. Process in order; cursor advance is per-msg.
      let newest = state.lastSeenTs
      for (const msg of replies) {
        if (!shouldProcessThreadMessage(msg, threadTs, newest)) continue
        const text = msg.text as string
        const ts = msg.ts as string
        const trig = detectTrigger(text)
        if (!trig) {
          // Non-trigger message in the thread — advance cursor so we
          // don't re-evaluate it next sweep.
          newest = ts
          continue
        }
        if (!THREAD_REPLY_TRIGGERS.has(trig)) {
          // Trigger detected but not in the thread-reply allowlist
          // (= [abort] / [codex-review] / status? / prs? routed via
          // main DM only). Advance cursor; do not dispatch.
          newest = ts
          continue
        }
        if (
          !isAllowedSender(
            msg.user as string | undefined,
            trig,
            config.hikaruUserId,
            codexReviewAllowlist,
          )
        ) {
          newest = ts
          continue
        }
        const replyThread = (msg.thread_ts as string | undefined) ?? ts
        console.log(
          `[watcher] thread-reply trigger=${trig} ts=${ts} sender=${msg.user} thread=${replyThread}`,
        )
        try {
          await dispatch(trig, msg as SlackMessage, replyThread)
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e)
          console.error(`[watcher] thread handler ${trig} failed:`, errMsg)
          try {
            await reply(`[watcher] handler error for ${trig}: ${errMsg}`, replyThread)
          } catch {
            // best effort
          }
        }
        newest = ts
        mutated = true
      }
      if (newest !== state.lastSeenTs) {
        updateThreadCursor(activeThreads, threadTs, newest)
        mutated = true
      }
    }
    if (mutated) {
      try {
        saveActiveThreads(ACTIVE_THREADS_FILE, activeThreads)
      } catch (e) {
        console.error(
          `[watcher] saveActiveThreads error: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
    }
  }

  /**
   * Executor completion relay sweep (bd ccsc-sbf).
   *
   * Passive-execution sessions cannot post to Slack themselves. They
   * drop `done-*.md` files into EXECUTOR_DONE_DIR with a flat YAML
   * frontmatter (`type: done`, `done_id`, `status`, `summary`, plus
   * optional `related_bd` / `related_pr` / `executor_session` /
   * `needs_review`). This sweep:
   *
   * 1. Lists parseable done entries (= filename matches `done-*.md` AND
   *    frontmatter type is `done` AND required fields are present).
   * 2. For each entry, skips it if its `done_id` was relayed within the
   *    past 5 minutes (= advisory window covering the rare race where
   *    Slack post succeeded but archive failed).
   * 3. Token guard: if the summary or body contains a raw secret
   *    pattern, refuses to relay (= log only; file remains so the
   *    executor can inspect and re-write).
   * 4. Posts `✅ 実行役完了: <summary>` (+ status / done_id / optional
   *    bd / PR / `[review 待ち]`) to Hikaru's main DM (= NOT in a
   *    thread). On `chat.postMessage` success: `archiveDoneFile()`
   *    atomically moves the file into `processed/` and the done_id is
   *    recorded in the dedup map. On failure: file remains, no map
   *    entry, archive deferred to the next sweep.
   *
   * Malformed done files (= named `done-*.md` but failing interpret)
   * are logged once per sweep and left in place; the executor inspects
   * and re-writes. Other types (`result` / `propose` / `progress` /
   * `ask`) live in the same directory and MUST NOT be touched here —
   * those belong to the consultation coordinator path.
   */
  async function executorRelaySweep(): Promise<void> {
    const now = Date.now()
    const pruned = pruneRecentlyRelayed(recentlyRelayed, now)
    if (pruned.length > 0) {
      console.log(`[watcher] executor-relay pruned dedup: ${pruned.join(',')}`)
    }

    const malformed = listMalformedDoneFiles(EXECUTOR_DONE_DIR)
    for (const path of malformed) {
      console.error(`[watcher] executor-relay malformed done file (left in place): ${path}`)
    }

    const entries = listDoneEntries(EXECUTOR_DONE_DIR)
    for (const entry of entries) {
      if (isRecentlyRelayed(recentlyRelayed, entry.done_id, now)) {
        console.log(`[watcher] executor-relay skip (recently relayed): done_id=${entry.done_id}`)
        continue
      }
      const token = detectTokenInDoneEntry(entry)
      if (token !== null) {
        console.error(
          `[watcher] executor-relay token guard (${token}) — refusing to relay: done_id=${entry.done_id} path=${entry.path}`,
        )
        continue
      }
      const text = formatDoneNotification(entry)
      try {
        await slack.chat.postMessage({
          channel: config.hikaruDmChannel,
          text,
          unfurl_links: false,
          unfurl_media: false,
        })
      } catch (e) {
        console.error(
          `[watcher] executor-relay chat.postMessage error (file left in place) done_id=${entry.done_id}: ${e instanceof Error ? e.message : String(e)}`,
        )
        continue
      }
      try {
        const dest = archiveDoneFile(entry.path)
        recentlyRelayed.set(entry.done_id, Date.now())
        console.log(
          `[watcher] executor-relay relayed done_id=${entry.done_id} status=${entry.status} -> ${dest}`,
        )
      } catch (e) {
        // Slack post succeeded; archive failed. Mark dedup so the next
        // sweep does not double-post within the window. The file
        // remains in EXECUTOR_DONE_DIR — operator must move it
        // manually or let the next archive attempt succeed (which it
        // won't, since the file is still in place; but the dedup
        // window prevents re-notify until it expires).
        recentlyRelayed.set(entry.done_id, Date.now())
        console.error(
          `[watcher] executor-relay archive error (file remains, dedup recorded) done_id=${entry.done_id}: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
    }
  }

  let stop = false
  process.on('SIGINT', () => {
    stop = true
  })
  process.on('SIGTERM', () => {
    stop = true
  })

  while (!stop) {
    try {
      await poll()
    } catch (e) {
      console.error(`[watcher] poll error: ${e instanceof Error ? e.message : String(e)}`)
    }
    try {
      await dispatchSweep()
    } catch (e) {
      console.error(`[watcher] dispatch sweep error: ${e instanceof Error ? e.message : String(e)}`)
    }
    try {
      await pollThreadReplies()
    } catch (e) {
      console.error(
        `[watcher] thread reply sweep error: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    try {
      await executorRelaySweep()
    } catch (e) {
      console.error(
        `[watcher] executor relay sweep error: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    if (stop) break
    await new Promise((r) => setTimeout(r, pollIntervalMs))
  }
  console.log('[watcher] exit')
}

// Run main only when invoked as a script (not when imported by the
// test file). import.meta.main is Bun-specific.
if (import.meta.main) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
