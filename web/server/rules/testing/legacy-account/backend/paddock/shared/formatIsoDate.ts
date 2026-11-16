/**
 * Date wording for backend messages staff read: "28 Nov 2026". Works on the YYYY-MM-DD digits
 * themselves (no Date parsing, so no timezone can shift the day). No SQL here.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2026-11-28" → "28 Nov 2026"; anything that isn't a YYYY-MM-DD date comes back unchanged. */
export function formatIsoDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.slice(0, 10))
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined
  if (!match || !month) return isoDate
  return `${Number(match[3])} ${month} ${match[1]}`
}

/** Rewrites every YYYY-MM-DD date in a message (e.g. the Worker's own error text) the same way. */
export function formatIsoDatesIn(text: string): string {
  return text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (d) => formatIsoDate(d))
}
