import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import answers from '@/lib/sanity/sample-answers.json'

import { bookingDaysAddress, bookingDaysFrom, bookingQuoteAddress, bookingQuoteFrom, sessionsAddress, sessionsFrom, type BookingQuote, type DaySessions, type PrivateSession, type PublicSession } from './api'
import {
  addDays,
  addMonths,
  bookingSummary,
  chosenSession,
  dayHeading,
  dayName,
  groupFor,
  groupLine,
  londonToday,
  monthOf,
  monthTitle,
  monthWeeks,
  privateBand,
  rowPrice,
  sessionTime,
  spotsLine,
  viewNote,
  type BookAddOn,
} from './book'

// Brief W77: the Book panel (WQ64-WQ66). What it writes, how it lays a month out, what it makes of W77a's three
// routes' answers, the add-ons it is given, and the one sum made on the site ("Total to pay"). The panel itself is
// watched in a browser (components/book/*.stories.tsx).

const fetched = vi.hoisted(() => vi.fn())
const readShopAddons = vi.hoisted(() => vi.fn())
vi.mock('@sanity/client', () => ({ createClient: () => ({ fetch: fetched }) }))
vi.mock('next/server', () => ({ connection: async () => undefined }))
vi.mock('react', async (original) => ({ ...(await original<typeof import('react')>()), cache: <T>(read: T) => read }))
vi.mock('next/cache', () => ({ unstable_cache: <T>(read: T): T => read }))
vi.mock('@/server/rules/shop/reads', () => ({ readShop: vi.fn(), readShopGiftCard: vi.fn() }))
vi.mock('@/server/rules/shop/events', () => ({ readShopEvents: vi.fn(), readShopEvent: vi.fn() }))
vi.mock('@/server/rules/shop/booking', () => ({ readShopAddons }))

const { bookAddOns, readBookAddOns } = await import('./read')

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SANITY_PROJECT_ID', 'project')
  vi.stubEnv('NEXT_PUBLIC_SANITY_DATASET', 'production')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  fetched.mockReset()
  readShopAddons.mockReset()
})

const PUBLIC: PublicSession = { id: '3333b108-0000-4000-8000-000000000001', startsAt: '2026-11-26T07:00:00+00:00', minutes: 60, service: 'Contrast Therapy', band: 'Off-Peak', state: 'bookable', mostPeople: 6, spotsLeft: 6, price: '15.00' }
const PRIVATE: PrivateSession = {
  id: '2d8b075b-0000-4000-8000-000000000002',
  startsAt: '2026-11-26T07:00:00+00:00',
  minutes: 60,
  service: 'Contrast Therapy - Private 60 min',
  band: 'Off-Peak',
  state: 'bookable',
  mostPeople: 10,
  prices: [
    { from: 1, to: 6, price: '90.00' },
    { from: 7, to: 7, price: '105.00' },
    { from: 8, to: 8, price: '120.00' },
    { from: 9, to: 9, price: '135.00' },
    { from: 10, to: 10, price: '150.00' },
  ],
}
/** A day as the sessions route answers it (briefs/W77a-logs/live-read.txt, cut to one session of each kind). */
const DAY: DaySessions = { date: '2026-11-26', mostPeople: { public: 6, private: 10 }, public: [PUBLIC], private: [{ minutes: 60, sessions: [PRIVATE] }] }
const QUOTE: BookingQuote = {
  session: PUBLIC.id,
  people: 3,
  reason: null,
  mostPeople: 6,
  total: '45.00',
  lines: [
    { who: 'you', people: 1, each: '15.00', total: '15.00' },
    { who: 'guests', people: 2, each: '15.00', total: '30.00' },
  ],
}

describe('days and months', () => {
  it("today is London's date, whatever the visitor's clock says", () => {
    expect(londonToday(new Date('2026-11-25T12:00:00Z'))).toBe('2026-11-25')
    // Winter: London is on UTC, so a minute before midnight is still the 25th.
    expect(londonToday(new Date('2026-11-25T23:59:00Z'))).toBe('2026-11-25')
    // Summer: London is an hour ahead, so 23:30 UTC is already tomorrow there.
    expect(londonToday(new Date('2026-07-01T23:30:00Z'))).toBe('2026-07-02')
    expect(londonToday(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12-31')
  })

  it('a month on, a month back, across the year; a day on, across the month', () => {
    expect([addMonths('2026-11', 1), addMonths('2026-12', 1), addMonths('2027-01', -1), addMonths('2026-11', 0), addMonths('2026-11', 14)]).toEqual(['2026-12', '2027-01', '2026-12', '2026-11', '2028-01'])
    expect([addDays('2026-11-30', 1), addDays('2026-12-01', -1), addDays('2026-12-31', 1), addDays('2028-02-28', 1), addDays('2026-11-12', 7), addDays('2026-11-12', -7)]).toEqual([
      '2026-12-01',
      '2026-11-30',
      '2027-01-01',
      '2028-02-29',
      '2026-11-19',
      '2026-11-05',
    ])
    expect(monthOf('2026-11-26')).toBe('2026-11')
  })

  it('a month is six weeks of seven, Monday first, blank where a week has no day of it', () => {
    const november = monthWeeks('2026-11')
    expect(november.map((week) => week.length)).toEqual([7, 7, 7, 7, 7, 7])
    // As Figma draws it: the 1st is a Sunday, alone at the end of the first week, and the 30th alone at the start of the sixth.
    expect(november[0]).toEqual([null, null, null, null, null, null, '2026-11-01'])
    expect(november[1]).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'])
    expect(november[5]).toEqual(['2026-11-30', null, null, null, null, null, null])
    expect(november.flat().filter((day) => day !== null)).toHaveLength(30)
    // February 2027 starts on a Monday and fills four weeks: the last two are blank, and the card keeps its height.
    const february = monthWeeks('2027-02')
    expect(february[0]![0]).toBe('2027-02-01')
    expect(february[3]![6]).toBe('2027-02-28')
    expect([...february[4]!, ...february[5]!].every((day) => day === null)).toBe(true)
    // A leap year's February, and a 31-day month that needs all six.
    expect(monthWeeks('2028-02').flat().filter((day) => day !== null)).toHaveLength(29)
    expect(monthWeeks('2026-08')[5]![0]).toBe('2026-08-31')
  })

  it('writes a month and a day as the designs do', () => {
    expect(monthTitle('2026-11')).toBe('November 2026')
    expect(dayHeading('2026-11-12')).toBe('Thursday 12th November 2026')
    expect([dayHeading('2026-12-01'), dayHeading('2026-12-22'), dayHeading('2027-01-03'), dayHeading('2026-12-11')]).toEqual(['Tuesday 1st December 2026', 'Tuesday 22nd December 2026', 'Sunday 3rd January 2027', 'Friday 11th December 2026'])
    expect(dayName('2026-11-12')).toBe('Thursday 12 November 2026')
  })
})

describe("a session's row", () => {
  it("the time is London's clock, in winter and in summer", () => {
    expect(sessionTime('2026-11-26T07:00:00+00:00')).toBe('07:00')
    // W77a gives the moment with the UK's own offset: 08:00 in July is 07:00 UTC, and still 08:00 on the row.
    expect(sessionTime('2026-07-01T08:00:00+01:00')).toBe('08:00')
    expect(sessionTime('2026-07-01T07:00:00Z')).toBe('08:00')
    expect(sessionTime('not a moment')).toBe('')
  })

  it('a price as drawn, the spots left, and a private band', () => {
    expect([rowPrice('15.00'), rowPrice('105.00'), rowPrice('4.50')]).toEqual(['£15', '£105', '£4.50'])
    expect([spotsLine(3), spotsLine(1), spotsLine(6)]).toEqual(['3 Spots Left', '1 Spot Left', '6 Spots Left'])
    expect(privateBand('Off-Peak')).toBe('Private - Off-Peak')
  })

  it("a private session's price is its size group's, by how many people the stepper is on", () => {
    expect([1, 4, 6].map((people) => groupFor(PRIVATE, people)?.price)).toEqual(['90.00', '90.00', '90.00'])
    expect([7, 8, 10].map((people) => groupFor(PRIVATE, people)?.price)).toEqual(['105.00', '120.00', '150.00'])
    // More than any group holds, or a size with no price of its own: none, never a guess.
    expect(groupFor(PRIVATE, 11)).toBeNull()
    expect(groupFor({ prices: [{ from: 1, to: 6, price: '90.00' }, { from: 8, to: 8, price: '120.00' }] }, 7)).toBeNull()
    expect([groupLine({ from: 1, to: 6 }), groupLine({ from: 7, to: 7 }), groupLine({ from: 1, to: 1 })]).toEqual(['1-6 People', '7 People', '1 Person'])
  })

  it("the line under the heading carries W77a's own number", () => {
    expect(viewNote('public', DAY.mostPeople.public)).toBe('Public sessions are shared. Up to 6 guests per session.')
    expect(viewNote('private', DAY.mostPeople.private)).toBe('You have the whole venue. Up to 10 guests per session.')
    expect(viewNote('public', 8)).toBe('Public sessions are shared. Up to 8 guests per session.')
  })
})

describe("what W77a's routes answer", () => {
  const ok = (data: unknown) => ({ ok: true, data })

  it('each read asks its own route, with what it is given in the address', () => {
    expect(bookingDaysAddress('2026-11')).toBe('/api/v1/shop/booking-days?month=2026-11')
    expect(sessionsAddress('2026-11-26')).toBe('/api/v1/shop/sessions?date=2026-11-26')
    expect(bookingQuoteAddress(PUBLIC.id, 3)).toBe(`/api/v1/shop/booking-quote?session=${PUBLIC.id}&people=3`)
  })

  it("a month's days: its own answer, or nothing", () => {
    const days = { month: '2026-11', publicDays: ['2026-11-26', '2026-11-27'], privateDays: ['2026-11-26'], firstDay: '2026-11-26', lastDay: '2027-03-03' }
    expect(bookingDaysFrom(ok(days), '2026-11')).toEqual(days)
    expect(bookingDaysFrom(ok({ ...days, firstDay: null, lastDay: null }), '2026-11')).toEqual({ ...days, firstDay: null, lastDay: null })
    // Another month's answer, a refusal, a list that isn't one, or no answer at all.
    expect(bookingDaysFrom(ok(days), '2026-12')).toBeNull()
    expect(bookingDaysFrom({ ok: false, error: { code: 'VALIDATION' } }, '2026-11')).toBeNull()
    expect(bookingDaysFrom(ok({ ...days, publicDays: 'all' }), '2026-11')).toBeNull()
    expect(bookingDaysFrom(ok({ ...days, privateDays: [26] }), '2026-11')).toBeNull()
    expect(bookingDaysFrom(null, '2026-11')).toBeNull()
  })

  it("a day's sessions: its own answer whole, or nothing", () => {
    expect(sessionsFrom(ok(DAY), '2026-11-26')).toEqual(DAY)
    expect(sessionsFrom(ok({ ...DAY, public: [], private: [] }), '2026-11-26')).toEqual({ ...DAY, public: [], private: [] })
    expect(sessionsFrom(ok(DAY), '2026-11-27')).toBeNull()
    // One session it can't read spoils the day: never half a list.
    expect(sessionsFrom(ok({ ...DAY, public: [PUBLIC, { ...PUBLIC, price: null }] }), '2026-11-26')).toBeNull()
    expect(sessionsFrom(ok({ ...DAY, public: [{ ...PUBLIC, state: 'blocked' }] }), '2026-11-26')).toBeNull()
    expect(sessionsFrom(ok({ ...DAY, private: [{ minutes: 60, sessions: [{ ...PRIVATE, prices: [{ from: 1, to: 6 }] }] }] }), '2026-11-26')).toBeNull()
    expect(sessionsFrom(ok({ ...DAY, mostPeople: { public: 6 } }), '2026-11-26')).toBeNull()
    expect(sessionsFrom({ ok: false }, '2026-11-26')).toBeNull()
  })

  it("a group's price: the answer for that session and that many people, or nothing", () => {
    expect(bookingQuoteFrom(ok(QUOTE), PUBLIC.id, 3)).toEqual(QUOTE)
    const refused = { session: PUBLIC.id, people: 7, reason: 'too_many', mostPeople: 6, total: null, lines: [] }
    expect(bookingQuoteFrom(ok(refused), PUBLIC.id, 7)).toEqual(refused)
    // Another session's, another count's, a reason it doesn't know, or "bookable" with no price.
    expect(bookingQuoteFrom(ok(QUOTE), PRIVATE.id, 3)).toBeNull()
    expect(bookingQuoteFrom(ok(QUOTE), PUBLIC.id, 2)).toBeNull()
    expect(bookingQuoteFrom(ok({ ...refused, reason: 'because' }), PUBLIC.id, 7)).toBeNull()
    expect(bookingQuoteFrom(ok({ ...QUOTE, total: null }), PUBLIC.id, 3)).toBeNull()
    expect(bookingQuoteFrom(ok({ ...QUOTE, lines: [{ who: 'everyone', people: 3, each: null, total: '45.00' }] }), PUBLIC.id, 3)).toBeNull()
  })
})

describe('"Your booking"', () => {
  const addOn = (id: string, name: string, price: string): BookAddOn => ({ id, name, price, picture: null })
  const ADD_ONS = [addOn('towel', 'One Towel Hire', '3.00'), addOn('knoll', 'High Brown Knoll', '5.00'), addOn('coffee', 'Cold Brew', '4.50'), addOn('tea', 'Tea', '0.10')]

  it('the session chosen carries booking-quote\'s own total; a refusal chooses nothing', () => {
    expect(chosenSession('public', PUBLIC, 3, QUOTE)).toEqual({
      view: 'public',
      session: { id: PUBLIC.id, startsAt: PUBLIC.startsAt, minutes: 60, service: 'Contrast Therapy', band: 'Off-Peak' },
      people: 3,
      group: null,
      total: '45.00',
    })
    expect(chosenSession('public', PUBLIC, 7, { session: PUBLIC.id, people: 7, reason: 'too_many', mostPeople: 6, total: null, lines: [] })).toBeNull()
    expect(chosenSession('public', PUBLIC, 1, { session: PUBLIC.id, people: 1, reason: 'closed', mostPeople: 0, total: null, lines: [] })).toBeNull()
    const group: BookingQuote = { session: PRIVATE.id, people: 4, reason: null, mostPeople: 10, total: '90.00', lines: [{ who: 'group', people: 4, each: null, total: '90.00' }] }
    expect(chosenSession('private', PRIVATE, 4, group)).toMatchObject({ view: 'private', people: 4, group: { from: 1, to: 6 }, total: '90.00' })
  })

  it('a public booking: one people line with the quote\'s total, and nothing added to it', () => {
    const one = bookingSummary(chosenSession('public', PUBLIC, 1, { ...QUOTE, people: 1, total: '15.00', lines: [QUOTE.lines[0]!] })!, ADD_ONS, {})
    expect(one).toEqual({
      service: 'Contrast Therapy',
      when: '07:00 Thursday 26 November 2026',
      startsAt: '2026-11-26T07:00:00+00:00',
      detail: '60 min - Public - Off-Peak',
      people: { key: 'people', label: '1 Person', value: '£15.00' },
      addOns: [],
      total: '£15.00',
    })
    const three = bookingSummary(chosenSession('public', PUBLIC, 3, QUOTE)!, ADD_ONS, {})
    expect([three.people.label, three.people.value, three.total]).toEqual(['3 People', '£45.00', '£45.00'])
  })

  it("a private booking says which group's price it is, and has no band in its line", () => {
    const quote = (people: number, total: string): BookingQuote => ({ session: PRIVATE.id, people, reason: null, mostPeople: 10, total, lines: [{ who: 'group', people, each: null, total }] })
    const four = bookingSummary(chosenSession('private', PRIVATE, 4, quote(4, '90.00'))!, ADD_ONS, {})
    expect([four.detail, four.people.label, four.people.value, four.total]).toEqual(['60 min - Private', '4 People - Group price for 1 to 6', '£90.00', '£90.00'])
    const seven = bookingSummary(chosenSession('private', PRIVATE, 7, quote(7, '105.00'))!, ADD_ONS, {})
    expect([seven.people.label, seven.people.value]).toEqual(['7 People - Group price for 7', '£105.00'])
    const alone = bookingSummary(chosenSession('private', PRIVATE, 1, quote(1, '90.00'))!, ADD_ONS, {})
    expect(alone.people.label).toBe('1 Person - Group price for 1 to 6')
  })

  it('each add-on chosen has its line, in the add-ons\' own order, and the total is the lines added up in whole pence', () => {
    const summary = bookingSummary(chosenSession('public', PUBLIC, 3, QUOTE)!, ADD_ONS, { coffee: 3, towel: 2, knoll: 0, gone: 4 })
    expect(summary.addOns).toEqual([
      { key: 'towel', label: 'One Towel Hire × 2', value: '£6.00' },
      { key: 'coffee', label: 'Cold Brew × 3', value: '£13.50' },
    ])
    expect(summary.total).toBe('£64.50')
    // Pence that a sum in pounds gets wrong (0.10 three times is 0.30000000000000004): whole pence, so never.
    const pennies = bookingSummary(chosenSession('public', PUBLIC, 3, QUOTE)!, ADD_ONS, { tea: 3, coffee: 1 })
    expect([pennies.addOns.map((line) => line.value), pennies.total]).toEqual([['£4.50', '£0.30'], '£49.80'])
    expect(bookingSummary(chosenSession('public', PUBLIC, 3, QUOTE)!, ADD_ONS, { towel: 99 }).total).toBe('£342.00')
  })
})

describe('the add-ons the panel is given', () => {
  const ON_SALE = [
    { sanityId: 'addon-towel', name: 'Towel', category: 'amenities', price: '3.00' },
    { sanityId: 'addon-knoll', name: 'High Brown Knoll', category: 'food_drink', price: '5.00' },
    { sanityId: 'addon-robe', name: 'Robe', category: 'amenities', price: '6.00' },
    { sanityId: 'not-in-sanity', name: 'Massage', category: 'services', price: '35.00' },
  ]

  it("W77a's add-ons in W77a's order, each with its Sanity picture cut 4 by 5, or none", () => {
    const addOns = bookAddOns(ON_SALE, answers.addons)
    expect(addOns.map(({ id, name, price }) => [id, name, price])).toEqual([
      ['addon-towel', 'Towel', '3.00'],
      ['addon-knoll', 'High Brown Knoll', '5.00'],
      ['addon-robe', 'Robe', '6.00'],
      ['not-in-sanity', 'Massage', '35.00'],
    ])
    expect(addOns.map((addOn) => addOn.picture?.alt ?? null)).toEqual(['', 'A bottle of High Brown Knoll', null, null])
    const picture = addOns[1]!.picture!
    expect([picture.width, picture.height]).toEqual([120, 150])
    expect(picture.src).toContain('https://cdn.sanity.io/images/project/production/knoll-1200x1500.jpg')
    expect(picture.srcSet.split(', ').map((one) => one.split(' ')[1])).toEqual(['120w', '240w', '360w', '480w', '720w'])
    // An add-on Sanity has and the Worker does not sell is not offered.
    expect(addOns.some((addOn) => addOn.id === 'addon-tea')).toBe(false)
  })

  it('the frame stands without them: add-ons that can\'t be read are none, pictures that can\'t be read are left out', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    readShopAddons.mockResolvedValue(ON_SALE)
    fetched.mockResolvedValue(answers.addons)
    expect((await readBookAddOns()).map((addOn) => [addOn.id, addOn.picture !== null])).toEqual([['addon-towel', true], ['addon-knoll', true], ['addon-robe', false], ['not-in-sanity', false]])
    expect(said).not.toHaveBeenCalled()

    fetched.mockRejectedValue(new Error('Sanity is not reachable'))
    expect((await readBookAddOns()).map((addOn) => [addOn.id, addOn.picture])).toEqual(ON_SALE.map((addOn) => [addOn.sanityId, null]))
    expect(said).toHaveBeenCalledTimes(1)

    fetched.mockResolvedValue(answers.addons)
    readShopAddons.mockRejectedValue(new Error('The database connection is not set up'))
    expect(await readBookAddOns()).toEqual([])
    expect(said).toHaveBeenCalledTimes(2)
  })
})

describe('where the panel gets things from, and where it sends them', () => {
  const web = path.resolve(__dirname, '../..')
  const filesIn = (folder: string): string[] =>
    readdirSync(path.join(web, folder)).flatMap((name) => {
      const file = path.join(folder, name)
      return statSync(path.join(web, file)).isDirectory() ? filesIn(file) : /\.(ts|tsx)$/.test(name) && !/\.(test|stories)\./.test(name) ? [file] : []
    })
  const source = (file: string) => readFileSync(path.join(web, file), 'utf8')

  it('no page, component or rule of the panel uses server code: lib/shop/read.ts is still the one file that does', () => {
    const users = ['app/book', 'components/book', 'lib/book'].flatMap(filesIn).filter((file) => /['"](@\/server|(\.\.\/)+server)[/'"]/.test(source(file)))
    expect(users).toEqual([])
    expect(source('lib/shop/read.ts')).toContain("import { readShopAddons, type ShopAddon } from '@/server/rules/shop/booking'")
    expect(source('lib/book/read.ts')).toContain("import { readShopAddonsKept, type ShopAddon } from '@/lib/shop/read'")
  })

  it('the one sum is in lib/book/book.ts: no component works a figure out', () => {
    // The stories' samples (sample-book.ts) are not the site.
    for (const file of [...filesIn('components/book'), ...filesIn('app/book'), 'components/frame/FramePanelsHost.tsx'].filter((one) => !path.basename(one).startsWith('sample-'))) {
      expect(source(file), file).not.toMatch(/toFixed|parseFloat|inPence|penceAsPounds/)
    }
    expect(filesIn('lib/book').filter((file) => /inPence/.test(source(file)))).toEqual(['lib/book/book.ts'])
  })

  it('the days, sessions and prices are asked of the three public routes, never cached; Add to bag, Book now and Log in go to their one seam each', () => {
    expect(source('lib/book/api.ts')).toContain("fetch(address, { cache: 'no-store', ...(signal ? { signal } : {}) })")
    const panel = source('components/book/BookPanel.tsx')
    expect(panel).toContain("import { addToBag, type BookingLine } from '@/lib/shop/bag'")
    expect(panel).toMatch(/onAddToBag=\{toBag\}[\s\S]*onBookNow=\{toBag\}/)
    expect(panel.match(/addToBag\(/g)).toHaveLength(1)
    const sessions = source('components/book/BookSessions.tsx')
    expect(sessions).toContain("import { signIn } from '@/lib/frame/sign-in'")
    expect(sessions).toContain('<SecondaryButton onClick={() => signIn()}>Log in</SecondaryButton>')
  })

  it('opening adds a history step for the same address, closing goes back from it, and at /book closing changes the address to / (WQ64)', () => {
    const host = source('components/frame/FramePanelsHost.tsx')
    expect(host).toContain("window.history.pushState({ [BOOK_STEP]: true }, '')")
    expect(host).toContain('if (onBookStep()) window.history.back()')
    expect(host).toContain("else if (window.location.pathname === BOOK_ADDRESS) window.history.replaceState(null, '', '/')")
    expect(host).toContain("window.addEventListener('popstate', changed)")
    expect(host).toContain('const bookOpen = stepOpen || atBook')
    // The frame puts it round everything, with the add-ons read beside the frame's own content.
    expect(source('components/frame/FrameShell.tsx')).toMatch(/<FramePanelsHost bookAddOns=\{bookAddOns\}>[\s\S]*<\/FramePanelsHost>/)
    expect(source('components/frame/Frame.tsx')).toContain('const [content, bookAddOns] = await Promise.all([readFrame(), readBookAddOns()])')
  })
})
