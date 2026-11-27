// The site's own addresses whose pages are not built yet (Level 3, 25 Nov 2026).
//
// A link to one is drawn and followed as any other (the header's Book and Account), but SiteLink never asks for it
// ahead of a press: Next fetches every link it can see in the background, and a page that is not there is a wasted
// request for each one, on every page of the site. When a page is built, take its address out:
// lib/routes/not-built.test.ts fails until this list and the folders in app/ agree. W76: /shop/gift-card is built, so
// the Shop's gift card card and the menu's Gift Cards link are fetched ahead as any other. W77: /book is built (the
// home page with the booking panel open; a link to it inside the site opens the panel where the visitor is).

export const NOT_BUILT_ADDRESSES = ['/account', '/auth', '/blog', '/checkout', '/events', '/waiver'] as const

/**
 * W75: a not-built address whose pages beneath it are built. An event's page (/events/<slug>) is there and is fetched
 * ahead as any built page; /events itself has no page yet (the events list is on Exclusive Hire: WQ60).
 */
export const BUILT_BENEATH: readonly string[] = ['/events']

/**
 * Whether an address of the site has a page to open: any but a not-built address, or one beneath it
 * (/account/orders), unless what is beneath it is built (/events/<slug>).
 */
export function isBuiltAddress(href: string): boolean {
  const path = href.split(/[?#]/)[0] ?? ''
  return !NOT_BUILT_ADDRESSES.some((address) => path === address || (path.startsWith(`${address}/`) && !BUILT_BENEATH.includes(address)))
}
