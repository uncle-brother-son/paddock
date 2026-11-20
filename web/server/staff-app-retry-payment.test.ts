import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { staffAppDir } from './rules/testing/staff-app-dir'

// Brief W47r item 5: the staff app's two thin wrappers for "Try the payment again now" against a stand-in for the
// Worker, the window's own words, and its screens read as source (the staff app has no test runner): where the button
// is offered, the press key kept after no answer or a throw, closing blocked while a press runs, one press per
// opening, and a reload on close. The wrappers through the real routes are held by memberships/retry-payment.test.ts.

const appDir = staffAppDir()
const backend = (name: string) => import(/* @vite-ignore */ path.join(appDir, 'backend/paddock', name))
const frontend = (name: string) => import(/* @vite-ignore */ path.join(appDir, 'frontend', name))
const source = (file: string) => readFileSync(path.join(appDir, file), 'utf8')

const user = { email: 'jo@example.com' }
const MEMBERSHIP = '10000000-0000-4000-8000-000000000010'
const KEY = 'a-press-key-of-sixteen-or-more'
const success = (data: unknown) => ({ data: { ok: true, data, requestId: 'worker-request' } })
const failure = (code: string, message: string, details?: unknown) => ({ data: { ok: false, error: { code, message, ...(details !== undefined ? { details } : {}) }, requestId: 'worker-request' } })
const refused = (code: string, reason: string, message: string, more: Record<string, unknown> = {}) => failure(code, message, { reason, message, action: 'payment_retry', ...more })

type Sent = { path: string; method: string; headers: Record<string, string>; body?: unknown; queryParams?: unknown }

describe("the staff app's wrappers for \"Try the payment again now\" (brief W47r item 5)", () => {
  const rawRequest = vi.fn()
  const sent = (call = 0) => rawRequest.mock.calls[call]?.[0] as Sent

  beforeEach(() => {
    rawRequest.mockReset()
    vi.stubGlobal('paddockWorkerV1', { rawRequest })
    // A thin wrapper never goes to the database or the legacy API itself.
    vi.stubGlobal('paddockData', {
      query: async (sql: string) => {
        throw new Error(`A wrapper went to the database itself: ${sql}`)
      },
    })
    vi.stubGlobal('paddockBackendApi2', {
      rawRequest: async () => {
        throw new Error('A wrapper went to the legacy API.')
      },
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  const NO_ANSWERS = [
    ['the Worker unreachable', () => rawRequest.mockRejectedValue(new Error('socket hang up'))],
    ['an answer nobody can read', () => rawRequest.mockResolvedValue({ data: '<html>502</html>' })],
    ['an earlier press with the same key still running', () => rawRequest.mockResolvedValue(failure('CONFLICT', 'This request is already being processed'))],
    ['a fault', () => rawRequest.mockResolvedValue(failure('INTERNAL', 'Something went wrong and the action may not have finished. Check before trying again.'))],
  ] as const

  describe('retryMembershipPayment', () => {
    const call = async (extra: Record<string, unknown> = {}) =>
      (await backend('retryMembershipPayment.ts')).default({ params: { membershipId: MEMBERSHIP, confirmedInvoiceId: 'in_1', confirmedAmount: 40, confirmedPaymentMethodId: 'pm_1', ...extra }, user })
    const paid = { retryId: 'r1', invoiceId: 'in_1', amountCharged: 40, alreadyPaid: false, cardBrand: 'visa', cardLast4: '4444', membershipUpdated: true, bookingsRestored: 2, bookingsWaiting: 0, subscriptionStatus: 'active', nextRenewalDate: '2027-01-10', message: 'Taken.' }

    it("sends the press to the membership's retry route under the window's key, with who is signed in and what the window showed, and nothing else", async () => {
      rawRequest.mockResolvedValue(success(paid))
      expect(await call({ idempotencyKey: KEY })).toEqual({ paid: true, message: 'Taken.', amountCharged: 40, alreadyPaid: false, membershipUpdated: true, bookingsRestored: 2, nextRenewalDate: '2027-01-10' })
      // W47r-a (the W47r review's S3): the card the window showed goes with the invoice and the amount.
      expect(sent()).toMatchObject({ path: `/api/v1/staff/memberships/${MEMBERSHIP}/retry-payment`, method: 'POST' })
      expect(sent().body).toEqual({ confirmed: { invoiceId: 'in_1', amount: 40, paymentMethodId: 'pm_1' } })
      expect(sent().headers).toMatchObject({ 'X-Staff-Email': 'jo@example.com', 'Idempotency-Key': KEY })
      expect(Object.keys(sent().body as object)).toEqual(['confirmed'])
      // A write: it must never be given a time limit of its own (a press that times out may still charge).
      expect(source('backend/paddock/retryMembershipPayment.ts')).not.toContain('timeoutMs')
    })

    it('with no key from the screen it makes one of its own, a new one each call; with no membership it answers without calling', async () => {
      rawRequest.mockResolvedValue(success(paid))
      await call()
      await call()
      const keys = [sent(0).headers['Idempotency-Key'], sent(1).headers['Idempotency-Key']]
      expect(keys.every((key) => typeof key === 'string' && key.length >= 16)).toBe(true)
      expect(keys[0]).not.toBe(keys[1])
      rawRequest.mockReset()
      expect(await call({ membershipId: '' })).toEqual({ paid: false, message: 'membershipId is required' })
      expect(rawRequest).not.toHaveBeenCalled()
    })

    it('every refusal comes back as `paid: false` with its reason and words; a payment on hold as `held`; a changed amount with the amount now', async () => {
      for (const [code, reason, message] of [
        ['FORBIDDEN', 'permission_denied', 'Needs the Issue refunds permission to try a membership payment again.'],
        ['CONFLICT', 'not_past_due', "This membership's payment isn't overdue, so there is nothing to try again. Nothing was charged."],
        ['CONFLICT', 'card_step_open', "The customer's card replace hasn't finished."],
        ['CONFLICT', 'retry_held', 'A payment was already tried for this membership.'],
        ['PAYMENT_FAILED', 'payment_failed', 'The card was declined: Your card was declined.'],
        ['MEMBERSHIP_PATH_OFF', 'membership_path_off', 'This is switched off in the booking system. Tell a manager.'],
      ] as const) {
        rawRequest.mockResolvedValue(refused(code, reason, message))
        expect(await call(), reason).toEqual({ paid: false, reason, message })
      }
      rawRequest.mockResolvedValue(refused('PAYMENT_UNCONFIRMED', 'payment_unconfirmed', 'On hold.', { held: { retryId: 'r1' } }))
      expect(await call()).toEqual({ paid: false, reason: 'payment_unconfirmed', message: 'On hold.', held: true })
      rawRequest.mockResolvedValue(refused('TOTAL_CHANGED', 'amount_changed', 'The amount to pay is now £45.00, not the £40.00 shown.', { amountNow: 45 }))
      expect(await call()).toEqual({ paid: false, reason: 'amount_changed', message: 'The amount to pay is now £45.00, not the £40.00 shown.', amountNow: 45 })
      rawRequest.mockResolvedValue(failure('FORBIDDEN', 'This staff account is inactive. Ask an admin to reactivate it.'))
      expect(await call()).toEqual({ paid: false, reason: 'permission_denied', message: 'This staff account is inactive. Ask an admin to reactivate it.' })
    })

    it('no answer (unreachable, unreadable, still running, a fault) is `no_answer` with `noAnswer`, in words that say the card may have been charged; a changed press under a kept key is "check first"', async () => {
      const worker = await backend('retryMembershipPayment.ts')
      for (const [what, arrange] of NO_ANSWERS) {
        arrange()
        expect(await call({ idempotencyKey: KEY }), what).toEqual({ paid: false, reason: 'no_answer', message: worker.RETRY_PAYMENT_NO_ANSWER_MESSAGE, noAnswer: true })
      }
      // The words are the function's own: the shared module every step F wrapper imports is as it was.
      expect(source('backend/paddock/shared/accountWorker.ts')).not.toContain('RETRY_PAYMENT')
      expect(worker.RETRY_PAYMENT_NO_ANSWER_MESSAGE).toBe(
        "The payment didn't get an answer, so the card may or may not have been charged. Don't take the payment another way: press again here (it won't charge twice), or close this and check the membership and the Orders page first."
      )
      rawRequest.mockResolvedValue(failure('IDEMPOTENCY_MISMATCH', 'This Idempotency-Key was already used for a different request.'))
      expect(await call({ idempotencyKey: KEY })).toEqual({ paid: false, reason: 'pressed_after_no_answer', message: worker.RETRY_PAYMENT_PRESSED_AFTER_NO_ANSWER_MESSAGE, noAnswer: true })
      // The window's own copy of the no-answer words (the frontend can't import backend files) is the same sentence.
      expect((await frontend('utils/retryPayment.ts')).RETRY_PAYMENT_NO_ANSWER_MESSAGE).toBe(worker.RETRY_PAYMENT_NO_ANSWER_MESSAGE)
    })
  })

  describe('getMembershipRetryPaymentQuote', () => {
    const call = async (membershipId: string = MEMBERSHIP) => (await backend('getMembershipRetryPaymentQuote.ts')).default({ params: { membershipId }, user })
    const quote = { membershipId: MEMBERSHIP, customerId: 'c', customerName: 'Mo Member', planName: 'Core', refusal: null, reason: null, alreadyPaid: false, invoiceId: 'in_1', amount: 40, cardBrand: 'visa', cardLast4: '4444', bookingsWaiting: 2, ifPaid: 'If the payment goes through…' }

    it("a read of the membership's quote route, with a read's time limit; the quote comes back whole, marked ok", async () => {
      rawRequest.mockResolvedValue(success(quote))
      expect(await call()).toEqual({ ok: true, ...quote })
      expect(sent()).toMatchObject({ path: `/api/v1/staff/memberships/${MEMBERSHIP}/retry-payment/quote`, method: 'GET' })
      expect(sent().headers['Idempotency-Key']).toBeUndefined()
      expect(source('backend/paddock/getMembershipRetryPaymentQuote.ts')).toContain('timeoutMs: READ_TIMEOUT_MS')
    })

    it('no such membership is null; anything else the Worker says (switched off, an inactive account) or no answer is `ok: false` with words to show', async () => {
      expect(await call('')).toBeNull()
      expect(rawRequest).not.toHaveBeenCalled()
      rawRequest.mockResolvedValue(failure('NOT_FOUND', 'Membership not found.', { reason: 'membership_not_found', message: 'Membership not found.', action: 'payment_retry_quote' }))
      expect(await call()).toBeNull()
      rawRequest.mockResolvedValue(failure('MEMBERSHIP_PATH_OFF', 'This is switched off in the booking system. Tell a manager.', { reason: 'membership_path_off', message: 'This is switched off in the booking system. Tell a manager.', kinds: ['payment_retries'] }))
      expect(await call()).toEqual({ ok: false, problem: 'This is switched off in the booking system. Tell a manager.' })
      rawRequest.mockResolvedValue(failure('FORBIDDEN', 'This staff account is inactive. Ask an admin to reactivate it.'))
      expect(await call()).toEqual({ ok: false, problem: 'This staff account is inactive. Ask an admin to reactivate it.' })
      rawRequest.mockRejectedValue(new Error('socket hang up'))
      const unreachable = (await call()) as { ok: boolean; problem: string }
      expect(unreachable.ok).toBe(false)
      expect(unreachable.problem.length).toBeGreaterThan(10)
      expect(unreachable.problem).not.toMatch(/request [0-9a-f-]{8}/)
    })
  })

  it('the stuck list wrapper carries the held retries, and an older Worker\'s list (with none) reads as an empty list', async () => {
    const retry = { retryId: 'r1', membershipId: MEMBERSHIP, customerId: 'c', customerName: 'Mo Member', invoiceId: 'in_1', amount: 40, cardBrand: 'visa', cardLast4: '4444', createdAt: '2026-12-10T16:00:00.000Z', ageMinutes: 16, reason: 'waiting', words: 'On hold.' }
    const list = { checkout: [], flows: [], claims: [], refunds: [], warnings: [], watched: [], steps: [], paymentDates: [], watchedPayments: [], webhook: null, alert: null }
    rawRequest.mockResolvedValue(success({ ...list, paymentRetries: [retry] }))
    expect((await (await backend('getStuckReaderPayments.ts')).default({ user })).paymentRetries).toEqual([retry])
    rawRequest.mockResolvedValue(success(list))
    expect((await (await backend('getStuckReaderPayments.ts')).default({ user })).paymentRetries).toEqual([])
  })
})

describe("the window's own words and the Orders page's line (brief W47r item 5)", () => {
  const quoted = { ok: true as const, membershipId: MEMBERSHIP, customerId: 'c', customerName: 'Mo Member', planName: 'Core', refusal: null, reason: null, alreadyPaid: false, invoiceId: 'in_1', amount: 40, cardBrand: 'visa', cardLast4: '4444', paymentMethodId: 'pm_1', bookingsWaiting: 2, ifPaid: 'x' }

  it('the amount and the card, by brand and last four; the press button says what it charges; nothing can be pressed on a refusal or with no amount', async () => {
    const words = await frontend('utils/retryPayment.ts')
    expect(words.RETRY_PAYMENT_LABEL).toBe('Try the payment again now')
    expect(words.retryCardText({ cardBrand: 'visa', cardLast4: '4444' })).toBe('the Visa card ending 4444')
    expect(words.retryCardText({ cardBrand: null, cardLast4: '4444' })).toBe('the card ending 4444')
    expect(words.retryCardText({ cardBrand: 'visa', cardLast4: null })).toBe('the saved card')
    expect(words.retryChargeLine(quoted)).toBe('£40.00 will be charged now to the Visa card ending 4444.')
    expect(words.retryPressLabel(quoted, false)).toBe('Charge £40.00 now')
    expect(words.retryPressLabel(quoted, true)).toBe('Charging…')
    expect(words.retryCanPress(quoted)).toBe(true)
    // Already paid by Stripe's own retry: nothing is charged, and the button says so.
    const alreadyPaid = { ...quoted, alreadyPaid: true, amount: 0 }
    expect(words.retryChargeLine(alreadyPaid)).toBeNull()
    expect(words.retryPressLabel(alreadyPaid, false)).toBe('Update the membership (no charge)')
    expect(words.retryCanPress(alreadyPaid)).toBe(true)
    // W47r-a (S3): nothing is charged then, so it needs no card; a charge can't be pressed without the card to send back.
    expect(words.retryCanPress({ ...alreadyPaid, paymentMethodId: null })).toBe(true)
    for (const cannot of [null, undefined, { ok: false, problem: 'x' }, { ...quoted, refusal: 'No.' }, { ...quoted, invoiceId: null }, { ...quoted, amount: null }, { ...quoted, amount: 0 }, { ...quoted, paymentMethodId: null }]) {
      expect(words.retryCanPress(cannot), JSON.stringify(cannot)).toBe(false)
    }
    expect(words.retryOfferAfterCard('Core')).toBe("The payment for the Core membership is overdue, and saving the card didn't take it. Try it now on the new card so the bookings waiting for payment don't lapse.")
    expect(words.retryOfferAfterCard(null)).toContain('The payment for a membership is overdue')
  })

  it('a held retry is counted with the membership changes and has a heading of its own; only one paid after its subscription ended is given a button, Mark refunded (W47r-a)', async () => {
    const list = await frontend('utils/stuckList.ts')
    expect(list.paymentRetryLabel({ customerName: 'Mo Member', cardLast4: '4444' })).toBe('Membership payment tried again on the card ending 4444, on hold · Mo Member')
    expect(list.paymentRetryLabel({ customerName: '', cardLast4: null })).toBe('Membership payment tried again, on hold')
    // W47r-a (the W47r review's S1): one the Worker gives a close is for a person, and the heading says what to do.
    const close = { kind: 'retry_paid_after_end', orderId: 'r1' }
    // W47r-b: the Worker lists a payment Stripe itself took after the membership had ended the same way (no card named),
    // so the heading of a line with a close says what it is, not that it was tried from the desk.
    expect(list.paymentRetryLabel({ customerName: 'Mo Member', cardLast4: '4444', close })).toBe('Membership payment taken on the card ending 4444 after the membership ended, to refund in Stripe · Mo Member')
    expect(list.paymentRetryLabel({ customerName: 'Mo Member', cardLast4: null, close })).toBe('Membership payment taken after the membership ended, to refund in Stripe · Mo Member')
    expect(list.closeButtonLabel('retry_paid_after_end')).toBe('Mark refunded')
    expect(list.closeDialogText('retry_paid_after_end')).toBe(
      "Checks this payment's refunds in Stripe first. If Stripe shows the whole payment refunded, it is marked as refunded and no longer listed. If not, nothing is changed and the answer says what Stripe shows. Only press this once the payment has been refunded in Stripe. Nothing is refunded by this press."
    )
    const empty = { checkout: [], flows: [], claims: [], refunds: [], warnings: [], watched: [], steps: [], paymentDates: [], watchedPayments: [], webhook: null, alert: null }
    expect(list.stuckCounts({ ...empty, paymentRetries: [{}] })).toEqual({ payments: 0, memberships: 1, watching: 0 })
    expect(list.stuckHeadline({ ...empty, paymentRetries: [{}] })).toBe('1 membership change needs attention. Each one says what to do.')
    expect(list.stuckAnythingToShow({ ...empty, paymentRetries: [{}] })).toBe(true)
    // An older Worker's list has no such field.
    expect(list.stuckCounts(empty)).toEqual({ payments: 0, memberships: 0, watching: 0 })
    const banner = source('frontend/components/StuckPaymentsBanner.tsx')
    const line = banner.slice(banner.indexOf('data?.paymentRetries?.map'), banner.indexOf('{/* Brief W40: a membership\'s cancel date'))
    expect(line).toContain('{paymentRetryLabel(item)} · {formatCurrency(item.amount)} · since {formatDateTime(item.createdAt)}')
    expect(line).toContain('{item.words}')
    // The button is the Worker's to give: `closeButton` shows nothing without a `close` (every other held retry).
    expect(line).toContain('{closeButton(item.close, `${paymentRetryLabel(item)} (${formatCurrency(item.amount)})`, item.words)}')
    expect(banner).toContain('const closeButton = (target: StuckCloseTarget | undefined, title: string, words: string) =>\n    target ? (')
  })

  it("W47r-d: a payment taken after the membership ended has a second button, Mark as owed, only where the Worker offers it; its dialog says when to use it, in the brief's words, and asks why the payment was owed", async () => {
    const list = await frontend('utils/stuckList.ts')
    expect(list.closeButtonLabel('paid_after_end_owed')).toBe('Mark as owed')
    expect(list.closeDialogText('paid_after_end_owed')).toBe(
      'Only use this if the payment was for a period the member had. If in doubt, refund it in Stripe and press Mark refunded. Marks this payment as owed, with your reason, so it is no longer listed. Nothing is refunded or changed in Stripe.'
    )
    // The first close is as it was.
    expect(list.closeButtonLabel('retry_paid_after_end')).toBe('Mark refunded')
    const banner = source('frontend/components/StuckPaymentsBanner.tsx')
    const line = banner.slice(banner.indexOf('data?.paymentRetries?.map'), banner.indexOf('{/* Brief W40: a membership\'s cancel date'))
    // Both buttons, Mark refunded first. `closeButton` shows nothing without a target, so an older Worker's line (no `closeOwed`) has one button.
    expect(line).toMatch(
      /\{closeButton\(item\.close, `\$\{paymentRetryLabel\(item\)\} \(\$\{formatCurrency\(item\.amount\)\}\)`, item\.words\)\}\s+\{closeButton\(item\.closeOwed, `\$\{paymentRetryLabel\(item\)\} \(\$\{formatCurrency\(item\.amount\)\}\)`, item\.words\)\}/
    )
    expect(line.match(/closeButton\(/g)).toHaveLength(2)
    // Each button needs Issue refunds (the Worker checks it too), and the dialog needs a reason of five characters before it can be pressed.
    expect(banner).toContain('disabled={!canIssueRefunds}')
    expect(banner).toContain('const reasonOk = reason.trim().length >= 5')
    expect(banner).toContain('<Button onClick={confirm} disabled={busy || !reasonOk}>')
    expect(banner).toContain("{target.kind === 'paid_after_end_owed' ? 'Why was this payment owed?' : 'Why are you closing it?'}")
    // The press sends the kind the Worker gave, with the reason.
    expect(banner).toContain('kind: target.kind,')
    expect(banner).toContain('reason: reason.trim(),')
    const types = source('frontend/types/paddock.ts')
    expect(types).toContain("  | 'paid_after_end_owed'")
    expect(types).toContain('  closeOwed?: StuckCloseTarget')
  })
})

describe('the screens, read as source (brief W47r item 5)', () => {
  const dialog = source('frontend/components/RetryPaymentDialog.tsx')

  it("the button is on the customer's membership when its payment is overdue, on Overview's overdue list, and offered straight after a card is saved", () => {
    const customers = source('frontend/pages/CustomersPage.tsx')
    expect(customers).toContain("{m.subscription_status === 'past_due' ? (\n                        <RetryPaymentDialog membershipId={m.id} onDone={() => trigger({ customerId }, { skipCache: true })} />")
    // After the reader has saved the card: the profile is read again and each overdue membership is offered the payment.
    expect(customers).toContain('setCardJustSaved(true)')
    expect(customers).toContain("{cardJustSaved\n          ? detail.memberships\n              .filter((m) => m.subscription_status === 'past_due')")
    expect(customers).toContain('<RetryPaymentDialog membershipId={m.id} variant="default" onDone={() => trigger({ customerId }, { skipCache: true })} />')
    expect(customers).toContain('{retryOfferAfterCard(m.plan_name)}')
    const overview = source('frontend/pages/OverviewPage.tsx')
    expect(overview).toContain('<RetryPaymentDialog membershipId={m.membership_id} onDone={() => loadPaymentAttention({}, { skipCache: true })} />')
    // The button is not inside the row's link to the customer.
    const row = overview.slice(overview.indexOf('{attentionMemberships.map((m) => ('), overview.indexOf('<RetryPaymentDialog membershipId={m.membership_id}'))
    expect(row.lastIndexOf('</Link>')).toBeGreaterThan(row.lastIndexOf('<Link'))
  })

  it('the window: Issue refunds; the quote read when it opens; the press sends what the quote showed under a key kept after no answer or a throw; no closing while a press runs; a reload on close', () => {
    expect(dialog).toContain("const disabledReason = !canIssueRefunds ? 'Needs the Issue refunds permission' : null")
    expect(dialog).toContain('const answer = (await fetchQuote({ membershipId }, { skipCache: true })) as RetryPaymentQuote | null | undefined')
    // W47r-a (S3): the card the quote named goes back with the invoice and the amount.
    expect(dialog).toContain(
      '{ membershipId, confirmedInvoiceId: quote.invoiceId, confirmedAmount: quote.amount, ...(quote.paymentMethodId ? { confirmedPaymentMethodId: quote.paymentMethodId } : {}), idempotencyKey: pressKey.current },'
    )
    expect(dialog).toContain('pressKey.current ??= crypto.randomUUID()')
    // No answer, or a throw: the key stays. Any answer: the next press (if one is allowed) is a new one.
    expect(dialog).toContain("if (!res || res.noAnswer) {\n        setResult({ paid: false, noAnswer: true, message: res?.message ?? RETRY_PAYMENT_NO_ANSWER_MESSAGE })\n        return\n      }\n      pressKey.current = null")
    expect(dialog).toContain('if (inFlight.current) return\n    pressKey.current = null\n    if (pressed.current) {\n      pressed.current = false\n      onDone()\n    }')
    expect(dialog).toContain('if (!canPress || inFlight.current ||')
  })

  it('one press: after an answer only "no answer" or a changed amount lets the window press again; a payment on hold or a decline shows its words and Close', () => {
    expect(dialog).toContain('const pressAgain = !result || result.noAnswer === true || result.amountNow !== undefined')
    expect(dialog).toContain('const canPress = retryCanPress(quote) && quoteRead && !submitting && pressAgain')
    expect(dialog).toContain('{finished || !retryCanPress(quote) || !pressAgain ? (')
    expect(dialog).toContain('const finished = Boolean(result?.paid) || onHold')
    // The amount, the card and what happens to the bookings; the result in the Worker's words.
    expect(dialog).toContain('{chargeLine ? <div className="font-medium">{chargeLine}</div> : null}')
    expect(dialog).toContain('<div>{quote.ifPaid}</div>')
    expect(dialog).toContain("<div>{result.message ?? 'The payment went through.'}</div>")
    expect(dialog).toContain('<div>{quote.refusal}</div>')
  })
})
