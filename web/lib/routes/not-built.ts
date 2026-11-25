// The site's own addresses whose pages are not built yet (Level 3, 25 Nov 2026).
//
// A link to one is drawn and followed as any other (the header's Book and Account, the menu's and the Shop's gift
// card), but SiteLink never asks for it ahead of a press: Next fetches every link it can see in the background, and a
// page that is not there is a wasted request for each one, on every page of the site. When a page is built, take its
// address out: lib/routes/not-built.test.ts fails until this list and the folders in app/ agree.

export const NOT_BUILT_ADDRESSES = ['/account', '/auth', '/blog', '/book', '/checkout', '/events', '/waiver', '/shop/gift-card'] as const

/** Whether an address of the site has a page to open: any but a not-built address, or one beneath it (/account/orders). */
export function isBuiltAddress(href: string): boolean {
  const path = href.split(/[?#]/)[0] ?? ''
  return !NOT_BUILT_ADDRESSES.some((address) => path === address || path.startsWith(`${address}/`))
}
