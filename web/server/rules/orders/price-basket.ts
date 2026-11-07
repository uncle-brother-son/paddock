// Ported from backend/paddock/createOrder.ts: every sum and refusal it makes before money moves.
import 'server-only'
import type {
  BasketAddonLine,
  BasketBookingAddon,
  BasketBookingQuote,
  BasketDelivery,
  BasketEventQuote,
  BasketLine,
  BasketPostage,
  BasketProblem,
  BasketProblemStage,
  BasketProductLine,
  BasketPromo,
  BasketQuoteInput,
  BasketQuoteOutput,
  PromoEligibleLine,
} from '@/contracts'
import type { Queryable } from '@/server/db'
import { applyPromoCode } from '@/server/rules/promo/promo-codes'
import { amountLeftToPay, exceedsAmount, round2 } from './amounts'
import { bookingProblem, GIFT_CARD_SOURCE_REMOVED_MESSAGE, priceBooking, type PricedBooking } from './basket-booking'
import { checkEvent, eventFullProblem, eventPromoLines } from './basket-event'
import { loadBasketFacts, type BasketAddonFacts, type BasketFacts, type BasketVariantFacts } from './load-basket'

/**
 * The only place a basket's prices are added up: the staff quote now, and the order and the website
 * from W06 on, so a quote and the money taken can't differ. No staff or customer context in here:
 * the route decides what its caller may do and says so in `options`.
 *
 * Things that stop the basket come back in `problems`, not as errors, so a screen can show them.
 * The first is what createOrder would have refused with, so the checks run in its order.
 *
 * W03-decisions settled six differences from createOrder, and each is marked below:
 *   Q1, Q2: postage and standalone add-ons are paid before credit spills onto the membership.
 *   Q3: a membership and a pass in one buy-new basket are both real lines.
 *   Q4: a shipped gift card counts towards free postage.
 *   Q5: a buy-new booking keeps its delivery address and special requests.
 *   Q6: a promo discounts the paid seats of a buy-new booking (the server's rule, kept).
 * Q23 and Q24 changed createOrder too, so they are rules here and not differences:
 *   Q23: free postage is judged on the corrected price, never one sent without Manage pricing.
 *   Q24: a promo applies to a private booking, on its whole price.
 */

export interface PriceBasketOptions {
  /** Whether a line's sent price counts. Off, a sent price is ignored and the system price stands. */
  allowPriceOverrides?: boolean
}

const money = (value: string): number => Number.parseFloat(value)

/** The first set price, in order. Nothing set is free. */
function firstPrice(...candidates: (string | null | undefined)[]): number {
  for (const candidate of candidates) {
    if (candidate !== null && candidate !== undefined) return money(candidate)
  }
  return 0
}

const addonSystemPrice = (addon: BasketAddonFacts, member: boolean): number =>
  firstPrice(member ? addon.member_price : null, addon.sale_price, addon.base_price)

const variantSystemPrice = (variant: BasketVariantFacts, member: boolean): number =>
  firstPrice(member ? variant.member_price : null, variant.price_override, variant.sale_price, variant.base_price)

const STANDALONE_CREDIT_MESSAGE = 'An add-on credit can only pay for an add-on on a booking. Charge this add-on, or add it to the booking.'

const PRICE_REASON_MESSAGE =
  'A price on this order was changed from the system price — enter a reason for the price change (up to 200 characters) on that line before completing the order.'

interface PricedLine {
  system: number
  unitPrice: number
  /** Trimmed, and only when the price differs from the system price. */
  overrideReason: string | null
  needsReason: boolean
}

function priceLine(sent: number | undefined, system: number, reason: string | null | undefined, allowOverrides: boolean): PricedLine {
  const unitPrice = allowOverrides && sent !== undefined ? sent : system
  const differs = round2(unitPrice) !== round2(system)
  const trimmed = (reason ?? '').trim()
  return { system, unitPrice, overrideReason: differs && trimmed ? trimmed : null, needsReason: differs && !trimmed }
}

function isShipped(line: BasketProductLine, variant: BasketVariantFacts | undefined): boolean {
  const method = variant?.fulfillment_method
  return method === 'shipping' || (method === 'both' && line.fulfillmentChoice === 'shipping')
}

function normaliseAddress(input: BasketQuoteInput['shippingAddress']): BasketDelivery['address'] | null {
  if (!input) return null
  const trim = (value: string | null | undefined) => (value ?? '').trim()
  return {
    name: trim(input.name),
    line1: trim(input.line1),
    line2: trim(input.line2) || null,
    city: trim(input.city),
    postcode: trim(input.postcode),
    country: trim(input.country) || 'United Kingdom',
  }
}

function addressProblem(address: BasketDelivery['address'] | null): string | null {
  if (!address) {
    return "This order includes an item that must be shipped — a delivery address is required. Add it in the checkout's Delivery address step."
  }
  const missing: string[] = []
  if (!address.name) missing.push('recipient name')
  if (!address.line1) missing.push('address line 1')
  if (!address.city) missing.push('town/city')
  if (!address.postcode) missing.push('postcode')
  if (missing.length === 0) return null
  return `The delivery address is incomplete — ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required.`
}

/** The amount of the gift card being bought, or why it can't be. */
function resolveGiftCard(input: BasketQuoteInput, facts: BasketFacts): { amount: number; problem: BasketProblem | null } {
  const { giftCard } = input
  const stop = (reason: string, message?: string) => ({
    amount: 0,
    problem: { stage: 'validation' as const, reason, ...(message ? { message } : {}) },
  })
  if (!giftCard) return { amount: 0, problem: null }
  if (giftCard.giftCardPresetId && giftCard.giftCardTypeId) {
    return stop('gift_card_selection_required', 'Choose either a preset amount or a custom amount, not both.')
  }

  let amount: number
  if (giftCard.giftCardPresetId) {
    const preset = facts.gift_card_preset
    if (!preset) return stop('gift_card_preset_not_found')
    if (!preset.active) return stop('gift_card_preset_inactive')
    amount = money(preset.amount)
  } else if (giftCard.giftCardTypeId) {
    const type = facts.gift_card_type
    if (!type) return stop('gift_card_type_not_found')
    if (!type.active) return stop('gift_card_type_inactive')
    if (!type.custom_amount_enabled) return stop('gift_card_custom_amount_not_allowed')
    const custom = giftCard.amount ?? 0
    if (!Number.isFinite(custom) || custom <= 0) return stop('invalid_gift_card_amount')
    const min = type.custom_amount_min === null ? null : money(type.custom_amount_min)
    const max = type.custom_amount_max === null ? null : money(type.custom_amount_max)
    if ((min !== null && custom < min) || (max !== null && custom > max)) return stop('gift_card_amount_out_of_range')
    amount = custom
  } else {
    return stop('gift_card_selection_required', 'Select a gift card preset or a custom-amount gift card type.')
  }

  if (!['digital', 'pickup', 'shipping'].includes(giftCard.fulfillmentMethod ?? '')) return stop('invalid_gift_card_fulfillment')
  return { amount, problem: null }
}

/** Claims run line by line, so two lines on one membership draw on the same credits. */
function addonCreditProblem(
  lines: readonly BasketAddonLine[],
  facts: BasketFacts,
  newMembership: { credits: number; isHerd: boolean } | null
): BasketProblem | null {
  const spent = new Map<string, number>()
  const refuse = (reason: string): BasketProblem => ({ stage: 'booking', reason })
  for (const line of lines) {
    if (line.redemptionSource !== 'membership_credit') continue
    const row = line.membershipId ? facts.addon_credits?.find((m) => m.id === line.membershipId) : null
    if (line.membershipId && !row?.usable) return refuse('addon_membership_not_found')
    const held = row ? { credits: row.addon_credits_remaining, isHerd: row.is_herd } : newMembership
    if (!held) continue
    const key = line.membershipId ?? 'new'
    const total = (spent.get(key) ?? 0) + line.quantity
    if (!held.isHerd) return refuse('addon_membership_too_new')
    if (total > held.credits) return refuse('insufficient_addon_membership_credit')
    spent.set(key, total)
  }
  return null
}

/** Stock is claimed line by line, so two lines of one variant share what's there. */
function stockProblem(lines: readonly BasketProductLine[], variants: ReadonlyMap<string, BasketVariantFacts>): BasketProblem | null {
  const taken = new Map<string, number>()
  for (const line of lines) {
    const variant = variants.get(line.productVariantId)
    if (!variant) continue
    const total = (taken.get(variant.id) ?? 0) + line.quantity
    if (total > variant.stock_quantity) {
      return { stage: 'product', reason: 'insufficient_stock', productVariantId: line.productVariantId }
    }
    taken.set(variant.id, total)
  }
  return null
}

export function priceFromFacts(input: BasketQuoteInput, facts: BasketFacts, options: PriceBasketOptions = {}): BasketQuoteOutput {
  const allowOverrides = options.allowPriceOverrides === true
  const { booking, event, giftCard } = input
  const payment = input.payment
  const method = payment?.method || undefined
  const standalone = input.standaloneAddons ?? []
  const attached = booking?.addons ?? []
  const products = input.products ?? []
  const planId = input.membershipPlanId || undefined
  const passTypeId = input.sessionPassTypeId || undefined
  const source = booking?.redemptionSource
  const buysNewMembership = source === 'buy_new_membership'
  const buysNewPass = source === 'buy_new_session_pass'
  const buysNew = buysNewMembership || buysNewPass
  const member = facts.customer?.has_active_membership === true

  const problems: BasketProblem[] = []
  const refuse = (stage: BasketProblemStage, reason: string, message?: string) => {
    problems.push({ stage, reason, ...(message ? { message } : {}) })
  }

  // --- The basket itself
  if (!booking && standalone.length === 0 && products.length === 0 && !planId && !passTypeId && !giftCard && !event) {
    refuse('validation', 'empty_order')
  }
  const sourceRemoved = source === 'gift_card'
  if (sourceRemoved) refuse('validation', 'gift_card_source_removed', GIFT_CARD_SOURCE_REMOVED_MESSAGE)
  if (input.customerId && !facts.customer) refuse('validation', 'customer_not_found')

  // Private bookings are always paid with real money, whatever the credit.
  const creditOnPrivate =
    (source === 'membership_credit' || source === 'session_pass_credit' || buysNew) && facts.session?.booking_type === 'private'
  if (creditOnPrivate) refuse('booking', 'private_booking_requires_real_payment')

  // --- Membership
  const frequency = input.membershipBillingFrequency
  let plan = null as BasketFacts['plan']
  let membershipPrice = 0
  if (planId) {
    if (frequency !== 'monthly' && frequency !== 'yearly') refuse('validation', 'membership_billing_frequency_required')
    else if (!facts.plan) refuse('validation', 'membership_plan_not_found')
    else if (facts.plan.active === false) refuse('validation', 'membership_plan_inactive')
    else {
      const price = frequency === 'yearly' ? facts.plan.price_yearly : facts.plan.price_monthly
      if (price === null) refuse('validation', 'membership_plan_price_not_set')
      else {
        plan = facts.plan
        membershipPrice = money(price)
      }
    }
  }
  if (buysNewMembership) {
    if (!planId) refuse('validation', 'booking_membership_plan_required')
    // Unlimited plans store sessions_included = 0 but still grant credit.
    else if (plan && !plan.is_unlimited && (plan.sessions_included ?? 0) <= 0) refuse('validation', 'booking_membership_plan_grants_no_sessions')
  }

  // --- Session pass
  let passType = null as BasketFacts['pass_type']
  if (passTypeId) {
    if (!facts.pass_type) refuse('validation', 'session_pass_type_not_found')
    else if (facts.pass_type.active === false) refuse('validation', 'session_pass_type_inactive')
    else passType = facts.pass_type
  }
  const passPrice = passType ? money(passType.price ?? '0') : 0
  if (buysNewPass) {
    if (!passTypeId) refuse('validation', 'booking_session_pass_type_required')
    else if (passType && (passType.sessions_included ?? 0) <= 0) refuse('validation', 'booking_session_pass_type_grants_no_sessions')
    else if (passType && !passType.covers_session) {
      refuse('validation', 'booking_session_pass_type_not_valid_for_band', "A Core pass can't be used for a Peak session. Choose an All-Access pass or another way to pay.")
    }
  }

  // --- Exhausted membership to replace
  if (booking?.cancelExhaustedMembershipId) {
    const old = facts.exhausted
    if (!buysNewMembership) refuse('validation', 'cancel_membership_requires_buy_new_membership')
    else if (!old) refuse('validation', 'exhausted_membership_not_found')
    // cancel_effective_date is the last day of access, so that day itself still counts.
    else if (old.subscription_status !== 'active' || (old.cancel_effective_date !== null && old.cancel_effective_date < facts.today)) {
      refuse('validation', 'exhausted_membership_not_active')
    } else if (old.is_unlimited || (old.credits_remaining ?? 0) > 0) refuse('validation', 'exhausted_membership_still_has_credit')
  }

  // --- Products
  const variants = new Map((facts.variants ?? []).map((row) => [row.id, row]))
  if (products.some((line) => !Number.isInteger(line.quantity) || line.quantity < 1)) refuse('validation', 'invalid_product_quantity')
  for (const line of products) {
    const variant = variants.get(line.productVariantId)
    const reason = !variant ? 'product_variant_not_found' : variant.product_active === false ? 'product_inactive' : null
    if (reason) {
      problems.push({ stage: 'validation', reason, productVariantId: line.productVariantId })
      break
    }
  }

  // --- Event
  const checkedEvent = event ? checkEvent(event, facts.event) : { line: null, problem: null }
  if (checkedEvent.problem) problems.push(checkedEvent.problem)
  const eventLine = checkedEvent.line

  // --- Prices, before postage: the shipped value is measured on them. Worked out here so that
  // their refusals can still come in createOrder's order, after postage.
  const addons = new Map((facts.addons ?? []).map((row) => [row.id, row]))
  const priceAddon = (line: BasketAddonLine): PricedLine => {
    const addon = addons.get(line.addonId)
    return priceLine(line.unitPrice, addon ? addonSystemPrice(addon, member) : (line.unitPrice ?? 0), line.priceOverrideReason, allowOverrides)
  }
  const pricedAttached = attached.map(priceAddon)
  const pricedStandalone = standalone.map(priceAddon)
  const pricedProducts = products.map((line) => {
    const variant = variants.get(line.productVariantId)
    return priceLine(line.unitPrice, variant ? variantSystemPrice(variant, member) : (line.unitPrice ?? 0), line.priceOverrideReason, allowOverrides)
  })
  const giftCardBought = resolveGiftCard(input, facts)

  // --- Delivery and postage
  const shippedProduct = products.some((line) => isShipped(line, variants.get(line.productVariantId)))
  const needsShipping = shippedProduct || giftCard?.fulfillmentMethod === 'shipping'
  const address = normaliseAddress(input.shippingAddress)
  let postage: BasketPostage | null = null
  if (needsShipping) {
    const missing = addressProblem(address)
    if (missing) refuse('validation', 'shipping_address_required', missing)

    const postageMethod = input.postageMethod === 'standard' || input.postageMethod === 'express' ? input.postageMethod : null
    // Q4: a shipped gift card counts, as the screen has always said. Q23: on corrected prices.
    const shippedValue =
      products.reduce((sum, line, i) => (isShipped(line, variants.get(line.productVariantId)) ? sum + (pricedProducts[i]?.unitPrice ?? 0) * line.quantity : sum), 0) +
      (giftCard?.fulfillmentMethod === 'shipping' ? giftCardBought.amount : 0)
    let amount = 0
    if (!postageMethod) {
      refuse('validation', 'postage_method_required', 'This order includes an item that must be shipped — choose a postage option (Standard or Express) in the Delivery address step.')
    } else if (!facts.postage) {
      refuse('validation', 'postage_settings_missing', 'Postage settings have not been configured yet — run the postage_settings migration to set them up.')
    } else {
      const threshold = money(facts.postage.free_shipping_threshold)
      // A threshold of 0 means no free postage.
      if (postageMethod === 'express') amount = money(facts.postage.express_price)
      else amount = threshold > 0 && shippedValue >= threshold ? 0 : money(facts.postage.standard_price)
    }
    postage = { method: postageMethod, amount, shippedValue: round2(shippedValue) }
  }
  const postageAmount = postage?.amount ?? 0

  // --- Add-ons
  const allAddons = [...attached, ...standalone]
  if (allAddons.some((line) => !Number.isInteger(line.quantity) || line.quantity < 1)) refuse('validation', 'invalid_addon_quantity')
  const creditWithoutMembership = (line: BasketAddonLine) => line.redemptionSource === 'membership_credit' && !line.membershipId
  // On a buy-new booking a missing membership means the one being bought.
  if (!buysNewMembership && attached.some(creditWithoutMembership)) refuse('validation', 'addon_membership_id_required')
  // Only an add-on on a booking can draw an add-on credit.
  if (standalone.some((line) => line.redemptionSource === 'membership_credit')) {
    refuse('validation', 'standalone_addon_credit_not_allowed', STANDALONE_CREDIT_MESSAGE)
  }
  for (const line of allAddons) {
    const addon = addons.get(line.addonId)
    const reason = !addon ? 'addon_not_found' : addon.active === false ? 'addon_inactive' : null
    if (reason) {
      refuse('validation', reason)
      break
    }
  }

  if ([...pricedAttached, ...pricedStandalone, ...pricedProducts].some((line) => line.needsReason)) {
    refuse('validation', 'price_override_reason_required', PRICE_REASON_MESSAGE)
  }

  if (giftCardBought.problem) problems.push(giftCardBought.problem)

  // --- Payment parts
  if (method && !['card', 'reader', 'cash'].includes(method)) refuse('validation', 'invalid_payment_method')
  if (plan && method === 'cash') {
    refuse(
      'payment',
      'membership_cash_not_accepted',
      "Memberships are billed by Stripe and cannot be paid in cash. The saved card on file is charged for the membership's renewals (a gift card or store credit can reduce the first payment). Take a card on the reader to save one first if needed."
    )
  }

  let giftCardApplied = 0
  if (payment?.giftCard) {
    const { amount } = payment.giftCard
    const card = facts.redeemed_gift_card
    if (!Number.isFinite(amount) || amount <= 0) refuse('validation', 'gift_card_amount_invalid')
    else if (!card) refuse('validation', 'gift_card_not_found')
    else if (card.voided) refuse('validation', 'gift_card_voided')
    // Valid through its expiry date (London).
    else if (card.expiry_date < facts.today) refuse('validation', 'gift_card_expired')
    else if (money(card.remaining_balance) <= 0 || amount > money(card.remaining_balance)) refuse('validation', 'gift_card_insufficient_or_invalid')
    else giftCardApplied = amount
  }

  let storeCreditApplied = 0
  if (payment?.storeCredit) {
    const { amount } = payment.storeCredit
    if (!Number.isFinite(amount) || amount <= 0) refuse('validation', 'store_credit_amount_invalid')
    else if (!facts.customer) {
      // A guest has no store credit. A missing customer was already refused above.
      if (!input.customerId) refuse('validation', 'customer_not_found')
    } else if (amount > money(facts.customer.store_credit_balance)) refuse('validation', 'store_credit_insufficient')
    else storeCreditApplied = amount
  }

  const onReader = method === 'reader'
  if (plan && payment && !onReader && !facts.customer?.has_saved_card) {
    refuse(
      'payment',
      'membership_no_saved_card',
      "This customer has no saved card. A membership always needs one — the card on file is charged for the membership's renewals (a gift card or store credit can reduce the first payment, but the card must be on file) — save a card on the card reader first, then retry checkout."
    )
  }
  if (plan && onReader && payment?.readerSaveCard !== true) {
    refuse(
      'payment',
      'reader_save_card_required',
      'Saving the card on the reader is required for a membership — the saved card is charged for the membership\'s renewals. Tick "Save this card for future charges?" (the customer must agree) before charging.'
    )
  }

  // --- Booking. createOrder only reaches createBooking once all of the above has passed.
  const pricedBooking: PricedBooking | null = booking && !sourceRemoved ? priceBooking(booking, facts) : null
  const bookingRefusal = booking && !sourceRemoved && !creditOnPrivate ? bookingProblem(booking, facts) : null
  const newMembership = buysNewMembership && plan ? { credits: plan.addons_included ?? 0, isHerd: frequency === 'yearly' } : null

  // --- Promo. Gift cards, postage and attached add-ons are never eligible.
  const promoText = input.promoCode?.trim() ?? ''
  const promoLines: PromoEligibleLine[] = [...(pricedBooking?.promoLines ?? [])]
  standalone.forEach((line, i) => {
    const addon = addons.get(line.addonId)
    const unitPrice = pricedStandalone[i]?.unitPrice ?? 0
    const memberPriced = member && addon?.member_price != null && Math.round(unitPrice * 100) === Math.round(money(addon.member_price) * 100)
    promoLines.push({ key: `addon:${i}`, itemType: 'addon', amount: unitPrice * line.quantity, isMemberPriced: memberPriced })
  })
  products.forEach((line, i) => {
    const variant = variants.get(line.productVariantId)
    const unitPrice = pricedProducts[i]?.unitPrice ?? 0
    const memberPriced = member && variant?.member_price != null && Math.round(unitPrice * 100) === Math.round(money(variant.member_price) * 100)
    promoLines.push({ key: `product:${i}`, itemType: 'product', amount: unitPrice * line.quantity, isMemberPriced: memberPriced })
  })
  if (passType && passPrice > 0.005) promoLines.push({ key: 'session_pass', itemType: 'session_pass', amount: passPrice, isMemberPriced: false })
  if (plan && membershipPrice > 0.005) promoLines.push({ key: 'membership', itemType: 'membership', amount: membershipPrice, isMemberPriced: false })
  if (eventLine) promoLines.push(...eventPromoLines(eventLine))

  let promo: BasketPromo | null = null
  let promoProblem: BasketProblem | null = null
  if (promoText) {
    const shown = promoText.toUpperCase()
    if (!facts.promo) {
      promoProblem = { stage: 'validation', reason: 'promo_code_invalid', message: `Promo code "${shown}" does not exist.` }
    } else {
      const { total_uses: totalUses, customer_uses: usesByThisCustomer, ...row } = facts.promo
      const result = applyPromoCode({
        promo: row,
        usage: { totalUses, usesByThisCustomer },
        todayLondon: facts.today,
        customerId: input.customerId ?? '',
        lines: promoLines,
      })
      if (result.ok) promo = { promoId: result.promoId, code: result.code, discountTotal: result.discountTotal, perLine: result.perLine }
      else promoProblem = { stage: 'validation', reason: 'promo_code_invalid', message: `Promo code "${shown}" cannot be used: ${result.message}` }
    }
  }

  // A buy-new order works its promo out before it writes anything; a normal one after the stock.
  const laterProblems = [
    ...(buysNew ? [promoProblem] : []),
    bookingRefusal,
    addonCreditProblem(attached, facts, newMembership),
    stockProblem(products, variants),
    ...(buysNew ? [] : [promoProblem]),
    eventLine ? eventFullProblem(eventLine) : null,
  ]
  problems.push(...laterProblems.filter((problem) => problem !== null))

  // --- Promo shares
  const share = (key: string): number => promo?.perLine.find((line) => line.key === key)?.discount ?? 0
  const sharesWith = (prefix: string): number => round2((promo?.perLine ?? []).filter((line) => line.key.startsWith(prefix)).reduce((sum, line) => sum + line.discount, 0))
  // Q24: a private booking's share is on its one `booking` line, the others' on their seats.
  const bookingDiscount = round2(sharesWith('seat:') + share('booking'))
  const eventDiscount = sharesWith('event:')
  const passDiscount = share('session_pass')
  const membershipDiscount = share('membership')

  // --- Totals. order_total stays at list price, with the promo held separately.
  const bookingPrice = pricedBooking?.price ?? 0
  const paidAttached = attached.reduce((sum, line, i) => ((line.redemptionSource ?? 'paid') === 'paid' ? sum + (pricedAttached[i]?.unitPrice ?? 0) * line.quantity : sum), 0)
  const standaloneTotal = standalone.reduce((sum, line, i) => sum + (pricedStandalone[i]?.unitPrice ?? 0) * line.quantity, 0)
  const productTotal = products.reduce((sum, line, i) => sum + (pricedProducts[i]?.unitPrice ?? 0) * line.quantity, 0)
  const eventTotal = eventLine?.listTotal ?? 0
  const orderTotal = bookingPrice + paidAttached + standaloneTotal + productTotal + membershipPrice + passPrice + giftCardBought.amount + eventTotal + postageAmount
  const addonDiscounts = standalone.reduce((sum, _, i) => sum + share(`addon:${i}`), 0)
  const productDiscounts = products.reduce((sum, _, i) => sum + share(`product:${i}`), 0)
  // Q1, Q2: everything but the membership, postage and standalone add-ons included. Gift card and
  // store credit pay all of this before any of it spills onto the membership's first payment.
  const nonMembershipDue =
    bookingPrice -
    bookingDiscount +
    paidAttached +
    standaloneTotal -
    addonDiscounts +
    productTotal -
    productDiscounts +
    passPrice -
    passDiscount +
    giftCardBought.amount +
    eventTotal -
    eventDiscount +
    postageAmount
  const firstPayment = plan ? Math.max(0, membershipPrice - membershipDiscount) : 0
  const totalDue = nonMembershipDue + firstPayment
  const credits = giftCardApplied + storeCreditApplied
  const spill = Math.max(0, Math.min(credits - nonMembershipDue, firstPayment))
  const spillFromStoreCredit = Math.min(storeCreditApplied, spill)
  const remainder = amountLeftToPay(nonMembershipDue, giftCardApplied, storeCreditApplied)
  // The one reader tap covers the membership's first payment too.
  const readerAmount = round2(Math.max(0, nonMembershipDue - credits) + Math.max(0, firstPayment - Math.max(0, credits - nonMembershipDue)))
  const amountDueTotal = round2(totalDue)

  // --- The amount checks, which mean nothing while something else is wrong
  if (problems.length === 0) {
    const toCharge = onReader ? readerAmount : remainder
    if (exceedsAmount(giftCardApplied, totalDue)) {
      problems.push({ stage: 'payment', reason: 'gift_card_amount_exceeds_total', amountDueTotal })
    } else if (exceedsAmount(credits, totalDue)) {
      problems.push({ stage: 'payment', reason: 'store_credit_amount_exceeds_total', amountDueTotal })
    } else if (payment && toCharge > 0 && !method) {
      problems.push({ stage: 'payment', reason: 'payment_method_required', amountDueTotal })
    } else if (onReader && toCharge <= 0.005) {
      problems.push({
        stage: 'payment',
        reason: 'reader_nothing_to_charge',
        message: plan
          ? 'Nothing is left for the card reader to charge (the basket is fully covered by credit — and a membership still needs a saved card for its renewals, so use the saved-card flow). Remove the credit parts or use a different payment method.'
          : 'The amount due has changed. Check it with the customer and confirm again.',
        amountDueTotal,
      })
    }
  }

  // --- The lines, in the order createOrder writes them
  const line = (fields: Pick<BasketLine, 'kind' | 'key' | 'unitPrice' | 'lineTotal'> & Partial<BasketLine>): BasketLine => ({
    itemId: null,
    name: null,
    quantity: 1,
    discount: 0,
    systemUnitPrice: null,
    priceOverrideReason: null,
    ...fields,
    unitPrice: round2(fields.unitPrice),
    lineTotal: round2(fields.lineTotal),
  })
  const membershipLine = plan
    ? [line({ kind: 'membership', key: 'membership', itemId: plan.id, name: plan.name, unitPrice: membershipPrice, lineTotal: membershipPrice, discount: membershipDiscount })]
    : []
  const passLine = passType
    ? [line({ kind: 'session_pass', key: 'session_pass', itemId: passType.id, name: passType.name, unitPrice: passPrice, lineTotal: passPrice, discount: passDiscount })]
    : []
  const bookingLine = pricedBooking ? [line({ kind: 'booking', key: 'booking', unitPrice: bookingPrice, lineTotal: bookingPrice, discount: bookingDiscount })] : []
  const eventOrderLine = eventLine
    ? [
        line({
          kind: 'event',
          key: 'event',
          itemId: eventLine.facts.id,
          name: eventLine.facts.name,
          quantity: eventLine.places.length,
          unitPrice: eventLine.listTotal / eventLine.places.length,
          lineTotal: eventLine.listTotal,
          discount: eventDiscount,
        }),
      ]
    : []
  const addonLines = standalone.map((item, i) => {
    const priced = pricedStandalone[i] as PricedLine
    return line({
      kind: 'addon',
      key: `addon:${i}`,
      itemId: item.addonId,
      name: addons.get(item.addonId)?.name ?? null,
      quantity: item.quantity,
      unitPrice: priced.unitPrice,
      lineTotal: priced.unitPrice * item.quantity,
      discount: share(`addon:${i}`),
      systemUnitPrice: priced.system,
      priceOverrideReason: priced.overrideReason,
    })
  })
  const productLines = products.map((item, i) => {
    const priced = pricedProducts[i] as PricedLine
    return line({
      kind: 'product',
      key: `product:${i}`,
      itemId: item.productVariantId,
      name: variants.get(item.productVariantId)?.product_name ?? null,
      quantity: item.quantity,
      unitPrice: priced.unitPrice,
      lineTotal: priced.unitPrice * item.quantity,
      discount: share(`product:${i}`),
      systemUnitPrice: priced.system,
      priceOverrideReason: priced.overrideReason,
    })
  })
  const giftCardLine = giftCard && !giftCardBought.problem ? [line({ kind: 'gift_card', key: 'gift_card', unitPrice: giftCardBought.amount, lineTotal: giftCardBought.amount })] : []
  const postageLine = postage ? [line({ kind: 'postage', key: 'postage', unitPrice: postageAmount, lineTotal: postageAmount })] : []
  // Q3: a buy-new order writes the membership and the pass ahead of the booking that needs them.
  const lines = [
    ...(buysNew ? [...membershipLine, ...passLine] : []),
    ...bookingLine,
    ...eventOrderLine,
    ...addonLines,
    ...productLines,
    ...(buysNew ? [] : [...membershipLine, ...passLine]),
    ...giftCardLine,
    ...postageLine,
  ]

  const bookingQuote: BasketBookingQuote | null =
    booking && pricedBooking
      ? {
          sessionId: booking.sessionId,
          bookingType: facts.session?.booking_type ?? null,
          band: facts.session?.band_code && facts.session.band_name ? { code: facts.session.band_code, name: facts.session.band_name } : null,
          redemptionSource: pricedBooking.recordedSource,
          price: round2(bookingPrice),
          discount: bookingDiscount,
          seats: pricedBooking.seats.map((seat) => ({ ...seat, discount: share(`seat:${seat.seatNo}`) })),
          addons: attached.map((item, i): BasketBookingAddon => {
            const priced = pricedAttached[i] as PricedLine
            const redemptionSource = item.redemptionSource ?? 'paid'
            return {
              addonId: item.addonId,
              name: addons.get(item.addonId)?.name ?? null,
              quantity: item.quantity,
              unitPrice: round2(priced.unitPrice),
              systemUnitPrice: round2(priced.system),
              redemptionSource,
              membershipId: redemptionSource === 'membership_credit' ? item.membershipId ?? null : null,
              charged: redemptionSource === 'paid' ? round2(priced.unitPrice * item.quantity) : 0,
            }
          }),
          // Q5: kept on a buy-new booking too.
          specialRequests: booking.specialRequests?.trim().slice(0, 500) || null,
        }
      : null

  const eventQuote: BasketEventQuote | null = eventLine
    ? {
        eventId: eventLine.facts.id,
        name: eventLine.facts.name,
        places: eventLine.places.map((place) => ({
          placeNo: place.place_no,
          attendeeType: place.attendee_type,
          priceLevel: place.price_level,
          unitPrice: money(place.unit_price),
          discount: share(`event:${place.place_no}`),
        })),
        listTotal: eventLine.listTotal,
        discount: eventDiscount,
        placesLeft: eventLine.facts.places_left,
      }
    : null

  return {
    lines,
    booking: bookingQuote,
    event: eventQuote,
    postage,
    // Q5: kept on a buy-new order too.
    delivery: needsShipping && address ? { address, saveToCustomer: input.saveShippingAddressToCustomer === true } : null,
    promo,
    totals: {
      orderTotal: round2(orderTotal),
      promoDiscount: promo?.discountTotal ?? 0,
      nonMembershipDue: round2(nonMembershipDue),
      membershipFirstPayment: round2(firstPayment),
      amountDue: amountDueTotal,
      giftCardApplied: round2(giftCardApplied),
      storeCreditApplied: round2(storeCreditApplied),
      spillToMembership: round2(spill),
      spillFromStoreCredit: round2(spillFromStoreCredit),
      spillFromGiftCard: round2(spill - spillFromStoreCredit),
      membershipToPay: round2(firstPayment - spill),
      toCollect: { card: round2(remainder), reader: readerAmount, cash: round2(remainder) },
      firstInvoice: plan && !onReader ? round2(firstPayment - spill) : 0,
    },
    problems,
  }
}

/** Prices a whole basket in one database read. See load-basket.ts. */
export async function priceBasket(q: Queryable, input: BasketQuoteInput, options: PriceBasketOptions = {}): Promise<BasketQuoteOutput> {
  return priceFromFacts(input, await loadBasketFacts(q, input), options)
}
