'use client'

import { useId, type Ref } from 'react'

import { TextInput } from '@/components/ui/Field'
import { OTHER_PROMPT, type AmountChoice, type GiftCardAmount } from '@/lib/shop/gift-card'

import { SizeOption } from './SizeSelect'

/** What the Other chip is called in its radio group, and on the chip. */
const OTHER = 'Other'

type OptionsAmountProps = {
  /** The presets on sale, lowest first. */
  amounts: GiftCardAmount[]
  /** Whether Other is offered (W76a: the type allows it and has limits). */
  other: boolean
  choice: AmountChoice
  onChoice: (choice: AmountChoice) => void
  /** What is wrong with the Other amount, in words, shown under its field; null when nothing is. */
  wrong: string | null
  /** The Other field, so a press of Add to bag with no amount can put the visitor in it. */
  fieldRef?: Ref<HTMLInputElement>
}

/**
 * Figma "OptionsAmount" (1389:39346): "Amount" in Copy 12, then a chip for each preset and, when the type allows it,
 * "Other", three to a row and 4px apart (Figma's SizeSelect, Big: the chip for sizes, gift card amounts and delivery
 * choice). Its states, as drawn: default and selected (a preset chosen, Surface/Secondary), other (Other chosen: the
 * amount field opens beneath, 4px under the chips, with its prompt "Enter an amount") and other full (an amount in it).
 *
 * The chips are one group of radio buttons, so the arrow keys move between them. What is typed is shown with its
 * pound sign, as drawn ("£200"); the digits are what the rule is asked about. The words under the field are the
 * Input's own error state: the field in Surface/Card Error with the message in Copy 12 and Text/Error.
 */
export function OptionsAmount({ amounts, other, choice, onChoice, wrong, fieldRef }: OptionsAmountProps) {
  const id = useId()
  const otherChosen = choice?.kind === 'other'
  const typed = otherChosen ? choice.typed : ''
  return (
    <div data-shop="amount" className="flex flex-col gap-12">
      <p id={`${id}-amount`} className="text-copy-12 text-text-primary">
        Amount
      </p>
      <div className="flex flex-col gap-4">
        <div role="radiogroup" aria-labelledby={`${id}-amount`} aria-required="true" className="grid grid-cols-3 gap-4">
          {amounts.map((one) => (
            <SizeOption
              key={one.amount}
              name={`${id}-amounts`}
              size={one.label}
              available
              selected={choice?.kind === 'preset' && choice.amount === one.amount}
              onSelect={() => onChoice({ kind: 'preset', amount: one.amount })}
            />
          ))}
          {other ? <SizeOption name={`${id}-amounts`} size={OTHER} available selected={otherChosen} onSelect={() => onChoice({ kind: 'other', typed })} /> : null}
        </div>
        {otherChosen ? (
          <TextInput
            {...(fieldRef ? { ref: fieldRef } : {})}
            label={OTHER_PROMPT}
            name="amount"
            inputMode="numeric"
            autoComplete="off"
            required
            value={typed === '' ? '' : `£${typed}`}
            onValue={(value) => onChoice({ kind: 'other', typed: value.replace(/^\s*£/, '').trimStart() })}
            error={wrong}
          />
        ) : null}
      </div>
    </div>
  )
}
