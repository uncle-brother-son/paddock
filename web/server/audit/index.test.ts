import { describe, it, expect, vi } from 'vitest'
import type { Tx } from '@/server/db'
import { audit } from './index'

describe('audit.record', () => {
  it('writes the entry through the given transaction', async () => {
    const query = vi.fn().mockResolvedValue([])
    const tx = { query } as unknown as Tx

    await audit.record(tx, {
      actorType: 'staff',
      actorId: 'staff-1',
      action: 'booking.cancel',
      entityType: 'booking',
      entityId: 'booking-1',
      requestId: 'req-1',
      details: { reason: 'customer request' },
    })

    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0]?.[0]).toContain('INSERT INTO audit_log')
    expect(query.mock.calls[0]?.[1]).toEqual([
      'staff',
      'staff-1',
      'booking.cancel',
      'booking',
      'booking-1',
      'req-1',
      { reason: 'customer request' },
    ])
  })

  it('defaults details to an empty object', async () => {
    const query = vi.fn().mockResolvedValue([])

    await audit.record({ query } as unknown as Tx, {
      actorType: 'system',
      actorId: null,
      action: 'membership.renew',
      entityType: 'membership',
      entityId: 'm-1',
      requestId: 'req-1',
    })

    expect(query.mock.calls[0]?.[1]?.[6]).toEqual({})
  })
})
