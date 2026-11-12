/** Generates a gift card code in this app's established format (PWC-XXXXXXXX, no ambiguous chars). */
export function generateGiftCardCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let suffix = ''
  for (let i = 0; i < 8; i++) suffix += chars[Math.floor(Math.random() * chars.length)]
  return `PWC-${suffix}`
}
