import { vi } from 'vitest'
import type { Db } from '@/server/db'

/**
 * W64 (H-plan 3.3 step 1): the staff app's `paddockWorkerV1` resource, standing in for Retool: a thin wrapper's call
 * runs the real /api/v1/staff route on the test database. Moved here from `replay/legacy-routes.ts` (W14 to W63), so the
 * Worker's own tests and the all-Worker sweep can call the staff app's thin wrappers with nothing of the old code
 * loaded. `replay/legacy-routes.ts` binds the old side through this one, adding its one frozen route.
 */

type Route = Record<string, (request: Request, context?: { params: Promise<Record<string, string>> }) => Promise<Response>>

/** The /api/v1/staff routes the staff app's thin wrappers call, by exact path. */
const STAFF_ROUTES: Record<string, () => Promise<unknown>> = {
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

function staffRoute(path: string, extra: Readonly<Record<string, () => Promise<unknown>>>): { load: () => Promise<unknown>; params: Record<string, string> } | null {
  const exact = extra[path] ?? STAFF_ROUTES[path]
  if (exact) return { load: exact, params: {} }
  for (const { pattern, load, params } of STAFF_PATTERNS) {
    const match = path.match(pattern)
    if (match) return { load, params: params(match) }
  }
  return null
}

const active: { db: Db | null } = { db: null }
let installed = false

/**
 * The routes open the test database: `db`, or the one bound last. Must run before any route is imported, so the routes
 * pick up the stand-in. A test file that mocks @/server/db/connection itself keeps its own, which points at the same
 * database.
 */
export function bindReplayDatabase(db?: Db): void {
  if (db) active.db = db
  if (installed) return
  installed = true
  vi.doMock('@/server/db/connection', () => ({
    openRequestDb: () => active.db,
    closeRequestDb: () => {},
  }))
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
 * key a test file already set, so its own routes keep working. W64: `db` is the database the routes open (left out:
 * the one bound last); `extra` adds routes by exact path (the old side's one frozen route, legacy-routes.ts).
 */
export function bindStaffRoutes(db?: Db, extra: Readonly<Record<string, () => Promise<unknown>>> = {}) {
  bindReplayDatabase(db)
  let key = process.env.STAFF_API_KEY
  if (!key) {
    key = 'replay-staff-key'
    vi.stubEnv('STAFF_API_KEY', key)
  }
  const staffKey = key
  return async function rawRequest({ path, method = 'GET', headers = {}, queryParams, body }: StaffCall): Promise<{ data: unknown }> {
    const found = staffRoute(path, extra)
    if (!found) throw new Error(`The replay harness has no staff route ${path}.`)
    const route = (await found.load()) as Route
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
