import { describe, it, expect, vi } from 'vitest'
import { chargeSavedCard, type ChargeSavedCardParams, type StripeChargeDeps } from './core'

const customerWithCard = {
  id: 'cust-1',
  stripe_customer_id: 'cus_123',
  saved_payment_method_id: 'pm_123',
}

function fakeSupabase(opts: {
  customer?: any
  customerError?: any
  order?: any
  orderError?: any
  lineItemError?: any
}) {
  const orderInsertCalls: any[] = []
  const lineItemInsertCalls: any[] = []

  const from = vi.fn((table: string) => {
    if (table === 'customers') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: opts.customer ?? null, error: opts.customerError ?? null }),
          }),
        }),
      }
    }
    if (table === 'orders') {
      return {
        insert: vi.fn((payload: any) => {
          orderInsertCalls.push(payload)
          return {
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: opts.order ?? null, error: opts.orderError ?? null }),
            }),
          }
        }),
      }
    }
    if (table === 'order_line_items') {
      return {
        insert: vi.fn((payload: any) => {
          lineItemInsertCalls.push(payload)
          return {
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: opts.lineItemError ? null : { id: 'line-1', ...payload },
                error: opts.lineItemError ?? null,
              }),
            }),
          }
        }),
      }
    }
    throw new Error(`Unexpected table in test: ${table}`)
  })

  return { from, orderInsertCalls, lineItemInsertCalls }
}

function fakeStripe(overrides: Partial<StripeChargeDeps> = {}): StripeChargeDeps & { paymentIntentsCreate: ReturnType<typeof vi.fn> } {
  return {
    paymentIntentsCreate: vi.fn().mockResolvedValue({ id: 'pi_123' }),
    ...overrides,
  } as any
}

const baseParams: ChargeSavedCardParams = {
  customerId: 'cust-1',
  amount: 50,
}

describe('chargeSavedCard', () => {
  it('skipOrderRecord=true charges the card and creates no orders or order_line_items rows', async () => {
    const supabase = fakeSupabase({ customer: customerWithCard })
    const stripe = fakeStripe()

    const result = await chargeSavedCard(
      { ...baseParams, skipOrderRecord: true, lineItems: [{ itemType: 'product', quantity: 1, unitPrice: 50, productVariantId: 'var-1' }] },
      supabase,
      stripe
    )

    expect(stripe.paymentIntentsCreate).toHaveBeenCalledTimes(1)
    expect(supabase.from).not.toHaveBeenCalledWith('orders')
    expect(supabase.from).not.toHaveBeenCalledWith('order_line_items')
    expect(result).toEqual({ success: true, paymentIntentId: 'pi_123', orderId: null })
  })

  it('skipOrderRecord=false (explicit) behaves exactly like today: creates the order and line items', async () => {
    const order = { id: 'order-1' }
    const supabase = fakeSupabase({ customer: customerWithCard, order })
    const stripe = fakeStripe()

    const result = await chargeSavedCard(
      {
        ...baseParams,
        skipOrderRecord: false,
        lineItems: [{ itemType: 'product', quantity: 2, unitPrice: 25, productVariantId: 'var-1' }],
      },
      supabase,
      stripe
    )

    expect(supabase.orderInsertCalls).toHaveLength(1)
    expect(supabase.orderInsertCalls[0]).toMatchObject({
      customer_id: 'cust-1',
      order_total: 50,
      payment_status: 'paid',
      stripe_payment_intent_id: 'pi_123',
      order_source: 'staff_created',
    })
    expect(supabase.lineItemInsertCalls).toHaveLength(1)
    expect(result).toMatchObject({
      success: true,
      order,
      paymentIntentId: 'pi_123',
    })
    expect((result as any).orderId).toBeUndefined()
  })

  it('skipOrderRecord absent defaults to false, unchanged behaviour', async () => {
    const order = { id: 'order-1' }
    const supabase = fakeSupabase({ customer: customerWithCard, order })
    const stripe = fakeStripe()

    const result = await chargeSavedCard(baseParams, supabase, stripe)

    expect(supabase.orderInsertCalls).toHaveLength(1)
    expect(result).toMatchObject({ success: true, order, paymentIntentId: 'pi_123' })
  })

  it('still returns a warning (not orderId) when the order insert fails, regardless of skipOrderRecord', async () => {
    const supabase = fakeSupabase({ customer: customerWithCard, order: null, orderError: { message: 'db down' } })
    const stripe = fakeStripe()

    const result = await chargeSavedCard(baseParams, supabase, stripe)

    expect(result).toEqual({
      success: true,
      warning: 'Card was charged but order record failed to save — verify manually.',
      paymentIntentId: 'pi_123',
    })
  })

  it('returns 402 on Stripe authentication_required, regardless of skipOrderRecord, and never touches the DB orders table', async () => {
    const supabase = fakeSupabase({ customer: customerWithCard })
    const stripe = fakeStripe({
      paymentIntentsCreate: vi.fn().mockRejectedValue(Object.assign(new Error('auth required'), { code: 'authentication_required' })),
    })

    const result = await chargeSavedCard({ ...baseParams, skipOrderRecord: true }, supabase, stripe)

    expect(result).toEqual({
      success: false,
      status: 402,
      error: 'Card requires additional authentication and cannot be charged off-session. Ask the customer to complete a new payment.',
    })
    expect(supabase.from).not.toHaveBeenCalledWith('orders')
  })

  it('returns 500 on a generic Stripe failure', async () => {
    const supabase = fakeSupabase({ customer: customerWithCard })
    const stripe = fakeStripe({ paymentIntentsCreate: vi.fn().mockRejectedValue(new Error('Stripe is down')) })

    const result = await chargeSavedCard(baseParams, supabase, stripe)

    expect(result).toEqual({
      success: false,
      status: 500,
      error: 'Failed to charge saved card',
      details: 'Stripe is down',
    })
  })

  it('returns 400 when customerId or amount is missing', async () => {
    const supabase = fakeSupabase({ customer: customerWithCard })
    const stripe = fakeStripe()

    const result = await chargeSavedCard({ customerId: '', amount: 0 }, supabase, stripe)

    expect(result).toEqual({
      success: false,
      status: 400,
      error: 'Missing required fields: customerId, amount (must be > 0)',
    })
    expect(stripe.paymentIntentsCreate).not.toHaveBeenCalled()
  })

  it('returns 404 when the customer does not exist', async () => {
    const supabase = fakeSupabase({ customer: null })
    const stripe = fakeStripe()

    const result = await chargeSavedCard(baseParams, supabase, stripe)

    expect(result).toEqual({ success: false, status: 404, error: 'Customer not found' })
  })

  it('returns 400 when the customer has no saved payment method', async () => {
    const supabase = fakeSupabase({ customer: { id: 'cust-1', stripe_customer_id: null, saved_payment_method_id: null } })
    const stripe = fakeStripe()

    const result = await chargeSavedCard(baseParams, supabase, stripe)

    expect(result).toEqual({ success: false, status: 400, error: 'Customer has no saved payment method on file.' })
    expect(stripe.paymentIntentsCreate).not.toHaveBeenCalled()
  })
})
