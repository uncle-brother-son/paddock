import { looksLikeEmail } from '@/lib/frame/newsletter'
import { GIFT_CARD_ADDRESS } from '@/lib/sanity/links'
import type { GiftCard, RichText, ShopSettings } from '@/lib/sanity/schemas'

import { checkOtherAmount, type OtherAmountLimits } from './gift-card-amount'
import { pounds } from './money'
import { galleryItems, type GalleryItem } from './product'
import type { ShopGiftCardPage } from './read'

// W76: what the Gift Card page shows (Figma 1684:41964, 1684:41977 and their mobile frames), made from Sanity's gift
// card (name, words, the two galleries) and the Worker's (W76a: the amounts on sale, the Other limits, how long a card
// lasts). Nothing here reads either, and no amount is worked out: a preset is one W76a's read gave, and an Other
// amount is what W76a's one rule answers (lib/shop/gift-card-amount.ts).

/** How a gift card is sent (WQ19): by email, or a card to post or collect. Digital comes first, as drawn. */
export const GIFT_CARD_FORMATS = ['digital', 'physical'] as const
export type GiftCardFormat = (typeof GIFT_CARD_FORMATS)[number]

/** The words on the switch (Figma "Toggle", 597:5432, on the page as Digital and Physical). */
export const FORMAT_LABELS: Record<GiftCardFormat, string> = { digital: 'Digital', physical: 'Physical' }

/** The line under the button, as drawn for each. */
export const FORMAT_LINES: Record<GiftCardFormat, string> = {
  digital: 'Your gift card will be sent by email',
  physical: 'Delivery or collection from the Paddock.',
}

/** What the address carries the format under: ?format=physical. */
export const FORMAT_PARAM = 'format'

/** The format an address asks for (?format=physical). Anything else, or nothing, is Digital: never an error. */
export function giftCardFormat(value: string | string[] | null | undefined): GiftCardFormat {
  return value === 'physical' ? 'physical' : 'digital'
}

/** The page's address with a format chosen, so either can be shared: Digital is the page's own address. */
export const giftCardAddress = (format: GiftCardFormat): string => (format === 'physical' ? `${GIFT_CARD_ADDRESS}?${FORMAT_PARAM}=physical` : GIFT_CARD_ADDRESS)

/** One preset on its chip: the Worker's money text ("15.00"), and as the designs write it ("£15"). */
export type GiftCardAmount = { amount: string; label: string }

export type GiftCardView = {
  /** The Sanity document's id: what the bag is told. */
  id: string
  name: string
  /** The Digital and the Physical card's own pictures and videos, swapped by the switch. */
  galleries: Record<GiftCardFormat, GalleryItem[]>
  /** The presets on sale, lowest first. */
  amounts: GiftCardAmount[]
  /** The Other amounts it takes (WQ63); null when Other isn't allowed, and there is then no Other chip. */
  other: OtherAmountLimits | null
  description: RichText
  /** Sanity's terms with {validity} filled from the staff app's setting ("6 months"). */
  terms: RichText
  /** Shop settings' Shipping & Returns summary, the same on every product. */
  shipping: RichText
}

/** How long a card lasts, as the terms say it: "6 months", "1 month". */
export const validityWords = (months: number): string => (months === 1 ? '1 month' : `${months} months`)

/** What an editor types where the validity goes (the Studio's hint on the terms field). */
export const VALIDITY_PLACEHOLDER = '{validity}'

/** The terms with every {validity} filled. The words are otherwise the editor's own. */
export function filledTerms(terms: RichText, months: number): RichText {
  const validity = validityWords(months)
  return terms.map((block) => ({ ...block, children: block.children.map((span) => ({ ...span, text: span.text.replaceAll(VALIDITY_PLACEHOLDER, validity) })) }))
}

type GiftCardContent = { giftCard: GiftCard; onSale: ShopGiftCardPage; settings: ShopSettings | null }

export function giftCardView({ giftCard, onSale, settings }: GiftCardContent): GiftCardView {
  return {
    id: giftCard.id,
    name: giftCard.name,
    galleries: { digital: galleryItems(giftCard.digitalGallery), physical: galleryItems(giftCard.physicalGallery) },
    amounts: onSale.amounts.map((amount) => ({ amount, label: pounds(amount) })),
    other: onSale.other,
    description: giftCard.description,
    terms: filledTerms(giftCard.terms, onSale.expiryMonths),
    shipping: settings?.shippingReturnsSummary ?? [],
  }
}

/** What is chosen of the amounts: a preset, or Other with what has been typed in its field; null with nothing to choose. */
export type AmountChoice = { kind: 'preset'; amount: string } | { kind: 'other'; typed: string } | null

/**
 * What the page opens on, as drawn (AmountField, State=default, and both page frames): the lowest preset, chosen.
 * A type with no presets opens on Other, its field ready; one with neither has nothing to choose.
 */
export function firstChoice(view: Pick<GiftCardView, 'amounts' | 'other'>): AmountChoice {
  const lowest = view.amounts[0]
  if (lowest) return { kind: 'preset', amount: lowest.amount }
  return view.other ? { kind: 'other', typed: '' } : null
}

/** The amount field's prompt, as drawn, and what it says when Add to bag is pressed with nothing typed. */
export const OTHER_PROMPT = 'Enter an amount'

/** The amount a choice comes to, or why it comes to none. */
export type AmountAnswer = {
  /** Money text ("25.00"); null while there is none to add. */
  amount: string | null
  /** The words under the amount field (W76a's, for something typed that the rule refuses); null with nothing wrong. */
  wrong: string | null
  /** Nothing is typed yet: said only once Add to bag is pressed. */
  empty: boolean
}

/**
 * A choice as an amount. A preset is its own amount. Other is W76a's rule on what is typed (WQ63: whole pounds,
 * within the limits), asked as the customer types; an empty field is not wrong until Add to bag is pressed.
 */
export function amountOf(choice: AmountChoice, other: OtherAmountLimits | null): AmountAnswer {
  if (choice === null) return { amount: null, wrong: null, empty: false }
  if (choice.kind === 'preset') return { amount: choice.amount, wrong: null, empty: false }
  if (choice.typed.trim() === '' || other === null) return { amount: null, wrong: null, empty: true }
  const answer = checkOtherAmount(choice.typed, other)
  return answer.ok ? { amount: answer.amount, wrong: null, empty: false } : { amount: null, wrong: answer.message, empty: false }
}

/**
 * The price line under the name: the chosen amount, and until there is one the lowest on sale, as drawn. None for a
 * type with no presets and no amount typed yet.
 */
export function priceShown(answer: AmountAnswer, amounts: GiftCardAmount[]): string | null {
  if (answer.amount !== null) return pounds(answer.amount)
  return amounts[0]?.label ?? null
}

/** Who a digital card is sent to, when it is a gift (Figma "SendToRecipientToggle", 1389:39585). */
export type Recipient = { name: string; email: string; message: string }

export const NO_RECIPIENT: Recipient = { name: '', email: '', message: '' }

/** The most a gift message holds, as drawn ("150 characters left"). */
export const GIFT_MESSAGE_MOST = 150

/** The counter under the gift message. */
export function charactersLeft(message: string): string {
  const left = Math.max(0, GIFT_MESSAGE_MOST - message.length)
  return left === 1 ? '1 character left' : `${left} characters left`
}

/** Field errors: no full stop, as the amount's (W76a). */
export const RECIPIENT_WORDS = {
  name: "Enter the recipient’s name",
  email: "Enter the recipient’s email",
  emailWrong: 'Enter a valid email address',
} as const

/** What is wrong with a gift's recipient: a name and an email address are needed; the message is not. */
export function recipientWrong(recipient: Recipient): { name: string | null; email: string | null } {
  const email = recipient.email.trim()
  return {
    name: recipient.name.trim() === '' ? RECIPIENT_WORDS.name : null,
    email: email === '' ? RECIPIENT_WORDS.email : looksLikeEmail(email) ? null : RECIPIENT_WORDS.emailWrong,
  }
}

/** What the button says under a mouse while something is still missing (WQ51): the first thing to do, or null. */
export function missingLabel({ amount, recipient }: { amount: AmountAnswer; recipient: Recipient | null }): string | null {
  if (amount.amount === null) return 'Enter amount'
  if (recipient) {
    const wrong = recipientWrong(recipient)
    if (wrong.name || wrong.email) return 'Add recipient'
  }
  return null
}
