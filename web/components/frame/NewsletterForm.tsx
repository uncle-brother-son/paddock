'use client'

import { useState, type FormEvent } from 'react'

import { InputWithSubmit } from '@/components/ui/InputWithSubmit'
import { subscribeToNewsletter, type NewsletterResult } from '@/lib/frame/newsletter'

/** The field's prompt, and the same words as its hidden label (docs/build-standards.md, section 1: Forms). */
const PROMPT = 'Enter your email address'

type NewsletterFormProps = {
  /** Stories and tests pass their own; the footer leaves it out and the real one is used. */
  subscribe?: (email: string) => Promise<NewsletterResult>
}

/**
 * The footer's newsletter field (W73): Figma "InputWithSubmit" (components/ui/InputWithSubmit.tsx) in its designed
 * states: empty, focus, filled and error, the message tied to the field and read out at once. Figma draws no success
 * state: a sign-up that works empties the field and says so to a screen reader only, until one is designed.
 */
export function NewsletterForm({ subscribe = subscribeToNewsletter }: NewsletterFormProps) {
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
    <form onSubmit={submit} noValidate>
      <InputWithSubmit
        label={PROMPT}
        submitLabel="Sign up"
        type="email"
        name="email"
        autoComplete="email"
        required
        value={email}
        onValue={(value) => {
          setEmail(value)
          setError(null)
        }}
        error={error}
        sending={sending}
      />
      <p aria-live="polite" className="sr-only">
        {done ? 'Thank you. You are signed up.' : ''}
      </p>
    </form>
  )
}
