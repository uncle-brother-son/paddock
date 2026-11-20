/**
 * A real date and time in the form the session dialogs send: YYYY-MM-DDTHH:MM:SS.mmmZ. The same
 * check as frontend/utils/dateInput.ts, copied because the two sides compile separately. Year 0000
 * is out: Postgres has no such year.
 */
export function isValidIsoDateTime(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || value.startsWith('0000')) return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
}
