import { describe, expect, it } from 'bun:test'
import { parseFrontmatterFile } from './lib/frontmatter'
import {
  buildTerminalConsultContent,
  buildTerminalSlackText,
  generateTerminalRequestId,
  parseDotEnv,
  parseTerminalInput,
  sanitizeTerminalText,
  type TerminalConsultConfig,
  truncateSlackBody,
} from './terminal-consult'

describe('terminal-consult helpers', () => {
  it('parses args before piped stdin', () => {
    expect(parseTerminalInput(['眼鏡から', '相談'], 'stdin body')).toBe('眼鏡から 相談')
    expect(parseTerminalInput([], ' stdin body\n')).toBe('stdin body')
  })

  it('parses simple .env files without exposing comments', () => {
    expect(parseDotEnv('A=1\n# x\nB="two words"\nC=has=equals\n')).toEqual({
      A: '1',
      B: 'two words',
      C: 'has=equals',
    })
  })

  it('redacts token-like text', () => {
    const r = sanitizeTerminalText(
      'please check xoxb-AAAAAAAAAAAAAAAAAAAAAA and Bearer abcdefghijklmnop',
    )
    expect(r.body).toContain('[REDACTED:xoxb]')
    expect(r.body).toContain('[REDACTED:bearer]')
    expect(r.redactedNames).toEqual(['xoxb', 'bearer'])
  })

  it('generates filesystem-safe request ids', () => {
    const id = generateTerminalRequestId(new Date('2026-05-12T01:02:03.000Z'))
    expect(id).toMatch(/^term-202605120102-[A-Z0-9]{8}$/)
  })

  it('truncates only the Slack presentation body', () => {
    const short = truncateSlackBody('abc', 10)
    expect(short).toEqual({ body: 'abc', truncated: false })
    const long = truncateSlackBody('abcdefghijklmnopqrstuvwxyz', 20)
    expect(long.truncated).toBe(true)
    expect(long.body).toContain('[truncated]')
  })

  it('builds Slack text with queue ack and redaction marker', () => {
    const text = buildTerminalSlackText({
      requestId: 'term-202605120102-ABCDEFGH',
      bodyClean: '新しいサイト作りたい',
      redactedNames: ['sk'],
    })
    expect(text).toContain('[terminal-consult] queued request_id=term-202605120102-ABCDEFGH')
    expect(text).toContain('Codex consult queue に登録済み')
    expect(text).toContain('token-like text redacted: sk')
  })

  it('builds a consult queue file compatible with existing frontmatter parser', () => {
    const config: TerminalConsultConfig = {
      hikaruUserId: 'U_TEST',
      hikaruDmChannel: 'D_TEST',
      pollIntervalMs: 5000,
    }
    const content = buildTerminalConsultContent({
      requestId: 'term-202605120102-ABCDEFGH',
      createdAt: new Date('2026-05-12T01:02:03.000Z'),
      config,
      slackTs: '1770000000.123456',
      bodyClean: 'G2から相談したい',
      riskGuess: null,
    })
    const parsed = parseFrontmatterFile(content)
    expect(parsed?.fm.type).toBe('consult-request')
    expect(parsed?.fm.request_id).toBe('term-202605120102-ABCDEFGH')
    expect(parsed?.fm.source_channel).toBe('D_TEST')
    expect(parsed?.fm.source_channel_type).toBe('dm')
    expect(parsed?.fm.sender).toBe('hikaru')
    expect(parsed?.fm.raw_prefix).toBe('terminal-consult')
    expect(parsed?.fm.status).toBe('pending')
    expect(parsed?.body).toContain('G2から相談したい')
  })
})
