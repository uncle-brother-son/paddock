import type { AccountSection } from '@/contracts/sign-in'

// W85 (backend log 25; docs/url-map.md, Account): the account's sections, by W85a's names, with their addresses and
// Figma's words (AccountNav, 1137:10804), in the menu's order. Which a customer sees is W85a's who am I.

export const ACCOUNT_ADDRESS = '/account'

export const SECTION_PAGES: Record<AccountSection, { path: string; label: string }> = {
  dashboard: { path: ACCOUNT_ADDRESS, label: 'Dashboard' },
  bookings: { path: '/account/bookings', label: 'Bookings' },
  events: { path: '/account/events', label: 'Events' },
  orders: { path: '/account/orders', label: 'Orders' },
  membership: { path: '/account/membership', label: 'Membership' },
  passes: { path: '/account/passes', label: 'Passes' },
  store_credit: { path: '/account/store-credit', label: 'Store credit' },
  details: { path: '/account/details', label: 'Personal info' },
  preferences: { path: '/account/preferences', label: 'Preferences' },
}

/** The words for Log out (AccountNav; and the last choice of the phone's menu: Wayne, 30 Nov). */
export const LOG_OUT = 'Log out'

/**
 * The section an /account address belongs to, by its first part after /account (a detail page is its section's:
 * /account/bookings/12 is Bookings; Figma's note on AccountNav); /account/close is Preferences', as Figma says. Null
 * for an address that is no section (which goes to /account).
 */
export function sectionOf(path: string): AccountSection | null {
  const [, first, part] = path.split(/[?#]/)[0]?.split('/') ?? []
  if (first !== 'account') return null
  if (part === undefined || part === '') return 'dashboard'
  if (part === 'close') return 'preferences'
  const found = (Object.entries(SECTION_PAGES) as [AccountSection, { path: string }][]).find(([section, page]) => section !== 'dashboard' && page.path === `${ACCOUNT_ADDRESS}/${part}`)
  return found ? found[0] : null
}
