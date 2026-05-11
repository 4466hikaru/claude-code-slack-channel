/**
 * scripts/lib/consult-queue.ts
 *
 * Mobile Codex Relay Phase 1 helpers (bd ccsc-nwm).
 *
 * Pure functions + filesystem readers / writers for the consult queue
 * and the from-codex plan reply path. Keeps `inbound-watcher.ts` thin
 * by isolating:
 *
 * 1. `isConsultRequest` — negative-list classifier for "is this DM
 *    body a natural-language consult request?" The existing watcher
 *    reserved-prefix routes win first; only the unrecognized tail
 *    becomes a consult.
 * 2. `analyzeConsultLength` — short-text gate (= mobile fragments
 *    must not pollute the queue).
 * 3. Queue file shape: `buildConsultFrontmatter`, filename helper,
 *    list / find by thread, append continuation log.
 * 4. From-codex side: `parseCodexPlanFile`, `formatPlanShortReply`
 *    (sanitize-aware short Slack reply).
 * 5. Hikaru reply parser: `parseHikaruConsultReply` distinguishes
 *    imperative (= "進めて" / `approve <consult_id>`) vs permissive
 *    (= bare "OK" / "任せる") vs abort vs edit, per
 *    `feedback_no_merge_by_claude.md`.
 *
 * Side-effect-free except for the explicit FS helpers
 * (`mkdirSync` / `writeFileSync` / `renameSync` are used by callers).
 * Never throws — the caller drives state-machine decisions from the
 * returned values and logs blockers.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Frontmatter, parseFrontmatterFile, serializeFrontmatter } from './frontmatter'

// --- constants --------------------------------------------------------

/**
 * Consult queue dir. Hardcoded absolute path so the watcher and any
 * Codex tooling (= manual `cat` in Phase 1, automation in Phase 2) hit
 * the exact same location. Created on first write via `mkdirSync
 * recursive`.
 */
export const CONSULT_QUEUE_DIR =
  '/home/hikaru/projects/hikaru-agent-knowledge/handoff/codex-consult-queue'

/**
 * From-codex dir for plan files. Shares physical location with the
 * approved-dispatch outbox (= `OUTBOX_DIR`) — plan files coexist with
 * outbox drafts and are distinguished by `type: codex-plan` (vs
 * outbox drafts which lack the `type` field and carry `draft_id` +
 * `status` from `KNOWN_STATUSES`). Outbox interpret skips plan files
 * cleanly because `draft_id` is absent.
 */
export const FROM_CODEX_DIR = '/home/hikaru/projects/hikaru-agent-knowledge/handoff/from-codex'

/**
 * Reserved-prefix list for the negative-list consult classifier. A DM
 * whose text (lowercased, trimmed) starts with any of these prefixes
 * is NOT a consult — it routes through the existing prefix
 * subroutines. `[abort` covers `[abort]` / `[abort-test]` /
 * `[abort cleanup]` in one entry so this list does not need to track
 * every closing-bracket variant.
 */
export const RESERVED_PREFIXES: readonly string[] = [
  'status?',
  'prs?',
  'pending?',
  '[abort',
  '[tech]',
  '[product]',
  '[bizdev]',
  '[marketing]',
  '[ops]',
  '[brainstorm]',
  '[整理]',
  '/queue',
  '[新規]',
  '/new-project',
  '[実行]',
  '/execute',
  '[codex-review]',
  // The trailing space discriminates `approve <id>` (= reserved) from
  // `approve してよい` (= natural language, falls through to consult
  // routing via the bare-token check below).
  'approve ',
  'approve-impl ',
  'cancel ',
  'cancel-impl ',
] as const

/**
 * Bare tokens (= word alone, no args). Treated as reserved so an
 * accidental single-word DM does not create a consult queue entry.
 * These are typically permissive answers to existing prompts.
 */
export const BARE_TOKENS: ReadonlySet<string> = new Set([
  'ok',
  'approve',
  'approve-impl',
  'cancel',
  'cancel-impl',
  'merge',
  'deploy',
])

/** UTF-16 code-unit length, matching `String.prototype.length`. */
function textLength(s: string): number {
  return s.length
}

/**
 * Negative-list consult classifier. Returns true when the text is a
 * candidate for the consult queue (= does NOT start with any reserved
 * prefix and is not a bare token). The short-length gate is applied
 * separately by `analyzeConsultLength` so the caller can distinguish
 * "ignore" / "ambiguous" / "normal".
 */
export function isConsultRequest(message: string): boolean {
  if (typeof message !== 'string') return false
  const trimmed = message.trim()
  if (trimmed.length === 0) return false
  const lower = trimmed.toLowerCase()
  for (const prefix of RESERVED_PREFIXES) {
    if (lower.startsWith(prefix.toLowerCase())) return false
  }
  if (BARE_TOKENS.has(lower)) return false
  return true
}

export type ConsultLengthKind = 'ignore' | 'ambiguous' | 'normal'

/**
 * Length gate (= bd spec A2):
 *   0       → ignore (= empty after trim)
 *   1-4     → ignore (= fragment, mobile continuation, too short)
 *   5-14    → ambiguous (= queue with `risk_guess: ambiguous`)
 *   15+     → normal (= queue with `risk_guess: null`)
 */
export function analyzeConsultLength(message: string): ConsultLengthKind {
  const trimmed = typeof message === 'string' ? message.trim() : ''
  const len = textLength(trimmed)
  if (len < 5) return 'ignore'
  if (len < 15) return 'ambiguous'
  return 'normal'
}

// --- channel-type heuristic (reuses ccsc-l34 pattern) -----------------

export type ConsultSourceChannelType = 'dm' | 'project-channel' | 'unknown'

export function classifyConsultSourceChannel(chatId: string): ConsultSourceChannelType {
  if (typeof chatId !== 'string' || chatId.length === 0) return 'unknown'
  if (chatId.startsWith('D')) return 'dm'
  if (chatId.startsWith('C')) return 'project-channel'
  return 'unknown'
}

// --- consult queue file shape ----------------------------------------

export type ConsultStatus =
  | 'pending'
  | 'planned'
  | 'approved'
  | 'dispatched'
  | 'blocked'
  | 'cancelled'

const TERMINAL_CONSULT_STATUSES: ReadonlySet<ConsultStatus> = new Set<ConsultStatus>([
  'approved',
  'dispatched',
  'cancelled',
])

/** True when the consult is past the active "waiting for plan / Hikaru" stage. */
export function isTerminalConsultStatus(s: string | undefined | null): boolean {
  return typeof s === 'string' && (TERMINAL_CONSULT_STATUSES as ReadonlySet<string>).has(s)
}

/**
 * Compose the queue filename: `<UTC iso-no-colon>-<request_id>.md`.
 * Mirrors the project-request and done-file conventions for
 * predictable archival ordering.
 */
export function consultRequestFilename(createdAt: Date, requestId: string): string {
  const y = createdAt.getUTCFullYear()
  const m = String(createdAt.getUTCMonth() + 1).padStart(2, '0')
  const d = String(createdAt.getUTCDate()).padStart(2, '0')
  const hh = String(createdAt.getUTCHours()).padStart(2, '0')
  const mi = String(createdAt.getUTCMinutes()).padStart(2, '0')
  return `${y}-${m}-${d}T${hh}${mi}-${requestId}.md`
}

export interface ConsultFrontmatterArgs {
  requestId: string
  createdAt: Date
  sourceChannel: string
  sender: string
  slackMessageId: string
  slackThreadTs: string
  riskGuess: 'ambiguous' | null
}

/**
 * Build the consult queue frontmatter. Phase 1 leaves the
 * Codex-side / Phase 3 fields (= `inferred_intent`, `codex_plan_ref`,
 * `hikaru_response`, `dispatched_to`) as `null`. The watcher only
 * writes; Codex / Phase 2-3 fill them in.
 */
export function buildConsultFrontmatter(args: ConsultFrontmatterArgs): Frontmatter {
  return {
    type: 'consult-request',
    request_id: args.requestId,
    created_at: args.createdAt.toISOString(),
    source_channel: args.sourceChannel,
    source_channel_type: classifyConsultSourceChannel(args.sourceChannel),
    sender: args.sender,
    slack_message_id: args.slackMessageId,
    slack_thread_ts: args.slackThreadTs,
    raw_prefix: null,
    status: 'pending',
    inferred_intent: null,
    risk_guess: args.riskGuess,
    codex_plan_ref: null,
    hikaru_response: null,
    dispatched_to: null,
    out_of_scope_inherits: 'true',
  }
}

export interface ConsultQueueEntry {
  path: string
  fm: Frontmatter
  body: string
}

/**
 * List parseable consult queue entries in `dir`. Filters by
 * `type: consult-request` so unrelated files in the dir (= future
 * archives / README) are ignored. Returns `[]` when the dir does not
 * exist — the caller is expected to create it on first write via
 * `mkdirSync`.
 */
export function listConsultEntries(dir: string): ConsultQueueEntry[] {
  if (!existsSync(dir)) return []
  const out: ConsultQueueEntry[] = []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  names.sort()
  for (const name of names) {
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
    if (parsed.fm.type !== 'consult-request') continue
    out.push({ path, fm: parsed.fm, body: parsed.body })
  }
  return out
}

/**
 * Find the consult entry matching `threadTs`. When `wantActiveOnly`
 * is true, terminal statuses are filtered out so a new utterance in
 * the same thread after an `approved` consult is reported as "no
 * active match" and the caller starts a fresh queue file.
 *
 * When multiple entries match (= legacy / race), the **newest by
 * `created_at`** is returned so the latest active state wins.
 */
export function findConsultByThreadTs(
  dir: string,
  threadTs: string,
  opts: { wantActiveOnly?: boolean } = {},
): ConsultQueueEntry | null {
  if (typeof threadTs !== 'string' || threadTs.length === 0) return null
  const wantActiveOnly = opts.wantActiveOnly ?? false
  let chosen: ConsultQueueEntry | null = null
  let chosenMs = -1
  for (const entry of listConsultEntries(dir)) {
    if (entry.fm.slack_thread_ts !== threadTs) continue
    if (wantActiveOnly && isTerminalConsultStatus(entry.fm.status as string)) continue
    const ca = typeof entry.fm.created_at === 'string' ? entry.fm.created_at : ''
    const t = ca.length > 0 ? Date.parse(ca) : 0
    const ms = Number.isFinite(t) ? t : 0
    if (ms >= chosenMs) {
      chosen = entry
      chosenMs = ms
    }
  }
  return chosen
}

/**
 * Idempotency check: was this exact Slack `message_id` already
 * queued? Returns the entry or null. Mirrors
 * `findProjectRequestByMessageId` so handler logic stays uniform.
 */
export function findConsultByMessageId(dir: string, messageId: string): ConsultQueueEntry | null {
  if (typeof messageId !== 'string' || messageId.length === 0) return null
  for (const entry of listConsultEntries(dir)) {
    if (entry.fm.slack_message_id === messageId) return entry
  }
  return null
}

/**
 * Append a continuation-log line to an existing consult queue file.
 * Pure FS mutation — the caller has already decided the message is a
 * continuation. The log block lives below the body under a fixed
 * `## continuation log` header; missing headers are tolerated (= the
 * line is appended at end-of-file).
 *
 * Returns the new file content so a test can assert exactly what was
 * written. The function itself writes; the return value is for
 * debugging / assertions.
 */
export function appendConsultContinuationLog(
  filePath: string,
  utterance: { text: string; slackMessageId: string; slackTs: string },
): string {
  const original = readFileSync(filePath, 'utf-8')
  const headerIdx = original.indexOf('## continuation log')
  const stamp = `- ${utterance.slackTs} (${utterance.slackMessageId}): ${utterance.text.replace(/\n/g, ' ')}`
  const tail = original.endsWith('\n') ? '' : '\n'
  let next: string
  if (headerIdx === -1) {
    // Header missing — append a fresh block at end.
    next = `${original}${tail}\n## continuation log\n${stamp}\n`
  } else {
    // Insert at end-of-file (= chronological order kept).
    next = `${original}${tail}${stamp}\n`
  }
  writeFileSync(filePath, next)
  return next
}

/**
 * Update only the frontmatter of a consult queue file in place,
 * preserving the body byte-for-byte. The file is read, the
 * frontmatter block is replaced with `serializeFrontmatter(newFm)`,
 * and the result is written back. Returns the new file content for
 * test assertions.
 */
export function rewriteConsultFrontmatter(filePath: string, newFm: Frontmatter): string {
  const original = readFileSync(filePath, 'utf-8')
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(original)
  const body = m ? (m[2] ?? '') : ''
  const next = `---\n${serializeFrontmatter(newFm)}\n---\n${body}`
  writeFileSync(filePath, next)
  return next
}

// --- from-codex plan -------------------------------------------------

export interface CodexPlanEntry {
  path: string
  plan_id: string
  related_consult_id: string
  slack_chat_id: string
  slack_thread_ts: string
  risk_level: string | null
  prod_gate: string | null
  status: string
  body: string
  fm: Frontmatter
}

/**
 * Parse a from-codex plan file. Returns null when:
 *  - the file lacks `---` frontmatter delimiters, OR
 *  - `type` is not `codex-plan` (= outbox drafts coexist; not
 *    malformed, just out of scope for this handler), OR
 *  - required fields (`plan_id`, `related_consult_id`,
 *    `slack_chat_id`, `slack_thread_ts`, `status`) are missing /
 *    wrong type.
 *
 * The caller treats null as "skip", not "error" — Codex may still be
 * mid-write or the file may belong to a different stream.
 */
export function parseCodexPlanFile(content: string): CodexPlanEntry | null {
  const parsed = parseFrontmatterFile(content)
  if (!parsed) return null
  const fm = parsed.fm
  if (fm.type !== 'codex-plan') return null
  const plan_id = fm.plan_id
  if (typeof plan_id !== 'string' || plan_id.length === 0) return null
  const related_consult_id = fm.related_consult_id
  if (typeof related_consult_id !== 'string' || related_consult_id.length === 0) return null
  const slack_chat_id = fm.slack_chat_id
  if (typeof slack_chat_id !== 'string' || slack_chat_id.length === 0) return null
  const slack_thread_ts = fm.slack_thread_ts
  if (typeof slack_thread_ts !== 'string' || slack_thread_ts.length === 0) return null
  const status = fm.status
  if (typeof status !== 'string' || status.length === 0) return null
  return {
    path: '',
    plan_id,
    related_consult_id,
    slack_chat_id,
    slack_thread_ts,
    risk_level: typeof fm.risk_level === 'string' ? fm.risk_level : null,
    prod_gate: typeof fm.prod_gate === 'string' ? fm.prod_gate : null,
    status,
    body: parsed.body,
    fm,
  }
}

/** List ready plan files in `dir` (= type=codex-plan AND status=ready). */
export function listReadyCodexPlans(dir: string): CodexPlanEntry[] {
  if (!existsSync(dir)) return []
  const out: CodexPlanEntry[] = []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  names.sort()
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const path = join(dir, name)
    let content: string
    try {
      content = readFileSync(path, 'utf-8')
    } catch {
      continue
    }
    const plan = parseCodexPlanFile(content)
    if (!plan) continue
    if (plan.status !== 'ready') continue
    out.push({ ...plan, path })
  }
  return out
}

/**
 * Extract up to `limit` bullet lines from a body section delimited by
 * Markdown `## <header>`. Returns the raw matched lines (no `- ` /
 * `* ` prefix stripping). Used for the short-format plan reply.
 */
export function extractMarkdownBullets(
  body: string,
  headerNames: readonly string[],
  limit: number,
): string[] {
  const lines = body.split('\n')
  const out: string[] = []
  let inSection = false
  for (const line of lines) {
    const hm = /^##\s+(.+?)\s*$/.exec(line)
    if (hm) {
      const heading = hm[1].toLowerCase()
      inSection = headerNames.some((n) => heading.includes(n.toLowerCase()))
      continue
    }
    if (!inSection) continue
    const bm = /^\s*(?:[-*]|\d+\.)\s+(.+?)\s*$/.exec(line)
    if (!bm) continue
    out.push(bm[1])
    if (out.length >= limit) break
  }
  return out
}

/**
 * Short-format Slack reply for a ready plan. Sanitizer is supplied
 * by the caller so we re-use `inbound-watcher.ts`'s `sanitizeTokens`
 * (= single source of truth) without circular imports.
 *
 * Output length is capped near 1000 chars by truncating the bullet
 * lists at 5 each.
 */
export function formatPlanShortReply(args: {
  plan: CodexPlanEntry
  consultId: string
  /**
   * Sanitizer hook (= inbound-watcher's `sanitizeTokens`). Receives
   * untrusted body content, returns sanitized text with redacted
   * names tracked separately. Made injectable so tests can provide
   * a stub.
   */
  sanitize: (text: string) => { body: string; redactedNames: string[] }
}): { text: string; redactedNames: string[] } {
  const { plan, consultId, sanitize } = args
  const files = extractMarkdownBullets(
    plan.body,
    ['files / repo to touch', 'files to touch', 'files'],
    5,
  )
  const acceptance = extractMarkdownBullets(plan.body, ['acceptance criteria', 'acceptance'], 5)
  const sanitizedFiles = files.map((f) => sanitize(f))
  const sanitizedAcceptance = acceptance.map((a) => sanitize(a))
  const allRedacted = new Set<string>()
  for (const r of sanitizedFiles) for (const n of r.redactedNames) allRedacted.add(n)
  for (const r of sanitizedAcceptance) for (const n of r.redactedNames) allRedacted.add(n)
  const fileLines = sanitizedFiles.map((r) => `  - ${r.body}`).join('\n') || '  (none listed)'
  const acceptanceLines =
    sanitizedAcceptance.map((r) => `  - ${r.body}`).join('\n') || '  (none listed)'
  const lines = [
    `📋 Plan ready (id: ${plan.plan_id})`,
    '',
    `risk: ${plan.risk_level ?? 'unspecified'}`,
    `gate: ${plan.prod_gate ?? 'unspecified'}`,
    'files:',
    fileLines,
    'acceptance:',
    acceptanceLines,
    '',
    `Hikaru の選択:`,
    `- ✅ 進めて (= "進めて" / "OK 進めて" / "approve ${consultId}")`,
    `- ✏ 修正 (= 自然文で修正点を返信)`,
    `- ❌ やめて (= "やめて" / "abort ${consultId}")`,
    '',
    `詳細: handoff/from-codex/${plan.plan_id}.md`,
  ]
  if (allRedacted.size > 0) {
    lines.push(`⚠ plan 本文に token-like 検出 (${[...allRedacted].join(',')})、sanitize 済`)
  }
  return { text: lines.join('\n'), redactedNames: [...allRedacted] }
}

// --- Hikaru reply parser ---------------------------------------------

export type HikaruConsultReply =
  | { kind: 'approve' }
  | { kind: 'abort' }
  | { kind: 'permissive' }
  | { kind: 'mismatch'; suppliedId: string }
  | { kind: 'edit'; text: string }
  | { kind: 'none' }

/** Imperative natural-language patterns that mean "approve, proceed". */
const IMPERATIVE_APPROVE_PATTERNS: readonly RegExp[] = [
  /^進めて(ください)?$/u,
  /^進めてください$/u,
  /^ok\s*進めて(ください)?$/iu,
  /^やる$/u,
  /^やってください$/u,
  /^実行して(ください)?$/u,
]

/** Permissive natural-language patterns that DO NOT progress status. */
const PERMISSIVE_PATTERNS: readonly RegExp[] = [
  /^ok$/iu,
  /^approve$/iu,
  /^approve\s*してよい$/iu,
  /^してよい$/u,
  /^していいよ$/u,
  /^任せる$/u,
]

/** Abort patterns (= imperative cancel). */
const ABORT_NATURAL_PATTERNS: readonly RegExp[] = [
  /^やめて$/u,
  /^中止$/u,
  /^cancel$/iu,
  /^abort$/iu,
]

/**
 * Parse a Hikaru thread reply in the context of a planned consult.
 *
 * The caller has already determined the thread has a consult queue
 * file in `status: planned` and passed the corresponding `consultId`.
 *
 * Decision matrix (= bd spec C2/C3):
 *
 *  - `approve <consultId>` (exact match) → `approve`
 *  - `approve <other-id>` → `mismatch` (caller replies "id doesn't
 *    match")
 *  - `abort <consultId>` → `abort`
 *  - imperative natural-language ("進めて", "実行して" 等) → `approve`
 *  - abort natural-language ("やめて", "中止") → `abort`
 *  - permissive ("OK", "approve", "任せる") → `permissive`
 *    (= caller posts confirm prompt; status unchanged)
 *  - long free-form text (= > 14 chars, not matching above) → `edit`
 *    (= continuation log + revert to pending)
 *  - empty / short fragment → `none`
 *
 * Returned `kind: 'edit'` carries the original text (untrimmed) so
 * the caller can append it to the continuation log verbatim.
 */
export function parseHikaruConsultReply(text: string, consultId: string): HikaruConsultReply {
  if (typeof text !== 'string') return { kind: 'none' }
  const trimmed = text.trim()
  if (trimmed.length === 0) return { kind: 'none' }
  const lower = trimmed.toLowerCase()

  // Permissive patterns must be checked BEFORE the `approve <id>`
  // regex so phrases like "approve してよい" (= permissive multi-token
  // sentence, not an id mismatch) are classified correctly.
  for (const re of PERMISSIVE_PATTERNS) {
    if (re.test(lower) || re.test(trimmed)) return { kind: 'permissive' }
  }
  for (const re of ABORT_NATURAL_PATTERNS) {
    if (re.test(lower) || re.test(trimmed)) return { kind: 'abort' }
  }
  for (const re of IMPERATIVE_APPROVE_PATTERNS) {
    if (re.test(lower) || re.test(trimmed)) return { kind: 'approve' }
  }

  const approveMatch = /^approve\s+(\S+)/i.exec(trimmed)
  if (approveMatch) {
    const id = approveMatch[1]
    if (id === consultId) return { kind: 'approve' }
    return { kind: 'mismatch', suppliedId: id }
  }
  const abortMatch = /^abort\s+(\S+)/i.exec(trimmed)
  if (abortMatch) {
    const id = abortMatch[1]
    if (id === consultId) return { kind: 'abort' }
    return { kind: 'mismatch', suppliedId: id }
  }

  if (trimmed.length < 5) return { kind: 'none' }
  return { kind: 'edit', text }
}

// --- replies the watcher posts back ---------------------------------

export function formatConsultAckReply(args: {
  requestId: string
  riskGuess: 'ambiguous' | null
  sourceChannelType: ConsultSourceChannelType
  redactedNames: string[]
}): string {
  const lines = [
    '📥 consult 受領、Codex の plan 起草を待ちます',
    `  id: ${args.requestId}`,
    '  status: pending',
  ]
  if (args.riskGuess === 'ambiguous') {
    lines.push('  ⚠ 短文 (5-14 char)、risk_guess: ambiguous で記録')
  }
  if (args.sourceChannelType === 'unknown') {
    lines.push('  ⚠ source channel 不明 (= D / C 以外の chat_id)、Hikaru 確認推奨')
  }
  if (args.redactedNames.length > 0) {
    lines.push(`  ⚠ token-like 検出 (${args.redactedNames.join(',')})、sanitize 済`)
  }
  return lines.join('\n')
}

export const CONSULT_APPROVED_REPLY = (consultId: string): string =>
  `✅ approved (consult ${consultId})、Phase 3 で実行役 dispatch 予定 (= 本 Phase 1 では prepare only、queue は status: approved に更新済み)`

export const CONSULT_CANCELLED_REPLY = (consultId: string): string =>
  `❌ cancelled (consult ${consultId})、queue file は履歴として残します`

export const CONSULT_PERMISSIVE_PROMPT = (consultId: string): string =>
  `permissive 表現 (= bare OK / 任せる 等) 単独では進めません。\`approve ${consultId}\` または \`「進めて」\` (imperative) で再返信お願いします`

export const CONSULT_EDIT_ACK = (consultId: string): string =>
  `✏ 修正受領 (consult ${consultId})、continuation log に追記済み・status を pending に戻しました。Codex に再起草を依頼してください`

export const CONSULT_MISMATCH_PROMPT = (consultId: string, suppliedId: string): string =>
  `consult_id が thread 内 consult と不一致 (= 受信 \`${suppliedId}\` / thread 側 \`${consultId}\`)。\`approve ${consultId}\` で再返信お願いします`
