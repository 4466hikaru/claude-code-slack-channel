import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildProjectRequestAck,
  buildProjectRequestFrontmatter,
  clampPollInterval,
  classifyChannelType,
  computeQueueKey,
  countActiveEntries,
  detectNonEmergencyOpsPrefix,
  detectProjectAbortPrefix,
  detectToken,
  detectTrigger,
  encodeRandomBase32,
  encodeTimeBase32,
  entryKey,
  escapeYamlString,
  extractNewProjectBody,
  findEntryByKey,
  findProjectRequestByMessageId,
  formatChannelAbortChannelReply,
  formatChannelAbortDmReply,
  formatChannelWarnReply,
  generateUlid,
  isAllowedSender,
  listProjectRequestEntries,
  listQueueEntries,
  NEW_PROJECT_BODY_MAX_BYTES,
  NON_EMERGENCY_OPS_PREFIXES,
  parseCodexReview,
  parseFrontmatterFile,
  projectRequestFilename,
  queueFilenameFor,
  routeInboundMessage,
  routeTrigger,
  sanitizeTokens,
  serializeFrontmatter,
  stripSlackLinkWrap,
  TRIGGERS,
  truncateBodyUtf8,
  UNKNOWN_SOURCE_CHANNEL_ACK_SUFFIX,
  unescapeYamlString,
} from './inbound-watcher'

// --- detectTrigger -----------------------------------------------------

describe('detectTrigger', () => {
  test('exact prefix match for each trigger', () => {
    expect(detectTrigger('[abort-test]')).toBe('[abort-test]')
    expect(detectTrigger('[abort]')).toBe('[abort]')
    expect(detectTrigger('[abort cleanup]')).toBe('[abort cleanup]')
    expect(detectTrigger('[codex-review] pr=https://x/1')).toBe('[codex-review]')
    expect(detectTrigger('status?')).toBe('status?')
    expect(detectTrigger('prs?')).toBe('prs?')
  })

  test('prefix followed by trailing content still matches', () => {
    expect(detectTrigger('[abort-test] now please')).toBe('[abort-test]')
    expect(detectTrigger('status? please')).toBe('status?')
    expect(detectTrigger('prs? open ones')).toBe('prs?')
  })

  test('leading whitespace is allowed', () => {
    expect(detectTrigger('  [abort-test]')).toBe('[abort-test]')
    expect(detectTrigger('\n\nstatus?')).toBe('status?')
    expect(detectTrigger('\t[abort cleanup]')).toBe('[abort cleanup]')
  })

  test('order: [abort cleanup] beats [abort] (longer prefix wins)', () => {
    expect(detectTrigger('[abort cleanup]')).toBe('[abort cleanup]')
    expect(detectTrigger('[abort cleanup] foo')).toBe('[abort cleanup]')
  })

  test('non-trigger or mid-string occurrences return null', () => {
    expect(detectTrigger('hello')).toBeNull()
    expect(detectTrigger('the [abort-test] in the middle')).toBeNull()
    expect(detectTrigger('')).toBeNull()
    expect(detectTrigger('   ')).toBeNull()
  })

  test('case-insensitive prefix match (PR #8 ops convention)', () => {
    expect(detectTrigger('[ABORT-TEST]')).toBe('[abort-test]')
    expect(detectTrigger('[Abort-Test]')).toBe('[abort-test]')
    expect(detectTrigger('[ABORT]')).toBe('[abort]')
    expect(detectTrigger('[ABORT CLEANUP]')).toBe('[abort cleanup]')
    expect(detectTrigger('[Abort Cleanup]')).toBe('[abort cleanup]')
    expect(detectTrigger('[CODEX-REVIEW] pr=https://x/1')).toBe('[codex-review]')
    expect(detectTrigger('[Codex-Review] pr=https://x/1')).toBe('[codex-review]')
    expect(detectTrigger('STATUS?')).toBe('status?')
    expect(detectTrigger('Status?')).toBe('status?')
    expect(detectTrigger('PRS?')).toBe('prs?')
    expect(detectTrigger('Prs?')).toBe('prs?')
  })

  test('case-insensitive combined with leading whitespace', () => {
    expect(detectTrigger('  [ABORT-TEST]')).toBe('[abort-test]')
    expect(detectTrigger('\n\nSTATUS? please')).toBe('status?')
    expect(detectTrigger('  [CODEX-REVIEW] pr=https://x/1')).toBe('[codex-review]')
  })

  test('[codex-review] does not collide with [abort] family', () => {
    // Pin the regression: adding [codex-review] to TRIGGERS must not
    // alter the [abort*] resolutions.
    expect(detectTrigger('[abort]')).toBe('[abort]')
    expect(detectTrigger('[abort cleanup]')).toBe('[abort cleanup]')
    expect(detectTrigger('[abort-test]')).toBe('[abort-test]')
  })
})

// --- TRIGGERS / routeTrigger ------------------------------------------

describe('TRIGGERS array order', () => {
  test('[abort cleanup] precedes [abort] (longer prefix wins)', () => {
    const i = TRIGGERS.indexOf('[abort cleanup]')
    const j = TRIGGERS.indexOf('[abort]')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(j).toBeGreaterThanOrEqual(0)
    expect(i).toBeLessThan(j)
  })

  test('[codex-review] is in TRIGGERS', () => {
    expect(TRIGGERS.indexOf('[codex-review]')).toBeGreaterThanOrEqual(0)
  })
})

describe('routeTrigger', () => {
  // Codex review against PR #2 v1: [abort] was aliased to [abort cleanup]
  // and ran rm -f on the flag. These tests pin the corrected semantics
  // and the new [codex-review] route.
  test('[abort] -> abort-create (touches/raises the flag, NOT cleanup)', () => {
    expect(routeTrigger('[abort]')).toBe('abort-create')
    expect(routeTrigger('[abort]')).not.toBe('abort-cleanup')
  })

  test('[abort cleanup] -> abort-cleanup (rm -f the flag, NOT create)', () => {
    expect(routeTrigger('[abort cleanup]')).toBe('abort-cleanup')
    expect(routeTrigger('[abort cleanup]')).not.toBe('abort-create')
  })

  test('[abort-test] -> abort-test', () => {
    expect(routeTrigger('[abort-test]')).toBe('abort-test')
  })

  test('[codex-review] -> codex-review-queue', () => {
    expect(routeTrigger('[codex-review]')).toBe('codex-review-queue')
  })

  test('status? -> status', () => {
    expect(routeTrigger('status?')).toBe('status')
  })

  test('prs? -> prs', () => {
    expect(routeTrigger('prs?')).toBe('prs')
  })
})

// --- clampPollInterval ------------------------------------------------

describe('clampPollInterval', () => {
  test('default for undefined', () => {
    expect(clampPollInterval(undefined)).toBe(5000)
  })

  test('default for non-finite values', () => {
    expect(clampPollInterval(Number.NaN)).toBe(5000)
    expect(clampPollInterval(Number.POSITIVE_INFINITY)).toBe(5000)
    expect(clampPollInterval(Number.NEGATIVE_INFINITY)).toBe(5000)
  })

  test('values below min (3000) fall back to default', () => {
    expect(clampPollInterval(0)).toBe(5000)
    expect(clampPollInterval(100)).toBe(5000)
    expect(clampPollInterval(2999)).toBe(5000)
  })

  test('values above max (60000) fall back to default', () => {
    expect(clampPollInterval(60001)).toBe(5000)
    expect(clampPollInterval(999999)).toBe(5000)
  })

  test('values inside [3000, 60000] pass through unchanged', () => {
    expect(clampPollInterval(3000)).toBe(3000)
    expect(clampPollInterval(5000)).toBe(5000)
    expect(clampPollInterval(60000)).toBe(60000)
  })
})

// --- detectToken ------------------------------------------------------

describe('detectToken', () => {
  test('positive: xoxb', () => {
    expect(detectToken('xoxb-1234567890abcdef1234567890')).toBe('xoxb')
    expect(detectToken('summary contains xoxb-ABCDEF1234567890ABCDEF')).toBe('xoxb')
  })

  test('positive: xapp', () => {
    expect(detectToken('xapp-1-A0123456789012-3456789012345-abcdef')).toBe('xapp')
  })

  test('positive: Bearer (case-insensitive)', () => {
    expect(detectToken('Bearer abcdefghij1234567890')).toBe('bearer')
    expect(detectToken('bearer abcdefghij1234567890')).toBe('bearer')
    expect(detectToken('Authorization: Bearer XYZabc1234567890XYZ')).toBe('bearer')
  })

  test('positive: sk-', () => {
    expect(detectToken('sk-1234567890abcdef1234567890')).toBe('sk')
    expect(detectToken('summary: sk-abcdef1234567890ABCDEF')).toBe('sk')
  })

  test('positive: ghp / ghs', () => {
    expect(detectToken('ghp_1234567890abcdef1234567890')).toBe('ghp')
    expect(detectToken('ghs_1234567890abcdef1234567890')).toBe('ghs')
  })

  test('negative: harmless text', () => {
    expect(detectToken('hello world')).toBeNull()
    expect(detectToken('summary=this is fine')).toBeNull()
    expect(detectToken('Bearer in mind...')).toBeNull() // short trailing
    expect(detectToken('asks the user')).toBeNull() // contains "sk" but not pattern
    expect(detectToken('please review pr')).toBeNull()
    expect(detectToken('xoxb-short')).toBeNull() // too short
  })
})

// --- parseCodexReview -------------------------------------------------

describe('parseCodexReview', () => {
  test('Form A: pr=<url>', () => {
    const r = parseCodexReview(
      '[codex-review] pr=https://github.com/4466hikaru/birth-kaitori/pull/12 summary=test fix',
    )
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect(r.form).toBe('pr-url')
    expect(r.repo).toBe('4466hikaru/birth-kaitori')
    if (r.form !== 'pr-url') return
    expect(r.pr_number).toBe(12)
    expect(r.summary).toBe('test fix')
  })

  test('Form B: issue=<url>', () => {
    const r = parseCodexReview(
      '[codex-review] issue=https://github.com/4466hikaru/birth-kaitori/issues/9 summary=cleanup task',
    )
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect(r.form).toBe('issue-url')
    expect(r.repo).toBe('4466hikaru/birth-kaitori')
    if (r.form !== 'issue-url') return
    expect(r.issue_url).toBe('https://github.com/4466hikaru/birth-kaitori/issues/9')
    expect(r.issue_number).toBe(9)
    expect(r.summary).toBe('cleanup task')
  })

  test('Form C: repo=<owner/repo> pr=<number>', () => {
    const r = parseCodexReview(
      '[codex-review] repo=4466hikaru/claude-code-slack-channel pr=2 summary=watcher merge',
    )
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect(r.form).toBe('repo-pr')
    expect(r.repo).toBe('4466hikaru/claude-code-slack-channel')
    if (r.form !== 'repo-pr') return
    expect(r.pr_number).toBe(2)
    expect(r.summary).toBe('watcher merge')
  })

  test('case-insensitive prefix and keys', () => {
    const r = parseCodexReview('[CODEX-REVIEW] PR=https://github.com/x/y/pull/1 SUMMARY=hello')
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect(r.form).toBe('pr-url')
    expect(r.summary).toBe('hello')
  })

  test('summary is taken to end of line, may contain spaces and punctuation', () => {
    const r = parseCodexReview(
      '[codex-review] pr=https://github.com/x/y/pull/1 summary=Codex review: prefer rebase, NOT merge.',
    )
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect(r.summary).toBe('Codex review: prefer rebase, NOT merge.')
  })

  test('error: missing summary=', () => {
    const r = parseCodexReview('[codex-review] pr=https://github.com/x/y/pull/1')
    expect('error' in r).toBe(true)
  })

  test('error: empty summary value', () => {
    const r = parseCodexReview('[codex-review] pr=https://github.com/x/y/pull/1 summary=')
    expect('error' in r).toBe(true)
  })

  test('error: pr + issue exclusive violation', () => {
    const r = parseCodexReview(
      '[codex-review] pr=https://github.com/x/y/pull/1 issue=https://github.com/x/y/issues/1 summary=ambiguous',
    )
    expect('error' in r).toBe(true)
  })

  test('error: issue + repo exclusive violation', () => {
    const r = parseCodexReview(
      '[codex-review] issue=https://github.com/x/y/issues/1 repo=x/y summary=ambiguous',
    )
    expect('error' in r).toBe(true)
  })

  test('error: pr non-URL without repo', () => {
    const r = parseCodexReview('[codex-review] pr=12 summary=missing repo')
    expect('error' in r).toBe(true)
  })

  test('error: invalid pr URL', () => {
    const r = parseCodexReview('[codex-review] pr=https://example.com/foo summary=wrong host')
    expect('error' in r).toBe(true)
  })

  test('error: invalid issue URL (PR url passed as issue)', () => {
    const r = parseCodexReview(
      '[codex-review] issue=https://github.com/x/y/pull/1 summary=wrong type',
    )
    expect('error' in r).toBe(true)
  })

  test('error: repo without pr', () => {
    const r = parseCodexReview('[codex-review] repo=x/y summary=missing pr')
    expect('error' in r).toBe(true)
  })

  test('error: invalid repo format', () => {
    const r = parseCodexReview('[codex-review] repo=just-a-name pr=1 summary=bad repo')
    expect('error' in r).toBe(true)
  })

  test('error: repo with non-numeric pr', () => {
    const r = parseCodexReview(
      '[codex-review] repo=x/y pr=https://github.com/x/y/pull/1 summary=bad pr value',
    )
    expect('error' in r).toBe(true)
  })

  test('error: unknown key', () => {
    const r = parseCodexReview(
      '[codex-review] pr=https://github.com/x/y/pull/1 foo=bar summary=unknown',
    )
    expect('error' in r).toBe(true)
  })

  test('error: missing prefix or no space after', () => {
    expect('error' in parseCodexReview('[codex-review]pr=...')).toBe(true)
    expect('error' in parseCodexReview('[abort] not codex-review')).toBe(true)
    expect('error' in parseCodexReview('plain text')).toBe(true)
  })

  test('mid-string [codex-review] is rejected (only first-token prefix)', () => {
    expect(
      'error' in
        parseCodexReview('see this: [codex-review] pr=https://github.com/x/y/pull/1 summary=mid'),
    ).toBe(true)
  })

  test('GitHub URL with trailing query / fragment is allowed', () => {
    const r = parseCodexReview(
      '[codex-review] pr=https://github.com/x/y/pull/1?ref=abc summary=with query',
    )
    expect('error' in r).toBe(false)
    if ('error' in r) return
    if (r.form !== 'pr-url') return
    expect(r.pr_number).toBe(1)
  })
})

// --- computeQueueKey / queueFilenameFor -------------------------------

describe('computeQueueKey', () => {
  test('pr-url and repo-pr forms produce same key shape', () => {
    expect(
      computeQueueKey({
        form: 'pr-url',
        repo: 'x/y',
        pr_number: 12,
        summary: '',
      }),
    ).toBe('x/y#pr-12')
    expect(
      computeQueueKey({
        form: 'repo-pr',
        repo: 'x/y',
        pr_number: 12,
        summary: '',
      }),
    ).toBe('x/y#pr-12')
  })

  test('issue-url form produces issue key shape', () => {
    expect(
      computeQueueKey({
        form: 'issue-url',
        repo: 'x/y',
        issue_url: 'https://github.com/x/y/issues/9',
        issue_number: 9,
        summary: '',
      }),
    ).toBe('x/y#issue-9')
  })
})

describe('queueFilenameFor', () => {
  test('no Windows-illegal characters and stable shape', () => {
    const fn = queueFilenameFor(new Date('2026-05-10T01:23:45.123Z'), {
      form: 'pr-url',
      repo: '4466hikaru/birth-kaitori',
      pr_number: 12,
      summary: 'x',
    })
    expect(fn).not.toMatch(/[:*?<>|"]/)
    expect(fn.startsWith('2026-05-10T01-23-45-123Z-')).toBe(true)
    expect(fn.endsWith('4466hikaru_birth-kaitori-pr12.md')).toBe(true)
  })

  test('issue-url form embeds issue number in filename', () => {
    const fn = queueFilenameFor(new Date('2026-05-10T00:00:00.000Z'), {
      form: 'issue-url',
      repo: 'x/y',
      issue_url: 'https://github.com/x/y/issues/9',
      issue_number: 9,
      summary: '',
    })
    expect(fn.endsWith('x_y-issue9.md')).toBe(true)
  })
})

// --- frontmatter round-trip -------------------------------------------

describe('serializeFrontmatter / parseFrontmatterFile', () => {
  test('round-trip preserves strings, numbers, null', () => {
    const fm = {
      created_at: '2026-05-10T01:23:45.123Z',
      pr_number: 12,
      summary: 'line with "quote" and \\ backslash and newline',
      missing: null,
      status: 'pending',
    }
    const ser = serializeFrontmatter(fm)
    const content = `---\n${ser}\n---\nbody text`
    const parsed = parseFrontmatterFile(content)
    expect(parsed).not.toBeNull()
    expect(parsed?.fm).toEqual(fm)
    expect(parsed?.body).toBe('body text')
  })

  test('parser returns null for non-frontmatter content', () => {
    expect(parseFrontmatterFile('plain text, no markers')).toBeNull()
    expect(parseFrontmatterFile('---\nincomplete')).toBeNull()
  })
})

// --- queue file ops (temp dir) ----------------------------------------

describe('queue file ops', () => {
  test('listQueueEntries / countActiveEntries / findEntryByKey', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-queue-test-'))
    try {
      writeFileSync(
        join(dir, 'a.md'),
        '---\nrepo: "x/y"\npr_number: 1\nstatus: "pending"\n---\nbody-a',
      )
      writeFileSync(
        join(dir, 'b.md'),
        '---\nrepo: "x/y"\npr_number: 2\nstatus: "blocked"\n---\nbody-b',
      )
      writeFileSync(
        join(dir, 'c.md'),
        '---\nrepo: "x/y"\npr_number: 3\nstatus: "reviewed"\n---\nbody-c',
      )
      writeFileSync(
        join(dir, 'd.md'),
        '---\nrepo: "x/y"\nissue_url: "https://github.com/x/y/issues/9"\nstatus: "pending"\n---\nbody-d',
      )
      // non-frontmatter file should be skipped silently
      writeFileSync(join(dir, 'junk.md'), 'no frontmatter here')

      const entries = listQueueEntries(dir)
      expect(entries.length).toBe(4)
      // pending + blocked = 3 (= a + b + d), reviewed (c) excluded
      expect(countActiveEntries(entries)).toBe(3)

      // findEntryByKey
      expect(findEntryByKey(dir, 'x/y#pr-1')?.fm.pr_number).toBe(1)
      expect(findEntryByKey(dir, 'x/y#pr-2')?.fm.pr_number).toBe(2)
      expect(findEntryByKey(dir, 'x/y#issue-9')?.fm.repo).toBe('x/y')
      expect(findEntryByKey(dir, 'x/y#pr-99')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('listQueueEntries on non-existent dir returns empty', () => {
    expect(listQueueEntries(join(tmpdir(), `does-not-exist-${Date.now()}`))).toEqual([])
  })
})

// --- entryKey ---------------------------------------------------------

describe('entryKey', () => {
  test('pr key from pr_number', () => {
    expect(entryKey({ repo: 'x/y', pr_number: 5 })).toBe('x/y#pr-5')
  })

  test('issue key from issue_url', () => {
    expect(entryKey({ repo: 'x/y', issue_url: 'https://github.com/x/y/issues/9' })).toBe(
      'x/y#issue-9',
    )
  })

  test('null when key cannot be computed', () => {
    expect(entryKey({})).toBeNull()
    expect(entryKey({ repo: 'x/y' })).toBeNull()
    expect(entryKey({ pr_number: 1 })).toBeNull()
  })
})

// --- escapeYamlString / unescapeYamlString round-trip ----------------

describe('escapeYamlString / unescapeYamlString', () => {
  // Codex review against PR #3 v1: the prior multi-replace
  // unescape pipeline corrupted strings with literal `\n` (backslash
  // + n, two source chars) by treating them as escapes after the
  // leading backslash had been doubled. These tests pin the corrected
  // single-pass unescape contract.
  test('round-trip preserves literal `\\n` (backslash + n, NOT newline)', () => {
    const s = 'foo\\nbar'
    expect(s.length).toBe(8) // f o o \ n b a r
    expect(unescapeYamlString(escapeYamlString(s))).toBe(s)
  })

  test('round-trip preserves an actual newline', () => {
    const s = 'foo\nbar'
    expect(s.length).toBe(7) // f o o NL b a r
    expect(unescapeYamlString(escapeYamlString(s))).toBe(s)
  })

  test('round-trip preserves two consecutive literal backslashes', () => {
    const s = 'a\\\\b'
    expect(s.length).toBe(4) // a \ \ b
    expect(unescapeYamlString(escapeYamlString(s))).toBe(s)
  })

  test('round-trip preserves literal CR', () => {
    const s = 'a\rb'
    expect(unescapeYamlString(escapeYamlString(s))).toBe(s)
  })

  test('round-trip preserves embedded double quotes', () => {
    const s = 'a "quoted" b'
    expect(unescapeYamlString(escapeYamlString(s))).toBe(s)
  })

  test('round-trip preserves a mixed payload (literal \\n + actual NL + " + \\)', () => {
    const s = 'line1\\n\nline2 with "quote" and \\ backslash and \r tail'
    expect(unescapeYamlString(escapeYamlString(s))).toBe(s)
  })

  test('unescape passes unknown escapes through verbatim (no silent drop)', () => {
    expect(unescapeYamlString('foo\\xbar')).toBe('foo\\xbar')
  })
})

describe('serializeFrontmatter / parseFrontmatterFile', () => {
  test('summary with literal `\\n` (2 source chars) survives round-trip', () => {
    const fm = { summary: 'foo\\nbar', status: 'pending' }
    const ser = serializeFrontmatter(fm)
    const parsed = parseFrontmatterFile(`---\n${ser}\n---\n`)
    expect(parsed?.fm.summary).toBe('foo\\nbar')
  })

  test('summary with actual newline survives round-trip', () => {
    const fm = { summary: 'line1\nline2', status: 'pending' }
    const ser = serializeFrontmatter(fm)
    const parsed = parseFrontmatterFile(`---\n${ser}\n---\n`)
    expect(parsed?.fm.summary).toBe('line1\nline2')
  })

  test('summary with mixed escape chars survives round-trip', () => {
    const fm: Record<string, string> = {
      summary: 'a\\nb\nc"d\\\\e\rf',
      status: 'pending',
    }
    const ser = serializeFrontmatter(fm)
    const parsed = parseFrontmatterFile(`---\n${ser}\n---\n`)
    expect(parsed?.fm.summary).toBe(fm.summary)
  })
})

// --- isAllowedSender (per-trigger gate) ------------------------------

describe('isAllowedSender', () => {
  // Codex review against PR #3 v1: the global poll filter `msg.user
  // !== hikaruUserId` blocked non-Hikaru senders for ALL triggers,
  // including [codex-review]. This pins the per-trigger gate: only
  // [codex-review] consults the codexReviewAllowlist; every other
  // trigger stays Hikaru-only.
  const HIKARU = 'U_HIKARU'
  const BOT = 'U_BOT'
  const OTHER = 'U_OTHER'
  const allowlistWithBot = [HIKARU, BOT]

  test('Hikaru can use every trigger', () => {
    for (const t of TRIGGERS) {
      expect(isAllowedSender(HIKARU, t, HIKARU, allowlistWithBot)).toBe(true)
    }
  })

  test('allowlisted (non-Hikaru) sender can use [codex-review]', () => {
    expect(isAllowedSender(BOT, '[codex-review]', HIKARU, allowlistWithBot)).toBe(true)
  })

  test('allowlisted (non-Hikaru) sender CANNOT use the 5 Hikaru-only triggers', () => {
    expect(isAllowedSender(BOT, '[abort]', HIKARU, allowlistWithBot)).toBe(false)
    expect(isAllowedSender(BOT, '[abort cleanup]', HIKARU, allowlistWithBot)).toBe(false)
    expect(isAllowedSender(BOT, '[abort-test]', HIKARU, allowlistWithBot)).toBe(false)
    expect(isAllowedSender(BOT, 'status?', HIKARU, allowlistWithBot)).toBe(false)
    expect(isAllowedSender(BOT, 'prs?', HIKARU, allowlistWithBot)).toBe(false)
  })

  test('non-allowlisted sender is denied for every trigger', () => {
    for (const t of TRIGGERS) {
      expect(isAllowedSender(OTHER, t, HIKARU, allowlistWithBot)).toBe(false)
    }
  })

  test('undefined / empty user is denied (gate closed by default)', () => {
    expect(isAllowedSender(undefined, '[codex-review]', HIKARU, allowlistWithBot)).toBe(false)
    expect(isAllowedSender(undefined, '[abort]', HIKARU, allowlistWithBot)).toBe(false)
    expect(isAllowedSender('', '[codex-review]', HIKARU, allowlistWithBot)).toBe(false)
  })

  test('default allowlist [hikaruUserId] keeps [codex-review] Hikaru-only', () => {
    // When the operator does not configure codexReviewSenderUserIds,
    // the watcher resolves the list to [hikaruUserId]. This pins the
    // resulting per-trigger behavior == old global gate.
    const onlyHikaru = [HIKARU]
    expect(isAllowedSender(HIKARU, '[codex-review]', HIKARU, onlyHikaru)).toBe(true)
    expect(isAllowedSender(BOT, '[codex-review]', HIKARU, onlyHikaru)).toBe(false)
    expect(isAllowedSender(OTHER, '[codex-review]', HIKARU, onlyHikaru)).toBe(false)
  })
})

// --- parseCodexReview role= ------------------------------------------

describe('parseCodexReview role=', () => {
  test('valid roles parse and lowercase canonicalize', () => {
    for (const role of ['hikaru', 'consultant', 'executor', 'agent']) {
      const r = parseCodexReview(
        `[codex-review] pr=https://github.com/x/y/pull/1 role=${role} summary=test`,
      )
      expect('error' in r).toBe(false)
      if ('error' in r) continue
      expect(r.role).toBe(role)
    }
  })

  test('case-insensitive role value', () => {
    const r = parseCodexReview(
      '[codex-review] pr=https://github.com/x/y/pull/1 role=CONSULTANT summary=test',
    )
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect(r.role).toBe('consultant')
  })

  test('invalid role -> error', () => {
    const r = parseCodexReview(
      '[codex-review] pr=https://github.com/x/y/pull/1 role=admin summary=test',
    )
    expect('error' in r).toBe(true)
  })

  test('omitted role -> undefined in parsed (handler will derive default)', () => {
    const r = parseCodexReview('[codex-review] pr=https://github.com/x/y/pull/1 summary=test')
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect(r.role).toBeUndefined()
  })

  test('role= works in all 3 forms', () => {
    const a = parseCodexReview(
      '[codex-review] pr=https://github.com/x/y/pull/1 role=executor summary=A',
    )
    const b = parseCodexReview(
      '[codex-review] issue=https://github.com/x/y/issues/1 role=consultant summary=B',
    )
    const c = parseCodexReview('[codex-review] repo=x/y pr=2 role=agent summary=C')
    expect('error' in a).toBe(false)
    expect('error' in b).toBe(false)
    expect('error' in c).toBe(false)
    if (!('error' in a)) expect(a.role).toBe('executor')
    if (!('error' in b)) expect(b.role).toBe('consultant')
    if (!('error' in c)) expect(c.role).toBe('agent')
  })
})

// --- stripSlackLinkWrap (Slack mrkdwn URL auto-link bug fix) ---------

describe('stripSlackLinkWrap', () => {
  // Codex review post-merge runtime check on PR #3: Slack stores any
  // URL in a message body as `<url>` (or `<url|display text>`) when
  // fetched via conversations.history. Without this strip, every
  // pr=<github-url> message Slack delivers would fail the URL regex
  // and reply with format error. Pin both the unwrap behavior and the
  // pass-through behavior for non-URL values.
  test('unwraps <url>', () => {
    expect(stripSlackLinkWrap('<https://github.com/x/y/pull/1>')).toBe(
      'https://github.com/x/y/pull/1',
    )
    expect(stripSlackLinkWrap('<http://example.com/path?q=1>')).toBe('http://example.com/path?q=1')
  })

  test('unwraps <url|display> by taking the URL part', () => {
    expect(stripSlackLinkWrap('<https://github.com/x/y/pull/1|PR #1>')).toBe(
      'https://github.com/x/y/pull/1',
    )
    expect(stripSlackLinkWrap('<https://example.com|click here>')).toBe('https://example.com')
  })

  test('passes plain URLs through unchanged (backward compat)', () => {
    expect(stripSlackLinkWrap('https://github.com/x/y/pull/1')).toBe(
      'https://github.com/x/y/pull/1',
    )
  })

  test('passes non-URL values through unchanged (Form C protections)', () => {
    expect(stripSlackLinkWrap('4466hikaru/claude-code-slack-channel')).toBe(
      '4466hikaru/claude-code-slack-channel',
    )
    expect(stripSlackLinkWrap('5')).toBe('5')
    expect(stripSlackLinkWrap('<not-a-url>')).toBe('<not-a-url>')
    expect(stripSlackLinkWrap('<>')).toBe('<>')
    expect(stripSlackLinkWrap('')).toBe('')
  })

  test('does not unwrap partial brackets', () => {
    expect(stripSlackLinkWrap('<https://x.example/')).toBe('<https://x.example/')
    expect(stripSlackLinkWrap('https://x.example/>')).toBe('https://x.example/>')
  })
})

// --- new bare-word triggers (bd ccsc-81q approved dispatch) ---------

describe('detectTrigger including bare-word triggers', () => {
  // Codex review against PR #5 (= bd ccsc-81q): adding bare-word
  // triggers `ok` / `approve` / `cancel` requires word-boundary
  // checks so "okay" / "approver" do not accidentally fire. These
  // tests pin the boundary contract.
  test('ok / approve / cancel match as standalone words', () => {
    expect(detectTrigger('ok')).toBe('ok')
    expect(detectTrigger('OK')).toBe('ok')
    expect(detectTrigger('Ok')).toBe('ok')
    expect(detectTrigger('approve d1')).toBe('approve')
    expect(detectTrigger('Approve abc')).toBe('approve')
    expect(detectTrigger('cancel d1')).toBe('cancel')
    expect(detectTrigger('CANCEL d1')).toBe('cancel')
    expect(detectTrigger('pending?')).toBe('pending?')
  })

  test('word-boundary protects against false positives', () => {
    expect(detectTrigger('okay maybe')).toBeNull()
    expect(detectTrigger('okie dokie')).toBeNull()
    expect(detectTrigger('approver agent')).toBeNull()
    expect(detectTrigger('cancelling now')).toBeNull()
  })

  test('non-letter terminators accepted (whitespace, EOL, punctuation)', () => {
    expect(detectTrigger('ok ')).toBe('ok')
    expect(detectTrigger('ok\n')).toBe('ok')
    expect(detectTrigger('ok!')).toBe('ok')
    expect(detectTrigger('ok.')).toBe('ok')
    expect(detectTrigger('ok,')).toBe('ok')
  })

  test('existing bracketed and `?`-suffixed triggers unchanged by boundary fix', () => {
    expect(detectTrigger('[abort]extra')).toBe('[abort]')
    expect(detectTrigger('status?extra')).toBe('status?')
    expect(detectTrigger('prs?extra')).toBe('prs?')
  })
})

describe('TRIGGERS includes new bare-word triggers', () => {
  test('ok / approve / cancel / pending? are in TRIGGERS', () => {
    expect(TRIGGERS.indexOf('ok')).toBeGreaterThanOrEqual(0)
    expect(TRIGGERS.indexOf('approve')).toBeGreaterThanOrEqual(0)
    expect(TRIGGERS.indexOf('cancel')).toBeGreaterThanOrEqual(0)
    expect(TRIGGERS.indexOf('pending?')).toBeGreaterThanOrEqual(0)
  })
})

describe('routeTrigger covers approved-dispatch verbs', () => {
  test('ok -> dispatch-ok', () => {
    expect(routeTrigger('ok')).toBe('dispatch-ok')
  })
  test('approve -> dispatch-approve', () => {
    expect(routeTrigger('approve')).toBe('dispatch-approve')
  })
  test('cancel -> dispatch-cancel', () => {
    expect(routeTrigger('cancel')).toBe('dispatch-cancel')
  })
  test('pending? -> dispatch-pending', () => {
    expect(routeTrigger('pending?')).toBe('dispatch-pending')
  })
})

describe('isAllowedSender for approved-dispatch verbs', () => {
  // bd ccsc-81q: bare OK / approve / cancel / pending? must be
  // Hikaru-only (= NOT bot-allowlisted). Only [codex-review] is on
  // the codexReviewAllowlist path.
  const HIKARU = 'U_HIKARU'
  const BOT = 'U_BOT'
  const allowlistWithBot = [HIKARU, BOT]

  test('Hikaru can use the dispatch verbs', () => {
    expect(isAllowedSender(HIKARU, 'ok', HIKARU, allowlistWithBot)).toBe(true)
    expect(isAllowedSender(HIKARU, 'approve', HIKARU, allowlistWithBot)).toBe(true)
    expect(isAllowedSender(HIKARU, 'cancel', HIKARU, allowlistWithBot)).toBe(true)
    expect(isAllowedSender(HIKARU, 'pending?', HIKARU, allowlistWithBot)).toBe(true)
  })

  test('Bot/agent on codex-review allowlist CANNOT use dispatch verbs', () => {
    expect(isAllowedSender(BOT, 'ok', HIKARU, allowlistWithBot)).toBe(false)
    expect(isAllowedSender(BOT, 'approve', HIKARU, allowlistWithBot)).toBe(false)
    expect(isAllowedSender(BOT, 'cancel', HIKARU, allowlistWithBot)).toBe(false)
    expect(isAllowedSender(BOT, 'pending?', HIKARU, allowlistWithBot)).toBe(false)
    // [codex-review] still allowed for bot — pinning that the gates
    // remain orthogonal.
    expect(isAllowedSender(BOT, '[codex-review]', HIKARU, allowlistWithBot)).toBe(true)
  })
})

describe('parseCodexReview through Slack mrkdwn URL wrap', () => {
  test('Form A: pr=<https://...> (Slack auto-link wrapped) parses', () => {
    const r = parseCodexReview(
      '[codex-review] pr=<https://github.com/4466hikaru/birth-kaitori/pull/12> summary=via slack wrap',
    )
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect(r.form).toBe('pr-url')
    expect(r.repo).toBe('4466hikaru/birth-kaitori')
    if (r.form !== 'pr-url') return
    expect(r.pr_number).toBe(12)
  })

  test('Form A: pr=<url|display> (mrkdwn with display text) parses', () => {
    const r = parseCodexReview(
      '[codex-review] pr=<https://github.com/x/y/pull/1|PR #1> summary=display label',
    )
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect(r.form).toBe('pr-url')
    expect(r.repo).toBe('x/y')
    if (r.form !== 'pr-url') return
    expect(r.pr_number).toBe(1)
  })

  test('Form B: issue=<https://...> (wrapped) parses', () => {
    const r = parseCodexReview(
      '[codex-review] issue=<https://github.com/4466hikaru/birth-kaitori/issues/9> summary=cleanup',
    )
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect(r.form).toBe('issue-url')
    expect(r.repo).toBe('4466hikaru/birth-kaitori')
    if (r.form !== 'issue-url') return
    expect(r.issue_number).toBe(9)
    // The stored issue_url is the unwrapped form so downstream
    // entryKey() and audit consumers see a canonical URL.
    expect(r.issue_url).toBe('https://github.com/4466hikaru/birth-kaitori/issues/9')
  })

  test('Form A: plain pr=<no-wrap> URL still parses (regression for human typists)', () => {
    const r = parseCodexReview('[codex-review] pr=https://github.com/x/y/pull/1 summary=plain')
    expect('error' in r).toBe(false)
    if ('error' in r) return
    if (r.form !== 'pr-url') return
    expect(r.pr_number).toBe(1)
  })

  test('Form C: repo=x/y pr=5 (numeric, not URL) ignores wrap logic', () => {
    const r = parseCodexReview('[codex-review] repo=x/y pr=5 summary=numeric pr unaffected')
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect(r.form).toBe('repo-pr')
    if (r.form !== 'repo-pr') return
    expect(r.pr_number).toBe(5)
  })
})

// --- bd ccsc-54g: /new-project + [新規] prefix --------------------

describe('detectTrigger: /new-project + [新規]', () => {
  test('exact prefix matches', () => {
    expect(detectTrigger('/new-project some idea')).toBe('/new-project')
    expect(detectTrigger('[新規] some idea')).toBe('[新規]')
  })

  test('case-insensitive on /new-project (ascii); [新規] is exact', () => {
    expect(detectTrigger('/NEW-PROJECT idea')).toBe('/new-project')
    expect(detectTrigger('/New-Project idea')).toBe('/new-project')
    expect(detectTrigger('[新規]idea')).toBe('[新規]')
  })

  test('no separator after prefix (body starts immediately)', () => {
    expect(detectTrigger('/new-projectゲーム作りたい')).toBe('/new-project')
    expect(detectTrigger('[新規]ゲーム作りたい')).toBe('[新規]')
  })

  test('leading whitespace allowed', () => {
    expect(detectTrigger('  /new-project idea')).toBe('/new-project')
    expect(detectTrigger('\n[新規] idea')).toBe('[新規]')
  })

  test('body-mention does NOT trigger (start-of-message only)', () => {
    expect(detectTrigger('please use /new-project next time')).toBeNull()
    expect(detectTrigger('参考: [新規] みたいに送って')).toBeNull()
  })

  test('full-width alias [ＮＥＷ] does NOT match (only [新規] alias allowed)', () => {
    expect(detectTrigger('[ＮＥＷ] idea')).toBeNull()
    expect(detectTrigger('[NEW] idea')).toBeNull()
  })

  test('does not collide with existing prefixes', () => {
    // pin: adding /new-project + [新規] must not alter existing resolutions
    expect(detectTrigger('[abort]')).toBe('[abort]')
    expect(detectTrigger('[abort cleanup]')).toBe('[abort cleanup]')
    expect(detectTrigger('[abort-test]')).toBe('[abort-test]')
    expect(detectTrigger('[codex-review] pr=https://x/1')).toBe('[codex-review]')
    expect(detectTrigger('status?')).toBe('status?')
    expect(detectTrigger('prs?')).toBe('prs?')
    expect(detectTrigger('pending?')).toBe('pending?')
    expect(detectTrigger('OK')).toBe('ok')
    expect(detectTrigger('approve x')).toBe('approve')
    expect(detectTrigger('cancel x')).toBe('cancel')
  })
})

describe('TRIGGERS / routeTrigger: /new-project + [新規]', () => {
  test('TRIGGERS includes both forms', () => {
    expect(TRIGGERS).toContain('/new-project')
    expect(TRIGGERS).toContain('[新規]')
  })

  test('routeTrigger routes both forms to new-project-queue', () => {
    expect(routeTrigger('/new-project')).toBe('new-project-queue')
    expect(routeTrigger('[新規]')).toBe('new-project-queue')
  })

  test('existing routes unchanged (regression pin)', () => {
    expect(routeTrigger('[abort]')).toBe('abort-create')
    expect(routeTrigger('[abort cleanup]')).toBe('abort-cleanup')
    expect(routeTrigger('[abort-test]')).toBe('abort-test')
    expect(routeTrigger('[codex-review]')).toBe('codex-review-queue')
    expect(routeTrigger('ok')).toBe('dispatch-ok')
    expect(routeTrigger('approve')).toBe('dispatch-approve')
    expect(routeTrigger('cancel')).toBe('dispatch-cancel')
    expect(routeTrigger('pending?')).toBe('dispatch-pending')
    expect(routeTrigger('status?')).toBe('status')
    expect(routeTrigger('prs?')).toBe('prs')
  })
})

describe('extractNewProjectBody', () => {
  test('strips /new-project + single space separator, preserves body case', () => {
    expect(extractNewProjectBody('/new-project My Game', '/new-project')).toBe('My Game')
    expect(extractNewProjectBody('/NEW-PROJECT My Game', '/new-project')).toBe('My Game')
  })

  test('strips [新規] + single space separator', () => {
    expect(extractNewProjectBody('[新規] ゲーム作る', '[新規]')).toBe('ゲーム作る')
  })

  test('no separator → body starts immediately', () => {
    expect(extractNewProjectBody('/new-projectゲーム作る', '/new-project')).toBe('ゲーム作る')
    expect(extractNewProjectBody('[新規]ゲーム作る', '[新規]')).toBe('ゲーム作る')
  })

  test('only one leading space dropped; subsequent kept', () => {
    expect(extractNewProjectBody('/new-project  two-spaces', '/new-project')).toBe(' two-spaces')
  })

  test('leading newline/tab in body preserved (= they are content, not separator)', () => {
    expect(extractNewProjectBody('/new-project\nmultiline', '/new-project')).toBe('\nmultiline')
    expect(extractNewProjectBody('/new-project\tindented', '/new-project')).toBe('\tindented')
  })

  test('empty body when message is just the prefix', () => {
    expect(extractNewProjectBody('/new-project', '/new-project')).toBe('')
    expect(extractNewProjectBody('[新規]', '[新規]')).toBe('')
    expect(extractNewProjectBody('/new-project ', '/new-project')).toBe('')
  })

  test('leading whitespace before prefix is stripped (matches detectTrigger)', () => {
    expect(extractNewProjectBody('  /new-project foo', '/new-project')).toBe('foo')
  })
})

describe('truncateBodyUtf8', () => {
  test('under limit: no truncation, identical body', () => {
    const r = truncateBodyUtf8('hello', 100)
    expect(r.truncated).toBe(false)
    expect(r.body).toBe('hello')
  })

  test('at limit: no truncation', () => {
    const s = 'a'.repeat(10)
    const r = truncateBodyUtf8(s, 10)
    expect(r.truncated).toBe(false)
    expect(r.body).toBe(s)
  })

  test('ascii over limit: cuts to maxBytes exactly', () => {
    const s = 'a'.repeat(20)
    const r = truncateBodyUtf8(s, 10)
    expect(r.truncated).toBe(true)
    expect(Buffer.byteLength(r.body, 'utf-8')).toBe(10)
  })

  test('multibyte over limit: cuts on valid UTF-8 boundary (no � tail)', () => {
    // 'あ' = 3 bytes in UTF-8. 20 chars = 60 bytes.
    const s = 'あ'.repeat(20)
    const r = truncateBodyUtf8(s, 10)
    expect(r.truncated).toBe(true)
    // result must be valid UTF-8 = multiple of 3 bytes only (no partial char)
    expect(Buffer.byteLength(r.body, 'utf-8') % 3).toBe(0)
    expect(Buffer.byteLength(r.body, 'utf-8')).toBeLessThanOrEqual(10)
    // and the body must round-trip cleanly without replacement char
    expect(r.body.includes('�')).toBe(false)
  })

  test('NEW_PROJECT_BODY_MAX_BYTES is the documented 8 KB cap', () => {
    expect(NEW_PROJECT_BODY_MAX_BYTES).toBe(8192)
  })
})

describe('sanitizeTokens', () => {
  test('no token: body unchanged, no names', () => {
    const r = sanitizeTokens('plain text with no secrets')
    expect(r.body).toBe('plain text with no secrets')
    expect(r.redactedNames).toEqual([])
  })

  test('single bearer: replaced with [REDACTED:bearer]', () => {
    const r = sanitizeTokens('header: Bearer abcdefghij1234567890')
    expect(r.body).toContain('[REDACTED:bearer]')
    expect(r.body).not.toContain('abcdefghij')
    expect(r.redactedNames).toEqual(['bearer'])
  })

  test('multiple distinct patterns: all redacted, names listed once each', () => {
    const r = sanitizeTokens('xoxb-ABCDEFGHIJ1234567890 and sk-ABCDEFGHIJKLMNOPQRSTUVWX')
    expect(r.body).toContain('[REDACTED:xoxb]')
    expect(r.body).toContain('[REDACTED:sk]')
    expect(r.redactedNames).toEqual(['xoxb', 'sk'])
  })

  test('multiple occurrences of same pattern: all replaced, name listed once', () => {
    const r = sanitizeTokens('one xoxb-AAAAAAAAAAAAAAAAAAAA and two xoxb-BBBBBBBBBBBBBBBBBBBB')
    expect((r.body.match(/\[REDACTED:xoxb\]/g) ?? []).length).toBe(2)
    expect(r.redactedNames).toEqual(['xoxb'])
  })
})

describe('encodeTimeBase32 / encodeRandomBase32 / generateUlid', () => {
  test('encodeTimeBase32: deterministic, length-correct', () => {
    expect(encodeTimeBase32(0, 10)).toBe('0000000000')
    expect(encodeTimeBase32(31, 10).endsWith('Z')).toBe(true)
    expect(encodeTimeBase32(32, 10).endsWith('10')).toBe(true)
  })

  test('encodeRandomBase32: deterministic given bytes', () => {
    const bytes = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
    expect(encodeRandomBase32(bytes, 16)).toBe('ZZZZZZZZZZZZZZZZ')
    const zeros = new Uint8Array(10)
    expect(encodeRandomBase32(zeros, 16)).toBe('0000000000000000')
  })

  test('generateUlid: 26 chars, Crockford alphabet only', () => {
    const id = generateUlid(0, new Uint8Array(10))
    expect(id).toBe('00000000000000000000000000')
    expect(id.length).toBe(26)
    const rand = generateUlid()
    expect(rand.length).toBe(26)
    expect(/^[0-9A-HJKMNP-TV-Z]+$/.test(rand)).toBe(true)
  })

  test('generateUlid: time prefix monotonic for monotonic clock', () => {
    const a = generateUlid(1_000_000, new Uint8Array(10))
    const b = generateUlid(1_000_001, new Uint8Array(10))
    expect(a.slice(0, 10) <= b.slice(0, 10)).toBe(true)
  })
})

describe('projectRequestFilename', () => {
  test('format: <UTC yyyy-mm-ddThhmm>-<id>.md', () => {
    const d = new Date(Date.UTC(2026, 4, 11, 9, 45, 0)) // 2026-05-11T09:45Z
    const name = projectRequestFilename(d, '01HXY01TESTID0000000000000')
    expect(name).toBe('2026-05-11T0945-01HXY01TESTID0000000000000.md')
  })
})

describe('listProjectRequestEntries + findProjectRequestByMessageId', () => {
  test('filters by type=project-request, ignores other types', () => {
    const dir = mkdtempSync(join(tmpdir(), 'project-requests-test-'))
    try {
      writeFileSync(
        join(dir, '2026-05-11T0945-A.md'),
        '---\ntype: "project-request"\nrequest_id: "A"\nstatus: "drafting"\nslack_message_id: "111.1"\n---\nbody A',
      )
      writeFileSync(
        join(dir, '2026-05-11T0946-B.md'),
        '---\ntype: "project-request"\nrequest_id: "B"\nstatus: "drafting"\nslack_message_id: "222.2"\n---\nbody B',
      )
      // wrong type → filtered out
      writeFileSync(
        join(dir, '2026-05-11T0947-C.md'),
        '---\ntype: "done"\ndone_id: "C"\nstatus: "complete"\n---\nbody C',
      )
      // missing frontmatter → skipped
      writeFileSync(join(dir, 'junk.md'), 'no frontmatter')
      // non-md → skipped
      writeFileSync(join(dir, 'note.txt'), 'irrelevant')

      const entries = listProjectRequestEntries(dir)
      expect(entries.map((e) => e.fm.request_id).sort()).toEqual(['A', 'B'])

      expect(findProjectRequestByMessageId(dir, '111.1')?.fm.request_id).toBe('A')
      expect(findProjectRequestByMessageId(dir, '222.2')?.fm.request_id).toBe('B')
      expect(findProjectRequestByMessageId(dir, '999.9')).toBeNull()
      // empty messageId → null (= short-circuit)
      expect(findProjectRequestByMessageId(dir, '')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('empty / missing dir returns []', () => {
    expect(listProjectRequestEntries(join(tmpdir(), `no-dir-${Date.now()}`))).toEqual([])
  })
})

// --- bd ccsc-l34: project channel model Phase 1 -----------------

describe('classifyChannelType', () => {
  test('D-prefixed chat_id → dm', () => {
    expect(classifyChannelType('D0B2GN71MNE')).toBe('dm')
    expect(classifyChannelType('DABC')).toBe('dm')
  })

  test('C-prefixed chat_id → project-channel', () => {
    expect(classifyChannelType('C1234567890')).toBe('project-channel')
    expect(classifyChannelType('CABC')).toBe('project-channel')
  })

  test('G-prefixed / empty / other → unknown', () => {
    expect(classifyChannelType('G123')).toBe('unknown')
    expect(classifyChannelType('')).toBe('unknown')
    expect(classifyChannelType('X999')).toBe('unknown')
    // non-string defensive: TS suppression to verify runtime guard
    expect(classifyChannelType(undefined as unknown as string)).toBe('unknown')
  })
})

describe('NON_EMERGENCY_OPS_PREFIXES + detectNonEmergencyOpsPrefix', () => {
  test('all 13 listed prefixes match at start (case-insensitive ascii)', () => {
    for (const p of NON_EMERGENCY_OPS_PREFIXES) {
      expect(detectNonEmergencyOpsPrefix(`${p} suffix`)).toBe(p)
    }
  })

  test('case-insensitive on ascii prefixes', () => {
    expect(detectNonEmergencyOpsPrefix('STATUS? today')).toBe('status?')
    expect(detectNonEmergencyOpsPrefix('[ABORT-TEST]')).toBe('[abort-test]')
    expect(detectNonEmergencyOpsPrefix('[Tech] q')).toBe('[tech]')
  })

  test('Japanese alias [整理] (toLowerCase is identity on kanji)', () => {
    expect(detectNonEmergencyOpsPrefix('[整理] memo')).toBe('[整理]')
  })

  test('leading whitespace is trimmed', () => {
    expect(detectNonEmergencyOpsPrefix('  status? ?')).toBe('status?')
    expect(detectNonEmergencyOpsPrefix('\n\n[tech] q')).toBe('[tech]')
  })

  test('emergency `[abort]` is NOT in the non-emergency set', () => {
    expect(detectNonEmergencyOpsPrefix('[abort]')).toBeNull()
    // sanity: `[abort cleanup]` (= ops, returns) vs `[abort]` (= emergency, null)
    expect(detectNonEmergencyOpsPrefix('[abort cleanup]')).toBe('[abort cleanup]')
  })

  test('non-prefix / body-mention returns null', () => {
    expect(detectNonEmergencyOpsPrefix('hello status?')).toBeNull()
    expect(detectNonEmergencyOpsPrefix('about [tech] later')).toBeNull()
    expect(detectNonEmergencyOpsPrefix('')).toBeNull()
  })
})

describe('detectProjectAbortPrefix', () => {
  test('exact `[abort]` → true (case-insensitive, leading WS OK)', () => {
    expect(detectProjectAbortPrefix('[abort]')).toBe(true)
    expect(detectProjectAbortPrefix('[ABORT]')).toBe(true)
    expect(detectProjectAbortPrefix('[Abort]')).toBe(true)
    expect(detectProjectAbortPrefix('  [abort]')).toBe(true)
    expect(detectProjectAbortPrefix('[abort] now')).toBe(true)
  })

  test('`[abort cleanup]` / `[abort-test]` → false (NOT emergency)', () => {
    expect(detectProjectAbortPrefix('[abort cleanup]')).toBe(false)
    expect(detectProjectAbortPrefix('[abort-test]')).toBe(false)
    expect(detectProjectAbortPrefix('[ABORT CLEANUP]')).toBe(false)
  })

  test('non-prefix / body-mention → false', () => {
    expect(detectProjectAbortPrefix('hello [abort]')).toBe(false)
    expect(detectProjectAbortPrefix('')).toBe(false)
    expect(detectProjectAbortPrefix('please abort')).toBe(false)
  })
})

describe('routeInboundMessage', () => {
  test('DM chat_id → dm-passthrough (existing dispatch path)', () => {
    expect(routeInboundMessage('status?', 'D0B2GN71MNE')).toEqual({ kind: 'dm-passthrough' })
    expect(routeInboundMessage('[abort]', 'D0B2GN71MNE')).toEqual({ kind: 'dm-passthrough' })
    expect(routeInboundMessage('hello', 'D0B2GN71MNE')).toEqual({ kind: 'dm-passthrough' })
    expect(routeInboundMessage('/new-project foo', 'D0B2GN71MNE')).toEqual({
      kind: 'dm-passthrough',
    })
  })

  test('project channel + `[abort]` → channel-abort (emergency dual-notify)', () => {
    expect(routeInboundMessage('[abort]', 'C1234567890')).toEqual({ kind: 'channel-abort' })
    expect(routeInboundMessage('[ABORT]', 'C1234567890')).toEqual({ kind: 'channel-abort' })
    expect(routeInboundMessage('  [Abort]', 'C1234567890')).toEqual({ kind: 'channel-abort' })
  })

  test('project channel + non-emergency ops → channel-warn (DM redirect)', () => {
    expect(routeInboundMessage('status?', 'C1234567890')).toEqual({
      kind: 'channel-warn',
      prefix: 'status?',
    })
    expect(routeInboundMessage('[abort-test]', 'C1234567890')).toEqual({
      kind: 'channel-warn',
      prefix: '[abort-test]',
    })
    expect(routeInboundMessage('[abort cleanup]', 'C1234567890')).toEqual({
      kind: 'channel-warn',
      prefix: '[abort cleanup]',
    })
    expect(routeInboundMessage('[tech] q', 'C1234567890')).toEqual({
      kind: 'channel-warn',
      prefix: '[tech]',
    })
    expect(routeInboundMessage('[整理] memo', 'C1234567890')).toEqual({
      kind: 'channel-warn',
      prefix: '[整理]',
    })
  })

  test('project channel + approve/cancel/-impl/ok → channel-passthrough', () => {
    expect(routeInboundMessage('approve 01HXY', 'C1234567890')).toEqual({
      kind: 'channel-passthrough',
      verb: 'approve',
    })
    expect(routeInboundMessage('cancel 01HXY', 'C1234567890')).toEqual({
      kind: 'channel-passthrough',
      verb: 'cancel',
    })
    expect(routeInboundMessage('approve-impl 01HXY', 'C1234567890')).toEqual({
      kind: 'channel-passthrough',
      verb: 'approve-impl',
    })
    expect(routeInboundMessage('cancel-impl 01HXY', 'C1234567890')).toEqual({
      kind: 'channel-passthrough',
      verb: 'cancel-impl',
    })
    expect(routeInboundMessage('OK', 'C1234567890')).toEqual({
      kind: 'channel-passthrough',
      verb: 'ok',
    })
  })

  test('passthrough word-boundary: `approver` is NOT approve', () => {
    expect(routeInboundMessage('approver wanted', 'C1234567890')).toEqual({ kind: 'channel-noop' })
    expect(routeInboundMessage('okay then', 'C1234567890')).toEqual({ kind: 'channel-noop' })
  })

  test('project channel + unrecognized text → channel-noop (silent)', () => {
    expect(routeInboundMessage('hello world', 'C1234567890')).toEqual({ kind: 'channel-noop' })
    expect(routeInboundMessage('', 'C1234567890')).toEqual({ kind: 'channel-noop' })
  })

  test('G-prefixed / unknown chat_id → unknown-channel-noop (silent + log at dispatch)', () => {
    expect(routeInboundMessage('[abort]', 'G123')).toEqual({ kind: 'unknown-channel-noop' })
    expect(routeInboundMessage('status?', 'X999')).toEqual({ kind: 'unknown-channel-noop' })
    expect(routeInboundMessage('hello', '')).toEqual({ kind: 'unknown-channel-noop' })
  })
})

describe('formatChannelAbortChannelReply / formatChannelAbortDmReply / formatChannelWarnReply', () => {
  test('channel reply states `global abort active` + path + recovery hint', () => {
    const reply = formatChannelAbortChannelReply('/tmp/abort')
    expect(reply).toContain('global abort active')
    expect(reply).toContain('/tmp/abort 作成済')
    expect(reply).toContain('[abort cleanup]')
  })

  test('DM reply renders source channel as <#...> mrkdwn link + source ts', () => {
    const reply = formatChannelAbortDmReply('C12345', '1700.123')
    expect(reply).toContain('<#C12345>')
    expect(reply).toContain('global abort active')
    expect(reply).toContain('source ts: 1700.123')
  })

  test('warn reply names the prefix + DM redirect text', () => {
    expect(formatChannelWarnReply('status?')).toBe(
      '`status?` は DM で打ってください、channel では受領しません',
    )
    expect(formatChannelWarnReply('[tech]')).toContain('[tech]')
  })
})

describe('buildProjectRequestFrontmatter', () => {
  const baseArgs = {
    requestId: '01HXY01TESTID0000000000000',
    createdAt: new Date(Date.UTC(2026, 4, 12, 9, 45, 0)),
    messageId: '1700.456',
    threadTs: '1700.456',
    rawPrefix: '/new-project' as const,
  }

  test('DM chat_id → source_channel_type=dm, all Phase 1 channel fields null/default', () => {
    const fm = buildProjectRequestFrontmatter({ ...baseArgs, chatId: 'D0B2GN71MNE' })
    // Phase 1 ccsc-54g fields preserved
    expect(fm.type).toBe('project-request')
    expect(fm.request_id).toBe(baseArgs.requestId)
    expect(fm.slack_chat_id).toBe('D0B2GN71MNE')
    expect(fm.raw_prefix).toBe('/new-project')
    expect(fm.project_name).toBeNull()
    expect(fm.project_type).toBeNull()
    expect(fm.target_visibility).toBe('private')
    expect(fm.out_of_scope_inherits).toBe('true')
    // Phase 1 ccsc-l34 channel-model fields
    expect(fm.project_channel_id).toBeNull()
    expect(fm.project_channel_name).toBeNull()
    expect(fm.source_channel_id).toBe('D0B2GN71MNE')
    expect(fm.source_channel_type).toBe('dm')
    expect(fm.template_source).toBe('blank')
    expect(fm.reference_repo).toBeNull()
    expect(fm.target_repo_name).toBeNull()
  })

  test('C... chat_id → source_channel_type=project-channel', () => {
    const fm = buildProjectRequestFrontmatter({ ...baseArgs, chatId: 'C1234567890' })
    expect(fm.source_channel_id).toBe('C1234567890')
    expect(fm.source_channel_type).toBe('project-channel')
    // project_channel_id remains null (Phase 1 default, Phase 2 fills it)
    expect(fm.project_channel_id).toBeNull()
  })

  test('G... chat_id → source_channel_type=unknown', () => {
    const fm = buildProjectRequestFrontmatter({ ...baseArgs, chatId: 'G999' })
    expect(fm.source_channel_id).toBe('G999')
    expect(fm.source_channel_type).toBe('unknown')
  })

  test('round-trip: serialize → parseFrontmatterFile preserves all 21 fields', () => {
    const fm = buildProjectRequestFrontmatter({ ...baseArgs, chatId: 'C1234567890' })
    const text = `---\n${serializeFrontmatter(fm)}\n---\nbody`
    const parsed = parseFrontmatterFile(text)
    expect(parsed).not.toBeNull()
    if (!parsed) return
    for (const k of Object.keys(fm)) {
      expect(parsed.fm[k]).toEqual(fm[k])
    }
  })
})

describe('buildProjectRequestAck', () => {
  const base = {
    requestId: '01HXY01ACKID00000000000000',
    truncated: false,
    redactedNames: [] as string[],
    channelType: 'dm' as const,
  }

  test('minimal ack: id / status / next step only', () => {
    const ack = buildProjectRequestAck(base)
    expect(ack).toContain('📋 project request 起票済')
    expect(ack).toContain('id: 01HXY01ACKID00000000000000')
    expect(ack).toContain('status: drafting')
    expect(ack).toContain('Codex の brief 起草を待つ')
    expect(ack).not.toContain('truncate')
    expect(ack).not.toContain('sanitize')
    expect(ack).not.toContain('source channel 不明')
  })

  test('truncated flag adds line', () => {
    const ack = buildProjectRequestAck({ ...base, truncated: true })
    expect(ack).toContain(`${NEW_PROJECT_BODY_MAX_BYTES} byte 超`)
  })

  test('redacted names flag adds line with name list', () => {
    const ack = buildProjectRequestAck({ ...base, redactedNames: ['bearer', 'xoxb'] })
    expect(ack).toContain('token-like 検出 (bearer,xoxb)')
  })

  test('unknown channel type adds source-channel warning', () => {
    const ack = buildProjectRequestAck({ ...base, channelType: 'unknown' })
    expect(ack).toContain(UNKNOWN_SOURCE_CHANNEL_ACK_SUFFIX.trim())
  })

  test('project-channel type does NOT add unknown warning', () => {
    const ack = buildProjectRequestAck({ ...base, channelType: 'project-channel' })
    expect(ack).not.toContain('source channel 不明')
  })
})
