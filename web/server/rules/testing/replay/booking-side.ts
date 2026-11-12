import path from 'node:path'
import type { Db } from '@/server/db'
import { loadBookingMoneyLeft } from '@/server/rules/bookings/money-left'
import type { FakeStripe } from '@/server/stripe/fake'
import { staffAppDir } from '../staff-app-dir'
import type { AllowedDifference } from './compare'
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

/** A route stores its answer against the request's key, refusals included (W03-plan 2.6, as brief W06 item 5). */
export const BOOKING_IDEMPOTENCY_ROW: AllowedDifference = {
  name: "The booking route stores its answer against the request's key",
  decision: 'W03-plan 2.6 (as brief W06 item 5)',
  path: /^\.tables\.api_idempotency$/,
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
      BOOKING_IDEMPOTENCY_ROW,
    ],
  ],
  [
    'w17-n3-status-set-to-payment-needed-then-settled-again',
    [
      {
        name: 'Payment needed is refused (the old code let Settle take seat 1 again: £20 charged twice), so Settle then refuses a booking that is not awaiting payment, and price_paid stays £40',
        decision: N3,
        path: /^\.results\[[12]\](\.|$)|^\.tables\.audit_log$|^\.tables\.bookings\.added\[0\]\.price_paid$/,
      },
      BOOKING_IDEMPOTENCY_ROW,
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
      BOOKING_IDEMPOTENCY_ROW,
    ],
  ],
])

// --- W19: Settle's named differences (brief W19 item 8)

const W19 = 'Brief W19 (D-plan 1.4, 4.2; W12-7; W17 flow records)'

/** The flow's Stripe keys and metadata come from its record: `<pendingId>:charge` or `:reader-intent`, `metadata.pending_id`. */
export const SETTLE_FLOW_KEYS: AllowedDifference = {
  name: "A Settle on the card or reader is keyed from its flow record's id (`<pendingId>:charge`, `<pendingId>:reader-intent`) and names the record in its metadata",
  decision: `${W19}: keys from the record, never from the booking's updated_at`,
  path: /^\.stripeCalls\[\d+\]\.(idempotencyKey|params\.metadata(\.pending_id)?)$/,
}

/** A card Settle's record (new: the old card path wrote none) and a reader Settle's Worker marks. */
export const SETTLE_FLOW_RECORD: AllowedDifference = {
  name: "A card Settle writes its flow record pending first (pending_reader_payments, method card); a reader Settle's record carries the Worker's marks (method, channel, request id, Stripe customer, the key's mode)",
  decision: `${W19}: pending-first with method, request_id, livemode, stripe_customer_id`,
  path: /^\.tables\.pending_reader_payments(\.added\[\d+\](\.snapshot\.(method|channel|request_id|stripe_customer_id|livemode))?)?$/,
}

/**
 * The audit rows: `booking.settle` (C1) and the flow's `reader_payment.finalise` / `.cancel` in place of the old
 * machinery's `booking.card_charge_started` / `_finished` and `booking.press_finished`. booking-replay.test.ts checks
 * that every other row is exactly the golden file's, in order.
 */
export const SETTLE_AUDIT_ROWS: AllowedDifference = {
  name: "Settle's audit rows: booking.settle and the flow's reader_payment.finalise or .cancel, in place of the old card-charge and press rows",
  decision: `${W19}: audit booking.settle in C1; W12's flow rows (D-plan 4.8)`,
  path: /^\.tables\.audit_log(\.|$)/,
}

/** The card part's order says how it was paid (Q9's table), where the legacy charge route left payment_method empty. */
export const SETTLE_CARD_ORDER_METHOD: AllowedDifference = {
  name: "The card part's order records payment_method 'card' (the legacy charge route left it empty); its order and booking line are otherwise today's",
  decision: "W03-decisions Q9 (an order paid on the saved card records 'card'); W17's card C2; Q36 keeps the card part's own order and line",
  path: /^\.tables\.orders\.added\[\d+\]\.payment_method$/,
}

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

const HELD_NOT_REFUNDED: AllowedDifference = {
  name: "The gift card's row fails after the card paid: the change is held for reconcile (Q35 words), never refunded for a database fault; the booking stays confirmed with its parts claimed and no order yet, and reconcile finishes it (settle.test.ts)",
  decision: "W6-3 (a good payment is never refunded for a database fault); Wayne's Q35 (held, reconcile finishes or undoes it)",
  path: /^\.results\[1\]\.(reason|message)$|^\.stripeCalls\[1\]$|^\.tables\.(booking_guests|bookings)\.added\[0\]\.\w+$|^\.tables\.(orders|order_line_items)\.added\[1\]$|^\.tables\.gift_cards$/,
}

const R1A: AllowedDifference = {
  name: "R1a: the old statement landed after the press undid everything (£20 given back on a settled booking); the Worker's C1 is one transaction, so the settle goes through once with the store credit and gift card it took",
  decision: 'W05 review 3, finding 1 (R1a); W17 golden gap; brief W19 item 1',
  path: /^\.results\[1\](\.|$)|^\.tables\.customers$|^\.tables\.store_credit_transactions\.added\[1\]$|^\.tables\.gift_cards$/,
}

const R1A_CONTROL: AllowedDifference = {
  name: "R1a's control (store credit and the card): the late statement can't happen; the settle goes through once, the card is charged once and kept, nothing is refunded or given back",
  decision: 'W05 review 3, finding 1 (R1a control); brief W19 item 1',
  path: /^\.results\[1\](\.|$)|^\.stripeCalls\[1\]$|^\.tables\.(booking_guests|bookings)\.added\[0\]\.\w+$|^\.tables\.customers\.changed\[0\]\.store_credit_balance\[1\]$|^\.tables\.order_line_items\.added\[1\]\.(refunded_at|refund_method|card_refunded_amount)$|^\.tables\.orders\.added\[1\]\.payment_status$|^\.tables\.store_credit_transactions\.added\[1\]$/,
}

const R2C: AllowedDifference = {
  name: "R2c: a press that died after a decline kept £5 of store credit; on the Worker each declined press is undone in one transaction, so both £5 claims go back and the balance ends at £10",
  decision: 'W05 review 3, finding 2 (R2c); W17 golden gap; brief W19 item 1',
  path: /^\.tables\.customers\.changed\[0\]\.store_credit_balance\[1\]$|^\.tables\.store_credit_transactions(\.|$)/,
}

const CARD = [SETTLE_FLOW_KEYS, SETTLE_FLOW_RECORD, SETTLE_AUDIT_ROWS, BOOKING_IDEMPOTENCY_ROW, SETTLE_CARD_ORDER_METHOD]
const READER = [SETTLE_FLOW_KEYS, SETTLE_FLOW_RECORD, SETTLE_AUDIT_ROWS, BOOKING_IDEMPOTENCY_ROW]

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
  ['w05l-settle-gift-card-and-reader-undone-then-settled', CARD],
  ['w05l-settle-gift-card-row-fails', [SETTLE_FLOW_KEYS, SETTLE_FLOW_RECORD, SETTLE_AUDIT_ROWS, BOOKING_IDEMPOTENCY_ROW, HELD_NOT_REFUNDED]],
  ['w05l-settle-gift-card-answer-lost-then-cancel', [...CARD, NO_LOST_ANSWER]],
  ['w05l-settle-gift-card-and-cash-answer-lost-then-cancel', [SETTLE_AUDIT_ROWS, BOOKING_IDEMPOTENCY_ROW]],
  ['w05l-settle-gift-card-and-reader-answer-lost-then-cancel', READER],
  ['w05l-settle-answer-lost-and-the-look-fails', [SETTLE_AUDIT_ROWS, BOOKING_IDEMPOTENCY_ROW, NO_LOST_ANSWER]],
  ['w17-r1a-settle-store-credit-and-gift-card-statement-lands-late', [SETTLE_AUDIT_ROWS, BOOKING_IDEMPOTENCY_ROW, R1A]],
  ['w17-r1a-control-settle-store-credit-and-card-statement-lands-late', [...CARD, R1A_CONTROL]],
  ['w17-r2c-settle-press-dies-after-a-decline-then-declined-again', [SETTLE_FLOW_KEYS, SETTLE_FLOW_RECORD, SETTLE_AUDIT_ROWS, BOOKING_IDEMPOTENCY_ROW, R2C]],
  ['w12-settle-store-credit-and-reader', READER],
  ['w12-settle-store-credit-and-reader-cancelled', READER],
])

/** The old machinery's audit rows (bookingCardCharge, pressFinished), which the Worker's flow record replaces. */
export const OLD_SETTLE_AUDIT_ACTIONS: ReadonlySet<string> = new Set([
  'booking.card_charge_started',
  'booking.card_charge_finished',
  'booking.card_charge_parts_returned',
  'booking.press_finished',
])
/** What Settle writes on the Worker: C1's row, and the flow's finish or undo. */
export const NEW_SETTLE_AUDIT_ACTIONS: ReadonlySet<string> = new Set(['booking.settle', 'reader_payment.finalise', 'reader_payment.cancel'])
