// New in W74a: the one order a product's sizes are shown in on the website. The database's text order is L, M, S, XL.
import 'server-only'

const NAMED_SIZES: readonly string[] = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL']
const A_NUMBER = /^\d+(\.\d+)?$/

/** Where a size comes: its group (named, then numbers, then anything else), and its place inside the group. */
function placeOf(size: string | null): readonly [group: number, place: number] {
  const text = (size ?? '').trim().toUpperCase()
  const named = NAMED_SIZES.indexOf(text)
  if (named !== -1) return [0, named]
  if (A_NUMBER.test(text)) return [1, Number(text)]
  return [2, 0]
}

/**
 * Sizes in shop order: XXS to XXXL, then numbers ascending, then anything else in the order given. Give them in the
 * order they were created (the customer channel reads them so): the sort keeps that order within a tie, so "One Size"
 * on its own, and sizes with no name of ours, stay as they were made. Letter case and spaces at the ends don't count.
 */
export function inShopOrder<Sized extends { size: string | null }>(sizes: readonly Sized[]): Sized[] {
  return sizes
    .map((sized) => ({ sized, place: placeOf(sized.size) }))
    .sort((a, b) => a.place[0] - b.place[0] || a.place[1] - b.place[1])
    .map(({ sized }) => sized)
}
