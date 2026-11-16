import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { staffAppDir } from './rules/testing/staff-app-dir'

// Brief W37 item 5: the staff app's four thin wrappers (adjustCustomerStoreCredit, adjustMembershipCredits,
// getMembershipCreditAdjustments, setMembershipHerd) against a stand-in for the Worker, and its three screens read as
// source (the staff app has no test runner): the press key kept after no answer or a throw, closing blocked while a
// press runs, and a reload on close. The wrappers through the real routes are held by account-replay.test.ts.

const appDir = staffAppDir()
const backend = (name: string) => import(/* @vite-ignore */ path.join(appDir, 'backend/paddock', name))
const source = (file: string) => readFileSync(path.join(appDir, file), 'utf8')

const user = { email: 'jo@example.com' }
const MEMBERSHIP = '10000000-0000-4000-8000-000000000010'
const CUSTOMER = '10000000-0000-4000-8000-000000000005'
const KEY = 'a-press-key-of-sixteen-or-more'
const success = (data: unknown) => ({ data: { ok: true, data, requestId: 'worker-request' } })
const failure = (code: string, message: string, details?: unknown) => ({ data: { ok: false, error: { code, message, ...(details !== undefined ? { details } : {}) }, requestId: 'worker-request' } })
const refused = (code: string, action: string, reason: string, message: string) => failure(code, message, { reason, message, action })

type Sent = { path: string; method: string; headers: Record<string, string>; body?: unknown; queryParams?: unknown }

describe("the staff app's step F wrappers (brief W37 item 5)", () => {
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

  describe('adjustMembershipCredits', () => {
    const params = { membershipId: MEMBERSHIP, creditType: 'session' as const, amount: 2, reason: 'Goodwill' }
    const call = async (extra: Record<string, unknown> = {}) => (await backend('adjustMembershipCredits.ts')).default({ params: { ...params, ...extra }, user })

    it("sends the press to the membership's credits route under the dialog's key, with who is signed in, and answers in the old shape", async () => {
      const period = { period_id: 'p', credits_allocated: 6, credits_used: 0, period_start: '2026-11-10', period_end: '2026-12-09' }
      rawRequest.mockResolvedValue(success({ period }))
      expect(await call({ idempotencyKey: KEY })).toEqual({ adjusted: true, period })
      expect(sent()).toMatchObject({ path: `/api/v1/staff/memberships/${MEMBERSHIP}/credits`, method: 'POST', body: { creditType: 'session', amount: 2, reason: 'Goodwill' } })
      expect(sent().headers).toMatchObject({ 'X-Staff-Email': 'jo@example.com', 'Idempotency-Key': KEY })
      expect(Object.keys(sent().body as object).sort()).toEqual(['amount', 'creditType', 'reason'])
      rawRequest.mockResolvedValue(success({ addon_credits_remaining: 5 }))
      expect(await call({ creditType: 'addon', idempotencyKey: KEY })).toEqual({ adjusted: true, addon_credits_remaining: 5 })
    })

    it('with no key from the screen it makes one of its own, a new one each call (never none: the route refuses a press without one)', async () => {
      rawRequest.mockResolvedValue(success({ addon_credits_remaining: 5 }))
      await call()
      await call()
      const keys = [sent(0).headers['Idempotency-Key'], sent(1).headers['Idempotency-Key']]
      expect(keys.every((key) => typeof key === 'string' && key.length >= 16)).toBe(true)
      expect(keys[0]).not.toBe(keys[1])
    })

    it('every refusal comes back as `adjusted: false` with its reason and words; no staff record or an inactive account as `permission_denied`', async () => {
      for (const [code, reason, message] of [
        ['FORBIDDEN', 'permission_denied', 'Needs the Issue refunds permission to adjust membership credits.'],
        ['VALIDATION', 'amount_invalid', 'Amount must be a non-zero whole number.'],
        ['VALIDATION', 'reason_required', 'A reason is required for the audit trail'],
        ['NOT_FOUND', 'membership_not_found', 'Membership not found.'],
        ['CONFLICT', 'below_used', 'Adjustment rejected: the period would be left with 0 allocated credit(s), below the 1 already used.'],
        ['CONFLICT', 'addon_below_zero', 'Adjustment rejected: the membership would be left with -3 add-on credit(s), below zero.'],
      ] as const) {
        rawRequest.mockResolvedValue(refused(code, 'credits', reason, message))
        expect(await call(), reason).toEqual({ adjusted: false, reason, message })
      }
      rawRequest.mockResolvedValue(failure('FORBIDDEN', 'This staff account is inactive. Ask an admin to reactivate it.'))
      expect(await call()).toEqual({ adjusted: false, reason: 'permission_denied', message: 'This staff account is inactive. Ask an admin to reactivate it.' })
      rawRequest.mockResolvedValue(failure('UNAUTHORISED', 'The staff app could not be authorised.'))
      expect(await call()).toEqual({ adjusted: false, reason: 'permission_denied', message: 'The staff app could not be authorised.' })
      rawRequest.mockResolvedValue(failure('VALIDATION', 'creditType: Invalid input'))
      expect(await call()).toEqual({ adjusted: false, reason: 'validation', message: 'creditType: Invalid input' })
    })

    it('no answer (unreachable, unreadable, still running, a fault) is `no_answer` with `noAnswer`, in words that say it may have gone through; a changed press under a kept key is "check first"', async () => {
      const worker = await backend('shared/accountWorker.ts')
      for (const [what, arrange] of NO_ANSWERS) {
        arrange()
        expect(await call({ idempotencyKey: KEY }), what).toEqual({ adjusted: false, reason: 'no_answer', message: worker.CREDITS_NO_ANSWER_MESSAGE, noAnswer: true })
      }
      expect(worker.CREDITS_NO_ANSWER_MESSAGE).toContain('may or may not have changed')
      expect(worker.CREDITS_NO_ANSWER_MESSAGE).toContain("it won't apply twice")
      rawRequest.mockResolvedValue(failure('IDEMPOTENCY_MISMATCH', 'This Idempotency-Key was already used for a different request.'))
      expect(await call({ idempotencyKey: KEY })).toEqual({ adjusted: false, reason: 'pressed_after_no_answer', message: worker.CREDITS_PRESSED_AFTER_NO_ANSWER_MESSAGE, noAnswer: true })
    })

    it('with no membership it answers the old words without calling', async () => {
      expect(await call({ membershipId: '' })).toEqual({ adjusted: false, reason: 'membership_not_found', message: 'Membership not found.' })
      expect(rawRequest).not.toHaveBeenCalled()
    })
  })

  describe('getMembershipCreditAdjustments', () => {
    it("reads the membership's history route (a read, with the time limit) and gives the rows as they come", async () => {
      vi.useFakeTimers()
      try {
        const rows = [{ id: 'a', membership_id: MEMBERSHIP, staff_id: null, staff_first_name: null, staff_last_name: null, staff_email: null, staff_role: null, amount: 2, credit_type: 'session', reason: 'Goodwill', created_at: '2026-11-10T09:00:00.000Z' }]
        rawRequest.mockResolvedValue(success(rows))
        const fn = (await backend('getMembershipCreditAdjustments.ts')).default
        expect(await fn({ params: { membershipId: MEMBERSHIP }, user })).toEqual(rows)
        expect(sent()).toMatchObject({ path: `/api/v1/staff/memberships/${MEMBERSHIP}/credit-adjustments`, method: 'GET' })
        expect(sent().headers['Idempotency-Key']).toBeUndefined()
        expect(sent().body).toBeUndefined()
        // A Worker that never answers: staff are told to try again after 15 seconds, not left waiting.
        rawRequest.mockReturnValue(new Promise(() => {}))
        const waiting = fn({ params: { membershipId: MEMBERSHIP }, user }).catch((err: Error) => err.message)
        await vi.advanceTimersByTimeAsync(15_000)
        expect(await waiting).toContain("The booking system didn't answer in time. Please try again.")
        rawRequest.mockClear()
        expect(await fn({ params: { membershipId: '' }, user })).toEqual([])
        expect(rawRequest).not.toHaveBeenCalled()
        rawRequest.mockResolvedValue(failure('FORBIDDEN', 'This staff account is inactive. Ask an admin to reactivate it.'))
        await expect(fn({ params: { membershipId: MEMBERSHIP }, user })).rejects.toThrow(/This staff account is inactive/)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('setMembershipHerd', () => {
    const call = async (herd: boolean | null, extra: Record<string, unknown> = {}) => (await backend('setMembershipHerd.ts')).default({ params: { membershipId: MEMBERSHIP, herd, ...extra }, user })
    const membership = { id: MEMBERSHIP, plan_name: 'Core', subscription_status: 'active', is_herd: true, herd_override: true, addon_credits_remaining: 2 }

    it("sends on, off and cleared to the membership's Herd route under the page's key, and answers in the old shape", async () => {
      for (const herd of [true, false, null]) {
        rawRequest.mockClear()
        rawRequest.mockResolvedValue(success({ membership }))
        expect(await call(herd, { idempotencyKey: KEY })).toEqual({ updated: true, membership })
        expect(sent()).toMatchObject({ path: `/api/v1/staff/memberships/${MEMBERSHIP}/herd`, method: 'POST', body: { herd } })
        expect(sent().headers['Idempotency-Key']).toBe(KEY)
      }
    })

    it('`not_found` with the reason alone, as before; no permission with its words (the old function threw them); no answer as `no_answer`', async () => {
      rawRequest.mockResolvedValue(refused('NOT_FOUND', 'herd', 'not_found', 'Membership not found.'))
      expect(await call(true)).toEqual({ updated: false, reason: 'not_found' })
      rawRequest.mockResolvedValue(refused('FORBIDDEN', 'herd', 'permission_denied', 'Needs Issue refunds permission — this action moves money back to the customer.'))
      expect(await call(true)).toEqual({ updated: false, reason: 'permission_denied', message: 'Needs Issue refunds permission — this action moves money back to the customer.' })
      const worker = await backend('shared/accountWorker.ts')
      for (const [what, arrange] of NO_ANSWERS) {
        arrange()
        expect(await call(null, { idempotencyKey: KEY }), what).toEqual({ updated: false, reason: 'no_answer', message: worker.HERD_NO_ANSWER_MESSAGE, noAnswer: true })
      }
      expect(await call(true, { membershipId: '' })).toEqual({ updated: false, reason: 'not_found' })
    })
  })

  describe('adjustCustomerStoreCredit', () => {
    const params = { customerId: CUSTOMER, amount: 20, mode: 'add' as const, reason: 'Goodwill gesture' }
    const call = async (extra: Record<string, unknown> = {}) => (await backend('adjustCustomerStoreCredit.ts')).default({ params: { ...params, ...extra }, user })

    it("sends the press to the customer's store credit route under the dialog's key, and answers in the old shape", async () => {
      rawRequest.mockResolvedValue(success({ appliedAmount: 20, balance: 50, transactionId: 't' }))
      expect(await call({ idempotencyKey: KEY })).toEqual({ ok: true, appliedAmount: 20, balance: 50, transactionId: 't' })
      expect(sent()).toMatchObject({ path: `/api/v1/staff/customers/${CUSTOMER}/store-credit`, method: 'POST', body: { mode: 'add', amount: 20, reason: 'Goodwill gesture' } })
      expect(sent().headers).toMatchObject({ 'X-Staff-Email': 'jo@example.com', 'Idempotency-Key': KEY })
      rawRequest.mockResolvedValue(success({ appliedAmount: -10 }))
      expect(await call({ mode: 'remove', amount: 10 })).toEqual({ ok: true, appliedAmount: -10 })
    })

    it("a refusal: the input checks with the words alone, as the old function gave them; the database's three with their reason; no permission with its words", async () => {
      for (const [reason, message] of [
        ['mode_invalid', 'Mode must be "add" or "remove".'],
        ['amount_invalid', 'Amount must be greater than 0.'],
        ['reason_required', 'A reason of at least 5 characters is required.'],
      ] as const) {
        rawRequest.mockResolvedValue(refused('VALIDATION', 'store_credit', reason, message))
        expect(await call(), reason).toEqual({ ok: false, message })
      }
      for (const [code, reason, message] of [
        ['CONFLICT', 'insufficient_store_credit', 'Removing that much would take the balance below zero — the adjustment was refused.'],
        ['NOT_FOUND', 'customer_not_found', 'That customer no longer exists.'],
        ['CONFLICT', 'amount_required', 'The adjustment was refused.'],
        ['FORBIDDEN', 'permission_denied', 'Needs Issue refunds permission — this action moves money back to the customer.'],
      ] as const) {
        rawRequest.mockResolvedValue(refused(code, 'store_credit', reason, message))
        expect(await call(), reason).toEqual({ ok: false, reason, message })
      }
      rawRequest.mockResolvedValue(failure('FORBIDDEN', 'This staff account is inactive. Ask an admin to reactivate it.'))
      expect(await call()).toEqual({ ok: false, reason: 'permission_denied', message: 'This staff account is inactive. Ask an admin to reactivate it.' })
    })

    it('no answer is `no_answer` with `noAnswer`; a changed press under a kept key is "check first"; with no customer it answers the old words without calling', async () => {
      const worker = await backend('shared/accountWorker.ts')
      for (const [what, arrange] of NO_ANSWERS) {
        arrange()
        expect(await call({ idempotencyKey: KEY }), what).toEqual({ ok: false, reason: 'no_answer', message: worker.STORE_CREDIT_NO_ANSWER_MESSAGE, noAnswer: true })
      }
      expect(worker.STORE_CREDIT_NO_ANSWER_MESSAGE).toContain('may or may not have changed')
      rawRequest.mockResolvedValue(failure('IDEMPOTENCY_MISMATCH', 'This Idempotency-Key was already used for a different request.'))
      expect(await call({ idempotencyKey: KEY })).toEqual({ ok: false, reason: 'pressed_after_no_answer', message: worker.STORE_CREDIT_PRESSED_AFTER_NO_ANSWER_MESSAGE, noAnswer: true })
      rawRequest.mockClear()
      expect(await call({ customerId: '' })).toEqual({ ok: false, message: 'Customer id is required.' })
      expect(rawRequest).not.toHaveBeenCalled()
    })
  })

  it('none of the four holds a rule of its own: no database, no legacy API, no staff lookup; each calls the Worker', () => {
    for (const name of ['adjustCustomerStoreCredit', 'adjustMembershipCredits', 'getMembershipCreditAdjustments', 'setMembershipHerd']) {
      const code = source(`backend/paddock/${name}.ts`)
      expect(code, name).toContain('callWorker')
      for (const gone of ['paddockData', 'paddockBackendApi2', 'staffAccess', 'resolveStaffId', 'shared/storeCredit', 'refresh_herd_flags']) expect(code, `${name}: ${gone}`).not.toContain(gone)
    }
  })
})

describe("the staff app's screens (brief W37 item 5), read as source", () => {
  it('AdjustStoreCreditDialog: a press key kept after no answer or a throw, closing blocked while a press runs, the balance reloaded on close', () => {
    const dialog = source('frontend/components/AdjustStoreCreditDialog.tsx')
    expect(dialog).toContain('pressKey.current ??= crypto.randomUUID()')
    expect(dialog).toContain('{ customerId, amount: amountValue, mode, reason: reason.trim(), idempotencyKey: pressKey.current }')
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
    expect(dialog).toMatch(/function resetAndClose\(\) \{\s+\/\/[^\n]+\s+if \(inFlight\.current\) return\s+pressKey\.current = null\s+if \(reloadOnClose\.current\) \{\s+reloadOnClose\.current = false\s+onAdjusted\(\)\s+\}/)
    // One call at a time, as before.
    expect(dialog).toContain('if (inFlight.current) return')
    expect(dialog).toContain('disabled={submitting || !amountValid || overdraw || !reasonValid}')
  })

  it('MembershipCreditDialog: a press key kept after no answer or a throw, closing blocked while a press runs, the profile reloaded on close', () => {
    const dialog = source('frontend/components/MembershipCreditDialog.tsx')
    expect(dialog).toContain('pressKey.current ??= crypto.randomUUID()')
    expect(dialog).toContain('{ membershipId: membership.id, creditType, amount: parsed, reason: reason.trim(), idempotencyKey: pressKey.current }')
    expect(dialog).toMatch(/if \(!result \|\| result\.noAnswer\) \{\s+reloadOnClose\.current = true\s+setNoAnswerMessage\(result\?\.message \?\? NO_ANSWER_MESSAGE\)\s+return\s+\}\s+pressKey\.current = null/)
    const thrown = dialog.slice(dialog.indexOf('} catch (err) {', dialog.indexOf('async function handleSubmit')), dialog.indexOf('} finally {', dialog.indexOf('async function handleSubmit')))
    expect(thrown).toContain('reloadOnClose.current = true')
    expect(thrown).not.toContain('pressKey')
    expect(dialog.match(/pressKey\.current = null/g)).toHaveLength(2)
    // Closing: never while a press runs, and it reloads the profile after no answer.
    expect(dialog).toContain('<Dialog open={open} onOpenChange={handleOpenChange}>')
    expect(dialog).toMatch(/function handleOpenChange\(next: boolean\) \{\s+\/\/[^\n]+\s+if \(saving\) return/)
    expect(dialog).toMatch(/pressKey\.current = null\s+setNoAnswerMessage\(null\)\s+setOpen\(false\)\s+if \(reloadOnClose\.current\) \{\s+reloadOnClose\.current = false\s+onReload\(\)\s+\}/)
    // A second press can't start while one runs.
    expect(dialog).toContain('if (saving) return')
    expect(dialog).toContain('disabled={saving || !canIssueRefunds}')
    // The Customers page gives it the reload.
    expect(source('frontend/pages/CustomersPage.tsx')).toContain('onReload={() => trigger({ customerId }, { skipCache: true })}')
  })

  it('the Herd control: a key for each press, kept after no answer or a throw for the same press again, dropped on any answer for that membership; the switch off while a change is sent; the profile reloaded after anything but a success', () => {
    const page = source('frontend/pages/CustomersPage.tsx')
    expect(page).toContain('const pressed = `${m.id}:${String(next)}`')
    expect(page).toContain('const idempotencyKey = herdKeys.current.get(pressed) ?? crypto.randomUUID()')
    expect(page).toContain('herdKeys.current.set(pressed, idempotencyKey)')
    expect(page).toContain('setHerd({ membershipId: m.id, herd: next, idempotencyKey }, { skipCache: true })')
    // Only an answer that isn't "no answer" drops the keys; a throw never reaches that line.
    expect(page).toContain('if (result && !result.noAnswer) forgetKeys()')
    expect(page.match(/forgetKeys\(\)/g)).toHaveLength(1)
    // One change at a time: the switch and the reset are off until the answer.
    expect(page).toContain('if (herdSaving) return')
    expect(page).toContain('disabled={!canIssueRefunds || herdSaving !== null}')
    expect(page).toMatch(/disabled=\{herdSaving !== null\}\s+onClick=\{\(\) => handleHerdChange\(m, null\)\}/)
    expect(page).toMatch(/\} finally \{\s+setHerdSaving\(null\)\s+\}/)
    // A refusal, no answer or a throw reloads the profile and shows the words.
    expect(page).toMatch(/\} catch \(err\) \{\s+\/\/[^\n]+\s+trigger\(\{ customerId \}, \{ skipCache: true \}\)\s+toast\.error\(err instanceof Error \? err\.message : 'Failed to update Herd\.'\)/)
  })
})
