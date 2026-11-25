import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { reads } from '@/lib/sanity/read'
import answers from '@/lib/sanity/sample-answers.json'
import type { ShopEvent } from '@/lib/shop/read'

// Brief W75, item 5: what /events/[slug] answers, and what the events list shows. An event's page shows when it is
// published in Sanity and in the Worker's read by its id (on sale; a started and a cancelled one too, WQ59); an old
// slug is a permanent redirect (W72a), anything else a 404. Sanity is stood in for by the samples its own engine made
// (lib/sanity/sample-answers.json: the Solstice event, Events settings, the page that holds the list), the Worker's
// reads by events made here.

const fetched = vi.hoisted(() => vi.fn())
const readShopEvents = vi.hoisted(() => vi.fn())
const readShopEvent = vi.hoisted(() => vi.fn())
vi.mock('@sanity/client', () => ({ createClient: () => ({ fetch: fetched }) }))
// Outside a request there is nothing to wait for.
vi.mock('next/server', () => ({ connection: async () => undefined }))
// React's `cache` shares a read inside one request; here every call is its own.
vi.mock('react', async (original) => ({ ...(await original<typeof import('react')>()), cache: <T>(read: T) => read }))
// Next's data cache: here it keeps nothing.
vi.mock('next/cache', () => ({ unstable_cache: <T>(read: T): T => read }))
vi.mock('@/server/rules/shop/reads', () => ({ readShop: vi.fn() }))
vi.mock('@/server/rules/shop/events', () => ({ readShopEvents, readShopEvent }))

const { findEventPage, readEventsListAddress, readUpcomingEventCards } = await import('./pages')

const onSale = (over: Partial<ShopEvent> = {}): ShopEvent => ({
  sanityId: 'event-1',
  startsAt: '2026-12-21T19:30:00+00:00',
  endsAt: null,
  spacesLeft: 6,
  access: 'public',
  publicReleaseAt: null,
  state: 'open',
  price: '25.00',
  memberPrice: '20.00',
  ...over,
})

/** Sanity, answering by the query it is sent. */
const sanity = ({ events = {}, moved = {}, listPage = answers.eventsListPage }: { events?: Record<string, unknown>; moved?: Record<string, { slug: string; isHome: boolean }>; listPage?: unknown } = {}) => {
  fetched.mockImplementation(async (query: string, params: { slug?: string; type?: string }) => {
    if (query === reads.movedSlug.query) return moved[`${params.type} ${params.slug}`] ?? null
    if (query === reads.event.query) return events[params.slug ?? ''] ?? null
    if (query === reads.eventCards.query) return answers.eventCards
    if (query === reads.eventsSettings.query) return answers.eventsSettings
    if (query === reads.eventsListPage.query) return listPage
    throw new Error(`A read the events' pages should not make: ${query.slice(0, 60)}`)
  })
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SANITY_PROJECT_ID', 'project')
  vi.stubEnv('NEXT_PUBLIC_SANITY_DATASET', 'production')
  readShopEvents.mockResolvedValue([onSale()])
  readShopEvent.mockResolvedValue(onSale())
})
afterEach(() => {
  vi.unstubAllEnvs()
  fetched.mockReset()
  readShopEvents.mockReset()
  readShopEvent.mockReset()
})

describe('an event, at /events/[slug]', () => {
  it("published in Sanity and on sale: its page, with the Worker's date, spaces, state and prices", async () => {
    sanity({ events: { 'solstice-2026': answers.event } })
    const { page, movedTo } = await findEventPage('solstice-2026')
    expect(movedTo).toBeNull()
    expect(readShopEvent).toHaveBeenCalledWith('event-1')
    expect([page?.event.slug, page?.view.id, page?.view.name]).toEqual(['solstice-2026', 'event-1', 'Solstice'])
    expect([page?.view.when, page?.view.startsAt]).toEqual(['19:30 Monday 21 December 2026', '2026-12-21T19:30:00+00:00'])
    expect(page?.view.live).toEqual({ state: 'open', spacesLeft: 6, price: { now: '£25', member: '£20', memberOnly: false } })
    expect(page?.view.gallery).toHaveLength(answers.event.gallery.length)
    // Its two tabs' words: its own description, and Events settings' terms summary with its own extra waiver.
    expect(page?.view.description).toEqual(answers.event.description)
    expect(page?.view.terms).toEqual(answers.eventsSettings.termsSummary)
    expect(page?.view.extraWaiver).toBe(answers.event.extraWaiver?.trim() || null)
    expect(page?.listAddress).toBe('/exclusive-hire#events')
  })

  it.each(['started', 'cancelled', 'sold_out', 'members_only', 'not_released_yet'] as const)('one that is %s still has its page, in that state (WQ59)', async (state) => {
    sanity({ events: { 'solstice-2026': answers.event } })
    readShopEvent.mockResolvedValue(onSale({ state, spacesLeft: state === 'sold_out' ? 0 : 6 }))
    // A started or cancelled event has left the Worker's list: it is still found by its id.
    readShopEvents.mockResolvedValue([])
    const { page } = await findEventPage('solstice-2026')
    expect(page?.view.live.state).toBe(state)
    expect(page?.others).toEqual([])
  })

  it('published in Sanity but not in the Worker\'s read (off sale, or never on): nothing (a 404)', async () => {
    sanity({ events: { 'solstice-2026': answers.event } })
    readShopEvent.mockResolvedValue(null)
    expect(await findEventPage('solstice-2026')).toEqual({ page: null, movedTo: null })
  })

  it('a slug the event had before: where it is now (a 308), and the database is not asked', async () => {
    sanity({ moved: { 'event solstice': { slug: 'solstice-2026', isHome: false } } })
    expect(await findEventPage('solstice')).toEqual({ page: null, movedTo: '/events/solstice-2026' })
    expect(readShopEvent).not.toHaveBeenCalled()
    expect(readShopEvents).not.toHaveBeenCalled()
  })

  it("a slug no event has or had: nothing (a 404); a product's old slug leads to no event", async () => {
    sanity({ moved: { 'product solstice': { slug: 'solstice-tee', isHome: false } } })
    expect(await findEventPage('no-such-event')).toEqual({ page: null, movedTo: null })
    expect(await findEventPage('solstice')).toEqual({ page: null, movedTo: null })
    expect(readShopEvent).not.toHaveBeenCalled()
  })

  it('an event that could not be read is an error, never a "not found"', async () => {
    sanity({ events: { 'solstice-2026': answers.event } })
    readShopEvent.mockRejectedValue(new Error('The database connection is not set up'))
    await expect(findEventPage('solstice-2026')).rejects.toThrow('The database connection is not set up')
  })

  it('Other events: the next upcoming ones, never the page\'s own', async () => {
    sanity({ events: { 'solstice-2026': answers.event } })
    // The sample has one event in Sanity: it is the page's own, so the row is empty though the Worker lists it.
    expect((await findEventPage('solstice-2026')).page?.others).toEqual([])
  })

  it('"All Events" has nowhere to go until a page holds the events list', async () => {
    sanity({ events: { 'solstice-2026': answers.event }, listPage: null })
    expect((await findEventPage('solstice-2026')).page?.listAddress).toBeNull()
    expect(await readEventsListAddress()).toBeNull()
  })
})

describe('the events list (the Upcoming Events module)', () => {
  it("is the Worker's upcoming events that Sanity publishes, soonest first, a sold-out one among them", async () => {
    sanity()
    readShopEvents.mockResolvedValue([onSale({ sanityId: 'not-in-sanity', startsAt: '2026-11-01T10:00:00+00:00' }), onSale({ spacesLeft: 0, state: 'sold_out' })])
    expect((await readUpcomingEventCards()).map((card) => [card.id, card.href, card.when, card.spaces])).toEqual([['event-1', '/events/solstice-2026', '19:30 — 21st Dec 2026', 'Sold out']])
  })

  it('no upcoming event: an empty list, which draws nothing', async () => {
    sanity()
    readShopEvents.mockResolvedValue([])
    expect(await readUpcomingEventCards()).toEqual([])
  })

  it('a list that could not be read is an error, never an empty list', async () => {
    sanity()
    readShopEvents.mockRejectedValue(new Error('The database connection is not set up'))
    await expect(readUpcomingEventCards()).rejects.toThrow('The database connection is not set up')
  })

  it('its page is found in Sanity by the module it holds: the address is made from that page\'s slug', async () => {
    sanity()
    expect(answers.eventsListPage).toEqual({ slug: 'exclusive-hire', isHome: false })
    expect(await readEventsListAddress()).toBe('/exclusive-hire#events')
    expect(reads.eventsListPage.query).toContain('count(modules[_type == "upcomingEvents"]) > 0')
  })

  it('the module is drawn by PageModules, and the page\'s first carries the id "events"', () => {
    const modules = readFileSync(path.resolve(__dirname, '../../components/modules/PageModules.tsx'), 'utf8')
    expect(modules).toContain("<UpcomingEvents key={one.key} heading={one.events.heading} {...(index === firstEvents ? { id: EVENTS_LIST_ID } : {})} />")
    expect(modules).toContain("const firstEvents = shown.findIndex((one) => 'events' in one)")
  })
})

describe('where the events\' figures come from', () => {
  const web = path.resolve(__dirname, '../..')
  const filesIn = (folder: string): string[] =>
    readdirSync(path.join(web, folder)).flatMap((name) => {
      const file = path.join(folder, name)
      return statSync(path.join(web, file)).isDirectory() ? filesIn(file) : /\.(ts|tsx)$/.test(name) && !/\.(test|stories)\./.test(name) ? [file] : []
    })
  const source = (file: string) => readFileSync(path.join(web, file), 'utf8')

  it('no page, component or rule of the events uses server code: lib/shop/read.ts is still the one file that does', () => {
    const users = ['app/events', 'components/events', 'components/modules', 'lib/events'].flatMap(filesIn).filter((file) => /['"](@\/server|(\.\.\/)+server)[/'"]/.test(source(file)))
    expect(users).toEqual([])
    expect(source('lib/shop/read.ts')).toContain("import { readShopEvent, readShopEvents, type ShopEvent } from '@/server/rules/shop/events'")
  })

  it('and no page or component writes a price by arithmetic: every figure shown is one of W75a\'s, through pounds()', () => {
    // The stories' sample events (sample-events.ts) are not the site.
    for (const file of [...filesIn('components/events'), ...filesIn('app/events')].filter((one) => !path.basename(one).startsWith('sample-'))) {
      expect(source(file), file).not.toMatch(/toFixed|parseFloat|Number\(|inPence/)
    }
  })

  it('the page asks the public route again after load, and goes to the bag and to sign-in through their one seam each', () => {
    const buy = source('components/events/EventBuy.tsx')
    expect(buy).toContain('export function EventBuy({ event, tabs, readLive = readEventAvailability, className }: EventBuyProps) {')
    expect(buy).toContain('addToBag({ event: event.id, quantity: chosen })')
    expect(buy).toContain('<BigButton onClick={() => signIn()}>Sign in</BigButton>')
    // The stepper never goes above the spaces left (WQ61).
    expect(buy).toContain('<QuantityStepper value={chosen} max={spacesLeft} onChange={setQuantity} label="Number of places" />')
    expect(buy).toContain('const chosen = Math.max(1, Math.min(quantity, spacesLeft))')
  })
})
