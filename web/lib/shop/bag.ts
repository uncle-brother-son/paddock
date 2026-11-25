// W74: the one place the shop's pages meet the bag. The bag is built in the buying stage (WQ5), so adding to it does
// nothing yet and says so, as useFramePanels does for the panels: a size in a card's strip and the Product page's
// "Add to bag" both come here, and nothing in either changes when the bag exists. W75: an Event page's "Add to bag" too.
// W76: and the Gift Card page's.

/**
 * W76: a gift card (its type's Sanity document id): how it is sent, its amount as money text ("25.00": a preset, or
 * an Other amount W76a's rule let through; the server asks that rule again when the basket is built), and for a
 * digital card sent as a gift who it goes to, with the message (which may be empty). `recipient` is null when the
 * card comes to the buyer, and always for a physical one.
 */
export type GiftCardLine = {
  giftCard: string
  format: 'digital' | 'physical'
  amount: string
  recipient: { name: string; email: string; message: string } | null
}

/**
 * What is added: a product (its Sanity document id) in one size, `size` null for a product with no sizes; an event
 * (its Sanity document id) with how many places, from 1 to the spaces left (WQ61); or a gift card.
 */
export type BagLine = { product: string; size: string | null } | { event: string; quantity: number } | GiftCardLine

/** Adds a line to the bag. True when it was added; false while there is no bag to add it to. */
export function addToBag(line: BagLine): boolean {
  void line
  return false
}
