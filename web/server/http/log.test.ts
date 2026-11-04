import { describe, it, expect, vi } from 'vitest'
import { redactForLog, writeRequestLog, type RequestLogEntry } from './log'

const entry: RequestLogEntry = {
  event: 'api_request',
  requestId: 'r',
  route: '/x',
  method: 'GET',
  actor: 'staff:1',
  status: 200,
  durationMs: 5,
  errorCode: null,
}

describe('redactForLog', () => {
  it('takes out emails, tokens and card-length numbers', () => {
    const text =
      'failed for sam.jones@example.co.uk with Bearer abc123 and eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl card 4242 4242 4242 4242'
    const redacted = redactForLog(text)

    expect(redacted).not.toContain('sam.jones')
    expect(redacted).not.toContain('abc123')
    expect(redacted).not.toContain('eyJhbGciOi')
    expect(redacted).not.toContain('4242')
  })

  it('leaves ordinary error text, and cuts very long text', () => {
    expect(redactForLog('duplicate key value violates unique constraint "a_b_key"')).toContain('a_b_key')
    expect(redactForLog('x'.repeat(2000)).length).toBe(500)
  })
})

describe('writeRequestLog', () => {
  it('writes one JSON line, to the error stream for server failures', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    writeRequestLog(entry)
    writeRequestLog({ ...entry, status: 500 })

    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toEqual(entry)
    expect(error).toHaveBeenCalledTimes(1)
    log.mockRestore()
    error.mockRestore()
  })
})
