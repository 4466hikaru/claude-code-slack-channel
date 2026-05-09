import { describe, expect, test } from 'bun:test'
import { detectTrigger } from './inbound-watcher'

describe('detectTrigger', () => {
  test('exact prefix match for each trigger', () => {
    expect(detectTrigger('[abort-test]')).toBe('[abort-test]')
    expect(detectTrigger('[abort]')).toBe('[abort]')
    expect(detectTrigger('[abort cleanup]')).toBe('[abort cleanup]')
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

  test('order: [abort cleanup] beats [abort]', () => {
    // If TRIGGERS were ordered with [abort] first, "[abort cleanup]"
    // would match [abort] and the cleanup handler would never run.
    // Pin the order invariant here.
    expect(detectTrigger('[abort cleanup]')).toBe('[abort cleanup]')
    expect(detectTrigger('[abort cleanup] foo')).toBe('[abort cleanup]')
  })

  test('non-trigger or mid-string occurrences return null', () => {
    expect(detectTrigger('hello')).toBeNull()
    expect(detectTrigger('the [abort-test] in the middle')).toBeNull()
    expect(detectTrigger('')).toBeNull()
    expect(detectTrigger('   ')).toBeNull()
    expect(detectTrigger('Status?')).toBeNull() // case-sensitive
  })
})
