import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { ERROR_CODES } from '@/contracts'
import { DbTimeoutError } from '@/server/db'
import { ApiError, ERROR_HTTP_STATUS, INTERNAL_MESSAGE, toApiError, validationError } from './errors'

describe('error codes', () => {
  it('every code maps to an error status', () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400)
    }
  })

  it('maps the main codes to the expected statuses', () => {
    expect(new ApiError('VALIDATION', 'x').status).toBe(400)
    expect(new ApiError('UNAUTHORISED', 'x').status).toBe(401)
    expect(new ApiError('PAYMENT_FAILED', 'x').status).toBe(402)
    expect(new ApiError('FORBIDDEN', 'x').status).toBe(403)
    expect(new ApiError('NOT_FOUND', 'x').status).toBe(404)
    expect(new ApiError('CONFLICT', 'x').status).toBe(409)
    expect(new ApiError('RATE_LIMITED', 'x').status).toBe(429)
    expect(new ApiError('INTERNAL', 'x').status).toBe(500)
  })
})

describe('toApiError', () => {
  it('leaves an ApiError alone', () => {
    const err = new ApiError('NOT_FOUND', 'Booking not found.')
    expect(toApiError(err)).toBe(err)
  })

  it('gives the safe message for anything unknown, with the detail kept for the log', () => {
    const err = toApiError(new Error('connection string postgres://user:pw@host'))
    expect(err.code).toBe('INTERNAL')
    expect(err.message).toBe(INTERNAL_MESSAGE)
    expect(err.logDetail).toContain('postgres://')
    expect(JSON.stringify(err.toBody())).not.toContain('postgres://')
  })

  it('handles a thrown non-error', () => {
    expect(toApiError('oops').code).toBe('INTERNAL')
  })

  it("shows a database error's own written message, and logs the driver's", () => {
    const err = toApiError(new DbTimeoutError('The database took too long.', '57014: canceling statement'))
    expect(err.message).toBe('The database took too long.')
    expect(err.logDetail).toContain('57014')
    expect(JSON.stringify(err.toBody())).not.toContain('57014')
  })
})

describe('toBody', () => {
  it('leaves out what is not set', () => {
    expect(new ApiError('CONFLICT', 'x').toBody()).toEqual({ code: 'CONFLICT', message: 'x' })
  })

  it('never includes the log detail', () => {
    expect(new ApiError('INTERNAL', 'x', { logDetail: 'private' }).toBody()).toEqual({ code: 'INTERNAL', message: 'x' })
  })
})

describe('validationError', () => {
  it('names the first field and lists every issue', () => {
    const parsed = z.object({ a: z.string(), b: z.object({ c: z.number() }) }).safeParse({ b: { c: 'x' } })
    const err = validationError(parsed.error as z.ZodError)

    expect(err.code).toBe('VALIDATION')
    expect(err.field).toBe('a')
    expect(err.details).toMatchObject({ issues: [{ field: 'a' }, { field: 'b.c' }] })
  })

  it('copes with a failure on the whole input', () => {
    const parsed = z.string().safeParse(1)
    const err = validationError(parsed.error as z.ZodError)
    expect(err.field).toBeUndefined()
  })
})
