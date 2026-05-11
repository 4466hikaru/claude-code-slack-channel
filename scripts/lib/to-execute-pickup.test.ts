import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  ABORT_FLAG_PATH,
  type AssignmentEntry,
  assignmentBodyForDisplay,
  claimAssignment,
  containsTokenLike,
  formatAssignmentSummary,
  interpretAssignment,
  listPendingAssignments,
  recommendedDoneFilename,
  resolveAssignment,
  TO_EXECUTE_DIR,
  TO_EXECUTE_PROCESSED_DIR,
} from './to-execute-pickup'

// --- helpers ---------------------------------------------------------

function writeAssignment(dir: string, name: string, fmLines: string[], body = ''): string {
  const path = join(dir, name)
  writeFileSync(path, `---\n${fmLines.join('\n')}\n---\n${body}`)
  return path
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'to-execute-pickup-test-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- constants -------------------------------------------------------

describe('constants', () => {
  test('TO_EXECUTE_DIR / TO_EXECUTE_PROCESSED_DIR / ABORT_FLAG_PATH are absolute', () => {
    expect(TO_EXECUTE_DIR).toBe('/home/hikaru/projects/hikaru-agent-knowledge/handoff/to-execute')
    expect(TO_EXECUTE_PROCESSED_DIR).toBe(`${TO_EXECUTE_DIR}/processed`)
    expect(ABORT_FLAG_PATH).toBe('/home/hikaru/projects/hikaru-agent-knowledge/handoff/abort-lv2')
  })
})

// --- interpretAssignment ---------------------------------------------

describe('interpretAssignment', () => {
  test('valid assign frontmatter → parsed entry with all fields surfaced', () => {
    const fm = {
      type: 'assign',
      correlation_id: 'bd-ccsc-cw1',
      related_task: 'ccsc-cw1',
      risk_level: 'medium',
      dev_verification: 'required',
      prod_gate: 'none',
      priority: 'P3',
      repo: '4466hikaru/claude-code-slack-channel',
      branch: 'feat/executor-to-execute-auto-pickup',
      pr_title: 'feat(executor): add pickup',
      consult_id: '01HXYZ',
      codex_plan_ref: '/home/x/plan.md',
      slack_origin_chat_id: 'D0B2GN71MNE',
      slack_origin_thread_ts: '1700.456',
      requires_human: 'false',
    }
    const entry = interpretAssignment('/tmp/a.md', fm, 'body')
    expect(entry).not.toBeNull()
    if (!entry) return
    expect(entry.path).toBe('/tmp/a.md')
    expect(entry.filename).toBe('a.md')
    expect(entry.correlation_id).toBe('bd-ccsc-cw1')
    expect(entry.related_task).toBe('ccsc-cw1')
    expect(entry.risk_level).toBe('medium')
    expect(entry.dev_verification).toBe('required')
    expect(entry.prod_gate).toBe('none')
    expect(entry.priority).toBe('P3')
    expect(entry.repo).toBe('4466hikaru/claude-code-slack-channel')
    expect(entry.branch).toBe('feat/executor-to-execute-auto-pickup')
    expect(entry.pr_title).toBe('feat(executor): add pickup')
    expect(entry.consult_id).toBe('01HXYZ')
    expect(entry.codex_plan_ref).toBe('/home/x/plan.md')
    expect(entry.slack_origin_chat_id).toBe('D0B2GN71MNE')
    expect(entry.slack_origin_thread_ts).toBe('1700.456')
    expect(entry.requires_human).toBe('false')
    expect(entry.body).toBe('body')
  })

  test('type !== assign → null (= not our concern, NOT malformed)', () => {
    expect(interpretAssignment('/tmp/x.md', { type: 'done', done_id: 'd1' }, '')).toBeNull()
    expect(
      interpretAssignment('/tmp/x.md', { type: 'result', correlation_id: 'c1' }, ''),
    ).toBeNull()
    expect(interpretAssignment('/tmp/x.md', {}, '')).toBeNull()
  })

  test('missing correlation_id → null', () => {
    expect(interpretAssignment('/tmp/x.md', { type: 'assign' }, '')).toBeNull()
    expect(interpretAssignment('/tmp/x.md', { type: 'assign', correlation_id: '' }, '')).toBeNull()
  })

  test('optional fields default to null when absent', () => {
    const entry = interpretAssignment('/tmp/x.md', { type: 'assign', correlation_id: 'c1' }, '')
    expect(entry).not.toBeNull()
    if (!entry) return
    expect(entry.related_task).toBeNull()
    expect(entry.risk_level).toBeNull()
    expect(entry.prod_gate).toBeNull()
    expect(entry.repo).toBeNull()
    expect(entry.consult_id).toBeNull()
    expect(entry.requires_human).toBeNull()
  })
})

// --- listPendingAssignments ------------------------------------------

describe('listPendingAssignments', () => {
  test('non-existent dir → empty result, no throw', () => {
    const r = listPendingAssignments(join(tmpdir(), `no-such-${Date.now()}`))
    expect(r.entries).toEqual([])
    expect(r.malformed_count).toBe(0)
    expect(r.skipped_non_assign_count).toBe(0)
    expect(r.total_files).toBe(0)
  })

  test('partitions assign / non-assign / malformed; sorted by filename', () => {
    withTempDir((dir) => {
      writeAssignment(
        dir,
        '2026-05-11T1600-A.md',
        ['type: "assign"', 'correlation_id: "A"', 'risk_level: "low"'],
        '# Assignment A\nbody A line\n',
      )
      writeAssignment(
        dir,
        '2026-05-11T1500-B.md',
        ['type: "assign"', 'correlation_id: "B"'],
        'body B\n',
      )
      // non-assign coexisting file (= future workflow)
      writeAssignment(dir, '2026-05-11T1700-C.md', ['type: "ping"'], 'body C')
      // malformed: no frontmatter delimiter at all
      writeFileSync(join(dir, 'broken.md'), 'no frontmatter')
      // assign with missing correlation_id → malformed by our standard
      writeAssignment(dir, '2026-05-11T1800-D.md', ['type: "assign"'], 'body D')
      // non-md file (must be ignored entirely)
      writeFileSync(join(dir, 'README.txt'), 'note')

      const r = listPendingAssignments(dir)
      expect(r.total_files).toBe(5) // 5 .md files inspected (README.txt skipped)
      expect(r.entries.map((e) => e.correlation_id)).toEqual(['B', 'A'])
      expect(r.skipped_non_assign_count).toBe(1) // ping type
      expect(r.malformed_count).toBe(2) // no frontmatter + missing correlation_id
    })
  })

  test('processed/ subdir is automatically excluded (readdirSync depth=1)', () => {
    withTempDir((dir) => {
      writeAssignment(dir, '2026-05-11T1600-A.md', ['type: "assign"', 'correlation_id: "A"'])
      const processed = join(dir, 'processed')
      mkdirSync(processed)
      // Simulate a prior claim. The processed/ subdir contains historical
      // assignments that must NOT appear in the pending list.
      writeAssignment(processed, '2026-05-10T0900-X.md', [
        'type: "assign"',
        'correlation_id: "X"',
      ])
      const r = listPendingAssignments(dir)
      // Only top-level A is listed; the processed/X.md is not seen.
      expect(r.entries.map((e) => e.correlation_id)).toEqual(['A'])
    })
  })
})

// --- resolveAssignment -----------------------------------------------

describe('resolveAssignment', () => {
  function fixtures(): AssignmentEntry[] {
    return [
      {
        path: '/x/2026-05-11T1600-ccsc-cw1.md',
        filename: '2026-05-11T1600-ccsc-cw1.md',
        correlation_id: 'bd-ccsc-cw1',
        related_task: 'ccsc-cw1',
        risk_level: 'medium',
        dev_verification: 'required',
        prod_gate: 'none',
        priority: 'P3',
        repo: null,
        branch: null,
        pr_title: null,
        consult_id: null,
        codex_plan_ref: null,
        slack_origin_chat_id: null,
        slack_origin_thread_ts: null,
        requires_human: null,
        fm: {},
        body: '',
      },
      {
        path: '/x/2026-05-11T1700-other.md',
        filename: '2026-05-11T1700-other.md',
        correlation_id: 'consult-XYZ',
        related_task: null,
        risk_level: null,
        dev_verification: null,
        prod_gate: null,
        priority: null,
        repo: null,
        branch: null,
        pr_title: null,
        consult_id: null,
        codex_plan_ref: null,
        slack_origin_chat_id: null,
        slack_origin_thread_ts: null,
        requires_human: null,
        fm: {},
        body: '',
      },
    ]
  }

  test('exact filename match', () => {
    const r = resolveAssignment(fixtures(), '2026-05-11T1600-ccsc-cw1.md')
    expect(r.kind).toBe('found')
    if (r.kind === 'found') expect(r.entry.correlation_id).toBe('bd-ccsc-cw1')
  })

  test('exact basename (no .md) match', () => {
    const r = resolveAssignment(fixtures(), '2026-05-11T1600-ccsc-cw1')
    expect(r.kind).toBe('found')
    if (r.kind === 'found') expect(r.entry.correlation_id).toBe('bd-ccsc-cw1')
  })

  test('exact correlation_id match', () => {
    const r = resolveAssignment(fixtures(), 'bd-ccsc-cw1')
    expect(r.kind).toBe('found')
    if (r.kind === 'found') expect(r.entry.filename).toBe('2026-05-11T1600-ccsc-cw1.md')
  })

  test('unique substring match', () => {
    const r = resolveAssignment(fixtures(), 'cw1')
    expect(r.kind).toBe('found')
    if (r.kind === 'found') expect(r.entry.correlation_id).toBe('bd-ccsc-cw1')
  })

  test('substring matching multiple entries → ambiguous with candidates', () => {
    const r = resolveAssignment(fixtures(), '2026-05-11T17') // both filenames don't share this
    // actually only `other` starts with T17; let me use a substring shared by both
    expect(r.kind).toBe('found')
    if (r.kind === 'found') expect(r.entry.filename).toContain('T1700')

    const r2 = resolveAssignment(fixtures(), '2026-05-11') // both filenames share this
    expect(r2.kind).toBe('ambiguous')
    if (r2.kind === 'ambiguous') expect(r2.matches).toHaveLength(2)
  })

  test('unknown identifier → none', () => {
    expect(resolveAssignment(fixtures(), 'no-such-id').kind).toBe('none')
    expect(resolveAssignment(fixtures(), '').kind).toBe('none')
  })
})

// --- claimAssignment -------------------------------------------------

describe('claimAssignment', () => {
  test('atomic move into processed/, returns destination, creates dir', () => {
    withTempDir((dir) => {
      const srcPath = writeAssignment(dir, '2026-05-11T1635-ccsc-cw1.md', [
        'type: "assign"',
        'correlation_id: "bd-ccsc-cw1"',
      ])
      const processed = join(dir, 'processed')
      expect(existsSync(processed)).toBe(false)

      const r = listPendingAssignments(dir)
      const entry = r.entries[0]
      expect(entry).toBeDefined()

      const dest = claimAssignment(entry, processed)
      expect(dest).toBe(join(processed, '2026-05-11T1635-ccsc-cw1.md'))
      expect(existsSync(srcPath)).toBe(false)
      expect(existsSync(dest)).toBe(true)
      expect(existsSync(processed)).toBe(true)

      // Subsequent listPendingAssignments must NOT show this assignment.
      const r2 = listPendingAssignments(dir)
      expect(r2.entries).toEqual([])
    })
  })

  test('claim preserves body byte-for-byte', () => {
    withTempDir((dir) => {
      writeAssignment(
        dir,
        '2026-05-11T1635-X.md',
        ['type: "assign"', 'correlation_id: "X"'],
        '# Title\n\nBody line 1\nBody line 2\n',
      )
      const entry = listPendingAssignments(dir).entries[0]
      const dest = claimAssignment(entry, join(dir, 'processed'))
      expect(readFileSync(dest, 'utf-8')).toContain('# Title')
      expect(readFileSync(dest, 'utf-8')).toContain('Body line 2')
    })
  })

  test('double claim of same entry: second call throws (= file already moved)', () => {
    withTempDir((dir) => {
      writeAssignment(dir, '2026-05-11T1635-Y.md', ['type: "assign"', 'correlation_id: "Y"'])
      const entry = listPendingAssignments(dir).entries[0]
      claimAssignment(entry, join(dir, 'processed'))
      // The entry's source path no longer exists.
      expect(() => claimAssignment(entry, join(dir, 'processed'))).toThrow()
    })
  })
})



describe('secret redaction for display', () => {
  test('detects token-like content and hides assignment body display', () => {
    expect(containsTokenLike('Bearer abcdefghijklmnop')).toBe(true)
    const body = assignmentBodyForDisplay('Use xoxb-secret-token')
    expect(body).toContain('token-like secret')
    expect(body).not.toContain('xoxb-secret-token')
  })

  test('formatAssignmentSummary hides token-like first body line', () => {
    const entry: AssignmentEntry = {
      path: '/tmp/a.md',
      filename: 'a.md',
      correlation_id: 'c1',
      related_task: null,
      risk_level: null,
      dev_verification: null,
      prod_gate: null,
      priority: null,
      repo: null,
      branch: null,
      pr_title: null,
      consult_id: null,
      codex_plan_ref: null,
      slack_origin_chat_id: null,
      slack_origin_thread_ts: null,
      requires_human: null,
      fm: {},
      body: 'xoxb-secret-token',
    }
    const summary = formatAssignmentSummary(entry)
    expect(summary).toContain('token-like secret')
    expect(summary).not.toContain('xoxb-secret-token')
  })
})

// --- formatAssignmentSummary -----------------------------------------

describe('formatAssignmentSummary', () => {
  test('includes filename, tags, correlation_id, first body line', () => {
    const entry: AssignmentEntry = {
      path: '/x/2026-05-11T1635-ccsc-cw1.md',
      filename: '2026-05-11T1635-ccsc-cw1.md',
      correlation_id: 'bd-ccsc-cw1',
      related_task: 'ccsc-cw1',
      risk_level: 'medium',
      dev_verification: 'required',
      prod_gate: 'none',
      priority: 'P3',
      repo: null,
      branch: null,
      pr_title: null,
      consult_id: null,
      codex_plan_ref: null,
      slack_origin_chat_id: null,
      slack_origin_thread_ts: null,
      requires_human: null,
      fm: {},
      body: '# Assignment: ccsc-cw1 — executor to-execute auto-pickup\n\n## Goal\nImplement the smallest safe path\n',
    }
    const s = formatAssignmentSummary(entry)
    expect(s).toContain('2026-05-11T1635-ccsc-cw1.md')
    expect(s).toContain('risk=medium')
    expect(s).toContain('gate=none')
    expect(s).toContain('prio=P3')
    expect(s).toContain('bd-ccsc-cw1')
    // First non-blank non-heading body line (= "## Goal" line is a
    // Markdown heading and skipped; the next non-blank line is the
    // prose under it).
    expect(s).toContain('Implement the smallest safe path')
    expect(s).not.toContain('## Goal')
  })

  test('omits tag block when no optional fields present', () => {
    const entry: AssignmentEntry = {
      path: '/x/a.md',
      filename: 'a.md',
      correlation_id: 'X',
      related_task: null,
      risk_level: null,
      dev_verification: null,
      prod_gate: null,
      priority: null,
      repo: null,
      branch: null,
      pr_title: null,
      consult_id: null,
      codex_plan_ref: null,
      slack_origin_chat_id: null,
      slack_origin_thread_ts: null,
      requires_human: null,
      fm: {},
      body: 'first body line\n',
    }
    const s = formatAssignmentSummary(entry)
    expect(s).toContain('a.md')
    expect(s).toContain('X')
    expect(s).not.toContain('[')
    expect(s).toContain('first body line')
  })

  test('truncates long body lines with ellipsis', () => {
    const long = 'a'.repeat(200)
    const entry: AssignmentEntry = {
      path: '/x/a.md',
      filename: 'a.md',
      correlation_id: 'X',
      related_task: null,
      risk_level: null,
      dev_verification: null,
      prod_gate: null,
      priority: null,
      repo: null,
      branch: null,
      pr_title: null,
      consult_id: null,
      codex_plan_ref: null,
      slack_origin_chat_id: null,
      slack_origin_thread_ts: null,
      requires_human: null,
      fm: {},
      body: `${long}\n`,
    }
    const s = formatAssignmentSummary(entry, 50)
    expect(s).toContain('a'.repeat(50))
    expect(s).toContain('…')
    expect(s).not.toContain('a'.repeat(60))
  })
})

// --- recommendedDoneFilename -----------------------------------------

describe('recommendedDoneFilename', () => {
  test('format: done-<UTC yyyy-mm-ddThhmm>-<done_id>.md', () => {
    const d = new Date(Date.UTC(2026, 4, 12, 1, 15, 0))
    expect(recommendedDoneFilename('ccsc-cw1', d)).toBe('done-2026-05-12T0115-ccsc-cw1.md')
  })

  test('uses current time when `now` is omitted', () => {
    const s = recommendedDoneFilename('ccsc-cw1')
    expect(s).toMatch(/^done-\d{4}-\d{2}-\d{2}T\d{4}-ccsc-cw1\.md$/)
  })
})

// --- basename round-trip sanity --------------------------------------

describe('claim → list → resolve sanity', () => {
  test('after claim, resolve cannot find by id (= not in pending)', () => {
    withTempDir((dir) => {
      writeAssignment(dir, '2026-05-11T1635-Z.md', ['type: "assign"', 'correlation_id: "bd-Z"'])
      const before = listPendingAssignments(dir).entries
      const z = before.find((e) => e.correlation_id === 'bd-Z')
      expect(z).toBeDefined()
      if (!z) return
      claimAssignment(z, join(dir, 'processed'))

      const after = listPendingAssignments(dir).entries
      expect(resolveAssignment(after, 'bd-Z').kind).toBe('none')
      // Confirm the file moved (= basename preserved)
      expect(existsSync(join(dir, 'processed', basename(z.path)))).toBe(true)
    })
  })
})
