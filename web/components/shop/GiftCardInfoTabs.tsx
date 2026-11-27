import { RichText } from '@/components/ui/RichText'
import type { GiftCardView } from '@/lib/shop/gift-card'

import type { InfoTab } from '@/components/modules/shop/ProductInfoPanel'

/**
 * The info panel's tabs for the gift card, in order, as Figma's ProductInfoContainer lists their links (Type=gift card): Description
 * (the gift card's rich text), Gift Card Terms & Conditions (Sanity's terms, {validity} already filled: "6 months")
 * and Shipping & returns (Shop settings' summary, the same on every product). A tab with nothing to say is left out,
 * and its link with it. Drawn on the server, so every tab's words are in the page.
 */
export function giftCardInfoTabs(view: Pick<GiftCardView, 'description' | 'terms' | 'shipping'>): InfoTab[] {
  const tabs: InfoTab[] = []
  if (view.description.length > 0) tabs.push({ id: 'description', label: 'Description', content: <RichText blocks={view.description} spacing="panel" /> })
  if (view.terms.length > 0) tabs.push({ id: 'terms', label: 'Gift Card Terms & Conditions', content: <RichText blocks={view.terms} spacing="panel" /> })
  if (view.shipping.length > 0) tabs.push({ id: 'shipping', label: 'Shipping & returns', content: <RichText blocks={view.shipping} spacing="panel" /> })
  return tabs
}
