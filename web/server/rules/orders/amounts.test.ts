import { describe, expect, it } from 'vitest'
import { cashDifferenceRefusal } from './amounts'

// Brief W25 (W24a "Noticed"): the 19 cash-rule tests W24a removed with the staff app's copy of the rule
// (backend/paddock/shared/cashConfirmation.ts), word for word, now against the Worker's own function, which has the
// same signature. Saved verbatim in the staff app repo's briefs/W24a-logs/removed-staff-app-helper-tests.ts.txt; the
// only change is where the function comes from. The rule's edges (half a penny either way, a figure that isn't a
// number, the "nothing left to collect" words) were otherwise only tested through the actions.

const CHANGED = (amount: string) => `The amount due has changed to £${amount}. Check it with the customer and confirm again.`
const NOTHING_LEFT = "The amount due has changed. There's nothing left to collect in cash. Check it with the customer and confirm again."

describe('cash must match what was confirmed: the rule', () => {
  it('refuses a higher figure, with the new amount', () => {
    expect(cashDifferenceRefusal('cash', 25, 20)).toEqual({ reason: 'cash_amount_changed', message: CHANGED('25.00'), amountToCollect: 25 })
  })

  it('refuses one penny more', () => {
    expect(cashDifferenceRefusal('cash', 20.01, 20)?.message).toBe(CHANGED('20.01'))
  })

  it('refuses a lower figure the same way', () => {
    expect(cashDifferenceRefusal('cash', 15, 20)).toEqual({ reason: 'cash_amount_changed', message: CHANGED('15.00'), amountToCollect: 15 })
  })

  it('refuses one penny less', () => {
    expect(cashDifferenceRefusal('cash', 19.99, 20)?.message).toBe(CHANGED('19.99'))
  })

  it('refuses when nothing is left to collect but cash was confirmed', () => {
    expect(cashDifferenceRefusal('cash', 0, 20)).toEqual({ reason: 'cash_amount_changed', message: NOTHING_LEFT, amountToCollect: 0 })
  })

  it('only says nothing is left when the figure really is £0.00', () => {
    expect(cashDifferenceRefusal('cash', 0.004, 20)?.message).toBe(NOTHING_LEFT)
    expect(cashDifferenceRefusal('cash', 0.01, 20)?.message).toBe(CHANGED('0.01'))
  })

  it.each([
    ['the same amount', 'cash', 20, 20],
    ['half a penny more', 'cash', 20.005, 20],
    ['half a penny less', 'cash', 19.995, 20],
    // Both come out a hair over half a penny. Refusing them would show staff the figure they
    // had just confirmed, every time they confirmed it.
    ['a tick rounded up', 'cash', 8.995, 9],
    ['a tick rounded down', 'cash', 12.345, 12.34],
    ['adding up noise', 'cash', 0.1 + 0.2, 0.3],
    ['a card', 'card', 25, 20],
    ['the reader', 'reader', 25, 20],
    ['no method', undefined, 25, 20],
  ])('lets through %s', (_label, method, due, confirmed) => {
    expect(cashDifferenceRefusal(method, due, confirmed)).toBeNull()
  })

  it.each([
    ['missing', undefined],
    ['null', null],
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ])('a %s figure counts as nothing confirmed', (_label, confirmed) => {
    expect(cashDifferenceRefusal('cash', 25, confirmed)?.reason).toBe('cash_amount_changed')
    expect(cashDifferenceRefusal('cash', 0, confirmed)).toBeNull()
  })
})
