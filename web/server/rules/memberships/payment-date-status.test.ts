import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { legacyAccountDir } from '@/server/rules/testing/replay/harness'
import { staffAppDir } from '@/server/rules/testing/staff-app-dir'
import { formatIsoDate, PAYMENT_DATE_FACTS_COLUMNS_SQL, PAYMENT_DATE_FACTS_JOIN_SQL, paymentDateRefusal, paymentDateStatus, type PaymentDateFacts } from './payment-date-status'

// Brief W39 item 2: the customer's profile carries why "Change payment date" is refused on each membership row. The
// Worker's read rule (the facts' SQL and the order of the refusals) is held here to the old module,
// shared/membershipPaymentDate.ts: to the frozen copy always, and to the staff app's own file while it is still
// there (W41: nothing in the staff app calls it any more). W41 changes one thing on purpose (brief item 4): a pending
// change holds the membership until it is settled, where the old rule let one go after 15 minutes.

const sources = [path.join(legacyAccountDir, 'shared/membershipPaymentDate.ts'), path.join(staffAppDir(), 'backend/paddock/shared/membershipPaymentDate.ts')]
const constant = (source: string, name: string): string => new RegExp(`export const ${name} = \`([^\`]*)\``).exec(source)?.[1] ?? `no ${name}`
const normal = (sql: string): string => sql.replace(/\s+/g, ' ').trim()
/** The old rule's 15-minute expiry on a pending change: the one clause W41 takes out. */
const EXPIRY = " AND pdc_p.created_at > now() - interval '15 minutes'"

const ALLOWED: PaymentDateFacts = {
  billing_frequency: 'monthly',
  subscription_status: 'active',
  stripe_subscription_id: 'sub_1',
  pdc_next_renewal_date: '2026-12-10',
  pdc_cancel_effective_date: null,
  pdc_today: '2026-11-10',
  pdc_has_payment_needed: false,
  pdc_has_saved_card: true,
  pdc_last_done_at: null,
  pdc_last_done_on: null,
  pdc_last_done_new_date: null,
  pdc_within_six_months: false,
  pdc_pending: false,
}

describe("the payment date button's refusal on the profile (brief W39 item 2)", () => {
  it("the facts' SQL is the old module's, word for word (the frozen copy, and the staff app's own while it has it)", () => {
    let compared = 0
    for (const file of sources) {
      let source: string
      try {
        source = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      const old = normal(constant(source, 'PAYMENT_DATE_CHANGE_COLUMNS_SQL'))
      // The old SQL with its 15-minute expiry taken out, and nothing else changed.
      expect(old.split(EXPIRY), file).toHaveLength(2)
      expect(normal(PAYMENT_DATE_FACTS_COLUMNS_SQL), file).toBe(old.replace(EXPIRY, ''))
      expect(PAYMENT_DATE_FACTS_COLUMNS_SQL).not.toContain('15 minutes')
      expect(normal(PAYMENT_DATE_FACTS_JOIN_SQL), file).toBe(normal(constant(source, 'PAYMENT_DATE_CHANGE_JOIN_SQL')))
      compared += 1
    }
    // The frozen copy is always there.
    expect(compared).toBeGreaterThanOrEqual(1)
  })

  it('allowed when nothing refuses; each refusal in the old order, the first one that applies', () => {
    expect(paymentDateRefusal(ALLOWED)).toBeNull()
    const everything: PaymentDateFacts = {
      ...ALLOWED,
      billing_frequency: 'yearly',
      subscription_status: 'past_due',
      pdc_cancel_effective_date: '2026-12-09',
      pdc_next_renewal_date: '2026-11-01',
      pdc_has_payment_needed: true,
      stripe_subscription_id: null,
      pdc_has_saved_card: false,
      pdc_last_done_new_date: '2026-12-20',
      pdc_last_done_on: '2026-11-01',
      pdc_pending: true,
    }
    const steps: Array<[Partial<PaymentDateFacts>, string]> = [
      [{}, "Yearly memberships renew once a year, so the payment date can't be changed"],
      [{ billing_frequency: 'monthly' }, 'A payment is failing on this membership'],
      [{ subscription_status: 'cancelled' }, "This membership isn't active"],
      [{ subscription_status: 'active' }, 'A cancellation is scheduled on this membership'],
      [{ pdc_cancel_effective_date: null }, 'The renewal payment is overdue'],
      [{ pdc_next_renewal_date: '2026-12-10' }, 'Bookings on this membership are waiting for payment (Payment needed)'],
      [{ pdc_has_payment_needed: false }, 'This membership has no Stripe subscription'],
      [{ stripe_subscription_id: 'sub_1' }, 'The customer has no saved card for the charge'],
      [{ pdc_has_saved_card: true }, 'Changed on 1 Nov 2026. It can be changed again from 20 Dec 2026.'],
      [{ pdc_last_done_on: null }, 'It can be changed again from 20 Dec 2026.'],
      [{ pdc_last_done_new_date: '2026-12-09' }, 'A payment date change is already in progress for this membership'],
      [{ pdc_pending: false }, ''],
    ]
    let facts = everything
    for (const [change, words] of steps) {
      facts = { ...facts, ...change }
      expect(paymentDateRefusal(facts), JSON.stringify(change)).toBe(words === '' ? null : words)
    }
    // No renewal date at all is overdue; a renewal date of today is not.
    expect(paymentDateRefusal({ ...ALLOWED, pdc_next_renewal_date: null })).toBe('The renewal payment is overdue')
    expect(paymentDateRefusal({ ...ALLOWED, pdc_next_renewal_date: '2026-11-10' })).toBeNull()
    // No frequency recorded counts as not monthly, as before.
    expect(paymentDateRefusal({ ...ALLOWED, billing_frequency: null })).toMatch(/^Yearly memberships/)
  })

  it('the status: when it was last changed (as ISO text), the refusal, and whether the six-month override is needed', () => {
    expect(paymentDateStatus(ALLOWED)).toEqual({ payment_date_changed_at: null, payment_date_change_blocked: null, payment_date_change_needs_override: false })
    expect(paymentDateStatus({ ...ALLOWED, pdc_last_done_at: new Date('2026-09-01T10:00:00.000Z'), pdc_within_six_months: true, pdc_last_done_new_date: '2026-10-10' })).toEqual({
      payment_date_changed_at: '2026-09-01T10:00:00.000Z',
      payment_date_change_blocked: null,
      payment_date_change_needs_override: true,
    })
    expect(paymentDateStatus({ ...ALLOWED, pdc_last_done_at: '2026-09-01T10:00:00.000Z' }).payment_date_changed_at).toBe('2026-09-01T10:00:00.000Z')
  })

  it('W58 (W45 audit row 41): on the renewal day the list and profile carry the refusal the quote and press give, so the button is greyed first', () => {
    const renewalDay = { ...ALLOWED, pdc_next_renewal_date: '2026-11-10' }
    expect(paymentDateStatus(renewalDay).payment_date_change_blocked).toBe(paymentDateRefusal(renewalDay, true))
    expect(paymentDateStatus(renewalDay).payment_date_change_blocked).not.toBeNull()
    // The day before, nothing refuses.
    expect(paymentDateStatus({ ...ALLOWED, pdc_next_renewal_date: '2026-11-11' }).payment_date_change_blocked).toBeNull()
  })

  it('dates are worded on their digits, as the old shared/formatIsoDate', () => {
    expect(formatIsoDate('2026-11-28')).toBe('28 Nov 2026')
    expect(formatIsoDate('2026-01-05')).toBe('5 Jan 2026')
    expect(formatIsoDate('not a date')).toBe('not a date')
    expect(formatIsoDate('2026-13-01')).toBe('2026-13-01')
    for (const file of [path.join(legacyAccountDir, 'shared/formatIsoDate.ts')]) expect(readFileSync(file, 'utf8')).toContain("const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']")
  })
})
