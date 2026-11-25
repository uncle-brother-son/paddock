import type { InfoTab } from '@/components/shop/ProductInfoPanel'
import { RichText } from '@/components/ui/RichText'
import type { EventView } from '@/lib/events/event'

/**
 * Event Terms & Conditions (WQ17): Events settings' terms summary, the same on every event, and after it the event's
 * own extra waiver when it has one (plain text an editor typed, a paragraph for each blank line between).
 */
function EventTerms({ terms, extraWaiver }: Pick<EventView, 'terms' | 'extraWaiver'>) {
  const waiver = extraWaiver?.split(/\n\s*\n/).filter((paragraph) => paragraph.trim()) ?? []
  return (
    <div className="flex flex-col gap-32">
      {terms.length > 0 ? <RichText blocks={terms} spacing="panel" /> : null}
      {waiver.map((paragraph, index) => (
        <p key={index} className="text-copy-14 whitespace-pre-line">
          {paragraph.trim()}
        </p>
      ))}
    </div>
  )
}

/**
 * The info panel's tabs for an event, in order, as Figma's PIC lists their links (Type=event): Description (the
 * event's rich text) and Event Terms & Conditions. A tab with nothing to say is left out, and its link with it. Drawn
 * on the server, so every tab's words are in the page.
 */
export function eventInfoTabs(view: Pick<EventView, 'description' | 'terms' | 'extraWaiver'>): InfoTab[] {
  const tabs: InfoTab[] = []
  if (view.description.length > 0) tabs.push({ id: 'description', label: 'Description', content: <RichText blocks={view.description} spacing="panel" /> })
  if (view.terms.length > 0 || view.extraWaiver) tabs.push({ id: 'terms', label: 'Event Terms & Conditions', content: <EventTerms terms={view.terms} extraWaiver={view.extraWaiver} /> })
  return tabs
}
