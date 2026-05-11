#!/usr/bin/env bun
/**
 * scripts/terminal-consult.ts
 *
 * G2 / terminal -> Slack DM + Codex consult queue relay.
 *
 * This intentionally does NOT execute work. It only turns text spoken
 * into a terminal session into the same durable consult shape that the
 * Slack inbound watcher already understands:
 *
 *   terminal text -> Slack DM root message -> codex-consult-queue/*.md
 *
 * The existing watcher then handles Codex plan replies / Hikaru approve
 * / executor dispatch. Secrets are redacted before either Slack or the
 * queue file sees the body.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { WebClient } from '@slack/web-api'
import {
  analyzeConsultLength,
  buildConsultFrontmatter,
  CONSULT_QUEUE_DIR,
  consultRequestFilename,
  isConsultRequest,
} from './lib/consult-queue'
import { type Frontmatter, serializeFrontmatter } from './lib/frontmatter'

const DEFAULT_SLACK_STATE_DIR = join(homedir(), '.claude/channels/slack')
const MAX_SLACK_BODY_CHARS = 2400

const TOKEN_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'xoxb', pattern: /\bxoxb-[A-Za-z0-9-]{20,}/ },
  { name: 'xapp', pattern: /\bxapp-[A-Za-z0-9-]{20,}/ },
  { name: 'sk', pattern: /\bsk-[A-Za-z0-9_-]{20,}/i },
  { name: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i },
  { name: 'ghp', pattern: /\bghp_[A-Za-z0-9]{20,}/ },
  { name: 'ghs', pattern: /\bghs_[A-Za-z0-9]{20,}/ },
]

export interface TerminalConsultConfig {
  hikaruUserId: string
  hikaruDmChannel: string
  pollIntervalMs?: number
}

export interface TerminalConsultBuildArgs {
  requestId: string
  createdAt: Date
  config: TerminalConsultConfig
  slackTs: string
  bodyClean: string
  riskGuess: 'ambiguous' | null
}

export function sanitizeTerminalText(body: string): { body: string; redactedNames: string[] } {
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

export function parseTerminalInput(args: string[], stdinText: string): string {
  const argText = args.join(' ').trim()
  const stdinClean = stdinText.trim()
  if (argText.length > 0) return argText
  return stdinClean
}

export function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

export function generateTerminalRequestId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 12)
  const rand = Math.random()
    .toString(36)
    .slice(2, 10)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '0')
  return `term-${stamp}-${rand.padEnd(8, '0')}`
}

export function truncateSlackBody(
  body: string,
  maxChars = MAX_SLACK_BODY_CHARS,
): { body: string; truncated: boolean } {
  if (body.length <= maxChars) return { body, truncated: false }
  return { body: `${body.slice(0, maxChars - 20)}\n...[truncated]`, truncated: true }
}

export function buildTerminalSlackText(args: {
  requestId: string
  bodyClean: string
  redactedNames: string[]
}): string {
  const trunc = truncateSlackBody(args.bodyClean)
  const lines = [
    `[terminal-consult] queued request_id=${args.requestId}`,
    '',
    trunc.body,
    '',
    'Codex consult queue に登録済み。計画返信を待つ。',
  ]
  if (trunc.truncated) {
    lines.push('terminal body は Slack 表示用に短縮済み。queue には sanitize 後の本文を保存。')
  }
  if (args.redactedNames.length > 0) {
    lines.push(`token-like text redacted: ${args.redactedNames.join(', ')}`)
  }
  return lines.join('\n')
}

export function buildTerminalConsultContent(args: TerminalConsultBuildArgs): string {
  const fm: Frontmatter = {
    ...buildConsultFrontmatter({
      requestId: args.requestId,
      createdAt: args.createdAt,
      sourceChannel: args.config.hikaruDmChannel,
      sender: 'hikaru',
      slackMessageId: args.slackTs,
      slackThreadTs: args.slackTs,
      riskGuess: args.riskGuess,
    }),
    raw_prefix: 'terminal-consult',
  }
  return `---\n${serializeFrontmatter(fm)}\n---\n${args.bodyClean.trim()}\n\n## continuation log\n`
}

export function loadWatcherConfig(stateDir: string): TerminalConsultConfig {
  const path = join(stateDir, 'inbound-watcher.config.json')
  const raw = readFileSync(path, 'utf8')
  const parsed = JSON.parse(raw) as Partial<TerminalConsultConfig>
  if (!parsed.hikaruUserId || !parsed.hikaruDmChannel) {
    throw new Error(`invalid watcher config: ${path}`)
  }
  return {
    hikaruUserId: parsed.hikaruUserId,
    hikaruDmChannel: parsed.hikaruDmChannel,
    pollIntervalMs: parsed.pollIntervalMs,
  }
}

export function loadSlackBotToken(stateDir: string): string {
  const envPath = join(stateDir, '.env')
  const env = parseDotEnv(readFileSync(envPath, 'utf8'))
  const token = env.SLACK_BOT_TOKEN
  if (!token || token === 'xoxb-disabled') throw new Error(`SLACK_BOT_TOKEN missing in ${envPath}`)
  return token
}

function writeConsultFile(args: {
  createdAt: Date
  requestId: string
  bodyClean: string
  config: TerminalConsultConfig
  slackTs: string
  riskGuess: 'ambiguous' | null
}): string {
  mkdirSync(CONSULT_QUEUE_DIR, { recursive: true })
  const filename = consultRequestFilename(args.createdAt, args.requestId)
  const path = join(CONSULT_QUEUE_DIR, filename)
  if (existsSync(path)) throw new Error(`queue file already exists: ${path}`)
  const tmp = `${path}.tmp-${process.pid}`
  const content = buildTerminalConsultContent({
    requestId: args.requestId,
    createdAt: args.createdAt,
    config: args.config,
    slackTs: args.slackTs,
    bodyClean: args.bodyClean,
    riskGuess: args.riskGuess,
  })
  writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
  return path
}

async function readStdinIfPiped(): Promise<string> {
  if (process.stdin.isTTY) return ''
  return await new Response(Bun.stdin.stream()).text()
}

function printUsage(): void {
  console.log(
    `Usage:\n  bun scripts/terminal-consult.ts "相談したい内容"\n  echo "相談したい内容" | bun scripts/terminal-consult.ts\n\nWrites a Slack DM root message and a codex-consult-queue request. Does not execute work.`,
  )
}

export async function runTerminalConsultCli(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage()
    return 0
  }

  const rawInput = parseTerminalInput(argv, await readStdinIfPiped())
  if (rawInput.length === 0) {
    console.error('[terminal-consult] empty input')
    return 2
  }
  if (!isConsultRequest(rawInput)) {
    console.error('[terminal-consult] reserved command-like input; use Slack prefix route directly')
    return 2
  }

  const lengthKind = analyzeConsultLength(rawInput)
  if (lengthKind === 'ignore') {
    console.error('[terminal-consult] input too short for consult queue')
    return 2
  }

  const stateDir = process.env.SLACK_STATE_DIR || DEFAULT_SLACK_STATE_DIR
  const createdAt = new Date()
  const requestId = generateTerminalRequestId(createdAt)
  const { body: bodyClean, redactedNames } = sanitizeTerminalText(rawInput)
  const config = loadWatcherConfig(stateDir)
  const token = loadSlackBotToken(stateDir)

  const slack = new WebClient(token)
  const slackText = buildTerminalSlackText({ requestId, bodyClean, redactedNames })
  const posted = await slack.chat.postMessage({
    channel: config.hikaruDmChannel,
    text: slackText,
    unfurl_links: false,
    unfurl_media: false,
  })
  const slackTs = posted.ts
  if (!slackTs) throw new Error('Slack post succeeded without ts')

  const path = writeConsultFile({
    createdAt,
    requestId,
    bodyClean,
    config,
    slackTs,
    riskGuess: lengthKind === 'ambiguous' ? 'ambiguous' : null,
  })

  console.log(`[terminal-consult] queued request_id=${requestId}`)
  console.log(`[terminal-consult] slack_thread_ts=${slackTs}`)
  console.log(`[terminal-consult] queue_file=${path}`)
  if (redactedNames.length > 0)
    console.log(`[terminal-consult] redacted=${redactedNames.join(',')}`)
  return 0
}

if (import.meta.main) {
  runTerminalConsultCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(
        `[terminal-consult] failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      process.exit(1)
    },
  )
}
