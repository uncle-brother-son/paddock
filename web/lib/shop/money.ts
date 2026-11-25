// W74: money on the shop's pages. The Worker gives every price as the database's own text ("45.00", "40.50"); nothing
// here works a price out. This only writes one the way the designs do, and compares two for the Shop's price sorts.

/** A price as the designs write it: "£45" for whole pounds, "£40.50" otherwise. */
export function pounds(money: string): string {
  const [whole = '0', pence = ''] = money.trim().split('.')
  const pennies = pence.padEnd(2, '0').slice(0, 2)
  return pennies === '00' ? `£${whole}` : `£${whole}.${pennies}`
}

/** W77: a price with its pence always written, as the Book panel's "Your booking" does: "£15.00", "£4.50". */
export function poundsAndPence(money: string): string {
  const [whole = '0', pence = ''] = money.trim().split('.')
  return `£${whole}.${pence.padEnd(2, '0').slice(0, 2)}`
}

/** A price as whole pence, to sort by: as text "100.00" would come before "28.00". */
export const inPence = (money: string): number => Math.round(Number(money) * 100)
