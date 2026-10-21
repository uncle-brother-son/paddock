import { describe, it, expect } from 'vitest'
import { computeMembershipEndDate, computeMembershipCancellation } from './membership-cancellation'

describe('computeMembershipEndDate', () => {
  it('monthly, started 10 days ago: the 2-month minimum term wins over the next renewal date', () => {
    const endDate = computeMembershipEndDate({
      startDate: '2026-10-11',
      nextRenewalDate: '2026-11-11',
      billingFrequency: 'monthly',
    })
    expect(endDate).toBe('2026-12-11') // startDate + 2 months, later than nextRenewalDate
  })

  it('monthly, started 5 months ago: the next renewal date wins over the (already-past) minimum term', () => {
    const endDate = computeMembershipEndDate({
      startDate: '2026-05-21',
      nextRenewalDate: '2026-11-21',
      billingFrequency: 'monthly',
    })
    expect(endDate).toBe('2026-11-21') // startDate + 2 months (2026-07-21) is in the past
  })

  it('yearly: always the next renewal date, no minimum-term floor', () => {
    const endDate = computeMembershipEndDate({
      startDate: '2026-01-15',
      nextRenewalDate: '2027-01-15',
      billingFrequency: 'yearly',
    })
    expect(endDate).toBe('2027-01-15')
  })

  it('month-end edge case: a 31 Jan start + 2 months lands cleanly on 31 March (no month-end rollover)', () => {
    const endDate = computeMembershipEndDate({
      startDate: '2026-01-31',
      nextRenewalDate: '2026-02-28', // Stripe's own anchor clamps Feb to its last day in a non-leap year
      billingFrequency: 'monthly',
    })
    expect(endDate).toBe('2026-03-31')
  })
})

describe('computeMembershipCancellation', () => {
  it('derives cancelEffectiveDate as endDate minus one calendar day', () => {
    const result = computeMembershipCancellation({
      startDate: '2026-10-11',
      nextRenewalDate: '2026-11-11',
      billingFrequency: 'monthly',
    })
    expect(result.endDate).toBe('2026-12-11')
    expect(result.cancelEffectiveDate).toBe('2026-12-10')
  })

  it('computes cancelAtUnix as real London midnight during BST (UTC+1)', () => {
    const result = computeMembershipCancellation({
      startDate: '2026-01-15',
      nextRenewalDate: '2026-07-15',
      billingFrequency: 'yearly',
    })
    expect(new Date(result.cancelAtUnix * 1000).toISOString()).toBe('2026-07-14T23:00:00.000Z')
  })

  it('computes cancelAtUnix as real London midnight during GMT (UTC+0)', () => {
    const result = computeMembershipCancellation({
      startDate: '2025-07-15',
      nextRenewalDate: '2026-01-15',
      billingFrequency: 'yearly',
    })
    expect(new Date(result.cancelAtUnix * 1000).toISOString()).toBe('2026-01-15T00:00:00.000Z')
  })
})
