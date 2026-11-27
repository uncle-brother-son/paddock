'use client'

import { useRef, type ClipboardEvent, type KeyboardEvent } from 'react'

/** How many digits a code has: Figma draws six fields. */
export const CODE_LENGTH = 6

const PLACES = Array.from({ length: CODE_LENGTH }, (_, index) => index)

const digitsOf = (text: string): string => text.replace(/\D/g, '')

type CodeInputProps = {
  /** What the code is, for a screen reader: "Sign-in code". */
  label: string
  /** The digits typed so far, in order: six at most. */
  value: string
  onValue: (value: string) => void
  /** The code was refused: every field is drawn in its error state. The words that say so are the form's own. */
  invalid?: boolean
  /** The id of those words, so they are read with each field. */
  describedBy?: string
  className?: string
}

/**
 * Figma "CodeInput" (03 UI, 1174:12397): six of Figma's Inputs side by side, 8px apart, sharing the width, each
 * holding one digit in Copy 14 at its middle (8px to its left and 6px to its right, as drawn). A field is
 * Surface/Card, and Surface/Card Selected while it has focus (State=default: the first has it); when the code is
 * wrong every field is Surface/Card Error (State=error).
 *
 * Six real fields under one group's name (docs/build-standards.md, section 1: Forms): a digit typed moves on to the
 * next field, Backspace clears a field and then goes back, Left and Right move between them, and a code pasted or
 * filled in by the phone ("one-time-code") fills them all. Anything that is not a digit is left out.
 */
export function CodeInput({ label, value, onValue, invalid = false, describedBy, className }: CodeInputProps) {
  const fields = useRef<(HTMLInputElement | null)[]>([])
  const focus = (index: number) => fields.current[Math.max(0, Math.min(CODE_LENGTH - 1, index))]?.focus()

  /** Digits arrive at a field: they take its place and those after it. A whole code starts from the first field. */
  const fill = (index: number, digits: string) => {
    if (digits === '') return
    const from = digits.length >= CODE_LENGTH ? 0 : Math.min(index, value.length)
    onValue((value.slice(0, from) + digits + value.slice(from + digits.length)).slice(0, CODE_LENGTH))
    focus(from + digits.length)
  }

  /** A field's own text changed. A digit typed into a field that held one arrives beside the old one, which goes. */
  const typed = (index: number, text: string) => {
    const held = value.charAt(index)
    const digits = digitsOf(text)
    const fresh = held !== '' && digits.length === 2 ? (digits.startsWith(held) ? digits.slice(1) : digits.replace(held, '')) : digits
    fill(index, fresh)
  }

  const without = (index: number) => onValue(value.slice(0, index) + value.slice(index + 1))

  const onKey = (index: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace') {
      event.preventDefault()
      if (value.charAt(index) !== '') return without(index)
      // An empty field: back to the one before, which is cleared.
      if (index > 0) {
        without(index - 1)
        focus(index - 1)
      }
    } else if (event.key === 'Delete') {
      event.preventDefault()
      without(index)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      focus(index - 1)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      focus(index + 1)
    }
  }

  const onPaste = (index: number, event: ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault()
    fill(index, digitsOf(event.clipboardData.getData('text')))
  }

  return (
    <div role="group" aria-label={label} data-code-input="" className={`flex gap-8 ${className ?? ''}`}>
      {PLACES.map((index) => (
        <input
          key={index}
          ref={(field) => {
            fields.current[index] = field
          }}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="one-time-code"
          aria-label={`Digit ${index + 1} of ${CODE_LENGTH}`}
          aria-invalid={invalid}
          {...(describedBy ? { 'aria-describedby': describedBy } : {})}
          value={value.charAt(index)}
          onChange={(event) => typed(index, event.target.value)}
          onKeyDown={(event) => onKey(index, event)}
          onPaste={(event) => onPaste(index, event)}
          // Its words are Copy 14 untrimmed, and its height is set from the capitals, as an Input's (Field.tsx).
          className={`block h-[calc(1cap_+_var(--spacing-32))] w-full min-w-0 flex-1 rounded-s pr-6 pl-8 text-center text-copy-14 [text-box-trim:none] text-text-primary outline-none transition-colors duration-short ease-smooth ${invalid ? 'bg-surface-card-error' : 'bg-surface-card focus:bg-surface-card-selected'}`}
        />
      ))}
    </div>
  )
}
