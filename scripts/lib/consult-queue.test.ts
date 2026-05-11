import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  analyzeConsultLength,
  appendConsultContinuationLog,
  buildConsultFrontmatter,
  CONSULT_QUEUE_DIR,
  classifyConsultSourceChannel,
  consultRequestFilename,
  extractMarkdownBullets,
  findConsultByMessageId,
  findConsultByThreadTs,
  formatConsultAckReply,
  formatPlanShortReply,
  isConsultRequest,
  isTerminalConsultStatus,
  listConsultEntries,
  listReadyCodexPlans,
  parseCodexPlanFile,
  parseHikaruConsultReply,
  rewriteConsultFrontmatter,
} from './consult-queue'

// ---- isConsultRequest ----------------------------------------------

describe('isConsultRequest', () => {
  test('reserved prefixes return false (= existing routing wins)', () => {
    const cases = [
      'status?',
      'PRS?',
      'pending? please',
      '[abort]',
      '[abort-test]',
      '[abort cleanup]',
      '[tech] q',
      '[整理] memo',
      '[新規] ゲーム',
      '/new-project foo',
      '[実行] task',
      '/execute job',
      '[codex-review] pr=https://x/1',
      'approve 01HXY',
      'approve-impl 01HXY',
      'cancel 01HXY',
      'cancel-impl 01HXY',
    ]
    for (const c of cases) {
      expect(isConsultRequest(c)).toBe(false)
    }
  })

  test('bare tokens return false', () => {
    for (const t of [
      'OK',
      'ok',
      'approve',
      'approve-impl',
      'cancel',
      'cancel-impl',
      'merge',
      'deploy',
    ]) {
      expect(isConsultRequest(t)).toBe(false)
    }
  })

  test('empty / whitespace returns false', () => {
    expect(isConsultRequest('')).toBe(false)
    expect(isConsultRequest('    ')).toBe(false)
    expect(isConsultRequest('\n')).toBe(false)
  })

  test('case-insensitive reserved prefix match', () => {
    expect(isConsultRequest('STATUS? today')).toBe(false)
    expect(isConsultRequest('[Codex-Review] pr=x')).toBe(false)
  })

  test('natural-language consult returns true', () => {
    expect(isConsultRequest('birth-kaitori の admin で店頭買取ボタン直したい')).toBe(true)
    expect(isConsultRequest('5 char')).toBe(true)
    expect(isConsultRequest('migration を逆向きにすべきか相談')).toBe(true)
  })

  test('prefix-like but with extra prefix char: still false if matches reserved', () => {
    // `approve ` (= with space) is reserved; `approve foo` is reserved match.
    expect(isConsultRequest('approve foo')).toBe(false)
    // `approver` is not a reserved prefix (= no trailing space) and not bare token → consult
    expect(isConsultRequest('approver wanted')).toBe(true)
  })

  test('non-string returns false (= defensive)', () => {
    expect(isConsultRequest(undefined as unknown as string)).toBe(false)
    expect(isConsultRequest(null as unknown as string)).toBe(false)
  })
})

// ---- analyzeConsultLength ------------------------------------------

describe('analyzeConsultLength', () => {
  test('empty / 1-4 chars → ignore', () => {
    expect(analyzeConsultLength('')).toBe('ignore')
    expect(analyzeConsultLength('a')).toBe('ignore')
    expect(analyzeConsultLength('1234')).toBe('ignore')
    expect(analyzeConsultLength('  abc  ')).toBe('ignore') // 3 after trim
  })

  test('5-14 chars → ambiguous', () => {
    expect(analyzeConsultLength('12345')).toBe('ambiguous')
    expect(analyzeConsultLength('短文 12 char')).toBe('ambiguous')
    expect(analyzeConsultLength('14 char or so')).toBe('ambiguous')
  })

  test('15+ chars → normal', () => {
    expect(analyzeConsultLength('15 chars exactly')).toBe('normal')
    expect(analyzeConsultLength('a'.repeat(100))).toBe('normal')
  })
})

// ---- classifyConsultSourceChannel ----------------------------------

describe('classifyConsultSourceChannel', () => {
  test('D... → dm; C... → project-channel; else → unknown', () => {
    expect(classifyConsultSourceChannel('D0B2GN71MNE')).toBe('dm')
    expect(classifyConsultSourceChannel('C12345')).toBe('project-channel')
    expect(classifyConsultSourceChannel('G999')).toBe('unknown')
    expect(classifyConsultSourceChannel('')).toBe('unknown')
    expect(classifyConsultSourceChannel(undefined as unknown as string)).toBe('unknown')
  })
})

// ---- buildConsultFrontmatter ---------------------------------------

describe('buildConsultFrontmatter', () => {
  const base = {
    requestId: '01HXY01CONSULT0XYZ',
    createdAt: new Date(Date.UTC(2026, 4, 11, 14, 55, 0)),
    sourceChannel: 'D0B2GN71MNE',
    sender: 'hikaru',
    slackMessageId: '1700.456',
    slackThreadTs: '1700.456',
  }

  test('DM source + null risk_guess (normal length)', () => {
    const fm = buildConsultFrontmatter({ ...base, riskGuess: null })
    expect(fm.type).toBe('consult-request')
    expect(fm.request_id).toBe('01HXY01CONSULT0XYZ')
    expect(fm.source_channel).toBe('D0B2GN71MNE')
    expect(fm.source_channel_type).toBe('dm')
    expect(fm.sender).toBe('hikaru')
    expect(fm.slack_message_id).toBe('1700.456')
    expect(fm.slack_thread_ts).toBe('1700.456')
    expect(fm.raw_prefix).toBeNull()
    expect(fm.status).toBe('pending')
    expect(fm.risk_guess).toBeNull()
    expect(fm.codex_plan_ref).toBeNull()
    expect(fm.hikaru_response).toBeNull()
    expect(fm.dispatched_to).toBeNull()
    expect(fm.inferred_intent).toBeNull()
    expect(fm.out_of_scope_inherits).toBe('true')
  })

  test('ambiguous short text marker', () => {
    const fm = buildConsultFrontmatter({ ...base, riskGuess: 'ambiguous' })
    expect(fm.risk_guess).toBe('ambiguous')
  })

  test('C... source → project-channel; G... → unknown', () => {
    const c = buildConsultFrontmatter({ ...base, sourceChannel: 'C123', riskGuess: null })
    expect(c.source_channel_type).toBe('project-channel')
    const g = buildConsultFrontmatter({ ...base, sourceChannel: 'G999', riskGuess: null })
    expect(g.source_channel_type).toBe('unknown')
  })
})

// ---- filename / dir constants --------------------------------------

describe('consultRequestFilename + CONSULT_QUEUE_DIR', () => {
  test('format: <UTC iso-no-colon>-<id>.md', () => {
    const d = new Date(Date.UTC(2026, 4, 11, 14, 55, 0))
    expect(consultRequestFilename(d, '01HXY01CONSULT0XYZ')).toBe(
      '2026-05-11T1455-01HXY01CONSULT0XYZ.md',
    )
  })

  test('CONSULT_QUEUE_DIR is a hardcoded absolute path', () => {
    expect(CONSULT_QUEUE_DIR).toBe(
      '/home/hikaru/projects/hikaru-agent-knowledge/handoff/codex-consult-queue',
    )
  })
})

// ---- listConsultEntries / find helpers -----------------------------

function writeFm(dir: string, name: string, fmLines: string[], body = 'body'): string {
  const path = join(dir, name)
  writeFileSync(path, `---\n${fmLines.join('\n')}\n---\n${body}`)
  return path
}

describe('listConsultEntries / findConsultByThreadTs / findConsultByMessageId', () => {
  test('filters by type=consult-request, finds by thread / message id, prefers newest active', () => {
    const dir = mkdtempSync(join(tmpdir(), 'consult-queue-test-'))
    try {
      writeFm(dir, '2026-05-11T1455-A.md', [
        'type: "consult-request"',
        'request_id: "A"',
        'created_at: "2026-05-11T14:55:00.000Z"',
        'slack_message_id: "11.11"',
        'slack_thread_ts: "T1"',
        'status: "pending"',
      ])
      writeFm(dir, '2026-05-11T1456-B.md', [
        'type: "consult-request"',
        'request_id: "B"',
        'created_at: "2026-05-11T14:56:00.000Z"',
        'slack_message_id: "22.22"',
        'slack_thread_ts: "T2"',
        'status: "planned"',
      ])
      // Newer entry on same thread T1 in planned state — should win for "active"
      writeFm(dir, '2026-05-11T1500-C.md', [
        'type: "consult-request"',
        'request_id: "C"',
        'created_at: "2026-05-11T15:00:00.000Z"',
        'slack_message_id: "33.33"',
        'slack_thread_ts: "T1"',
        'status: "planned"',
      ])
      // unrelated type — must be skipped
      writeFm(dir, '2026-05-11T1457-D.md', ['type: "done"', 'done_id: "D1"', 'status: "complete"'])
      // approved on T2 — wantActiveOnly should still pick the planned B (since approved C2 doesn't exist for T2)
      writeFm(dir, '2026-05-11T1501-E.md', [
        'type: "consult-request"',
        'request_id: "E"',
        'created_at: "2026-05-11T15:01:00.000Z"',
        'slack_message_id: "55.55"',
        'slack_thread_ts: "T3"',
        'status: "approved"',
      ])

      const entries = listConsultEntries(dir)
      expect(entries.map((e) => e.fm.request_id).sort()).toEqual(['A', 'B', 'C', 'E'])

      // Newest by created_at on T1 = C (planned)
      const t1 = findConsultByThreadTs(dir, 'T1', { wantActiveOnly: true })
      expect(t1?.fm.request_id).toBe('C')

      const t2 = findConsultByThreadTs(dir, 'T2', { wantActiveOnly: true })
      expect(t2?.fm.request_id).toBe('B')

      // T3 only has approved → wantActiveOnly=true returns null
      expect(findConsultByThreadTs(dir, 'T3', { wantActiveOnly: true })).toBeNull()
      // wantActiveOnly=false returns it
      expect(findConsultByThreadTs(dir, 'T3', { wantActiveOnly: false })?.fm.request_id).toBe('E')

      // findConsultByMessageId
      expect(findConsultByMessageId(dir, '11.11')?.fm.request_id).toBe('A')
      expect(findConsultByMessageId(dir, '33.33')?.fm.request_id).toBe('C')
      expect(findConsultByMessageId(dir, '99.99')).toBeNull()
      expect(findConsultByMessageId(dir, '')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('listConsultEntries on missing dir returns []', () => {
    expect(listConsultEntries(join(tmpdir(), `no-such-${Date.now()}`))).toEqual([])
  })

  test('isTerminalConsultStatus', () => {
    expect(isTerminalConsultStatus('approved')).toBe(true)
    expect(isTerminalConsultStatus('dispatched')).toBe(true)
    expect(isTerminalConsultStatus('cancelled')).toBe(true)
    expect(isTerminalConsultStatus('pending')).toBe(false)
    expect(isTerminalConsultStatus('planned')).toBe(false)
    expect(isTerminalConsultStatus('blocked')).toBe(false)
    expect(isTerminalConsultStatus(null)).toBe(false)
    expect(isTerminalConsultStatus(undefined)).toBe(false)
  })
})

// ---- continuation log / frontmatter rewrite ------------------------

describe('appendConsultContinuationLog + rewriteConsultFrontmatter', () => {
  test('appends a stamped line; creates header if missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'consult-mut-test-'))
    try {
      const path = writeFm(
        dir,
        'q.md',
        ['type: "consult-request"', 'request_id: "X"', 'status: "pending"'],
        'original body line\n',
      )
      const after = appendConsultContinuationLog(path, {
        text: 'follow-up',
        slackMessageId: '88.88',
        slackTs: '88.88',
      })
      expect(after).toContain('## continuation log')
      expect(after).toContain('88.88')
      expect(after).toContain('follow-up')

      // Second append goes after the existing header
      appendConsultContinuationLog(path, {
        text: 'another',
        slackMessageId: '99.99',
        slackTs: '99.99',
      })
      const finalText = readFileSync(path, 'utf-8')
      // header appears once, two log lines present
      expect((finalText.match(/## continuation log/g) ?? []).length).toBe(1)
      expect(finalText).toContain('88.88')
      expect(finalText).toContain('99.99')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('rewriteConsultFrontmatter preserves body byte-for-byte', () => {
    const dir = mkdtempSync(join(tmpdir(), 'consult-rewrite-test-'))
    try {
      const path = writeFm(
        dir,
        'q.md',
        ['type: "consult-request"', 'request_id: "X"', 'status: "pending"'],
        'body with line\n\n## continuation log\n- 88.88: hi\n',
      )
      const next = rewriteConsultFrontmatter(path, {
        type: 'consult-request',
        request_id: 'X',
        status: 'planned',
        codex_plan_ref: '/home/x/handoff/from-codex/plan-1.md',
      })
      expect(next).toContain('status: "planned"')
      expect(next).toContain('codex_plan_ref: "/home/x/handoff/from-codex/plan-1.md"')
      // Body preserved
      expect(next).toContain('body with line')
      expect(next).toContain('## continuation log')
      expect(next).toContain('- 88.88: hi')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---- parseCodexPlanFile / listReadyCodexPlans ----------------------

describe('parseCodexPlanFile + listReadyCodexPlans', () => {
  test('valid ready plan parses; non-codex-plan / missing fields / not-ready filtered', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plans-test-'))
    try {
      // ready plan ✓
      writeFm(
        dir,
        'plan-1.md',
        [
          'type: "codex-plan"',
          'plan_id: "P1"',
          'related_consult_id: "C1"',
          'slack_chat_id: "D0B2GN71MNE"',
          'slack_thread_ts: "1700.456"',
          'risk_level: "low"',
          'prod_gate: "light"',
          'status: "ready"',
        ],
        '# Plan body\n\n## Files / repo to touch\n- src/foo.ts\n- src/foo.test.ts\n\n## Acceptance criteria\n- A1 X\n- A2 Y\n',
      )
      // acknowledged (not ready) — must be skipped by listReady
      writeFm(
        dir,
        'plan-2.md',
        [
          'type: "codex-plan"',
          'plan_id: "P2"',
          'related_consult_id: "C2"',
          'slack_chat_id: "D0B2GN71MNE"',
          'slack_thread_ts: "1700.999"',
          'status: "acknowledged"',
        ],
        '',
      )
      // missing related_consult_id
      writeFm(
        dir,
        'plan-3.md',
        [
          'type: "codex-plan"',
          'plan_id: "P3"',
          'slack_chat_id: "D0B2GN71MNE"',
          'slack_thread_ts: "1701.000"',
          'status: "ready"',
        ],
        '',
      )
      // outbox draft (no type, has draft_id) — coexists; must be skipped
      writeFm(
        dir,
        'draft-x.md',
        ['draft_id: "DX"', 'created_at: "2026-05-11T14:55:00.000Z"', 'status: "pending"'],
        '',
      )
      // unrelated file
      writeFileSync(join(dir, 'README.txt'), 'just notes')

      const ready = listReadyCodexPlans(dir)
      expect(ready.map((p) => p.plan_id)).toEqual(['P1'])
      const p1 = ready[0]
      expect(p1.related_consult_id).toBe('C1')
      expect(p1.slack_chat_id).toBe('D0B2GN71MNE')
      expect(p1.slack_thread_ts).toBe('1700.456')
      expect(p1.risk_level).toBe('low')
      expect(p1.prod_gate).toBe('light')

      // parseCodexPlanFile direct edge cases
      expect(parseCodexPlanFile('no frontmatter')).toBeNull()
      expect(parseCodexPlanFile('---\ntype: "other"\n---\nbody')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('listReadyCodexPlans on missing dir returns []', () => {
    expect(listReadyCodexPlans(join(tmpdir(), `nope-${Date.now()}`))).toEqual([])
  })
})

// ---- extractMarkdownBullets + formatPlanShortReply -----------------

describe('extractMarkdownBullets + formatPlanShortReply', () => {
  test('extractMarkdownBullets pulls bullets under matching section', () => {
    const body = `# top\n\n## Files / repo to touch\n- src/a.ts\n- src/b.ts\n- src/c.ts\n- src/d.ts\n- src/e.ts\n- src/f.ts\n\n## Acceptance criteria\n- A1\n- A2\n`
    const files = extractMarkdownBullets(body, ['files / repo to touch', 'files to touch'], 5)
    expect(files).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'])
    const accept = extractMarkdownBullets(body, ['acceptance'], 5)
    expect(accept).toEqual(['A1', 'A2'])
  })

  test('formatPlanShortReply builds short Slack text and surfaces redacted names', () => {
    const body = `## Files / repo to touch\n- src/foo.ts\n- src/bar.ts\n\n## Acceptance criteria\n- A1\n- A2\n`
    const plan = {
      path: '/x/plan.md',
      plan_id: 'P1',
      related_consult_id: 'C1',
      slack_chat_id: 'D0B2GN71MNE',
      slack_thread_ts: '1700.456',
      risk_level: 'low',
      prod_gate: 'light',
      status: 'ready',
      body,
      fm: {},
    }
    const stub = (text: string) => ({ body: text, redactedNames: [] })
    const r = formatPlanShortReply({ plan, consultId: 'C1', sanitize: stub })
    expect(r.text).toContain('📋 Plan ready (id: P1)')
    expect(r.text).toContain('risk: low')
    expect(r.text).toContain('gate: light')
    expect(r.text).toContain('src/foo.ts')
    expect(r.text).toContain('A1')
    expect(r.text).toContain('approve C1')
    expect(r.text).toContain('abort C1')
    expect(r.text).toContain('handoff/from-codex/P1.md')
    expect(r.redactedNames).toEqual([])
  })

  test('sanitizer surfacing redacted names propagates to ⚠ line', () => {
    const body = `## Files\n- has token Bearer abcdefghij1234567890\n\n## Acceptance\n- ok\n`
    const plan = {
      path: '/x/plan.md',
      plan_id: 'P2',
      related_consult_id: 'C2',
      slack_chat_id: 'D0B2GN71MNE',
      slack_thread_ts: '1700.456',
      risk_level: null,
      prod_gate: null,
      status: 'ready',
      body,
      fm: {},
    }
    let calls = 0
    const sanitize = (text: string) => {
      calls++
      if (text.includes('Bearer')) return { body: '[REDACTED:bearer]', redactedNames: ['bearer'] }
      return { body: text, redactedNames: [] }
    }
    const r = formatPlanShortReply({ plan, consultId: 'C2', sanitize })
    expect(r.text).toContain('[REDACTED:bearer]')
    expect(r.text).toContain('⚠ plan 本文に token-like 検出 (bearer)、sanitize 済')
    expect(r.redactedNames).toEqual(['bearer'])
    expect(calls).toBeGreaterThan(0)
  })

  test('format falls back to "unspecified" when risk_level / prod_gate are null', () => {
    const plan = {
      path: '/x/plan.md',
      plan_id: 'P3',
      related_consult_id: 'C3',
      slack_chat_id: 'D0B2GN71MNE',
      slack_thread_ts: '1700.456',
      risk_level: null,
      prod_gate: null,
      status: 'ready',
      body: '',
      fm: {},
    }
    const stub = (text: string) => ({ body: text, redactedNames: [] })
    const r = formatPlanShortReply({ plan, consultId: 'C3', sanitize: stub })
    expect(r.text).toContain('risk: unspecified')
    expect(r.text).toContain('gate: unspecified')
    expect(r.text).toContain('(none listed)')
  })
})

// ---- parseHikaruConsultReply ---------------------------------------

describe('parseHikaruConsultReply', () => {
  const id = '01HXY01CONSULT0XYZ'

  test('imperative `approve <id>` exact match → approve', () => {
    expect(parseHikaruConsultReply(`approve ${id}`, id)).toEqual({ kind: 'approve' })
    expect(parseHikaruConsultReply(`APPROVE ${id}`, id)).toEqual({ kind: 'approve' })
  })

  test('approve with wrong id → mismatch with suppliedId', () => {
    expect(parseHikaruConsultReply('approve OTHER', id)).toEqual({
      kind: 'mismatch',
      suppliedId: 'OTHER',
    })
  })

  test('abort variants', () => {
    expect(parseHikaruConsultReply(`abort ${id}`, id)).toEqual({ kind: 'abort' })
    expect(parseHikaruConsultReply(`ABORT ${id}`, id)).toEqual({ kind: 'abort' })
    expect(parseHikaruConsultReply('abort WRONG', id)).toEqual({
      kind: 'mismatch',
      suppliedId: 'WRONG',
    })
    expect(parseHikaruConsultReply('やめて', id)).toEqual({ kind: 'abort' })
    expect(parseHikaruConsultReply('中止', id)).toEqual({ kind: 'abort' })
    expect(parseHikaruConsultReply('cancel', id)).toEqual({ kind: 'abort' })
  })

  test('imperative natural-language Japanese → approve', () => {
    expect(parseHikaruConsultReply('進めて', id)).toEqual({ kind: 'approve' })
    expect(parseHikaruConsultReply('進めてください', id)).toEqual({ kind: 'approve' })
    expect(parseHikaruConsultReply('OK 進めて', id)).toEqual({ kind: 'approve' })
    expect(parseHikaruConsultReply('やる', id)).toEqual({ kind: 'approve' })
    expect(parseHikaruConsultReply('やってください', id)).toEqual({ kind: 'approve' })
    expect(parseHikaruConsultReply('実行して', id)).toEqual({ kind: 'approve' })
  })

  test('permissive bare/`OK` / 任せる → permissive (NO status change)', () => {
    expect(parseHikaruConsultReply('OK', id)).toEqual({ kind: 'permissive' })
    expect(parseHikaruConsultReply('ok', id)).toEqual({ kind: 'permissive' })
    expect(parseHikaruConsultReply('approve', id)).toEqual({ kind: 'permissive' })
    expect(parseHikaruConsultReply('approve してよい', id)).toEqual({ kind: 'permissive' })
    expect(parseHikaruConsultReply('任せる', id)).toEqual({ kind: 'permissive' })
    expect(parseHikaruConsultReply('していいよ', id)).toEqual({ kind: 'permissive' })
  })

  test('long free-form text → edit (with original text)', () => {
    const text = '思ったより複雑なので、まず A だけ実装して B は別 PR に分けたい'
    expect(parseHikaruConsultReply(text, id)).toEqual({ kind: 'edit', text })
  })

  test('empty / very short fragment → none', () => {
    expect(parseHikaruConsultReply('', id)).toEqual({ kind: 'none' })
    expect(parseHikaruConsultReply('  ', id)).toEqual({ kind: 'none' })
    expect(parseHikaruConsultReply('ね', id)).toEqual({ kind: 'none' })
    expect(parseHikaruConsultReply('はい', id)).toEqual({ kind: 'none' })
  })
})

// ---- formatConsultAckReply -----------------------------------------

describe('formatConsultAckReply', () => {
  test('minimal: id + status only', () => {
    const r = formatConsultAckReply({
      requestId: 'C1',
      riskGuess: null,
      sourceChannelType: 'dm',
      redactedNames: [],
    })
    expect(r).toContain('📥 consult 受領、Codex の plan 起草を待ちます')
    expect(r).toContain('id: C1')
    expect(r).toContain('status: pending')
    expect(r).not.toContain('ambiguous')
    expect(r).not.toContain('不明')
    expect(r).not.toContain('sanitize')
  })

  test('ambiguous + unknown source + redacted → extra warning lines', () => {
    const r = formatConsultAckReply({
      requestId: 'C1',
      riskGuess: 'ambiguous',
      sourceChannelType: 'unknown',
      redactedNames: ['bearer', 'xoxb'],
    })
    expect(r).toContain('ambiguous')
    expect(r).toContain('不明')
    expect(r).toContain('bearer,xoxb')
  })
})
