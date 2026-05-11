import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  archiveDoneFile,
  DONE_DEDUP_WINDOW_MS,
  type DoneEntry,
  detectTokenInDoneEntry,
  formatDoneNotification,
  interpretDoneEntry,
  isRecentlyRelayed,
  listDoneEntries,
  listMalformedDoneFiles,
  pruneRecentlyRelayed,
} from './executor-relay'

// --- interpretDoneEntry ----------------------------------------------

function fm(over: Record<string, string | number | null> = {}) {
  return {
    type: 'done',
    done_id: 'd1',
    status: 'complete',
    summary: 'task complete',
    ...over,
  }
}

describe('interpretDoneEntry', () => {
  test('parses a valid done frontmatter', () => {
    const e = interpretDoneEntry(
      '/tmp/done-x.md',
      fm({
        created_at: '2026-05-11T01:00:00.000Z',
        executor_session: 'exec-A',
        related_bd: 'ccsc-sbf',
        related_pr: 'https://github.com/x/y/pull/1',
        needs_review: 'true',
      }),
      'body text',
    )
    expect(e).not.toBeNull()
    if (!e) return
    expect(e.type).toBe('done')
    expect(e.done_id).toBe('d1')
    expect(e.status).toBe('complete')
    expect(e.summary).toBe('task complete')
    expect(e.created_at).toBe('2026-05-11T01:00:00.000Z')
    expect(e.executor_session).toBe('exec-A')
    expect(e.related_bd).toBe('ccsc-sbf')
    expect(e.related_pr).toBe('https://github.com/x/y/pull/1')
    expect(e.needs_review).toBe(true)
    expect(e.body).toBe('body text')
  })

  test('type !== "done" returns null (= not for this relay)', () => {
    expect(interpretDoneEntry('/tmp/x.md', fm({ type: 'result' }), '')).toBeNull()
    expect(interpretDoneEntry('/tmp/x.md', fm({ type: 'progress' }), '')).toBeNull()
    expect(interpretDoneEntry('/tmp/x.md', fm({ type: 'ask' }), '')).toBeNull()
    expect(interpretDoneEntry('/tmp/x.md', fm({ type: 'propose' }), '')).toBeNull()
  })

  test('missing required fields -> null', () => {
    expect(interpretDoneEntry('/tmp/x.md', fm({ done_id: '' }), '')).toBeNull()
    expect(
      interpretDoneEntry('/tmp/x.md', { type: 'done', status: 'complete', summary: 's' }, ''),
    ).toBeNull()
    expect(interpretDoneEntry('/tmp/x.md', fm({ status: 'unknown' }), '')).toBeNull()
    expect(interpretDoneEntry('/tmp/x.md', fm({ summary: '' }), '')).toBeNull()
  })

  test('needs_review parsing — true tokens', () => {
    for (const v of ['true', 'True', 'TRUE', '1', 'yes', 'YES']) {
      const e = interpretDoneEntry('/tmp/x.md', fm({ needs_review: v }), '')
      expect(e?.needs_review).toBe(true)
    }
  })

  test('needs_review parsing — false / absent tokens', () => {
    for (const v of ['false', 'no', '0', '']) {
      const e = interpretDoneEntry('/tmp/x.md', fm({ needs_review: v }), '')
      expect(e?.needs_review).toBe(false)
    }
    // absent entirely
    const absent = interpretDoneEntry('/tmp/x.md', fm(), '')
    expect(absent?.needs_review).toBe(false)
  })

  test('all three known statuses accepted; unknown rejected', () => {
    for (const s of ['complete', 'blocked', 'failed']) {
      const e = interpretDoneEntry('/tmp/x.md', fm({ status: s }), '')
      expect(e?.status).toBe(s)
    }
    expect(interpretDoneEntry('/tmp/x.md', fm({ status: 'in-progress' }), '')).toBeNull()
  })

  test('empty optional fields normalize to undefined', () => {
    const e = interpretDoneEntry(
      '/tmp/x.md',
      fm({ related_bd: '', related_pr: '', executor_session: '' }),
      '',
    )
    expect(e?.related_bd).toBeUndefined()
    expect(e?.related_pr).toBeUndefined()
    expect(e?.executor_session).toBeUndefined()
  })
})

// --- formatDoneNotification ------------------------------------------

function makeEntry(over: Partial<DoneEntry> = {}): DoneEntry {
  return {
    path: '/tmp/x.md',
    type: 'done',
    done_id: 'd1',
    status: 'complete',
    summary: 'task complete',
    needs_review: false,
    body: '',
    ...over,
  }
}

describe('formatDoneNotification', () => {
  test('minimal: summary + status + done_id', () => {
    const text = formatDoneNotification(makeEntry())
    expect(text).toBe(
      ['✅ 実行役完了: task complete', '  status: complete', '  done_id: d1'].join('\n'),
    )
  })

  test('includes bd / PR lines when present', () => {
    const text = formatDoneNotification(
      makeEntry({
        related_bd: 'ccsc-sbf',
        related_pr: 'https://github.com/x/y/pull/1',
      }),
    )
    expect(text).toContain('bd:     ccsc-sbf')
    expect(text).toContain('PR:     https://github.com/x/y/pull/1')
  })

  test('omits bd / PR lines when absent', () => {
    const text = formatDoneNotification(makeEntry())
    expect(text).not.toContain('bd:')
    expect(text).not.toContain('PR:')
  })

  test('appends [review 待ち] when needs_review is true', () => {
    expect(formatDoneNotification(makeEntry({ needs_review: true }))).toContain('[review 待ち]')
  })

  test('omits [review 待ち] when needs_review is false', () => {
    expect(formatDoneNotification(makeEntry({ needs_review: false }))).not.toContain(
      '[review 待ち]',
    )
  })

  test('preserves status text for blocked / failed', () => {
    expect(formatDoneNotification(makeEntry({ status: 'blocked' }))).toContain('status: blocked')
    expect(formatDoneNotification(makeEntry({ status: 'failed' }))).toContain('status: failed')
  })
})

// --- detectTokenInDoneEntry ------------------------------------------

describe('detectTokenInDoneEntry', () => {
  test('hits token in summary', () => {
    expect(detectTokenInDoneEntry(makeEntry({ summary: 'leaked xoxb-ABCDEFGHIJ1234567890' }))).toBe(
      'xoxb',
    )
  })

  test('hits token in body', () => {
    expect(
      detectTokenInDoneEntry(makeEntry({ body: 'Authorization: Bearer ABCDEFGHIJ12345678' })),
    ).toBe('bearer')
  })

  test('clean summary + body -> null', () => {
    expect(
      detectTokenInDoneEntry(makeEntry({ summary: 'all good', body: 'no secrets here' })),
    ).toBeNull()
  })
})

// --- dedup window ----------------------------------------------------

describe('isRecentlyRelayed / pruneRecentlyRelayed', () => {
  test('returns true within the window, false past', () => {
    const map = new Map<string, number>()
    map.set('d1', 1_000_000)
    expect(isRecentlyRelayed(map, 'd1', 1_000_000 + 1)).toBe(true)
    expect(isRecentlyRelayed(map, 'd1', 1_000_000 + DONE_DEDUP_WINDOW_MS - 1)).toBe(true)
    expect(isRecentlyRelayed(map, 'd1', 1_000_000 + DONE_DEDUP_WINDOW_MS)).toBe(false)
  })

  test('false for unknown id', () => {
    expect(isRecentlyRelayed(new Map(), 'absent', Date.now())).toBe(false)
  })

  test('prune removes stale entries, keeps fresh', () => {
    const map = new Map<string, number>()
    map.set('stale', 1_000_000)
    map.set('fresh', 1_000_000 + DONE_DEDUP_WINDOW_MS / 2)
    const pruned = pruneRecentlyRelayed(map, 1_000_000 + DONE_DEDUP_WINDOW_MS)
    expect(pruned).toEqual(['stale'])
    expect(Array.from(map.keys())).toEqual(['fresh'])
  })
})

// --- listDoneEntries / listMalformedDoneFiles / archiveDoneFile -----

function writeFm(dir: string, name: string, fmLines: string[], body = ''): string {
  const path = join(dir, name)
  writeFileSync(path, `---\n${fmLines.join('\n')}\n---\n${body}`)
  return path
}

describe('listDoneEntries + listMalformedDoneFiles (temp dir)', () => {
  test('partitions valid-done, malformed-done, non-done filenames', () => {
    const dir = mkdtempSync(join(tmpdir(), 'executor-relay-'))
    try {
      // valid
      writeFm(dir, 'done-2026-05-11T0100-d1.md', [
        'type: "done"',
        'done_id: "d1"',
        'status: "complete"',
        'summary: "ok"',
      ])
      // malformed: missing required field
      writeFm(dir, 'done-2026-05-11T0101-d2.md', [
        'type: "done"',
        'status: "complete"',
        'summary: "no done_id"',
      ])
      // wrong type (= NOT in this relay's scope, also not "malformed")
      writeFm(dir, 'done-2026-05-11T0102-d3.md', [
        'type: "result"',
        'status: "complete"',
        'summary: "wrong type"',
      ])
      // non-done filename (= ignored entirely; existing result/propose files)
      writeFm(dir, 'result-2026-05-11T0103-r1.md', ['type: "result"', 'outcome: "done"'])
      writeFm(dir, 'progress-2026-05-11T0104.md', ['type: "progress"'])
      // non-frontmatter file
      writeFileSync(join(dir, 'done-bad-format.md'), 'no frontmatter')

      const entries = listDoneEntries(dir)
      expect(entries.map((e) => e.done_id)).toEqual(['d1'])

      // listMalformedDoneFiles flags everything with done- prefix that
      // doesn't yield a valid DoneEntry (= missing field, wrong type,
      // unparseable). NB: wrong-type done-prefixed files DO show up
      // here per design — operator inspection prompt; the relay still
      // refuses to act on them.
      const malformed = listMalformedDoneFiles(dir).map((p) => p.split('/').pop() ?? '')
      expect(malformed.sort()).toEqual(
        ['done-2026-05-11T0101-d2.md', 'done-2026-05-11T0102-d3.md', 'done-bad-format.md'].sort(),
      )

      // listDoneEntries on non-existent dir returns empty
      expect(listDoneEntries(join(tmpdir(), `no-${Date.now()}`))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('archiveDoneFile', () => {
  test('moves source file into processed dir (creates dir if absent)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'executor-relay-arc-'))
    try {
      const src = writeFm(dir, 'done-a.md', [
        'type: "done"',
        'done_id: "a"',
        'status: "complete"',
        'summary: "x"',
      ])
      const processedDir = join(dir, 'processed')
      // processed dir does not exist beforehand; archiveDoneFile should
      // create it.
      expect(existsSync(processedDir)).toBe(false)
      const dest = archiveDoneFile(src, processedDir)
      expect(dest).toBe(join(processedDir, 'done-a.md'))
      expect(existsSync(processedDir)).toBe(true)
      expect(existsSync(dest)).toBe(true)
      expect(existsSync(src)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
