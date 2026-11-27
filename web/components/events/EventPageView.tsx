import { ProductInfoContainer } from '@/components/components/shop/ProductInfoContainer'
import { Grid } from '@/components/layout/Grid'
import { UpSellRow } from '@/components/modules/shop/UpSellRow'
import { ProductGallery } from '@/components/shop/ProductGallery'
import type { ShopEventAvailabilityRouteOutput } from '@/contracts/shop'
import type { EventCardView, EventView } from '@/lib/events/event'

import { eventInfoTabs } from './EventInfoTabs'

type EventPageViewProps = {
  view: EventView
  /** The Other events row; empty hides it. */
  others: EventCardView[]
  /** Where "All Events" goes; null hides the link. */
  listAddress: string | null
  /** For Storybook and tests only: where the spaces are asked again after load, or null to ask nothing. The site asks its own route. */
  readLive?: ((event: string) => Promise<ShopEventAvailabilityRouteOutput | null>) | null
  /** For Storybook and tests: reduced motion on or off, whatever the visitor's own setting. */
  reducedMotion?: boolean
}

/**
 * An event's page (Figma "Event", 1684:41950, and "Event (mobile)", 1684:42018), laid out as a product's is.
 * - From 768px: the gallery fills the window's left half, from its edge to the end of the grid's 12th column, its
 *   pictures and videos stacked (the same media blocks as a product's gallery: WQ43); the details are columns 15 to
 *   21, and stay in view (they stick to the window's top) while the gallery scrolls past (taller than the window:
 *   WQ73, components/layout/StickyColumn.tsx).
 * - Below: the gallery is the window's whole width, a row to swipe, with the details beneath it.
 * Then Other events. The info panel is the details' own (components/components/shop/CallToAction.tsx).
 */
export function EventPageView({ view, others, listAddress, readLive, reducedMotion }: EventPageViewProps) {
  // Only what the details draw goes to the browser with them: the tabs' words are drawn here, on the server.
  const { id, name, when, startsAt, live } = view
  return (
    <>
      <Grid as="section" data-event="page" className="items-start">
        <div className="col-span-full -mx-16 md:col-span-12 md:mr-0">
          <ProductGallery items={view.gallery} label="Event pictures" {...(reducedMotion === undefined ? {} : { reducedMotion })} />
        </div>
        <ProductInfoContainer
          type="event"
          event={{ id, name, when, startsAt, live }}
          tabs={eventInfoTabs(view)}
          className="col-span-full md:col-span-7 md:col-start-15"
          {...(readLive === undefined ? {} : { readLive })}
        />
      </Grid>
      <UpSellRow type="events" cards={others} allHref={listAddress} />
    </>
  )
}
