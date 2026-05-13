import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  ABORT_FLAG_PATH,
  assignmentBodyForDisplay,
  type ConsultInboxEntry,
  claimInboxEntry,
  containsTokenLike,
  FROM_EXECUTE_DIR,
  FROM_EXECUTE_PROCESSED_DIR,
  formatInboxSummary,
  interpretInboxEntry,
  listPendingInbox,
  RECOGNISED_INBOX_TYPES,
  resolveInboxEntry,
} from './from-execute-pickup'

// --- helpers ---------------------------------------------------------

function writeEntry(dir: string, name: string, fmLines: string[], body = ''): string {
  const path = join(dir, name)
  writeFileSync(path, `---\n${fmLines.join('\n')}\n---\n${body}`)
  return path
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'from-execute-pickup-test-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- constants -------------------------------------------------------

describe('constants', () => {
  test('inbox / processed / abort paths match the inter-session-protocol layout', () => {
    expect(FROM_EXECUTE_DIR).toBe(
      '/home/hikaru/projects/hikaru-agent-knowledge/handoff/from-execute',
    )
    // Per handoff/README.md the consult-side processed dir is
    // handoff/processed/from-execute/, distinct from the watcher's
    // handoff/from-execute/processed/. The CLI must NOT claim into the
    // latter or it would race the watcher's executor-relay.
    expect(FROM_EXECUTE_PROCESSED_DIR).toBe(
      '/home/hikaru/projects/hikaru-agent-knowledge/handoff/processed/from-execute',
    )
    expect(FROM_EXECUTE_PROCESSED_DIR).not.toBe(`${FROM_EXECUTE_DIR}/processed`)
    // Abort flag is shared with the executor pickup (= one signal halts both).
    expect(ABORT_FLAG_PATH).toBe('/home/hikaru/projects/hikaru-agent-knowledge/handoff/abort-lv2')
  })

  test('RECOGNISED_INBOX_TYPES matches the assignment scope (result / propose / ask / progress)', () => {
    expect([...RECOGNISED_INBOX_TYPES].sort()).toEqual(['ask', 'progress', 'propose', 'result'])
    // `done` is deliberately NOT in this set — those belong to the
    // watcher's executor-relay path.
    expect((RECOGNISED_INBOX_TYPES as readonly string[]).includes('done')).toBe(false)
  })
})

// --- interpretInboxEntry ---------------------------------------------

describe('interpretInboxEntry', () => {
  test('valid recognised entry → parsed entry with all fields surfaced', () => {
    const fm = {
      type: 'result',
      correlation_id: '01HXACK1R2K',
      from: '実行担当',
      to: '相談担当',
      in_reply_to: '01HXPIVOTR2',
      related_task: '2026-05-09-multi-consultant-architecture',
      requires_human: 'false',
      created: '2026-05-09T12:56:34+09:00',
      consult_id: 'consult-XYZ',
    }
    const entry = interpretInboxEntry('/tmp/a.md', fm, 'body')
    expect(entry).not.toBeNull()
    if (!entry) return
    expect(entry.path).toBe('/tmp/a.md')
    expect(entry.filename).toBe('a.md')
    expect(entry.type).toBe('result')
    expect(entry.correlation_id).toBe('01HXACK1R2K')
    expect(entry.from).toBe('実行担当')
    expect(entry.to).toBe('相談担当')
    expect(entry.in_reply_to).toBe('01HXPIVOTR2')
    expect(entry.related_task).toBe('2026-05-09-multi-consultant-architecture')
    expect(entry.requires_human).toBe('false')
    expect(entry.created).toBe('2026-05-09T12:56:34+09:00')
    expect(entry.consult_id).toBe('consult-XYZ')
    expect(entry.body).toBe('body')
  })

  test('every recognised type yields a non-null entry when correlation_id is present', () => {
    for (const t of RECOGNISED_INBOX_TYPES) {
      const entry = interpretInboxEntry('/tmp/x.md', { type: t, correlation_id: 'c1' }, '')
      expect(entry).not.toBeNull()
      if (entry) expect(entry.type).toBe(t)
    }
  })

  test('type !== recognised → null (= not our concern, NOT malformed)', () => {
    expect(interpretInboxEntry('/tmp/x.md', { type: 'done', done_id: 'd1' }, '')).toBeNull()
    expect(
      interpretInboxEntry('/tmp/x.md', { type: 'assign', correlation_id: 'c1' }, ''),
    ).toBeNull()
    expect(
      interpretInboxEntry('/tmp/x.md', { type: 'verification-result', correlation_id: 'c1' }, ''),
    ).toBeNull()
    expect(interpretInboxEntry('/tmp/x.md', {}, '')).toBeNull()
  })

  test('missing correlation_id → null (= belongs to malformed_count)', () => {
    expect(interpretInboxEntry('/tmp/x.md', { type: 'result' }, '')).toBeNull()
    expect(interpretInboxEntry('/tmp/x.md', { type: 'result', correlation_id: '' }, '')).toBeNull()
  })

  test('optional fields default to null when absent', () => {
    const entry = interpretInboxEntry('/tmp/x.md', { type: 'propose', correlation_id: 'c1' }, '')
    expect(entry).not.toBeNull()
    if (!entry) return
    expect(entry.from).toBeNull()
    expect(entry.to).toBeNull()
    expect(entry.in_reply_to).toBeNull()
    expect(entry.related_task).toBeNull()
    expect(entry.requires_human).toBeNull()
    expect(entry.created).toBeNull()
    expect(entry.consult_id).toBeNull()
  })
})

// --- listPendingInbox ------------------------------------------------

describe('listPendingInbox', () => {
  test('non-existent dir → empty result, no throw', () => {
    const r = listPendingInbox(join(tmpdir(), `no-such-${Date.now()}`))
    expect(r.entries).toEqual([])
    expect(r.malformed_count).toBe(0)
    expect(r.skipped_non_target_count).toBe(0)
    expect(r.total_files).toBe(0)
  })

  test('partitions recognised / non-target / malformed; sorted by filename', () => {
    withTempDir((dir) => {
      writeEntry(
        dir,
        '2026-05-13T1600-A.md',
        ['type: "result"', 'correlation_id: "A"', 'from: "実行担当"'],
        '# Result A\nbody A line\n',
      )
      writeEntry(
        dir,
        '2026-05-13T1500-B.md',
        ['type: "propose"', 'correlation_id: "B"'],
        'body B\n',
      )
      // non-target: done file (watcher territory)
      writeEntry(dir, '2026-05-13T1700-done.md', ['type: "done"', 'done_id: "x"'], 'body done')
      // non-target: future workflow type
      writeEntry(dir, '2026-05-13T1730-future.md', ['type: "verification-result"'], 'body v')
      // malformed: no frontmatter delimiter at all
      writeFileSync(join(dir, 'broken.md'), 'no frontmatter')
      // malformed: recognised type with missing correlation_id
      writeEntry(dir, '2026-05-13T1800-D.md', ['type: "ask"'], 'body D')
      // non-md file (must be ignored entirely)
      writeFileSync(join(dir, 'README.txt'), 'note')

      const r = listPendingInbox(dir)
      expect(r.total_files).toBe(6) // 6 .md files inspected (README.txt skipped)
      expect(r.entries.map((e) => e.correlation_id)).toEqual(['B', 'A'])
      // done + verification-result both classified as non-target.
      expect(r.skipped_non_target_count).toBe(2)
      // broken + ask-with-missing-correlation_id both classified malformed.
      expect(r.malformed_count).toBe(2)
    })
  })

  test('processed/ subdir is automatically excluded (readdirSync depth=1)', () => {
    withTempDir((dir) => {
      writeEntry(dir, '2026-05-13T1600-A.md', ['type: "result"', 'correlation_id: "A"'])
      const processed = join(dir, 'processed')
      mkdirSync(processed)
      // Simulate a prior consult claim. The processed/ subdir contains
      // historical entries that must NOT appear in the pending list.
      writeEntry(processed, '2026-05-13T0900-X.md', ['type: "result"', 'correlation_id: "X"'])
      const r = listPendingInbox(dir)
      expect(r.entries.map((e) => e.correlation_id)).toEqual(['A'])
    })
  })

  test('does NOT pick up done files that should be left to the watcher relay', () => {
    withTempDir((dir) => {
      // Imitate the actual from-execute root: a mix of done (= watcher
      // territory) and result/propose (= consult territory). Only the
      // latter should be in entries[].
      writeEntry(dir, '2026-05-12T0600-done-x.md', ['type: "done"', 'done_id: "x"'])
      writeEntry(dir, '2026-05-12T0700-done-y.md', ['type: "done"', 'done_id: "y"'])
      writeEntry(dir, '2026-05-12T0800-result-z.md', ['type: "result"', 'correlation_id: "z"'])
      const r = listPendingInbox(dir)
      expect(r.entries.map((e) => e.correlation_id)).toEqual(['z'])
      expect(r.skipped_non_target_count).toBe(2)
    })
  })
})

// --- resolveInboxEntry -----------------------------------------------

describe('resolveInboxEntry', () => {
  function fixtures(): ConsultInboxEntry[] {
    return [
      {
        path: '/x/2026-05-13T1600-codex-consult-foo.md',
        filename: '2026-05-13T1600-codex-consult-foo.md',
        type: 'propose',
        correlation_id: 'codex-consult-foo-20260513',
        from: null,
        to: null,
        in_reply_to: null,
        related_task: null,
        requires_human: null,
        created: null,
        consult_id: null,
        fm: {},
        body: '',
      },
      {
        path: '/x/2026-05-13T1700-result-bar.md',
        filename: '2026-05-13T1700-result-bar.md',
        type: 'result',
        correlation_id: 'consult-XYZ',
        from: null,
        to: null,
        in_reply_to: null,
        related_task: null,
        requires_human: null,
        created: null,
        consult_id: null,
        fm: {},
        body: '',
      },
    ]
  }

  test('exact filename match', () => {
    const r = resolveInboxEntry(fixtures(), '2026-05-13T1600-codex-consult-foo.md')
    expect(r.kind).toBe('found')
    if (r.kind === 'found') expect(r.entry.correlation_id).toBe('codex-consult-foo-20260513')
  })

  test('exact basename (no .md) match', () => {
    const r = resolveInboxEntry(fixtures(), '2026-05-13T1600-codex-consult-foo')
    expect(r.kind).toBe('found')
    if (r.kind === 'found') expect(r.entry.correlation_id).toBe('codex-consult-foo-20260513')
  })

  test('exact correlation_id match', () => {
    const r = resolveInboxEntry(fixtures(), 'codex-consult-foo-20260513')
    expect(r.kind).toBe('found')
    if (r.kind === 'found') expect(r.entry.filename).toBe('2026-05-13T1600-codex-consult-foo.md')
  })

  test('unique substring match', () => {
    const r = resolveInboxEntry(fixtures(), 'foo')
    expect(r.kind).toBe('found')
    if (r.kind === 'found') expect(r.entry.correlation_id).toBe('codex-consult-foo-20260513')
  })

  test('substring matching multiple entries → ambiguous with candidates', () => {
    const r = resolveInboxEntry(fixtures(), '2026-05-13')
    expect(r.kind).toBe('ambiguous')
    if (r.kind === 'ambiguous') expect(r.matches).toHaveLength(2)
  })

  test('unknown identifier → none', () => {
    expect(resolveInboxEntry(fixtures(), 'no-such-id').kind).toBe('none')
    expect(resolveInboxEntry(fixtures(), '').kind).toBe('none')
  })
})

// --- claimInboxEntry -------------------------------------------------

describe('claimInboxEntry', () => {
  test('atomic move into processedDir, returns destination, creates dir', () => {
    withTempDir((dir) => {
      const srcPath = writeEntry(dir, '2026-05-13T1635-result-A.md', [
        'type: "result"',
        'correlation_id: "A"',
      ])
      const processed = join(dir, 'consult-processed')
      expect(existsSync(processed)).toBe(false)

      const entry = listPendingInbox(dir).entries[0]
      expect(entry).toBeDefined()

      const dest = claimInboxEntry(entry, processed)
      expect(dest).toBe(join(processed, '2026-05-13T1635-result-A.md'))
      expect(existsSync(srcPath)).toBe(false)
      expect(existsSync(dest)).toBe(true)
      expect(existsSync(processed)).toBe(true)

      // Subsequent listPendingInbox must NOT show this entry.
      const r2 = listPendingInbox(dir)
      expect(r2.entries).toEqual([])
    })
  })

  test('claim preserves body byte-for-byte', () => {
    withTempDir((dir) => {
      writeEntry(
        dir,
        '2026-05-13T1635-X.md',
        ['type: "result"', 'correlation_id: "X"'],
        '# Title\n\nBody line 1\nBody line 2\n',
      )
      const entry = listPendingInbox(dir).entries[0]
      const dest = claimInboxEntry(entry, join(dir, 'processed'))
      expect(readFileSync(dest, 'utf-8')).toContain('# Title')
      expect(readFileSync(dest, 'utf-8')).toContain('Body line 2')
    })
  })

  test('double claim of same entry: second call throws (= file already moved)', () => {
    withTempDir((dir) => {
      writeEntry(dir, '2026-05-13T1635-Y.md', ['type: "result"', 'correlation_id: "Y"'])
      const entry = listPendingInbox(dir).entries[0]
      claimInboxEntry(entry, join(dir, 'processed'))
      expect(() => claimInboxEntry(entry, join(dir, 'processed'))).toThrow()
    })
  })
})

// --- secret redaction ------------------------------------------------

describe('secret redaction for display', () => {
  test('shared containsTokenLike / assignmentBodyForDisplay re-export still works', () => {
    expect(containsTokenLike('Bearer abcdefghijklmnop')).toBe(true)
    const body = assignmentBodyForDisplay('Use xoxb-secret-token')
    expect(body).toContain('token-like secret')
    expect(body).not.toContain('xoxb-secret-token')
  })

  test('formatInboxSummary hides token-like first body line', () => {
    const entry: ConsultInboxEntry = {
      path: '/tmp/a.md',
      filename: 'a.md',
      type: 'result',
      correlation_id: 'c1',
      from: null,
      to: null,
      in_reply_to: null,
      related_task: null,
      requires_human: null,
      created: null,
      consult_id: null,
      fm: {},
      body: 'xoxb-secret-token',
    }
    const summary = formatInboxSummary(entry)
    expect(summary).toContain('token-like secret')
    expect(summary).not.toContain('xoxb-secret-token')
  })
})

// --- formatInboxSummary ----------------------------------------------

describe('formatInboxSummary', () => {
  test('includes filename, type tag, correlation_id, first body line', () => {
    const entry: ConsultInboxEntry = {
      path: '/x/2026-05-13T1635-codex-consult-foo.md',
      filename: '2026-05-13T1635-codex-consult-foo.md',
      type: 'propose',
      correlation_id: 'codex-consult-foo-20260513',
      from: '実行担当',
      to: '相談担当',
      in_reply_to: 'prev-correlation',
      related_task: null,
      requires_human: null,
      created: null,
      consult_id: null,
      fm: {},
      body: '# Propose: foo\n\n## Goal\nKeep the consult pipeline boring\n',
    }
    const s = formatInboxSummary(entry)
    expect(s).toContain('2026-05-13T1635-codex-consult-foo.md')
    expect(s).toContain('type=propose')
    expect(s).toContain('from=実行担当')
    expect(s).toContain('reply=prev-correlation')
    expect(s).toContain('codex-consult-foo-20260513')
    expect(s).toContain('Keep the consult pipeline boring')
    expect(s).not.toContain('## Goal')
  })

  test('marks requires_human=true entries', () => {
    const entry: ConsultInboxEntry = {
      path: '/x/a.md',
      filename: 'a.md',
      type: 'ask',
      correlation_id: 'X',
      from: null,
      to: null,
      in_reply_to: null,
      related_task: null,
      requires_human: 'true',
      created: null,
      consult_id: null,
      fm: {},
      body: 'first body line\n',
    }
    expect(formatInboxSummary(entry)).toContain('requires_human')
  })

  test('truncates long body lines with ellipsis', () => {
    const long = 'a'.repeat(200)
    const entry: ConsultInboxEntry = {
      path: '/x/a.md',
      filename: 'a.md',
      type: 'result',
      correlation_id: 'X',
      from: null,
      to: null,
      in_reply_to: null,
      related_task: null,
      requires_human: null,
      created: null,
      consult_id: null,
      fm: {},
      body: `${long}\n`,
    }
    const s = formatInboxSummary(entry, 50)
    expect(s).toContain('a'.repeat(50))
    expect(s).toContain('…')
    expect(s).not.toContain('a'.repeat(60))
  })
})

// --- claim → list → resolve sanity -----------------------------------

describe('claim → list → resolve sanity', () => {
  test('after claim, resolve cannot find by id (= not in pending)', () => {
    withTempDir((dir) => {
      writeEntry(dir, '2026-05-13T1635-Z.md', ['type: "result"', 'correlation_id: "bd-Z"'])
      const before = listPendingInbox(dir).entries
      const z = before.find((e) => e.correlation_id === 'bd-Z')
      expect(z).toBeDefined()
      if (!z) return
      claimInboxEntry(z, join(dir, 'processed'))

      const after = listPendingInbox(dir).entries
      expect(resolveInboxEntry(after, 'bd-Z').kind).toBe('none')
      expect(existsSync(join(dir, 'processed', basename(z.path)))).toBe(true)
    })
  })
})
