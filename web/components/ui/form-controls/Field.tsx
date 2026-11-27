'use client'

import { useId, type ComponentPropsWithoutRef, type Ref } from 'react'

// Figma "Input" (03 UI, 948:9227) and "TextField" (1389:39131): a field on Surface/Card with 4px corners, 16px to
// its left, its words in Copy 14. Its states, as drawn: empty (the prompt in Text/Muted Primary), focus
// (Surface/Card Selected), full (the words in Text/Primary) and error (Surface/Card Error, with the message beneath
// in Copy 12 and Text/Error) and, an Input only, disabled. A note (a counter) and the message sit 8px under the
// field, 16px in, with 4px beneath.
//
// By the build standards (docs/build-standards.md, section 1: Forms) the prompt inside the field is also its hidden
// label, the message is tied to the field (`aria-describedby`, `aria-invalid`) and read out when it appears, and a
// field shows its designed focus state in place of the focus ring.

/** What both fields share. Their words are Copy 14 untrimmed: a field draws its own line, so its height is set from the capitals below. */
const FIELD = 'block w-full rounded-s pr-6 pl-16 text-copy-14 [text-box-trim:none] text-text-primary outline-none transition-colors duration-short ease-smooth placeholder:text-text-muted-primary'

const fill = (wrong: boolean): string => (wrong ? 'bg-surface-card-error' : 'bg-surface-card focus:bg-surface-card-selected')

/**
 * Figma "Input", State=disabled (956:17481): Surface/Card Disabled with its words in Text/Muted Primary. A browser
 * dims a disabled field's words by itself (Safari, by their fill colour): here they are the token's colour, whole.
 */
const DISABLED = 'disabled:bg-surface-card-disabled disabled:text-text-muted-primary disabled:opacity-100 disabled:[-webkit-text-fill-color:currentColor]'

type Shared = {
  /** The prompt inside the field while it is empty, and its name for a screen reader. */
  label: string
  value: string
  onValue: (value: string) => void
  /** What is wrong with it, in words; null or left out when nothing is. */
  error?: string | null
  /** A line under the field in Text/Muted Primary (a counter). It is read with the field, not each time it changes. */
  note?: string | null
  className?: string
}

/** The lines under a field: the note, then the message. The message's place is always there, so its arrival is read out. */
function Beneath({ note, noteId, error, errorId }: { note: string | null; noteId: string; error: string | null; errorId: string }) {
  return (
    <>
      {note ? (
        <p id={noteId} className="mt-8 px-16 text-copy-12 text-text-muted-primary">
          {note}
        </p>
      ) : null}
      <div aria-live="polite">
        {error ? (
          <p id={errorId} data-field-error="" className="mt-8 px-16 text-copy-12 text-text-error">
            {error}
          </p>
        ) : null}
      </div>
    </>
  )
}

const described = (note: string | null, noteId: string, error: string | null, errorId: string): { 'aria-describedby'?: string } => {
  const ids = [error ? errorId : null, note ? noteId : null].filter((id) => id !== null)
  return ids.length > 0 ? { 'aria-describedby': ids.join(' ') } : {}
}

type TextInputProps = Shared & Omit<ComponentPropsWithoutRef<'input'>, 'value' | 'onChange' | 'className' | 'placeholder' | 'id'> & { ref?: Ref<HTMLInputElement> }

/**
 * One line (Figma "Input"): 16px above and below its capitals, as the option chips beside it (42px for Copy 14).
 * The browser sets the line in the middle of the field.
 */
export function TextInput({ label, value, onValue, error = null, note = null, className, type = 'text', ref, ...rest }: TextInputProps) {
  const id = useId()
  return (
    <div data-field="" className={`flex flex-col ${note || error ? 'pb-4' : ''} ${className ?? ''}`}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        ref={ref}
        id={id}
        type={type}
        value={value}
        onChange={(event) => onValue(event.target.value)}
        placeholder={label}
        aria-invalid={error !== null}
        {...described(note, `${id}-note`, error, `${id}-error`)}
        className={`${FIELD} h-[calc(1cap_+_var(--spacing-32))] ${fill(error !== null)} ${DISABLED}`}
        {...rest}
      />
      <Beneath note={note} noteId={`${id}-note`} error={error} errorId={`${id}-error`} />
    </div>
  )
}

type TextAreaProps = Shared & Omit<ComponentPropsWithoutRef<'textarea'>, 'value' | 'onChange' | 'className' | 'placeholder' | 'id' | 'rows'> & { ref?: Ref<HTMLTextAreaElement> }

/**
 * Several lines (Figma "TextField", as the Gift Card page has it: 66px): room for two lines, the first line's
 * capitals 16px from the top as an Input's are. More than two lines scroll inside it; it can't be dragged bigger.
 */
export function TextArea({ label, value, onValue, error = null, note = null, className, ref, ...rest }: TextAreaProps) {
  const id = useId()
  return (
    <div data-field="" className={`flex flex-col ${note || error ? 'pb-4' : ''} ${className ?? ''}`}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <textarea
        ref={ref}
        id={id}
        value={value}
        onChange={(event) => onValue(event.target.value)}
        placeholder={label}
        aria-invalid={error !== null}
        {...described(note, `${id}-note`, error, `${id}-error`)}
        data-lenis-prevent=""
        // Two lines: the capitals of the first, 4px, and a whole line, with 16px above and below (Figma: 66px).
        className={`${FIELD} h-[calc(1cap_+_1lh_+_var(--spacing-4)_+_var(--spacing-32))] resize-none py-[calc(var(--spacing-16)_-_(1lh_-_1cap)_/_2)] ${fill(error !== null)}`}
        {...rest}
      />
      <Beneath note={note} noteId={`${id}-note`} error={error} errorId={`${id}-error`} />
    </div>
  )
}
