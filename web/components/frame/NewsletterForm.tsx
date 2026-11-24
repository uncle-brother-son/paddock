'use client'

import { useId, useState, type FormEvent } from 'react'

import { Icon } from '@/components/brand/Icon'
import { subscribeToNewsletter, type NewsletterResult } from '@/lib/frame/newsletter'

/** The field's prompt, and the same words as its hidden label (docs/build-standards.md, section 1: Forms). */
const PROMPT = 'Enter your email address'

type NewsletterFormProps = {
  /** Stories and tests pass their own; the footer leaves it out and the real one is used. */
  subscribe?: (email: string) => Promise<NewsletterResult>
}

/**
 * The footer's newsletter field (W73; Figma "InputWithSubmit", 911:9431) in its designed states: empty (the prompt
 * in Text/Muted Primary), focus (Surface/Card Selected), filled (the arrow gains Surface/Card) and error
 * (Surface/Card Error, with the message beneath in Text/Error). The message is tied to the field and read out at
 * once. Figma draws no success state: a sign-up that works empties the field and says so to a screen reader only,
 * until one is designed. The arrow button is 32px, the nearest spacing token to Figma's 30 (Wayne, 24 Nov).
 */
export function NewsletterForm({ subscribe = subscribeToNewsletter }: NewsletterFormProps) {
  const fieldId = useId()
  const messageId = useId()
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [done, setDone] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (sending) return
    setSending(true)
    setDone(false)
    const result = await subscribe(email)
    setSending(false)
    if (result.ok) {
      setEmail('')
      setError(null)
      setDone(true)
    } else {
      setError(result.message)
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-8">
      <div
        className={`flex items-center rounded-s py-6 pr-6 pl-16 transition-colors duration-short ease-smooth ${error ? 'bg-surface-card-error' : 'bg-surface-card has-[input:focus]:bg-surface-card-selected'}`}
      >
        <label htmlFor={fieldId} className="sr-only">
          {PROMPT}
        </label>
        <input
          id={fieldId}
          type="email"
          name="email"
          autoComplete="email"
          required
          placeholder={PROMPT}
          value={email}
          onChange={(event) => {
            setEmail(event.target.value)
            setError(null)
          }}
          aria-invalid={error !== null}
          {...(error ? { 'aria-describedby': messageId } : {})}
          className="min-w-0 flex-1 bg-transparent text-copy-14 text-text-primary outline-none placeholder:text-text-muted-primary"
        />
        <button
          type="submit"
          aria-label="Sign up"
          aria-disabled={sending}
          className={`flex size-32 shrink-0 items-center justify-center rounded-s text-text-primary transition-colors duration-short ease-smooth ${email !== '' ? 'bg-surface-card' : ''}`}
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
      <p aria-live="polite" className="sr-only">
        {done ? 'Thank you. You are signed up.' : ''}
      </p>
    </form>
  )
}
