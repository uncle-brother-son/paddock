import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

const booking = {
  id: 'booking-1',
  customer_id: 'customer-1',
  session_id: 'session-1',
  status: 'confirmed',
  redemption_source: 'paid',
  price_paid: 45,
  party_size: 2,
  stripe_payment_id: 'pi_123',
}

const session = {
  id: 'session-1',
  start_time: '2030-01-15T09:00:00.000Z', // far enough in the future to clear the 24h rule
  total_booked: 10,
}

function createMockSupabase(opts: {
  creditResult?: { data: any; error: any }
}) {
  const bookingSingle = vi.fn().mockResolvedValue({ data: booking, error: null })
  const bookingSelect = vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ single: bookingSingle }) })

  const bookingUpdateSingle = vi.fn().mockResolvedValue({
    data: { ...booking, status: 'cancelled' },
    error: null,
  })
  const bookingUpdate = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single: bookingUpdateSingle }) }),
  })

  const sessionSingle = vi.fn().mockResolvedValue({ data: session, error: null })
  const sessionSelect = vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ single: sessionSingle }) })

  const sessionUpdate = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) })

  const from = vi.fn((table: string) => {
    if (table === 'bookings') return { select: bookingSelect, update: bookingUpdate }
    if (table === 'sessions') return { select: sessionSelect, update: sessionUpdate }
    throw new Error(`Unexpected table in test: ${table}`)
  })

  const rpc = vi.fn().mockResolvedValue(
    opts.creditResult ?? { data: { ok: true, balance: 145, transaction_id: 'txn_1' }, error: null }
  )

  return { from, rpc, bookingUpdate, sessionUpdate }
}

let mockSupabase: ReturnType<typeof createMockSupabase>

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => mockSupabase),
}))

function fakeRequest(body: unknown): NextRequest {
  return {
    headers: { get: (name: string) => (name === 'authorization' ? 'Bearer test-retool-key' : null) },
    json: async () => body,
  } as unknown as NextRequest
}

beforeEach(() => {
  process.env.RETOOL_API_KEY = 'test-retool-key'
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
  vi.resetModules()
})

describe('POST /api/bookings/refund — credit branch', () => {
  it('applies store credit via store_credit_apply and cancels the booking', async () => {
    mockSupabase = createMockSupabase({})
    const { POST } = await import('./route')

    const response = await POST(fakeRequest({ bookingId: 'booking-1', refundMethod: 'credit' }))
    const body = await response.json()

    expect(mockSupabase.rpc).toHaveBeenCalledWith('store_credit_apply', {
      p_customer_id: 'customer-1',
      p_amount: 45,
      p_reason: 'refund',
      p_booking_id: 'booking-1',
      p_note: 'Refund to store credit: booking cancelled',
    })
    expect(mockSupabase.bookingUpdate).toHaveBeenCalled()
    expect(mockSupabase.sessionUpdate).toHaveBeenCalled()
    expect(body).toMatchObject({ success: true, storeCreditBalance: 145 })
    expect(body.giftCard).toBeUndefined()
  })

  it('returns 500 and leaves the booking untouched when store_credit_apply fails', async () => {
    mockSupabase = createMockSupabase({
      creditResult: { data: { ok: false, reason: 'customer_not_found' }, error: null },
    })
    const { POST } = await import('./route')

    const response = await POST(fakeRequest({ bookingId: 'booking-1', refundMethod: 'credit' }))
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.error).toContain('customer_not_found')
    expect(mockSupabase.bookingUpdate).not.toHaveBeenCalled()
    expect(mockSupabase.sessionUpdate).not.toHaveBeenCalled()
  })
})
