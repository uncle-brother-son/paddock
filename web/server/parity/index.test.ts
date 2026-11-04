import { describe, it, expect, vi } from 'vitest'
import type { Queryable } from '@/server/db'
import { recordParity } from './index'

describe('recordParity', () => {
  it('stores the comparison with the request id', async () => {
    const query = vi.fn().mockResolvedValue([])

    await recordParity(
      { query } as unknown as Queryable,
      { action: 'getBookings', oldResult: [{ a: 1 }], newResult: [{ a: 2 }], matches: false, diff: [{ path: '0.a' }] },
      'req-1'
    )

    expect(query.mock.calls[0]?.[0]).toContain('INSERT INTO parity_log')
    expect(query.mock.calls[0]?.[1]).toEqual(['getBookings', 'req-1', [{ a: 1 }], [{ a: 2 }], false, [{ path: '0.a' }]])
  })

  it('stores a missing result as null, not undefined', async () => {
    const query = vi.fn().mockResolvedValue([])

    await recordParity(
      { query } as unknown as Queryable,
      { action: 'x', oldResult: undefined, newResult: undefined, matches: true, diff: undefined },
      'req-1'
    )

    expect(query.mock.calls[0]?.[1]).toEqual(['x', 'req-1', null, null, true, null])
  })
})
