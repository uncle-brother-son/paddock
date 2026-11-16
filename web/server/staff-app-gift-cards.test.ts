import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { staffAppDir } from './rules/testing/staff-app-dir'

// Brief W38 item 4: the staff app's five thin gift card wrappers (extendGiftCardExpiry, setGiftCardPickedUp,
// setGiftCardShipped, getGiftCards, getGiftCardRedemptions) against a stand-in for the Worker, and its screens read as
// source (the staff app has no test runner): the Extend dialog's press key kept after no answer or a throw, closing
// blocked while a press runs, the list reloaded on close, and Q46's words shown; the picked up and shipped buttons;
// New Order's gift card search. The wrappers through the real routes are held by gift-card-replay.test.ts.

const appDir = staffAppDir()
const backend = (name: string) => import(/* @vite-ignore */ path.join(appDir, 'backend/paddock', name))
const source = (file: string) => readFileSync(path.join(appDir, file), 'utf8')

const user = { email: 'jo@example.com' }
const CARD = '10000000-0000-4000-8000-000000000009'
const KEY = 'a-press-key-of-sixteen-or-more'
const success = (data: unknown) => ({ data: { ok: true, data, requestId: 'worker-request' } })
const failure = (code: string, message: string, details?: unknown) => ({ data: { ok: false, error: { code, message, ...(details !== undefined ? { details } : {}) }, requestId: 'worker-request' } })
const refused = (code: string, action: string, reason: string, message: string) => failure(code, message, { reason, message, action })
const INACTIVE = 'This staff account is inactive. Ask an admin to reactivate it.'

type Sent = { path: string; method: string; headers: Record<string, string>; body?: unknown; queryParams?: unknown }

describe("the staff app's gift card wrappers (brief W38 item 4)", () => {
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

  describe('extendGiftCardExpiry', () => {
    const call = async (extra: Record<string, unknown> = {}) => (await backend('extendGiftCardExpiry.ts')).default({ params: { giftCardId: CARD, extendByMonths: 6, ...extra }, user })
    const giftCard = { id: CARD, expiry_date: '2030-07-01', voided: false }

    it("sends the press to the card's extend route under the dialog's key, with who is signed in, and answers in the old shape", async () => {
      rawRequest.mockResolvedValue(success({ giftCard }))
      expect(await call({ idempotencyKey: KEY })).toEqual({ updated: true, giftCard })
      expect(sent()).toMatchObject({ path: `/api/v1/staff/gift-cards/${CARD}/extend`, method: 'POST', body: { extendByMonths: 6 } })
      expect(sent().headers).toMatchObject({ 'X-Staff-Email': 'jo@example.com', 'Idempotency-Key': KEY })
      expect(Object.keys(sent().body as object)).toEqual(['extendByMonths'])
    })

    it('with no key from the screen it makes one of its own, a new one each call (never none: the route refuses a press without one)', async () => {
      rawRequest.mockResolvedValue(success({ giftCard }))
      await call()
      await call()
      const keys = [sent(0).headers['Idempotency-Key'], sent(1).headers['Idempotency-Key']]
      expect(keys.every((key) => typeof key === 'string' && key.length >= 16)).toBe(true)
      expect(keys[0]).not.toBe(keys[1])
    })

    it("the old function's two reasons with no words come back with none; no permission with its words; Q46's two refusals with the reason why; no staff record or an inactive account as `permission_denied`", async () => {
      rawRequest.mockResolvedValue(refused('VALIDATION', 'gift_card_extend', 'invalid_months', 'Enter a whole number of months from 1 to 120.'))
      expect(await call()).toEqual({ updated: false, reason: 'invalid_months' })
      rawRequest.mockResolvedValue(refused('NOT_FOUND', 'gift_card_extend', 'gift_card_not_found', 'Failed to extend gift card.'))
      expect(await call()).toEqual({ updated: false, reason: 'gift_card_not_found' })
      for (const [code, reason, message] of [
        ['FORBIDDEN', 'permission_denied', 'Needs the Issue refunds permission to extend or re-activate a gift card.'],
        ['CONFLICT', 'voided_by_refund', "This gift card was voided because its order was refunded, so it can't be reactivated or extended. Its value was refunded with the order: check the order for where it went."],
        ['CONFLICT', 'voided_to_store_credit', "This gift card was voided because its balance was moved to the customer's store credit, so it can't be reactivated or extended. Its balance was moved to their store credit."],
      ] as const) {
        rawRequest.mockResolvedValue(refused(code, 'gift_card_extend', reason, message))
        expect(await call(), reason).toEqual({ updated: false, reason, message })
      }
      rawRequest.mockResolvedValue(failure('FORBIDDEN', INACTIVE))
      expect(await call()).toEqual({ updated: false, reason: 'permission_denied', message: INACTIVE })
      rawRequest.mockResolvedValue(failure('UNAUTHORISED', 'The staff app could not be authorised.'))
      expect(await call()).toEqual({ updated: false, reason: 'permission_denied', message: 'The staff app could not be authorised.' })
      rawRequest.mockResolvedValue(failure('VALIDATION', 'giftCardId: Invalid UUID'))
      expect(await call()).toEqual({ updated: false, reason: 'validation', message: 'giftCardId: Invalid UUID' })
    })

    it('no answer (unreachable, unreadable, still running, a fault) is `no_answer` with `noAnswer`, in words that say it may have gone through; a changed press under a kept key is "check first"', async () => {
      const worker = await backend('shared/accountWorker.ts')
      for (const [what, arrange] of NO_ANSWERS) {
        arrange()
        expect(await call({ idempotencyKey: KEY }), what).toEqual({ updated: false, reason: 'no_answer', message: worker.GIFT_CARD_EXTEND_NO_ANSWER_MESSAGE, noAnswer: true })
      }
      expect(worker.GIFT_CARD_EXTEND_NO_ANSWER_MESSAGE).toContain('may or may not have changed')
      expect(worker.GIFT_CARD_EXTEND_NO_ANSWER_MESSAGE).toContain("it won't add the months twice")
      rawRequest.mockResolvedValue(failure('IDEMPOTENCY_MISMATCH', 'This Idempotency-Key was already used for a different request.'))
      expect(await call({ idempotencyKey: KEY })).toEqual({ updated: false, reason: 'pressed_after_no_answer', message: worker.GIFT_CARD_EXTEND_PRESSED_AFTER_NO_ANSWER_MESSAGE, noAnswer: true })
    })

    it('with no card it answers the old reason without calling', async () => {
      expect(await call({ giftCardId: '' })).toEqual({ updated: false, reason: 'gift_card_not_found' })
      expect(rawRequest).not.toHaveBeenCalled()
    })
  })

  describe.each([
    ['setGiftCardPickedUp', 'picked-up', 'pickedUp', 'not_pickup_fulfillment', 'gift_card_picked_up', 'This gift card is not a pickup-fulfillment card'],
    ['setGiftCardShipped', 'shipped', 'shipped', 'not_shipping_fulfillment', 'gift_card_shipped', 'This gift card is not a shipping-fulfillment card'],
  ] as const)('%s', (name, route, flag, wrongMethod, action, wrongWords) => {
    const call = async (value: boolean, extra: Record<string, unknown> = {}) => (await backend(`${name}.ts`)).default({ params: { giftCardId: CARD, [flag]: value, ...extra }, user })
    const giftCard = { id: CARD, code: 'PICKUP01', picked_up: true }

    it("sends set and clear to the card's route with who is signed in and a key (the screen's, or one of its own), and answers in the old shape", async () => {
      for (const value of [true, false]) {
        rawRequest.mockClear()
        rawRequest.mockResolvedValue(success({ giftCard }))
        expect(await call(value, { idempotencyKey: KEY })).toEqual({ updated: true, giftCard })
        expect(sent()).toMatchObject({ path: `/api/v1/staff/gift-cards/${CARD}/${route}`, method: 'POST', body: { [flag]: value } })
        expect(sent().headers).toMatchObject({ 'X-Staff-Email': 'jo@example.com', 'Idempotency-Key': KEY })
        expect(Object.keys(sent().body as object)).toEqual([flag])
      }
      rawRequest.mockClear()
      await call(true)
      await call(true)
      const keys = [sent(0).headers['Idempotency-Key'], sent(1).headers['Idempotency-Key']]
      expect(keys.every((key) => typeof key === 'string' && key.length >= 16)).toBe(true)
      expect(keys[0]).not.toBe(keys[1])
    })

    it('the two old reasons with the reason alone, as before; no staff record or an inactive account as `permission_denied` with the words (the old function threw them); no answer as `no_answer`', async () => {
      rawRequest.mockResolvedValue(refused('NOT_FOUND', action, 'not_found', 'Failed to update'))
      expect(await call(true)).toEqual({ updated: false, reason: 'not_found' })
      rawRequest.mockResolvedValue(refused('CONFLICT', action, wrongMethod, wrongWords))
      expect(await call(false)).toEqual({ updated: false, reason: wrongMethod })
      rawRequest.mockResolvedValue(failure('FORBIDDEN', INACTIVE))
      expect(await call(false)).toEqual({ updated: false, reason: 'permission_denied', message: INACTIVE })
      const noRecord = "No staff record matches the logged-in user's email (jo@example.com). Ask an admin to add you as staff before performing this action."
      rawRequest.mockResolvedValue(failure('UNAUTHORISED', noRecord))
      expect(await call(false)).toEqual({ updated: false, reason: 'permission_denied', message: noRecord })
      const worker = await backend('shared/accountWorker.ts')
      for (const [what, arrange] of NO_ANSWERS) {
        arrange()
        expect(await call(true), what).toEqual({ updated: false, reason: 'no_answer', message: worker.GIFT_CARD_FLAG_NO_ANSWER_MESSAGE, noAnswer: true })
      }
      expect(worker.GIFT_CARD_FLAG_NO_ANSWER_MESSAGE).toContain('may or may not have changed')
      // W38a (review S1): on an order's page it is the order's lines that reload, so "the screen", not "the list".
      expect(worker.GIFT_CARD_FLAG_NO_ANSWER_MESSAGE).toBe("Updating the gift card didn't get an answer, so it may or may not have changed. The screen has been reloaded: check the card, and press again if it hasn't changed.")
      rawRequest.mockClear()
      expect(await call(true, { giftCardId: '' })).toEqual({ updated: false, reason: 'not_found' })
      expect(rawRequest).not.toHaveBeenCalled()
    })
  })

  describe('getGiftCards and getGiftCardRedemptions', () => {
    it('getGiftCards reads the list route (a read, with the time limit): the search trimmed and sent as a query, or none; the rows as they come; a refusal thrown, as any read', async () => {
      vi.useFakeTimers()
      try {
        const rows = [{ id: CARD, code: 'SEEDCARD', remaining_balance: '40.00', purchaser_first_name: null }]
        rawRequest.mockResolvedValue(success(rows))
        const fn = (await backend('getGiftCards.ts')).default
        expect(await fn({ params: {}, user })).toEqual(rows)
        expect(sent()).toMatchObject({ path: '/api/v1/staff/gift-cards', method: 'GET' })
        expect(sent().queryParams).toBeUndefined()
        expect(sent().headers['Idempotency-Key']).toBeUndefined()
        expect(sent().headers['X-Staff-Email']).toBe('jo@example.com')
        expect(sent().body).toBeUndefined()
        await fn({ params: { search: '  seed  ' }, user })
        expect(sent(1).queryParams).toEqual({ search: 'seed' })
        await fn({ params: { search: '   ' }, user })
        expect(sent(2).queryParams).toBeUndefined()
        await fn({ user })
        expect(sent(3).queryParams).toBeUndefined()
        // A Worker that never answers: staff are told to try again after 15 seconds, not left waiting.
        rawRequest.mockReturnValue(new Promise(() => {}))
        const waiting = fn({ params: {}, user }).catch((err: Error) => err.message)
        await vi.advanceTimersByTimeAsync(15_000)
        expect(await waiting).toContain("The booking system didn't answer in time. Please try again.")
        rawRequest.mockResolvedValue(failure('FORBIDDEN', INACTIVE))
        await expect(fn({ params: {}, user })).rejects.toThrow(/This staff account is inactive/)
      } finally {
        vi.useRealTimers()
      }
    })

    it("getGiftCardRedemptions reads the card's history route; with no card it answers an empty list without calling; a refusal thrown", async () => {
      const rows = [{ id: 'r', gift_card_id: CARD, order_id: 'o', booking_id: null, event_booking_id: null, amount_used: '5.00', redeemed_at: '2026-11-10T09:00:00.000Z' }]
      rawRequest.mockResolvedValue(success(rows))
      const fn = (await backend('getGiftCardRedemptions.ts')).default
      expect(await fn({ params: { giftCardId: CARD }, user })).toEqual(rows)
      expect(sent()).toMatchObject({ path: `/api/v1/staff/gift-cards/${CARD}/redemptions`, method: 'GET' })
      expect(sent().headers['Idempotency-Key']).toBeUndefined()
      rawRequest.mockClear()
      expect(await fn({ params: { giftCardId: '' }, user })).toEqual([])
      expect(rawRequest).not.toHaveBeenCalled()
      rawRequest.mockResolvedValue(failure('FORBIDDEN', INACTIVE))
      await expect(fn({ params: { giftCardId: CARD }, user })).rejects.toThrow(/This staff account is inactive/)
    })
  })

  it('none of the five (nor the helper the two flags share) holds a rule of its own: no database, no legacy API, no staff lookup, no SQL; each calls the Worker', () => {
    for (const name of ['extendGiftCardExpiry', 'getGiftCards', 'getGiftCardRedemptions', 'shared/giftCardFlag']) {
      const code = source(`backend/paddock/${name}.ts`)
      expect(code, name).toContain('callWorker')
      for (const gone of ['paddockData', 'paddockBackendApi2', 'staffAccess', 'resolveStaffId', 'UPDATE ', 'SELECT ', 'expiry_date +']) expect(code, `${name}: ${gone}`).not.toContain(gone)
    }
    for (const name of ['setGiftCardPickedUp', 'setGiftCardShipped']) {
      const code = source(`backend/paddock/${name}.ts`)
      expect(code, name).toContain("from './shared/giftCardFlag'")
      for (const gone of ['paddockData', 'paddockBackendApi2', 'staffAccess', 'resolveStaffId', 'UPDATE ', 'SELECT ']) expect(code, `${name}: ${gone}`).not.toContain(gone)
    }
    // The reads' time limit, and never one on a write.
    for (const name of ['getGiftCards', 'getGiftCardRedemptions']) expect(source(`backend/paddock/${name}.ts`)).toContain('timeoutMs: READ_TIMEOUT_MS')
    for (const name of ['extendGiftCardExpiry', 'shared/giftCardFlag']) expect(source(`backend/paddock/${name}.ts`)).not.toContain('timeoutMs')
  })
})

describe("the staff app's gift card screens (brief W38 item 4), read as source", () => {
  it('ExtendGiftCardDialog: a press key kept after no answer or a throw, closing blocked while a press runs, the list reloaded on close', () => {
    const dialog = source('frontend/components/ExtendGiftCardDialog.tsx')
    expect(dialog).toContain('pressKey.current ??= crypto.randomUUID()')
    expect(dialog).toContain('{ giftCardId: card.id, extendByMonths: parsedMonths, idempotencyKey: pressKey.current }')
    // No answer keeps the key and marks the reload; any answer starts a new key.
    expect(dialog).toMatch(/if \(!result \|\| result\.noAnswer\) \{\s+reloadOnClose\.current = true\s+setErrorMessage\(result\?\.message \?\? NO_ANSWER_MESSAGE\)\s+return\s+\}\s+pressKey\.current = null/)
    // A throw keeps the key too (nothing in the catch clears it), and marks the reload.
    const thrown = dialog.slice(dialog.indexOf('} catch (err) {', dialog.indexOf('async function handleSubmit')), dialog.indexOf('} finally {', dialog.indexOf('async function handleSubmit')))
    expect(thrown).toContain('reloadOnClose.current = true')
    expect(thrown).not.toContain('pressKey')
    // The key is dropped in two places only: on an answer, and when the dialog closes.
    expect(dialog.match(/pressKey\.current = null/g)).toHaveLength(2)
    // Closing: never while a press runs (the dialog's own close and the handler), and it reloads after no answer.
    expect(dialog).toContain('onOpenChange={(next) => (submitting ? undefined : next ? setOpen(true) : resetAndClose())}')
    expect(dialog).toMatch(/function resetAndClose\(\) \{\s+\/\/[^\n]+\s+if \(inFlight\.current\) return\s+pressKey\.current = null\s+if \(reloadOnClose\.current\) \{\s+reloadOnClose\.current = false\s+onReload\(\)\s+\}/)
    // One call at a time.
    expect(dialog).toMatch(/async function handleSubmit\(\) \{\s+if \(inFlight\.current\) return/)
    expect(dialog).toContain('disabled={submitting || !canIssueRefunds}')
    expect(dialog).toMatch(/\} finally \{\s+inFlight\.current = false\s+setSubmitting\(false\)\s+\}/)
    // The Gift Cards page gives it the reload.
    expect(source('frontend/pages/GiftCardsPage.tsx')).toContain('<ExtendGiftCardDialog card={card} onExtended={handleExtended} onReload={reload} />')
  })

  it("ExtendGiftCardDialog: Q46's reason is shown as the Worker gives it, and the dialog says before the press which voided cards can't come back and (Q47) where the months count from", () => {
    const dialog = source('frontend/components/ExtendGiftCardDialog.tsx')
    // Any refusal with words shows them; the two old reasons with none keep the dialog's own.
    expect(dialog).toMatch(/result\.reason === 'invalid_months'\s+\? 'Enter a whole number of months from 1 to 120\.'\s+: result\.reason === 'permission_denied'\s+\? \(result\.message \?\? 'Needs the Issue refunds permission\.'\)\s+: \(result\.message \?\? 'Failed to extend gift card\.'\)/)
    expect(dialog).toMatch(/Saving un-voids it, unless it was voided because its order was refunded\s+or because it was moved to store credit: those can't be reactivated\./)
    expect(dialog).not.toContain('Saving will un-void it and restore full usability')
    expect(dialog).toContain("const expired = card.expiry_date.slice(0, 10) < londonTodayIso()")
    expect(dialog).toContain("{expired ? 'It has already expired, so the months count from today.' : 'The months are added to its expiry date.'}")
    expect(dialog).not.toContain('not from today')
  })

  it('the Gift Cards page: one flag press per card at a time, its buttons off until the answer; a refusal, no answer or a throw reloads the list and shows the words', () => {
    const page = source('frontend/pages/GiftCardsPage.tsx')
    expect(page).toMatch(/async function withPending\(cardId: string, press: \(\) => Promise<void>\) \{\s+if \(pendingIds\.has\(cardId\)\) return/)
    expect(page.match(/disabled=\{pendingIds\.has\(card\.id\)\}/g)).toHaveLength(4)
    expect(page).toContain('await setPickedUp({ giftCardId: cardId, pickedUp: next }, { skipCache: true })')
    expect(page).toContain('await setShipped({ giftCardId: cardId, shipped: next }, { skipCache: true })')
    expect(page).toMatch(/result\?\.reason === 'not_pickup_fulfillment'\s+\? 'This gift card is not a pickup-fulfillment card'\s+: \(result\?\.message \?\? 'Failed to update pickup status'\)/)
    expect(page).toMatch(/result\?\.reason === 'not_shipping_fulfillment'\s+\? 'This gift card is not a shipping-fulfillment card'\s+: \(result\?\.message \?\? 'Failed to update shipping status'\)/)
    // Picked up: reloaded when it didn't go through, and on a throw. Shipped: always (it shows the stored time).
    expect(page).toMatch(/const result = await setPickedUp\([^\n]+\n\s+if \(!result\?\.updated\) \{\s+\/\/[^\n]+\s+reload\(\)/)
    expect(page).toMatch(/\/\/ The stored time and who, or what is stored after a refusal or no answer\.\s+reload\(\)/)
    expect(page).toMatch(/\} catch \(err\) \{\s+reload\(\)\s+toast\.error\(err instanceof Error && err\.message \? err\.message : 'Failed to update pickup status'\)/)
    expect(page).toMatch(/\} catch \(err\) \{\s+reload\(\)\s+toast\.error\(err instanceof Error && err\.message \? err\.message : 'Failed to update shipping status'\)/)
    // The list and its search, as before.
    expect(page).toContain("trigger({ ...(search.trim() ? { search: search.trim() } : {}) }, { skipCache: true })")
  })

  it("the order's line items: picked up and shipped show the Worker's words, and reload the lines after no answer or a throw; one press per line at a time, as before", () => {
    const lines = source('frontend/components/OrderLineItemsTable.tsx')
    expect(lines).toContain('await setShipped({ giftCardId: line.gift_card_id, shipped: next }, { skipCache: true })')
    expect(lines).toContain('await setPickedUp({ giftCardId: line.gift_card_id, pickedUp: next }, { skipCache: true })')
    expect(lines).toMatch(/toast\.error\(result\?\.message \?\? 'Failed to update shipping status'\)\s+if \(result\?\.noAnswer\) refresh\(\)/)
    expect(lines).toMatch(/toast\.error\(result\?\.message \?\? 'Failed to update pickup status'\)\s+if \(result\?\.noAnswer\) refresh\(\)/)
    expect(lines).toMatch(/toast\.error\(err instanceof Error && err\.message \? err\.message : 'Failed to update shipping status'\)\s+refresh\(\)/)
    expect(lines).toMatch(/toast\.error\(err instanceof Error && err\.message \? err\.message : 'Failed to update pickup status'\)\s+refresh\(\)/)
    expect(lines).toContain('const isPending = pendingIds.has(line.id)')
  })

  it("the history and New Order's gift card search still call the same two hooks, with the same params", () => {
    expect(source('frontend/components/GiftCardRedemptionHistory.tsx')).toContain('trigger({ giftCardId })')
    const payment = source('frontend/components/checkout/PaymentStep.tsx')
    expect(payment).toContain('const { data: giftCardResults, loading: giftCardSearching, error: giftCardSearchError, trigger: searchGiftCards } = useGetGiftCards()')
    expect(payment).toContain('if (giftCardSearch.trim()) searchGiftCards({ search: giftCardSearch.trim() }, { skipCache: true })')
    expect(payment).toContain('const disabled = isVoided(card) || isExpired(card) || isExhausted(card)')
  })

  it("New Order's gift card search says when the read was refused or failed (W38a, review L2): the hook's error is shown under the search box, before \"No gift cards found.\"", () => {
    const payment = source('frontend/components/checkout/PaymentStep.tsx')
    // Searching, then the error, then nothing found, then the cards: a failed read is never told as "none found".
    expect(payment).toMatch(
      /\{giftCardSearching \? \(\s+<div className="p-3 text-sm text-muted-foreground">Searching\.\.\.<\/div>\s+\) : giftCardSearchError \? \(\s+\/\/[^\n]+\s+<div className="p-3 text-sm text-destructive">Error: \{giftCardSearchError\}<\/div>\s+\) : !giftCardResults \|\| giftCardResults\.length === 0 \? \(\s+<div className="p-3 text-sm text-muted-foreground">No gift cards found\.<\/div>/
    )
    expect(payment.match(/giftCardSearchError/g)).toHaveLength(3)
  })

  it('ExtendGiftCardDialog: the months are held to 1 to 120 before the press, with the same words as the Worker (W38a, review S2; Wayne, 16 Nov)', async () => {
    const dialog = source('frontend/components/ExtendGiftCardDialog.tsx')
    const { GIFT_CARD_EXTEND_MAX_MONTHS, GIFT_CARD_EXTEND_WORDS } = await import('@/server/rules/gift-cards/failure-messages')
    expect(GIFT_CARD_EXTEND_WORDS.monthsInvalid).toBe('Enter a whole number of months from 1 to 120.')
    // The check, its words and the return come before the press is sent.
    expect(dialog).toMatch(
      new RegExp(
        String.raw`const parsedMonths = Number\.parseInt\(months, 10\)\s+//[^\n]+\s+if \(!Number\.isInteger\(parsedMonths\) \|\| parsedMonths <= 0 \|\| parsedMonths > ${GIFT_CARD_EXTEND_MAX_MONTHS}\) \{\s+setErrorMessage\('Enter a whole number of months from 1 to 120\.'\)\s+return\s+\}`
      )
    )
    expect(dialog.indexOf('parsedMonths > 120')).toBeLessThan(dialog.indexOf('await extendExpiry('))
    expect(dialog.match(/Enter a whole number of months from 1 to 120\./g)).toHaveLength(2)
    expect(dialog).not.toContain('greater than 0')
    expect(dialog).toContain('<Input type="number" min={1} max={120} step={1} value={months}')
  })
})
