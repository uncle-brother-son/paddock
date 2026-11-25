'use client'

import { useEffect, useState } from 'react'

import { InfoPanelLink } from '@/components/shop/InfoPanelLink'
import { ProductInfoPanel, type InfoTab } from '@/components/shop/ProductInfoPanel'
import { BigButton } from '@/components/ui/Button'
import { QuantityStepper } from '@/components/ui/QuantityStepper'
import type { ShopEventAvailabilityRouteOutput } from '@/contracts/shop'
import { readEventAvailability } from '@/lib/events/availability'
import { eventLive, type EventPrice, type EventView } from '@/lib/events/event'
import { EVENT_CANCELLED, spacesLine } from '@/lib/events/format'
import { signIn } from '@/lib/frame/sign-in'
import { addToBag } from '@/lib/shop/bag'

/** CTA's price line (Type=event): the public price and "(Member from £X)", or for a members-only event its member price and "Member Only". */
function Price({ price }: { price: EventPrice }) {
  if (price.now === null) return null
  return (
    <p className="flex flex-wrap items-baseline gap-8">
      <span className="text-copy-14 text-text-primary">{price.now}</span>
      {price.memberOnly ? <span className="text-copy-14 text-text-primary">Member Only</span> : null}
      {price.member !== null ? <span className="text-copy-14 text-text-muted-primary">(Member from {price.member})</span> : null}
    </p>
  )
}

type EventBuyProps = {
  event: Pick<EventView, 'id' | 'name' | 'when' | 'startsAt' | 'live'>
  /** The info panel's tabs, in order: Description, Event Terms & Conditions. */
  tabs: InfoTab[]
  /**
   * The event's spaces, state and prices now, asked once the page has loaded (lib/events/availability.ts). Storybook
   * and tests give their own, or null to ask nothing.
   */
  readLive?: ((event: string) => Promise<ShopEventAvailabilityRouteOutput | null>) | null
  /** Where the details sit on the page: their columns of the grid, and that they stick. */
  className?: string
}

/**
 * The details beside an event's gallery (Figma "PIC", Type=event: desktop 1389:40291's 1402:49329, mobile on
 * 1684:42028, holding "CTA", Type=event, 1684:39401): the name in H2, the price line, the date and time in UK time,
 * the button with what goes with it, and the links that open the info panel.
 *
 * CTA's states, from the Worker's own state for a visitor who isn't signed in (WQ59):
 * - open, "non-member" (1684:41515): the quantity stepper, from 1 to the spaces left (WQ61), "Add to bag", and
 *   "6 spaces left" beneath. A press goes to the one `addToBag()` seam with the event and how many;
 * - members only, and members first before it opens to everyone, "member only signed out" (1709:48988): the member
 *   price with "Member Only", "Sign in" (the one `signIn()` seam, which opens nothing yet) and the spaces left;
 * - full, "sold out" (1684:41643): the button disabled, reading "Sold out", and no spaces line;
 * - started, or cancelled, "closed" (1684:41716): the button disabled, reading "Closed". A cancelled event says so
 *   under it.
 * The member's own states wait for accounts.
 *
 * What it is sent with may be up to a minute old, so once it has loaded it asks the event's route and shows what that
 * says; a quantity above the spaces now left comes down to them.
 */
export function EventBuy({ event, tabs, readLive = readEventAvailability, className }: EventBuyProps) {
  const [live, setLive] = useState(event.live)
  const [quantity, setQuantity] = useState(1)
  const [panel, setPanel] = useState<{ open: boolean; tab: string }>({ open: false, tab: tabs[0]?.id ?? '' })

  useEffect(() => {
    if (!readLive) return
    const stop = new AbortController()
    readLive(event.id).then((now) => {
      if (now && !stop.signal.aborted) setLive(eventLive(now))
    })
    return () => stop.abort()
  }, [event.id, readLive])

  const { state, spacesLeft, price } = live
  const open = state === 'open'
  const membersOnly = state === 'members_only' || state === 'not_released_yet'
  // Never more than are left, whatever was chosen before the spaces were asked again.
  const chosen = Math.max(1, Math.min(quantity, spacesLeft))
  const line = open || membersOnly ? spacesLine(spacesLeft) : state === 'cancelled' ? EVENT_CANCELLED : null

  return (
    <>
      <div data-event="details" className={`flex flex-col gap-64 pt-24 pb-120 md:pt-240 md:pb-80 ${className ?? ''}`}>
        <div className="flex flex-col gap-32">
          <div className="flex flex-col gap-24">
            <h1 className="text-h2 text-text-primary">{event.name}</h1>
            <div aria-live="polite">
              <Price price={price} />
            </div>
            <p className="text-copy-14 text-text-primary">
              <time dateTime={event.startsAt}>{event.when}</time>
            </p>
          </div>

          <div className="flex flex-col">
            <div className="flex items-stretch gap-4">
              {open ? (
                <>
                  <QuantityStepper value={chosen} max={spacesLeft} onChange={setQuantity} label="Number of places" />
                  <BigButton className="min-w-0 flex-1" onClick={() => addToBag({ event: event.id, quantity: chosen })}>
                    Add to bag
                  </BigButton>
                </>
              ) : membersOnly ? (
                <BigButton onClick={() => signIn()}>Sign in</BigButton>
              ) : (
                <BigButton disabled>{state === 'sold_out' ? 'Sold out' : 'Closed'}</BigButton>
              )}
            </div>
            {/* Always there, so a change after load is said to a screen reader; the line brings its own 8px, so with none it takes no room. */}
            <div aria-live="polite">{line ? <p className="mt-8 text-copy-12 text-text-muted-primary">{line}</p> : null}</div>
          </div>
        </div>

        {tabs.length > 0 ? (
          <ul className="flex flex-col items-start gap-16">
            {tabs.map((tab) => (
              <li key={tab.id}>
                <InfoPanelLink onClick={() => setPanel({ open: true, tab: tab.id })}>{tab.label}</InfoPanelLink>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {/* Beside the details, not inside them: they stick as the gallery scrolls past, and what sticks is a layer of its own, which would hold the panel beneath the header. */}
      {tabs.length > 0 ? (
        <ProductInfoPanel
          open={panel.open}
          tabs={tabs}
          tab={panel.tab}
          onTab={(tab) => setPanel({ open: true, tab })}
          onClose={() => setPanel((now) => ({ ...now, open: false }))}
          label="Event information"
        />
      ) : null}
    </>
  )
}
