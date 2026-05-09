import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clampPollInterval,
  computeQueueKey,
  countActiveEntries,
  detectToken,
  detectTrigger,
  entryKey,
  findEntryByKey,
  listQueueEntries,
  parseCodexReview,
  parseFrontmatterFile,
  queueFilenameFor,
  routeTrigger,
  serializeFrontmatter,
  TRIGGERS,
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
