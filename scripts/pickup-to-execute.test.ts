import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_WAIT_POLL_MS,
  MAX_WAIT_POLL_MS,
  MIN_WAIT_POLL_MS,
  parseWaitOptions,
} from './pickup-to-execute'

describe('parseWaitOptions', () => {
  test('uses safe defaults', () => {
    expect(parseWaitOptions([])).toEqual({
      pollMs: DEFAULT_WAIT_POLL_MS,
      timeoutMs: null,
    })
  })

  test('accepts separated and equals forms', () => {
    expect(parseWaitOptions(['--poll-ms', '1000', '--timeout-ms=2500'])).toEqual({
      pollMs: 1000,
      timeoutMs: 2500,
    })
    expect(parseWaitOptions(['--poll-ms=60000', '--timeout-ms', '0'])).toEqual({
      pollMs: 60000,
      timeoutMs: 0,
    })
  })

  test('rejects unknown options', () => {
    expect(() => parseWaitOptions(['--forever'])).toThrow('unknown wait option')
  })

  test('rejects invalid poll intervals', () => {
    expect(() => parseWaitOptions(['--poll-ms', String(MIN_WAIT_POLL_MS - 1)])).toThrow(
      'between',
    )
    expect(() => parseWaitOptions(['--poll-ms', String(MAX_WAIT_POLL_MS + 1)])).toThrow(
      'between',
    )
    expect(() => parseWaitOptions(['--poll-ms', 'nan'])).toThrow('integer')
  })

  test('rejects invalid timeouts', () => {
    expect(() => parseWaitOptions(['--timeout-ms', '-1'])).toThrow('0 or greater')
    expect(() => parseWaitOptions(['--timeout-ms'])).toThrow('requires')
    expect(() => parseWaitOptions(['--timeout-ms', '1.5'])).toThrow('integer')
  })
})
