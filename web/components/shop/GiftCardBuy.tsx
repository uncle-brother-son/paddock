'use client'

import { useRef, useState, type FormEvent } from 'react'

import { StickyColumn } from '@/components/layout/StickyColumn'
import { BigButton } from '@/components/ui/Button'
import { Toggle } from '@/components/ui/Toggle'
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

import { InfoPanelLink } from './InfoPanelLink'
import { OptionsAmount } from './OptionsAmount'
import { ProductInfoPanel, type InfoTab } from './ProductInfoPanel'
import { RecipientInfo } from './RecipientInfo'

const [DIGITAL, PHYSICAL] = GIFT_CARD_FORMATS

const FORMAT_OPTIONS = [
  { value: DIGITAL, label: FORMAT_LABELS[DIGITAL] },
  { value: PHYSICAL, label: FORMAT_LABELS[PHYSICAL] },
] as const

const NOTHING_WRONG = { name: null, email: null }

type GiftCardBuyProps = {
  giftCard: Pick<GiftCardView, 'id' | 'name' | 'amounts' | 'other'>
  /** How it is sent: the page's switch, which also swaps the gallery beside these details. */
  format: GiftCardFormat
  onFormat: (format: GiftCardFormat) => void
  /** The info panel's tabs, in order: Description, Gift Card Terms & Conditions, Shipping & returns. */
  tabs: InfoTab[]
  /** Where the details sit on the page: their columns of the grid. They stick there as a StickyColumn does (components/layout/StickyColumn.tsx). */
  className?: string
}

/**
 * The details beside the gift card's gallery (Figma "PIC", Type=gift card digital and gift card physical: desktop on
 * 1684:41971 and 1684:41984, mobile on 1684:42041 and 1684:42053, holding "CTA", Type=gift card, 1684:40760 and
 * 1684:40761): the name in H2, the price line, the Digital / Physical switch, the amounts, for a digital card
 * "Sending to someone else?", the button with the line under it, and the links that open the info panel.
 *
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
export function GiftCardBuy({ giftCard, format, onFormat, tabs, className }: GiftCardBuyProps) {
  const [choice, setChoice] = useState(() => firstChoice(giftCard))
  const [sending, setSending] = useState(false)
  const [recipient, setRecipient] = useState<Recipient>(NO_RECIPIENT)
  // Add to bag was pressed with something missing: from then on each field says what it needs until it has it.
  const [asked, setAsked] = useState(false)
  const [panel, setPanel] = useState<{ open: boolean; tab: string }>({ open: false, tab: tabs[0]?.id ?? '' })
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
    <>
      <StickyColumn place={className ?? ''} data-shop="details" className="flex flex-col gap-64 pt-24 pb-120 md:pt-240 md:pb-80">
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

          {nothingToBuy ? null : <OptionsAmount amounts={giftCard.amounts} other={giftCard.other !== null} choice={choice} onChoice={setChoice} wrong={amountWrong} fieldRef={amountField} />}

          {format === DIGITAL ? (
            <RecipientInfo
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

        {tabs.length > 0 ? (
          <ul className="flex flex-col items-start gap-16">
            {tabs.map((tab) => (
              <li key={tab.id}>
                <InfoPanelLink onClick={() => setPanel({ open: true, tab: tab.id })}>{tab.label}</InfoPanelLink>
              </li>
            ))}
          </ul>
        ) : null}
      </StickyColumn>
      {/* Beside the details, not inside them: they stick as the gallery scrolls past, and what sticks is a layer of its own, which would hold the panel beneath the header. */}
      {tabs.length > 0 ? (
        <ProductInfoPanel
          open={panel.open}
          tabs={tabs}
          tab={panel.tab}
          onTab={(tab) => setPanel({ open: true, tab })}
          onClose={() => setPanel((now) => ({ ...now, open: false }))}
          label="Gift card information"
        />
      ) : null}
    </>
  )
}
