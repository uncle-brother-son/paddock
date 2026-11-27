import type { ReactNode } from 'react'

import { Radio } from './Radio'

type PaymentMethodOptionProps = {
  /** The radio group's name: one group for the ways to pay. */
  name: string
  value: string
  selected: boolean
  onSelect: () => void
  /** Its words, in Copy 14 ("Card"): they are its name, and a press on them chooses it. */
  children: ReactNode
  className?: string
}

/**
 * Figma "PaymentMethodOption" (03 UI, 956:16243): one way to pay, the whole width of what holds it. Figma's Radio and,
 * 12px from it, its words in Copy 14 and Text/Primary, with 16px all round, on Surface/Card (State=not selected) or,
 * once chosen, Surface/Card Selected (State=selected). Under a mouse (State=hover, WQ80) one not chosen is Surface/Card
 * Selected too, its Radio still unchosen. Its corners are square, as drawn: the options stand one on another.
 *
 * The whole row is the radio's label, so a press anywhere on it chooses it.
 */
export function PaymentMethodOption({ name, value, selected, onSelect, children, className }: PaymentMethodOptionProps) {
  return (
    <label
      data-payment-method=""
      className={`flex cursor-pointer items-center gap-12 p-16 transition-colors duration-short ease-smooth ${selected ? 'bg-surface-card-selected' : 'bg-surface-card hover:bg-surface-card-selected'} ${className ?? ''}`}
    >
      <Radio name={name} value={value} checked={selected} onChange={onSelect} />
      <span className="min-w-0 flex-1 text-copy-14 text-text-primary">{children}</span>
    </label>
  )
}
