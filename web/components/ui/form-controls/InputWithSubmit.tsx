'use client'

import { useId, type ComponentPropsWithoutRef } from 'react'

import { Icon } from '@/components/brand/Icon'

type InputWithSubmitProps = Omit<ComponentPropsWithoutRef<'input'>, 'value' | 'onChange' | 'className' | 'placeholder' | 'id'> & {
  /** The prompt inside the field while it is empty, and its name for a screen reader. */
  label: string
  value: string
  onValue: (value: string) => void
  /** What the arrow does, for a screen reader: "Sign up". */
  submitLabel: string
  /** What is wrong, in words; null or left out when nothing is. */
  error?: string | null
  /** While what was sent is on its way: the arrow says it can't be pressed again yet. */
  sending?: boolean
  className?: string
}

/**
 * Figma "InputWithSubmit" (03 UI, 911:9431): a field with its own arrow, on Surface/Card with 4px corners, 16px to
 * its left and 6px round the arrow, its words in Copy 14. Its states, as drawn: empty (the prompt in Text/Muted
 * Primary), focus (Surface/Card Selected), full (the words in Text/Primary, and the arrow gains Surface/Card) and
 * error (Surface/Card Error, with the message 8px beneath in Copy 12 and Text/Error). The arrow button is 32px, the
 * nearest spacing token to Figma's 30 (Wayne, 24 Nov).
 *
 * It goes inside the caller's <form>: the arrow is that form's submit button. By the build standards
 * (docs/build-standards.md, section 1: Forms) the prompt is also the field's hidden label, and the message is tied
 * to the field and read out at once.
 */
export function InputWithSubmit({ label, value, onValue, submitLabel, error = null, sending = false, className, type = 'text', ...rest }: InputWithSubmitProps) {
  const fieldId = useId()
  const messageId = useId()
  return (
    <div data-input-with-submit="" className={`flex flex-col gap-8 ${className ?? ''}`}>
      <div
        className={`flex items-center rounded-s py-6 pr-6 pl-16 transition-colors duration-short ease-smooth ${error ? 'bg-surface-card-error' : 'bg-surface-card has-[input:focus]:bg-surface-card-selected'}`}
      >
        <label htmlFor={fieldId} className="sr-only">
          {label}
        </label>
        <input
          id={fieldId}
          type={type}
          placeholder={label}
          value={value}
          onChange={(event) => onValue(event.target.value)}
          aria-invalid={error !== null}
          {...(error ? { 'aria-describedby': messageId } : {})}
          className="min-w-0 flex-1 bg-transparent text-copy-14 text-text-primary outline-none placeholder:text-text-muted-primary"
          {...rest}
        />
        <button
          type="submit"
          aria-label={submitLabel}
          aria-disabled={sending}
          className={`flex size-32 shrink-0 items-center justify-center rounded-s text-text-primary transition-colors duration-short ease-smooth ${value !== '' ? 'bg-surface-card' : ''}`}
        >
          <Icon name="arrow" />
        </button>
      </div>
      <div aria-live="assertive" className="empty:hidden">
        {error ? (
          <p id={messageId} className="text-copy-12 text-text-error">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  )
}
