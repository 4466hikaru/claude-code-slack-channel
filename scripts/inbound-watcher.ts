#!/usr/bin/env bun
/**
 * scripts/inbound-watcher.ts
 *
 * Why this exists
 * ---------------
 * server.ts delivers each inbound DM to Claude Code via an MCP
 * notification (`notifications/claude/channel`, see server.ts around
 * the handleMessage / deliverEvent path). MCP notifications are
 * server-initiated and one-way: the message lands in the receiving
 * session's context as a <channel source="slack" ...> tag, but
 * Claude Code does NOT generate a response without a user turn.
 * An idle session stays idle. For a small set of allowlisted
 * prefixes we want immediate scripted responses; this watcher
 * polls Slack Web API directly and replies via chat.postMessage,
 * bypassing Claude Code entirely.
 *
 * Coexistence with the prod bridge
 * --------------------------------
 * The watcher does NOT open Socket Mode. The prod bridge owns the
 * singular Socket Mode connection. Both processes share the bot
 * token (read from $SLACK_STATE_DIR/.env); concurrent Web API calls
 * under a single bot identity are fine on Slack's side.
 *
 * Allowlisted triggers (longest-prefix wins for [abort *])
 *   [abort-test]    -> touch + verify + rm cycle on the abort flag,
 *                      reply "abort-test 完了、cleanup OK"
 *   [abort cleanup] -> rm -f the abort flag, reply "abort cleanup OK"
 *   [abort]         -> alias for [abort cleanup]
 *   status?         -> reply with watcher / state-dir / abort-flag status
 *   prs?            -> reply with `gh pr list` output
 *
 * Authorization
 *   Only messages whose Slack `user` equals the configured
 *   hikaruUserId are honored. Others are silently ignored.
 *
 * Destructive ops
 *   The only authorized destructive operation is `rm -f` on the
 *   hardcoded ABORT_FLAG path. The path is a const, never overridable
 *   from config or env.
 *
 * State files (in $SLACK_STATE_DIR)
 *   inbound-watcher.config.json   required: { hikaruUserId, hikaruDmChannel, pollIntervalMs? }
 *   inbound-watcher.last-ts       persisted last-seen Slack ts
 *   inbound-watcher.pid           single-instance lockfile
 *
 * Stop with Ctrl-C; the loop exits between polls (up to one
 * pollIntervalMs of latency).
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

// --- triggers (exported for testing) ----------------------------------

export const TRIGGERS = [
  '[abort-test]',
  '[abort cleanup]',
  '[abort]',
  'status?',
  'prs?',
] as const
export type Trigger = (typeof TRIGGERS)[number]

/**
 * Detect the trigger prefix at the start of a message body.
 * Returns null if no allowlisted prefix matches.
 *
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
  const pollIntervalMs = config.pollIntervalMs ?? 5000

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

  async function handleAbort(threadTs: string): Promise<void> {
    if (!existsSync(ABORT_FLAG)) {
      await reply(
        `abort cleanup: no flag at ${ABORT_FLAG}, nothing to do.`,
        threadTs,
      )
      return
    }
    execFileSync('rm', ['-f', ABORT_FLAG])
    await reply('abort cleanup OK', threadTs)
  }

  async function handleStatus(threadTs: string): Promise<void> {
    const lines = [
      'status:',
      `  watcher:    polling ${config.hikaruDmChannel} every ${pollIntervalMs}ms`,
      `  state dir:  ${STATE_DIR}`,
      `  abort flag: ${existsSync(ABORT_FLAG) ? 'PRESENT' : 'absent'} (${ABORT_FLAG})`,
    ]
    await reply(lines.join('\n'), threadTs)
  }

  async function handlePrs(threadTs: string): Promise<void> {
    let out: string
    try {
      out = execFileSync(
        'gh',
        [
          'pr',
          'list',
          '--repo',
          '4466hikaru/claude-code-slack-channel',
          '--state',
          'open',
          '--json',
          'number,title,state,url',
          '--jq',
          '.[] | "  #\\(.number) [\\(.state)] \\(.title) — \\(.url)"',
        ],
        { encoding: 'utf-8' },
      ).trim()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await reply(`prs?: gh pr list failed — ${msg}`, threadTs)
      return
    }
    await reply(`prs:\n${out || '  (no open PRs)'}`, threadTs)
  }

  async function dispatch(trigger: Trigger, threadTs: string): Promise<void> {
    switch (trigger) {
      case '[abort-test]':
        await handleAbortTest(threadTs)
        break
      case '[abort cleanup]':
      case '[abort]':
        await handleAbort(threadTs)
        break
      case 'status?':
        await handleStatus(threadTs)
        break
      case 'prs?':
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
