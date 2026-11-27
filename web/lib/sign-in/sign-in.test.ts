import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { ACCOUNT_SECTIONS } from '@/contracts/sign-in'
import { ACCOUNT_ADDRESS, SECTION_PAGES, sectionOf } from '@/lib/account/sections'
import { forThisDevice, KEEP_SIGNED_IN, keepSignedInCookie, keepsSignedIn } from '@/lib/supabase/keep-signed-in'

import { linkedFrom, meFrom, outcomeOf } from './account'
import { emailReturnAddress, returnPath } from './next'
import { LINK_COPY, SIGN_IN_COPY } from './words'

// Brief W85: the rules under the sign-in popup, the email link page and the account's menu.

const SITE = 'https://paddock.example'

describe('where a sign-in goes back to (backend log 27: only a page of this site)', () => {
  it.each([
    ['/shop/hoodie', '/shop/hoodie'],
    ['/account/bookings?tab=past', '/account/bookings?tab=past'],
    [`${SITE}/events/aufguss`, '/events/aufguss'],
    [`${SITE}`, '/'],
  ])('%s goes to %s', (next, path) => expect(returnPath(next, SITE)).toBe(path))

  it.each([null, '', 'https://elsewhere.example/account', '//elsewhere.example/x', '/\\elsewhere.example/x', 'javascript:alert(1)', 'http://paddock.example/shop', 'https://paddock.example.elsewhere.example/'])(
    'never another site, nor nothing: %s goes home',
    (next) => expect(returnPath(next, SITE)).toBe('/')
  )

  it("the email's link is told this site's address and the page's path, with no query string (W85a decision 6)", () => {
    expect(emailReturnAddress(SITE, '/shop/hoodie?colour=orange#top')).toBe(`${SITE}/shop/hoodie`)
    expect(emailReturnAddress(SITE, 'https://elsewhere.example/x')).toBe(`${SITE}/`)
  })
})

describe('"Keep me signed in" (Wayne, 30 Nov)', () => {
  const lasting = { path: '/', sameSite: 'lax' as const, maxAge: 400 * 24 * 60 * 60 }

  it('ticked, or never asked: the sign-in lasts until log out (Supabase\'s own 400 days)', () => {
    expect(keepsSignedIn([])).toBe(true)
    expect(keepsSignedIn([{ name: KEEP_SIGNED_IN, value: '1' }])).toBe(true)
    expect(forThisDevice(lasting, true)).toEqual(lasting)
  })

  it('unticked: the cookies have no lifetime, so the browser drops them when it closes', () => {
    expect(keepsSignedIn([{ name: 'other', value: '0' }, { name: KEEP_SIGNED_IN, value: '0' }])).toBe(false)
    expect(forThisDevice(lasting, false)).toEqual({ path: '/', sameSite: 'lax' })
    expect(forThisDevice({ path: '/', expires: new Date(Date.now() + 86_400_000) }, false)).toEqual({ path: '/' })
  })

  it('a cookie being taken away is still taken away (signing out never leaves the session until the browser closes)', () => {
    expect(forThisDevice({ path: '/', maxAge: 0 }, false)).toEqual({ path: '/', maxAge: 0 })
    const past = new Date(0)
    expect(forThisDevice({ path: '/', expires: past }, false)).toEqual({ path: '/', expires: past })
  })

  it("the choice is the site's cookie for this visit only, or none", () => {
    expect(keepSignedInCookie(false)).toBe(`${KEEP_SIGNED_IN}=0; Path=/; SameSite=Lax`)
    expect(keepSignedInCookie(true)).toBe(`${KEEP_SIGNED_IN}=; Path=/; Max-Age=0; SameSite=Lax`)
  })
})

describe("W85a's answers, as the site reads them", () => {
  const me = { firstName: 'Bob', email: 'bob@example.com', sections: ['dashboard', 'orders', 'details', 'preferences'] }

  it('who am I: the name, the email and the sections; anything else is a fault', () => {
    expect(outcomeOf(200, { ok: true, data: me }, meFrom)).toEqual({ kind: 'ok', answer: me })
    expect(outcomeOf(200, { ok: true, data: { ...me, sections: ['dashboard', 'garden'] } }, meFrom)).toEqual({ kind: 'fault' })
  })

  it('link and create: linked with a first name, or needs details', () => {
    expect(linkedFrom({ status: 'linked', customer: { firstName: 'Bob', email: 'bob@example.com' }, change: 'linked' })).toEqual({ status: 'linked', firstName: 'Bob' })
    expect(linkedFrom({ status: 'needs_details' })).toEqual({ status: 'needs_details' })
    expect(linkedFrom({ status: 'other' })).toBeNull()
  })

  it('no sign-in is signed out; a login with no customer is not linked yet', () => {
    expect(outcomeOf(401, { ok: false, error: { code: 'UNAUTHORISED', message: 'Please sign in to continue.' } }, meFrom)).toEqual({ kind: 'signed_out' })
    expect(outcomeOf(403, { ok: false, error: { code: 'CUSTOMER_NOT_LINKED', message: 'x' } }, meFrom)).toEqual({ kind: 'not_linked' })
  })

  it("a refusal keeps the Worker's own words, its reason and its field", () => {
    const words = 'This email is linked to another sign-in. Please contact us.'
    expect(outcomeOf(409, { ok: false, error: { code: 'CONFLICT', message: words, details: { reason: 'email_linked_elsewhere', message: words } } }, linkedFrom)).toEqual({
      kind: 'refused',
      refusal: { code: 'CONFLICT', reason: 'email_linked_elsewhere', field: null, message: words },
    })
    expect(outcomeOf(400, { ok: false, error: { code: 'VALIDATION', message: 'Please enter your first name.', field: 'firstName', details: { reason: 'first_name_required', message: 'Please enter your first name.' } } }, linkedFrom)).toMatchObject({
      refusal: { reason: 'first_name_required', field: 'firstName' },
    })
  })

  it('no answer the site can read, or a fault of the Worker\'s, is a fault: nothing is assumed', () => {
    expect(outcomeOf(500, { ok: false, error: { code: 'INTERNAL', message: 'x' } }, meFrom)).toEqual({ kind: 'fault' })
    expect(outcomeOf(502, null, meFrom)).toEqual({ kind: 'fault' })
  })
})

describe("the account's sections (backend log 25; docs/url-map.md)", () => {
  it("every one of W85a's sections has its address and Figma's words, in the menu's order", () => {
    expect(Object.keys(SECTION_PAGES)).toEqual([...ACCOUNT_SECTIONS])
    expect(Object.values(SECTION_PAGES).map((page) => page.label)).toEqual(['Dashboard', 'Bookings', 'Events', 'Orders', 'Membership', 'Passes', 'Store credit', 'Personal info', 'Preferences'])
    expect(SECTION_PAGES.store_credit.path).toBe('/account/store-credit')
    expect(SECTION_PAGES.details.path).toBe('/account/details')
  })

  it.each([
    ['/account', 'dashboard'],
    ['/account/', 'dashboard'],
    ['/account/bookings', 'bookings'],
    ['/account/bookings/12/move', 'bookings'],
    ['/account/store-credit?x=1', 'store_credit'],
    ['/account/close', 'preferences'],
    ['/account/garden', null],
    ['/accounts', null],
    ['/shop', null],
  ])('%s is %s', (address, section) => expect(sectionOf(address)).toBe(section))

  it('the Dashboard is /account', () => expect(SECTION_PAGES.dashboard.path).toBe(ACCOUNT_ADDRESS))
})

describe("the words are Figma's where Figma draws them", () => {
  it('the popup (SignInModal 1174:12669) and the link page (1180:24831)', () => {
    expect(SIGN_IN_COPY.wrongCode).toBe("That code isn't right or has expired. Check the latest email, or resend a new code.")
    expect(SIGN_IN_COPY.createIntro).toBe('You don’t have an account with us yet. Tell us a little about you to finish setting up your account.')
    expect([SIGN_IN_COPY.emailTitle, SIGN_IN_COPY.codeTitle, SIGN_IN_COPY.keepSignedIn, SIGN_IN_COPY.resend, SIGN_IN_COPY.resent, SIGN_IN_COPY.mobile, SIGN_IN_COPY.news]).toEqual([
      'Log in or create an account',
      'Enter Code',
      'Keep me signed in',
      'Resend code',
      'Code sent',
      'Mobile (Optional)',
      'Email me with news and offers',
    ])
    expect(LINK_COPY.expiredText).toBe('Sign-in links can only be used once and stop working after a while. Request a new one to sign in.')
  })
})

describe('the code in the browser never decides who the customer is', () => {
  const WEB = path.resolve(__dirname, '../..')
  const read = (file: string) => readFileSync(path.join(WEB, file), 'utf8')

  it('the routes are sent no email: link has no body, create only the names, the phone and the tick', () => {
    const calls = read('lib/sign-in/account.ts')
    expect(calls).toContain('call(LINK_ADDRESS, token, linkedFrom, {})')
    const host = read('components/frame/SignInHost.tsx')
    expect(host).toMatch(/askCreate\(login\.token, \{ firstName: account\.firstName, lastName: account\.lastName, phone: [^}]*, marketingConsent: account\.news \}\)/)
  })

  it('the email link is used up only by the button, never as the page loads (backend log 27)', () => {
    const page = read('components/auth/SignInLinkPage.tsx')
    expect(page).not.toMatch(/useEffect/)
    expect(page).toMatch(/const press = async \(\) => \{[\s\S]*?await confirm\(tokenHash\)/)
  })
})
