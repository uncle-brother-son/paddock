// Ported from backend/paddock/shared/generateGiftCardCode.ts (W07).
import 'server-only'

/** The characters a code is made of: no 0, O, 1 or I, which read alike. */
export const GIFT_CARD_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** The app's established format: PWC- and eight of the alphabet. */
export const GIFT_CARD_CODE_FORMAT = /^PWC-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/

/**
 * A new gift card code in the app's format. The old function drew from Math.random; a code is a
 * bearer credential (whoever has it can spend the card), so this draws from the platform's
 * cryptographic generator instead. The alphabet is 32 characters, so a byte modulo 32 is unbiased.
 */
export function generateGiftCardCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  let suffix = ''
  for (const byte of bytes) suffix += GIFT_CARD_CODE_ALPHABET.charAt(byte % GIFT_CARD_CODE_ALPHABET.length)
  return `PWC-${suffix}`
}
