'use client'

import { useId, useState, type KeyboardEvent } from 'react'

import { Icon } from '@/components/brand/Icon'
import { ICON_BUTTON_PAGE_BUTTON } from '@/components/ui/buttons/IconButton'

type PriceStepperProps = {
  /** The amount, in whole pounds (WQ63). */
  value: number
  /** The least it goes to, in whole pounds. */
  min: number
  /** The most it goes to, in whole pounds. */
  max: number
  onChange: (value: number) => void
  /** What the amount is, for a screen reader: "Amount". */
  label: string
  className?: string
}

const clamp = (value: number, least: number, most: number): number => Math.min(Math.max(value, least), most)

/** Only digits can be typed: whole pounds. */
const digitsOf = (typed: string): string => typed.replace(/\D/g, '').slice(0, 6)

/**
 * Figma "PriceStepper" (03 UI, 1157:16352; its one variant, Switch=no, Big=no): on Surface/Card with 4px corners, the
 * amount in Label 12 with 8px each side, then Figma's IconButton (Style=page) holding the up-and-down icon
 * (`quantity`), 25px square. It is as wide as its parts and 25px tall, as the small QuantityStepper.
 *
 * It changes the amount (WQ80): the icon's upper half takes it up £1 and its lower half down £1, never above `max`
 * or below `min`; at either end that half does nothing and its arrow is Text/Muted Primary, as a disabled IconButton
 * is drawn. The amount can be typed too (digits only: whole pounds); it is taken on Enter or when focus leaves, put
 * within the limits, and anything left empty goes back to the amount it was.
 *
 * For the keyboard and a screen reader the amount is a spin button: its name, its amount said as "£5", and the up
 * and down arrow keys step it by £1. The two halves are buttons with their own names, left out of the Tab order as a
 * spin button's are (the arrow keys do the same), and a press on one keeps focus where it was. A change made with
 * them is said aloud. Figma draws no focus state: the fill turns Surface/Card Selected while the amount has focus,
 * as a text field's does (Field.tsx).
 */
export function PriceStepper({ value, min, max, onChange, label, className }: PriceStepperProps) {
  const id = useId()
  // What is being typed, until it is taken; null while nothing is.
  const [draft, setDraft] = useState<string | null>(null)
  // Said aloud after a press on a half (the spin button says its own amount when the arrow keys change it).
  const [said, setSaid] = useState('')

  const typed = (): number => (draft === null || draft === '' ? value : Number(draft))

  const settle = (next: number): number => {
    const amount = clamp(next, min, max)
    setDraft(null)
    if (amount !== value) onChange(amount)
    return amount
  }

  const step = (by: 1 | -1) => settle(typed() + by)

  const pressed = (by: 1 | -1) => setSaid(`£${step(by)}`)

  const take = () => {
    if (draft === null) return
    const amount = settle(typed())
    // A typed amount put within the limits is said, so the change is heard.
    if (draft !== '' && amount !== Number(draft)) setSaid(`£${amount}`)
  }

  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      step(event.key === 'ArrowUp' ? 1 : -1)
    } else if (event.key === 'Enter') {
      take()
    }
  }

  const shown = draft ?? String(value)
  const atLeast = typed() <= min
  const atMost = typed() >= max

  return (
    <div
      data-price-stepper=""
      className={`inline-flex h-[25px] shrink-0 items-stretch rounded-s bg-surface-card transition-colors duration-short ease-smooth has-[input:focus]:bg-surface-card-selected ${className ?? ''}`}
    >
      {/* Both lines of type keep their full height here (no trim), so "£" and the typed digits share a baseline. */}
      <label className="flex cursor-text items-center px-8 text-label-12 whitespace-nowrap text-text-primary [text-box:normal]">
        <span aria-hidden="true">£</span>
        {/* The field is as wide as what it holds: an unseen copy of it sets the width. */}
        <span className="inline-grid">
          <span aria-hidden="true" className="invisible col-start-1 row-start-1 whitespace-pre">
            {shown || '0'}
          </span>
          <input
            id={`${id}-amount`}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            // A field has a width of its own (about 20 characters, and some even at one): this one has none (`w-0`) and
            // stretches to the copy beside it (`min-w-full`).
            size={1}
            role="spinbutton"
            aria-label={label}
            aria-valuenow={value}
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuetext={`£${value}`}
            value={shown}
            onChange={(event) => setDraft(digitsOf(event.target.value))}
            onKeyDown={keyDown}
            onBlur={take}
            className="col-start-1 row-start-1 m-0 w-0 min-w-full appearance-none border-0 bg-transparent p-0 text-inherit outline-none [font:inherit] [letter-spacing:inherit]"
          />
        </span>
      </label>
      <span className="relative flex w-[25px] flex-col">
        {(
          [
            { by: 1, name: 'One pound more', end: atMost, half: 'rounded-b-none', icon: 'top-6' },
            { by: -1, name: 'One pound less', end: atLeast, half: 'rounded-t-none', icon: 'top-[-6.5px]' },
          ] as const
        ).map(({ by, name, end, half, icon }) => (
          <button
            key={by}
            type="button"
            tabIndex={-1}
            aria-label={name}
            aria-controls={`${id}-amount`}
            disabled={end}
            // A press keeps focus where it was: in the amount, if it is being typed.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => pressed(by)}
            data-step={by > 0 ? 'up' : 'down'}
            className={`${ICON_BUTTON_PAGE_BUTTON} relative min-h-0 flex-1 overflow-hidden ${half}`}
          >
            {/* One icon, cut in two: each half shows its own arrow, where Figma draws it in the 25px button. */}
            <Icon name="quantity" className={`absolute left-8 ${icon}`} />
          </button>
        ))}
      </span>
      <span data-price-said="" aria-live="polite" className="sr-only">
        {said}
      </span>
    </div>
  )
}
