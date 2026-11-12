import path from 'node:path'
import { vi } from 'vitest'
import type { Db } from '@/server/db'
import { quoteAddGuest } from '@/server/rules/bookings/add-guest'
import { loadBookingMoneyLeft } from '@/server/rules/bookings/money-left'
import type { AddBookingGuestInput } from '@/contracts'
import type { FakeStripe } from '@/server/stripe/fake'
import { staffAppDir } from '../staff-app-dir'
import { seatLineLessPaidAddOns, withCanonicalGoneNumbers, type AllowedDifference, type Recording, type Row } from './compare'
import { LEGACY_BOOKING_ACTIONS, oldSide, REPLAY_USER, type ReplaySide } from './harness'
import { replayStripe } from './stripe-binding'

/*
 * W17 (D-plan 4.11 item 1): step D's side of the replay, as order-side.ts is step C's. Each slice (W18 to W24) gives
 * one old action to the Worker: its params go to the new route, and its answer comes back in the old function's shape,
 * as the staff app's thin wrapper will give it to the screen. Every other call, the setup before and the steps after,
 * still runs through the frozen copy of the old functions (legacy-booking/), so the seed state is exactly what each
 * golden file recorded, whichever actions have switched. A test file using a route mocks @/server/db/connection to the
 * replay database and sets STAFF_API_KEY, as order-side.ts's users do.
 *
 * W17 builds no route, so the one action it can give the Worker is the read with no route of its own yet:
 * getBookingRefundFigures, from server/rules/bookings/money-left.ts (its route is W21's).
 */

/** The old step D actions (LEGACY_BOOKING_ACTIONS), and the one each slice moves to the Worker. */
export const BOOKING_ACTIONS: ReadonlyMap<string, string> = new Map([
  ['setBookingSpecialRequests', 'W18'],
  ['setBookingStatus', 'W18'],
  ['settleLapsedBooking', 'W19'],
  ['finaliseReaderPayment', 'W19'],
  ['cancelReaderPayment', 'W19'],
  ['addBookingGuest', 'W20'],
  ['getBookingRefundFigures', 'W21'],
  ['refundBooking', 'W21 to W23'],
  ['removeBookingGuest', 'W22'],
  ['removeBookingAddon', 'W22'],
  ['cancelCreditBooking', 'W23'],
  ['moveBooking', 'W24'],
])

/** How the Worker answers one old action, in the old function's shape. */
export type NewBookingAction = (db: Db, params: unknown) => Promise<unknown>

/**
 * W18 on: the staff app's own thin wrapper, which calls the real route through the old side's paddockWorkerV1
 * stand-in (bindStaffRoutes), so the replay holds the wrapper and the route together to the old function. callWorker
 * puts a fresh request id into an error it throws; that id is left out so a recording repeats.
 */
export function throughStaffApp(name: string): NewBookingAction {
  return async (_db, params) => {
    const wrapper = (await import(/* @vite-ignore */ path.join(staffAppDir(), 'backend/paddock', `${name}.ts`))) as {
      default: (req: { params: unknown; user: typeof REPLAY_USER }) => Promise<unknown>
    }
    try {
      return await wrapper.default({ params, user: REPLAY_USER })
    } catch (err) {
      if (err instanceof Error) throw new Error(err.message.replace(/, request [^)]*\)$/, ')'))
      throw err
    }
  }
}

/**
 * W19: ORDER_SWITCH as it will be live once Wayne adds the booking kinds (W15's four, then `booking_changes` and
 * `reader_flows`), so a booking change that moves money isn't refused BOOKING_PATH_OFF.
 */
export const BOOKING_KINDS_ON = 'no_stripe,saved_card,reader,membership,booking_changes,reader_flows'

/** `work` with ORDER_SWITCH set to `value`, put back after it (the old side's own calls see their own). */
export async function withSwitch<T>(value: string, work: () => Promise<T>): Promise<T> {
  const before = process.env.ORDER_SWITCH
  process.env.ORDER_SWITCH = value
  try {
    return await work()
  } finally {
    if (before === undefined) delete process.env.ORDER_SWITCH
    else process.env.ORDER_SWITCH = before
  }
}

/**
 * W19 (Q18): the figures the Settle dialog sends, as the screen works them out from the booking it loaded: seat 1's
 * stored price as `amountDue`, and what the method takes after the gift card and store credit as `toCollect` (the
 * cash tick's own figure for cash, so a recorded cash mismatch still reaches the Worker as it was sent). The old
 * function's params had none.
 */
export async function withSettleFigures(db: Db, params: unknown): Promise<unknown> {
  const sent = params as { bookingId?: string; payment?: { method?: string; confirmedCashAmount?: number; giftCard?: { amount?: number }; storeCredit?: { amount?: number } } }
  if (!sent.bookingId) return params
  const seat = (
    await db.query<{ unit_price: string | null }>(
      'SELECT unit_price::text AS unit_price FROM booking_guests WHERE booking_id = $1 ORDER BY created_at, id LIMIT 1',
      [sent.bookingId]
    )
  )[0]
  if (!seat?.unit_price) return params
  const amountDue = Number.parseFloat(seat.unit_price)
  const left = Math.max(0, Math.round((amountDue - (sent.payment?.giftCard?.amount ?? 0) - (sent.payment?.storeCredit?.amount ?? 0)) * 100) / 100)
  const toCollect = sent.payment?.method === 'cash' && typeof sent.payment.confirmedCashAmount === 'number' ? sent.payment.confirmedCashAmount : left
  return { ...sent, figures: { amountDue, toCollect } }
}

/**
 * W20 (Q18): the figures the Add Guest dialog sends with a payment, as the screen has them from the Worker's quote (its
 * first call): `amountDue` the guest's seat plus the paid add-ons, and what the method takes after the gift card and
 * store credit as `toCollect` (the cash tick's own figure for cash, so a recorded cash mismatch still reaches the Worker
 * as it was sent). Read just before the call, without locking or writing. The old function's params had none.
 */
export async function withAddGuestFigures(db: Db, params: unknown): Promise<unknown> {
  const sent = params as AddBookingGuestInput & { bookingId?: string }
  if (!sent.bookingId || !sent.payment) return params
  const staff = (await db.query<{ can_manage_pricing: boolean | null }>('SELECT can_manage_pricing FROM staff WHERE email = $1', [REPLAY_USER.email]))[0]
  const quote = await quoteAddGuest(db, sent.bookingId, sent, staff?.can_manage_pricing === true)
  if (!quote) return params
  const payment = sent.payment
  const left = Math.max(0, Math.round((quote.amountDue - (payment.giftCard?.amount ?? 0) - (payment.storeCredit?.amount ?? 0)) * 100) / 100)
  const toCollect = payment.method === 'cash' && typeof payment.confirmedCashAmount === 'number' ? payment.confirmedCashAmount : left
  return { ...sent, figures: { amountDue: quote.amountDue, toCollect } }
}

/**
 * W20: Add Guest as the dialog presses it: with the figures it shows (withAddGuestFigures) and a press key. The dialog
 * keeps the key after a press that got no answer (or was refused for being sent again under it), and sends it on every
 * later press until it is closed; any other answer starts a new one. The replay models that per booking, so a press
 * after a dead one gets the first one's stored answer, or is refused if it changed, rather than adding a second guest.
 */
function addGuestAsTheDialogPresses(): NewBookingAction {
  const heldKeys = new Map<string, string>()
  return async (db, params) => {
    const bookingId = (params as { bookingId?: string }).bookingId ?? ''
    const idempotencyKey = heldKeys.get(bookingId) ?? crypto.randomUUID()
    const answer = await withSwitch(BOOKING_KINDS_ON, async () =>
      throughStaffApp('addBookingGuest')(db, { ...((await withAddGuestFigures(db, params)) as object), idempotencyKey })
    )
    const reason = (answer as { reason?: string } | null)?.reason
    if (reason === 'no_answer' || reason === 'pressed_after_no_answer') heldKeys.set(bookingId, idempotencyKey)
    else heldKeys.delete(bookingId)
    return answer
  }
}

/**
 * The actions the Worker answers so far, by old name. W17: the refund figures, straight from the rule (the old
 * function threw 'Booking not found.' for a missing booking; so does this). W18: special requests and status, through
 * the staff app's thin wrappers. W19: Settle, with the figures the dialog now sends, and the reader flows' finalise and
 * cancel, through the staff app's wrappers, which send a flow the Worker started to the Worker and an old one (old
 * Move and Add Guest, until W24 and W20) to their old body.
 */
export const BUILT_BOOKING_ACTIONS: ReadonlyMap<string, NewBookingAction> = new Map<string, NewBookingAction>([
  ['setBookingSpecialRequests', throughStaffApp('setBookingSpecialRequests')],
  ['setBookingStatus', throughStaffApp('setBookingStatus')],
  ['settleLapsedBooking', async (db, params) => withSwitch(BOOKING_KINDS_ON, async () => throughStaffApp('settleLapsedBooking')(db, await withSettleFigures(db, params)))],
  ['addBookingGuest', addGuestAsTheDialogPresses()],
  ['finaliseReaderPayment', throughStaffApp('finaliseReaderPayment')],
  ['cancelReaderPayment', throughStaffApp('cancelReaderPayment')],
  [
    'getBookingRefundFigures',
    async (db, params) => {
      const figures = await loadBookingMoneyLeft(db, (params as { bookingId: string }).bookingId)
      if (!figures) throw new Error('Booking not found.')
      return figures
    },
  ],
])

export interface BookingSideOptions {
  /** Which old actions go to the Worker (default: every built one). */
  actions?: ReadonlyMap<string, NewBookingAction>
  /** Changes an answer after the Worker gives it: how a test plants a deliberate difference. */
  adjust?: (action: string, answer: unknown) => unknown
  /** Every call, as it was made, for tests that check which side answered. */
  calls?: Array<{ action: string; side: 'new' | 'old' }>
}

/**
 * The new side: the actions in `actions` through the Worker, everything else through the old functions (the frozen
 * copies for steps C and D, the staff app's checkout for the rest), on the same database and the same fake Stripe.
 */
export function newBookingSide({ actions = BUILT_BOOKING_ACTIONS, adjust, calls }: BookingSideOptions = {}): (db: Db, stripe: FakeStripe) => ReplaySide {
  for (const action of actions.keys()) {
    if (!LEGACY_BOOKING_ACTIONS.has(action)) throw new Error(`${action} isn't one of the old step D actions.`)
  }
  return (db, stripe) => {
    const old = oldSide(db, stripe)
    replayStripe.current = stripe
    return {
      name: 'new',
      async call(action, params) {
        const built = actions.get(action)
        calls?.push({ action, side: built ? 'new' : 'old' })
        if (!built) return old.call(action, params)
        // W20: the clock moves between presses, as the old side's moves with each statement (harness.ts, tick), so two
        // presses in a row don't write rows with the same created_at, which no real presses would.
        vi.setSystemTime(Date.now() + 1)
        const answer = await built(db, params)
        return adjust ? adjust(action, answer) : answer
      },
    }
  }
}

/**
 * W05l later 1, permanent with Wayne's Q36 answer (12 Nov): a gift card part recorded against the booking with no
 * order (Move, Settle, a reader flow's finalise) counts as gift card money in the figures, where the old figures put
 * it under cash. Only the split of `left` changes: its total, the card figure and everything else stay the same.
 */
export const GIFT_CARD_PART_WITHOUT_ORDER: AllowedDifference = {
  name: 'The refund figures count a gift card part with no order as gift card money, not cash',
  decision: 'W05l later 1; W03-decisions, Wayne 12 Nov (Q36: keep today\'s way, so this stays permanent)',
  path: /^\.results\[\d+\]\.parts\.(giftCard|cash)$/,
}

const N3 =
  "N3 (D-plan section 3; lead's step D plan calls, W03-decisions 12 Nov; brief W18): the status route takes only pending, confirmed, completed and no-show, and never changes a booking awaiting payment or cancelled"

/**
 * W18: the only named differences on the new side for special requests and status, all N3's, against W17's three
 * recordings of the old setBookingStatus. Each status change is refused with its words and writes nothing, so what
 * follows sees the booking as it was. Every other scenario, and every other step, must still match exactly.
 */
export const N3_DIFFERENCES: ReadonlyMap<string, readonly AllowedDifference[]> = new Map([
  [
    'w17-n3-status-set-to-cancelled-on-a-paid-booking',
    [
      {
        name: 'Cancelled is refused (the old code cancelled the paid booking with no refund and kept its places), so the booking stays confirmed and its figures say so',
        decision: N3,
        path: /^\.results\[1\](\.|$)|^\.results\[2\]\.status$|^\.tables\.bookings\.added\[0\]\.(status|cancelled_at)$/,
      },
    ],
  ],
  [
    'w17-n3-status-set-to-payment-needed-then-settled-again',
    [
      {
        name: 'Payment needed is refused (the old code let Settle take seat 1 again: £20 charged twice), so Settle then refuses a booking that is not awaiting payment, and price_paid stays £40',
        decision: N3,
        path: /^\.results\[[12]\](\.|$)|^\.tables\.bookings\.added\[0\]\.price_paid$/,
      },
    ],
  ],
  [
    'w17-n3-status-set-to-confirmed-from-payment-needed',
    [
      {
        name: 'A booking awaiting payment is not confirmed with nothing paid: refused, and it stays payment needed',
        decision: N3,
        path: /^\.results\[1\](\.|$)|^\.tables\.bookings\.added\[0\]\.status$/,
      },
    ],
  ],
])

// --- W19: Settle's named differences (brief W19 item 8)

const W19 = 'Brief W19 (D-plan 1.4, 4.2; W12-7; W17 flow records)'

/** A flow record's label, as the comparison has it (`card_flow#N` for a Worker card record set aside: comparable). */
const FLOW_LABEL = /^(pending_reader_payments|card_flow)#\d+$/
const FLOW_KEY = /^(pending_reader_payments|card_flow)#\d+:(charge|reader-intent)$/

/**
 * The flow's Stripe keys and metadata come from its record: `<pendingId>:charge` or `:reader-intent`, and
 * `metadata.pending_id` naming it (a card charge's whole metadata is new: the legacy charge route sent none). W20 (W19
 * review later 4): only those values pass.
 */
export function flowKeys(action: string, decision: string): AllowedDifference {
  return {
    name: `${action} on the card or reader is keyed from its flow record's id (\`<pendingId>:charge\`, \`<pendingId>:reader-intent\`) and names the record in its metadata`,
    decision,
    path: /^\.stripeCalls\[\d+\]\.(idempotencyKey|params\.metadata(\.pending_id)?)$/,
    actual: (value, _expected, path) => {
      if (path.endsWith('.idempotencyKey')) return typeof value === 'string' && FLOW_KEY.test(value)
      if (path.endsWith('.pending_id')) return typeof value === 'string' && FLOW_LABEL.test(value)
      const metadata = value as Record<string, unknown> | null
      return (
        metadata !== null &&
        typeof metadata === 'object' &&
        JSON.stringify(Object.keys(metadata).sort()) === JSON.stringify(['flow', 'pending_id', 'record_id']) &&
        FLOW_LABEL.test(String(metadata['pending_id']))
      )
    },
  }
}

/** The Worker's marks on a reader flow's record (the old reader record had none), each with its one right value. */
const READER_MARK_VALUES: Readonly<Record<string, (value: unknown) => boolean>> = {
  method: (value) => value === 'reader',
  channel: (value) => value === 'staff',
  livemode: (value) => value === false,
  request_id: (value) => typeof value === 'string' && /^gone#\d+$/.test(value),
  stripe_customer_id: (value) => typeof value === 'string' && value.startsWith('cus_'),
  'gift_card.stamped_redeemed_at': (value) => typeof value === 'boolean',
}

/** A reader flow's record carries the Worker's marks; nothing else on it may differ (W19 review later 4). */
export function readerFlowMarks(action: string, decision: string): AllowedDifference {
  return {
    name: `${action} on the reader: its flow record carries the Worker's marks (method, channel, request id, Stripe customer, the key's mode, whether the gift card claim stamped it used up)`,
    decision,
    path: /^\.tables\.pending_reader_payments\.added\[\d+\]\.snapshot\.(method|channel|request_id|stripe_customer_id|livemode|gift_card\.stamped_redeemed_at)$/,
    actual: (value, expected, path) => {
      const field = /\.snapshot\.(.+)$/.exec(path)?.[1] ?? ''
      return expected === undefined && (READER_MARK_VALUES[field]?.(value) ?? false)
    },
  }
}

/** The card part's order says how it was paid (Q9's table), where the legacy charge route left payment_method empty. */
export function cardOrderMethod(decision: string): AllowedDifference {
  return {
    name: "The card part's order records payment_method 'card' (the legacy charge route left it empty); its order and booking line are otherwise today's",
    decision,
    path: /^\.tables\.orders\.added\[\d+\]\.payment_method$/,
    actual: (value, expected) => value === 'card' && expected === null,
  }
}

export const SETTLE_FLOW_KEYS = flowKeys('A Settle', `${W19}: keys from the record, never from the booking's updated_at`)
export const SETTLE_FLOW_RECORD = readerFlowMarks('A Settle', `${W19}: pending-first with method, request_id, livemode, stripe_customer_id; a card Settle's record is set aside and checked on its own (cardRecordProblems)`)
export const SETTLE_CARD_ORDER_METHOD = cardOrderMethod("W03-decisions Q9 (an order paid on the saved card records 'card'); W17's card C2; Q36 keeps the card part's own order and line")

/** The old code's overlapping-press hooks wait on its own steps, which the Worker never takes: only one press runs. */
const ONE_PRESS = (path: RegExp): AllowedDifference => ({
  name: "Two overlapping presses: the overlap is hooked on the old code's own steps (its charge route, its started row), which the Worker never takes, so only one press runs here; the Worker's race is C1's lock (settle-postgres.test.ts: two settles at once, one charge, one settle)",
  decision: `${W19}: one transaction; D-plan 4.11 item 5 (real Postgres races)`,
  path,
})

/** The old code's lost-answer hooks match its own statements; the Worker's C1 is one transaction with no lost answer to recover from. */
const NO_LOST_ANSWER: AllowedDifference = {
  name: "A lost answer on the old statement: the hook matches the old code's SQL, which the Worker doesn't run; C1 is one transaction, so the settle simply goes through once",
  decision: `${W19}: one transaction (W05 review 3, finding 1; the old machinery's press rows retired)`,
  path: /^\.results\[1\](\.|$)/,
}

/**
 * W20 (W19 review later 4): a settled booking's fields, each with the one value a settle gives it (confirmed, paid,
 * £20 paid, nothing due by, its membership credit released, seat 1 paid), in place of "any field of the booking and
 * seat 1". Other paths an allowance names pass this unchecked.
 */
const SETTLED_FIELDS = /^\.tables\.bookings\.added\[0\]\.(status|redemption_source|price_paid|payment_due_by|credit_period_id|redeemed_membership_id)$|^\.tables\.booking_guests\.added\[0\]\.pay_by$/
const SETTLED_VALUES: Readonly<Record<string, unknown>> = {
  status: 'confirmed',
  redemption_source: 'paid',
  price_paid: '20.00',
  payment_due_by: null,
  credit_period_id: null,
  redeemed_membership_id: null,
  pay_by: 'paid',
}
const settledAsDecided = (value: unknown, _expected: unknown, path: string): boolean =>
  !SETTLED_FIELDS.test(path) || SETTLED_VALUES[path.slice(path.lastIndexOf('.') + 1)] === value

const HELD_NOT_REFUNDED: AllowedDifference = {
  name: "The gift card's row fails after the card paid: the change is held for reconcile (Q35 words), never refunded for a database fault; the booking stays confirmed with its parts claimed and no order yet, and reconcile finishes it (settle.test.ts)",
  decision: "W6-3 (a good payment is never refunded for a database fault); Wayne's Q35 (held, reconcile finishes or undoes it)",
  path: new RegExp(`^\\.results\\[1\\]\\.(reason|message)$|^\\.stripeCalls\\[1\\]$|${SETTLED_FIELDS.source}|^\\.tables\\.(orders|order_line_items)\\.added\\[1\\]$|^\\.tables\\.gift_cards$`),
  actual: settledAsDecided,
}

const R1A: AllowedDifference = {
  name: "R1a: the old statement landed after the press undid everything (£20 given back on a settled booking); the Worker's C1 is one transaction, so the settle goes through once with the store credit and gift card it took",
  decision: 'W05 review 3, finding 1 (R1a); W17 golden gap; brief W19 item 1',
  path: /^\.results\[1\](\.|$)|^\.tables\.customers$|^\.tables\.store_credit_transactions\.added\[1\]$|^\.tables\.gift_cards$/,
}

const R1A_CONTROL: AllowedDifference = {
  name: "R1a's control (store credit and the card): the late statement can't happen; the settle goes through once, the card is charged once and kept, nothing is refunded or given back",
  decision: 'W05 review 3, finding 1 (R1a control); brief W19 item 1',
  path: new RegExp(
    `^\\.results\\[1\\](\\.|$)|^\\.stripeCalls\\[1\\]$|${SETTLED_FIELDS.source}|^\\.tables\\.customers\\.changed\\[0\\]\\.store_credit_balance\\[1\\]$|^\\.tables\\.order_line_items\\.added\\[1\\]\\.(refunded_at|refund_method|card_refunded_amount)$|^\\.tables\\.orders\\.added\\[1\\]\\.payment_status$|^\\.tables\\.store_credit_transactions\\.added\\[1\\]$`
  ),
  actual: settledAsDecided,
}

const R2C: AllowedDifference = {
  name: "R2c: a press that died after a decline kept £5 of store credit; on the Worker each declined press is undone in one transaction, so both £5 claims go back and the balance ends at £10",
  decision: 'W05 review 3, finding 2 (R2c); W17 golden gap; brief W19 item 1',
  path: /^\.tables\.customers\.changed\[0\]\.store_credit_balance\[1\]$|^\.tables\.store_credit_transactions(\.|$)/,
}

const CARD = [SETTLE_FLOW_KEYS, SETTLE_CARD_ORDER_METHOD]
const READER = [SETTLE_FLOW_KEYS, SETTLE_FLOW_RECORD]

/**
 * W19: every golden scenario that calls Settle, and the only differences allowed in each. Every other path must match
 * exactly. N3's Settle step (w17-n3-status-set-to-payment-needed-then-settled-again) keeps W18's N3 difference: the
 * status change is refused, so Settle refuses with the old reason.
 */
export const SETTLE_DIFFERENCES: ReadonlyMap<string, readonly AllowedDifference[]> = new Map([
  ['p1-two-settles-at-once', [...CARD, ONE_PRESS(/^\.results\[[12]\](\.|$)/)]],
  ['p1-two-settles-the-other-way-round', [...CARD, ONE_PRESS(/^\.results\[2\]$|^\.stripeCalls\[1\]$|^\.tables\.store_credit_transactions\.added\[[12]\]$/)]],
  ['w05l-settle-gift-card-and-card-then-cancel', CARD],
  ['w05l-settle-gift-card-and-reader-then-cancel', READER],
  ['w05l-settle-gift-card-and-reader-undone-then-settled', [...CARD, SETTLE_FLOW_RECORD]],
  ['w05l-settle-gift-card-row-fails', [SETTLE_FLOW_KEYS, HELD_NOT_REFUNDED]],
  ['w05l-settle-gift-card-answer-lost-then-cancel', [...CARD, NO_LOST_ANSWER]],
  ['w05l-settle-gift-card-and-cash-answer-lost-then-cancel', []],
  ['w05l-settle-gift-card-and-reader-answer-lost-then-cancel', READER],
  ['w05l-settle-answer-lost-and-the-look-fails', [NO_LOST_ANSWER]],
  ['w17-r1a-settle-store-credit-and-gift-card-statement-lands-late', [R1A]],
  ['w17-r1a-control-settle-store-credit-and-card-statement-lands-late', [...CARD, R1A_CONTROL]],
  ['w17-r2c-settle-press-dies-after-a-decline-then-declined-again', [SETTLE_FLOW_KEYS, R2C]],
  ['w12-settle-store-credit-and-reader', READER],
  ['w12-settle-store-credit-and-reader-cancelled', READER],
])

// --- W20 (W19 review later 4): the audit rows and stored answers, set aside exactly rather than allowed wholesale

/** The flows whose actions are on the Worker: their old machinery rows and their new rows are swapped, nothing else. */
export const WORKER_FLOWS: ReadonlySet<string> = new Set(['settle', 'add_guest'])

type AuditRow = Row & { action?: string; details?: Record<string, unknown> | null }

/**
 * Which flow an old machinery row (bookingCardCharge's started, finished and parts-returned rows; pressFinished's row)
 * was written for: the started row names it, the finished row's key does, a parts-returned row points at its started
 * row, and each action's press row has its own fields (Add Guest's guest and add-on lines, Settle's price paid, Move's
 * claim). Null for any other row.
 */
function oldMachineryFlow(row: AuditRow, byId: ReadonlyMap<unknown, AuditRow>): string | null {
  const details = row.details ?? {}
  switch (row.action) {
    case 'booking.card_charge_started':
      return typeof details['flow'] === 'string' ? details['flow'] : null
    case 'booking.card_charge_finished':
      return /^booking-charge:([a-z_]+):/.exec(String(details['key'] ?? ''))?.[1] ?? null
    case 'booking.card_charge_parts_returned': {
      const started = byId.get(details['startedId'])
      return started ? oldMachineryFlow(started, byId) : null
    }
    case 'booking.press_finished':
      if ('guest' in details || 'addon_lines' in details) return 'add_guest'
      if ('price_paid' in details) return 'settle'
      if ('claim' in details) return 'move'
      return null
    default:
      return null
  }
}

/** The Worker's own rows for a flow on it: C1's row, and the flow's finish or undo (W12). */
function newRowFlow(row: AuditRow): string | null {
  if (row.action === 'booking.settle') return 'settle'
  if (row.action === 'booking.guest_add') return 'add_guest'
  if (row.action === 'reader_payment.finalise' || row.action === 'reader_payment.cancel' || row.action === 'reader_payment.charge_without_record') {
    const flow = row.details?.['flow']
    return typeof flow === 'string' ? flow : null
  }
  return null
}

/** The swapped rows a recording holds: the golden file's old machinery rows, or the new side's own rows, for WORKER_FLOWS. */
export function swappedAuditRows(recording: Recording, side: 'golden' | 'new'): AuditRow[] {
  const rows = (recording.tables['audit_log']?.added ?? []) as AuditRow[]
  const byId = new Map(rows.map((row) => [row['id'], row]))
  return rows.filter((row) => {
    const flow = side === 'golden' ? oldMachineryFlow(row, byId) : newRowFlow(row)
    return flow !== null && WORKER_FLOWS.has(flow)
  })
}

const AUDIT_LABEL = /^audit_log#\d+$/

/** A card flow the Worker started for one of WORKER_FLOWS: the golden files have none (the old card paths wrote none). */
const isWorkerCardRecord = (row: Row): boolean =>
  WORKER_FLOWS.has(String(row['flow'])) && (row['snapshot'] as Record<string, unknown> | null)?.['method'] === 'card'

/** The Worker's card flow records in a new-side recording (set aside from the comparison, checked by cardRecordProblems). */
export function workerCardRecords(recording: Recording): Row[] {
  return (recording.tables['pending_reader_payments']?.added ?? []).filter(isWorkerCardRecord)
}

/**
 * A recording as the replay compares it once the Worker has an action: the swapped audit rows set aside (each side's
 * own, swappedAuditRows), the audit rows' own labels and any detail naming one left out (they shift when rows are set
 * aside); the stored answers set aside (api_idempotency: only the new side has them); on the new side, the Worker's
 * card flow records set aside and the other flow records renumbered without them (`card_flow#N` names a set-aside one
 * wherever it is mentioned); store credit notes' random refs unnumbered, and the remaining gone ids renumbered by where
 * they are first met. Everything else is compared exactly, and what was set aside is checked on its own
 * (newAuditRowProblems, storedAnswerProblems, cardRecordProblems).
 */
export function comparable(recording: Recording, side: 'golden' | 'new'): Recording {
  const swapped = new Set(swappedAuditRows(recording, side))
  const tables = { ...recording.tables }
  delete tables['api_idempotency']
  const audit = tables['audit_log']
  if (audit) {
    const added = (audit.added as AuditRow[])
      .filter((row) => !swapped.has(row))
      .map((row) => {
        const rest: AuditRow = { ...row }
        delete rest['id']
        const details = rest.details ? Object.fromEntries(Object.entries(rest.details).map(([key, value]) => [key, typeof value === 'string' && AUDIT_LABEL.test(value) ? '<audit row>' : value])) : rest.details
        return { ...rest, details }
      })
    if (added.length === 0 && audit.changed.length === 0 && audit.removed.length === 0) delete tables['audit_log']
    else tables['audit_log'] = { added, changed: audit.changed, removed: audit.removed, tied: 0 }
  }
  const relabel = new Map<string, string>()
  const flows = tables['pending_reader_payments']
  if (side === 'new' && flows) {
    let kept = 0
    let card = 0
    for (const row of flows.added) {
      const label = String(row['id'])
      relabel.set(label, isWorkerCardRecord(row) ? `card_flow#${(card += 1)}` : `pending_reader_payments#${(kept += 1)}`)
    }
    const added = flows.added.filter((row) => !isWorkerCardRecord(row))
    if (added.length === 0 && flows.changed.length === 0 && flows.removed.length === 0) delete tables['pending_reader_payments']
    else tables['pending_reader_payments'] = { ...flows, added }
  }
  let text = JSON.stringify({ ...recording, tables }).replace(/\[ref gone#\d+\]/g, '[ref gone]')
  if (relabel.size > 0) text = text.replace(/pending_reader_payments#\d+\b/g, (label) => relabel.get(label) ?? label)
  return withCanonicalGoneNumbers(JSON.parse(text) as Recording)
}

/** The fields a Worker card record's snapshot may hold for each flow: the old undo fields and the Worker's marks. */
const CARD_RECORD_FIELDS: Readonly<Record<string, readonly string[]>> = {
  settle: ['customer_id', 'description', 'booking_id', 'old_status', 'old_price_paid', 'old_payment_due_by', 'old_redemption_source', 'old_redeemed_membership_id', 'old_credit_period_id', 'old_seat1_pay_by', 'amount', 'store_credit_amount', 'gift_card'],
  add_guest: ['customer_id', 'description', 'booking_id', 'session_id', 'addon_credits', 'price_increment', 'claimed_extra_capacity', 'store_credit_amount', 'gift_card', 'guest_row_id', 'addon_line_ids'],
}
const CARD_MARKS = ['method', 'channel', 'request_id', 'livemode', 'stripe_customer_id', 'payment_method_id']

/**
 * W20 (W19 review later 4): each Worker card flow record, exactly: its flow, its status (a held one is pending), the
 * card's part, its snapshot's fields (the undo's and the Worker's marks, nothing else), the marks' values, and a
 * PaymentIntent exactly when finished. Answers the problems found.
 */
export function cardRecordProblems(recording: Recording): string[] {
  const problems: string[] = []
  for (const row of workerCardRecords(recording)) {
    const snapshot = (row['snapshot'] ?? {}) as Record<string, unknown>
    const wrong = (why: string) => problems.push(`${String(row['id'])}: ${why} (${JSON.stringify(row)})`)
    const fields = CARD_RECORD_FIELDS[String(row['flow'])] ?? []
    const extra = Object.keys(snapshot).filter((key) => !fields.includes(key) && !CARD_MARKS.includes(key))
    if (extra.length > 0) wrong(`fields ${extra.join(', ')}`)
    if (CARD_MARKS.some((key) => !(key in snapshot))) wrong('a mark missing')
    if (snapshot['channel'] !== 'staff' || typeof snapshot['request_id'] !== 'string' || snapshot['livemode'] !== false) wrong('the marks')
    if (typeof snapshot['stripe_customer_id'] !== 'string' || typeof snapshot['payment_method_id'] !== 'string') wrong('the saved card')
    if (!['pending', 'finalised', 'cancelled'].includes(String(row['status']))) wrong('status')
    if (!(Number(row['expected_amount']) > 0)) wrong('the card part')
    if (row['status'] === 'finalised' && typeof row['payment_intent_id'] !== 'string') wrong('finished with no PaymentIntent')
    if (row['order_id'] !== null) wrong('an order on the record')
    if (row['flow'] === 'add_guest' && snapshot['guest_row_id'] === undefined && Number(snapshot['price_increment'] ?? 0) !== 0) wrong('a seat price with no guest')
  }
  return problems
}

const round2 = (n: number): number => Math.round(n * 100) / 100
const sameKeys = (details: Record<string, unknown> | null | undefined, keys: readonly string[]): boolean =>
  JSON.stringify(Object.keys(details ?? {}).sort()) === JSON.stringify([...keys].sort())

/**
 * W20: what each of the Worker's own rows must say, exactly (the fields, and the sums between them). Answers the
 * problems found, empty when every row is right.
 */
export function newAuditRowProblems(recording: Recording): string[] {
  const problems: string[] = []
  for (const row of swappedAuditRows(recording, 'new')) {
    const d = row.details ?? {}
    const n = (key: string) => Number(d[key])
    const wrong = (why: string) => problems.push(`${String(row.action)}: ${why} (${JSON.stringify(d)})`)
    if (row.action === 'booking.guest_add') {
      if (!sameKeys(d, ['guestId', 'addonLineIds', 'guestAmount', 'addonsAmount', 'amountDue', 'storeCredit', 'giftCard', 'method', 'toCollect', 'orderId', 'pendingId'])) wrong('fields')
      if (round2(n('guestAmount') + n('addonsAmount')) !== n('amountDue')) wrong('amountDue is not the guest plus the paid add-ons')
      if (round2(Math.max(0, n('amountDue') - n('storeCredit') - n('giftCard'))) !== n('toCollect')) wrong('toCollect is not what is left after the parts')
      if ((n('toCollect') > 0) !== (d['method'] !== null)) wrong('a method exactly when something is collected')
      if ((d['pendingId'] !== null) !== (d['method'] === 'card' || d['method'] === 'reader')) wrong('a flow record exactly for the card or reader')
      if ((d['orderId'] !== null) !== (d['pendingId'] === null && n('amountDue') > 0)) wrong('its own order exactly when no card money is due and something is')
      if (row['entity_type'] !== 'booking' || typeof row['request_id'] !== 'string') wrong('entity or request id')
    } else if (row.action === 'booking.settle') {
      if (!sameKeys(d, ['amount', 'storeCredit', 'giftCard', 'method', 'toCollect', 'pendingId'])) wrong('fields')
      if (round2(Math.max(0, n('amount') - n('storeCredit') - n('giftCard'))) !== n('toCollect')) wrong('toCollect is not what is left after the parts')
      if ((d['pendingId'] !== null) !== (d['method'] === 'card' || d['method'] === 'reader')) wrong('a flow record exactly for the card or reader')
      if (row['entity_type'] !== 'booking' || typeof row['request_id'] !== 'string') wrong('entity or request id')
    } else if (row.action === 'reader_payment.finalise') {
      if (!sameKeys(d, ['flow', 'recordId', 'paymentIntentId', 'collected', 'orderId', 'alreadyRecorded'])) wrong('fields')
      if (!(n('collected') > 0) || typeof d['paymentIntentId'] !== 'string' || typeof d['orderId'] !== 'string') wrong('a payment, an amount and its order')
      if (row['entity_type'] !== 'reader_payment') wrong('entity')
    } else if (row.action === 'reader_payment.cancel') {
      if (!sameKeys(d, ['why', 'flow', 'recordId', 'snapshot', 'problems'])) wrong('fields')
      if (!Array.isArray(d['problems']) || (d['problems'] as unknown[]).length > 0) wrong('the undo reported a problem')
      if (row['entity_type'] !== 'reader_payment') wrong('entity')
    } else {
      wrong('an unexpected row')
    }
  }
  return problems
}

/** W20: the stored answers the new side wrote: each a finished press of a booking or flow route on the Worker. */
export function storedAnswerProblems(recording: Recording): string[] {
  const rows = (recording.tables['api_idempotency']?.added ?? []) as Row[]
  const route = /^POST \/api\/v1\/staff\/(bookings\/[^/]+\/(settle|guests|status|special-requests)|reader-flows\/[^/]+\/(finalise|cancel))$/
  return rows
    .filter((row) => row['status'] !== 'done' || !route.test(String(row['endpoint'])))
    .map((row) => `${String(row['endpoint'])}: ${String(row['status'])}`)
}

// --- W20: Add Guest's named differences (brief W20 item 5)

const W20 = 'Brief W20 (D-plan 1.3, 4.2; W12-7; W17 flow records)'

const AG_KEYS = flowKeys('An Add Guest', `${W20}: keys from the record, never from the booking's updated_at`)
const AG_READER = readerFlowMarks('An Add Guest', `${W20}: pending-first with method, request_id, livemode, stripe_customer_id; a card Add Guest's record is set aside and checked on its own (cardRecordProblems)`)
const AG_CARD_METHOD = cardOrderMethod("W03-decisions Q9 (an order paid on the saved card records 'card'); W17's card C2; Q36 keeps the card part's own order")

/**
 * W05c Noticed 5: a guest's card or reader payment writes the seat on the booking line and the paid add-ons on their
 * own lines of the same order, so the booking line is smaller by the add-ons (never below £0). The refund figures'
 * seat money is unchanged: money-left.ts's ADDONS_INSIDE_LINE took the add-ons out of the old, larger line. W20a (W20
 * review S2): checked exactly, on booking lines only (seatLineLessPaidAddOns).
 */
const AG_SEAT_LINE: AllowedDifference = {
  name: "A guest's card or reader order puts only the seat on the booking line; the paid add-ons are on their own lines of the same order",
  decision: 'W05c Noticed 5 (D-plan 2.3); brief W20 item 2; brief W20a item 4 (exact)',
  path: /^\.tables\.order_line_items\.added\[\d+\]\.(unit_price|line_total)$/,
  actual: seatLineLessPaidAddOns,
}

const AG_CARD = [AG_KEYS, AG_CARD_METHOD]
const AG_CARD_N5 = [AG_KEYS, AG_SEAT_LINE, AG_CARD_METHOD]
const AG_READER_ONLY = [AG_KEYS, AG_READER]
const AG_READER_N5 = [AG_KEYS, AG_SEAT_LINE, AG_READER]

const NO_ANSWER_WORDS = (value: unknown) => typeof value === 'string' && value.startsWith("Adding didn't get an answer")
const PRESSED_AGAIN_WORDS = (value: unknown) => typeof value === 'string' && value.startsWith("The last press didn't get an answer")

/**
 * The old press died (or Retool stopped waiting) after its charge; on the Worker the charge is inside the route, which
 * runs to the end, so the press's answer is what is lost: the screen says so and keeps the key. The next press sends
 * that key: the same request gets the first press's stored answer; a changed one is refused. One guest, paid once.
 */
const deadPressAnswerLost = (scenario: string, path: RegExp, saying: string): AllowedDifference => ({
  name: `${scenario}: the press's answer is lost after the Worker's route ran to the end (one transaction, then the card); ${saying}`,
  decision: `${W20}: C1 then the card in one route; the dialog keeps the key after no answer (W03-plan 2.6); W05 review 3 finding 2 (R2) where named`,
  path,
  actual: (value, _expected, at) => {
    if (at.endsWith('.reason')) return value === 'no_answer' || value === 'pressed_after_no_answer'
    if (at.endsWith('.message')) return NO_ANSWER_WORDS(value) || PRESSED_AGAIN_WORDS(value)
    return true
  },
})

/** The old code's overlapping-press hooks wait on its own steps (its charge route, its started row), which the Worker never takes. */
const AG_ONE_PRESS = (path: RegExp): AllowedDifference => ({
  name: "Two overlapping presses: the overlap is hooked on the old code's own steps, which the Worker never takes, so only one press runs here (one guest, one charge); the Worker's race is C1's lock (add-guest-postgres.test.ts: two presses at once)",
  decision: `${W20}: one transaction; D-plan 4.11 item 5 (real Postgres races)`,
  path,
})

/** The old code's lost-answer hooks match its own statements, which the Worker doesn't run: the add answers as done. */
const AG_NO_LOST_ANSWER = (path: RegExp): AllowedDifference => ({
  name: "A lost answer on the old statement: the hook matches the old code's SQL, which the Worker doesn't run; C1 is one transaction, so the add simply goes through once and answers with its guest",
  decision: `${W20}: one transaction (W05 review 3, finding 1; the old machinery's press rows retired)`,
  path,
})

/**
 * W20: every golden scenario that calls Add Guest and differs, and the only differences allowed in each (every other
 * path must match exactly). Add Guest scenarios paid in cash, gift card or store credit, or adding for free, match
 * their golden files exactly and are not listed (booking-replay.test.ts counts them).
 */
export const ADD_GUEST_DIFFERENCES: ReadonlyMap<string, readonly AllowedDifference[]> = new Map<string, readonly AllowedDifference[]>([
  ...[
    'q25-higher-tier-on-the-card-then-refund',
    'q25-higher-tier-on-the-card-to-store-credit',
    'q25-higher-tier-split-on-the-card-then-refund',
    'q25-guests-up-through-the-tiers-then-refund',
    'q25-guest-removed-then-another-added',
    'q25-no-promo-higher-tier-then-refund',
    'q25-public-promo-guest-on-the-card-then-refund',
    'q27-part-to-credit-higher-tier-on-the-card-then-to-the-card',
    'q27-part-to-credit-higher-tier-on-the-card-then-to-store-credit',
    'q27-no-promo-part-to-credit-higher-tier-then-to-the-card',
    'q27-cheaper-move-to-store-credit-is-not-a-part-refund',
    'q27-guest-removed-then-a-part-refund-then-a-guest',
    'remove-guest-capped-an-old-quote-refused',
    'credit-addon-with-guest-on-the-card',
    'remove-guest-more-left-than-the-seat',
    'remove-guest-capped-to-store-credit',
    'remove-guest-capped-then-cancel',
    'remove-guest-nothing-left',
    'unsure-remove-guest-store-credit-arrived',
    'all-part-refunded-with-a-guest-then-cancel',
    'remove-guest-on-the-card',
    'remove-guest-to-store-credit',
    'remove-guest-then-cancel',
    'remove-guest-while-a-reader-move-is-open',
    'reader-move-finished-then-remove-guest',
    'owed-then-a-guest-higher-tier',
    'part-refund-fails-partway',
    'part-refund-fails-partway-then-the-rest',
    'part-refund-fails-partway-then-a-same-price-move',
    'part-refund-fails-partway-then-a-guest',
    'q25-higher-tier-free-booking-then-refund',
    'credit-booking-paid-guest-removed-then-cancelled',
    'q27-part-to-card-higher-tier-on-the-card-then-to-the-card',
    'q27-two-part-refunds-then-a-higher-tier',
    'q27-guests-through-the-tiers-after-a-part-refund',
    'q27-public-booking-part-refund-is-unchanged',
    'q27-cheaper-move-is-not-a-part-refund',
    'q27-part-refund-before-a-same-price-move-still-counts',
    'q27-tier-rise-after-a-cheaper-move',
    'q28-private-part-then-guest-then-move',
    'cancel-write-fails-then-a-guest',
    'addon-with-no-guest-on-the-card-ticked',
    'q28-public-same-price-after-a-capped-remove-guest',
    'remove-guest-the-older-of-two',
    'remove-guest-both-of-two',
    'remove-guest-after-a-cheaper-move',
    'owed-then-remove-guest-stops-at-what-is-left',
  ].map((name): [string, readonly AllowedDifference[]] => [name, AG_CARD]),
  ...[
    'q25-higher-tier-guest-and-addon-on-the-card',
    'q25-guest-and-addon-both-refunded-to-the-card',
    'q25-no-promo-guest-and-addon-both-refunded-to-the-card',
    'addon-with-guest-private-card-not-ticked',
    'addon-with-guest-private-to-store-credit-ticked',
    'addon-with-guest-removed-to-the-card-then-cancel',
    'addon-with-guest-removed-to-store-credit-then-cancel',
    'addon-with-guest-part-refund-then-cancel',
    'addon-with-guest-cheaper-move-then-cancel',
    'q25-same-tier-guest-and-addon-on-the-card',
    'addon-with-guest-same-tier-ticked',
    'addon-with-guest-same-tier-not-ticked',
    'addon-with-guest-same-tier-to-store-credit-not-ticked',
    'addon-with-guest-same-tier-to-store-credit-ticked',
    'addon-with-guest-private-split-card-ticked',
    'addon-with-guest-private-split-card-not-ticked',
    'addon-with-guest-public-card-ticked',
    'addon-with-guest-public-card-not-ticked',
    'addon-with-guest-then-remove-guest-then-cancel',
    'remove-guest-their-addon-left',
    'addon-with-guest-public-split-card-ticked',
    'addon-with-guest-public-split-card-not-ticked',
  ].map((name): [string, readonly AllowedDifference[]] => [name, AG_CARD_N5]),
  ...[
    'q25-higher-tier-on-the-reader-then-refund',
    'q25-higher-tier-on-the-reader-to-store-credit',
    'q27-part-to-credit-higher-tier-on-the-reader-then-to-the-card',
    'q27-part-to-credit-higher-tier-on-the-reader-then-to-store-credit',
    'q25-higher-tier-split-on-the-reader-then-refund',
    'q25-reader-cancelled-puts-it-all-back',
    'cancel-while-a-guest-is-on-the-reader',
    'move-while-a-guest-is-on-the-reader',
    'q27-part-to-card-higher-tier-on-the-reader-then-to-the-card',
    'q27-reader-cancelled-after-a-part-refund',
  ].map((name): [string, readonly AllowedDifference[]] => [name, AG_READER_ONLY]),
  ...[
    'addon-with-guest-private-reader-ticked',
    'addon-with-guest-private-reader-not-ticked',
    'addon-with-guest-private-split-reader-ticked',
    'addon-with-guest-private-split-reader-not-ticked',
    'addon-with-guest-public-reader-ticked',
    'addon-with-guest-public-reader-not-ticked',
    'addon-with-guest-public-split-reader-ticked',
    'addon-with-guest-public-split-reader-not-ticked',
  ].map((name): [string, readonly AllowedDifference[]] => [name, AG_READER_N5]),
  ...['remove-guest-while-a-guest-is-on-the-reader', 'second-guest-while-a-guest-is-on-the-reader'].map(
    (name): [string, readonly AllowedDifference[]] => [name, [AG_KEYS, AG_CARD_METHOD, AG_READER]]
  ),
  [
    'q25-card-declined-rolls-back',
    [
      AG_KEYS,
      {
        name: "A declined card is undone by W12's flow undo in one transaction: its store credit reversal has the undo's note and no staff member (the old put-back's had its own note and the staff member); the claim and the reversal share the press's moment",
        decision: "W12's flow undo (W17's card flows; W19 report, unsure 7 and for later 1: the shared undo's words for a card flow at W25)",
        path: /^\.tables\.store_credit_transactions\.(added\[1\]\.(note|staff_id)|tied)$/,
        actual: (value, _expected, at) =>
          at.endsWith('.note') ? String(value).startsWith('Automatic reversal — the reader payment was cancelled or its finalisation failed.') : at.endsWith('.staff_id') ? value === null : value === 2,
      },
    ],
  ],
  [
    'q27-a-reversed-charge-is-not-a-part-refund',
    [
      {
        name: "Writing the guest fails inside C1, before any Stripe call: nothing is charged, so there is nothing to reverse (the old code charged £30, then refunded it); the words say nothing was added or taken",
        decision: 'W02 finding 7 (D-plan 2.1); bug 9 (every claim before any Stripe call); brief W20 item 2',
        path: /^\.results\[1\]\.(reason|message)$|^\.stripeCalls\[[12]\]$|^\.tables\.(orders|order_line_items)\.added\[1\]$/,
        actual: (value, _expected, at) => (at.endsWith('.reason') ? value === 'add_guest_not_saved' : at.endsWith('.message') ? typeof value === 'string' && value.includes('nothing was added and no payment was taken') : value === undefined),
      },
    ],
  ],
  ['dies-after-the-charge-add-guest', [...AG_CARD, deadPressAnswerLost('dies-after-the-charge-add-guest', /^\.results\[1\]\.(reason|message)$|^\.stripeCalls\[2\]$/, 'the same press again gets the stored answer, so the card is sent once (the old resume sent it again under its key)')]],
  [
    'p4-charge-lands-after-the-press-gave-up',
    [
      ...CARD,
      deadPressAnswerLost(
        'p4-charge-lands-after-the-press-gave-up',
        /^\.results\[1\]\.(reason|message)$|^\.stripeCalls\[2\]$|^\.tables\.store_credit_transactions\.added\[[12]\]$/,
        'the same press again gets the stored answer: the store credit is taken once and never given back and taken again, and the card is sent once'
      ),
    ],
  ],
  [
    'w17-r2a-add-guest-press-dies-after-the-charge-then-paid-on-the-card',
    [
      ...CARD,
      deadPressAnswerLost(
        'R2a',
        /^\.results\[2\]\.(reason|message)$|^\.results\[3\]\.(added|limitReached|guest|addonLineIds|reason|message)$|^\.stripeCalls\[2\]$|^\.tables\.(orders|order_line_items)\.added\[2\]$|^\.tables\.sessions\.changed\[0\]\.total_booked\[1\]$/,
        'the next press, on the card alone, is refused: the guest is added and paid once (£5 store credit and £15 card), where the old code took £20 more on the card and a second place'
      ),
    ],
  ],
  [
    'w17-r2b-add-guest-press-dies-after-the-charge-then-resumed-with-a-gift-card',
    [
      ...CARD,
      deadPressAnswerLost(
        'R2b',
        /^\.results\[2\]\.(reason|message)$|^\.results\[3\]\.(added|limitReached|guest|addonLineIds|reason|message)$|^\.stripeCalls\[2\]$|^\.tables\.gift_card_redemptions$/,
        'the next press, with a gift card, is refused: the guest is added and paid once (£5 store credit and £15 card), and the gift card is never touched (the old code took £5 from it and charged £15 again)'
      ),
    ],
  ],
  [
    'w17-r2d-add-guest-press-dies-while-the-worker-charges-and-writes-no-order',
    [
      AG_KEYS,
      deadPressAnswerLost(
        'R2d',
        /^\.results\[2\]\.(reason|message)$|^\.results\[3\]\.(added|limitReached|guest|addonLineIds|reason|message)$|^\.stripeCalls\[2\]$|^\.tables\.customers\.changed\[0\]\.store_credit_balance\[1\]$|^\.tables\.(orders|order_line_items)\.added\[1\]$|^\.tables\.sessions\.changed\[0\]\.total_booked\[1\]$|^\.tables\.store_credit_transactions\.added\[1\]$/,
        "the card paid and its order couldn't be written, so the change is held for reconcile (never refunded for a database fault, W6-3), with the guest added once and £5 store credit taken once; the next press is refused (the old code took the £5 again and charged £15 again). add-guest.test.ts runs reconcile on the same hold and it writes the order"
      ),
    ],
  ],
  ['p2-two-add-guests-at-once', [...AG_CARD, AG_ONE_PRESS(/^\.results\[[12]\](\.|$)/)]],
  ['p2-two-add-guests-the-other-way-round', [...AG_CARD, AG_ONE_PRESS(/^\.results\[2\]$|^\.stripeCalls\[2\]$|^\.tables\.store_credit_transactions\.added\[[12]\]$/)]],
  ['p2-add-guest-first-press-alive-a-minute-later', [...AG_CARD, AG_ONE_PRESS(/^\.results\[2\]$|^\.stripeCalls\[2\]$/)]],
  ['w05l-add-guest-gift-card-and-cash-answer-lost-then-cancel', [AG_NO_LOST_ANSWER(/^\.results\[2\]\.guest$/)]],
  ['w05l-add-guest-gift-card-and-reader-answer-lost-then-cancel', [...AG_READER_ONLY, AG_NO_LOST_ANSWER(/^\.results\[2\]\.guest$/)]],
  ['w05l-add-guest-answer-lost-and-the-look-fails', [AG_NO_LOST_ANSWER(/^\.results\[2\]\.(added|reason|message|limitReached|guest|addonLineIds)$/)]],
  [
    'w17-r1c-add-guest-store-credit-and-gift-card-statement-lands-late',
    [
      {
        name: "R1c: the old statement landed after the press had given the £15 store credit and the place back (the guest added, its money and place given away); the Worker's C1 is one transaction, so the guest is added once with the place, the £15 store credit and the £5 gift card it took",
        decision: 'W05 review 3, finding 1 (R1c); W17 golden gap; brief W20 item 2',
        path: /^\.results\[2\]\.(added|reason|limitReached|guest|addonLineIds)$|^\.tables\.sessions\.changed\[0\]\.total_booked\[1\]$|^\.tables\.store_credit_transactions\.added\[1\]$|^\.tables\.(customers|gift_cards)$/,
      },
    ],
  ],
  [
    'w17-r4a-add-guest-store-credit-claim-answer-lost-then-pressed-again',
    [
      deadPressAnswerLost(
        'R4a',
        /^\.results\[2\]\.(thrown|added|reason|message)$|^\.tables\.customers\.changed\[0\]\.store_credit_balance\[1\]$|^\.tables\.sessions\.changed\[0\]\.total_booked\[1\]$|^\.tables\.store_credit_transactions\.added\[0\]\.order_id$|^\.tables\.store_credit_transactions\.added\[1\]$/,
        'the store credit claim is inside C1, so the press went through and only its answer was lost: the same press again gets the stored answer, so £15 is taken once with its order (the old code kept the lost claim and took £15 again, and a second place)'
      ),
    ],
  ],
])
