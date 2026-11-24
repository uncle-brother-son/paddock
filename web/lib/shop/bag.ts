// W74: the one place the shop's pages meet the bag. The bag is built in the buying stage (WQ5), so adding to it does
// nothing yet and says so, as useFramePanels does for the panels: a size in a card's strip and the Product page's
// "Add to bag" both come here, and nothing in either changes when the bag exists.

/** What is added: a product (its Sanity document id) in one size. `size` is null for a product with no sizes. */
export type BagLine = { product: string; size: string | null }

/** Adds a line to the bag. True when it was added; false while there is no bag to add it to. */
export function addToBag(line: BagLine): boolean {
  void line
  return false
}
