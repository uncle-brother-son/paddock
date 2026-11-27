'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'

import { BigButton } from '@/components/ui/buttons/Button'
import { QuantityStepper } from '@/components/ui/form-controls/QuantityStepper'
import { Toggle } from '@/components/ui/form-controls/Toggle'
import type { ShopAvailabilityRouteOutput, ShopEventAvailabilityRouteOutput } from '@/contracts/shop'
import { readEventAvailability } from '@/lib/events/availability'
import { eventLive, type EventPrice, type EventView } from '@/lib/events/event'
import { EVENT_CANCELLED, spacesLine } from '@/lib/events/format'
import { signIn } from '@/lib/frame/sign-in'
import { readAvailability } from '@/lib/shop/availability'
import { addToBag } from '@/lib/shop/bag'
import {
  amountOf,
  firstChoice,
  FORMAT_LABELS,
  FORMAT_LINES,
  GIFT_CARD_FORMATS,
  missingLabel,
  NO_RECIPIENT,
  OTHER_PROMPT,
  priceShown,
  recipientWrong,
  type GiftCardFormat,
  type GiftCardView,
  type Recipient,
} from '@/lib/shop/gift-card'
import { productSizes, type PriceLine, type ProductView } from '@/lib/shop/product'

import { AmountField } from './AmountField'
import { ColourField } from './ColourField'
import { SendToRecipientToggle } from './SendToRecipientToggle'
import { SizeField } from './SizeField'

/** A product's price line: the price before a sale struck through, the price ("From" while the sizes differ), and the member's. */
function ProductPrice({ price }: { price: PriceLine }) {
  if (price.now === null) return null
  return (
    <p className="flex flex-wrap items-baseline gap-8">
      {price.before !== null ? (
        <s className="text-copy-14 text-text-muted-primary">
          <span className="sr-only">Was </span>
          {price.before}
        </s>
      ) : null}
      <span className="text-copy-14 text-text-primary">{price.from ? `From ${price.now}` : price.now}</span>
      {price.member !== null ? <span className="text-copy-14 text-text-muted-primary">(Member from {price.member})</span> : null}
    </p>
  )
}

/** An event's price line (Type=event): the public price and "(Member from £X)", or for a members-only event its member price and "Member Only". */
function EventPriceLine({ price }: { price: EventPrice }) {
  if (price.now === null) return null
  return (
    <p className="flex flex-wrap items-baseline gap-8">
      <span className="text-copy-14 text-text-primary">{price.now}</span>
      {price.memberOnly ? <span className="text-copy-14 text-text-primary">Member Only</span> : null}
      {price.member !== null ? <span className="text-copy-14 text-text-muted-primary">(Member from {price.member})</span> : null}
    </p>
  )
}

const [DIGITAL, PHYSICAL] = GIFT_CARD_FORMATS

const FORMAT_OPTIONS = [
  { value: DIGITAL, label: FORMAT_LABELS[DIGITAL] },
  { value: PHYSICAL, label: FORMAT_LABELS[PHYSICAL] },
] as const

const NOTHING_WRONG = { name: null, email: null }

export type ProductCallToAction = {
  type: 'product'
  product: Pick<ProductView, 'id' | 'name' | 'colourName' | 'price' | 'sizes' | 'soldOut' | 'colours' | 'fulfilment'>
  /**
   * The product's sizes now, asked once the page has loaded (lib/shop/availability.ts). Storybook and tests give
   * their own, or null to ask nothing.
   */
  readSizes?: ((product: string) => Promise<ShopAvailabilityRouteOutput | null>) | null
}

export type EventCallToAction = {
  type: 'event'
  event: Pick<EventView, 'id' | 'name' | 'when' | 'startsAt' | 'live'>
  /**
   * The event's spaces, state and prices now, asked once the page has loaded (lib/events/availability.ts). Storybook
   * and tests give their own, or null to ask nothing.
   */
  readLive?: ((event: string) => Promise<ShopEventAvailabilityRouteOutput | null>) | null
}

export type GiftCardCallToAction = {
  type: 'gift card'
  giftCard: Pick<GiftCardView, 'id' | 'name' | 'amounts' | 'other'>
  /** How it is sent: the page's switch, which also swaps the gallery beside these details. */
  format: GiftCardFormat
  onFormat: (format: GiftCardFormat) => void
}

type CallToActionProps =
  | (ProductCallToAction & {
      /** The ProductInfoContainer's id, which the sizes are named from. */
      id: string
      /** Opens the info panel on its Size Guide; null when the product has no guide. */
      onSizeGuide: (() => void) | null
    })
  | EventCallToAction
  | GiftCardCallToAction

/**
 * Figma "CallToAction" (04 Components > Shop, 1684:39401): the purchase box at the top of a ProductInfoContainer,
 * one for each Type: the name in H2, the price line, what is chosen, and the button with the line under it.
 */
export function CallToAction(props: CallToActionProps) {
  if (props.type === 'product') return <ProductBox {...props} />
  if (props.type === 'event') return <EventBox {...props} />
  return <GiftCardBox {...props} />
}

/**
 * Type=product: the name, the price line, the colours of its family (ColourField), its sizes (SizeField), the button
 * and the line under it. Its states, as drawn: non-member ("Add to bag"); select size ("Please select a size" in
 * Text/Error under the sizes, when the button is pressed with none picked); sold out (every size struck through, the
 * button disabled and reading "Sold out"). The member's state waits for accounts. A press with a size picked goes to
 * the one `addToBag()` seam (lib/shop/bag.ts), which does nothing until the bag is built. While a size is still to
 * pick, a mouse over the button slides its label up and "Select size" in from beneath (WQ51); the button's name stays.
 *
 * The sizes it is sent with may be up to a minute old, so once it has loaded it asks the availability route and
 * shows what that says: a size that sold out in between is struck through, and no longer the one picked.
 */
function ProductBox({ product, readSizes = readAvailability, id, onSizeGuide }: Extract<CallToActionProps, { type: 'product' }>) {
  const [live, setLive] = useState({ sizes: product.sizes, soldOut: product.soldOut })
  const [chosen, setChosen] = useState<string | null>(null)
  const [asked, setAsked] = useState(false)

  useEffect(() => {
    if (!readSizes) return
    const stop = new AbortController()
    readSizes(product.id).then((now) => {
      if (now && !stop.signal.aborted) setLive({ sizes: productSizes(now.sizes), soldOut: now.soldOut })
    })
    return () => stop.abort()
  }, [product.id, readSizes])

  const { sizes, soldOut } = live
  // A product that comes in one size only has no size to pick: that one is the size.
  const named = sizes.flatMap((size) => (size.size === null ? [] : [{ ...size, size: size.size }]))
  const picked = named.find((size) => size.size === chosen && size.available) ?? null
  const needsSize = named.length > 0 && picked === null
  const wrong = asked && needsSize && !soldOut

  const add = () => {
    if (soldOut) return
    if (needsSize) return setAsked(true)
    addToBag({ product: product.id, size: picked?.size ?? null })
  }

  return (
    <div className="flex flex-col gap-32">
      <div className="flex flex-col gap-24">
        {/* Wayne, 26 Nov: the colours of a family share a name, so a screen reader hears the colour with it
            ("Paddock T-Shirt, Orange": what tells one colour's page from another's when focus arrives here after
            a swatch). Nothing seen changes: the colour is drawn in its own line below. */}
        <h1 className="text-h2 text-text-primary">
          {product.name}
          {product.colourName ? <span className="sr-only">, {product.colourName}</span> : null}
        </h1>
        <div aria-live="polite">
          <ProductPrice price={picked?.price ?? product.price} />
        </div>
      </div>

      {product.colourName || product.colours.length > 0 ? <ColourField colourName={product.colourName} colours={product.colours} /> : null}

      {named.length > 0 ? <SizeField id={id} sizes={named} picked={picked?.size ?? null} wrong={wrong} onSizeGuide={onSizeGuide} onPick={setChosen} /> : null}

      <div className="flex flex-col gap-24">
        {/* WQ51: with a size still to pick, a mouse over the button slides "Select size" in over its label. */}
        <BigButton disabled={soldOut} onClick={add} {...(needsSize && !soldOut ? { hoverLabel: 'Select size' } : {})}>
          {soldOut ? 'Sold out' : 'Add to bag'}
        </BigButton>
        {product.fulfilment ? <p className="text-copy-12 text-text-primary">{product.fulfilment}</p> : null}
      </div>
    </div>
  )
}

/**
 * Type=event: the name, the price line, the date and time in UK time, the button with what goes with it. Its states,
 * from the Worker's own state for a visitor who isn't signed in (WQ59):
 * - open, "non-member" (1684:41515): the quantity stepper, from 1 to the spaces left (WQ61), "Add to bag", and
 *   "6 spaces left" beneath. A press goes to the one `addToBag()` seam with the event and how many;
 * - members only, and members first before it opens to everyone, "member only signed out" (1709:48988): the member
 *   price with "Member Only", "Sign in" (the one `signIn()` seam, which opens nothing yet) and the spaces left;
 * - full, "sold out" (1684:41643): the button disabled, reading "Sold out", and no spaces line;
 * - started, or cancelled, "closed" (1684:41716): the button disabled, reading "Closed". A cancelled event says so
 *   under it.
 * The member's own states wait for accounts.
 *
 * What it is sent with may be up to a minute old, so once it has loaded it asks the event's route and shows what that
 * says; a quantity above the spaces now left comes down to them.
 */
function EventBox({ event, readLive = readEventAvailability }: EventCallToAction) {
  const [live, setLive] = useState(event.live)
  const [quantity, setQuantity] = useState(1)

  useEffect(() => {
    if (!readLive) return
    const stop = new AbortController()
    readLive(event.id).then((now) => {
      if (now && !stop.signal.aborted) setLive(eventLive(now))
    })
    return () => stop.abort()
  }, [event.id, readLive])

  const { state, spacesLeft, price } = live
  const open = state === 'open'
  const membersOnly = state === 'members_only' || state === 'not_released_yet'
  // Never more than are left, whatever was chosen before the spaces were asked again.
  const chosen = Math.max(1, Math.min(quantity, spacesLeft))
  const line = open || membersOnly ? spacesLine(spacesLeft) : state === 'cancelled' ? EVENT_CANCELLED : null

  return (
    <div className="flex flex-col gap-32">
      <div className="flex flex-col gap-24">
        <h1 className="text-h2 text-text-primary">{event.name}</h1>
        <div aria-live="polite">
          <EventPriceLine price={price} />
        </div>
        <p className="text-copy-14 text-text-primary">
          <time dateTime={event.startsAt}>{event.when}</time>
        </p>
      </div>

      <div className="flex flex-col">
        <div className="flex items-stretch gap-4">
          {open ? (
            <>
              <QuantityStepper value={chosen} max={spacesLeft} onChange={setQuantity} label="Number of places" />
              <BigButton className="min-w-0 flex-1" onClick={() => addToBag({ event: event.id, quantity: chosen })}>
                Add to bag
              </BigButton>
            </>
          ) : membersOnly ? (
            <BigButton onClick={() => signIn()}>Sign in</BigButton>
          ) : (
            <BigButton disabled>{state === 'sold_out' ? 'Sold out' : 'Closed'}</BigButton>
          )}
        </div>
        {/* Always there, so a change after load is said to a screen reader; the line brings its own 8px, so with none it takes no room. */}
        <div aria-live="polite">{line ? <p className="mt-8 text-copy-12 text-text-muted-primary">{line}</p> : null}</div>
      </div>
    </div>
  )
}

/**
 * Type=gift card (digital 1684:40760, physical 1684:40761): the name, the price line, the Digital / Physical switch,
 * the amounts (AmountField), for a digital card "Sending to someone else?" (SendToRecipientToggle), and the button
 * with the line under it.
 * - The price line is the chosen amount; with none yet (Other, and nothing it can take typed) the lowest on sale.
 * - It opens on the lowest preset, chosen, as both page frames draw it. Switching Digital and Physical keeps the
 *   amount, and what was typed for a recipient.
 * - Other's amount is checked as it is typed (W76a's one rule: whole pounds, within the type's limits), its words
 *   under the field in the Input's error state.
 * - Add to bag sends the type, how it is sent, the amount and, for a digital gift, the recipient and message to the
 *   one `addToBag()` seam. With something missing (no amount, an Other it can't take, a gift with no name or no
 *   email) it adds nothing: each field concerned says what it needs, and the first of them takes focus. While
 *   something is missing a mouse over the button slides its label up and what to do in from beneath (WQ51), and the
 *   button's name stays "Add to bag".
 */
function GiftCardBox({ giftCard, format, onFormat }: GiftCardCallToAction) {
  const [choice, setChoice] = useState(() => firstChoice(giftCard))
  const [sending, setSending] = useState(false)
  const [recipient, setRecipient] = useState<Recipient>(NO_RECIPIENT)
  // Add to bag was pressed with something missing: from then on each field says what it needs until it has it.
  const [asked, setAsked] = useState(false)
  const amountField = useRef<HTMLInputElement>(null)
  const nameField = useRef<HTMLInputElement>(null)
  const emailField = useRef<HTMLInputElement>(null)

  const amount = amountOf(choice, giftCard.other)
  // Only a digital card goes to someone else by email: a physical one is posted or collected by the buyer.
  const gift = format === DIGITAL && sending
  const recipientIs = gift ? recipientWrong(recipient) : NOTHING_WRONG
  const amountWrong = amount.wrong ?? (asked && amount.empty ? OTHER_PROMPT : null)
  const nothingToBuy = choice === null
  const hoverLabel = nothingToBuy ? null : missingLabel({ amount, recipient: gift ? recipient : null })

  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (nothingToBuy) return
    if (amount.amount === null || recipientIs.name || recipientIs.email) {
      setAsked(true)
      const first = amount.amount === null ? amountField : recipientIs.name ? nameField : emailField
      first.current?.focus()
      return
    }
    setAsked(false)
    addToBag({
      giftCard: giftCard.id,
      format,
      amount: amount.amount,
      recipient: gift ? { name: recipient.name.trim(), email: recipient.email.trim(), message: recipient.message.trim() } : null,
    })
  }

  const price = priceShown(amount, giftCard.amounts)

  return (
    <form noValidate onSubmit={add} className="flex flex-col gap-32">
      <div className="flex flex-col gap-24">
        <h1 className="text-h2 text-text-primary">{giftCard.name}</h1>
        <div aria-live="polite">
          {price !== null ? (
            <p data-shop="price" className="flex flex-wrap items-baseline gap-8">
              <span className="text-copy-14 text-text-primary">{price}</span>
            </p>
          ) : null}
        </div>
      </div>

      <Toggle label="How it is sent" name="format" value={format} options={FORMAT_OPTIONS} onChange={onFormat} className="self-start" />

      {nothingToBuy ? null : <AmountField amounts={giftCard.amounts} other={giftCard.other !== null} choice={choice} onChoice={setChoice} wrong={amountWrong} fieldRef={amountField} />}

      {format === DIGITAL ? (
        <SendToRecipientToggle
          sending={sending}
          onSending={setSending}
          recipient={recipient}
          onRecipient={setRecipient}
          wrong={asked ? recipientIs : NOTHING_WRONG}
          nameRef={nameField}
          emailRef={emailField}
        />
      ) : null}

      <div className="flex flex-col gap-24">
        {/* WQ51: with something still missing, a mouse over the button slides what to do in over its label. */}
        <BigButton type="submit" disabled={nothingToBuy} {...(hoverLabel ? { hoverLabel } : {})}>
          {nothingToBuy ? 'Unavailable' : 'Add to bag'}
        </BigButton>
        <p data-shop="fulfilment" className="text-copy-12 text-text-primary">
          {FORMAT_LINES[format]}
        </p>
      </div>
    </form>
  )
}
