import { describe, it, expect, vi } from 'vitest'
import { handlePaymentIntent } from './core'

function pi(status: string, extra: Record<string, unknown> = {}): any {
  return { id: 'pi_123', status, amount: 4500, amount_received: status === 'succeeded' ? 4500 : 0, currency: 'gbp', metadata: { order_id: 'ord_1' }, customer: 'cus_1', created: 1700000000, ...extra }
}

describe('handlePaymentIntent', () => {
  it('rejects a bad id', async () => {
    const r = await handlePaymentIntent({ paymentIntentId: 'xyz', action: 'retrieve' }, { retrieve: vi.fn(), cancel: vi.fn() })
    expect(r).toMatchObject({ success: false, status: 400, code: 'invalid_id' })
  })

  it('retrieves and converts pence to pounds with metadata', async () => {
    const r = await handlePaymentIntent({ paymentIntentId: 'pi_123', action: 'retrieve' }, { retrieve: vi.fn().mockResolvedValue(pi('succeeded')), cancel: vi.fn() })
    expect(r).toMatchObject({ success: true, paymentIntent: { status: 'succeeded', amount: 45, amountReceived: 45, metadata: { order_id: 'ord_1' }, customerId: 'cus_1' } })
  })

  it('cancels a payment that has not completed', async () => {
    const cancel = vi.fn().mockResolvedValue(pi('canceled'))
    const r = await handlePaymentIntent({ paymentIntentId: 'pi_123', action: 'cancel' }, { retrieve: vi.fn().mockResolvedValue(pi('requires_payment_method')), cancel })
    expect(cancel).toHaveBeenCalledWith('pi_123')
    expect(r).toMatchObject({ success: true, cancelled: true })
  })

  it('never cancels a succeeded payment and tells the caller to finalise', async () => {
    const cancel = vi.fn()
    const r = await handlePaymentIntent({ paymentIntentId: 'pi_123', action: 'cancel' }, { retrieve: vi.fn().mockResolvedValue(pi('succeeded')), cancel })
    expect(cancel).not.toHaveBeenCalled()
    expect(r).toMatchObject({ success: true, cancelled: false, alreadySucceeded: true })
  })

  it('re-reads after a failed cancel and reports a payment that completed meanwhile', async () => {
    const retrieve = vi.fn().mockResolvedValueOnce(pi('requires_payment_method')).mockResolvedValueOnce(pi('succeeded'))
    const r = await handlePaymentIntent({ paymentIntentId: 'pi_123', action: 'cancel' }, { retrieve, cancel: vi.fn().mockRejectedValue(new Error('race')) })
    expect(r).toMatchObject({ success: true, alreadySucceeded: true })
  })

  it('treats an already cancelled payment as cancelled', async () => {
    const cancel = vi.fn()
    const r = await handlePaymentIntent({ paymentIntentId: 'pi_123', action: 'cancel' }, { retrieve: vi.fn().mockResolvedValue(pi('canceled')), cancel })
    expect(cancel).not.toHaveBeenCalled()
    expect(r).toMatchObject({ success: true, cancelled: true })
  })

  it('returns 404 when Stripe has no such payment', async () => {
    const err: any = new Error('No such payment_intent'); err.statusCode = 404
    const r = await handlePaymentIntent({ paymentIntentId: 'pi_123', action: 'retrieve' }, { retrieve: vi.fn().mockRejectedValue(err), cancel: vi.fn() })
    expect(r).toMatchObject({ success: false, status: 404, code: 'not_found' })
  })
})
