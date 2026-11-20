import { describe, expect, it } from 'vitest'
import { adminRefusalDetailsSchema } from '@/contracts'
import { lapseSweepOn } from '@/server/rules/bookings/lapse-sweep'
import { MEMBERSHIP_PATH_OFF_MESSAGE } from '@/server/rules/memberships/failure-messages'
import { cardMovesOn, membershipChangePathOff, membershipChangesOn, paymentDateChangesOn, paymentRetriesOn } from '@/server/rules/memberships/membership-switch'
import { kindsOn, ORDER_KINDS, orderKind, orderPathOff } from '@/server/rules/orders/order-switch'
import { PLAN_CHANGE_KINDS, planChangePathOff, planChangesOn } from './plan-switch'

// Brief W48 item 2 (G-plan 4.6, lead call L3): step G's one switch kind, `plan_changes`, for the plan actions that
// touch Stripe (level A only). Off until the lead adds it to the secret when W57 goes live; it turns nothing else on,
// and no other kind turns it on. Added as `payment_retries` was (memberships/membership-switch.test.ts).

/** The secret's value on live since W43 (staff app CLAUDE.md, 18 Nov 2026): `payment_retries` is still off there. */
const LIVE_TODAY = 'no_stripe,saved_card,reader,membership,booking_changes,reader_flows,order_refunds,event_cancels,membership_changes,payment_date_changes,card_moves,lapse_sweep'

describe("step G's switch kind (brief W48 item 2)", () => {
  it('ORDER_SWITCH knows the kind, and only by its exact name; it is the last in the list and the fourteen before it are as they were', () => {
    expect(PLAN_CHANGE_KINDS).toEqual(['plan_changes'])
    expect(ORDER_KINDS.indexOf('plan_changes')).toBe(14)
    expect(ORDER_KINDS.at(-1)).toBe('plan_changes')
    expect(ORDER_KINDS.slice(0, 14)).toEqual(['no_stripe', 'saved_card', 'reader', 'membership', 'reader_flows', 'booking_changes', 'order_refunds', 'event_cancels', 'customer_cancels', 'membership_changes', 'payment_date_changes', 'card_moves', 'lapse_sweep', 'payment_retries'])
    expect([...kindsOn(' Plan_Changes ,')]).toEqual(['plan_changes'])
    for (const typo of ['plan_change', 'plans_changes', 'plan-changes', 'planchanges', 'plans', 'changes', 'membership_changes', 'membership', 'price_changes']) expect(kindsOn(typo).has('plan_changes'), typo).toBe(false)
  })

  it('off by default: unset, empty, the value live runs today, and every other kind on. Deploying this Worker starts no plan action', () => {
    const everyOtherKind = ORDER_KINDS.filter((kind) => kind !== 'plan_changes').join(',')
    expect(everyOtherKind.split(',').sort()).toEqual([...LIVE_TODAY.split(','), 'customer_cancels', 'payment_retries'].sort())
    for (const value of [undefined, null, '', '   ', LIVE_TODAY, everyOtherKind]) {
      expect(planChangesOn(value), String(value)).toBe(false)
      expect(planChangePathOff(value), String(value)).toMatchObject({
        code: 'MEMBERSHIP_PATH_OFF',
        status: 501,
        message: 'This is switched off in the booking system. Tell a manager.',
        details: { reason: 'membership_path_off', message: MEMBERSHIP_PATH_OFF_MESSAGE, action: 'plan.change', kinds: ['plan_changes'] },
      })
    }
    // The refusal's details are a step G refusal's, so a thin wrapper reads them as any other.
    expect(adminRefusalDetailsSchema.safeParse(planChangePathOff(LIVE_TODAY)?.details).success).toBe(true)
    // And it changes nothing for the kinds that are on.
    expect(membershipChangePathOff(LIVE_TODAY)).toBeNull()
    expect(cardMovesOn(LIVE_TODAY)).toBe(true)
    expect(lapseSweepOn(LIVE_TODAY)).toBe(true)
    expect(orderPathOff({ payment: { method: 'card' } } as Parameters<typeof orderPathOff>[0], LIVE_TODAY)).toBeNull()
  })

  it('on only when the secret names it, and it turns nothing else on or off', () => {
    expect(planChangesOn(`${LIVE_TODAY},plan_changes`)).toBe(true)
    expect(planChangePathOff(`${LIVE_TODAY},plan_changes`)).toBeNull()
    expect(planChangePathOff('plan_changes')).toBeNull()
    expect([...kindsOn('plan_changes')]).toEqual(['plan_changes'])
    expect(membershipChangesOn('plan_changes')).toBe(false)
    expect(paymentDateChangesOn('plan_changes')).toBe(false)
    expect(cardMovesOn('plan_changes')).toBe(false)
    expect(paymentRetriesOn('plan_changes')).toBe(false)
    expect(lapseSweepOn('plan_changes')).toBe(false)
    // A basket is never this kind: it gates no order, and a membership bought at the desk is still `membership`.
    expect(orderKind({ payment: { method: 'card' } } as Parameters<typeof orderKind>[0])).toBe('saved_card')
    expect(orderKind({ membershipPlanId: 'plan' } as Parameters<typeof orderKind>[0])).toBe('membership')
    expect(orderPathOff({ membershipPlanId: 'plan' } as Parameters<typeof orderPathOff>[0], 'plan_changes')).toMatchObject({ code: 'ORDER_PATH_OFF' })
  })
})
