import type { GiftCardFormat, GiftCardView } from '@/lib/shop/gift-card'

import { GiftCardDetail } from './GiftCardDetail'
import { giftCardInfoTabs } from './GiftCardInfoTabs'

type GiftCardPageViewProps = {
  view: GiftCardView
  /** The format the address asked for: Digital unless it says ?format=physical. */
  format: GiftCardFormat
  /** For Storybook and tests only: where a switch's address goes. The site puts it in the address bar. */
  showAddress?: (address: string) => void
  /** For Storybook and tests: reduced motion on or off, whatever the visitor's own setting. */
  reducedMotion?: boolean
}

/**
 * The Gift Card page (Figma "Gift card digital", 1684:41964, "Gift card physical", 1684:41977, and their mobile
 * frames, 1684:42032 and 1684:42044), laid out as a product's is.
 * - From 768px: the gallery fills the window's left half, from its edge to the end of the grid's 12th column, its
 *   pictures and videos stacked (the same media blocks as a product's gallery: WQ43); the details are columns 15 to
 *   21, and stay in view (they stick to the window's top) while the gallery scrolls past.
 * - Below: the gallery is the window's whole width, a row to swipe, with the details beneath it.
 * No row follows it: the frames draw none. The info panel is the details' own (components/shop/GiftCardBuy.tsx).
 */
export function GiftCardPageView({ view, format, showAddress, reducedMotion }: GiftCardPageViewProps) {
  // Only what the gallery and the details draw goes to the browser with them: the tabs' words are drawn here, on the server.
  const { id, name, galleries, amounts, other } = view
  return (
    <GiftCardDetail
      giftCard={{ id, name, galleries, amounts, other }}
      format={format}
      tabs={giftCardInfoTabs(view)}
      {...(showAddress === undefined ? {} : { showAddress })}
      {...(reducedMotion === undefined ? {} : { reducedMotion })}
    />
  )
}
