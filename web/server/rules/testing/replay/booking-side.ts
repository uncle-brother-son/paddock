import path from 'node:path'
import { vi } from 'vitest'
import type { Db } from '@/server/db'
import { quoteAddGuest } from '@/server/rules/bookings/add-guest'
import { openRefundClaimOn } from '@/server/rules/bookings/refunds'
import { quoteRemoveAddon } from '@/server/rules/bookings/remove-addon'
import { reconcileClaimNow } from '@/server/rules/orders/reconcile'
import type { AddBookingGuestInput, CancelQuote } from '@/contracts'
import type { FakeStripe } from '@/server/stripe/fake'
import { staffAppDir } from '../staff-app-dir'
import { seatLineLessPaidAddOns, withCanonicalGoneNumbers, type AllowedDifference, type Recording, type Row } from './compare'
import { LEGACY_BOOKING_ACTIONS, oldSide, REPLAY_USER, type ReplaySide } from './harness'
import { inOldSideSetup } from './scenarios'
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
 * W21: refundBooking's amount paths (Part refund, Refund the rest, It already arrived) as the dialogs press them: with
 * a press key kept after no answer (the dialog keeps it until it closes, W20a's rule), and the switch on. The wrapper
 * now answers a refusal as `failed` data (so the dialog can tell it from no answer); the dialogs show its words where
 * they showed the old function's thrown error, so the replay reads it as that throw. W23: Cancel & Refund (no amount)
 * too, as its dialog presses it: the Worker's quote for the ticked add-ons first, then the press with the quote's
 * figures as confirmed (Q18; the old params had none).
 */
function refundAsTheDialogPresses(): NewBookingAction {
  const heldKeys = new Map<string, string>()
  return async (db, params) => {
    const sent = params as { bookingId?: string; refundMethod?: string; addonLineIds?: string[]; clubCancelled?: boolean }
    const bookingId = sent.bookingId ?? ''
    let press: object = params as object
    if (!refundBuiltFor(params)) {
      // W23a: Block Session's and Block Day's dialogs ask for the club's quote.
      const quoted = (await withSwitch(BOOKING_KINDS_ON, () =>
        throughStaffApp('refundBooking')(db, {
          bookingId,
          refundMethod: sent.refundMethod,
          ...(sent.addonLineIds ? { addonLineIds: sent.addonLineIds } : {}),
          ...(sent.clubCancelled === true ? { clubCancelled: true } : {}),
        })
      )) as { quote?: CancelQuote } | null
      press = { ...(params as object), confirmed: { refund: quoted?.quote?.refund ?? 0, addonsRefund: quoted?.quote?.addonsRefund ?? 0 } }
    }
    const idempotencyKey = heldKeys.get(bookingId) ?? crypto.randomUUID()
    const answer = (await withSwitch(BOOKING_KINDS_ON, () => throughStaffApp('refundBooking')(db, { ...press, idempotencyKey }))) as {
      failed?: { message: string }
      noAnswer?: unknown
      pressedAfterNoAnswer?: unknown
    } | null
    if (answer?.noAnswer || answer?.pressedAfterNoAnswer) heldKeys.set(bookingId, idempotencyKey)
    else heldKeys.delete(bookingId)
    if (answer?.failed) throw new Error(answer.failed.message)
    await settleHeldRefund(db, bookingId)
    return answer
  }
}

/**
 * W21: a refund the Worker held (Q35): staff check the Orders page, where reconcile has settled it, before they do
 * anything else to the booking. The replay settles it as reconcile does (it never sends a refund) straight after the
 * press, and again before the booking's next step if a write the scenario made fail was still failing then.
 */
async function settleHeldRefund(db: Db, bookingId: string | undefined): Promise<void> {
  if (!bookingId || !replayStripe.current) return
  const held = await openRefundClaimOn(db, bookingId)
  if (held) await reconcileClaimNow(db, replayStripe.current, held, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID() })
}

/**
 * W22: Remove Guest as the dialog presses it: the quote, then the removal with the amount it showed (the old params
 * carry both), with a press key kept after no answer (W20a's rule) per guest, and the switch on. A refund the Worker
 * held is settled straight after, as staff would find it on the Orders page.
 */
function removeGuestAsTheDialogPresses(): NewBookingAction {
  const heldKeys = new Map<string, string>()
  return async (db, params) => {
    const guestId = (params as { guestId?: string }).guestId ?? ''
    const bookingId = await bookingOf(db, params)
    const idempotencyKey = heldKeys.get(guestId) ?? crypto.randomUUID()
    const answer = (await withSwitch(BOOKING_KINDS_ON, () => throughStaffApp('removeBookingGuest')(db, { ...(params as object), idempotencyKey }))) as { reason?: string } | null
    if (answer?.reason === 'no_answer' || answer?.reason === 'pressed_after_no_answer') heldKeys.set(guestId, idempotencyKey)
    else heldKeys.delete(guestId)
    await settleHeldRefund(db, bookingId)
    return answer
  }
}

/**
 * W22: Remove add-on as the dialog presses it: the Worker's quote first (the dialog asks for it on open), then the
 * removal with the refund it showed for the choice (`confirmedRefund`: the quote's refund for a paid add-on refunded
 * to the card or store credit, else £0), a press key kept after no answer, and the switch on. The old params had no
 * figure: the old function worked it out itself.
 */
function removeAddonAsTheDialogPresses(): NewBookingAction {
  const heldKeys = new Map<string, string>()
  return async (db, params) => {
    const sent = params as { addonLineId?: string; refund?: string }
    const lineId = sent.addonLineId ?? ''
    const bookingId = await bookingOf(db, params)
    let confirmedRefund = 0
    try {
      const quote = await quoteRemoveAddon(db, lineId)
      confirmedRefund = quote.paid && (sent.refund === 'card' || sent.refund === 'credit') ? quote.refund : 0
    } catch {
      // The quote is refused as the removal will be (the line gone, removed, or its session started): £0 is sent.
    }
    const idempotencyKey = heldKeys.get(lineId) ?? crypto.randomUUID()
    const answer = (await withSwitch(BOOKING_KINDS_ON, () => throughStaffApp('removeBookingAddon')(db, { ...sent, confirmedRefund, idempotencyKey }))) as {
      removed?: boolean
      reason?: string
    } | null
    if (answer?.reason === 'no_answer' || answer?.reason === 'pressed_after_no_answer') heldKeys.set(lineId, idempotencyKey)
    else heldKeys.delete(lineId)
    await settleHeldRefund(db, bookingId)
    return answer
  }
}

/**
 * W23: Cancel & return credit and Cancel (payment needed) as their dialogs press them: the Worker's quote for the ticked
 * add-ons first, then the press with the paid add-ons' figure it showed when staff chose a refund for them (£0 otherwise,
 * as the dialog sends it), a press key kept after no answer, and the switch on. The old params had no figure.
 */
function cancelCreditAsTheDialogPresses(): NewBookingAction {
  const heldKeys = new Map<string, string>()
  return async (db, params) => {
    const sent = params as { bookingId?: string; addonLineIds?: string[]; addonRefund?: string; clubCancelled?: boolean }
    const bookingId = sent.bookingId ?? ''
    const quoted = (await withSwitch(BOOKING_KINDS_ON, () =>
      throughStaffApp('cancelCreditBooking')(db, {
        bookingId,
        ...(sent.addonLineIds ? { addonLineIds: sent.addonLineIds } : {}),
        ...(sent.clubCancelled === true ? { clubCancelled: true } : {}),
      })
    )) as { quote?: CancelQuote } | null
    const refunded = sent.addonRefund === 'card' || sent.addonRefund === 'credit'
    const confirmed = { addonsRefund: refunded ? (quoted?.quote?.addonsRefund ?? 0) : 0 }
    const idempotencyKey = heldKeys.get(bookingId) ?? crypto.randomUUID()
    const answer = (await withSwitch(BOOKING_KINDS_ON, () => throughStaffApp('cancelCreditBooking')(db, { ...sent, confirmed, idempotencyKey }))) as { reason?: string } | null
    if (answer?.reason === 'no_answer' || answer?.reason === 'pressed_after_no_answer') heldKeys.set(bookingId, idempotencyKey)
    else heldKeys.delete(bookingId)
    await settleHeldRefund(db, bookingId)
    return answer
  }
}

/**
 * W24: Move as the dialog presses it. The quote (the dialog's "Check Price Difference") goes to the Worker's quote route
 * and its figures are kept for that booking, as the dialog keeps them on screen; the press sends them back (Q18:
 * `figures.amountDue`, signed; `toCollect` the cash tick's own figure for cash, else what the method takes after the
 * gift card and store credit), with a press key kept after no answer (W20a's rule), and the switch on. A press with no
 * quote before it (none in the golden files) asks for one first. The old params had no figures.
 */
function moveAsTheDialogPresses(): NewBookingAction {
  const heldKeys = new Map<string, string>()
  const shown = new Map<string, number>()
  return async (db, params) => {
    const sent = params as { bookingId?: string; newSessionId?: string; confirmed?: boolean; payment?: { method?: string; confirmedCashAmount?: number; giftCard?: { amount?: number }; storeCredit?: { amount?: number } } }
    const bookingId = sent.bookingId ?? ''
    const quote = async () => {
      const answer = (await withSwitch(BOOKING_KINDS_ON, () => throughStaffApp('moveBooking')(db, { bookingId, newSessionId: sent.newSessionId }))) as { priceImpact?: { amountDue: number } } | null
      if (answer?.priceImpact) shown.set(bookingId, answer.priceImpact.amountDue)
      else shown.delete(bookingId)
      return answer
    }
    if (sent.confirmed !== true) return quote()
    if (!shown.has(bookingId)) await quote()
    const amountDue = shown.get(bookingId) ?? 0
    const payment = sent.payment
    const left = Math.max(0, Math.round((amountDue - (payment?.giftCard?.amount ?? 0) - (payment?.storeCredit?.amount ?? 0)) * 100) / 100)
    const toCollect = payment?.method === 'cash' && typeof payment.confirmedCashAmount === 'number' ? payment.confirmedCashAmount : left
    const idempotencyKey = heldKeys.get(bookingId) ?? crypto.randomUUID()
    const answer = (await withSwitch(BOOKING_KINDS_ON, () => throughStaffApp('moveBooking')(db, { ...sent, figures: { amountDue, toCollect }, idempotencyKey }))) as {
      reason?: string
      priceImpact?: { amountDue: number }
    } | null
    if (answer?.reason === 'no_answer' || answer?.reason === 'pressed_after_no_answer') heldKeys.set(bookingId, idempotencyKey)
    else heldKeys.delete(bookingId)
    // A refusal over the amount carries the new figures: the dialog moves to them.
    if (answer?.priceImpact) shown.set(bookingId, answer.priceImpact.amountDue)
    await settleHeldRefund(db, bookingId)
    return answer
  }
}

/** W22: the booking an action's params are about: its booking id, or the booking of its guest or add-on line. */
async function bookingOf(db: Db, params: unknown): Promise<string | undefined> {
  const sent = (params ?? {}) as { bookingId?: string; guestId?: string; addonLineId?: string }
  if (sent.bookingId) return sent.bookingId
  if (sent.guestId) return (await db.query<{ booking_id: string }>('SELECT booking_id FROM booking_guests WHERE id = $1::uuid', [sent.guestId]))[0]?.booking_id
  if (sent.addonLineId) return (await db.query<{ booking_id: string }>('SELECT booking_id FROM addon_order_lines WHERE id = $1::uuid', [sent.addonLineId]))[0]?.booking_id
  return undefined
}

/** W21: the refundBooking calls with an amount (or about owed money); W23: the rest are Cancel & Refund. */
export function refundBuiltFor(params: unknown): boolean {
  const sent = (params ?? {}) as { amount?: unknown; refundOwed?: unknown; owedArrived?: unknown }
  return sent.amount !== undefined || sent.refundOwed === true || sent.owedArrived === true
}

/**
 * W21: actions only some of whose calls the Worker answers (the rest still run through the old function). W23: none
 * since Cancel & Refund moved.
 */
export const PARTLY_BUILT: ReadonlyMap<string, (params: unknown) => boolean> = new Map()

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
  // W21: through the staff app's thin wrapper and the figures route (W17 answered it from the rule directly).
  ['getBookingRefundFigures', throughStaffApp('getBookingRefundFigures')],
  ['refundBooking', refundAsTheDialogPresses()],
  // W22: Remove Guest and Remove add-on, through the staff app's thin wrappers as the dialogs press them.
  ['removeBookingGuest', removeGuestAsTheDialogPresses()],
  ['removeBookingAddon', removeAddonAsTheDialogPresses()],
  // W23: Cancel & return credit and Cancel (payment needed), through the staff app's thin wrapper as the dialogs press it.
  ['cancelCreditBooking', cancelCreditAsTheDialogPresses()],
  // W24: Move, through the staff app's thin wrapper as the dialog presses it.
  ['moveBooking', moveAsTheDialogPresses()],
])

export interface BookingSideOptions {
  /** Which old actions go to the Worker (default: every built one). */
  actions?: ReadonlyMap<string, NewBookingAction>
  /** Changes an answer after the Worker gives it: how a test plants a deliberate difference. */
  adjust?: (action: string, answer: unknown) => unknown
  /**
   * Every call, as it was made, for tests that check which side answered. W23: `cancel` marks Cancel & Refund and Cancel &
   * return credit. W24: `setup` marks a call a scenario runs on the old side (onTheOldSide).
   */
  calls?: Array<{ action: string; side: 'new' | 'old'; cancel?: boolean; setup?: boolean }>
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
        // W24: a setup step the scenario runs through the frozen copy (onTheOldSide).
        if (inOldSideSetup()) {
          calls?.push({ action, side: 'old', setup: true })
          return old.call(action, params)
        }
        // W21: a refund still held from an earlier step is settled first, as staff would find it (settleHeldRefund). W22:
        // a Remove Guest or Remove add-on call names its guest or line, not the booking.
        await settleHeldRefund(db, await bookingOf(db, params))
        const found = actions.get(action)
        // W21: refundBooking's Cancel & Refund stays on the old function (W23).
        const built = found && (PARTLY_BUILT.get(action)?.(params) ?? true) ? found : undefined
        const cancel = action === 'cancelCreditBooking' || (action === 'refundBooking' && !refundBuiltFor(params))
        calls?.push({ action, side: built ? 'new' : 'old', ...(cancel ? { cancel: true } : {}) })
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
  // W24 (W20 review later 1): every path with its one value, where the stripe call, the order rows and the gift card
  // table let any value through: the old reversal refund gone, no card order yet (held), the £5 gift card claimed once.
  actual: (value, expected, path) => {
    if (path === '.stripeCalls[1]') return value === undefined && (expected as { method?: string; idempotencyKey?: string } | undefined)?.method === 'refunds.create' && String((expected as { idempotencyKey?: string }).idempotencyKey).startsWith('reverse-charge:')
    if (/^\.tables\.(orders|order_line_items)\.added\[1\]$/.test(path)) return value === undefined
    if (path === '.tables.gift_cards') return expected === undefined && JSON.stringify((value as { changed?: unknown } | undefined)?.changed) === JSON.stringify([{ id: '10000000-0000-4000-8000-000000000009', remaining_balance: ['40.00', '35.00'] }])
    if (path.endsWith('.reason')) return value === 'paid_not_finished'
    if (path.endsWith('.message')) return typeof value === 'string' && value.startsWith("The card payment went through, but the change couldn't be finished.")
    return settledAsDecided(value, expected, path)
  },
}

const R1A: AllowedDifference = {
  name: "R1a: the old statement landed after the press undid everything (£20 given back on a settled booking); the Worker's C1 is one transaction, so the settle goes through once with the store credit and gift card it took",
  decision: 'W05 review 3, finding 1 (R1a); W17 golden gap; brief W19 item 1',
  path: /^\.results\[1\](\.|$)|^\.tables\.customers$|^\.tables\.store_credit_transactions\.added\[1\]$|^\.tables\.gift_cards$/,
  // W24 (W20 review later 1): each value, where the whole tables went unchecked: settled with £20 charged; no store
  // credit given back (the member's balance ends where the scenario's top-up began) and no reversal row; the £5 gift
  // card claimed once.
  actual: (value, expected, path) => {
    if (path === '.results[1].settled') return value === true
    if (path === '.results[1].reason' || path === '.results[1].message') return value === undefined
    if (path === '.results[1].booking') return JSON.stringify(value) === JSON.stringify({ id: 'bookings#1', status: 'confirmed', redemption_source: 'paid', price_paid: '20.00', payment_due_by: null })
    if (path === '.results[1].amountCharged') return value === 20
    if (path === '.tables.customers' || path === '.tables.store_credit_transactions.added[1]') return value === undefined
    if (path === '.tables.gift_cards') return expected === undefined && JSON.stringify((value as { changed?: unknown } | undefined)?.changed) === JSON.stringify([{ id: '10000000-0000-4000-8000-000000000009', remaining_balance: ['40.00', '35.00'] }])
    return false
  },
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
export const WORKER_FLOWS: ReadonlySet<string> = new Set(['settle', 'add_guest', 'move'])

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
  // W24: Move's own row (a cheaper move's is R2's, set aside with its claim's rows below).
  if (row.action === 'booking.move') return 'move'
  if (row.action === 'reader_payment.finalise' || row.action === 'reader_payment.cancel' || row.action === 'reader_payment.charge_without_record') {
    const flow = row.details?.['flow']
    return typeof flow === 'string' ? flow : null
  }
  return null
}

/** W21: the refund kinds now on the Worker (Part refund, Refund the rest; W22: Remove Guest; W23: Cancel & Refund); Move's stays old. */
const REFUND_KINDS_ON_WORKER: ReadonlySet<string> = new Set(['part_refund', 'refund_owed', 'remove_guest', 'cancel', 'move'])
/**
 * W21: the actions' own rows, written only by those actions (the old functions' and the Worker's). W22: Remove Guest's
 * and Remove add-on's (the Worker's only: the old functions wrote none).
 */
const REFUND_ACTION_ROWS: ReadonlySet<string> = new Set([
  'booking.part_refund',
  'booking.refund_owed',
  'booking.refund_owed_arrived',
  'booking.guest_remove',
  'booking.addon_remove',
  // W23: Cancel & Refund's and Cancel & return credit's (the Worker's only).
  'booking.cancel',
  'booking.cancel_credit',
  // W24: Move's (the Worker's only).
  'booking.move',
])
/** The old code's notes about a card refund inside a claim (its refusal count and its unsure keys). */
const OLD_REFUND_NOTES: ReadonlySet<string> = new Set(['booking.card_refund_refused', 'booking.card_refund_unsure'])

/**
 * W21: a recording's rows for the refunds now on the Worker. The golden file's: the claims of Part refund and Refund
 * the rest, their finished rows, the actions' own rows, and the old code's refusal and unsure notes written between a
 * claim and its finished row (refundBooking's calls run one at a time). The new side's: the Worker's claims and their
 * finished rows, the actions' own rows, and (W26a) the marks of a card part Stripe refused (`booking.refund_refused`).
 */
function refundRows(rows: readonly AuditRow[], side: 'golden' | 'new'): Set<AuditRow> {
  // W24: on the new side, an old claim of a kind now on the Worker comes from a setup step run on the old side
  // (onTheOldSide), exactly as the golden file has it: set aside on both sides, as the golden side sets aside all of them.
  const oldKind = (row: AuditRow) => row.details?.['worker'] !== true && REFUND_KINDS_ON_WORKER.has(String(row.details?.['kind']))
  const claimIds = new Set(
    rows
      .filter((row) => row.action === 'booking.refund_claimed' && (side === 'golden' ? REFUND_KINDS_ON_WORKER.has(String(row.details?.['kind'])) : row.details?.['worker'] === true || oldKind(row)))
      .map((row) => row['id'])
  )
  const oldClaimIds = new Set(rows.filter((row) => row.action === 'booking.refund_claimed' && oldKind(row)).map((row) => row['id']))
  const swapped = new Set<AuditRow>()
  let open: unknown = null
  for (const row of rows) {
    if (row.action === 'booking.refund_claimed' && claimIds.has(row['id'])) {
      swapped.add(row)
      open = row['id']
    } else if (row.action === 'booking.refund_finished' && claimIds.has(row.details?.['claimId'])) {
      swapped.add(row)
      if (row.details?.['claimId'] === open) open = null
    } else if (REFUND_ACTION_ROWS.has(String(row.action))) {
      swapped.add(row)
    } else if ((side === 'golden' || oldClaimIds.has(open)) && open !== null && OLD_REFUND_NOTES.has(String(row.action))) {
      swapped.add(row)
    } else if (side === 'new' && row.action === 'order.reconcile' && row['entity_type'] === 'refund_claim') {
      // Reconcile's row for a held claim the replay settled (refundAsTheDialogPresses).
      swapped.add(row)
    } else if (side === 'new' && row.action === 'booking.refund_refused' && claimIds.has(row.details?.['claimId'])) {
      // W26a: the Worker's mark that Stripe refused one of a claim's card parts (the old code wrote none).
      swapped.add(row)
    }
  }
  return swapped
}

/** The swapped rows a recording holds: the golden file's old machinery rows, or the new side's own rows, for WORKER_FLOWS (W21: and the refunds). */
export function swappedAuditRows(recording: Recording, side: 'golden' | 'new'): AuditRow[] {
  const rows = (recording.tables['audit_log']?.added ?? []) as AuditRow[]
  const byId = new Map(rows.map((row) => [row['id'], row]))
  const refunds = refundRows(rows, side)
  return rows.filter((row) => {
    if (refunds.has(row)) return true
    // W24: the old machinery rows of a setup step run on the old side (onTheOldSide) are set aside on the new side too.
    const flow = side === 'golden' ? oldMachineryFlow(row, byId) : (newRowFlow(row) ?? oldMachineryFlow(row, byId))
    return flow !== null && WORKER_FLOWS.has(flow)
  })
}

/**
 * W24: the Worker's own rows among the new side's swapped ones: not an old claim (or its finished row, or a note inside
 * it) or an old machinery row from a setup step run on the old side, which match the golden file's and are set aside on
 * both sides alike.
 */
function workerRows(recording: Recording): AuditRow[] {
  const rows = (recording.tables['audit_log']?.added ?? []) as AuditRow[]
  const byId = new Map(rows.map((row) => [row['id'], row]))
  const oldClaims = new Set(rows.filter((row) => row.action === 'booking.refund_claimed' && row.details?.['worker'] !== true).map((row) => row['id']))
  return swappedAuditRows(recording, 'new').filter((row) => {
    if (row.action === 'booking.refund_claimed') return row.details?.['worker'] === true
    if (row.action === 'booking.refund_finished') return !oldClaims.has(row.details?.['claimId'])
    if (OLD_REFUND_NOTES.has(String(row.action))) return false
    return oldMachineryFlow(row, byId) === null
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
  // W21: reconcile's look for a held claim's refunds (refunds.list on a planned PaymentIntent) is set aside: the old
  // code had no such look for a booking refund. claimLookProblems checks it is only ever a look, never a send.
  const claimIntents = side === 'new' ? workerClaimIntents(recording) : new Set<string>()
  const stripeCalls = recording.stripeCalls.filter((call) => !isClaimLook(call, claimIntents))
  let text = JSON.stringify({ ...recording, stripeCalls, tables }).replace(/\[ref gone#\d+\]/g, '[ref gone]')
  if (relabel.size > 0) text = text.replace(/pending_reader_payments#\d+\b/g, (label) => relabel.get(label) ?? label)
  return withCanonicalGoneNumbers(JSON.parse(text) as Recording)
}

/** W21: the PaymentIntents the Worker's refund claims in a recording planned to refund. */
function workerClaimIntents(recording: Recording): Set<string> {
  const rows = (recording.tables['audit_log']?.added ?? []) as AuditRow[]
  const intents = new Set<string>()
  for (const row of rows) {
    if (row.action !== 'booking.refund_claimed' || row.details?.['worker'] !== true) continue
    const plan = row.details['plan'] as { card?: Array<{ paymentIntentId: string }> } | undefined
    for (const part of plan?.card ?? []) intents.add(part.paymentIntentId)
  }
  return intents
}

type StripeCall = Recording['stripeCalls'][number]
const isClaimLook = (call: StripeCall, intents: ReadonlySet<string>): boolean =>
  call.method === 'refunds.list' && intents.has(String((call.params as { payment_intent?: unknown } | null)?.payment_intent))

/**
 * W21: reconcile's looks for a held claim, set aside by `comparable`: each a refunds.list of one planned PaymentIntent,
 * with no key (a read). Answers the problems found. Reconcile sending anything shows in the comparison itself.
 */
export function claimLookProblems(recording: Recording): string[] {
  const intents = workerClaimIntents(recording)
  return recording.stripeCalls
    .filter((call) => isClaimLook(call, intents))
    .filter((call) => call.idempotencyKey !== null || Object.keys((call.params ?? {}) as object).sort().join(',') !== 'limit,payment_intent')
    .map((call) => JSON.stringify(call))
}

/** The fields a Worker card record's snapshot may hold for each flow: the old undo fields and the Worker's marks. */
const CARD_RECORD_FIELDS: Readonly<Record<string, readonly string[]>> = {
  settle: ['customer_id', 'description', 'booking_id', 'old_status', 'old_price_paid', 'old_payment_due_by', 'old_redemption_source', 'old_redeemed_membership_id', 'old_credit_period_id', 'old_seat1_pay_by', 'amount', 'store_credit_amount', 'gift_card'],
  add_guest: ['customer_id', 'description', 'booking_id', 'session_id', 'addon_credits', 'price_increment', 'claimed_extra_capacity', 'store_credit_amount', 'gift_card', 'guest_row_id', 'addon_line_ids', 'over_18_confirmed_here'],
  // W24: the old reader move's snapshot (W12's undo and C2 read it).
  move: [
    'customer_id',
    'description',
    'booking_id',
    'old_session_id',
    'old_start_time',
    'old_end_time',
    'old_price_paid',
    'price_paid_change',
    'old_band_id',
    'old_credit_period_id',
    'old_redemption_source',
    'old_redeemed_membership_id',
    'old_redeemed_session_pass_id',
    'release_session_pass_on_finalise',
    'seats',
    'new_session_id',
    'new_session_booking_type',
    'party_size',
    'store_credit_amount',
    'gift_card',
  ],
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
    // W25 (W20 review 5): only ever `true`, and only with a guest (it is their tick that stamped the booking).
    if ('over_18_confirmed_here' in snapshot && (snapshot['over_18_confirmed_here'] !== true || snapshot['guest_row_id'] === undefined)) wrong('the over-18 mark')
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
  const all = (recording.tables['audit_log']?.added ?? []) as AuditRow[]
  for (const row of workerRows(recording)) {
    const d = row.details ?? {}
    const n = (key: string) => Number(d[key])
    const wrong = (why: string) => problems.push(`${String(row.action)}: ${why} (${JSON.stringify(d)})`)
    if (row.action === 'booking.refund_claimed') {
      // W21: the claim, its plan adding up to what was claimed, and the Worker's marks.
      const cash = d['method'] === 'cash'
      const matched = 'matched' in d
      // W22: Remove Guest's and Remove add-on's claims carry what they removed. W23: a cancel's, what it changed.
      const cancelKind = d['kind'] === 'cancel' || d['kind'] === 'cancel_credit'
      const removed = d['kind'] === 'remove_guest' ? ['guest'] : d['kind'] === 'remove_addon' ? ['addon'] : cancelKind ? ['cancel'] : d['kind'] === 'move' ? ['move'] : []
      if (!sameKeys(d, ['kind', 'amount', 'pricePaidBefore', 'method', 'reason', 'worker', 'plan', 'livemode', ...(cash ? ['handedOverBy'] : []), ...(matched ? ['matched'] : []), ...removed])) wrong('fields')
      if (d['kind'] === 'remove_guest') {
        const guest = (d['guest'] ?? {}) as Record<string, unknown>
        const card = ((d['plan'] as { card?: unknown[] } | undefined)?.card ?? []).length > 0
        // The guest's row is kept exactly when a card part could be refused and the guest put back.
        if (!sameKeys(guest, ['id', 'name', 'seatPrice', 'placeReleased', ...(card ? ['restore'] : [])])) wrong('the guest')
        if (!(Number(guest['seatPrice']) >= n('amount')) || d['reason'] !== null || !['card', 'credit'].includes(String(d['method']))) wrong('a guest claim')
      }
      if (d['kind'] === 'remove_addon') {
        const addon = (d['addon'] ?? {}) as { lines?: Array<{ amount: number }>; refund?: unknown }
        if (!sameKeys(addon as Record<string, unknown>, ['lines', 'described', 'names', 'refund'])) wrong('the add-on')
        if (round2((addon.lines ?? []).reduce((total, line) => total + line.amount, 0)) !== n('amount') || addon.refund !== d['method']) wrong('an add-on claim')
      }
      if (cancelKind) {
        // W23: the booking as R1 found it, the places, the add-on lines; the amount is the seat money and the refunded add-ons.
        const cancel = (d['cancel'] ?? {}) as { seatAmount?: number; addons?: Array<{ paid?: boolean; amount?: number }>; addonRefund?: unknown }
        // W23a: a club cancel (Block Session, Block Day) says so, and only with `true`.
        const clubKey = 'clubCancelled' in cancel ? ['clubCancelled'] : []
        if (clubKey.length > 0 && (cancel as Record<string, unknown>)['clubCancelled'] !== true) wrong('clubCancelled')
        const expected = ['status', 'cancelledAt', 'refundOwed', 'sessionId', 'placesReleased', 'passReturned', 'seatAmount', 'allBackAlready', 'addons', 'addonRefund', ...(d['kind'] === 'cancel_credit' ? ['creditUsableAgain'] : []), ...clubKey]
        if (!sameKeys(cancel as Record<string, unknown>, expected)) wrong('the cancel')
        const addonsBack = round2((cancel.addons ?? []).filter((line) => line.paid).reduce((total, line) => total + Number(line.amount), 0))
        if (round2(Number(cancel.seatAmount) + addonsBack) !== n('amount') || d['reason'] !== null || !['card', 'credit'].includes(String(d['method']))) wrong('a cancel claim')
        if (d['kind'] === 'cancel_credit' && Number(cancel.seatAmount) !== 0) wrong('seat money on Cancel & return credit')
      }
      if (d['kind'] === 'move') {
        // W24: a cheaper Move's claim: the booking as R1 found it and what R1 changed (for the undo), and only card or
        // store credit (no cash back on a move).
        const move = (d['move'] ?? {}) as Record<string, unknown>
        const fields = ['oldSessionId', 'newSessionId', 'oldStartTime', 'oldEndTime', 'oldBandId', 'oldCreditPeriodId', 'oldRedemptionSource', 'oldRedeemedMembershipId', 'oldRedeemedSessionPassId', 'seats', 'placesClaimed', 'placesReleased', 'passReturned', 'creditReleased']
        if (!sameKeys(move, fields)) wrong('the move')
        if (move['oldSessionId'] === move['newSessionId'] || !Array.isArray(move['seats']) || d['reason'] !== null || !['card', 'credit'].includes(String(d['method']))) wrong('a move claim')
        if (!(Number(move['placesClaimed']) >= 0) || !(Number(move['placesReleased']) >= 0)) wrong('places')
      }
      const plan = (d['plan'] ?? {}) as { card?: Array<{ orderId?: string; amount: number; lines?: Array<{ amount: number; addon?: unknown }> }>; storeCredit?: number; cash?: number }
      // W23 (item 1): one card part per order, and add-on lines in a part only on a cancel's claim.
      const partOrders = (plan.card ?? []).map((part) => part.orderId)
      if (new Set(partOrders).size !== partOrders.length) wrong('two card parts for one order')
      if (!cancelKind && (plan.card ?? []).some((part) => (part.lines ?? []).some((line) => line.addon !== undefined))) wrong('an add-on line in a part outside a cancel')
      // W21a (W21 review L2): parts matched to an old refund that went, on Refund the rest (W23: and Cancel & Refund) only, each a planned part, once.
      if (matched) {
        const parts = Array.isArray(d['matched']) ? (d['matched'] as Array<{ orderId?: unknown; refundId?: unknown }>) : []
        const orders = parts.map((part) => part.orderId)
        if ((d['kind'] !== 'refund_owed' && d['kind'] !== 'cancel') || parts.length === 0 || new Set(orders).size !== orders.length) wrong('matched parts')
        if (parts.some((part) => typeof part.refundId !== 'string' || !(plan.card ?? []).some((planned) => planned.orderId === part.orderId))) wrong('a matched part not planned')
      }
      const card = round2((plan.card ?? []).reduce((total, part) => total + part.amount, 0))
      if (round2(card + Number(plan.storeCredit) + Number(plan.cash)) !== n('amount')) wrong('the plan is not what was claimed')
      if ((plan.card ?? []).some((part) => round2((part.lines ?? []).reduce((total, line) => total + line.amount, 0)) !== part.amount)) wrong("a card part is not its lines' sum")
      // A card refund with no card money left plans store credit only; nothing else ever plans a card part.
      if (card > 0 && d['method'] !== 'card') wrong('card parts only for the card')
      if ((card > 0) !== (typeof d['livemode'] === 'boolean')) wrong("the key's mode exactly with card parts")
      if (!['part_refund', 'refund_owed', 'remove_guest', 'remove_addon', 'cancel', 'cancel_credit', 'move'].includes(String(d['kind'])) || d['worker'] !== true) wrong('kind')
      if (row['entity_type'] !== 'booking' || typeof row['request_id'] !== 'string') wrong('entity or request id')
    } else if (row.action === 'booking.refund_finished') {
      const claim = all.find((other) => other['id'] === d['claimId'])
      const c = (claim?.details ?? {}) as Record<string, unknown>
      if (!sameKeys(d, ['claimId', 'outcome', 'cardRefunded', 'storeCreditRefunded', 'owed', ...('cash' in d ? ['cash'] : []), ...('refused' in d ? ['refused'] : []), ...('by' in d ? ['by'] : [])])) wrong('fields')
      // W26a: Stripe's reason, only on a claim that ended with money owed (a refused part never ends as store credit).
      if ('refused' in d && (typeof d['refused'] !== 'string' || d['refused'] === '' || d['outcome'] !== 'owed')) wrong('refused without money owed')
      const accounted = round2(n('cardRefunded') + n('storeCreditRefunded') + n('owed') + Number(d['cash'] ?? 0))
      if (d['outcome'] === 'put_back') {
        if (accounted !== 0) wrong('a put-back moves nothing')
      } else if (accounted !== Number(c['amount'])) wrong('what went, to store credit and owed is not what was claimed')
      if (d['outcome'] !== 'put_back' && (d['outcome'] === 'owed') !== n('owed') > 0) wrong('owed exactly when something is')
      // W26b (Wayne, 14 Nov): only the plan's own store credit is ever given. Card money that never went is owed on the
      // booking, live or cancelled, never store credit on top.
      const planned = Number(((c['plan'] ?? {}) as { storeCredit?: number }).storeCredit ?? 0)
      if (d['outcome'] !== 'put_back' && n('storeCreditRefunded') !== round2(planned)) wrong("store credit given is not the plan's own")
      if (typeof row['request_id'] !== 'string') wrong('request id')
    } else if (row.action === 'booking.refund_refused') {
      // W26a: the mark of a refused card part: the claim, the planned part it names, Stripe's reason; and the claim never
      // ends with that part's money given as store credit (put back, or at least that much owed).
      const claim = all.find((other) => other['id'] === d['claimId'])
      const plan = ((claim?.details ?? {})['plan'] ?? {}) as { card?: Array<{ orderId?: string; amount: number }> }
      if (!sameKeys(d, ['claimId', 'orderId', 'amount', 'detail'])) wrong('fields')
      if (claim?.details?.['worker'] !== true || !(plan.card ?? []).some((part) => part.orderId === d['orderId'] && part.amount === n('amount'))) wrong('not a planned card part of a Worker claim')
      if (typeof d['detail'] !== 'string' || !d['detail'].startsWith('Failed to refund payment: ')) wrong("Stripe's reason")
      const finished = all.find((other) => other.action === 'booking.refund_finished' && other.details?.['claimId'] === d['claimId'])
      if (finished && finished.details?.['outcome'] !== 'put_back' && !(Number(finished.details?.['owed']) >= n('amount'))) wrong('a refused part that did not end owed')
      if (row['entity_type'] !== 'booking' || typeof row['request_id'] !== 'string') wrong('entity or request id')
    } else if (row.action === 'booking.part_refund' || row.action === 'booking.refund_owed') {
      const part = row.action === 'booking.part_refund'
      const cash = 'cashRefunded' in d
      if (!sameKeys(d, [...(part ? ['amount', 'reason', 'method'] : ['amount', 'method']), 'cardRefunded', 'storeCreditRefunded', 'owed', ...(cash ? ['cashRefunded', 'handedOverBy'] : [])])) wrong('fields')
      if (round2(n('cardRefunded') + n('storeCreditRefunded') + n('owed') + Number(d['cashRefunded'] ?? 0)) !== n('amount')) wrong('the parts are not the amount')
      if (typeof row['request_id'] !== 'string') wrong('request id')
    } else if (row.action === 'order.reconcile' && row['entity_type'] === 'refund_claim') {
      // Finished, or left once while the scenario's failing write was still failing (finished before the next step).
      const finished = d['outcome'] === 'finalised' && sameKeys(d, ['outcome', 'detail'])
      const leftOnce = d['outcome'] === 'left' && d['reason'] === 'finish_failed' && sameKeys(d, ['outcome', 'reason', 'detail'])
      if (!finished && !leftOnce) wrong('a held claim reconcile finished')
    } else if (row.action === 'booking.guest_remove') {
      // W22: every removal; with a claim, its parts add up to what was claimed. W22a: a paid seat removed inside 24 hours
      // names the reason, with nothing back.
      const inside = d['reason'] === 'inside_24_hours'
      if (!sameKeys(d, ['guestId', 'refundAmount', 'method', 'cardRefunded', 'storeCreditRefunded', 'owed', ...(inside ? ['reason'] : [])])) wrong('fields')
      if (inside && n('refundAmount') !== 0) wrong('money back inside 24 hours')
      if (round2(n('cardRefunded') + n('storeCreditRefunded') + n('owed')) !== n('refundAmount')) wrong('the parts are not the refund')
      if ((n('refundAmount') > 0) !== (d['method'] === 'card' || d['method'] === 'credit')) wrong('a method exactly when something goes back')
      if (typeof d['guestId'] !== 'string' || row['entity_type'] !== 'booking' || typeof row['request_id'] !== 'string') wrong('guest, entity or request id')
    } else if (row.action === 'booking.addon_remove') {
      if (!sameKeys(d, ['lineIds', 'refund', 'amount', 'cardRefunded', 'storeCreditRefunded', 'owed', 'creditsReturned'])) wrong('fields')
      if (round2(n('cardRefunded') + n('storeCreditRefunded') + n('owed')) !== n('amount')) wrong('the parts are not the amount')
      if (!Array.isArray(d['lineIds']) || (d['lineIds'] as unknown[]).length !== 1) wrong('one line')
      if (n('creditsReturned') > 0 && n('amount') > 0) wrong('credits back and money back on one line')
      if (row['entity_type'] !== 'booking' || typeof row['request_id'] !== 'string') wrong('entity or request id')
    } else if (row.action === 'booking.cancel' || row.action === 'booking.cancel_credit') {
      // W23: every cancel; what went to the card, to store credit and owed is the seat money and the refunded add-ons.
      const credit = row.action === 'booking.cancel_credit'
      const common = ['addonLineIds', 'addonsRefund', 'cardRefunded', 'storeCreditRefunded', 'owed', 'creditsReturned', 'placesReleased']
      // W23a: a club cancel's row says so, and only with `true`.
      const clubKey = 'clubCancelled' in d ? ['clubCancelled'] : []
      if (clubKey.length > 0 && d['clubCancelled'] !== true) wrong('clubCancelled')
      if (!sameKeys(d, [...(credit ? ['addonRefund', 'creditUsableAgain', 'passReturned'] : ['refundMethod', 'seatRefund']), ...common, ...clubKey])) wrong('fields')
      if (round2(n('cardRefunded') + n('storeCreditRefunded') + n('owed')) !== round2((credit ? 0 : n('seatRefund')) + n('addonsRefund'))) wrong('the parts are not what went back')
      if (!Array.isArray(d['addonLineIds']) || !(n('placesReleased') >= 0) || !(n('creditsReturned') >= 0)) wrong('lines, places or credits')
      if (row['entity_type'] !== 'booking' || typeof row['request_id'] !== 'string') wrong('entity or request id')
    } else if (row.action === 'booking.move') {
      // W24: every move; its money: what was collected (dearer) or what went back (cheaper), and nothing else.
      const keys = ['oldSessionId', 'newSessionId', 'amountDue', 'storeCredit', 'giftCard', 'method', 'toCollect', 'refundMethod', 'cardRefunded', 'storeCreditRefunded', 'owed', 'pendingId', 'creditReleased', 'passReleased', 'legacyPricing']
      if (!sameKeys(d, keys)) wrong('fields')
      if (d['oldSessionId'] === d['newSessionId'] || typeof d['newSessionId'] !== 'string') wrong('the sessions')
      const due = n('amountDue')
      if (due > 0) {
        if (round2(Math.max(0, due - n('storeCredit') - n('giftCard'))) !== n('toCollect')) wrong('toCollect is not what is left after the parts')
        if ((n('toCollect') > 0) !== (d['method'] !== null)) wrong('a method exactly when something is collected')
        if ((d['pendingId'] !== null) !== (d['method'] === 'card' || d['method'] === 'reader')) wrong('a flow record exactly for the card or reader')
        if (d['refundMethod'] !== null || n('cardRefunded') + n('storeCreditRefunded') + n('owed') !== 0) wrong('money back on a dearer move')
      } else if (due < 0) {
        if (round2(n('cardRefunded') + n('storeCreditRefunded') + n('owed')) !== round2(-due)) wrong('the parts are not the refund')
        if (!['card', 'credit'].includes(String(d['refundMethod'])) || d['pendingId'] !== null || n('storeCredit') + n('giftCard') + n('toCollect') !== 0) wrong('a refund')
      } else if (d['method'] !== null || d['refundMethod'] !== null || d['pendingId'] !== null || n('storeCredit') + n('giftCard') + n('toCollect') + n('cardRefunded') + n('storeCreditRefunded') + n('owed') !== 0) {
        wrong('money on a same-price move')
      }
      if (row['entity_type'] !== 'booking' || typeof row['request_id'] !== 'string') wrong('entity or request id')
    } else if (row.action === 'booking.refund_owed_arrived') {
      if (!sameKeys(d, ['amount', 'reason']) || !(n('amount') > 0) || typeof d['reason'] !== 'string') wrong('fields')
    } else if (row.action === 'booking.guest_add') {
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
  const route =
    /^POST \/api\/v1\/staff\/(bookings\/[^/]+\/(settle|guests|status|special-requests|refunds|refunds\/owed|refunds\/owed-arrived|cancel-and-refund|cancel-credit|move)|bookings\/(guests|addon-lines)\/[^/]+\/remove|reader-flows\/[^/]+\/(finalise|cancel))$/
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
const deadPressAnswerLost = (scenario: string, path: RegExp, saying: string, kept: { storeCreditHigherBy?: number } = {}): AllowedDifference => ({
  name: `${scenario}: the press's answer is lost after the Worker's route ran to the end (one transaction, then the card); ${saying}`,
  decision: `${W20}: C1 then the card in one route; the dialog keeps the key after no answer (W03-plan 2.6); W05 review 3 finding 2 (R2) where named`,
  path,
  actual: (value, expected, at) => {
    if (at.endsWith('.reason')) return value === 'no_answer' || value === 'pressed_after_no_answer'
    if (at.endsWith('.message')) return NO_ANSWER_WORDS(value) || PRESSED_AGAIN_WORDS(value)
    // W25 (W20 review later 1; W24 "noticed"): every other path exactly, not any value. The Worker never repeats what
    // the old resume repeated: the press answered is not an add; no second Stripe call, order, line, store credit row
    // or gift card use exists on its side; one place is taken, not two; the store credit is taken once.
    const pennies = (amount: unknown): number => Math.round(Number(amount) * 100)
    if (/^\.results\[\d+\]\.added$/.test(at)) return value === false
    if (/^\.results\[\d+\]\.(limitReached|guest|addonLineIds|thrown)$/.test(at)) return value === undefined
    if (/^\.stripeCalls\[\d+\]$/.test(at)) return value === undefined
    if (/\.added\[\d+\]$/.test(at) || at === '.tables.gift_card_redemptions') return value === undefined
    if (at.endsWith('.total_booked[1]')) return Number(value) === Number(expected) - 1
    if (at.endsWith('.store_credit_balance[1]')) return kept.storeCreditHigherBy !== undefined && pennies(value) - pennies(expected) === pennies(kept.storeCreditHigherBy)
    // The store credit row carries the order C1 wrote with it (the old lost claim had none).
    if (at.endsWith('.added[0].order_id')) return typeof value === 'string' && value.length > 0
    return false
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
    'w22a-remove-guest-a-minute-outside-24-hours',
    'w22a-remove-guest-a-minute-inside-24-hours',
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
        "the card paid and its order couldn't be written, so the change is held for reconcile (never refunded for a database fault, W6-3), with the guest added once and £5 store credit taken once; the next press is refused (the old code took the £5 again and charged £15 again). add-guest.test.ts runs reconcile on the same hold and it writes the order",
        { storeCreditHigherBy: 5 }
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
        // W24 (W20 review later 1): each value, where the whole tables went unchecked: Bea added (her £20 seat), the
        // third place taken, the £15 store credit taken once (no reversal row), the £5 gift card claimed once.
        actual: (value, expected, path) => {
          if (path.endsWith('.added')) return value === true
          if (path.endsWith('.reason')) return value === undefined
          if (path.endsWith('.limitReached')) return value === false
          if (path.endsWith('.guest')) return (value as { guest_name?: unknown; unit_price?: unknown } | undefined)?.guest_name === 'Bea Guest' && (value as { unit_price?: unknown }).unit_price === 20
          if (path.endsWith('.addonLineIds')) return Array.isArray(value) && value.length === 0
          if (path.endsWith('.total_booked[1]')) return value === 3
          if (path === '.tables.store_credit_transactions.added[1]') return value === undefined
          // W24a (W24 review, its unread parts): the whole table's change, so a row added or gone beside the one changed
          // balance doesn't pass (only `changed` was looked at).
          const only = (changed: Row): boolean => expected === undefined && JSON.stringify(value) === JSON.stringify({ added: [], changed: [changed], removed: [], tied: 0 })
          if (path === '.tables.customers') return only({ id: '10000000-0000-4000-8000-000000000005', store_credit_balance: ['30.00', '15.00'] })
          return only({ id: '10000000-0000-4000-8000-000000000009', remaining_balance: ['40.00', '35.00'] })
        },
      },
    ],
  ],
  [
    'w17-r4a-add-guest-store-credit-claim-answer-lost-then-pressed-again',
    [
      deadPressAnswerLost(
        'R4a',
        /^\.results\[2\]\.(thrown|added|reason|message)$|^\.tables\.customers\.changed\[0\]\.store_credit_balance\[1\]$|^\.tables\.sessions\.changed\[0\]\.total_booked\[1\]$|^\.tables\.store_credit_transactions\.added\[0\]\.order_id$|^\.tables\.store_credit_transactions\.added\[1\]$/,
        'the store credit claim is inside C1, so the press went through and only its answer was lost: the same press again gets the stored answer, so £15 is taken once with its order (the old code kept the lost claim and took £15 again, and a second place)',
        { storeCreditHigherBy: 15 }
      ),
    ],
  ],
])

// --- W21: Part refund, Refund the rest, It already arrived and the figures (brief W21 item 6)

const W21 = 'Brief W21 (D-plan 4.3, 4.10; lead call L3: claims in audit_log)'
const CLAIM_KEY = /^audit_log#\d+:refund:orders#\d+$/
const CLAIM_LABEL = /^audit_log#\d+$/

/**
 * A card refund's key and metadata come from its claim: `<claimId>:refund:<orderId>`, with `metadata.claim_id`
 * naming the claim and `refund_key` the key (the old keys were built from the figures, with a 24-hour look-up: both
 * replaced). Only those values pass.
 */
export const CLAIM_KEYS: AllowedDifference = {
  name: "A Worker refund's card refund (Part refund, Refund the rest; W22: Remove Guest, Remove add-on) is keyed from its claim (`<claimId>:refund:<orderId>`) and names it in `metadata.claim_id`; the old figure-built keys (and Remove add-on's line-built ones) and their 24-hour look-up are replaced",
  decision: `${W21}: keys from the claim id (D-plan 4.3); brief W22 items 1 and 2 (W22's claims, the same rule)`,
  path: /^\.stripeCalls\[\d+\]\.(idempotencyKey|params\.metadata\.(refund_key|claim_id))$/,
  actual: (value, _expected, path) => (path.endsWith('.claim_id') ? typeof value === 'string' && CLAIM_LABEL.test(value) : typeof value === 'string' && CLAIM_KEY.test(value)),
}

/** W21a (W21 review S1): the line says what is left to refund, by its parts, or that nothing is. */
const LEFT_LINE = /^(Left to refund: £\d+\.\d{2} (card money|gift card \/ store credit|cash)((, | and )£\d+\.\d{2} (gift card \/ store credit|cash))*\.|Nothing left to refund\.)$/

/** W26a (audit S5; Q37): the booking detail's payment line, by its parts, or that nothing was paid. */
const PAID_WORDS = /^(Paid £\d+\.\d{2} (by card|by gift card \/ store credit|in cash)((, | and )£\d+\.\d{2} (by gift card \/ store credit|in cash))*\.|Nothing was paid\.)$/

/**
 * Q26's cash, the line of what is left, and (W26a) how the money on the booking was paid, on every figures answer and
 * on the figures a refusal carries. Nothing else changes.
 */
export const FIGURES_CASH_AND_LINE: AllowedDifference = {
  name: 'The refund figures also say what cash can be handed back (Q26), what is left to refund, in words (W21a), and how the money on the booking was paid, in words (W26a, Q37)',
  decision: "Wayne's Q26 (6 Nov) and Q37 (12 Nov); lead call L2 (cash refunds for bookings in D); brief W21 items 1 and 5; brief W21a item 1 (W21 review S1); brief W26a item 6 (audit S5; Wayne, 14 Nov)",
  path: /^\.results\[\d+\]\.(refused\.figures\.)?(cashLeft|paidLine|paidWords)$/,
  actual: (value, expected, path) =>
    expected === undefined &&
    (path.endsWith('.cashLeft')
      ? typeof value === 'number' && value >= 0
      : path.endsWith('.paidWords')
        ? typeof value === 'string' && PAID_WORDS.test(value)
        : typeof value === 'string' && LEFT_LINE.test(value)),
}

/**
 * W26a (Wayne, 14 Nov; audit table 35): a later card part Stripe refused stays on the booking as still to refund,
 * never store credit unseen. The four part-refund-fails-partway scenarios end exactly as the old code left them (its
 * store credit write failed, so £70 stayed owed): only the warning's words differ, and no store credit write is tried.
 */
const laterRefusalStaysOwed = (result: number, refusedPart: number, owed: number): AllowedDifference => ({
  name: `A later card part Stripe refused (£${refusedPart.toFixed(2)}) is never sent to store credit: it stays on the booking as still to refund, and the warning carries Stripe's reason and the two buttons (the old warning said it may not have reached store credit)`,
  decision: "Brief W26a item 1 (Wayne, 14 Nov: every Stripe card refusal is held for staff, never automatic store credit; audit S2, table 34 and 35)",
  path: new RegExp(`^\\.results\\[${result}\\]\\.warning$`),
  actual: (value) =>
    value ===
    `A further card refund of £${refusedPart.toFixed(2)} was refused (Failed to refund payment: Your card was declined.), so £${owed.toFixed(2)} shows on the booking as still to refund. Check Stripe first: if the money already reached the customer, use It already arrived; if not, use Refund the rest.`,
})

/**
 * R2's store credit write fails after a card part went (the scenario's failing write): the claim is held for
 * reconcile, with words saying what went (W6-3's rule for refunds: what went is never sent again). Reconcile, before
 * the next step (as staff would find it), records what went and gives the plan's store credit: the booking ends
 * exactly as the old code left it. W26a: only for a claim whose plan has store credit of its own (Refund the rest
 * across card and store credit); a refused later part writes no store credit any more (laterRefusalStaysOwed).
 */
const heldWhileStoreCreditFails = (result: number, gone: number): AllowedDifference => ({
  name: `A card part went and R2's store credit write failed: held (unsure, "£${gone.toFixed(2)} went back to the card, but the refund couldn't be finished…"); reconcile then ends it as the old code did`,
  decision: `${W21}: R2 is one transaction; held for reconcile (Q35); D-plan 4.10 (reconcile records what went, never resends)`,
  path: new RegExp(`^\\.results\\[${result}\\]\\.(cardRefundedAmount|storeCreditRefundedAmount|pricePaid|warning|unsure)$`),
  actual: (value, _expected, path) =>
    path.endsWith('.unsure')
      ? typeof value === 'object' && value !== null && String((value as { message?: unknown }).message).startsWith(`£${gone.toFixed(2)} went back to the card, but the refund couldn't be finished`)
      : value === undefined,
})

const ANSWER_LOST_ON_THE_ROUTE = "The Worker's answer is lost after its route ran to the end (the old code lost Stripe's answer on its legacy call): the dialog gets no answer and keeps its key; the refund went and R2 recorded it, so nothing is owed and the next step finds nothing owed (refused, with the figures)"
const noAnswerWords = (value: unknown): boolean => typeof value === 'object' && value !== null && String((value as { message?: unknown }).message).startsWith("The refund didn't get an answer")

/** W21: every golden scenario that calls a Part refund, Refund the rest, It already arrived or the figures and differs. */
export const REFUND_DIFFERENCES: ReadonlyMap<string, readonly AllowedDifference[]> = new Map<string, readonly AllowedDifference[]>([
  ...[
    'q24-part-refund-then-the-rest',
    'q25-part-refund-then-a-guest',
    'q27-part-to-card-same-tier-then-to-the-card',
    'q27-part-to-card-same-tier-then-to-store-credit',
    'q27-part-to-card-higher-tier-on-the-card-then-to-the-card',
    'q27-part-to-card-higher-tier-on-the-reader-then-to-the-card',
    'q27-part-to-card-higher-tier-in-cash-then-to-the-card',
    'q27-no-promo-part-to-card-same-tier-then-to-the-card',
    'q27-part-refund-split-card-and-credit-counted-once',
    'q27-two-part-refunds-then-a-higher-tier',
    'q27-whole-booking-part-refunded-then-same-tier',
    'q27-guests-through-the-tiers-after-a-part-refund',
    'q27-reader-cancelled-after-a-part-refund',
    'q27-public-booking-part-refund-is-unchanged',
    'q27-part-refund-after-a-cheaper-move-still-counts',
    'q27-part-refund-before-a-same-price-move-still-counts',
    'q27-guest-removed-then-a-part-refund-then-a-guest',
    'q27-tier-price-fell-then-a-part-refund-then-a-guest',
    'addon-with-guest-part-refund-then-cancel',
    'q28-public-same-price-part-to-the-card',
    'remove-guest-capped-an-old-quote-refused',
    'q28-private-same-price-part-to-the-card',
    'q28-private-dearer-on-the-card',
    'q28-private-dearer-on-the-reader',
    'q28-private-dearer-in-cash',
    'q28-private-dearer-store-credit-and-card',
    'q28-private-cheaper-to-the-card',
    'q28-private-cheaper-to-store-credit',
    'q28-private-cheaper-stops-at-what-is-left',
    'q28-private-cheaper-with-nothing-left',
    'q28-private-there-and-back',
    'q28-private-cheaper-move-then-part-then-dearer-move',
    'q28-private-part-then-guest-then-move',
    'q28-private-reader-cancelled-puts-it-all-back',
    'q28-promo-booking-still-cannot-move',
    'q28-public-dearer-on-the-card',
    'q28-public-dearer-on-the-reader',
    'q28-public-dearer-in-cash',
    'q28-public-cheaper-to-the-card',
    'q28-public-cheaper-to-store-credit',
    'q28-public-cheaper-stops-at-what-is-left',
    'q28-public-credit-released-after-a-part-refund',
    'q28-public-same-price-after-a-capped-remove-guest',
    'remove-guest-more-left-than-the-seat',
    'remove-guest-capped-to-store-credit',
    'remove-guest-capped-then-cancel',
    'remove-guest-nothing-left',
    'part-refund-declined-changes-nothing',
    'decline-then-the-same-part-refund-again',
    'capped-move-down-then-back-up',
    'all-part-refunded-to-the-card-then-cancel',
    'all-part-refunded-card-and-credit-then-cancel',
    'all-part-refunded-with-a-guest-then-cancel',
    'all-part-refunded-addon-not-ticked-then-cancel',
    'all-part-refunded-addon-ticked-then-cancel',
    'nearly-all-part-refunded-then-cancel',
    'price-paid-cleared-half-back-then-cancel',
    'price-paid-cleared-addon-credit-is-not-seat-money',
    'public-move-credit-fails-partway',
    'private-move-credit-fails-partway',
    'private-move-credit-fails-then-a-same-price-move-leaves-it-owed',
    'private-move-rest-retried-then-a-same-price-move',
    'move-refund-card-declined-then-retried',
    'credit-booking-paid-seat-part-refunded-to-the-card-then-cancelled',
    'owed-then-a-same-price-move',
    'owed-then-a-dearer-move',
    'owed-with-nothing-left-then-a-same-price-move',
    'owed-then-a-guest-same-tier',
    'owed-then-a-guest-higher-tier',
    'owed-then-remove-guest-stops-at-what-is-left',
    'refund-the-rest-card-then-store-credit',
    'part-refund-while-a-reader-move-is-open',
    'refund-the-rest-while-a-reader-move-is-open',
    'public-move-credit-fails-partway-then-retried',
    'private-move-credit-fails-partway-then-retried',
  ].map((name): [string, readonly AllowedDifference[]] => [name, [CLAIM_KEYS]]),
  ...[
    'figures-on-the-card',
    'figures-in-cash',
    'figures-card-gift-card-and-store-credit',
    'figures-card-order-and-a-cash-guest',
    'figures-card-order-and-a-guest-on-store-credit',
    'figures-with-money-owed',
    'w17-r3-move-two-presses-the-new-session-full-for-both',
    'w17-n3-status-set-to-cancelled-on-a-paid-booking',
  ].map((name): [string, readonly AllowedDifference[]] => [name, [FIGURES_CASH_AND_LINE]]),
  ['figures-after-a-part-refund', [CLAIM_KEYS, FIGURES_CASH_AND_LINE]],
  [
    'unsure-cheaper-move-card-then-the-rest',
    [
      {
        name: "The old Move's £40 card refund got no clear answer but went: Refund the rest finds it in Stripe by its old key (a read) and records it as the card refund of the rest, never sending it again (the old code sent it again under the same key, and Stripe gave the first back)",
        decision: `${W21}: the old 24-hour look-up's job, kept for owed money the old screens make until W22 to W24; no refund sent twice (D-plan 4.3)`,
        path: /^\.stripeCalls\[2\]$/,
        actual: (value, expected) => value === undefined && (expected as { method?: string } | undefined)?.method === 'refunds.create',
      },
    ],
  ],
  ['part-refund-fails-partway', [CLAIM_KEYS, laterRefusalStaysOwed(3, 70, 70)]],
  ['part-refund-fails-partway-then-the-rest', [CLAIM_KEYS, laterRefusalStaysOwed(3, 70, 70)]],
  ['part-refund-fails-partway-then-a-same-price-move', [CLAIM_KEYS, laterRefusalStaysOwed(3, 70, 70)]],
  ['part-refund-fails-partway-then-a-guest', [CLAIM_KEYS, laterRefusalStaysOwed(3, 70, 70)]],
  [
    'refund-the-rest-fails-partway-then-retried',
    [
      CLAIM_KEYS,
      heldWhileStoreCreditFails(4, 10),
      {
        name: "Reconcile gives the claim's planned £30 store credit (its note R2's: the rest went back to the card) before the retry, so the retry finds nothing owed; the customer gets the same £10 card and £30 store credit",
        decision: `${W21}: R2 gives the plan's store credit (D-plan 4.3); held for reconcile (Q35)`,
        path: /^\.results\[5\]\.(cardRefundedAmount|storeCreditRefundedAmount|storeCreditBalance|pricePaid|refused)$|^\.tables\.store_credit_transactions\.added\[1\]\.note$/,
        actual: (value, _expected, path) =>
          path.endsWith('.note')
            ? value === 'Refund the rest of a failed booking refund (the rest went back to the card). [ref gone]'
            : path.endsWith('.refused')
              ? String((value as { message?: unknown }).message) === 'Nothing is owed on this booking any more.'
              : value === undefined,
      },
    ],
  ],
  [
    'unsure-part-refund-card-arrived',
    [
      CLAIM_KEYS,
      {
        name: `${ANSWER_LOST_ON_THE_ROUTE}; the £40 is on the order's line (the old code left it off, and It already arrived only cleared what was owed)`,
        decision: `${W21}; W20's model of a lost answer (the route ran); W03-plan 2.6 (the key kept)`,
        path: /^\.results\[1\]\.(unsure|noAnswer)$|^\.results\[2\]\.(cardRefundedAmount|storeCreditRefundedAmount|pricePaid|refused)$|^\.tables\.order_line_items\.added\[0\]\.card_refunded_amount$|^\.stripeCalls\[2\]\.(idempotencyKey|params\.metadata\.refund_key)$/,
        actual: (value, _expected, path) =>
          path.endsWith('.noAnswer')
            ? noAnswerWords(value)
            : path.endsWith('.refused')
              ? String((value as { message?: unknown }).message) === 'Nothing is owed on this booking any more.'
              : path.endsWith('.card_refunded_amount')
                ? value === '100.00'
                : path.startsWith('.stripeCalls[2]')
                  ? value === 'booking-refund:order_line_items#1:6000:4000:6000:0'
                  : value === undefined,
      },
    ],
  ],
  [
    'unsure-part-refund-card-then-the-rest-then-cancel',
    [
      CLAIM_KEYS,
      {
        name: `${ANSWER_LOST_ON_THE_ROUTE}; so Cancel & Refund then gives the £60 left in one card refund, where the old code gave £40 (Refund the rest) and then £60`,
        decision: `${W21}; W20's model of a lost answer (the route ran); W03-plan 2.6 (the key kept)`,
        path: /^\.results\[1\]\.(unsure|noAnswer)$|^\.results\[2\]\.(cardRefundedAmount|storeCreditRefundedAmount|pricePaid|refused)$|^\.stripeCalls\[2\]\.(params\.amount|idempotencyKey|params\.metadata\.refund_key)$|^\.stripeCalls\[3\]$/,
        actual: (value, _expected, path) =>
          path.endsWith('.noAnswer') ? noAnswerWords(value) : path.endsWith('.refused') ? String((value as { message?: unknown }).message) === 'Nothing is owed on this booking any more.' : path.endsWith('.amount') ? value === 6000 : path.startsWith('.stripeCalls[2]') ? true : value === undefined,
      },
    ],
  ],
  [
    'unsure-part-refund-store-credit-arrived',
    [
      {
        name: "A lost answer on the old store credit statement: the hook matches the old code's SQL, which the Worker doesn't run; R1 is one transaction, so the £40 goes to store credit once and the order is partly refunded; It already arrived then finds nothing owed",
        decision: `${W21}: R1 is one transaction (the store credit's answer can't be lost on its own); W05 review 3's finding 3 for refunds`,
        path: /^\.results\[1\]\.(unsure|cardRefundedAmount|storeCreditRefundedAmount|storeCreditBalance|pricePaid)$|^\.results\[2\]\.(cardRefundedAmount|storeCreditRefundedAmount|pricePaid|refused)$|^\.tables\.orders\.added\[0\]\.payment_status$/,
        actual: (value, _expected, path) => {
          if (path.endsWith('.unsure') || path.startsWith('.results[2]')) return path.endsWith('.refused') ? String((value as { message?: unknown }).message) === 'Nothing is owed on this booking any more.' : value === undefined
          if (path.endsWith('.payment_status')) return value === 'partially_refunded'
          if (path.endsWith('.storeCreditRefundedAmount')) return value === 40
          if (path.endsWith('.cardRefundedAmount')) return value === 0
          return typeof value === 'number'
        },
      },
    ],
  ],
])

// --- W22: Remove Guest and Remove add-on (brief W22 item 5)

const W22 = 'Brief W22 (D-plan 1.5, 1.8, 4.3; W02 finding 11; lead call L3: claims in audit_log)'

/** R2's words for a card refund that went and couldn't be recorded yet (W21's refundGoneNotRecordedMessage). */
const goneNotRecorded = (gone: number) => (value: unknown): boolean =>
  typeof value === 'string' && value.startsWith(`£${gone.toFixed(2)} went back to the card, but the refund couldn't be finished on the booking yet.`)

/**
 * Remove Guest's £10 card part went and R2's £10 store credit failed (the scenario's failing write): the claim is held,
 * with the guest removed (R1), and the words say what went (W6-3's rule for refunds: what went is never sent again).
 * The old code removed the guest, recorded the £10 on the line and left the other £10 owed. On the Worker, reconcile
 * finishes it once the write works again: the £10 card part recorded and the planned £10 store credit given (the next
 * scenario shows it). Until then the booking is as R1 left it: £40 paid, nothing owed, nothing on the line yet.
 */
const REMOVE_HELD_WHILE_STORE_CREDIT_FAILS: AllowedDifference = {
  name: "Remove Guest's card part went and R2's store credit write failed: held (removed, \"£10.00 went back to the card, but the refund couldn't be finished…\"), the booking as R1 left it until reconcile finishes it",
  decision: `${W22}; R2 is one transaction, held for reconcile (Q35); D-plan 4.10 (reconcile records what went, never resends)`,
  path: /^\.results\[4\]\.warning$|^\.tables\.bookings\.added\[0\]\.(price_paid|refund_owed_amount)$|^\.tables\.order_line_items\.added\[0\]\.card_refunded_amount$|^\.tables\.orders\.added\[0\]\.payment_status$/,
  actual: (value, _expected, path) =>
    path.endsWith('.warning')
      ? goneNotRecorded(10)(value)
      : path.endsWith('.price_paid')
        ? value === '40.00'
        : path.endsWith('.refund_owed_amount') || path.endsWith('.card_refunded_amount')
          ? value === '0.00'
          : value === 'paid',
}

/**
 * The same hold, then Refund the rest: reconcile finishes the claim first (as staff would find it on the Orders page),
 * recording the £10 on the line and giving the planned £10 store credit (Remove Guest's note), so Refund the rest finds
 * nothing owed. The customer gets the same £10 card and £10 store credit, and the booking ends as the old code left it.
 */
const REMOVE_HELD_THEN_RECONCILED: AllowedDifference = {
  name: "Remove Guest held while its store credit failed; reconcile gives the planned £10 store credit (Remove Guest's note) before Refund the rest, which finds nothing owed; the customer gets the same £10 card and £10 store credit",
  decision: `${W22}; R2 gives the plan's store credit (D-plan 4.3); held for reconcile (Q35)`,
  path: /^\.results\[4\]\.warning$|^\.results\[5\]\.(cardRefundedAmount|storeCreditRefundedAmount|storeCreditBalance|pricePaid|refused)$|^\.tables\.store_credit_transactions\.added\[1\]\.note$/,
  actual: (value, _expected, path) =>
    path.endsWith('.warning')
      ? goneNotRecorded(10)(value)
      : path.endsWith('.note')
        ? value === 'Refund for a guest removed from the booking (Bea Guest) (the rest went back to the card). [ref gone]'
        : path.endsWith('.refused')
          ? String((value as { message?: unknown }).message) === 'Nothing is owed on this booking any more.'
          : value === undefined,
}

/**
 * A lost answer on the old store credit statement (the hook matches the old code's SQL, which the Worker doesn't run):
 * R1 is one transaction, so the guest is removed with the £20 to store credit once, the guest's line is stamped and the
 * orders' status worked out; It already arrived then finds nothing owed, and the last Remove finds the guest gone.
 */
const REMOVE_NO_LOST_ANSWER: AllowedDifference = {
  name: "A lost answer on the old store credit statement: R1 is one transaction, so the guest is removed once with £20 to store credit (the line stamped, the orders' status); It already arrived finds nothing owed and the last Remove finds the guest gone",
  decision: `${W22}: R1 is one transaction (W02 finding 11; W05 review 2, finding 11)`,
  path: /^\.results\[3\]\.(removed|reason|message|retryLocked|quote|refundedAmount|cardRefundedAmount|storeCreditRefundedAmount|storeCreditBalance)$|^\.results\[4\]\.(cardRefundedAmount|storeCreditRefundedAmount|pricePaid|refused)$|^\.results\[5\]\.(removed|refundedAmount|cardRefundedAmount|storeCreditRefundedAmount|reason)$|^\.tables\.order_line_items\.added\[1\]\.(refunded_at|refund_method)$|^\.tables\.orders\.added\[[01]\]\.payment_status$/,
  actual: (value, _expected, path) => {
    if (path.startsWith('.results[3]')) {
      if (path.endsWith('.removed')) return value === true
      if (path.endsWith('.refundedAmount') || path.endsWith('.storeCreditRefundedAmount')) return value === 20
      if (path.endsWith('.cardRefundedAmount')) return value === 0
      if (path.endsWith('.storeCreditBalance')) return typeof value === 'number'
      return value === undefined
    }
    if (path.startsWith('.results[4]')) return path.endsWith('.refused') ? String((value as { message?: unknown }).message) === 'Nothing is owed on this booking any more.' : value === undefined
    if (path.startsWith('.results[5]')) return path.endsWith('.removed') ? value === false : path.endsWith('.reason') ? value === 'guest_not_found' : value === undefined
    if (path.endsWith('.refunded_at')) return value === '<set>'
    if (path.endsWith('.refund_method')) return value === 'credit'
    return path.includes('added[0]') ? value === 'partially_refunded' : value === 'refunded'
  },
}

/**
 * W22: every golden scenario that calls Remove Guest or Remove add-on and differs, and the only differences allowed
 * in each (with W20's Add Guest and W21's refund allowances where the scenario has them). The rest match exactly.
 */
export const REMOVE_DIFFERENCES: ReadonlyMap<string, readonly AllowedDifference[]> = new Map<string, readonly AllowedDifference[]>([
  ...[
    'addon-with-guest-then-remove-guest-then-cancel',
    'addon-with-guest-removed-to-the-card-then-cancel',
    'remove-guest-on-the-card',
    'remove-guest-their-addon-left',
    'remove-guest-the-older-of-two',
    'remove-guest-both-of-two',
    'remove-a-seat-from-the-first-order',
    'remove-guest-after-a-cheaper-move',
    'credit-booking-paid-seat-removed',
    'credit-booking-paid-guest-removed-then-cancelled',
    'remove-guest-while-a-reader-move-is-open',
    'remove-guest-while-a-guest-is-on-the-reader',
    'reader-move-finished-then-remove-guest',
    'w22a-remove-guest-a-minute-outside-24-hours',
  ].map((name): [string, readonly AllowedDifference[]] => [name, [CLAIM_KEYS]]),
  ['remove-guest-credit-fails-partway', [CLAIM_KEYS, REMOVE_HELD_WHILE_STORE_CREDIT_FAILS]],
  ['remove-guest-credit-fails-partway-then-retried', [CLAIM_KEYS, REMOVE_HELD_THEN_RECONCILED]],
  ['unsure-remove-guest-store-credit-arrived', [REMOVE_NO_LOST_ANSWER]],
])

// --- W22a: Remove Guest follows the 24-hour rule (Wayne's decision, 13 Nov; brief W22a item 1)

const W22A = "Wayne's decision (13 Nov): Remove Guest follows the 24-hour rule, as Cancel & Refund and Remove add-on (brief W22a item 1)"

/** Remove Guest's quote also says whether the session starts within 24 hours: false on every golden press (none is inside them). */
const GUEST_QUOTE_OUTSIDE_24_HOURS: AllowedDifference = {
  name: "Remove Guest's quote also says whether the session starts within 24 hours: false, so the seat's refund is the old one",
  decision: W22A,
  path: /^\.results\[\d+\]\.quote\.insideTwentyFourHours$/,
  actual: (value, expected) => expected === undefined && value === false,
}

/**
 * A minute inside the 24 hours: the old code refunded Bea's £20 seat to the card; the Worker's quote is £0 (it says the
 * session is inside 24 hours), the press sends that £0, and she is removed with nothing back: no Stripe refund, her
 * line not stamped, her order still paid, the £20 left on the booking (Part refund can give it). Her place is released
 * and the party size lowered exactly as before (those tables match the golden file).
 */
const REMOVE_GUEST_INSIDE_24_HOURS: AllowedDifference = {
  name: "Remove Guest a minute inside 24 hours of the session: the quote £0 (inside 24 hours), the guest removed with nothing back (no refund, line not stamped, order paid, £60 left on the booking)",
  decision: W22A,
  path: /^\.results\[3\]\.quote\.(refundAmount|insideTwentyFourHours)$|^\.results\[4\]\.(refundedAmount|cardRefundedAmount)$|^\.stripeCalls\[2\]$|^\.tables\.bookings\.added\[0\]\.price_paid$|^\.tables\.order_line_items\.added\[1\]\.(refunded_at|refund_method|card_refunded_amount)$|^\.tables\.orders\.added\[1\]\.payment_status$/,
  actual: (value, expected, path) => {
    if (path.endsWith('.insideTwentyFourHours')) return expected === undefined && value === true
    if (path.startsWith('.results')) return expected === 20 && value === 0
    if (path === '.stripeCalls[2]') return (expected as { method?: string } | undefined)?.method === 'refunds.create' && value === undefined
    if (path.endsWith('.price_paid')) return expected === '40.00' && value === '60.00'
    if (path.endsWith('.card_refunded_amount')) return expected === '20.00' && value === '0.00'
    if (path.endsWith('.payment_status')) return expected === 'refunded' && value === 'paid'
    return value === null
  },
}

/**
 * W22a: every golden scenario whose Remove Guest answers carry the quote, and the 24-hour allowance each needs (with the
 * W20 / W21 / W22 allowances it already had). Only `w22a-remove-guest-a-minute-inside-24-hours` gives a different
 * refund; the rest differ only by the quote's new `insideTwentyFourHours: false`.
 */
export const REMOVE_GUEST_24_HOURS_DIFFERENCES: ReadonlyMap<string, readonly AllowedDifference[]> = new Map<string, readonly AllowedDifference[]>([
  ...[
    'addon-with-guest-then-remove-guest-then-cancel',
    'credit-booking-paid-guest-removed-then-cancelled',
    'credit-booking-paid-seat-removed',
    'owed-then-remove-guest-stops-at-what-is-left',
    'q28-public-same-price-after-a-capped-remove-guest',
    'reader-move-finished-then-remove-guest',
    'remove-a-seat-from-the-first-order',
    'remove-guest-after-a-cheaper-move',
    'remove-guest-both-of-two',
    'remove-guest-capped-an-old-quote-refused',
    'remove-guest-capped-then-cancel',
    'remove-guest-capped-to-store-credit',
    'remove-guest-credit-fails-partway',
    'remove-guest-credit-fails-partway-then-retried',
    'remove-guest-more-left-than-the-seat',
    'remove-guest-nothing-left',
    'remove-guest-on-the-card',
    'remove-guest-paid-in-cash',
    'remove-guest-the-older-of-two',
    'remove-guest-their-addon-left',
    'remove-guest-then-cancel',
    'remove-guest-to-store-credit',
    'remove-guest-while-a-reader-move-is-open',
    'w22a-remove-guest-a-minute-outside-24-hours',
  ].map((name): [string, readonly AllowedDifference[]] => [name, [GUEST_QUOTE_OUTSIDE_24_HOURS]]),
  ['w22a-remove-guest-a-minute-inside-24-hours', [REMOVE_GUEST_INSIDE_24_HOURS]],
])

// --- W23: Cancel & Refund, Cancel & return credit and Cancel (payment needed) (brief W23 item 6)

const W23 = 'Brief W23 (D-plan 1.6, 1.7, 3 N4, 4.3, 4.7; lead call L3: claims in audit_log)'

/**
 * Item 1: a cancel's seat money and its ticked add-ons' on the same order go back in ONE card refund under one key
 * (`<claimId>:refund:<orderId>`); the old code sent the seat's refund and then the add-on's (its own `addon-refund:` key).
 * Only that passes: the order's refund larger than the old one, and the old add-on refund gone.
 */
type RefundCall = { method?: string; params?: { payment_intent?: string; amount?: number; metadata?: { refund_key?: string } } }
const refundKeyOf = (call: RefundCall | undefined): string => String(call?.params?.metadata?.refund_key)
/** The old code's add-on refunds on a PaymentIntent (their `addon-refund:` keys), in pence. */
const oldAddonRefundsOn = (recording: Recording, paymentIntent: string | undefined): number =>
  (recording.stripeCalls as RefundCall[])
    .filter((call) => call.method === 'refunds.create' && call.params?.payment_intent === paymentIntent && refundKeyOf(call).startsWith('addon-refund:'))
    .reduce((total, call) => total + Number(call.params?.amount ?? 0), 0)

const ONE_PART_PER_ORDER: AllowedDifference = {
  name: "A cancel's seat money and its ticked add-on on the same order go back in one card refund, one key (the old code sent two)",
  decision: `${W23}, item 1 (W22 review, later 1): one card part per order per claim`,
  path: /^\.stripeCalls\[\d+\](\.params\.amount)?$/,
  // W24 (W23 review, later 3): exactly the old seat refund plus the old add-on refunds on that PaymentIntent, where any
  // larger amount passed before; and a refund gone only if it was an old add-on refund on a PaymentIntent the new side
  // refunded in one part, with the same total sent back to that PaymentIntent on both sides (W24a, W24 review L2).
  actual: (value, expected, path, recordings) => {
    const index = Number(/^\.stripeCalls\[(\d+)\]/.exec(path)?.[1])
    if (path.endsWith('.amount')) {
      const merged = recordings.actual.stripeCalls[index] as RefundCall | undefined
      const seat = recordings.expected.stripeCalls[index] as RefundCall | undefined
      const paymentIntent = merged?.params?.payment_intent
      if (merged?.method !== 'refunds.create' || seat?.method !== 'refunds.create' || seat.params?.payment_intent !== paymentIntent) return false
      if (!refundKeyOf(seat).startsWith('booking-refund:')) return false
      const addons = oldAddonRefundsOn(recordings.expected, paymentIntent)
      return addons > 0 && typeof value === 'number' && typeof expected === 'number' && value === expected + addons
    }
    const old = expected as RefundCall | undefined
    if (value !== undefined || old?.method !== 'refunds.create' || !refundKeyOf(old).startsWith('addon-refund:')) return false
    // Gone into its order's one part: the new side sends exactly one refund fewer on that PaymentIntent per old add-on refund.
    const paymentIntent = old.params?.payment_intent
    const refundsOn = (recording: Recording) => (recording.stripeCalls as RefundCall[]).filter((call) => call.method === 'refunds.create' && call.params?.payment_intent === paymentIntent)
    const oldAddons = refundsOn(recordings.expected).filter((call) => refundKeyOf(call).startsWith('addon-refund:')).length
    if (refundsOn(recordings.actual).length !== refundsOn(recordings.expected).length - oldAddons) return false
    // W24a (W24 review L2): ...and the same money goes back to that PaymentIntent on both sides, to the penny, so a
    // merged part that left the add-on's money out (the old refund gone, the seat's part unchanged) is not allowed.
    const sentBack = (recording: Recording) => refundsOn(recording).reduce((total, call) => total + Number(call.params?.amount ?? Number.NaN), 0)
    return sentBack(recordings.actual) === sentBack(recordings.expected)
  },
}

/**
 * The order's status is worked out once, after the ticked add-ons are stamped (R2 is one transaction). The old code
 * worked out the booking's orders before the add-ons were stamped, and never again for an order whose add-on gave back
 * only a credit, so a guest's order with a credit add-on stayed `partially_refunded` with every line given back.
 */
const ORDER_STATUS_AFTER_ADDONS: AllowedDifference = {
  name: "A guest's order whose seat was refunded and whose credit add-on's credit came back reads `refunded` (worked out after the add-on's stamp)",
  decision: `${W23}: R2 in one transaction, the statuses last (D-plan 4.3)`,
  path: /^\.tables\.orders\.added\[\d+\]\.payment_status$/,
  actual: (value, expected) => expected === 'partially_refunded' && value === 'refunded',
}

/**
 * The cancel's database write failing (the scenario's failing `sessions` update) is inside R1, before any money moves:
 * nothing is cancelled, refunded or given, and the booking stays as it was. The old code sent the card refund (or gave
 * the store credit) first, then put the booking back live with that money as a part refund (or took the store credit
 * back). `extra` names what follows in each scenario: the next step sees the booking with all its money.
 */
const cancelWriteFails = (extra: RegExp | null, values: Readonly<Record<string, unknown>> = {}): AllowedDifference => ({
  name: "The cancel's write fails inside R1 (one transaction), before any money moves: nothing cancelled, refunded or given; the next step finds the booking as it was",
  decision: `${W23}, item 2: R1 one transaction (the old Cancel & Refund's money-first order retired); W02 finding 6`,
  path: new RegExp(
    `^\\.stripeCalls\\[1\\]$|^\\.tables\\.bookings\\.added\\[0\\]\\.(price_paid|part_refunded_amount|refund_owed_amount)$|^\\.tables\\.order_line_items\\.added\\[0\\]\\.card_refunded_amount$|^\\.tables\\.orders\\.added\\[0\\]\\.payment_status$|^\\.tables\\.store_credit_transactions(\\.added\\[[23]\\])?$${extra ? `|${extra.source}` : ''}`
  ),
  actual: (value, expected, path) => {
    const field = path.slice(path.lastIndexOf('.') + 1)
    // A figure is the same whether a row holds it as text ('100.00') or an answer as a number (100).
    if (field in values) return values[field] === value || (value !== null && value !== undefined && Number(values[field]) === Number(value))
    if (path === '.stripeCalls[1]') return value === undefined && (expected as { method?: string } | undefined)?.method === 'refunds.create'
    if (path.endsWith('.part_refunded_amount') || path.endsWith('.card_refunded_amount')) return value === '0.00'
    if (path.endsWith('.payment_status')) return value === 'paid'
    if (path.startsWith('.tables.store_credit_transactions')) return value === undefined
    return true
  },
})

const N4 = "N4 (D-plan section 3; lead's step D plan calls): Cancel & return credit's cancel, places, pass session, add-on credits and stamps are one transaction"

/** N4: the places' or the pass session's write failing rolls the whole cancel back (the old code had cancelled already). */
const n4OneTransaction = (sessions: boolean): AllowedDifference => ({
  name: "Cancel & return credit is one transaction: a write failing after the cancel rolls it back, so nothing is cancelled and the words say so (the old code left it cancelled with its place or pass session not given back, and threw 'connection lost')",
  decision: N4,
  path: new RegExp(`^\\.results\\[1\\]\\.(thrown|cancelled|reason|message)$|^\\.tables\\.bookings\\.added\\[0\\]\\.(status|cancelled_at)$${sessions ? '|^\\.tables\\.sessions$' : ''}`),
  actual: (value, expected, path) => {
    if (path.endsWith('.thrown')) return expected === 'connection lost' && value === undefined
    if (path.endsWith('.cancelled')) return value === false
    if (path.endsWith('.reason')) return value === 'cancel_not_saved'
    if (path.endsWith('.message')) return typeof value === 'string' && value.startsWith("The cancellation couldn't be saved")
    if (path.endsWith('.status')) return value === 'confirmed'
    if (path.endsWith('.cancelled_at')) return value === null
    // The booking's place is still held: its session counts it, as before the cancel.
    return JSON.stringify((value as { changed?: unknown } | undefined)?.changed) === JSON.stringify([{ id: '10000000-0000-4000-8000-000000000004', total_booked: [0, 1] }])
  },
})

/**
 * Cancel & Refund's card refund went and only the route's answer was lost: the dialog gets no answer and keeps its key;
 * the next press, under the same key, gets the first press's stored answer, so nothing is sent again. The old code put
 * the booking back with everything owed and sent the refund again under its figure-built key.
 */
const CANCEL_ANSWER_LOST: AllowedDifference = {
  name: "Cancel & Refund's answer is lost after its route ran to the end: no answer, the key kept, and the next press gets the stored answer (nothing sent twice)",
  decision: `${W23}; W20's model of a lost answer (the route ran); W03-plan 2.6 (the key kept); W02 finding 6`,
  path: /^\.results\[1\]\.(unsure|noAnswer)$|^\.stripeCalls\[2\]$/,
  actual: (value, expected, path) => {
    if (path.endsWith('.noAnswer')) return typeof value === 'object' && value !== null && String((value as { message?: unknown }).message).startsWith("Cancelling didn't get an answer")
    if (path === '.stripeCalls[2]') return value === undefined && (expected as { method?: string } | undefined)?.method === 'refunds.create'
    return value === undefined
  },
}

/**
 * A lost answer on the old store credit statement (its hook matches the old SQL, which the Worker doesn't run): R1 is
 * one transaction, so the booking is cancelled with its £100 to store credit once. It already arrived then finds it
 * cancelled, and so does the last Cancel & Refund (both refused with the old words); the customer gets the same £100.
 */
const CANCEL_NO_LOST_ANSWER: AllowedDifference = {
  name: "A lost answer on the old store credit statement: R1 is one transaction, so the cancel goes through once with £100 to store credit; the next two presses find it cancelled (W25: It already arrived runs on a cancelled booking, and finds nothing owed)",
  decision: `${W23}: R1 one transaction (W05 review 3, finding 3 for refunds); brief W25 item 6 (W23 review later 1): Refund the rest and It already arrived run on a cancelled booking`,
  path: /^\.results\[1\]\.(unsure|cardRefundedAmount|storeCreditRefundedAmount|storeCreditBalance)$|^\.results\[[23]\]\.(cardRefundedAmount|storeCreditRefundedAmount|pricePaid|thrown)$|^\.results\[2\]\.refused$|^\.tables\.bookings\.added\[0\]\.(price_paid|refund_owed_amount)$|^\.tables\.order_line_items\.added\[0\]\.(refunded_at|refund_method)$|^\.tables\.orders\.added\[0\]\.payment_status$/,
  actual: (value, _expected, path) => {
    if (path.startsWith('.results[1]')) return path.endsWith('.unsure') ? value === undefined : path.endsWith('.storeCreditRefundedAmount') ? value === 100 : path.endsWith('.cardRefundedAmount') ? value === 0 : typeof value === 'number'
    // W25: It already arrived (result 2) is no longer refused for the cancel: it finds nothing owed, with the figures.
    if (path === '.results[2].refused') {
      const refused = value as { message?: unknown; figures?: { refundOwed?: unknown; status?: unknown } } | undefined
      return refused?.message === 'Nothing is owed on this booking any more.' && refused.figures?.refundOwed === 0 && refused.figures?.status === 'cancelled'
    }
    if (path === '.results[2].thrown') return value === undefined
    if (path.endsWith('.thrown')) return value === 'This booking is already cancelled.'
    if (path.startsWith('.results')) return value === undefined
    if (path.endsWith('.price_paid')) return value === '100.00'
    if (path.endsWith('.refund_owed_amount')) return value === '0.00'
    if (path.endsWith('.refunded_at')) return value === '<set>'
    if (path.endsWith('.refund_method')) return value === 'credit'
    return value === 'refunded'
  },
}

const W23A_CLUB = "Brief W23a item 3 (Wayne, 13 Nov): when the club cancels (Block Session, Block Day: `clubCancelled`), the 24-hour rule doesn't apply"
const WITHIN_24_WORDS = 'Not eligible for refund or credit — within 24 hours of session start.'

/**
 * W23a: Cancel & Refund from Block Session, 22 hours before the session. The old code refused it (it had no club's
 * cancel); the Worker gives the whole £40 back to the card in one refund keyed from the claim, the booking cancelled,
 * its two places released (so the session ends where it began), its line and order refunded. The same press from the
 * booking page, just before, is refused on both sides (not named: it matches).
 */
const CLUB_CANCEL_AND_REFUND: AllowedDifference = {
  name: "The club's Cancel & Refund inside 24 hours gives the whole booking back (the old code refused it)",
  decision: W23A_CLUB,
  path: /^\.results\[2\]\.(thrown|cardRefundedAmount|storeCreditRefundedAmount)$|^\.stripeCalls\[1\]$|^\.tables\.bookings\.added\[0\]\.(status|cancelled_at)$|^\.tables\.order_line_items\.added\[0\]\.(refunded_at|refund_method|card_refunded_amount)$|^\.tables\.orders\.added\[0\]\.payment_status$|^\.tables\.sessions$/,
  actual: (value, expected, path) => {
    if (path.endsWith('.thrown')) return expected === WITHIN_24_WORDS && value === undefined
    if (path.endsWith('.cardRefundedAmount')) return value === 40
    if (path.endsWith('.storeCreditRefundedAmount')) return value === 0
    if (path === '.stripeCalls[1]') {
      const call = value as { method?: string; params?: { amount?: number }; idempotencyKey?: string } | undefined
      return expected === undefined && call?.method === 'refunds.create' && call.params?.amount === 4000 && call.idempotencyKey === 'audit_log#1:refund:orders#1'
    }
    if (path.endsWith('.status')) return expected === 'confirmed' && value === 'cancelled'
    if (path.endsWith('.cancelled_at') || path.endsWith('.refunded_at')) return value === '<set>'
    if (path.endsWith('.refund_method')) return value === 'card'
    if (path.endsWith('.card_refunded_amount')) return value === '40.00'
    if (path.endsWith('.payment_status')) return value === 'refunded'
    // Booked (0 -> 2) and released again: no change to the session at the end.
    return path === '.tables.sessions' && value === undefined
  },
}

/**
 * W23a: Cancel & return credit from Block Day, 22 hours before the session. The old code refused it; the Worker cancels
 * it with its credit usable again: the pass session back (the pass ends where it began, 3) and its place released.
 */
const CLUB_CANCEL_CREDIT: AllowedDifference = {
  name: "The club's Cancel & return credit inside 24 hours gives the credit back (the old code refused it)",
  decision: W23A_CLUB,
  path: /^\.results\[2\]\.(cancelled|reason|message|creditUsableAgain|booking)$|^\.tables\.bookings\.added\[0\]\.(status|cancelled_at)$|^\.tables\.(customer_session_passes|sessions)$/,
  actual: (value, expected, path) => {
    if (path.endsWith('.cancelled')) return expected === false && value === true
    if (path.endsWith('.reason')) return expected === 'within_24_hours' && value === undefined
    if (path.endsWith('.message')) return expected === WITHIN_24_WORDS && value === undefined
    if (path.endsWith('.creditUsableAgain')) return value === true
    if (path.endsWith('.booking')) return JSON.stringify(value) === JSON.stringify({ id: 'bookings#1', status: 'cancelled' })
    if (path.endsWith('.status')) return expected === 'confirmed' && value === 'cancelled'
    if (path.endsWith('.cancelled_at')) return value === '<set>'
    // The pass (3 -> 2 -> 3) and the session (0 -> 1 -> 0) end where they began.
    return value === undefined
  },
}

/**
 * W23: every golden scenario that calls Cancel & Refund or Cancel & return credit and differs, and the only differences
 * allowed in each (with the W19 to W22 allowances it already had). The rest match their golden files exactly.
 */
export const CANCEL_DIFFERENCES: ReadonlyMap<string, readonly AllowedDifference[]> = new Map<string, readonly AllowedDifference[]>([
  ...[
    'add-guest-while-a-reader-move-is-open',
    'addon-on-the-first-order-private-not-ticked',
    'addon-on-the-first-order-public-not-ticked',
    'addon-with-guest-private-card-not-ticked',
    'addon-with-guest-private-cash-ticked',
    'addon-with-guest-private-reader-not-ticked',
    'addon-with-guest-private-split-card-not-ticked',
    'addon-with-guest-private-split-reader-not-ticked',
    'addon-with-guest-public-card-not-ticked',
    'addon-with-guest-public-cash-ticked',
    'addon-with-guest-public-reader-not-ticked',
    'addon-with-guest-public-split-card-not-ticked',
    'addon-with-guest-public-split-reader-not-ticked',
    'addon-with-guest-removed-to-store-credit-then-cancel',
    'addon-with-guest-same-tier-not-ticked',
    'addon-with-guest-same-tier-ticked',
    'addon-with-no-guest-on-the-card-ticked',
    'cancel-while-a-guest-is-on-the-reader',
    'cancel-while-a-reader-move-is-open',
    'move-refund-store-credit-fails-outright-then-retried',
    'owed-arrived-then-cancel',
    'owed-public-then-a-same-price-move',
    'owed-then-a-dearer-move-then-cancel',
    'owed-then-cancel',
    'public-move-refund-fails-outright-then-retried',
    'q24-cancel-and-refund-to-the-card',
    'q24-other-items-keep-their-money',
    'q24-split-payment-refunded',
    'q25-guest-removed-then-another-added',
    'q25-guests-up-through-the-tiers-then-refund',
    'q25-higher-tier-free-booking-then-refund',
    'q25-higher-tier-guest-and-addon-on-the-card',
    'q25-higher-tier-in-cash-then-refund',
    'q25-higher-tier-on-the-card-then-refund',
    'q25-higher-tier-on-the-reader-then-refund',
    'q25-higher-tier-split-in-cash-then-refund',
    'q25-higher-tier-split-on-the-card-then-refund',
    'q25-higher-tier-split-on-the-reader-then-refund',
    'q25-no-promo-higher-tier-then-refund',
    'q25-no-promo-same-tier-then-refund',
    'q25-public-promo-guest-in-cash-then-refund',
    'q25-public-promo-guest-on-the-card-then-refund',
    'q25-same-tier-fixed-promo-then-refund',
    'q25-same-tier-guest-and-addon-on-the-card',
    'q25-same-tier-then-refund-to-the-card',
    'q27-cheaper-move-is-not-a-part-refund',
    'q27-cheaper-move-to-store-credit-is-not-a-part-refund',
    'q27-no-promo-part-to-credit-higher-tier-then-to-the-card',
    'q27-part-to-credit-higher-tier-on-the-card-then-to-the-card',
    'q27-part-to-credit-higher-tier-on-the-reader-then-to-the-card',
    'q27-part-to-credit-same-tier-then-to-the-card',
    'q27-tier-rise-after-a-cheaper-move',
    'q28-private-same-price-part-to-store-credit',
    'q28-public-same-price-part-to-store-credit',
    'remove-guest-then-cancel',
    'w05l-add-guest-gift-card-and-cash-answer-lost-then-cancel',
    'w05l-add-guest-gift-card-and-reader-answer-lost-then-cancel',
    'w05l-move-fails-after-another-press-finished',
    'w05l-move-gift-card-and-card-then-cancel',
    'w05l-move-gift-card-and-cash-answer-lost-then-cancel',
    'w05l-move-gift-card-and-cash-then-cancel',
    'w05l-move-gift-card-and-reader-answer-lost-then-cancel',
    'w05l-move-gift-card-and-reader-then-cancel',
    'w05l-move-gift-card-and-reader-undone-then-cancel',
    'w05l-move-gift-card-answer-lost-then-cancel',
    'w05l-settle-gift-card-and-card-then-cancel',
    'w05l-settle-gift-card-and-reader-answer-lost-then-cancel',
    'w05l-settle-gift-card-and-reader-then-cancel',
    'w05l-settle-gift-card-and-reader-undone-then-settled',
    'w05l-settle-gift-card-answer-lost-then-cancel',
    'part-refund-fails-partway-then-the-rest',
    'part-refund-fails-partway-then-a-guest',
  ].map((name): [string, readonly AllowedDifference[]] => [name, [CLAIM_KEYS]]),
  ...[
    'addon-on-the-first-order-private-ticked',
    'addon-on-the-first-order-public-ticked',
    'addon-with-guest-cheaper-move-then-cancel',
    'addon-with-guest-private-reader-ticked',
    'addon-with-guest-private-split-card-ticked',
    'addon-with-guest-private-split-reader-ticked',
    'addon-with-guest-public-card-ticked',
    'addon-with-guest-public-reader-ticked',
    'addon-with-guest-public-split-card-ticked',
    'addon-with-guest-public-split-reader-ticked',
    'q25-guest-and-addon-both-refunded-to-the-card',
    'q25-no-promo-guest-and-addon-both-refunded-to-the-card',
  ].map((name): [string, readonly AllowedDifference[]] => [name, [CLAIM_KEYS, ONE_PART_PER_ORDER]]),
  ['credit-addon-with-guest-on-the-card', [CLAIM_KEYS, ORDER_STATUS_AFTER_ADDONS]],
  ['cancel-write-fails-after-the-card', [cancelWriteFails(null, { price_paid: '100.00' })]],
  ['cancel-write-fails-public-then-a-same-price-move', [cancelWriteFails(/^\.results\[2\]\.booking\.price_paid$/, { price_paid: 40 })]],
  ['cancel-write-fails-then-a-same-price-move', [cancelWriteFails(/^\.results\[2\]\.booking\.price_paid$/, { price_paid: 100 })]],
  ['cancel-write-fails-to-store-credit', [cancelWriteFails(null)]],
  ['owed-then-cancel-write-fails', [cancelWriteFails(null, { price_paid: '140.00', refund_owed_amount: '40.00' })]],
  // The retry then gives everything: £90 to the card and £10 to store credit (the old retry gave only the £10 left).
  ['cancel-write-fails-card-and-credit-then-retried', [CLAIM_KEYS, cancelWriteFails(/^\.results\[1\]\.cardRefundedAmount$/, { price_paid: '100.00', cardRefundedAmount: 90 })]],
  ['owed-then-cancel-write-fails-after-part-of-it', [CLAIM_KEYS, cancelWriteFails(/^\.results\[3\]\.cardRefundedAmount$/, { price_paid: '140.00', cardRefundedAmount: 110 })]],
  [
    'cancel-write-fails-then-a-guest',
    [
      AG_KEYS,
      AG_CARD_METHOD,
      // The guest's card charge is the second Stripe call now (no refund before it), with the next PaymentIntent id.
      cancelWriteFails(/^\.stripeCalls\[[12]\](\..+)?$|^\.tables\.orders\.added\[1\]\.stripe_payment_intent_id$/, { price_paid: '150.00', stripe_payment_intent_id: 'pi_fake_0004' }),
    ],
  ],
  ['unsure-cancel-card-pressed-again', [CLAIM_KEYS, CANCEL_ANSWER_LOST]],
  ['unsure-cancel-store-credit-arrived', [CANCEL_NO_LOST_ANSWER]],
  ['w17-n4-cancel-credit-places-write-fails-after-the-cancel', [n4OneTransaction(false)]],
  ['w17-n4-cancel-credit-pass-session-write-fails-after-the-cancel', [n4OneTransaction(true)]],
  // W23a: the club's cancel (Block Session, Block Day) inside 24 hours.
  ['w23a-block-session-cancel-and-refund-inside-24-hours', [CLUB_CANCEL_AND_REFUND]],
  ['w23a-block-day-cancel-credit-inside-24-hours', [CLUB_CANCEL_CREDIT]],
])

// --- W24: Move (brief W24 item 8)

const W24 = 'Brief W24 (D-plan 1.2, 4.2, 4.3, 4.7; W19\'s flows, W21\'s claims)'

/** A Move on the card or reader is keyed from its flow record, and names it in its metadata (W19's rule). */
const MOVE_KEYS = flowKeys('A Move', `${W24}: keys from the record, never from the booking's updated_at`)
/** A Move on the reader: its flow record carries the Worker's marks (W19's rule). */
const MOVE_READER = readerFlowMarks('A Move', `${W24}: pending-first with method, request_id, livemode, stripe_customer_id; a card Move's record is set aside and checked on its own (cardRecordProblems)`)
/** A Move's card part's order says 'card' (Q9), where the legacy charge route left it empty. */
const MOVE_CARD_METHOD = cardOrderMethod("W03-decisions Q9 (an order paid on the saved card records 'card'); W17's card C2; Q36 keeps the card part's own order and line")

/**
 * A cheaper move's quote also says, for the dialog, whether card money is left and how the refund would split between
 * the card(s) that paid and store credit (Q37). Only on a quote that gives money back; only these two fields; and the
 * split must add up to that quote's refund (W24a).
 */
const MOVE_QUOTE_REFUND_CHOICE: AllowedDifference = {
  name: "A cheaper move's quote also says whether card money is left and how its refund splits between the card and store credit (Q37)",
  decision: `${W24}, item 7; Wayne's Q37 (12 Nov): the card offered from card money left`,
  path: /^\.results\[\d+\]\.(cardRefundAvailable|refundParts)$/,
  actual: (value, expected, path, recordings) => {
    if (expected !== undefined) return false
    if (path.endsWith('.cardRefundAvailable')) return typeof value === 'boolean'
    const parts = value as { card?: unknown; storeCredit?: unknown } | null
    if (parts === null || typeof parts !== 'object' || Object.keys(parts).sort().join(',') !== 'card,storeCredit') return false
    if (typeof parts.card !== 'number' || typeof parts.storeCredit !== 'number' || parts.card < 0 || parts.storeCredit < 0) return false
    // W24a (W24 review L3): the two parts add up to the quote's own refund, to the penny (the same answer's amountDue,
    // which is compared with the old side's and has no allowance here).
    const quoted = recordings.actual.results[Number(/^\.results\[(\d+)\]/.exec(path)?.[1])] as { priceImpact?: { amountDue?: unknown } } | undefined
    const amountDue = quoted?.priceImpact?.amountDue
    return typeof amountDue === 'number' && amountDue < 0 && Math.round((parts.card + parts.storeCredit) * 100) === Math.round(-amountDue * 100)
  },
}

const MOVE_CARD = [MOVE_KEYS, MOVE_CARD_METHOD]
const MOVE_READER_ONLY = [MOVE_KEYS, MOVE_READER]
const MOVE_CHEAPER = [CLAIM_KEYS, MOVE_QUOTE_REFUND_CHOICE]

const MOVE_REFUND_FAILED_WORDS = (value: unknown): boolean =>
  typeof value === 'string' && value.startsWith('The card refund failed (') && value.endsWith("so the booking wasn't moved and nothing was refunded. Try again, or refund the difference to store credit.")
const MOVE_NOT_SAVED_WORDS = (value: unknown): boolean => typeof value === 'string' && value.startsWith("The move couldn't be saved")
const NOTHING_OWED = (value: unknown): boolean => String((value as { message?: unknown } | null)?.message) === 'Nothing is owed on this booking any more.'

/**
 * A cheaper move's first card refund refused (`move-refund-card-declined`): the old code kept the move and left the £40
 * owed; the Worker puts the move back exactly (the booking on its old session and band, both sessions' places, nothing
 * owed) and says so. `then`: what the later steps see instead: Refund the rest finds nothing owed, and Cancel & Refund
 * gives the whole £140 in one refund where the old code gave the £40 and then £100.
 */
const moveRefusedPutBack = (then: boolean): AllowedDifference => ({
  name: `A cheaper move's first card refund refused: the move put back exactly, nothing owed${then ? '; Refund the rest then finds nothing owed and Cancel & Refund gives all £140 in one refund' : ''}`,
  decision: `${W24}, item 4: the first refusal undoes the move exactly (W21's R1 undo)`,
  path: new RegExp(
    `^\\.results\\[2\\]\\.(moved|booking|reason|warning|message)$|^\\.tables\\.bookings\\.added\\[0\\]\\.(session_id|band_id|refund_owed_amount)$|^\\.tables\\.sessions\\.changed\\[0\\]\\.id$${
      then
        ? '|^\\.results\\[3\\]\\.(cardRefundedAmount|storeCreditRefundedAmount|pricePaid|refused)$|^\\.results\\[4\\]\\.cardRefundedAmount$|^\\.stripeCalls\\[2\\]\\.params\\.amount$|^\\.stripeCalls\\[3\\]$|^\\.tables\\.bookings\\.added\\[0\\]\\.price_paid$'
        : ''
    }`
  ),
  actual: (value, expected, path) => {
    if (path.endsWith('.moved')) return value === false
    if (path.endsWith('.reason')) return value === 'refund_failed'
    if (path.endsWith('.message')) return MOVE_REFUND_FAILED_WORDS(value)
    if (path.endsWith('.booking') || path.endsWith('.warning')) return value === undefined
    if (path.endsWith('.session_id')) return value === '10000000-0000-4000-8000-000000000040'
    if (path.endsWith('.band_id')) return value === '10000000-0000-4000-8000-00000000000c'
    if (path.endsWith('.refund_owed_amount')) return value === '0.00'
    if (path.endsWith('.changed[0].id')) return value === '10000000-0000-4000-8000-000000000040'
    if (path.endsWith('.refused')) return NOTHING_OWED(value)
    if (path.startsWith('.results[3]')) return value === undefined
    if (path.startsWith('.results[4]')) return value === 140
    if (path.endsWith('.params.amount')) return value === 14000
    if (path === '.stripeCalls[3]') return value === undefined && (expected as { method?: string } | undefined)?.method === 'refunds.create'
    return path.endsWith('.price_paid') && value === '140.00'
  },
})

/**
 * A cheaper move to store credit whose store credit write fails (`move-refund-store-credit-fails-outright` and its family):
 * R1 is one transaction, so nothing is moved, given or owed, and the words say so (the old code moved it and left the
 * money owed). `then`: Refund the rest finds nothing owed, and Cancel & Refund gives the whole price paid to the card in
 * one refund (the customer gets the same total: the old code gave the difference as store credit and the rest to the card).
 */
const moveNotSaved = (scenario: { result: number; oldSession: string; oldBand: string; seatsBack?: boolean; then?: { all: number; less: number; credit: number; balance: number } }): AllowedDifference => {
  const { then } = scenario
  return {
    name: `A cheaper move whose store credit can't be written is one transaction: not moved, nothing given or owed${then ? `; Refund the rest finds nothing owed, and Cancel & Refund gives all £${then.all} to the card` : ''}`,
    decision: `${W24}, item 4: same price or cheaper with no card is one transaction (R1); W05 review 3, finding 3 for refunds`,
    path: new RegExp(
      `^\\.results\\[${scenario.result}\\]\\.(moved|booking|reason|warning|message)$|^\\.tables\\.bookings\\.added\\[0\\]\\.(session_id|band_id|refund_owed_amount)$|^\\.tables\\.sessions\\.changed\\[0\\]\\.id$${scenario.seatsBack ? '|^\\.tables\\.booking_guests\\.added\\[[01]\\]\\.unit_price$' : ''}${
        then
          ? `|^\\.results\\[${scenario.result + 1}\\]\\.(cardRefundedAmount|storeCreditRefundedAmount|storeCreditBalance|pricePaid|refused)$|^\\.results\\[${scenario.result + 2}\\]\\.cardRefundedAmount$|^\\.stripeCalls\\[1\\]\\.params\\.amount$|^\\.tables\\.bookings\\.added\\[0\\]\\.price_paid$|^\\.tables\\.(customers|store_credit_transactions)$|^\\.tables\\.order_line_items\\.added\\[0\\]\\.card_refunded_amount$`
          : ''
      }`
    ),
    actual: (value, _expected, path) => {
      if (path.endsWith('.moved')) return value === false
      if (path.endsWith('.reason')) return value === 'move_not_saved'
      if (path.endsWith('.message')) return MOVE_NOT_SAVED_WORDS(value)
      if (path.endsWith('.booking') || path.endsWith('.warning')) return value === undefined
      if (path.endsWith('.session_id') || path.endsWith('.changed[0].id')) return value === scenario.oldSession
      if (path.endsWith('.band_id')) return value === scenario.oldBand
      if (path.endsWith('.refund_owed_amount')) return value === '0.00'
      if (path.endsWith('.unit_price')) return value === '25.50'
      if (!then) return false
      if (path.endsWith('.refused')) return NOTHING_OWED(value)
      if (path.startsWith(`.results[${scenario.result + 1}]`)) return value === undefined
      if (path.startsWith(`.results[${scenario.result + 2}]`)) return value === then.all
      if (path.endsWith('.params.amount')) return value === then.all * 100
      if (path.endsWith('.price_paid')) return Number(value) === then.all
      if (path.endsWith('.card_refunded_amount')) return Number(value) === then.all
      // No store credit at all: the move gave none, and the cancel's money all went to the card.
      return value === undefined
    },
  }
}

const PEAK_PRIVATE = { oldSession: '10000000-0000-4000-8000-000000000040', oldBand: '10000000-0000-4000-8000-00000000000c' }
const PEAK_PUBLIC = { oldSession: '10000000-0000-4000-8000-00000000000e', oldBand: '10000000-0000-4000-8000-00000000000c' }

/**
 * A cheaper move to the card whose card part went and whose store credit write then failed (the `*-credit-fails-partway`
 * family): R2 is one transaction, so the claim is held (W21's words: what went), never sent again; the booking stays as
 * R1 left it until reconcile finishes the claim. The old code recorded the card part and left the rest owed. Before the
 * next step reconcile finishes it (as staff would find it on the Orders page): the card part recorded and the planned
 * store credit given (the move's note), so Refund the rest finds nothing owed; the customer gets the same card and store
 * credit money.
 */
const moveHeldWhileStoreCreditFails = (scenario: { result: number; gone: number; r1PricePaid: number; recorded?: string; then?: 'the_rest' | 'same_price_move' }): AllowedDifference => ({
  name: `A cheaper move's £${scenario.gone.toFixed(2)} card part went and R2's store credit failed: held (the words say what went); ${scenario.then ? 'reconcile finishes it before the next step, which finds nothing owed' : 'the booking as R1 left it until reconcile finishes it'}`,
  decision: `${W24}, item 4 (W21's R2: one transaction, held for reconcile, Q35); D-plan 4.10 (reconcile records what went, never resends)`,
  path: new RegExp(
    `^\\.results\\[${scenario.result}\\]\\.(booking\\.price_paid|warning)$${
      scenario.then === 'the_rest'
        ? `|^\\.results\\[${scenario.result + 1}\\]\\.(cardRefundedAmount|storeCreditRefundedAmount|storeCreditBalance|pricePaid|refused)$|^\\.tables\\.store_credit_transactions\\.added\\[1\\]\\.note$`
        : scenario.then === 'same_price_move'
          ? `|^\\.results\\[${scenario.result + 2}\\]\\.booking\\.price_paid$|^\\.tables\\.bookings\\.added\\[0\\]\\.(price_paid|refund_owed_amount)$|^\\.tables\\.customers$|^\\.tables\\.store_credit_transactions\\.added\\[1\\]$`
          : '|^\\.tables\\.bookings\\.added\\[0\\]\\.(price_paid|refund_owed_amount)$|^\\.tables\\.order_line_items\\.added\\[0\\]\\.card_refunded_amount$'
    }`
  ),
  actual: (value, _expected, path) => {
    if (path.endsWith('.warning')) return goneNotRecorded(scenario.gone)(value)
    if (path.endsWith('.booking.price_paid')) return value === scenario.r1PricePaid
    if (path.endsWith('.refused')) return NOTHING_OWED(value)
    if (path.startsWith(`.results[${scenario.result + 1}]`)) return value === undefined
    if (path.endsWith('.note')) return value === 'Refund of the price difference after a booking move (the rest went back to the card). [ref gone]'
    if (path.endsWith('.price_paid')) return Number(value) === scenario.r1PricePaid
    if (path.endsWith('.refund_owed_amount')) return value === '0.00'
    if (path.endsWith('.card_refunded_amount')) return value === scenario.recorded
    // The planned £30 store credit given by reconcile: the balance ends where it began (£30 taken at the order, £30 back).
    if (path === '.tables.customers') return value === undefined
    return typeof value === 'object' && value !== null && (value as { reason?: unknown }).reason === 'refund'
  },
})

/** The Worker's answer is lost after its move route ran to the end (W20's model): no answer, the key kept. */
const MOVE_NO_ANSWER = (value: unknown): boolean => typeof value === 'string' && value.startsWith("Moving didn't get an answer")

/**
 * The old hooks for a lost answer match the old code's own statements (its press row, its single statement), which the
 * Worker doesn't run: C1 is one transaction, so the move simply goes through once with what it took.
 */
const moveNoLostAnswer = (result: number): AllowedDifference => ({
  name: "A lost answer on the old statement: the hook matches the old code's SQL, which the Worker doesn't run; C1 is one transaction, so the move goes through once",
  decision: `${W24}, item 5: one transaction (W05 review 3, finding 1; the old press rows retired)`,
  path: new RegExp(`^\\.results\\[${result}\\]\\.(moved|reason|message|booking)$`),
  actual: (value, _expected, path) => (path.endsWith('.moved') ? value === true : path.endsWith('.booking') ? JSON.stringify(value) === JSON.stringify({ id: 'bookings#1', price_paid: 51 }) : value === undefined),
})

/**
 * Wayne's Q34 (N2): the old code kept a credit on a booking moved past the membership's last day, or a pass seat moved
 * past the pass's expiry (£0 due, moved, the seat still free). The Worker releases it: the seat is charged its full new
 * price (£20), so the press with no payment is refused for a method with the new figures, and nothing moves.
 */
const Q34_RELEASED: AllowedDifference = {
  name: "Q34: a credit that doesn't cover the new date is released: the seat is £20 (paid, the credit released), and the press with no payment is refused for a method",
  decision: "Wayne's Q34 (12 Nov, as recommended): a credit stays on a move only if it covers the new date; brief W24 item 2",
  path: /^\.results\[1\]\.priceImpact\.(amountDue|seatDeltas\[0\]\.(payBy|delta|creditReleased))$|^\.results\[2\]\.(moved|booking|reason|priceImpact)$|^\.tables\.bookings\.added\[0\]\.session_id$|^\.tables\.sessions\.changed\[0\]\.id$/,
  actual: (value, _expected, path) => {
    if (path.endsWith('.amountDue') || path.endsWith('.delta')) return value === 20
    if (path.endsWith('.payBy')) return value === 'paid'
    if (path.endsWith('.creditReleased')) return value === true
    if (path.endsWith('.moved')) return value === false
    if (path.endsWith('.booking')) return value === undefined
    if (path.endsWith('.reason')) return value === 'payment_method_required'
    if (path.endsWith('.priceImpact')) return (value as { amountDue?: unknown } | undefined)?.amountDue === 20
    // Not moved: still on the Core session of the 12th.
    return value === '10000000-0000-4000-8000-000000000004'
  },
}

const N1 = "N1 (D-plan section 3; brief W24 item 3): one booking a day is checked before any money moves, with New Order's words"
const DUPLICATE_DAY_WORDS = 'This customer already has a booking on that day. Only one booking per customer per day is allowed.'

/**
 * W24: every golden scenario that calls Move and differs, and the only differences allowed in each (with the W19 to W23
 * allowances it already had). The rest match their golden files exactly.
 */
export const MOVE_DIFFERENCES: ReadonlyMap<string, readonly AllowedDifference[]> = new Map<string, readonly AllowedDifference[]>([
  // Cheaper to the card: the claim's keys, and the quote's card choice.
  ...[
    'q27-cheaper-move-is-not-a-part-refund',
    'q27-part-refund-after-a-cheaper-move-still-counts',
    'addon-with-guest-cheaper-move-then-cancel',
    'q27-tier-rise-after-a-cheaper-move',
    'q28-private-cheaper-to-the-card',
    'q28-private-cheaper-stops-at-what-is-left',
    'q28-public-cheaper-to-the-card',
    'q28-public-cheaper-stops-at-what-is-left',
    'remove-guest-after-a-cheaper-move',
    'w05l-move-cheaper-answer-lost',
  ].map((name): [string, readonly AllowedDifference[]] => [name, MOVE_CHEAPER]),
  // Cheaper to store credit: only the quote's card choice.
  ...['q27-cheaper-move-to-store-credit-is-not-a-part-refund', 'q28-private-cheaper-to-store-credit', 'q28-public-cheaper-to-store-credit', 'cheaper-move-to-store-credit-stays-live'].map(
    (name): [string, readonly AllowedDifference[]] => [name, [MOVE_QUOTE_REFUND_CHOICE]]
  ),
  // Dearer on the saved card.
  ...['q28-private-dearer-on-the-card', 'q28-private-dearer-store-credit-and-card', 'q28-public-dearer-on-the-card', 'q28-public-credit-released-after-a-part-refund', 'w05l-move-gift-card-and-card-then-cancel', 'owed-then-a-dearer-move', 'owed-then-a-dearer-move-then-cancel'].map(
    (name): [string, readonly AllowedDifference[]] => [name, MOVE_CARD]
  ),
  // Its flow key is covered by Add Guest's allowance (the same key rule): only the card order's method is the Move's.
  ['move-while-a-guest-is-on-the-reader', [MOVE_CARD_METHOD]],
  ['q28-private-there-and-back', [...MOVE_CARD, ...MOVE_CHEAPER]],
  ['q28-private-cheaper-move-then-part-then-dearer-move', [...MOVE_CARD, ...MOVE_CHEAPER]],
  ['capped-move-down-then-back-up', [...MOVE_CARD, ...MOVE_CHEAPER]],
  // Dearer on the reader.
  ...[
    'q28-private-dearer-on-the-reader',
    'q28-public-dearer-on-the-reader',
    'q28-private-reader-cancelled-puts-it-all-back',
    'w05l-move-gift-card-and-reader-then-cancel',
    'w05l-move-gift-card-and-reader-undone-then-cancel',
    'w05l-move-gift-card-and-reader-answer-lost-then-cancel',
    'add-guest-while-a-reader-move-is-open',
    'cancel-while-a-reader-move-is-open',
    'part-refund-while-a-reader-move-is-open',
    'refund-the-rest-while-a-reader-move-is-open',
    'second-move-while-a-reader-move-is-open',
  ].map((name): [string, readonly AllowedDifference[]] => [name, MOVE_READER_ONLY]),
  // Their flow keys are covered by Add Guest's allowance (the same key rule): only the Move's reader marks.
  ...['remove-guest-while-a-reader-move-is-open', 'reader-move-finished-then-remove-guest'].map((name): [string, readonly AllowedDifference[]] => [name, [MOVE_READER]]),
  // Item 4: the first card refusal puts the move back; a store credit write failing is one transaction.
  ['move-refund-card-declined', [...MOVE_CHEAPER, moveRefusedPutBack(false)]],
  ['move-refund-card-declined-then-retried', [...MOVE_CHEAPER, moveRefusedPutBack(true)]],
  ['move-refund-store-credit-fails-outright', [MOVE_QUOTE_REFUND_CHOICE, moveNotSaved({ result: 2, ...PEAK_PRIVATE })]],
  ['move-refund-store-credit-fails-outright-then-retried', [...MOVE_CHEAPER, moveNotSaved({ result: 2, ...PEAK_PRIVATE, then: { all: 140, less: 100, credit: 40, balance: 70 } })]],
  ['public-move-refund-fails-outright-then-retried', [...MOVE_CHEAPER, moveNotSaved({ result: 2, ...PEAK_PUBLIC, seatsBack: true, then: { all: 51, less: 40, credit: 11, balance: 41 } })]],
  ['public-move-credit-fails-partway', [...MOVE_CHEAPER, moveHeldWhileStoreCreditFails({ result: 3, gone: 6, r1PricePaid: 25, recorded: '15.00' })]],
  ['public-move-credit-fails-partway-then-retried', [...MOVE_CHEAPER, moveHeldWhileStoreCreditFails({ result: 3, gone: 6, r1PricePaid: 25, then: 'the_rest' })]],
  ['private-move-credit-fails-partway', [...MOVE_CHEAPER, moveHeldWhileStoreCreditFails({ result: 3, gone: 10, r1PricePaid: 0, recorded: '100.00' })]],
  ['private-move-credit-fails-partway-then-retried', [...MOVE_CHEAPER, moveHeldWhileStoreCreditFails({ result: 3, gone: 10, r1PricePaid: 0, then: 'the_rest' })]],
  ['private-move-credit-fails-then-a-same-price-move-leaves-it-owed', [...MOVE_CHEAPER, moveHeldWhileStoreCreditFails({ result: 3, gone: 10, r1PricePaid: 0, then: 'same_price_move' })]],
  ['private-move-rest-retried-then-a-same-price-move', [...MOVE_CHEAPER, moveHeldWhileStoreCreditFails({ result: 3, gone: 30, r1PricePaid: 20, then: 'the_rest' })]],
  // Item 5 (W05i "die between", W05k): the press's answer lost after the Worker's route ran (the old code resumed and
  // charged again under its key); the same press again gets the stored answer, so the card is charged once.
  [
    'dies-after-the-charge-move',
    [
      ...MOVE_CARD,
      {
        name: "The press's answer is lost after the move route ran to the end (C1, then the card): no answer, the key kept; the same press again gets the stored answer, so the card is charged once (the old resume charged again)",
        decision: `${W24}, item 5; W20's model of a lost answer; W03-plan 2.6 (the key kept)`,
        path: /^\.results\[1\]\.(reason|message)$|^\.stripeCalls\[2\]$/,
        actual: (value, expected, path) => {
          if (path.endsWith('.reason')) return value === 'no_answer'
          if (path.endsWith('.message')) return MOVE_NO_ANSWER(value)
          return value === undefined && (expected as { method?: string } | undefined)?.method === 'paymentIntents.create'
        },
      },
    ],
  ],
  [
    'unsure-cheaper-move-card-then-the-rest',
    [
      ...MOVE_CHEAPER,
      {
        name: "A cheaper move's answer is lost after its route ran to the end (the card refund went and R2 recorded it): no answer, the key kept; Refund the rest then finds nothing owed (the old code left the £40 owed and Refund the rest gave it again under the old key)",
        decision: `${W24}, item 4; W20's model of a lost answer; D-plan 4.3 (no refund sent twice)`,
        path: /^\.results\[2\]\.(moved|booking|reason|warning|message)$|^\.results\[3\]\.(cardRefundedAmount|storeCreditRefundedAmount|pricePaid|refused)$/,
        actual: (value, _expected, path) => {
          if (path.endsWith('.moved')) return value === false
          if (path.endsWith('.reason')) return value === 'no_answer'
          if (path.endsWith('.message')) return MOVE_NO_ANSWER(value)
          if (path.endsWith('.refused')) return NOTHING_OWED(value)
          return value === undefined
        },
      },
    ],
  ],
  ['w05l-move-gift-card-answer-lost-then-cancel', [...MOVE_CARD, moveNoLostAnswer(2)]],
  ['w05l-move-answer-lost-and-the-look-fails', [moveNoLostAnswer(2)]],
  [
    'w05l-move-fails-after-another-press-finished',
    [
      {
        name: "The gift card's row failing is inside C1 (one transaction): nothing moved or taken, with the plain words (the old code moved, then put everything back by hand)",
        decision: `${W24}, item 5: one transaction`,
        path: /^\.results\[4\]\.(reason|message)$/,
        actual: (value, _expected, path) => (path.endsWith('.reason') ? value === 'move_not_saved' : MOVE_NOT_SAVED_WORDS(value)),
      },
    ],
  ],
  [
    'w05l-move-gift-card-row-fails-then-cancel',
    [
      MOVE_KEYS,
      {
        name: "The gift card's row fails in C2 after the card paid: the move is held for reconcile (Q35 words), never refunded for a database fault; Cancel & Refund is then refused while the payment is being checked (W18a's words)",
        decision: "W6-3 (a good payment is never refunded for a database fault); Wayne's Q35; brief W24 item 6 (a payment still being taken refuses a booking change)",
        path: /^\.results\[2\]\.(reason|message)$|^\.results\[3\]\.(cardRefundedAmount|storeCreditRefundedAmount|thrown)$|^\.stripeCalls\[[23]\]$|^\.tables\.booking_guests\.added\[[01]\]\.unit_price$|^\.tables\.bookings\.added\[0\]\.(session_id|status|price_paid|cancelled_at|band_id)$|^\.tables\.order_line_items\.added\[0\]\.(refunded_at|refund_method|card_refunded_amount)$|^\.tables\.(orders|order_line_items)\.added\[1\]$|^\.tables\.orders\.added\[0\]\.payment_status$|^\.tables\.(gift_cards|sessions)$/,
        actual: (value, expected, path) => {
          if (path.endsWith('.reason')) return value === 'paid_not_finished'
          if (path.endsWith('.message')) return typeof value === 'string' && value.startsWith('The card payment went through, but the change couldn\'t be finished.')
          if (path.endsWith('.thrown')) return value === "A card payment on this booking is still being checked. Don't take payment again: use Resolve now on the Orders page after 15 minutes."
          if (path.startsWith('.results[3]')) return value === undefined
          if (path.startsWith('.stripeCalls')) return value === undefined && (expected as { method?: string } | undefined)?.method === 'refunds.create'
          if (path.endsWith('.unit_price')) return value === '25.50'
          if (path.endsWith('.session_id')) return value === '10000000-0000-4000-8000-00000000000e'
          if (path.endsWith('.status')) return value === 'confirmed'
          if (path.endsWith('.price_paid')) return value === '51.00'
          if (path.endsWith('.band_id')) return value === '10000000-0000-4000-8000-00000000000c'
          if (path.endsWith('.card_refunded_amount')) return value === '0.00'
          if (path.endsWith('.payment_status')) return value === 'paid'
          // Held: the £5 on the gift card claimed, both sessions holding the party (the old seat until C2).
          if (path === '.tables.gift_cards') return JSON.stringify((value as { changed?: unknown }).changed) === JSON.stringify([{ id: '10000000-0000-4000-8000-000000000009', remaining_balance: ['40.00', '35.00'] }])
          if (path === '.tables.sessions') {
            return JSON.stringify((value as { changed?: unknown }).changed) === JSON.stringify([{ id: '10000000-0000-4000-8000-000000000004', total_booked: [0, 2] }, { id: '10000000-0000-4000-8000-00000000000e', total_booked: [0, 2] }])
          }
          // No card order yet (C2 couldn't write it), nothing refunded, nothing cancelled.
          return value === undefined || value === null
        },
      },
    ],
  ],
  [
    'p2-two-moves-the-other-way-round',
    [
      ...MOVE_CARD,
      {
        name: "Two overlapping presses: the overlap is hooked on the old code's started row, which the Worker never writes, so only one press runs here (one move, one charge, the store credit taken once); the Worker's race is C1's lock (move-postgres.test.ts: two moves at once)",
        decision: `${W24}: one transaction; D-plan 4.11 item 5 (real Postgres races)`,
        path: /^\.results\[2\]$|^\.stripeCalls\[2\]$|^\.tables\.store_credit_transactions\.added\[[12]\]$/,
        actual: (value) => value === undefined,
      },
    ],
  ],
  // The W17 golden gaps (W05 review 3), with the outcomes the old code's faults no longer reach.
  [
    'w17-r1b-move-store-credit-and-gift-card-statement-lands-late',
    [
      {
        name: "R1b: the old statement landed after the press had given the £6 store credit and £5 gift card back (the booking moved, its money given away); the Worker's C1 is one transaction, so the move goes through once with what it took",
        decision: 'W05 review 3, finding 1 (R1b); W17 golden gap; brief W24 item 5',
        path: /^\.results\[2\]\.(moved|reason|booking)$|^\.tables\.sessions\.changed\[0\]\.id$|^\.tables\.store_credit_transactions\.added\[1\]$|^\.tables\.(customers|gift_cards)$/,
        actual: (value, _expected, path) => {
          if (path.endsWith('.moved')) return value === true
          if (path.endsWith('.reason')) return value === undefined
          if (path.endsWith('.booking')) return JSON.stringify(value) === JSON.stringify({ id: 'bookings#1', price_paid: 51 })
          if (path.endsWith('.id')) return value === '10000000-0000-4000-8000-00000000000e'
          if (path === '.tables.customers') return JSON.stringify((value as { changed?: unknown }).changed) === JSON.stringify([{ id: '10000000-0000-4000-8000-000000000005', store_credit_balance: ['30.00', '24.00'] }])
          if (path === '.tables.gift_cards') return JSON.stringify((value as { changed?: unknown }).changed) === JSON.stringify([{ id: '10000000-0000-4000-8000-000000000009', remaining_balance: ['40.00', '35.00'] }])
          return value === undefined
        },
      },
    ],
  ],
  [
    'w17-r1d-move-gift-card-and-reader-statement-lands-late-then-cancel',
    [
      ...MOVE_READER_ONLY,
      {
        name: "R1d: the old statement landed after the press undid it, so the old sweep's cancel gave the £5 gift card back a second time and the Peak session went to -2; the Worker's C1 is one transaction, so the reader flow starts once, and its cancel puts everything back once",
        decision: 'W05 review 3, finding 1 (R1d); W17 golden gap; brief W24 item 5',
        path: /^\.results\[2\]\.(moved|reason|booking|pendingReaderPayment)$|^\.tables\.gift_cards$|^\.tables\.sessions\.changed\[1\]$/,
        actual: (value, _expected, path) => {
          if (path.endsWith('.moved')) return value === true
          if (path.endsWith('.booking')) return JSON.stringify(value) === JSON.stringify({ id: 'bookings#1', price_paid: 51 })
          if (path.endsWith('.pendingReaderPayment')) return (value as { flow?: unknown; amount?: unknown } | undefined)?.flow === 'move' && (value as { amount?: unknown }).amount === 6
          return value === undefined
        },
      },
    ],
  ],
  [
    'w17-r3-move-two-presses-the-new-session-full-for-both',
    [
      {
        name: "R3: with the new session full, the old presses each charged £11 and refunded it (the second recording the one refund twice); the Worker refuses the press in C1 before any charge, and the overlapping second press (hooked on the old started row) never runs, so the figures come next",
        decision: 'W05 review 3, finding 4 (R3); W17 golden gap; brief W24 item 5',
        path: /^\.results\[3\](\.|$)|^\.results\[4\]$|^\.stripeCalls\[[1-4]\]$|^\.tables\.(orders|order_line_items)\.added\[1\]$/,
        actual: (value, expected, path) => {
          const field = path.slice(path.lastIndexOf('.') + 1)
          const figures: Readonly<Record<string, unknown>> = { status: 'confirmed', customerId: '10000000-0000-4000-8000-000000000005', pricePaid: 40, refundOwed: 0, left: 40, cardLeft: 40 }
          if (path.startsWith('.results[3]')) {
            if (field === 'moved' || field === 'reason') return value === undefined
            if (field === 'parts') return JSON.stringify(value) === JSON.stringify({ card: 40, giftCard: 0, storeCredit: 0, cash: 0 })
            return figures[field] === value
          }
          if (path === '.results[4]') return value === undefined && typeof expected === 'object'
          return value === undefined
        },
      },
    ],
  ],
  [
    'w17-r4b-move-store-credit-claim-answer-lost',
    [
      {
        name: "R4b: the old store credit claim's answer was lost, so the press stopped with the £6 kept; on the Worker the claim is inside C1, so the hook (on the old SQL) does nothing and the move goes through once: £6 store credit and £5 on the card",
        decision: 'W05 review 3, finding 3 (R4b); W17 golden gap; brief W24 item 5',
        path: /^\.results\[2\]\.(moved|reason|booking)$|^\.stripeCalls\[1\]$|^\.tables\.booking_guests\.added\[[01]\]\.unit_price$|^\.tables\.bookings\.added\[0\]\.(session_id|price_paid|band_id)$|^\.tables\.(orders|order_line_items)\.added\[1\]$|^\.tables\.sessions\.changed\[0\]\.id$/,
        actual: (value, _expected, path) => {
          if (path.endsWith('.moved')) return value === true
          if (path.endsWith('.reason')) return value === undefined
          if (path.endsWith('.booking')) return JSON.stringify(value) === JSON.stringify({ id: 'bookings#1', price_paid: 51 })
          if (path === '.stripeCalls[1]') return (value as { params?: { amount?: unknown } } | undefined)?.params?.amount === 500
          if (path.endsWith('.unit_price')) return value === '25.50'
          if (path.endsWith('.session_id') || path.endsWith('.id')) return value === '10000000-0000-4000-8000-00000000000e'
          if (path.endsWith('.price_paid')) return value === '51.00'
          if (path.endsWith('.band_id')) return value === '10000000-0000-4000-8000-00000000000c'
          return (value as { order_total?: unknown; line_total?: unknown } | undefined)?.order_total === '5.00' || (value as { line_total?: unknown } | undefined)?.line_total === '5.00'
        },
      },
    ],
  ],
  ['w24-q34-membership-credit-moved-past-its-last-day', [Q34_RELEASED]],
  ['w24-q34-pass-seat-moved-past-its-expiry', [Q34_RELEASED]],
  [
    'w17-n1-dearer-move-on-the-card-to-a-day-with-another-booking',
    [
      {
        name: "N1: the quote and the press are refused with New Order's words before any money moves (the old code charged £11, met the trigger at its write and refunded it)",
        decision: N1,
        path: /^\.results\[1\]\.(priceImpact|reason|message)$|^\.results\[2\]\.(reason|message)$|^\.stripeCalls\[[12]\]$|^\.tables\.(orders|order_line_items)\.added\[1\]$/,
        actual: (value, _expected, path) => (path.endsWith('.reason') ? value === 'duplicate_day_booking' : path.endsWith('.message') ? value === DUPLICATE_DAY_WORDS : value === undefined),
      },
    ],
  ],
  [
    'w17-n1-same-price-move-to-a-day-with-another-booking',
    [
      {
        name: "N1: the quote and the press are refused with New Order's words (the old code showed the database's own text, thrown)",
        decision: N1,
        path: /^\.results\[1\]\.(priceImpact|reason|message)$|^\.results\[2\]\.(thrown|moved|reason|message)$/,
        actual: (value, _expected, path) => {
          if (path.endsWith('.reason')) return value === 'duplicate_day_booking'
          if (path.endsWith('.message')) return value === DUPLICATE_DAY_WORDS
          if (path.endsWith('.moved')) return value === false
          return value === undefined
        },
      },
    ],
  ],
])
