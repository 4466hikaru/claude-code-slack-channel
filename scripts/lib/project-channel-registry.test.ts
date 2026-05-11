import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadActiveProjectChannels } from './project-channel-registry'

// --- helpers ----------------------------------------------------------

interface FmFixture {
  type?: string | null
  request_id?: string
  project_channel_id?: string | null
  project_channel_name?: string | null
  project_channel_status?: string | null
  created_at?: string
  extras?: Record<string, string | null>
}

/** Write a queue file with the given frontmatter into `dir`. */
function writeQueueFile(dir: string, name: string, fm: FmFixture, body = 'body'): string {
  const lines: string[] = []
  const push = (k: string, v: string | number | null | undefined) => {
    if (v === undefined) return
    if (v === null) {
      lines.push(`${k}: null`)
    } else if (typeof v === 'number') {
      lines.push(`${k}: ${v}`)
    } else {
      lines.push(`${k}: "${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    }
  }
  push('type', fm.type === undefined ? 'project-request' : fm.type)
  if (fm.request_id !== undefined) push('request_id', fm.request_id)
  if (fm.project_channel_id !== undefined) push('project_channel_id', fm.project_channel_id)
  if (fm.project_channel_name !== undefined) push('project_channel_name', fm.project_channel_name)
  if (fm.project_channel_status !== undefined) {
    push('project_channel_status', fm.project_channel_status)
  }
  if (fm.created_at !== undefined) push('created_at', fm.created_at)
  if (fm.extras) {
    for (const [k, v] of Object.entries(fm.extras)) push(k, v)
  }
  const path = join(dir, name)
  writeFileSync(path, `---\n${lines.join('\n')}\n---\n${body}`)
  return path
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'project-channel-registry-test-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- A1: normal cases ------------------------------------------------

describe('loadActiveProjectChannels (A1: normal cases)', () => {
  test('single active queue → 1 entry, fields populated', () => {
    withTempDir((dir) => {
      const path = writeQueueFile(dir, '2026-05-10T0900-A.md', {
        request_id: 'reqA',
        project_channel_id: 'C0000000001',
        project_channel_name: 'proj-tracaverse',
        project_channel_status: 'active',
        created_at: '2026-05-10T09:00:00.000Z',
      })
      const r = loadActiveProjectChannels(dir)
      expect(r.total_files).toBe(1)
      expect(r.malformed_count).toBe(0)
      expect(r.duplicate_skip_count).toBe(0)
      expect(r.active).toHaveLength(1)
      const e = r.active[0]
      expect(e.request_id).toBe('reqA')
      expect(e.project_channel_id).toBe('C0000000001')
      expect(e.project_channel_name).toBe('proj-tracaverse')
      expect(e.project_channel_status).toBe('active')
      expect(e.created_at).toBe('2026-05-10T09:00:00.000Z')
      expect(e.source_path).toBe(path)
    })
  })

  test('multiple active queues → all listed, sorted by created_at asc', () => {
    withTempDir((dir) => {
      writeQueueFile(dir, '2026-05-10T0900-A.md', {
        request_id: 'reqA',
        project_channel_id: 'C0000000001',
        created_at: '2026-05-10T09:00:00.000Z',
      })
      writeQueueFile(dir, '2026-05-10T0700-B.md', {
        request_id: 'reqB',
        project_channel_id: 'C0000000002',
        created_at: '2026-05-10T07:00:00.000Z',
      })
      writeQueueFile(dir, '2026-05-10T0800-C.md', {
        request_id: 'reqC',
        project_channel_id: 'C0000000003',
        created_at: '2026-05-10T08:00:00.000Z',
      })
      const r = loadActiveProjectChannels(dir)
      expect(r.total_files).toBe(3)
      expect(r.malformed_count).toBe(0)
      expect(r.duplicate_skip_count).toBe(0)
      expect(r.active.map((e) => e.request_id)).toEqual(['reqB', 'reqC', 'reqA'])
    })
  })

  test('null project_channel_id → excluded, NOT malformed', () => {
    withTempDir((dir) => {
      writeQueueFile(dir, '2026-05-10T0900-X.md', {
        request_id: 'reqX',
        project_channel_id: null,
        created_at: '2026-05-10T09:00:00.000Z',
      })
      const r = loadActiveProjectChannels(dir)
      expect(r.total_files).toBe(1)
      expect(r.malformed_count).toBe(0)
      expect(r.active).toEqual([])
    })
  })

  test('empty-string project_channel_id → excluded, NOT malformed', () => {
    withTempDir((dir) => {
      writeQueueFile(dir, '2026-05-10T0900-X.md', {
        request_id: 'reqX',
        project_channel_id: '',
        created_at: '2026-05-10T09:00:00.000Z',
      })
      const r = loadActiveProjectChannels(dir)
      expect(r.malformed_count).toBe(0)
      expect(r.active).toEqual([])
    })
  })

  test('missing project_channel_id field (old Phase 0 schema) → excluded, NOT malformed', () => {
    withTempDir((dir) => {
      // No project_channel_id field at all = backward-compat with pre-ccsc-l34 schema.
      writeQueueFile(dir, '2026-05-10T0900-X.md', {
        request_id: 'reqX',
        created_at: '2026-05-10T09:00:00.000Z',
      })
      const r = loadActiveProjectChannels(dir)
      expect(r.total_files).toBe(1)
      expect(r.malformed_count).toBe(0)
      expect(r.active).toEqual([])
    })
  })

  test('non-C-prefixed project_channel_id (`D012345`, etc.) → malformed', () => {
    withTempDir((dir) => {
      writeQueueFile(dir, '2026-05-10T0900-D.md', {
        request_id: 'reqD',
        project_channel_id: 'D012345',
        created_at: '2026-05-10T09:00:00.000Z',
      })
      writeQueueFile(dir, '2026-05-10T0900-G.md', {
        request_id: 'reqG',
        project_channel_id: 'G999',
        created_at: '2026-05-10T09:00:00.000Z',
      })
      const r = loadActiveProjectChannels(dir)
      expect(r.total_files).toBe(2)
      expect(r.malformed_count).toBe(2)
      expect(r.active).toEqual([])
    })
  })
})

// --- A2: status filter -----------------------------------------------

describe('loadActiveProjectChannels (A2: status filter)', () => {
  function setupStatus(dir: string, status: string | null | undefined) {
    return writeQueueFile(dir, `q-${status ?? 'null'}.md`, {
      request_id: `req-${status ?? 'null'}`,
      project_channel_id: 'C0000000001',
      project_channel_status: status === undefined ? undefined : status,
      created_at: '2026-05-10T09:00:00.000Z',
    })
  }

  test('archived → excluded', () => {
    withTempDir((dir) => {
      setupStatus(dir, 'archived')
      const r = loadActiveProjectChannels(dir)
      expect(r.active).toEqual([])
      expect(r.malformed_count).toBe(0)
    })
  })

  test('cancelled → excluded', () => {
    withTempDir((dir) => {
      setupStatus(dir, 'cancelled')
      const r = loadActiveProjectChannels(dir)
      expect(r.active).toEqual([])
    })
  })

  test('failed → excluded (= trial failed, no live channel)', () => {
    withTempDir((dir) => {
      setupStatus(dir, 'failed')
      const r = loadActiveProjectChannels(dir)
      expect(r.active).toEqual([])
    })
  })

  test('pending → included (A3 rule: id-filled means pollable)', () => {
    withTempDir((dir) => {
      setupStatus(dir, 'pending')
      const r = loadActiveProjectChannels(dir)
      expect(r.active).toHaveLength(1)
      expect(r.active[0].project_channel_status).toBe('pending')
    })
  })

  test('active → included', () => {
    withTempDir((dir) => {
      setupStatus(dir, 'active')
      const r = loadActiveProjectChannels(dir)
      expect(r.active).toHaveLength(1)
      expect(r.active[0].project_channel_status).toBe('active')
    })
  })

  test('null status → included (backward compat)', () => {
    withTempDir((dir) => {
      setupStatus(dir, null)
      const r = loadActiveProjectChannels(dir)
      expect(r.active).toHaveLength(1)
      expect(r.active[0].project_channel_status).toBeNull()
    })
  })

  test('missing status field → included (backward compat)', () => {
    withTempDir((dir) => {
      setupStatus(dir, undefined)
      const r = loadActiveProjectChannels(dir)
      expect(r.active).toHaveLength(1)
      expect(r.active[0].project_channel_status).toBeNull()
    })
  })
})

// --- A3: duplicate -----------------------------------------------------

describe('loadActiveProjectChannels (A3: duplicate channel id)', () => {
  test('duplicate id, distinct created_at → newest wins, others count as duplicate_skip', () => {
    withTempDir((dir) => {
      writeQueueFile(dir, 'a.md', {
        request_id: 'older',
        project_channel_id: 'C0000000001',
        project_channel_name: 'proj-old',
        created_at: '2026-05-09T09:00:00.000Z',
      })
      writeQueueFile(dir, 'b.md', {
        request_id: 'newer',
        project_channel_id: 'C0000000001',
        project_channel_name: 'proj-new',
        created_at: '2026-05-10T09:00:00.000Z',
      })
      writeQueueFile(dir, 'c.md', {
        request_id: 'between',
        project_channel_id: 'C0000000001',
        project_channel_name: 'proj-mid',
        created_at: '2026-05-09T17:00:00.000Z',
      })
      const r = loadActiveProjectChannels(dir)
      expect(r.total_files).toBe(3)
      expect(r.malformed_count).toBe(0)
      expect(r.duplicate_skip_count).toBe(2)
      expect(r.active).toHaveLength(1)
      expect(r.active[0].request_id).toBe('newer')
      expect(r.active[0].project_channel_name).toBe('proj-new')
    })
  })

  test('duplicate id, no created_at → last file in iteration wins, others duplicate_skip', () => {
    withTempDir((dir) => {
      writeQueueFile(dir, 'aaa.md', {
        request_id: 'first',
        project_channel_id: 'C0000000001',
      })
      writeQueueFile(dir, 'bbb.md', {
        request_id: 'second',
        project_channel_id: 'C0000000001',
      })
      const r = loadActiveProjectChannels(dir)
      expect(r.duplicate_skip_count).toBe(1)
      expect(r.active).toHaveLength(1)
      // last file in readdirSync alphabetical order wins → 'bbb.md' = 'second'
      expect(r.active[0].request_id).toBe('second')
    })
  })

  test('two distinct channel ids → no duplicate skip even when filenames are similar', () => {
    withTempDir((dir) => {
      writeQueueFile(dir, 'a.md', {
        request_id: 'reqA',
        project_channel_id: 'C0000000001',
        created_at: '2026-05-10T09:00:00.000Z',
      })
      writeQueueFile(dir, 'b.md', {
        request_id: 'reqB',
        project_channel_id: 'C0000000002',
        created_at: '2026-05-10T09:00:00.000Z',
      })
      const r = loadActiveProjectChannels(dir)
      expect(r.duplicate_skip_count).toBe(0)
      expect(r.active).toHaveLength(2)
    })
  })
})

// --- A4: malformed ----------------------------------------------------

describe('loadActiveProjectChannels (A4: malformed)', () => {
  test('YAML frontmatter parse error → malformed, skipped', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, 'bad.md'), '---\nthis is: not valid: yaml: at all\n---\nbody')
      // The light parser tolerates one `:` per line. A truly broken
      // file is one without the `---` opener/closer — write that.
      writeFileSync(join(dir, 'bad2.md'), 'no frontmatter here at all')
      const r = loadActiveProjectChannels(dir)
      // bad.md parses (the parser is permissive) but has no
      // project_channel_id → not active, not malformed.
      // bad2.md fails parseFrontmatterFile → malformed.
      expect(r.total_files).toBe(2)
      expect(r.malformed_count).toBe(1)
      expect(r.active).toEqual([])
    })
  })

  test('frontmatter delimiter missing → malformed', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, 'x.md'), 'just body, no frontmatter')
      const r = loadActiveProjectChannels(dir)
      expect(r.malformed_count).toBe(1)
      expect(r.active).toEqual([])
    })
  })

  test('type != project-request → skipped silently (not malformed, not active)', () => {
    withTempDir((dir) => {
      writeQueueFile(dir, 'other.md', {
        type: 'done',
        project_channel_id: 'C0000000999',
        created_at: '2026-05-10T09:00:00.000Z',
        extras: { done_id: 'X' },
      })
      const r = loadActiveProjectChannels(dir)
      expect(r.total_files).toBe(1)
      expect(r.malformed_count).toBe(0)
      expect(r.active).toEqual([])
    })
  })

  test('missing required project_channel_id (= old Phase 0 schema) → not active, not malformed', () => {
    withTempDir((dir) => {
      writeQueueFile(dir, 'old.md', {
        request_id: 'old',
        created_at: '2026-05-10T09:00:00.000Z',
      })
      const r = loadActiveProjectChannels(dir)
      expect(r.malformed_count).toBe(0)
      expect(r.active).toEqual([])
    })
  })
})

// --- A5: environment / boundary ---------------------------------------

describe('loadActiveProjectChannels (A5: environment)', () => {
  test('non-existent dir → empty result, no throw', () => {
    const r = loadActiveProjectChannels(join(tmpdir(), `no-such-dir-${Date.now()}`))
    expect(r.total_files).toBe(0)
    expect(r.malformed_count).toBe(0)
    expect(r.duplicate_skip_count).toBe(0)
    expect(r.active).toEqual([])
  })

  test('empty dir → empty result', () => {
    withTempDir((dir) => {
      const r = loadActiveProjectChannels(dir)
      expect(r.total_files).toBe(0)
      expect(r.active).toEqual([])
    })
  })

  test('dir with only non-.md files → empty result, no malformed count', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, 'README.txt'), 'not a queue')
      writeFileSync(join(dir, '.gitkeep'), '')
      const r = loadActiveProjectChannels(dir)
      expect(r.total_files).toBe(0)
      expect(r.malformed_count).toBe(0)
      expect(r.active).toEqual([])
    })
  })

  test('all malformed → active=[], malformed_count>0, no throw', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, 'a.md'), 'no frontmatter')
      writeFileSync(join(dir, 'b.md'), 'still no frontmatter')
      const r = loadActiveProjectChannels(dir)
      expect(r.total_files).toBe(2)
      expect(r.malformed_count).toBe(2)
      expect(r.active).toEqual([])
    })
  })
})

// --- A6: mixed realistic scenario ------------------------------------

describe('loadActiveProjectChannels (A6: mixed scenario)', () => {
  test('realistic mix: active + pending + archived + null-id + malformed + duplicate', () => {
    withTempDir((dir) => {
      writeQueueFile(dir, 'q1.md', {
        request_id: 'r1',
        project_channel_id: 'C001',
        project_channel_name: 'proj-one',
        project_channel_status: 'active',
        created_at: '2026-05-10T01:00:00.000Z',
      })
      writeQueueFile(dir, 'q2.md', {
        request_id: 'r2',
        project_channel_id: 'C002',
        project_channel_status: 'pending',
        created_at: '2026-05-10T02:00:00.000Z',
      })
      writeQueueFile(dir, 'q3-archived.md', {
        request_id: 'r3',
        project_channel_id: 'C003',
        project_channel_status: 'archived',
        created_at: '2026-05-10T03:00:00.000Z',
      })
      writeQueueFile(dir, 'q4-no-id.md', {
        request_id: 'r4',
        project_channel_id: null,
        created_at: '2026-05-10T04:00:00.000Z',
      })
      writeQueueFile(dir, 'q5-bad-id.md', {
        request_id: 'r5',
        project_channel_id: 'D012345',
        created_at: '2026-05-10T05:00:00.000Z',
      })
      writeFileSync(join(dir, 'q6-broken.md'), 'no frontmatter')
      writeQueueFile(dir, 'q7-dup-newer.md', {
        request_id: 'r7',
        project_channel_id: 'C001',
        project_channel_name: 'proj-one-renamed',
        created_at: '2026-05-10T07:00:00.000Z',
      })

      const r = loadActiveProjectChannels(dir)
      expect(r.total_files).toBe(7)
      // malformed: q5 (bad id) + q6 (no frontmatter) = 2
      expect(r.malformed_count).toBe(2)
      // duplicate: q1 (older) loses to q7 (newer) on C001 → +1
      expect(r.duplicate_skip_count).toBe(1)
      // active: r7 (C001) + r2 (C002). Ordered by created_at asc.
      expect(r.active.map((e) => e.request_id)).toEqual(['r2', 'r7'])
      expect(r.active.find((e) => e.project_channel_id === 'C001')?.project_channel_name).toBe(
        'proj-one-renamed',
      )
    })
  })
})
