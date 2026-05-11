import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ACTIVE_THREAD_TTL_MS,
  type ActiveThreadMap,
  loadActiveThreads,
  pruneStaleThreads,
  recordReply,
  saveActiveThreads,
  shouldProcessThreadMessage,
  updateLastSeen,
} from './thread-tracker'

// --- recordReply / updateLastSeen ------------------------------------

describe('recordReply', () => {
  test('adds a new entry with cursor seeded to threadTs', () => {
    const map: ActiveThreadMap = new Map()
    const t = 1_000_000
    recordReply(map, '1.1', t)
    const entry = map.get('1.1')
    expect(entry).not.toBeUndefined()
    if (!entry) return
    expect(entry.lastSeenTs).toBe('1.1')
    expect(entry.expiresAt).toBe(t + ACTIVE_THREAD_TTL_MS)
  })

  test('refreshes TTL on existing entry, preserves cursor', () => {
    const map: ActiveThreadMap = new Map()
    recordReply(map, '1.1', 1_000_000)
    updateLastSeen(map, '1.1', '1.5')
    recordReply(map, '1.1', 2_000_000)
    const entry = map.get('1.1')
    if (!entry) throw new Error('missing entry')
    expect(entry.lastSeenTs).toBe('1.5') // cursor preserved
    expect(entry.expiresAt).toBe(2_000_000 + ACTIVE_THREAD_TTL_MS) // TTL refreshed
  })

  test('custom ttlMs override', () => {
    const map: ActiveThreadMap = new Map()
    recordReply(map, '1.1', 1_000_000, 5_000)
    expect(map.get('1.1')?.expiresAt).toBe(1_005_000)
  })
})

describe('updateLastSeen', () => {
  test('advances cursor on tracked thread', () => {
    const map: ActiveThreadMap = new Map()
    recordReply(map, '1.1', 0)
    updateLastSeen(map, '1.1', '1.2')
    expect(map.get('1.1')?.lastSeenTs).toBe('1.2')
  })

  test('no-op when thread is not tracked (e.g. pruned)', () => {
    const map: ActiveThreadMap = new Map()
    updateLastSeen(map, '1.1', '1.2')
    expect(map.size).toBe(0)
  })
})

// --- pruneStaleThreads ------------------------------------------------

describe('pruneStaleThreads', () => {
  test('removes entries whose expiresAt is <= now', () => {
    const map: ActiveThreadMap = new Map()
    map.set('fresh', { lastSeenTs: 'fresh', expiresAt: 2_000 })
    map.set('stale', { lastSeenTs: 'stale', expiresAt: 1_000 })
    map.set('exact', { lastSeenTs: 'exact', expiresAt: 1_500 })
    const removed = pruneStaleThreads(map, 1_500)
    expect(removed.sort()).toEqual(['exact', 'stale'])
    expect(Array.from(map.keys())).toEqual(['fresh'])
  })

  test('no-op on empty map', () => {
    const map: ActiveThreadMap = new Map()
    expect(pruneStaleThreads(map, Date.now())).toEqual([])
  })
})

// --- shouldProcessThreadMessage --------------------------------------

describe('shouldProcessThreadMessage', () => {
  test('rejects messages without text or ts', () => {
    expect(shouldProcessThreadMessage({ ts: '1.5' }, '1.1', '1.1')).toBe(false)
    expect(shouldProcessThreadMessage({ text: 'OK' }, '1.1', '1.1')).toBe(false)
    expect(
      shouldProcessThreadMessage(
        // biome-ignore lint/suspicious/noExplicitAny: synthetic edge for negative test
        { text: 'OK', ts: 5 as unknown as string },
        '1.1',
        '1.1',
      ),
    ).toBe(false)
  })

  test('rejects the thread root', () => {
    expect(shouldProcessThreadMessage({ ts: '1.1', text: 'OK' }, '1.1', '1.1')).toBe(false)
  })

  test('rejects ts older than or equal to cursor', () => {
    expect(shouldProcessThreadMessage({ ts: '1.0', text: 'OK' }, '1.1', '1.5')).toBe(false)
    expect(shouldProcessThreadMessage({ ts: '1.5', text: 'OK' }, '1.1', '1.5')).toBe(false)
  })

  test('accepts newer-than-cursor non-root messages', () => {
    expect(shouldProcessThreadMessage({ ts: '1.6', text: 'OK' }, '1.1', '1.5')).toBe(true)
  })
})

// --- load / save round-trip ------------------------------------------

describe('loadActiveThreads / saveActiveThreads', () => {
  test('round-trip preserves entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thread-tracker-'))
    try {
      const path = join(dir, 'state.json')
      const map: ActiveThreadMap = new Map()
      map.set('1.1', { lastSeenTs: '1.5', expiresAt: 999_999 })
      map.set('2.2', { lastSeenTs: '2.7', expiresAt: 1_999_999 })
      saveActiveThreads(path, map)
      const loaded = loadActiveThreads(path)
      expect(loaded.size).toBe(2)
      expect(loaded.get('1.1')).toEqual({
        lastSeenTs: '1.5',
        expiresAt: 999_999,
      })
      expect(loaded.get('2.2')).toEqual({
        lastSeenTs: '2.7',
        expiresAt: 1_999_999,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('missing file -> empty map', () => {
    expect(loadActiveThreads(join(tmpdir(), `no-such-${Date.now()}.json`)).size).toBe(0)
  })

  test('corrupt JSON -> empty map (= watcher resilient)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thread-tracker-'))
    try {
      const path = join(dir, 'state.json')
      writeFileSync(path, 'not json at all')
      const loaded = loadActiveThreads(path)
      expect(loaded.size).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('malformed entry shape filtered out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thread-tracker-'))
    try {
      const path = join(dir, 'state.json')
      writeFileSync(
        path,
        JSON.stringify({
          good: { lastSeenTs: '1.5', expiresAt: 100 },
          missingTs: { expiresAt: 100 },
          missingExpiry: { lastSeenTs: '2.0' },
          stringExpiry: { lastSeenTs: '3.0', expiresAt: 'soon' },
        }),
      )
      const loaded = loadActiveThreads(path)
      expect(loaded.size).toBe(1)
      expect(loaded.has('good')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
