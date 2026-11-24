import { payment } from './art/payment'
import { BrandSvg } from './BrandSvg'

/** The five marks the site shows (WQ31), each with the name a screen reader reads. */
const PAYMENT_MARKS = {
  visa: { art: payment.visa, label: 'Visa' },
  mastercard: { art: payment.mastercard, label: 'Mastercard' },
  amex: { art: payment.amex, label: 'American Express' },
  'apple-pay': { art: payment['apple-pay'], label: 'Apple Pay' },
  'google-pay': { art: payment['google-pay'], label: 'Google Pay' },
} as const

export type PaymentBrand = keyof typeof PAYMENT_MARKS

export const PAYMENT_BRANDS = Object.keys(PAYMENT_MARKS) as PaymentBrand[]

const isPaymentBrand = (brand: string): brand is PaymentBrand => Object.hasOwn(PAYMENT_MARKS, brand)

/**
 * A payment method's mark in its own brand colours (WQ31): Visa, Mastercard, Amex, Apple Pay or Google Pay. Any
 * other brand (Stripe's `discover`, `diners`, `unionpay`, ...) is the word "Card", with no logo, in the text style
 * of where it sits.
 */
export function PaymentMark({ brand, className }: { brand: string; className?: string }) {
  const key = brand.trim().toLowerCase().replace(/[\s_]+/g, '-')
  if (!isPaymentBrand(key)) return <span className={className}>Card</span>
  const mark = PAYMENT_MARKS[key]
  return <BrandSvg art={mark.art} label={mark.label} className={className ? `shrink-0 ${className}` : 'shrink-0'} />
}
