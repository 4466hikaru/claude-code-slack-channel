import { describe, expect, test } from 'bun:test'
import {
  TRIGGERS,
  clampPollInterval,
  detectTrigger,
  routeTrigger,
} from './inbound-watcher'

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

  test('order: [abort cleanup] beats [abort] (longer prefix wins)', () => {
    // If TRIGGERS were ordered with [abort] first, "[abort cleanup]"
    // would match [abort] and the cleanup handler would never run.
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

describe('TRIGGERS array order', () => {
  test('[abort cleanup] is listed before [abort] (so detectTrigger picks the longer prefix)', () => {
    const i = TRIGGERS.indexOf('[abort cleanup]')
    const j = TRIGGERS.indexOf('[abort]')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(j).toBeGreaterThanOrEqual(0)
    expect(i).toBeLessThan(j)
  })
})

describe('routeTrigger (pins [abort] vs [abort cleanup] semantics)', () => {
  // Codex review against PR #2 v1: [abort] was aliased to [abort cleanup]
  // and ran rm -f on the flag. That is dangerous as a "raise the abort
  // flag" command. These tests pin the corrected semantics.
  test('[abort] -> abort-create (touches/raises the flag, NOT cleanup)', () => {
    expect(routeTrigger('[abort]')).toBe('abort-create')
    expect(routeTrigger('[abort]')).not.toBe('abort-cleanup')
  })

  test('[abort cleanup] -> abort-cleanup (rm -f the flag, NOT create)', () => {
    expect(routeTrigger('[abort cleanup]')).toBe('abort-cleanup')
    expect(routeTrigger('[abort cleanup]')).not.toBe('abort-create')
  })

  test('[abort-test] -> abort-test (touch + verify + rm cycle)', () => {
    expect(routeTrigger('[abort-test]')).toBe('abort-test')
  })

  test('status? -> status', () => {
    expect(routeTrigger('status?')).toBe('status')
  })

  test('prs? -> prs', () => {
    expect(routeTrigger('prs?')).toBe('prs')
  })
})

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
