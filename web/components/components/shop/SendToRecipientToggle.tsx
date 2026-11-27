'use client'

import type { Ref } from 'react'

import { Checkbox } from '@/components/ui/form-controls/Checkbox'
import { TextArea, TextInput } from '@/components/ui/form-controls/Field'
import { charactersLeft, GIFT_MESSAGE_MOST, type Recipient } from '@/lib/shop/gift-card'

type SendToRecipientToggleProps = {
  /** "Sending to someone else?" is ticked. */
  sending: boolean
  onSending: (sending: boolean) => void
  recipient: Recipient
  onRecipient: (recipient: Recipient) => void
  /** What is wrong with the name and the email, in words, shown under each; null when nothing is (or not yet said). */
  wrong: { name: string | null; email: string | null }
  nameRef?: Ref<HTMLInputElement>
  emailRef?: Ref<HTMLInputElement>
}

/**
 * Figma "SendToRecipientToggle" (1389:39585), for a digital card only: the tick box "Sending to someone else?" and, once it
 * is ticked (Selected=yes), 32px beneath it and 8px apart: Recipient's Name, Recipient's Email and Gift message, the
 * message with its counter ("150 characters left") in Copy 12 and Text/Muted Primary. Unticked there is the tick box alone.
 *
 * The email is checked as one, and neither field is filled in from the buyer's own details: they are someone else's.
 * The message stops at 150 characters; its counter is read with the field, not at each letter.
 */
export function SendToRecipientToggle({ sending, onSending, recipient, onRecipient, wrong, nameRef, emailRef }: SendToRecipientToggleProps) {
  return (
    <div data-shop="recipient" className="flex flex-col gap-32">
      <Checkbox checked={sending} onChange={onSending} name="gift">
        Sending to someone else?
      </Checkbox>
      {sending ? (
        <div role="group" aria-label="Recipient" className="flex flex-col gap-8">
          <TextInput
            {...(nameRef ? { ref: nameRef } : {})}
            label="Recipient’s Name"
            name="recipient-name"
            autoComplete="off"
            required
            value={recipient.name}
            onValue={(name) => onRecipient({ ...recipient, name })}
            error={wrong.name}
          />
          <TextInput
            {...(emailRef ? { ref: emailRef } : {})}
            label="Recipient’s Email"
            name="recipient-email"
            type="email"
            inputMode="email"
            autoComplete="off"
            autoCapitalize="none"
            required
            value={recipient.email}
            onValue={(email) => onRecipient({ ...recipient, email })}
            error={wrong.email}
          />
          <TextArea
            label="Gift message"
            name="gift-message"
            maxLength={GIFT_MESSAGE_MOST}
            value={recipient.message}
            onValue={(message) => onRecipient({ ...recipient, message: message.slice(0, GIFT_MESSAGE_MOST) })}
            note={charactersLeft(recipient.message)}
          />
        </div>
      ) : null}
    </div>
  )
}
