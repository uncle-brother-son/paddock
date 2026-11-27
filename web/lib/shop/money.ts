// W74: money on the shop's pages. The Worker gives every price as the database's own text ("45.00", "40.50"); nothing
// here works a price out. This only writes one the way the designs do, and compares two for the Shop's price sorts.

// W83: the site's one money format. Pounds have their thousands marked ("£1,000", "£1,308.50"; "£999" has none), on
// every page: only the text is changed, no number is made of it.
const parts = (money: string): { whole: string; pennies: string } => {
  const [whole = '0', pence = ''] = money.trim().split('.')
  return { whole: whole.replace(/\B(?=(\d{3})+(?!\d))/g, ','), pennies: pence.padEnd(2, '0').slice(0, 2) }
}

/** A price as the designs write it: "£45" for whole pounds, "£40.50" otherwise, "£1,308" past a thousand. */
export function pounds(money: string): string {
  const { whole, pennies } = parts(money)
  return pennies === '00' ? `£${whole}` : `£${whole}.${pennies}`
}

/** W77: a price with its pence always written, as the booking panel's "Your booking" does: "£15.00", "£4.50", "£1,660.50". */
export function poundsAndPence(money: string): string {
  const { whole, pennies } = parts(money)
  return `£${whole}.${pennies}`
}

/** A price as whole pence, to sort by: as text "100.00" would come before "28.00". */
export const inPence = (money: string): number => Math.round(Number(money) * 100)
