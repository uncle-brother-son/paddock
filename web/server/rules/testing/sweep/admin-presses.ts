import { vi } from 'vitest'
import type { Db } from '@/server/db'
import { throughStaffApp } from './booking-presses'

/*
 * W64 (H-plan 3.3 step 3): step G's presses (W49 to W57), as the screen presses them, moved here unchanged from
 * `replay/admin-side.ts` so the all-Worker sweep and the Worker's own rule tests can press the Worker with nothing of the
 * old code loaded.
 */

/** W49: the six staff functions. */
export const W49_ACTIONS: ReadonlySet<string> = new Set(['getCurrentStaff', 'getStaff', 'createStaff', 'setStaffRole', 'setStaffPermission', 'setStaffCanManagePricing'])
/** W54: the four pricing setters and the four promo code functions. */
export const W54_ACTIONS: ReadonlySet<string> = new Set(['setBandPrice', 'setBandRules', 'setMembershipBandTerm', 'setPostageSettings', 'getPromoCodes', 'getPromoCodeRedemptions', 'createPromoCode', 'updatePromoCode'])
/** W50: the six booking and Overview reads, and the three flags. */
export const W50_READS: ReadonlySet<string> = new Set(['getBookings', 'getBookingById', 'getBookingDetail', 'getAddonPrepChecklistForRange', 'getWaiverGapsForRange', 'getPaymentAttentionItems'])
export const W50_FLAGS: ReadonlySet<string> = new Set(['setBookingCheckedIn', 'setGuestWaiverStatus', 'setAddonLinePrepared'])
export const W50_ACTIONS: ReadonlySet<string> = new Set([...W50_READS, ...W50_FLAGS])
/** W51: the two calendar reads and the ten session and timetable writes. (generateUpcomingSessions is deleted, not moved: GB24.) */
export const W51_READS: ReadonlySet<string> = new Set(['getSessionsForRange', 'getServiceTypesForSlot'])
export const W51_WRITES: ReadonlySet<string> = new Set([
  'blockSession',
  'blockDay',
  'unblockSession',
  'unblockDay',
  'setSessionBand',
  'resetSessionBand',
  'setSessionStartTime',
  'createOneOffSession',
  'addServiceTypeScheduleSlot',
  'deleteServiceTypeScheduleSlot',
])
export const W51_ACTIONS: ReadonlySet<string> = new Set([...W51_READS, ...W51_WRITES])
/** W52: the three event reads, the two catalogue writes and the three event-day flags. */
export const W52_READS: ReadonlySet<string> = new Set(['getEvents', 'getEventAttendees', 'getTodaysEvents'])
export const W52_WRITES: ReadonlySet<string> = new Set(['setEventActive', 'setEventDetails'])
export const W52_FLAGS: ReadonlySet<string> = new Set(['setEventAttendeeCheckIn', 'setEventAttendeesCheckIn', 'setEventAttendeeWaiver'])
export const W52_ACTIONS: ReadonlySet<string> = new Set([...W52_READS, ...W52_WRITES, ...W52_FLAGS])
/** W53: the two order reads and the fulfilled tick. (getPaymentAttentionItems moved with W50; its read only changed files.) */
export const W53_READS: ReadonlySet<string> = new Set(['getOrders', 'getOrderLineItems'])
export const W53_FLAGS: ReadonlySet<string> = new Set(['setOrderLineItemFulfilled'])
export const W53_ACTIONS: ReadonlySet<string> = new Set([...W53_READS, ...W53_FLAGS])
/** W55: products, add-ons and stock: the three reads and eight writes. (updateCatalogItemPrice's membership plan branch stays on the legacy route until W57.) */
export const W55_READS: ReadonlySet<string> = new Set(['getProducts', 'getAddons', 'getStockAdjustments'])
export const W55_WRITES: ReadonlySet<string> = new Set(['setProductActive', 'setProductFulfillmentMethod', 'setProductVariantDetails', 'createProductVariant', 'adjustVariantStock', 'updateCatalogItemPrice', 'setAddonActive', 'setAddonSku'])
export const W55_ACTIONS: ReadonlySet<string> = new Set([...W55_READS, ...W55_WRITES])
/** W56: service types, tiers, passes and gift card types: the three reads and fifteen writes. */
export const W56_READS: ReadonlySet<string> = new Set(['getServiceTypes', 'getSessionPassTypes', 'getGiftCardTypes'])
export const W56_WRITES: ReadonlySet<string> = new Set([
  'setServiceTypeActive',
  'setServiceTypeCapacityInfo',
  'createServiceTypePriceTier',
  'setServiceTypePriceTierRange',
  'updateTierPrice',
  'setSessionPassActive',
  'setSessionPassExpiry',
  'setSessionPassSessionsIncluded',
  'setSessionPassLevel',
  'setGiftCardTypeActive',
  'setGiftCardPresetActive',
  'createGiftCardPreset',
  'updateGiftCardPresetPrice',
  'setGiftCardTypeCustomAmountSettings',
  'setGiftCardTypeExpiry',
])
export const W56_ACTIONS: ReadonlySet<string> = new Set([...W56_READS, ...W56_WRITES])
/**
 * W57: membership plans and settings: the two reads and four writes (updateCatalogItemPrice's plan branch moved with
 * them, on W55's function). The plan writes touch Stripe and are gated by `plan_changes`: this side presses them with
 * the kind on and the fake Stripe bound.
 */
export const W57_READS: ReadonlySet<string> = new Set(['getMembershipPlans', 'getMembershipSettings'])
export const W57_WRITES: ReadonlySet<string> = new Set(['createMembershipPlan', 'setMembershipPlanActive', 'setMembershipPlanDetails', 'setMembershipSettings'])
export const W57_ACTIONS: ReadonlySet<string> = new Set([...W57_READS, ...W57_WRITES])
/** Every old step G function now a thin call to the Worker. */
export const STEP_G_ACTIONS_MOVED: ReadonlySet<string> = new Set([...W49_ACTIONS, ...W54_ACTIONS, ...W50_ACTIONS, ...W51_ACTIONS, ...W52_ACTIONS, ...W53_ACTIONS, ...W55_ACTIONS, ...W56_ACTIONS, ...W57_ACTIONS])
/** W57: the switch kind the plan writes need (and updateCatalogItemPrice for a plan). */
export const PLAN_KIND_ON = 'plan_changes'

/** The ones that add something: their dialogs keep a press key, and their wrappers answer a refusal as data. */
export const CREATES: ReadonlySet<string> = new Set([
  'createStaff',
  'createPromoCode',
  'createOneOffSession',
  'addServiceTypeScheduleSlot',
  // W55 + W56: and a stock change (GB13), which its row presses the same way (`adjusted: false`).
  'createProductVariant',
  'adjustVariantStock',
  'createServiceTypePriceTier',
  'createGiftCardPreset',
  // W57: a new plan, and a plan's details (a price change in it): their dialogs keep the key after no answer.
  'createMembershipPlan',
  'setMembershipPlanDetails',
])
/**
 * W51: the refusals createOneOffSession answered as data before it was a thin call, with these reasons and no words
 * (its dialog has the words). They still come back so, and the replay reads them as answers, as recorded.
 */
export const ONE_OFF_REASONS_ANSWERED: ReadonlySet<string> = new Set(['service_type_not_found', 'service_type_incomplete', 'slot_already_exists'])
/** The moved reads GB14's recording makes with `call`, which stops at the first throw. */
export const READS: ReadonlySet<string> = new Set(['getStaff', 'getPromoCodes', 'getPromoCodeRedemptions', ...W50_READS, ...W51_READS, ...W52_READS, ...W53_READS, ...W55_READS, ...W56_READS, ...W57_READS])

export type CreateAnswer = { created?: boolean; adjusted?: boolean; updated?: boolean; reason?: string; message?: string; noAnswer?: boolean } | null

/**
 * A create as its dialog presses it (NewStaffDialog, PromoCodeDialog; W51: CreateOneOffSessionDialog,
 * NewScheduleSlotDialog): each press has a key; a press that got no answer keeps it for the next press; any other
 * answer starts a new one. The wrapper answers a refusal as data (`created: false`, so the dialog can tell it from
 * no answer); the dialog shows its words where it showed the old function's thrown error, so the replay reads it as
 * that throw. W51: a refusal the old function itself answered as data (createOneOffSession's three reasons) stays
 * an answer.
 */
export function createAsTheDialogPresses(action: string): (db: Db, params: unknown) => Promise<unknown> {
  let held: string | null = null
  return async (db, params) => {
    const idempotencyKey = held ?? crypto.randomUUID()
    const answer = (await throughStaffApp(action)(db, { ...(params as object), idempotencyKey })) as CreateAnswer
    held = answer?.noAnswer ? idempotencyKey : null
    const answeredAsData = action === 'createOneOffSession' && typeof answer?.reason === 'string' && ONE_OFF_REASONS_ANSWERED.has(answer.reason)
    // W57: a plan's details answer a refusal as `updated: false`, as a create answers `created: false`.
    if (answer && (answer.created === false || answer.adjusted === false || answer.updated === false) && !answeredAsData) throw new Error(String(answer.message))
    return answer
  }
}

// --- W51: the figures a two-step press confirms (Q18's rule for counts). The old functions took none.

/**
 * W51. Block Day, Unblock Day and a band change send the figures their dialog showed (`seen`), and the Worker
 * refuses a press whose figures are no longer right. A scenario's params have none (the old functions counted
 * again for themselves), so each press is made as its dialog makes it: the quote first, by the same sign-in, then
 * the press with the figures the quote gave. A quote the Worker refuses (an inactive account, no Manage pricing)
 * gives no figures; the press is then refused the same way, before any figure is looked at, as the recording has
 * it. So a recording never meets `changed_since`: its dialog is always up to date. The rule itself is tested where
 * it can be shown (sessions/admin.test.ts).
 */
export const FIGURES_THE_DIALOG_SHOWED: Readonly<Record<string, (db: Db, params: Record<string, unknown>) => Promise<unknown>>> = {
  // BlockDayDialog: the quote when it opens.
  async blockDay(db, params) {
    const shown = (await throughStaffApp('blockDay')(db, { date: params['date'], quote: true })) as { toBlock?: unknown; alreadyBlocked?: unknown }
    return { toBlock: shown.toBlock, alreadyBlocked: shown.alreadyBlocked }
  },
  // UnblockDayDialog: the count when it opens. Only the confirmed call is a press.
  async unblockDay(db, params) {
    if (params['confirmed'] !== true) return undefined
    const shown = (await throughStaffApp('unblockDay')(db, { date: params['date'] })) as { blockedSessions?: unknown; blockedBefore?: unknown; closedDates?: unknown }
    // W51a: whether a closed date goes with the day's block is one of the figures the dialog shows and sends.
    return { blockedSessions: shown.blockedSessions, blockedBefore: shown.blockedBefore, closedDates: shown.closedDates }
  },
  // ChangeSessionBandDialog: "Check Affected", then "Confirm Change". Only the confirmed call is a press.
  async setSessionBand(db, params) {
    if (params['confirmed'] !== true) return undefined
    const first = Object.fromEntries(Object.entries(params).filter(([name]) => name !== 'confirmed'))
    const shown = (await throughStaffApp('setSessionBand')(db, first)) as { sessionsAffected?: unknown; bookingsAffected?: unknown }
    return { sessionsAffected: shown.sessionsAffected, bookingsAffected: shown.bookingsAffected }
  },
}

/** `params` with the figures the dialog would hold, read just before the press. Params that bring their own keep them. */
export async function withTheFiguresShown(action: string, db: Db, params: unknown): Promise<unknown> {
  const read = FIGURES_THE_DIALOG_SHOWED[action]
  if (!read || (isRecord(params) && 'seen' in params)) return params
  let seen: unknown
  try {
    seen = await read(db, (params ?? {}) as Record<string, unknown>)
  } catch {
    // The dialog's quote was refused, or failed: it has no figures to send.
    seen = undefined
  }
  return seen === undefined ? params : { ...(params as object), seen }
}

// --- W54a: the stamp (admin/stamp.ts). The old functions had none, so the replay drives it as the screens do.

/** The stamp of a row that isn't there yet (admin/stamp.ts, NO_ROW_STAMP): what a screen that saw no row sends. */
export const NO_ROW = 'none'

/**
 * W54a. The four edits that send a whole row back carry the stamp their screen loaded. A scenario's params have
 * none (the old functions took none), so each is pressed as its screen presses it: the screen's own read first, by
 * the same sign-in, then the press with the stamp that read gave. A read the Worker refuses (an inactive account, a
 * sign-in with no staff row) gives no stamp; the press is then refused by the staff check, before a stamp is looked
 * at, as the recording has it. So a recording never meets `changed_since`: its page is always up to date. The rule
 * itself is tested where it can be shown (pricing/ and promo/ admin.test.ts; the races in admin-postgres.test.ts).
 */
export const STAMP_THE_SCREEN_LOADED: Readonly<Record<string, (db: Db, params: Record<string, unknown>) => Promise<unknown>>> = {
  // The Promo Codes page: the row's stamp from the list (the switch and the dialog both send it).
  async updatePromoCode(db, params) {
    const rows = (await throughStaffApp('getPromoCodes')(db, {})) as Array<{ id?: unknown; stamp?: unknown }>
    return rows.find((row) => row.id === params['id'])?.stamp
  },
  // The Pricing page: the day's stamp, by day.
  async setBandRules(db, params) {
    const config = (await throughStaffApp('getPricingConfig')(db, {})) as { bandRulesStamps?: unknown[] }
    return config.bandRulesStamps?.[Number(params['dayOfWeek'])]
  },
  // The Pricing page: the term's row. A term with no row yet is saved with the stamp of no row.
  async setMembershipBandTerm(db, params) {
    const config = (await throughStaffApp('getPricingConfig')(db, {})) as { membershipTerms?: Array<{ membership_level?: unknown; band_id?: unknown; stamp?: unknown }> }
    const level = typeof params['membershipLevel'] === 'string' ? params['membershipLevel'].trim() : params['membershipLevel']
    return (config.membershipTerms ?? []).find((term) => term.membership_level === level && term.band_id === params['bandId'])?.stamp ?? NO_ROW
  },
  // The Pricing page's postage boxes.
  async setPostageSettings(db) {
    return ((await throughStaffApp('getPostageSettings')(db, {})) as { stamp?: unknown }).stamp
  },
  // W52. Catalog → Events: the event's stamp from the list (the edit dialog opens on a row of it).
  async setEventDetails(db, params) {
    const rows = (await throughStaffApp('getEvents')(db, {})) as Array<{ id?: unknown; stamp?: unknown }>
    return rows.find((row) => row.id === params['eventId'])?.stamp
  },
  // W55. Catalog → Products: the variant row's stamp from the products list.
  async setProductVariantDetails(db, params) {
    const products = (await throughStaffApp('getProducts')(db, {})) as Array<{ variants?: Array<{ id?: unknown; stamp?: unknown }> }>
    return products.flatMap((product) => product.variants ?? []).find((variant) => variant.id === params['variantId'])?.stamp
  },
  // W56. Catalog → Service Types: the type's stamp, and a tier's size group's.
  async setServiceTypeCapacityInfo(db, params) {
    const types = (await throughStaffApp('getServiceTypes')(db, {})) as Array<{ id?: unknown; stamp?: unknown }>
    return types.find((type) => type.id === params['serviceTypeId'])?.stamp
  },
  async setServiceTypePriceTierRange(db, params) {
    const types = (await throughStaffApp('getServiceTypes')(db, {})) as Array<{ price_tiers?: Array<{ id?: unknown; range_stamp?: unknown }> }>
    return types.flatMap((type) => type.price_tiers ?? []).find((tier) => tier.id === params['tierId'])?.range_stamp
  },
  // W56. Catalog → Gift Card Types: the type's custom amounts' stamp.
  async setGiftCardTypeCustomAmountSettings(db, params) {
    const types = (await throughStaffApp('getGiftCardTypes')(db, {})) as Array<{ id?: unknown; stamp?: unknown }>
    return types.find((type) => type.id === params['giftCardTypeId'])?.stamp
  },
  // W57. Catalog → Membership Plans: the plan's row's stamp (the edit dialog opens on a row of the list).
  async setMembershipPlanDetails(db, params) {
    const plans = (await throughStaffApp('getMembershipPlans')(db, {})) as Array<{ id?: unknown; stamp?: unknown }>
    return plans.find((plan) => plan.id === params['planId'])?.stamp
  },
}

// --- W57: the counts a plan's price change and the waiting period confirm (Q53, GB19). The old functions took none.

export type PlanListed = { id?: unknown; price_monthly?: unknown; price_yearly?: unknown; stripe_price_id?: unknown; stripe_price_id_yearly?: unknown; members_monthly?: unknown; members_yearly?: unknown }
export const pennyOf = (value: unknown): number | null => (value === null || value === undefined || value === '' ? null : Math.round(Number(value) * 100))
/** Whether a typed price changes the plan's (as the dialog and the Worker decide it: frontend/utils/membershipPlans.ts). */
export const priceChanges = (stored: unknown, priceId: unknown, typed: unknown): boolean =>
  typed !== undefined && (stored === null || pennyOf(stored) !== pennyOf(typed) || (priceId === null && stored !== null && Number(stored) > 0))

/**
 * W57. The edit dialog says how many members will move to a changed price before the press, from the row it opened on,
 * and sends that count (`membersToMove`); the waiting period control reads the Herd count for the period typed and
 * sends it (`herdFlagsToChange`). A scenario's params have neither (the old functions counted nothing), so each is
 * read just before the press, as the screens read it. A read the Worker refuses gives none; the press is then refused
 * before any count is looked at, as the recording has it. updateCatalogItemPrice for a plan is pressed by no screen,
 * so it is sent as recorded, with no count.
 */
export async function withTheCountsShown(action: string, db: Db, params: unknown): Promise<unknown> {
  if (!isRecord(params)) return params
  try {
    if (action === 'setMembershipPlanDetails' && !('membersToMove' in params)) {
      const plans = (await throughStaffApp('getMembershipPlans')(db, {})) as PlanListed[]
      const row = plans.find((plan) => plan.id === params['planId'])
      if (!row) return params
      const monthly = priceChanges(row.price_monthly ?? null, row.stripe_price_id ?? null, params['priceMonthly'])
      const yearly = priceChanges(row.price_yearly ?? null, row.stripe_price_id_yearly ?? null, params['priceYearly'])
      if (!monthly && !yearly) return params
      return { ...params, membersToMove: (monthly ? Number(row.members_monthly ?? 0) : 0) + (yearly ? Number(row.members_yearly ?? 0) : 0) }
    }
    if (action === 'setMembershipSettings' && !('herdFlagsToChange' in params)) {
      const quote = (await throughStaffApp('getMembershipSettingsQuote')(db, { addonCreditWaitMonths: params['addonCreditWaitMonths'] })) as { herdFlagsToChange?: unknown }
      return typeof quote.herdFlagsToChange === 'number' ? { ...params, herdFlagsToChange: quote.herdFlagsToChange } : params
    }
  } catch {
    // The screen's read was refused, or failed: it has no count to send.
  }
  return params
}

/** W57: what the plan list, a plan's saved details and a new plan answer beside the old function's row, set aside and noted. */
export interface AnsweredPlanExtra {
  action: string
  where: string
  value: unknown
}

/**
 * W57. Set aside before the answers compare: each plan row's stamp, live member counts, set-up state and open change
 * (the list); a saved plan's new stamp and its price change (setMembershipPlanDetails); a new plan's held set-up
 * (createMembershipPlan); a plan price's change (updateCatalogItemPrice). Each is noted in `found` for the test.
 */
export function withoutPlanExtras(action: string, answer: unknown, found: AnsweredPlanExtra[] | undefined): unknown {
  const aside = (row: Record<string, unknown>, fields: readonly string[], where: string): Record<string, unknown> => {
    const rest: Record<string, unknown> = { ...row }
    for (const field of fields) {
      if (field in rest) {
        found?.push({ action, where: `${where}${field}`, value: rest[field] })
        delete rest[field]
      }
    }
    return rest
  }
  if (action === 'getMembershipPlans' && Array.isArray(answer)) return answer.map((row: unknown, i) => (isRecord(row) ? aside(row, ['stamp', 'members_monthly', 'members_yearly', 'setup', 'price_change_open'], `[${i}].`) : row))
  if (action === 'setMembershipPlanDetails' && isRecord(answer)) return aside(answer, ['stamp', 'priceChange'], '')
  if (action === 'createMembershipPlan' && isRecord(answer)) return aside(answer, ['create'], '')
  if (action === 'updateCatalogItemPrice' && isRecord(answer)) return aside(answer, ['priceChange'], '')
  return answer
}
/** The edits that carry a stamp. */
export const STAMPED_EDITS: ReadonlySet<string> = new Set(Object.keys(STAMP_THE_SCREEN_LOADED))

/** `params` with the stamp the screen would hold, read just before the press. Params that bring a stamp of their own (a test's older page) keep it. */
export async function asTheScreenPresses(action: string, db: Db, params: unknown): Promise<unknown> {
  const read = STAMP_THE_SCREEN_LOADED[action]
  if (!read || (isRecord(params) && 'stamp' in params)) return params
  let stamp: unknown
  try {
    stamp = await read(db, (params ?? {}) as Record<string, unknown>)
  } catch {
    // The screen's read was refused, or failed: the screen has no stamp to send.
    stamp = undefined
  }
  return stamp === undefined ? params : { ...(params as object), stamp }
}

/** A stamp the new side answered that the old functions never did: which call, and where in its answer. */
export interface AnsweredStamp {
  action: string
  where: string
  stamp: unknown
}

export const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * W54a. An answer with its stamps set aside, so it compares with the old function's: a saved edit's new stamp, and
 * the stamp on each row of the promo code list. Each one set aside is noted in `found`, and checked on its own
 * (answeredStampProblems). Nothing else is taken out, and an answer with no stamp is left exactly as it is.
 */
export function withoutStamps(action: string, answer: unknown, found: AnsweredStamp[] | undefined): unknown {
  if (STAMPED_EDITS.has(action) && isRecord(answer) && 'stamp' in answer) {
    const { stamp, ...rest } = answer
    found?.push({ action, where: 'stamp', stamp })
    return rest
  }
  // W52: the events list carries a stamp on each row, as the promo code list does.
  if ((action === 'getPromoCodes' || action === 'getEvents') && Array.isArray(answer)) {
    return answer.map((row: unknown, i) => {
      if (!isRecord(row) || !('stamp' in row)) return row
      const { stamp, ...rest } = row
      found?.push({ action, where: `[${i}].stamp`, stamp })
      return rest
    })
  }
  // W55 + W56: the catalogue reads' stamps: each variant's, each service type's and each tier's group's, each gift card type's.
  if (action === 'getProducts' && Array.isArray(answer)) {
    return answer.map((product: unknown, i) =>
      isRecord(product) && Array.isArray(product['variants'])
        ? { ...product, variants: (product['variants'] as unknown[]).map((variant, j) => (isRecord(variant) && 'stamp' in variant ? asideStamp(variant, 'stamp', action, `[${i}].variants[${j}].stamp`, found) : variant)) }
        : product
    )
  }
  if (action === 'getServiceTypes' && Array.isArray(answer)) {
    return answer.map((type: unknown, i) => {
      if (!isRecord(type)) return type
      const typeAside = 'stamp' in type ? asideStamp(type, 'stamp', action, `[${i}].stamp`, found) : type
      const tiers = Array.isArray(typeAside['price_tiers']) ? (typeAside['price_tiers'] as unknown[]).map((tier, j) => (isRecord(tier) && 'range_stamp' in tier ? asideStamp(tier, 'range_stamp', action, `[${i}].price_tiers[${j}].range_stamp`, found) : tier)) : typeAside['price_tiers']
      return { ...typeAside, price_tiers: tiers }
    })
  }
  if (action === 'getGiftCardTypes' && Array.isArray(answer)) {
    return answer.map((type: unknown, i) => (isRecord(type) && 'stamp' in type ? asideStamp(type, 'stamp', action, `[${i}].stamp`, found) : type))
  }
  if (action === 'setServiceTypePriceTierRange' && isRecord(answer) && 'range_stamp' in answer) return asideStamp(answer, 'range_stamp', action, 'range_stamp', found)
  // W52: a saved event edit answers the event's row with its new stamp on it (the page puts the row back in its list).
  if (action === 'setEventDetails' && isRecord(answer) && isRecord(answer['event']) && 'stamp' in answer['event']) {
    const { stamp, ...event } = answer['event']
    found?.push({ action, where: 'event.stamp', stamp })
    return { ...answer, event }
  }
  return answer
}

/** W55 + W56: a row with its stamp field set aside and noted in `found`. */
export function asideStamp(row: Record<string, unknown>, field: string, action: string, where: string, found: AnsweredStamp[] | undefined): Record<string, unknown> {
  const { [field]: stamp, ...rest } = row
  found?.push({ action, where, stamp })
  return rest
}

/** W52: whether a refund on a booking's order is still being checked, as the attendee list now says beside each booking: which call, which booking, and what it said. */
export interface AnsweredRefundOpen {
  eventBookingId: unknown
  refundOpen: unknown
}

/**
 * W52: the attendee list answers `refund_open` on each booking (W35 audit row 18), which the old read never did. It
 * is set aside, so the bookings compare with the recording's, and noted in `found` for the test to check on its own.
 */
export function withoutRefundOpen(action: string, answer: unknown, found: AnsweredRefundOpen[] | undefined): unknown {
  if (action !== 'getEventAttendees' || !isRecord(answer) || !Array.isArray(answer['bookings'])) return answer
  return {
    ...answer,
    bookings: (answer['bookings'] as unknown[]).map((booking) => {
      if (!isRecord(booking) || !('refund_open' in booking)) return booking
      const { refund_open, ...rest } = booking
      found?.push({ eventBookingId: booking['id'], refundOpen: refund_open })
      return rest
    }),
  }
}

/** W53: how an order was paid, in words, as the order list now says beside each order: which order, what its row records, and the words. */
export interface AnsweredPaidBy {
  orderId: unknown
  paymentMethod: unknown
  label: unknown
}

/**
 * W53 (lead call L9): the order list answers `payment_method_label` on each order, which the old read never did. It is
 * set aside, so the orders compare with the recording's, and noted in `found` for the test to check on its own.
 */
export function withoutPaidByLabel(action: string, answer: unknown, found: AnsweredPaidBy[] | undefined): unknown {
  if (action !== 'getOrders' || !Array.isArray(answer)) return answer
  return answer.map((order: unknown) => {
    if (!isRecord(order) || !('payment_method_label' in order)) return order
    const { payment_method_label, ...rest } = order
    found?.push({ orderId: order['id'], paymentMethod: order['payment_method'], label: payment_method_label })
    return rest
  })
}

/** What each stamp set aside must be: text that isn't empty, in the stamp's own form. Answers the problems found. */
export function answeredStampProblems(found: readonly AnsweredStamp[]): string[] {
  // A row's stamp, or a set of rows' (each row's id and stamp, in id order). W52: or the stamp of the columns one
  // edit writes (admin/stamp.ts, fieldsStampSql), which has no moment in front.
  const one = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{6}Z#[0-9a-f]{32}'
  // W56: a size group's stamp is a set of rows' whose own stamps are of the columns written (each tier's range).
  const fields = 'fields#[0-9a-f]{32}'
  const form = new RegExp(`^(${one}|[0-9a-f-]{36}@${one}(,[0-9a-f-]{36}@${one})*|${fields}|[0-9a-f-]{36}@${fields}(,[0-9a-f-]{36}@${fields})*)$`)
  return found.filter(({ stamp }) => typeof stamp !== 'string' || !form.test(stamp)).map(({ action, where, stamp }) => `${action} ${where}: ${JSON.stringify(stamp)}`)
}

/**
 * W51: the calendar read answers the sessions and the date sessions are made up to; the old function answered the
 * sessions alone. The list is what is compared with the recording; the date is set aside (noted in `found`).
 */
export function sessionsOf(action: string, answer: unknown, found: unknown[] | undefined): unknown {
  if (action !== 'getSessionsForRange' || !isRecord(answer) || !('sessions' in answer)) return answer
  found?.push(answer['madeUpTo'])
  return answer['sessions']
}

/** The database's nightly job as the saved schema has it (migration 032), run as the job runs it: the tables' owner. */
export async function runNightlyJobAsNow(db: Db): Promise<void> {
  // The clock moves, as it does between presses: what the job makes comes after what was made before it.
  vi.setSystemTime(Date.now() + 1)
  await db.query('RESET ROLE')
  try {
    await db.query('SELECT public.generate_upcoming_sessions()')
  } finally {
    await db.query('SET ROLE paddock_worker')
  }
}
