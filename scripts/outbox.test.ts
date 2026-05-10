import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  APPROVE_GRACE_MS,
  DEFAULT_TTL_MS,
  extractDraftIdArg,
  filterApproved,
  filterPending,
  findDuplicateDraftIds,
  findEntriesByDraftId,
  findEntryByDraftId,
  interpretOutboxEntry,
  isWithinGrace,
  isWithinTtl,
  listOutboxEntries,
  type OutboxEntry,
  parseTtl,
  resolveBareOk,
  shouldDispatch,
  summaryLine,
  transitionEntry,
} from './outbox'

// --- parseTtl ---------------------------------------------------------

describe('parseTtl', () => {
  test('valid units', () => {
    expect(parseTtl('500ms')).toBe(500)
    expect(parseTtl('5s')).toBe(5000)
    expect(parseTtl('30m')).toBe(30 * 60_000)
    expect(parseTtl('1h')).toBe(3_600_000)
  })

  test('case-insensitive units and trim', () => {
    expect(parseTtl('30M')).toBe(30 * 60_000)
    expect(parseTtl('  10s  ')).toBe(10_000)
  })

  test('malformed -> null', () => {
    expect(parseTtl(undefined)).toBeNull()
    expect(parseTtl(null)).toBeNull()
    expect(parseTtl('')).toBeNull()
    expect(parseTtl('30')).toBeNull() // no unit
    expect(parseTtl('thirty m')).toBeNull()
    expect(parseTtl('-1m')).toBeNull()
  })
})

// --- interpretOutboxEntry --------------------------------------------

function makeEntry(over: Partial<OutboxEntry> = {}): OutboxEntry {
  const created = '2026-05-10T01:00:00.000Z'
  return {
    path: '/tmp/x.md',
    draft_id: 'd1',
    status: 'pending',
    created_at: created,
    ttl_ms: 30 * 60_000,
    slack_chat_id: 'D1',
    slack_thread_ts: '1.1',
    body: 'sample body',
    raw: {
      draft_id: 'd1',
      status: 'pending',
      created_at: created,
      ttl: '30m',
      slack_chat_id: 'D1',
      slack_thread_ts: '1.1',
    },
    ...over,
  }
}

describe('interpretOutboxEntry', () => {
  test('parses a valid frontmatter', () => {
    const e = interpretOutboxEntry(
      '/tmp/x.md',
      {
        draft_id: 'd1',
        status: 'pending',
        created_at: '2026-05-10T01:00:00.000Z',
        ttl: '30m',
        slack_chat_id: 'D1',
        slack_thread_ts: '1.1',
        target_role: 'consultant',
      },
      'body text',
    )
    expect(e).not.toBeNull()
    if (!e) return
    expect(e.draft_id).toBe('d1')
    expect(e.status).toBe('pending')
    expect(e.ttl_ms).toBe(30 * 60_000)
    expect(e.slack_chat_id).toBe('D1')
    expect(e.slack_thread_ts).toBe('1.1')
    expect(e.target_role).toBe('consultant')
    expect(e.body).toBe('body text')
  })

  test('returns null on missing draft_id', () => {
    expect(
      interpretOutboxEntry('/tmp/x.md', { status: 'pending', created_at: 'x', ttl: '30m' }, ''),
    ).toBeNull()
  })

  test('returns null on unknown status (= malformed)', () => {
    expect(
      interpretOutboxEntry(
        '/tmp/x.md',
        {
          draft_id: 'd1',
          status: 'in-progress',
          created_at: 'x',
          ttl: '30m',
        },
        '',
      ),
    ).toBeNull()
  })

  test('returns null on missing created_at', () => {
    expect(
      interpretOutboxEntry('/tmp/x.md', { draft_id: 'd1', status: 'pending', ttl: '30m' }, ''),
    ).toBeNull()
  })

  test('falls back to default TTL on malformed ttl', () => {
    const e = interpretOutboxEntry(
      '/tmp/x.md',
      {
        draft_id: 'd1',
        status: 'pending',
        created_at: '2026-05-10T01:00:00.000Z',
        ttl: 'forever',
      },
      '',
    )
    expect(e?.ttl_ms).toBe(DEFAULT_TTL_MS)
  })

  test('falls back to default TTL when ttl missing', () => {
    const e = interpretOutboxEntry(
      '/tmp/x.md',
      {
        draft_id: 'd1',
        status: 'pending',
        created_at: '2026-05-10T01:00:00.000Z',
      },
      '',
    )
    expect(e?.ttl_ms).toBe(DEFAULT_TTL_MS)
  })
})

// --- filters / isWithinTtl / isWithinGrace ---------------------------

describe('filterPending / filterApproved', () => {
  test('partition by status', () => {
    const a = makeEntry({ draft_id: 'a', status: 'pending' })
    const b = makeEntry({ draft_id: 'b', status: 'approved' })
    const c = makeEntry({ draft_id: 'c', status: 'sent' })
    const d = makeEntry({ draft_id: 'd', status: 'pending' })
    const all = [a, b, c, d]
    expect(filterPending(all).map((e) => e.draft_id)).toEqual(['a', 'd'])
    expect(filterApproved(all).map((e) => e.draft_id)).toEqual(['b'])
  })
})

describe('isWithinTtl', () => {
  const created = '2026-05-10T01:00:00.000Z'
  const ttlMs = 30 * 60_000
  const entry = makeEntry({ created_at: created, ttl_ms: ttlMs })

  test('within TTL', () => {
    expect(isWithinTtl(entry, Date.parse(created) + 1000)).toBe(true)
    expect(isWithinTtl(entry, Date.parse(created) + ttlMs)).toBe(true) // boundary
  })

  test('past TTL', () => {
    expect(isWithinTtl(entry, Date.parse(created) + ttlMs + 1)).toBe(false)
  })

  test('non-finite created_at -> false', () => {
    expect(isWithinTtl(makeEntry({ created_at: 'not-a-date' }), Date.now())).toBe(false)
  })
})

describe('isWithinGrace', () => {
  const approvedAt = '2026-05-10T01:00:00.000Z'
  const t = Date.parse(approvedAt)

  test('only approved status counts', () => {
    expect(isWithinGrace(makeEntry({ status: 'pending', approved_at: approvedAt }), t + 1000)).toBe(
      false,
    )
  })

  test('within grace', () => {
    expect(
      isWithinGrace(
        makeEntry({ status: 'approved', approved_at: approvedAt }),
        t + APPROVE_GRACE_MS - 1,
      ),
    ).toBe(true)
  })

  test('past grace', () => {
    expect(
      isWithinGrace(
        makeEntry({ status: 'approved', approved_at: approvedAt }),
        t + APPROVE_GRACE_MS,
      ),
    ).toBe(false)
  })

  test('missing approved_at -> false', () => {
    expect(isWithinGrace(makeEntry({ status: 'approved' }), Date.now())).toBe(false)
  })
})

// --- shouldDispatch --------------------------------------------------

describe('shouldDispatch', () => {
  const approvedAt = '2026-05-10T01:00:00.000Z'
  const t = Date.parse(approvedAt)
  const ready = makeEntry({ status: 'approved', approved_at: approvedAt })

  test('grace elapsed + abort absent => true', () => {
    expect(shouldDispatch(ready, t + APPROVE_GRACE_MS, false)).toBe(true)
  })

  test('grace elapsed + abort present => false (= held)', () => {
    expect(shouldDispatch(ready, t + APPROVE_GRACE_MS, true)).toBe(false)
  })

  test('grace not elapsed => false', () => {
    expect(shouldDispatch(ready, t + APPROVE_GRACE_MS - 1, false)).toBe(false)
  })

  test('non-approved status => false', () => {
    expect(
      shouldDispatch(makeEntry({ status: 'pending', approved_at: approvedAt }), t + 999_999, false),
    ).toBe(false)
    expect(
      shouldDispatch(makeEntry({ status: 'sent', approved_at: approvedAt }), t + 999_999, false),
    ).toBe(false)
  })

  test('missing approved_at => false', () => {
    expect(shouldDispatch(makeEntry({ status: 'approved' }), Date.now(), false)).toBe(false)
  })
})

// --- resolveBareOk ----------------------------------------------------

describe('resolveBareOk', () => {
  const baseCreated = '2026-05-10T01:00:00.000Z'
  const now = Date.parse(baseCreated) + 1000

  test('no pending -> no-pending rejection', () => {
    const r = resolveBareOk([], now, 'tts')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('no-pending')
    expect(r.candidates).toEqual([])
  })

  test('multiple pending -> multiple rejection with candidate list', () => {
    const a = makeEntry({
      draft_id: 'a',
      created_at: '2026-05-10T01:00:00.000Z',
      slack_thread_ts: 'tts',
    })
    const b = makeEntry({
      draft_id: 'b',
      created_at: '2026-05-10T01:00:01.000Z',
      slack_thread_ts: 'tts',
    })
    const r = resolveBareOk([a, b], now, 'tts')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('multiple')
    expect(r.candidates.map((e) => e.draft_id)).toEqual(['a', 'b'])
  })

  test('exactly 1 pending TTL expired -> ttl-expired rejection', () => {
    const a = makeEntry({
      draft_id: 'a',
      created_at: baseCreated,
      ttl_ms: 100, // very short
      slack_thread_ts: 'tts',
    })
    const r = resolveBareOk([a], Date.parse(baseCreated) + 1000, 'tts')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('ttl-expired')
    expect(r.candidates).toEqual([a])
  })

  test('exactly 1 pending in TTL but thread mismatch -> thread-mismatch', () => {
    const a = makeEntry({ draft_id: 'a', slack_thread_ts: 'TTS_A' })
    const r = resolveBareOk([a], now, 'TTS_OTHER')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('thread-mismatch')
  })

  test('exactly 1 pending in TTL but draft has no thread_ts -> thread-mismatch', () => {
    const a = makeEntry({ draft_id: 'a', slack_thread_ts: undefined })
    const r = resolveBareOk([a], now, 'TTS_X')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('thread-mismatch')
  })

  test('exactly 1 pending in TTL, thread match -> ok', () => {
    const a = makeEntry({ draft_id: 'a', slack_thread_ts: 'tts' })
    const r = resolveBareOk([a], now, 'tts')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.entry.draft_id).toBe('a')
  })

  test('approved entries do not count toward pending', () => {
    const a = makeEntry({
      draft_id: 'a',
      status: 'approved',
      slack_thread_ts: 'tts',
    })
    const b = makeEntry({ draft_id: 'b', slack_thread_ts: 'tts' })
    const r = resolveBareOk([a, b], now, 'tts')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.entry.draft_id).toBe('b')
  })
})

// --- findEntryByDraftId / findDuplicateDraftIds ----------------------

describe('find* helpers', () => {
  test('findEntryByDraftId returns the matching entry or null', () => {
    const a = makeEntry({ draft_id: 'a' })
    const b = makeEntry({ draft_id: 'b' })
    expect(findEntryByDraftId([a, b], 'b')?.draft_id).toBe('b')
    expect(findEntryByDraftId([a, b], 'zzz')).toBeNull()
  })

  test('findDuplicateDraftIds reports re-write bug indicator', () => {
    const a = makeEntry({ draft_id: 'a' })
    const a2 = makeEntry({ draft_id: 'a' })
    const b = makeEntry({ draft_id: 'b' })
    expect(findDuplicateDraftIds([a, b])).toEqual([])
    expect(findDuplicateDraftIds([a, a2, b])).toEqual(['a'])
  })

  test('findEntriesByDraftId returns ALL matches (= duplicate gate input)', () => {
    // Codex review on PR #5: handlers must REFUSE to act when more
    // than one file shares the same draft_id rather than silently
    // mutating only the first match. findEntriesByDraftId surfaces
    // the count to the caller so it can short-circuit.
    const a = makeEntry({ draft_id: 'a', path: '/tmp/a-1.md' })
    const a2 = makeEntry({ draft_id: 'a', path: '/tmp/a-2.md' })
    const b = makeEntry({ draft_id: 'b' })
    expect(findEntriesByDraftId([a, a2, b], 'a').length).toBe(2)
    expect(findEntriesByDraftId([a, a2, b], 'a').map((e) => e.path)).toEqual([
      '/tmp/a-1.md',
      '/tmp/a-2.md',
    ])
    expect(findEntriesByDraftId([a, a2, b], 'b').length).toBe(1)
    expect(findEntriesByDraftId([a, a2, b], 'zzz').length).toBe(0)
  })
})

// --- extractDraftIdArg / summaryLine ---------------------------------

describe('extractDraftIdArg', () => {
  test('takes the first whitespace-delimited token after the verb', () => {
    expect(extractDraftIdArg('approve ABC123', 'approve')).toBe('ABC123')
    expect(extractDraftIdArg('cancel ABC123 leftover', 'cancel')).toBe('ABC123')
    expect(extractDraftIdArg('  approve\tABC123  ', 'approve')).toBe('ABC123')
  })

  test('case-insensitive verb', () => {
    expect(extractDraftIdArg('APPROVE ABC', 'approve')).toBe('ABC')
    expect(extractDraftIdArg('Cancel xyz', 'cancel')).toBe('xyz')
  })

  test('no arg -> null (= format error from caller)', () => {
    expect(extractDraftIdArg('approve', 'approve')).toBeNull()
    expect(extractDraftIdArg('approve   ', 'approve')).toBeNull()
    expect(extractDraftIdArg('cancel', 'cancel')).toBeNull()
  })

  test('different verb -> null', () => {
    expect(extractDraftIdArg('cancel ABC', 'approve')).toBeNull()
  })
})

describe('summaryLine', () => {
  test('first non-empty body line', () => {
    expect(summaryLine(makeEntry({ body: 'first\nsecond' }))).toBe('first')
    expect(summaryLine(makeEntry({ body: '\n\n\nfirst' }))).toBe('first')
    expect(summaryLine(makeEntry({ body: '   leading ws\n2' }))).toBe('leading ws')
    expect(summaryLine(makeEntry({ body: '' }))).toBe('')
    expect(summaryLine(makeEntry({ body: '\n\n' }))).toBe('')
  })
})

// --- listOutboxEntries / transitionEntry (filesystem) ----------------

describe('listOutboxEntries / transitionEntry (temp dir)', () => {
  test('reads valid + skips malformed; transitionEntry rewrites in place', () => {
    const dir = mkdtempSync(join(tmpdir(), 'outbox-test-'))
    try {
      writeFileSync(
        join(dir, 'a.md'),
        '---\ndraft_id: "d1"\nstatus: "pending"\ncreated_at: "2026-05-10T01:00:00.000Z"\nttl: "30m"\nslack_chat_id: "D1"\nslack_thread_ts: "tts1"\ntarget_role: "consultant"\n---\nfirst body line\nsecond',
      )
      writeFileSync(
        join(dir, 'b.md'),
        '---\ndraft_id: "d2"\nstatus: "approved"\ncreated_at: "2026-05-10T01:00:01.000Z"\nttl: "30m"\nslack_chat_id: "D1"\napproved_at: "2026-05-10T01:00:02.000Z"\napproved_by: "hikaru"\n---\nbody-2',
      )
      // malformed: missing draft_id
      writeFileSync(join(dir, 'malformed.md'), '---\nstatus: "pending"\ncreated_at: "x"\n---\nbody')
      // non-frontmatter file
      writeFileSync(join(dir, 'plain.md'), 'no frontmatter')

      const entries = listOutboxEntries(dir)
      expect(entries.length).toBe(2)
      expect(entries.map((e) => e.draft_id).sort()).toEqual(['d1', 'd2'])

      // Transition d1 to approved
      const d1 = findEntryByDraftId(entries, 'd1')
      expect(d1).not.toBeNull()
      if (!d1) return
      const approvedAt = '2026-05-10T01:00:05.000Z'
      transitionEntry(d1, {
        status: 'approved',
        approved_at: approvedAt,
        approved_by: 'hikaru',
      })

      // Re-read; the body is preserved, status flipped, fields appended.
      const entries2 = listOutboxEntries(dir)
      const d1again = findEntryByDraftId(entries2, 'd1')
      expect(d1again).not.toBeNull()
      if (!d1again) return
      expect(d1again.status).toBe('approved')
      expect(d1again.approved_at).toBe(approvedAt)
      expect(d1again.approved_by).toBe('hikaru')
      expect(d1again.body).toBe('first body line\nsecond')
      // Other fields preserved.
      expect(d1again.slack_chat_id).toBe('D1')
      expect(d1again.slack_thread_ts).toBe('tts1')
      expect(d1again.target_role).toBe('consultant')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('listOutboxEntries on non-existent dir returns empty', () => {
    expect(listOutboxEntries(join(tmpdir(), `outbox-no-${Date.now()}`))).toEqual([])
  })
})
