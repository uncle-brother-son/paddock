import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { staffAppDir } from './rules/testing/staff-app-dir'

// Brief W39 item 4: the staff app's three thin customer wrappers (createCustomer, getCustomers, getCustomerDetail)
// against a stand-in for the Worker, and its screens read as source (the staff app has no test runner): the New
// Customer dialog's press key kept after no answer or a throw, closing blocked while a press runs, and the duplicate
// words shown as the Worker gives them; the customer picker and usePaymentCustomer on New Order; the Customers page
// and the profile. The wrappers through the real routes are held by the all-Worker sweep (server/rules/testing/sweep/).

const appDir = staffAppDir()
const backend = (name: string) => import(/* @vite-ignore */ path.join(appDir, 'backend/paddock', name))
const source = (file: string) => readFileSync(path.join(appDir, file), 'utf8')

const user = { email: 'jo@example.com' }
const CUSTOMER = '10000000-0000-4000-8000-000000000005'
const KEY = 'a-press-key-of-sixteen-or-more'
const success = (data: unknown) => ({ data: { ok: true, data, requestId: 'worker-request' } })
const failure = (code: string, message: string, details?: unknown) => ({ data: { ok: false, error: { code, message, ...(details !== undefined ? { details } : {}) }, requestId: 'worker-request' } })
const refused = (code: string, reason: string, message: string) => failure(code, message, { reason, message, action: 'create_customer' })
const INACTIVE = 'This staff account is inactive. Ask an admin to reactivate it.'
const DUPLICATE = 'A customer with this email address already exists'

type Sent = { path: string; method: string; headers: Record<string, string>; body?: unknown; queryParams?: unknown }

describe("the staff app's customer wrappers (brief W39 item 4)", () => {
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

  describe('createCustomer', () => {
    const dee = { firstName: 'Dee', lastName: 'Dale', email: 'Dee@Example.com', dateOfBirth: '1992-02-29' }
    const call = async (extra: Record<string, unknown> = {}) => (await backend('createCustomer.ts')).default({ params: { ...dee, ...extra }, user })
    const row = { id: CUSTOMER, first_name: 'Dee', last_name: 'Dale', email: 'dee@example.com', phone: null, date_of_birth: '1992-02-29', created_at: '2026-11-10T09:00:00.000Z', updated_at: '2026-11-10T09:00:00.000Z' }

    it("sends the fields as typed to the create route under the dialog's key, with who is signed in, and answers the new customer's row, as before", async () => {
      rawRequest.mockResolvedValue(success(row))
      expect(await call({ phone: '07700 900123', idempotencyKey: KEY })).toEqual(row)
      expect(sent()).toMatchObject({ path: '/api/v1/staff/customers', method: 'POST', body: { ...dee, phone: '07700 900123' } })
      expect(sent().headers).toMatchObject({ 'X-Staff-Email': 'jo@example.com', 'Idempotency-Key': KEY })
      // The key travels in the header only, and the wrapper changes nothing it was given (the Worker trims and lower-cases).
      expect(Object.keys(sent().body as object).sort()).toEqual(['dateOfBirth', 'email', 'firstName', 'lastName', 'phone'])
      expect((sent().body as { email: string }).email).toBe('Dee@Example.com')
    })

    it('with no key from the screen it makes one of its own, a new one each call (never none: the route refuses a press without one)', async () => {
      rawRequest.mockResolvedValue(success(row))
      await call()
      await call()
      const keys = [sent(0).headers['Idempotency-Key'], sent(1).headers['Idempotency-Key']]
      expect(keys.every((key) => typeof key === 'string' && key.length >= 16)).toBe(true)
      expect(keys[0]).not.toBe(keys[1])
    })

    it('every refusal comes back as data, `created: false` with its reason and the Worker\'s words (the old function threw them): the duplicate, each bad field, no staff record or an inactive account as `permission_denied`', async () => {
      for (const [code, reason, message] of [
        ['CONFLICT', 'duplicate_email', DUPLICATE],
        ['VALIDATION', 'first_name_required', 'First name is required'],
        ['VALIDATION', 'last_name_required', 'Last name is required'],
        ['VALIDATION', 'email_invalid', 'A valid email address is required'],
        ['VALIDATION', 'date_of_birth_invalid', 'A valid date of birth is required'],
        ['VALIDATION', 'date_of_birth_in_future', 'Date of birth cannot be in the future'],
        ['VALIDATION', 'under_18', 'Customers must be 18 or over.'],
      ] as const) {
        rawRequest.mockResolvedValue(refused(code, reason, message))
        expect(await call(), reason).toEqual({ created: false, reason, message })
      }
      rawRequest.mockResolvedValue(failure('FORBIDDEN', INACTIVE))
      expect(await call()).toEqual({ created: false, reason: 'permission_denied', message: INACTIVE })
      rawRequest.mockResolvedValue(failure('UNAUTHORISED', 'The staff app could not be authorised.'))
      expect(await call()).toEqual({ created: false, reason: 'permission_denied', message: 'The staff app could not be authorised.' })
      rawRequest.mockResolvedValue(failure('VALIDATION', 'email: Invalid input'))
      expect(await call()).toEqual({ created: false, reason: 'validation', message: 'email: Invalid input' })
    })

    it('no answer (unreachable, unreadable, still running, a fault) is `no_answer` with `noAnswer`, in words that say they may have been added; a changed press under a kept key is "check first"', async () => {
      const worker = await backend('shared/accountWorker.ts')
      for (const [what, arrange] of NO_ANSWERS) {
        arrange()
        expect(await call({ idempotencyKey: KEY }), what).toEqual({ created: false, reason: 'no_answer', message: worker.CREATE_CUSTOMER_NO_ANSWER_MESSAGE, noAnswer: true })
      }
      expect(worker.CREATE_CUSTOMER_NO_ANSWER_MESSAGE).toContain('may or may not have been added')
      expect(worker.CREATE_CUSTOMER_NO_ANSWER_MESSAGE).toContain("it won't add them twice")
      rawRequest.mockResolvedValue(failure('IDEMPOTENCY_MISMATCH', 'This Idempotency-Key was already used for a different request.'))
      expect(await call({ idempotencyKey: KEY })).toEqual({ created: false, reason: 'pressed_after_no_answer', message: worker.CREATE_CUSTOMER_PRESSED_AFTER_NO_ANSWER_MESSAGE, noAnswer: true })
      expect(worker.CREATE_CUSTOMER_PRESSED_AFTER_NO_ANSWER_MESSAGE).toContain('search for the customer')
    })
  })

  describe('getCustomers', () => {
    const fn = async (params?: Record<string, unknown>) => (await backend('getCustomers.ts')).default({ ...(params !== undefined ? { params } : {}), user })
    const rows = [{ id: CUSTOMER, first_name: 'Sam', last_name: 'Test', email: 'sam@example.com', has_saved_card: true, store_credit_balance: '30.00' }]

    it('the newest 200 with no params; a search trimmed; one customer by id (the id wins over a search); a read with its time limit and no key', async () => {
      rawRequest.mockResolvedValue(success(rows))
      expect(await fn()).toEqual(rows)
      expect(sent(0)).toMatchObject({ path: '/api/v1/staff/customers', method: 'GET' })
      expect(sent(0).queryParams).toBeUndefined()
      await fn({})
      expect(sent(1).queryParams).toBeUndefined()
      await fn({ search: '  sam test ' })
      expect(sent(2).queryParams).toEqual({ search: 'sam test' })
      await fn({ search: '   ' })
      expect(sent(3).queryParams).toBeUndefined()
      await fn({ customerId: CUSTOMER })
      expect(sent(4).queryParams).toEqual({ customerId: CUSTOMER })
      await fn({ customerId: CUSTOMER, search: 'mo' })
      expect(sent(5).queryParams).toEqual({ customerId: CUSTOMER })
      for (let index = 0; index < 6; index += 1) {
        expect(sent(index).headers['Idempotency-Key']).toBeUndefined()
        expect(sent(index).headers['X-Staff-Email']).toBe('jo@example.com')
        expect(sent(index).body).toBeUndefined()
      }
    })

    it("a refusal is thrown in the Worker's words, as every read's is (the page and the picker show the hook's error)", async () => {
      rawRequest.mockResolvedValue(failure('FORBIDDEN', INACTIVE))
      await expect(fn({ search: 'sam' })).rejects.toThrow(/This staff account is inactive/)
      rawRequest.mockRejectedValue(new Error('socket hang up'))
      await expect(fn()).rejects.toThrow(/Could not reach the Worker/)
    })

    it('a Worker that never answers is given up on after the read time limit', async () => {
      // Loaded before the clock is faked, so the read's timer is set the moment the wrapper is called.
      const { default: getCustomers } = await backend('getCustomers.ts')
      vi.useFakeTimers()
      try {
        rawRequest.mockReturnValue(new Promise(() => {}))
        const waiting = (getCustomers({ params: { search: 'sam' }, user }) as Promise<unknown>).then(
          () => 'answered',
          (err: Error) => err.message
        )
        await vi.advanceTimersByTimeAsync(15_000)
        expect(await waiting).toMatch(/didn't answer in time/)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('getCustomerDetail', () => {
    const fn = async (customerId: string) => (await backend('getCustomerDetail.ts')).default({ params: { customerId }, user })
    const detail = { memberships: [], sessionPasses: [], bookingHistory: [], storeCreditBalance: '30.00', storeCreditHistory: [], eventBookings: [] }

    it("reads the customer's own route and answers the Worker's profile unchanged; a read with its time limit and no key; a refusal is thrown", async () => {
      rawRequest.mockResolvedValue(success(detail))
      expect(await fn(CUSTOMER)).toEqual(detail)
      expect(sent()).toMatchObject({ path: `/api/v1/staff/customers/${CUSTOMER}`, method: 'GET' })
      expect(sent().headers['Idempotency-Key']).toBeUndefined()
      expect(sent().queryParams).toBeUndefined()
      // An id is one path segment, whatever is in it.
      await fn('a/b?c')
      expect(sent(1).path).toBe('/api/v1/staff/customers/a%2Fb%3Fc')
      rawRequest.mockResolvedValue(failure('FORBIDDEN', INACTIVE))
      await expect(fn(CUSTOMER)).rejects.toThrow(/This staff account is inactive/)
    })
  })

  it('none of the three holds a rule of its own: no database, no legacy API, no staff lookup, no SQL, no age or email check; each calls the Worker; the reads have the time limit and the write has none', () => {
    for (const name of ['createCustomer', 'getCustomers', 'getCustomerDetail']) {
      const code = source(`backend/paddock/${name}.ts`)
      expect(code, name).toContain('callWorker')
      for (const gone of ['paddockData', 'paddockBackendApi2', 'staffAccess', 'resolveStaffId', 'INSERT ', 'SELECT ', 'ILIKE', 'isAtLeastMinimumAge', 'EMAIL_PATTERN', 'toLowerCase', 'membershipPaymentDate', 'eventAttendance']) {
        expect(code, `${name}: ${gone}`).not.toContain(gone)
      }
    }
    for (const name of ['getCustomers', 'getCustomerDetail']) expect(source(`backend/paddock/${name}.ts`)).toContain('timeoutMs: READ_TIMEOUT_MS')
    expect(source('backend/paddock/createCustomer.ts')).not.toContain('timeoutMs')
    // The shapes the screens read are still the functions' own.
    for (const type of ['CustomerMembershipRow', 'CustomerSessionPassRow', 'CustomerBookingHistoryRow', 'StoreCreditTransactionRow', 'CustomerEventBookingRow', 'CustomerDetail']) {
      expect(source('backend/paddock/getCustomerDetail.ts'), type).toContain(`export interface ${type} {`)
    }
    expect(source('backend/paddock/getCustomers.ts')).toContain('export interface CustomerRow {')
    expect(source('backend/paddock/createCustomer.ts')).toContain('export interface CreateCustomerRow {')
  })
})

describe("the staff app's customer screens (brief W39 item 4), read as source", () => {
  it('NewCustomerDialog: a press key kept after no answer or a throw, closing blocked while a press runs', () => {
    const dialog = source('frontend/components/NewCustomerDialog.tsx')
    expect(dialog).toContain('pressKey.current ??= crypto.randomUUID()')
    expect(dialog).toContain('idempotencyKey: pressKey.current,')
    // No answer at all, or no answer as data, keeps the key; a refusal or a success starts a new one.
    expect(dialog).toMatch(/if \(!result\) \{\s+\/\/[^\n]+\s+setErrorMessage\(NO_ANSWER_MESSAGE\)\s+\} else if \('created' in result\) \{\s+\/\/[^\n]+\s+if \(!result\.noAnswer\) pressKey\.current = null\s+setErrorMessage\(result\.message \|\| 'Failed to create customer\.'\)\s+\} else \{\s+pressKey\.current = null\s+created = result\s+\}/)
    // A throw keeps the key too (nothing in the catch clears it), and says the customer may have been made.
    const submit = dialog.indexOf('async function handleSubmit')
    const thrown = dialog.slice(dialog.indexOf('} catch (err) {', submit), dialog.indexOf('} finally {', submit))
    expect(thrown).toContain('setErrorMessage(thrownCallMessage(err))')
    expect(thrown).not.toContain('pressKey')
    // The key is dropped in three places only: a refusal, a success, and when the dialog closes.
    expect(dialog.match(/pressKey\.current = null/g)).toHaveLength(3)
    // Closing: never while a press runs (the dialog's own close and the handler).
    expect(dialog).toContain('onOpenChange={(next) => (submitting ? undefined : next ? setOpen(true) : resetAndClose())}')
    expect(dialog).toMatch(/function resetAndClose\(\) \{\s+\/\/[^\n]+\s+if \(inFlight\.current\) return\s+pressKey\.current = null\s+setOpen\(false\)/)
    // One call at a time.
    expect(dialog).toMatch(/async function handleSubmit\(\) \{\s+if \(inFlight\.current\) return/)
    expect(dialog).toContain('<Button onClick={handleSubmit} disabled={submitting}>')
    expect(dialog).toMatch(/\} finally \{\s+inFlight\.current = false\s+setSubmitting\(false\)\s+\}/)
    // The new customer is handed on, and the dialog closed, only once the press has finished.
    expect(dialog).toMatch(/if \(created\) \{\s+toast\.success\('Customer created'\)\s+onCreated\(created\)\s+resetAndClose\(\)\s+\}/)
    expect(dialog.indexOf('inFlight.current = false')).toBeLessThan(dialog.indexOf("toast.success('Customer created')"))
  })

  it("NewCustomerDialog: a refusal's words are the Worker's (the duplicate words, a date that isn't one), shown where the thrown error was; its own checks before the press are unchanged", () => {
    const dialog = source('frontend/components/NewCustomerDialog.tsx')
    expect(dialog).toContain("setErrorMessage(result.message || 'Failed to create customer.')")
    for (const words of ['First name is required.', 'Last name is required.', 'A valid email address is required.', 'Date of birth is required.', 'Customers must be 18 or over.']) expect(dialog, words).toContain(`setErrorMessage('${words}')`)
    expect(dialog).toContain('firstName: firstName.trim(),')
    expect(dialog).toContain('email: email.trim(),')
    expect(dialog).toContain("...(phone.trim() ? { phone: phone.trim() } : {}),")
  })

  it('the customer picker on New Order: the search as before, the new customer selected as before, and a search that was refused or failed says so before "No customers found."', () => {
    const picker = source('frontend/components/CustomerPicker.tsx')
    expect(picker).toContain('const { data, loading, error, trigger } = useGetCustomers()')
    expect(picker).toContain('trigger({ search: search.trim() }, { skipCache: true })')
    expect(picker).toContain('<NewCustomerDialog label="New Customer" variant="outline" onCreated={onSelect} />')
    expect(picker).toMatch(
      /\{loading \? \(\s+<div className="p-3 text-sm text-muted-foreground">Searching\.\.\.<\/div>\s+\) : error \? \(\s+\/\/[^\n]+\s+<div className="p-3 text-sm text-destructive">Error: \{error\}<\/div>\s+\) : !data \|\| data\.length === 0 \? \(\s+<div className="p-3 text-sm text-muted-foreground">No customers found\.<\/div>/
    )
  })

  it('usePaymentCustomer: one customer by id, and a read that fails shows as `failed` (Try again), as before', () => {
    const hook = source('frontend/hooks/usePaymentCustomer.ts')
    expect(hook).toContain('getCustomers({ customerId }, { skipCache: true }).result.then(')
    expect(hook).toMatch(/\(\) => \{\s+if \(requestRef\.current !== requestId\) return\s+setCustomer\(null\)\s+setStatus\('failed'\)/)
  })

  it("the Customers page and the profile: the list, the search, the profile and the card row call the same hooks with the same params; the list's error is shown; a new customer goes to the top", () => {
    const page = source('frontend/pages/CustomersPage.tsx')
    expect(page).toContain('const { data, loading, error, dataAccessErrors, trigger } = useGetCustomers()')
    expect(page).toContain('trigger({})')
    expect(page).toContain('trigger({ search: trimmed }, { skipCache: true })')
    expect(page).toContain('{error ? <div className="text-destructive text-sm mb-4">Error: {error}</div> : null}')
    // W58 (W45 audit row 17): the profile's read error is shown.
    expect(page).toContain('const { data, loading, error: detailError, trigger } = useGetCustomerDetail()')
    expect(page).toContain('trigger({ customerId }, { skipCache: true })')
    expect(page).toContain('fetchCard({ customerId }, { skipCache: true })')
    expect(page).toContain('<NewCustomerDialog onCreated={handleCustomerCreated} />')
    expect(page).toMatch(/function handleCustomerCreated\(customer: CustomerRow\) \{\s+setRows\(\(prev\) => \[customer, \.\.\.prev\]\)/)
  })
})

// --- Brief W70a (the W05j calls, lead, 7 Nov: the `[ref <uuid>]` on store credit notes is hidden on screen)

describe('the reference at the end of a store credit note is hidden on screen (W05j)', () => {
  it('only that exact ending goes; any other note, and none, is shown as it is; the history shows the note through it', async () => {
    const { storeCreditNoteForDisplay } = (await import(/* @vite-ignore */ path.join(staffAppDir(), 'frontend/utils/storeCreditNote'))) as { storeCreditNoteForDisplay: (note: string | null) => string | null }
    const ref = '[ref 3f2504e0-4f89-41d3-9a0c-0305e82c3301]'
    expect(storeCreditNoteForDisplay(`Booking refund. ${ref}`)).toBe('Booking refund.')
    for (const note of ['Booking refund.', `${ref} first`, 'Booking refund. [ref 3f25]', `Booking refund.${ref}`, '']) expect(storeCreditNoteForDisplay(note), note).toBe(note)
    expect(storeCreditNoteForDisplay(null)).toBeNull()
    expect(readFileSync(path.join(staffAppDir(), 'frontend/components/StoreCreditSection.tsx'), 'utf8')).toContain('storeCreditNoteForDisplay(')
  })
})
