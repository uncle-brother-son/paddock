import { vi } from 'vitest'
import type { Db, SqlParam } from '@/server/db'
import type { FakeStripe } from '@/server/stripe/fake'

/**
 * Runs the old functions' Worker calls through the real legacy routes, with only their edges
 * swapped: Stripe's SDK becomes the fake, and supabase-js becomes a small stand-in over the same
 * test database. So the fake sees exactly what Stripe would, at the same boundary server/stripe
 * uses, and an old run and a new run can be compared call for call.
 */

const API_KEY = 'replay-legacy-key'

type Route = { POST: (request: never) => Promise<Response> }

const ROUTES: Record<string, () => Promise<unknown>> = {
  // W25: deleted from app/; the test-only copy of the old step D functions still calls it (legacy-order/README.md).
  '/api/payments/charge-saved-card': () => import('../legacy-order/routes/payments/charge-saved-card/route'),
  // W34: deleted from app/; the test-only copies of the old step D and step E functions still call them.
  '/api/payments/refund-order': () => import('../legacy-order/routes/payments/refund-order/route'),
  '/api/memberships/cancel-subscription': () => import('../legacy-order/routes/memberships/cancel-subscription/route'),
  // W36: the three legacy membership routes the old step F functions call, from the frozen copy (legacy-account/README.md).
  // W44: deleted from app/; step F's golden files keep replaying through the copy.
  '/api/memberships/cancel': () => import('../legacy-account/routes/memberships/cancel/route'),
  '/api/memberships/undo-cancel': () => import('../legacy-account/routes/memberships/undo-cancel/route'),
  '/api/memberships/change-payment-date': () => import('../legacy-account/routes/memberships/change-payment-date/route'),
  // W48: the seven legacy catalogue routes the old step G functions call, from the frozen copy (legacy-admin/README.md),
  // so step G's golden files keep replaying now that W61 has deleted the live ones from app/api/catalog.
  '/api/catalog/toggle-active': () => import('../legacy-admin/routes/catalog/toggle-active/route'),
  '/api/catalog/update-price': () => import('../legacy-admin/routes/catalog/update-price/route'),
  '/api/catalog/update-tier-price': () => import('../legacy-admin/routes/catalog/update-tier-price/route'),
  '/api/catalog/create-variant': () => import('../legacy-admin/routes/catalog/create-variant/route'),
  '/api/catalog/sync-stripe': () => import('../legacy-admin/routes/catalog/sync-stripe/route'),
  '/api/catalog/create-gift-card-preset': () => import('../legacy-admin/routes/catalog/create-gift-card-preset/route'),
  '/api/catalog/update-gift-card-preset-price': () => import('../legacy-admin/routes/catalog/update-gift-card-preset-price/route'),
  // W16: deleted from app/; the test-only copy of the old order code still calls them (legacy-order/README.md).
  '/api/memberships/create-subscription': () => import('../legacy-order/routes/memberships/create-subscription/route'),
  '/api/terminal/resolve-saved-card': () => import('../legacy-order/routes/terminal/resolve-saved-card/route'),
  // W25: these two as well.
  '/api/terminal/create-payment-intent': () => import('../legacy-order/routes/terminal/create-payment-intent/route'),
  '/api/terminal/payment-intent': () => import('../legacy-order/routes/terminal/payment-intent/route'),
}

/** The /api/v1/staff routes the old functions call, beyond the quote shadow's own. */
const STAFF_ROUTES: Record<string, () => Promise<unknown>> = {
  // W34: deleted from app/; the old refund code's look-up by key (shared/stripeRefundLookup in the frozen copies) still calls it.
  '/api/v1/staff/payments/refunds': () => import('../legacy-order/routes/v1/staff/payments/refunds/route'),
  // W14: the wrappers ask the Worker first (the terminal and the saved card; createOrder and the reader's finalise
  // and cancel when a test runs the staff app's own thin calls). The quote shadow is gone (W16).
  '/api/v1/staff/orders': () => import('@/app/api/v1/staff/orders/route'),
  '/api/v1/staff/terminal/connection-token': () => import('@/app/api/v1/staff/terminal/connection-token/route'),
  '/api/v1/staff/terminal/setup-intents': () => import('@/app/api/v1/staff/terminal/setup-intents/route'),
  // W14b: the Orders page (the manual reconcile run, the stuck list and the manual close).
  '/api/v1/staff/orders/reconcile': () => import('@/app/api/v1/staff/orders/reconcile/route'),
  '/api/v1/staff/orders/stuck': () => import('@/app/api/v1/staff/orders/stuck/route'),
  '/api/v1/staff/orders/stuck/close': () => import('@/app/api/v1/staff/orders/stuck/close/route'),
  // W47: the staff app's thin getMoneyOwed (the Orders page's "Money still to refund" section and Overview's count).
  '/api/v1/staff/money-owed': () => import('@/app/api/v1/staff/money-owed/route'),
  // W38: the staff app's thin getGiftCards.
  '/api/v1/staff/gift-cards': () => import('@/app/api/v1/staff/gift-cards/route'),
  // W39: the staff app's thin createCustomer and getCustomers.
  '/api/v1/staff/customers': () => import('@/app/api/v1/staff/customers/route'),
  // W40: the staff app's thin getSubscriptions.
  '/api/v1/staff/memberships': () => import('@/app/api/v1/staff/memberships/route'),
  // W49: the staff app's thin getCurrentStaff, getStaff and createStaff.
  '/api/v1/staff/staff/me': () => import('@/app/api/v1/staff/staff/me/route'),
  '/api/v1/staff/staff': () => import('@/app/api/v1/staff/staff/route'),
  // W54: the staff app's thin getPromoCodes and createPromoCode, setMembershipBandTerm and setPostageSettings.
  '/api/v1/staff/promo-codes': () => import('@/app/api/v1/staff/promo-codes/route'),
  '/api/v1/staff/pricing/member-band-terms': () => import('@/app/api/v1/staff/pricing/member-band-terms/route'),
  '/api/v1/staff/postage/settings': () => import('@/app/api/v1/staff/postage/settings/route'),
  // W54a: the staff app's thin getPricingConfig, which the Pricing page reads its stamps from before a save.
  '/api/v1/staff/pricing/config': () => import('@/app/api/v1/staff/pricing/config/route'),
  // W54: New Order's basket quote (the staff app's thin quoteBasket), read before and after a pricing change.
  '/api/v1/staff/quotes/basket': () => import('@/app/api/v1/staff/quotes/basket/route'),
  // W50: the staff app's thin getBookings, getAddonPrepChecklistForRange, getWaiverGapsForRange and getPaymentAttentionItems.
  '/api/v1/staff/bookings': () => import('@/app/api/v1/staff/bookings/route'),
  '/api/v1/staff/bookings/addon-prep': () => import('@/app/api/v1/staff/bookings/addon-prep/route'),
  '/api/v1/staff/bookings/waiver-gaps': () => import('@/app/api/v1/staff/bookings/waiver-gaps/route'),
  '/api/v1/staff/overview/payment-attention': () => import('@/app/api/v1/staff/overview/payment-attention/route'),
  // W51: the staff app's thin getSessionsForRange and createOneOffSession (one path, GET and POST), and getServiceTypesForSlot.
  '/api/v1/staff/sessions': () => import('@/app/api/v1/staff/sessions/route'),
  '/api/v1/staff/sessions/for-slot': () => import('@/app/api/v1/staff/sessions/for-slot/route'),
  // W52: the staff app's thin getEvents and getTodaysEvents, and the check-in press (setEventAttendeeCheckIn checking in, and setEventAttendeesCheckIn).
  '/api/v1/staff/catalog/events': () => import('@/app/api/v1/staff/catalog/events/route'),
  '/api/v1/staff/events/today': () => import('@/app/api/v1/staff/events/today/route'),
  '/api/v1/staff/events/attendees/check-in': () => import('@/app/api/v1/staff/events/attendees/check-in/route'),
  // W55 + W56: the staff app's thin getProducts, getAddons, getServiceTypes, getSessionPassTypes and
  // getGiftCardTypes, and setServiceTypePriceTierRange (one route for a size group, by the tier in its body).
  '/api/v1/staff/catalog/products': () => import('@/app/api/v1/staff/catalog/products/route'),
  '/api/v1/staff/catalog/addons': () => import('@/app/api/v1/staff/catalog/addons/route'),
  '/api/v1/staff/catalog/service-types': () => import('@/app/api/v1/staff/catalog/service-types/route'),
  '/api/v1/staff/catalog/session-pass-types': () => import('@/app/api/v1/staff/catalog/session-pass-types/route'),
  '/api/v1/staff/catalog/gift-card-types': () => import('@/app/api/v1/staff/catalog/gift-card-types/route'),
  '/api/v1/staff/catalog/tier-groups/range': () => import('@/app/api/v1/staff/catalog/tier-groups/range/route'),
  // W57: the staff app's thin getMembershipPlans and createMembershipPlan (one path, GET and POST), getMembershipSettings
  // and setMembershipSettings (likewise), and getMembershipSettingsQuote.
  '/api/v1/staff/catalog/membership-plans': () => import('@/app/api/v1/staff/catalog/membership-plans/route'),
  '/api/v1/staff/membership-settings': () => import('@/app/api/v1/staff/membership-settings/route'),
  '/api/v1/staff/membership-settings/quote': () => import('@/app/api/v1/staff/membership-settings/quote/route'),
}

/** W55 + W56: `catalog/<folder>/:id/<leaf>`, each loading its own route file, the id under the route's own name. */
const catalogRoute = (folder: string, param: string, leaf: string, load: () => Promise<unknown>) => ({
  pattern: new RegExp(`^/api/v1/staff/catalog/${folder}/([^/]+)/${leaf}$`),
  load,
  params: (m: RegExpMatchArray) => ({ [param]: decodeURIComponent(m[1] ?? '') }),
})
const CATALOG_PATTERNS = [
  catalogRoute('products', 'productId', 'active', () => import('@/app/api/v1/staff/catalog/products/[productId]/active/route')),
  catalogRoute('products', 'productId', 'price', () => import('@/app/api/v1/staff/catalog/products/[productId]/price/route')),
  catalogRoute('products', 'productId', 'fulfilment', () => import('@/app/api/v1/staff/catalog/products/[productId]/fulfilment/route')),
  catalogRoute('products', 'productId', 'variants', () => import('@/app/api/v1/staff/catalog/products/[productId]/variants/route')),
  catalogRoute('variants', 'variantId', 'details', () => import('@/app/api/v1/staff/catalog/variants/[variantId]/details/route')),
  catalogRoute('variants', 'variantId', 'stock', () => import('@/app/api/v1/staff/catalog/variants/[variantId]/stock/route')),
  catalogRoute('variants', 'variantId', 'stock-adjustments', () => import('@/app/api/v1/staff/catalog/variants/[variantId]/stock-adjustments/route')),
  catalogRoute('addons', 'addonId', 'active', () => import('@/app/api/v1/staff/catalog/addons/[addonId]/active/route')),
  catalogRoute('addons', 'addonId', 'price', () => import('@/app/api/v1/staff/catalog/addons/[addonId]/price/route')),
  catalogRoute('addons', 'addonId', 'sku', () => import('@/app/api/v1/staff/catalog/addons/[addonId]/sku/route')),
  catalogRoute('service-types', 'serviceTypeId', 'active', () => import('@/app/api/v1/staff/catalog/service-types/[serviceTypeId]/active/route')),
  catalogRoute('service-types', 'serviceTypeId', 'price', () => import('@/app/api/v1/staff/catalog/service-types/[serviceTypeId]/price/route')),
  catalogRoute('service-types', 'serviceTypeId', 'details', () => import('@/app/api/v1/staff/catalog/service-types/[serviceTypeId]/details/route')),
  catalogRoute('service-types', 'serviceTypeId', 'tiers', () => import('@/app/api/v1/staff/catalog/service-types/[serviceTypeId]/tiers/route')),
  catalogRoute('tiers', 'tierId', 'price', () => import('@/app/api/v1/staff/catalog/tiers/[tierId]/price/route')),
  catalogRoute('session-pass-types', 'passTypeId', 'active', () => import('@/app/api/v1/staff/catalog/session-pass-types/[passTypeId]/active/route')),
  catalogRoute('session-pass-types', 'passTypeId', 'price', () => import('@/app/api/v1/staff/catalog/session-pass-types/[passTypeId]/price/route')),
  catalogRoute('session-pass-types', 'passTypeId', 'details', () => import('@/app/api/v1/staff/catalog/session-pass-types/[passTypeId]/details/route')),
  catalogRoute('session-pass-types', 'passTypeId', 'level-quote', () => import('@/app/api/v1/staff/catalog/session-pass-types/[passTypeId]/level-quote/route')),
  catalogRoute('gift-card-types', 'giftCardTypeId', 'active', () => import('@/app/api/v1/staff/catalog/gift-card-types/[giftCardTypeId]/active/route')),
  catalogRoute('gift-card-types', 'giftCardTypeId', 'details', () => import('@/app/api/v1/staff/catalog/gift-card-types/[giftCardTypeId]/details/route')),
  catalogRoute('gift-card-types', 'giftCardTypeId', 'presets', () => import('@/app/api/v1/staff/catalog/gift-card-types/[giftCardTypeId]/presets/route')),
  catalogRoute('gift-card-presets', 'presetId', 'active', () => import('@/app/api/v1/staff/catalog/gift-card-presets/[presetId]/active/route')),
  catalogRoute('gift-card-presets', 'presetId', 'price', () => import('@/app/api/v1/staff/catalog/gift-card-presets/[presetId]/price/route')),
  // W57: a plan's details and price (setMembershipPlanDetails, and updateCatalogItemPrice for a plan), and on or off sale.
  catalogRoute('membership-plans', 'planId', 'details', () => import('@/app/api/v1/staff/catalog/membership-plans/[planId]/details/route')),
  catalogRoute('membership-plans', 'planId', 'active', () => import('@/app/api/v1/staff/catalog/membership-plans/[planId]/active/route')),
]

/** W14: the staff routes with an id in the path, and the path's parameters. */
const STAFF_PATTERNS: Array<{ pattern: RegExp; load: () => Promise<unknown>; params: (match: RegExpMatchArray) => Record<string, string> }> = [
  { pattern: /^\/api\/v1\/staff\/orders\/([^/]+)\/finalise$/, load: () => import('@/app/api/v1/staff/orders/[orderId]/finalise/route'), params: (m) => ({ orderId: m[1] ?? '' }) },
  { pattern: /^\/api\/v1\/staff\/orders\/([^/]+)\/cancel$/, load: () => import('@/app/api/v1/staff/orders/[orderId]/cancel/route'), params: (m) => ({ orderId: m[1] ?? '' }) },
  { pattern: /^\/api\/v1\/staff\/customers\/([^/]+)\/saved-card$/, load: () => import('@/app/api/v1/staff/customers/[customerId]/saved-card/route'), params: (m) => ({ customerId: m[1] ?? '' }) },
  // W18: the staff app's thin setBookingSpecialRequests and setBookingStatus.
  { pattern: /^\/api\/v1\/staff\/bookings\/([^/]+)\/special-requests$/, load: () => import('@/app/api/v1/staff/bookings/[bookingId]/special-requests/route'), params: (m) => ({ bookingId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/bookings\/([^/]+)\/status$/, load: () => import('@/app/api/v1/staff/bookings/[bookingId]/status/route'), params: (m) => ({ bookingId: decodeURIComponent(m[1] ?? '') }) },
  // W19: the staff app's thin settleLapsedBooking, and its flow wrappers for a flow the Worker started.
  { pattern: /^\/api\/v1\/staff\/bookings\/([^/]+)\/settle$/, load: () => import('@/app/api/v1/staff/bookings/[bookingId]/settle/route'), params: (m) => ({ bookingId: decodeURIComponent(m[1] ?? '') }) },
  // W20: the staff app's thin addBookingGuest.
  { pattern: /^\/api\/v1\/staff\/bookings\/([^/]+)\/guests$/, load: () => import('@/app/api/v1/staff/bookings/[bookingId]/guests/route'), params: (m) => ({ bookingId: decodeURIComponent(m[1] ?? '') }) },
  // W21: the staff app's thin refundBooking (Part refund, Refund the rest, It already arrived) and getBookingRefundFigures.
  { pattern: /^\/api\/v1\/staff\/bookings\/([^/]+)\/refunds$/, load: () => import('@/app/api/v1/staff/bookings/[bookingId]/refunds/route'), params: (m) => ({ bookingId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/bookings\/([^/]+)\/refunds\/owed$/, load: () => import('@/app/api/v1/staff/bookings/[bookingId]/refunds/owed/route'), params: (m) => ({ bookingId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/bookings\/([^/]+)\/refunds\/owed-arrived$/, load: () => import('@/app/api/v1/staff/bookings/[bookingId]/refunds/owed-arrived/route'), params: (m) => ({ bookingId: decodeURIComponent(m[1] ?? '') }) },
  // W22: Remove Guest (quote, remove) and Remove add-on (quote, remove), by the guest's or the add-on line's id.
  { pattern: /^\/api\/v1\/staff\/bookings\/guests\/([^/]+)\/remove\/quote$/, load: () => import('@/app/api/v1/staff/bookings/guests/[guestId]/remove/quote/route'), params: (m) => ({ guestId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/bookings\/guests\/([^/]+)\/remove$/, load: () => import('@/app/api/v1/staff/bookings/guests/[guestId]/remove/route'), params: (m) => ({ guestId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/bookings\/addon-lines\/([^/]+)\/remove\/quote$/, load: () => import('@/app/api/v1/staff/bookings/addon-lines/[lineId]/remove/quote/route'), params: (m) => ({ lineId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/bookings\/addon-lines\/([^/]+)\/remove$/, load: () => import('@/app/api/v1/staff/bookings/addon-lines/[lineId]/remove/route'), params: (m) => ({ lineId: decodeURIComponent(m[1] ?? '') }) },
  // W23: Cancel & Refund (quote, press) and Cancel & return credit / Cancel (payment needed) (quote, press).
  { pattern: /^\/api\/v1\/staff\/bookings\/([^/]+)\/cancel-and-refund\/quote$/, load: () => import('@/app/api/v1/staff/bookings/[bookingId]/cancel-and-refund/quote/route'), params: (m) => ({ bookingId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/bookings\/([^/]+)\/cancel-and-refund$/, load: () => import('@/app/api/v1/staff/bookings/[bookingId]/cancel-and-refund/route'), params: (m) => ({ bookingId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/bookings\/([^/]+)\/cancel-credit\/quote$/, load: () => import('@/app/api/v1/staff/bookings/[bookingId]/cancel-credit/quote/route'), params: (m) => ({ bookingId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/bookings\/([^/]+)\/cancel-credit$/, load: () => import('@/app/api/v1/staff/bookings/[bookingId]/cancel-credit/route'), params: (m) => ({ bookingId: decodeURIComponent(m[1] ?? '') }) },
  // W24: Move's quote and press.
  { pattern: /^\/api\/v1\/staff\/bookings\/([^/]+)\/move\/quote$/, load: () => import('@/app/api/v1/staff/bookings/[bookingId]/move/quote/route'), params: (m) => ({ bookingId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/bookings\/([^/]+)\/move$/, load: () => import('@/app/api/v1/staff/bookings/[bookingId]/move/route'), params: (m) => ({ bookingId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/bookings\/([^/]+)\/refund-figures$/, load: () => import('@/app/api/v1/staff/bookings/[bookingId]/refund-figures/route'), params: (m) => ({ bookingId: decodeURIComponent(m[1] ?? '') }) },
  // W28: the staff app's thin refundOrder, getOrderRefundFigures and refundOrderOwed.
  { pattern: /^\/api\/v1\/staff\/orders\/([^/]+)\/refund-figures$/, load: () => import('@/app/api/v1/staff/orders/[orderId]/refund-figures/route'), params: (m) => ({ orderId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/orders\/([^/]+)\/refunds$/, load: () => import('@/app/api/v1/staff/orders/[orderId]/refunds/route'), params: (m) => ({ orderId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/orders\/([^/]+)\/refunds\/owed$/, load: () => import('@/app/api/v1/staff/orders/[orderId]/refunds/owed/route'), params: (m) => ({ orderId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/orders\/([^/]+)\/refunds\/owed-arrived$/, load: () => import('@/app/api/v1/staff/orders/[orderId]/refunds/owed-arrived/route'), params: (m) => ({ orderId: decodeURIComponent(m[1] ?? '') }) },
  // W30: the staff app's thin cancelEventPlaces and getEventCancellationQuote.
  { pattern: /^\/api\/v1\/staff\/event-bookings\/([^/]+)\/cancel\/quote$/, load: () => import('@/app/api/v1/staff/event-bookings/[eventBookingId]/cancel/quote/route'), params: (m) => ({ eventBookingId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/event-bookings\/([^/]+)\/cancel$/, load: () => import('@/app/api/v1/staff/event-bookings/[eventBookingId]/cancel/route'), params: (m) => ({ eventBookingId: decodeURIComponent(m[1] ?? '') }) },
  // W31: the staff app's thin cancelEvent and getEventCancellationOverview.
  { pattern: /^\/api\/v1\/staff\/events\/([^/]+)\/cancel\/overview$/, load: () => import('@/app/api/v1/staff/events/[eventId]/cancel/overview/route'), params: (m) => ({ eventId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/events\/([^/]+)\/cancel$/, load: () => import('@/app/api/v1/staff/events/[eventId]/cancel/route'), params: (m) => ({ eventId: decodeURIComponent(m[1] ?? '') }) },
  // W37: the staff app's thin adjustMembershipCredits, getMembershipCreditAdjustments, setMembershipHerd and adjustCustomerStoreCredit.
  { pattern: /^\/api\/v1\/staff\/memberships\/([^/]+)\/credits$/, load: () => import('@/app/api/v1/staff/memberships/[membershipId]/credits/route'), params: (m) => ({ membershipId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/memberships\/([^/]+)\/credit-adjustments$/, load: () => import('@/app/api/v1/staff/memberships/[membershipId]/credit-adjustments/route'), params: (m) => ({ membershipId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/memberships\/([^/]+)\/herd$/, load: () => import('@/app/api/v1/staff/memberships/[membershipId]/herd/route'), params: (m) => ({ membershipId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/customers\/([^/]+)\/store-credit$/, load: () => import('@/app/api/v1/staff/customers/[customerId]/store-credit/route'), params: (m) => ({ customerId: decodeURIComponent(m[1] ?? '') }) },
  // W40: the staff app's thin setMembershipCancellation (cancel and undo).
  { pattern: /^\/api\/v1\/staff\/memberships\/([^/]+)\/cancel$/, load: () => import('@/app/api/v1/staff/memberships/[membershipId]/cancel/route'), params: (m) => ({ membershipId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/memberships\/([^/]+)\/undo-cancel$/, load: () => import('@/app/api/v1/staff/memberships/[membershipId]/undo-cancel/route'), params: (m) => ({ membershipId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/memberships\/([^/]+)\/payment-date$/, load: () => import('@/app/api/v1/staff/memberships/[membershipId]/payment-date/route'), params: (m) => ({ membershipId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/memberships\/([^/]+)\/payment-date\/quote$/, load: () => import('@/app/api/v1/staff/memberships/[membershipId]/payment-date/quote/route'), params: (m) => ({ membershipId: decodeURIComponent(m[1] ?? '') }) },
  // W47r: "Try the payment again now" and its quote.
  { pattern: /^\/api\/v1\/staff\/memberships\/([^/]+)\/retry-payment$/, load: () => import('@/app/api/v1/staff/memberships/[membershipId]/retry-payment/route'), params: (m) => ({ membershipId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/memberships\/([^/]+)\/retry-payment\/quote$/, load: () => import('@/app/api/v1/staff/memberships/[membershipId]/retry-payment/quote/route'), params: (m) => ({ membershipId: decodeURIComponent(m[1] ?? '') }) },
  // W38: the staff app's thin extendGiftCardExpiry, setGiftCardPickedUp, setGiftCardShipped and getGiftCardRedemptions.
  { pattern: /^\/api\/v1\/staff\/gift-cards\/([^/]+)\/extend$/, load: () => import('@/app/api/v1/staff/gift-cards/[giftCardId]/extend/route'), params: (m) => ({ giftCardId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/gift-cards\/([^/]+)\/picked-up$/, load: () => import('@/app/api/v1/staff/gift-cards/[giftCardId]/picked-up/route'), params: (m) => ({ giftCardId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/gift-cards\/([^/]+)\/shipped$/, load: () => import('@/app/api/v1/staff/gift-cards/[giftCardId]/shipped/route'), params: (m) => ({ giftCardId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/gift-cards\/([^/]+)\/redemptions$/, load: () => import('@/app/api/v1/staff/gift-cards/[giftCardId]/redemptions/route'), params: (m) => ({ giftCardId: decodeURIComponent(m[1] ?? '') }) },
  // W39: the staff app's thin getCustomerDetail.
  { pattern: /^\/api\/v1\/staff\/customers\/([^/]+)$/, load: () => import('@/app/api/v1/staff/customers/[customerId]/route'), params: (m) => ({ customerId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/reader-flows\/([^/]+)\/finalise$/, load: () => import('@/app/api/v1/staff/reader-flows/[pendingId]/finalise/route'), params: (m) => ({ pendingId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/reader-flows\/([^/]+)\/cancel$/, load: () => import('@/app/api/v1/staff/reader-flows/[pendingId]/cancel/route'), params: (m) => ({ pendingId: decodeURIComponent(m[1] ?? '') }) },
  // W49: the staff app's thin setStaffRole, and setStaffPermission and setStaffCanManagePricing (one route).
  { pattern: /^\/api\/v1\/staff\/staff\/([^/]+)\/role$/, load: () => import('@/app/api/v1/staff/staff/[staffId]/role/route'), params: (m) => ({ staffId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/staff\/([^/]+)\/permissions$/, load: () => import('@/app/api/v1/staff/staff/[staffId]/permissions/route'), params: (m) => ({ staffId: decodeURIComponent(m[1] ?? '') }) },
  // W54: the staff app's thin setBandPrice and setBandRules, getPromoCodeRedemptions and updatePromoCode (never
  // `promo-codes/validate`, which is step B's own route).
  { pattern: /^\/api\/v1\/staff\/pricing\/bands\/([^/]+)\/price$/, load: () => import('@/app/api/v1/staff/pricing/bands/[bandId]/price/route'), params: (m) => ({ bandId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/pricing\/band-rules\/([^/]+)$/, load: () => import('@/app/api/v1/staff/pricing/band-rules/[dayOfWeek]/route'), params: (m) => ({ dayOfWeek: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/promo-codes\/([^/]+)\/redemptions$/, load: () => import('@/app/api/v1/staff/promo-codes/[promoCodeId]/redemptions/route'), params: (m) => ({ promoCodeId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/promo-codes\/(?!validate$)([^/]+)$/, load: () => import('@/app/api/v1/staff/promo-codes/[promoCodeId]/route'), params: (m) => ({ promoCodeId: decodeURIComponent(m[1] ?? '') }) },
  // W50: the staff app's thin getBookingById and getBookingDetail, and the three flags. A booking's own row is the
  // path with an id and nothing after it (never one of the fixed paths beside it, which are looked up first).
  { pattern: /^\/api\/v1\/staff\/bookings\/([^/]+)\/detail$/, load: () => import('@/app/api/v1/staff/bookings/[bookingId]/detail/route'), params: (m) => ({ bookingId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/bookings\/([^/]+)\/check-in$/, load: () => import('@/app/api/v1/staff/bookings/[bookingId]/check-in/route'), params: (m) => ({ bookingId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/bookings\/guests\/([^/]+)\/waiver$/, load: () => import('@/app/api/v1/staff/bookings/guests/[guestId]/waiver/route'), params: (m) => ({ guestId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/bookings\/addon-lines\/([^/]+)\/prepared$/, load: () => import('@/app/api/v1/staff/bookings/addon-lines/[lineId]/prepared/route'), params: (m) => ({ lineId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/bookings\/(?!addon-prep$|waiver-gaps$|day-conflict$)([^/]+)$/, load: () => import('@/app/api/v1/staff/bookings/[bookingId]/route'), params: (m) => ({ bookingId: decodeURIComponent(m[1] ?? '') }) },
  // W51: the staff app's thin blockDay, unblockDay and setSessionBand for a day (each with its quote); blockSession,
  // unblockSession, setSessionBand for one session (with its quote), resetSessionBand and setSessionStartTime; and
  // the two weekly slot functions. A day's paths are `sessions/days/:date/...`, so they are listed before a session's.
  { pattern: /^\/api\/v1\/staff\/sessions\/days\/([^/]+)\/block\/quote$/, load: () => import('@/app/api/v1/staff/sessions/days/[date]/block/quote/route'), params: (m) => ({ date: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/sessions\/days\/([^/]+)\/block$/, load: () => import('@/app/api/v1/staff/sessions/days/[date]/block/route'), params: (m) => ({ date: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/sessions\/days\/([^/]+)\/unblock\/quote$/, load: () => import('@/app/api/v1/staff/sessions/days/[date]/unblock/quote/route'), params: (m) => ({ date: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/sessions\/days\/([^/]+)\/unblock$/, load: () => import('@/app/api/v1/staff/sessions/days/[date]/unblock/route'), params: (m) => ({ date: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/sessions\/days\/([^/]+)\/band\/quote$/, load: () => import('@/app/api/v1/staff/sessions/days/[date]/band/quote/route'), params: (m) => ({ date: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/sessions\/days\/([^/]+)\/band$/, load: () => import('@/app/api/v1/staff/sessions/days/[date]/band/route'), params: (m) => ({ date: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/sessions\/(?!days\/)([^/]+)\/block$/, load: () => import('@/app/api/v1/staff/sessions/[sessionId]/block/route'), params: (m) => ({ sessionId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/sessions\/(?!days\/)([^/]+)\/unblock$/, load: () => import('@/app/api/v1/staff/sessions/[sessionId]/unblock/route'), params: (m) => ({ sessionId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/sessions\/(?!days\/)([^/]+)\/band\/quote$/, load: () => import('@/app/api/v1/staff/sessions/[sessionId]/band/quote/route'), params: (m) => ({ sessionId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/sessions\/(?!days\/)([^/]+)\/band\/reset$/, load: () => import('@/app/api/v1/staff/sessions/[sessionId]/band/reset/route'), params: (m) => ({ sessionId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/sessions\/(?!days\/)([^/]+)\/band$/, load: () => import('@/app/api/v1/staff/sessions/[sessionId]/band/route'), params: (m) => ({ sessionId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/sessions\/(?!days\/)([^/]+)\/start-time$/, load: () => import('@/app/api/v1/staff/sessions/[sessionId]/start-time/route'), params: (m) => ({ sessionId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/catalog\/service-types\/([^/]+)\/schedule-slots$/, load: () => import('@/app/api/v1/staff/catalog/service-types/[serviceTypeId]/schedule-slots/route'), params: (m) => ({ serviceTypeId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/catalog\/schedule-slots\/([^/]+)\/remove$/, load: () => import('@/app/api/v1/staff/catalog/schedule-slots/[slotId]/remove/route'), params: (m) => ({ slotId: decodeURIComponent(m[1] ?? '') }) },
  // W52: the staff app's thin setEventDetails and setEventActive; getEventAttendees; and an attendee's undo and waiver
  // (`events/attendees/:attendeeId/...`: an event's own paths are `events/:eventId/...`, never `events/attendees`).
  { pattern: /^\/api\/v1\/staff\/catalog\/events\/([^/]+)\/details$/, load: () => import('@/app/api/v1/staff/catalog/events/[eventId]/details/route'), params: (m) => ({ eventId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/catalog\/events\/([^/]+)\/active$/, load: () => import('@/app/api/v1/staff/catalog/events/[eventId]/active/route'), params: (m) => ({ eventId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/events\/attendees\/([^/]+)\/check-in\/undo$/, load: () => import('@/app/api/v1/staff/events/attendees/[attendeeId]/check-in/undo/route'), params: (m) => ({ attendeeId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/events\/attendees\/([^/]+)\/waiver$/, load: () => import('@/app/api/v1/staff/events/attendees/[attendeeId]/waiver/route'), params: (m) => ({ attendeeId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/events\/([^/]+)\/attendees$/, load: () => import('@/app/api/v1/staff/events/[eventId]/attendees/route'), params: (m) => ({ eventId: decodeURIComponent(m[1] ?? '') }) },
  // W53: the staff app's thin getOrderLineItems and setOrderLineItemFulfilled (`orders/lines/:lineItemId/...`: an
  // order's own paths are `orders/:orderId/...`, never `orders/lines`). getOrders is the exact path above.
  { pattern: /^\/api\/v1\/staff\/orders\/lines\/([^/]+)\/fulfilled$/, load: () => import('@/app/api/v1/staff/orders/lines/[lineItemId]/fulfilled/route'), params: (m) => ({ lineItemId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/orders\/([^/]+)\/lines$/, load: () => import('@/app/api/v1/staff/orders/[orderId]/lines/route'), params: (m) => ({ orderId: decodeURIComponent(m[1] ?? '') }) },
  // W55 + W56: the catalogue's writes and the two reads with an id (a variant's stock history, a pass type's level
  // quote). A service type's paths beside W51's schedule slots (`catalog/service-types/:id/schedule-slots`, above).
  ...CATALOG_PATTERNS,
]

function staffRoute(path: string): { load: () => Promise<unknown>; params: Record<string, string> } | null {
  const exact = STAFF_ROUTES[path]
  if (exact) return { load: exact, params: {} }
  for (const { pattern, load, params } of STAFF_PATTERNS) {
    const match = path.match(pattern)
    if (match) return { load, params: params(match) }
  }
  return null
}

const active: { stripe: FakeStripe | null; db: Db | null } = { stripe: null, db: null }

/**
 * The parts of supabase-js the legacy routes use: select, update and insert, by equal columns. W48: and what the
 * legacy update-price route's member look-up adds: `.in(column, values)` and `.not(column, 'is', null)`.
 */
class SupabaseQuery {
  private filters: Array<[string, unknown]> = []
  /** W48: conditions that aren't "equals": each a SQL fragment and the values it binds, in order. */
  private conditions: Array<{ sql: (bind: (value: unknown) => string) => string }> = []
  private columns = '*'
  private write: { kind: 'update' | 'insert'; row: Record<string, unknown> } | null = null

  constructor(private readonly table: string) {}

  select(columns = '*') {
    this.columns = columns
    return this
  }
  eq(column: string, value: unknown) {
    this.filters.push([column, value])
    return this
  }
  in(column: string, values: unknown[]) {
    this.conditions.push({ sql: (bind) => `${column} IN (${values.map(bind).join(', ')})` })
    return this
  }
  not(column: string, operator: string, value: unknown) {
    if (operator !== 'is' || value !== null) throw new Error("The supabase stand-in has only modelled .not(column, 'is', null).")
    this.conditions.push({ sql: () => `${column} IS NOT NULL` })
    return this
  }
  update(row: Record<string, unknown>) {
    this.write = { kind: 'update', row: withoutUndefined(row) }
    return this
  }
  insert(row: Record<string, unknown>) {
    this.write = { kind: 'insert', row: withoutUndefined(row) }
    return this
  }

  private async rows(): Promise<Record<string, unknown>[]> {
    const db = active.db as Db
    const params: SqlParam[] = []
    const bind = (value: unknown) => {
      params.push(value as SqlParam)
      return `$${params.length}`
    }
    // Test data only: the table and column names are literals from the legacy routes.
    let sql: string
    if (this.write?.kind === 'insert') {
      const names = Object.keys(this.write.row)
      const values = Object.values(this.write.row).map(bind)
      sql = `INSERT INTO ${this.table} (${names.join(', ')}) VALUES (${values.join(', ')}) RETURNING *`
    } else if (this.write?.kind === 'update') {
      const sets = Object.entries(this.write.row).map(([name, value]) => `${name} = ${bind(value)}`)
      const where = this.filters.map(([name, value]) => `${name} = ${bind(value)}`)
      sql = `UPDATE ${this.table} SET ${sets.join(', ')} WHERE ${where.join(' AND ')} RETURNING *`
    } else {
      const where = [...this.filters.map(([name, value]) => `${name} = ${bind(value)}`), ...this.conditions.map((condition) => condition.sql(bind))]
      sql = `SELECT ${this.columns} FROM ${this.table} WHERE ${where.join(' AND ')}`
    }
    return db.query(sql, params)
  }

  async single() {
    try {
      const rows = await this.rows()
      return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: 'Expected one row.' } }
    } catch (err) {
      return { data: null, error: { message: err instanceof Error ? err.message : String(err) } }
    }
  }

  then<T>(resolve: (value: { data: unknown; error: { message: string } | null }) => T, reject?: (reason: unknown) => T) {
    return this.rows()
      .then((data) => ({ data, error: null }), (err: Error) => ({ data: null, error: { message: err.message } }))
      .then(resolve, reject)
  }
}

/** W48: a field set to `undefined` is not sent, as supabase-js's JSON body leaves it out (create-variant's `price_override`). */
const withoutUndefined = (row: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined))

let installed = false

/** Must run before any route is imported, so the routes pick up the stand-ins. */
function install(): void {
  if (installed) return
  installed = true
  vi.doMock('stripe', async () => {
    const actual = await vi.importActual<typeof import('stripe')>('stripe')
    class StripeStandIn {
      static errors = actual.default.errors
      static createFetchHttpClient = () => undefined
      constructor() {
        if (!active.stripe) throw new Error('No fake Stripe is bound.')
        return active.stripe
      }
    }
    return { ...actual, default: StripeStandIn }
  })
  vi.doMock('@supabase/supabase-js', () => ({
    createClient: () => ({ from: (table: string) => new SupabaseQuery(table) }),
  }))
  // The staff routes open the same test database. A test file that mocks this itself keeps its own,
  // which points at the same database.
  vi.doMock('@/server/db/connection', () => ({
    openRequestDb: () => active.db,
    closeRequestDb: () => {},
  }))
}

export interface LegacyCall {
  path: string
  method?: string
  body?: unknown
}

/** A stand-in for paddockBackendApi2.rawRequest: like the real one, it never throws on a non-2xx. */
export function bindLegacyRoutes(db: Db, stripe: FakeStripe) {
  install()
  active.db = db
  active.stripe = stripe
  vi.stubEnv('RETOOL_API_KEY', API_KEY)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://replay.test')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'replay')
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_replay')

  return async function rawRequest({ path, method = 'POST', body }: LegacyCall): Promise<{ data: unknown }> {
    const load = ROUTES[path]
    if (!load) throw new Error(`The replay harness has no legacy route ${path}.`)
    const route = (await load()) as Route
    const request = new Request(`http://replay.test${path}`, {
      method,
      headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    const response = await route.POST(request as never)
    return { data: await response.json() }
  }
}

export interface StaffCall {
  path: string
  method?: string
  headers?: Record<string, string>
  queryParams?: Record<string, string>
  body?: unknown
}

/**
 * A stand-in for paddockWorkerV1.rawRequest, running the real /api/v1/staff route. The resource
 * adds the key, as the "Paddock Worker v1" resource does; callWorker adds who is acting. Uses the
 * key a test file already set, so its own routes keep working.
 */
export function bindStaffRoutes() {
  install()
  let key = process.env.STAFF_API_KEY
  if (!key) {
    key = 'replay-staff-key'
    vi.stubEnv('STAFF_API_KEY', key)
  }
  const staffKey = key
  return async function rawRequest({ path, method = 'GET', headers = {}, queryParams, body }: StaffCall): Promise<{ data: unknown }> {
    const found = staffRoute(path)
    if (!found) throw new Error(`The replay harness has no staff route ${path}.`)
    const route = (await found.load()) as Record<string, (request: Request, context?: { params: Promise<Record<string, string>> }) => Promise<Response>>
    const handler = route[method]
    if (!handler) throw new Error(`${path} has no ${method}.`)
    const url = new URL(`http://replay.test${path}`)
    for (const [name, value] of Object.entries(queryParams ?? {})) url.searchParams.set(name, value)
    const response = await handler(
      new Request(url, {
        method,
        headers: { ...headers, authorization: `Bearer ${staffKey}`, 'content-type': 'application/json' },
        ...(method !== 'GET' && body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      { params: Promise.resolve(found.params) }
    )
    return { data: await response.json() }
  }
}
