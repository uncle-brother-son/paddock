// W74: the one place the shop's pages meet the bag. The bag is built in the buying stage (WQ5), so adding to it does
// nothing yet and says so, as useFramePanels does for the panels: a size in a card's strip and the Product page's
// "Add to bag" both come here, and nothing in either changes when the bag exists. W75: an Event page's "Add to bag" too.
// W76: and the Gift Card page's. W77: and the booking panel's "Add to bag" and "Book now". W81: and a Membership card's
// and a Session Pass card's.

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
 * W77: a session booking from the booking panel: the session (W77a's id), how many people from 1 to the most that
 * session allows, and the add-ons chosen, each by its Sanity document id with how many (none: an empty list). No
 * price goes with it: the server prices the basket itself, and asks the online booking rule again (WQ66).
 */
export type BookingLine = { session: string; people: number; addOns: { addOn: string; quantity: number }[] }

/**
 * W81: a membership: the plan chosen on its card (its Sanity document id: Foal - Core) and how it is billed. No
 * price goes with it: the server prices the basket itself.
 */
export type MembershipLine = { membershipPlan: string; billing: 'monthly' | 'yearly' }

/** W81: a session pass: the pass chosen on its card (its Sanity document id: 5 Session - Core). No price goes with it. */
export type SessionPassLine = { sessionPass: string }

/**
 * What is added: a product (its Sanity document id) in one size, `size` null for a product with no sizes; an event
 * (its Sanity document id) with how many places, from 1 to the spaces left (WQ61); a gift card; a session booking; a
 * membership; or a session pass.
 */
export type BagLine = { product: string; size: string | null } | { event: string; quantity: number } | GiftCardLine | BookingLine | MembershipLine | SessionPassLine

/** Adds a line to the bag. True when it was added; false while there is no bag to add it to. */
export function addToBag(line: BagLine): boolean {
  void line
  return false
}
