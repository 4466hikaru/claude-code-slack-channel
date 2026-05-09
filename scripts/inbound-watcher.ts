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
 * Allowlisted triggers
 *   [abort-test]    -> touch + verify + rm -f + verify cycle on the
 *                      abort flag; reply "abort-test 完了、cleanup OK"
 *   [abort]         -> touch + verify on the abort flag (CREATE);
 *                      reply with the flag path. NOTE: this raises the
 *                      abort flag, it does NOT clean up. Cleanup is the
 *                      separate [abort cleanup] command.
 *   [abort cleanup] -> rm -f + verify-absent on the abort flag; reply
 *   status?         -> watcher alive / abort-flag presence / open PR
 *                      count across the 3 active repos / blocker
 *                      (`unknown` until a detection mechanism exists)
 *   prs?            -> top open PRs across the 3 active repos
 *                      (max 5 total)
 *
 * Handler routing is pinned by routeTrigger() + the test file so that
 * the [abort] / [abort cleanup] semantics cannot accidentally flip.
 *
 * Authorization: only messages whose Slack `user` equals the
 * configured hikaruUserId are honored. Other senders are silently
 * ignored.
 *
 * Destructive ops: the watcher manipulates ONE path only:
 *   /home/hikaru/projects/hikaru-agent-knowledge/handoff/abort-lv2
 * It is touched by [abort] and [abort-test] (write), and removed by
 * [abort cleanup] and [abort-test] (rm -f). The path is a const, not
 * overridable from config or env.
 *
 * State files (in $SLACK_STATE_DIR)
 *   inbound-watcher.config.json   required: { hikaruUserId, hikaruDmChannel, pollIntervalMs? }
 *   inbound-watcher.last-ts       persisted last-seen Slack ts
 *   inbound-watcher.pid           single-instance lockfile
 *
 * Stop with Ctrl-C; the loop exits between polls (latency up to one
 * pollIntervalMs).
 */

import { WebClient } from '@slack/web-api'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// --- constants --------------------------------------------------------

const STATE_DIR =
  process.env.SLACK_STATE_DIR || join(homedir(), '.claude', 'channels', 'slack')
const ENV_FILE = join(STATE_DIR, '.env')
const CONFIG_FILE = join(STATE_DIR, 'inbound-watcher.config.json')
const LAST_TS_FILE = join(STATE_DIR, 'inbound-watcher.last-ts')
const LOCK_FILE = join(STATE_DIR, 'inbound-watcher.pid')

// Hardcoded: the single destructive target the watcher is authorized
// to manipulate. Not env-configurable by design.
const ABORT_FLAG =
  '/home/hikaru/projects/hikaru-agent-knowledge/handoff/abort-lv2'

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
  'status?',
  'prs?',
] as const
export type Trigger = (typeof TRIGGERS)[number]

export type TriggerAction =
  | 'abort-test'
  | 'abort-create'
  | 'abort-cleanup'
  | 'status'
  | 'prs'

/**
 * Detect the trigger prefix at the start of a message body.
 * Order matters: '[abort cleanup]' is checked before '[abort]' so the
 * longer prefix wins on a message like "[abort cleanup] foo".
 */
export function detectTrigger(text: string): Trigger | null {
  const t = text.trim()
  for (const trig of TRIGGERS) {
    if (t.startsWith(trig)) return trig
  }
  return null
}

/**
 * Map a trigger to its action name. Pinned by tests so the
 * [abort] / [abort cleanup] semantics cannot accidentally flip back to
 * the buggy alias-to-cleanup behavior.
 *
 *   [abort]         => abort-create   (touch the flag)
 *   [abort cleanup] => abort-cleanup  (rm -f the flag)
 *   [abort-test]    => abort-test     (touch + verify + rm cycle)
 */
export function routeTrigger(trigger: Trigger): TriggerAction {
  switch (trigger) {
    case '[abort-test]':
      return 'abort-test'
    case '[abort]':
      return 'abort-create'
    case '[abort cleanup]':
      return 'abort-cleanup'
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

// --- config -----------------------------------------------------------

interface Config {
  hikaruUserId: string
  hikaruDmChannel: string
  pollIntervalMs?: number
}

function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE)) {
    console.error(`[watcher] missing config: ${CONFIG_FILE}`)
    console.error(
      '[watcher] expected JSON: { "hikaruUserId": "U...", "hikaruDmChannel": "D...", "pollIntervalMs": 5000 }',
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
  return raw
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

type PrListResult =
  | { ok: true; prs: PrSummary[] }
  | { ok: false; error: string }

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
        console.warn(
          `[watcher] stale pid file (pid ${oldPid} not running); cleaning up.`,
        )
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

async function main(): Promise<void> {
  acquireLock()
  const config = loadConfig()
  const slack = new WebClient(loadBotToken())
  const pollIntervalMs = clampPollInterval(config.pollIntervalMs)

  let lastTs = existsSync(LAST_TS_FILE)
    ? readFileSync(LAST_TS_FILE, 'utf-8').trim()
    : String(Math.floor(Date.now() / 1000))
  console.log(
    `[watcher] starting; channel=${config.hikaruDmChannel} sender=${config.hikaruUserId} pollMs=${pollIntervalMs} lastTs=${lastTs}`,
  )

  async function reply(text: string, threadTs: string): Promise<void> {
    await slack.chat.postMessage({
      channel: config.hikaruDmChannel,
      text,
      thread_ts: threadTs,
      unfurl_links: false,
      unfurl_media: false,
    })
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
      await reply(
        'abort-test: touch did not create the flag (unexpected).',
        threadTs,
      )
      return
    }
    execFileSync('rm', ['-f', ABORT_FLAG])
    if (existsSync(ABORT_FLAG)) {
      await reply(
        'abort-test: rm did not remove the flag (unexpected).',
        threadTs,
      )
      return
    }
    await reply('abort-test 完了、cleanup OK', threadTs)
  }

  async function handleAbortCreate(threadTs: string): Promise<void> {
    if (existsSync(ABORT_FLAG)) {
      await reply(
        `abort: flag already present at ${ABORT_FLAG}, no-op.`,
        threadTs,
      )
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
      await reply(
        `abort cleanup: no flag at ${ABORT_FLAG}, nothing to do.`,
        threadTs,
      )
      return
    }
    execFileSync('rm', ['-f', ABORT_FLAG])
    if (existsSync(ABORT_FLAG)) {
      await reply(
        'abort cleanup: rm did not remove the flag (unexpected).',
        threadTs,
      )
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
      (p) =>
        `  [${p.repo.replace('4466hikaru/', '')}] #${p.number} ${p.title} — ${p.url}`,
    )
    if (all.length > PR_LIMIT) {
      lines.push(`  (+${all.length - PR_LIMIT} more)`)
    }
    if (errorRepo) {
      lines.push(`  warning: gh error on ${errorRepo}: ${errorMsg}`)
    }
    await reply(
      `prs (open, max ${PR_LIMIT} across 3 repos):\n${lines.join('\n')}`,
      threadTs,
    )
  }

  async function dispatch(trigger: Trigger, threadTs: string): Promise<void> {
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
      if (msg.user !== config.hikaruUserId) continue
      if (typeof msg.text !== 'string' || typeof msg.ts !== 'string') continue
      const trig = detectTrigger(msg.text)
      if (!trig) continue
      const threadTs = (msg.thread_ts as string | undefined) ?? msg.ts
      console.log(
        `[watcher] trigger=${trig} ts=${msg.ts} thread=${threadTs}`,
      )
      try {
        await dispatch(trig, threadTs)
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e)
        console.error(`[watcher] handler ${trig} failed:`, errMsg)
        try {
          await reply(
            `[watcher] handler error for ${trig}: ${errMsg}`,
            threadTs,
          )
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
      console.error(
        `[watcher] poll error: ${e instanceof Error ? e.message : String(e)}`,
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
