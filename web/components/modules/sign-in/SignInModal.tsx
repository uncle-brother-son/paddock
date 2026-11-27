'use client'

import { useId, type FormEvent, type ReactNode, type RefObject } from 'react'

import { Icon } from '@/components/brand/Icon'
import { FRAME_BUTTON, FrameButtonLabel } from '@/components/frame/FrameButton'
import { TextLink } from '@/components/ui/TextLink'
import { BigButton } from '@/components/ui/buttons/Button'
import { Checkbox } from '@/components/ui/form-controls/Checkbox'
import { CodeInput } from '@/components/ui/form-controls/CodeInput'
import { TextInput } from '@/components/ui/form-controls/Field'
import { InputWithSubmit } from '@/components/ui/form-controls/InputWithSubmit'
import { SIGN_IN_COPY as COPY } from '@/lib/sign-in/words'

/** Figma's steps (SignInModal, 1174:12669): code resent and wrong code are the code step with `resent` and `wrong`. */
export type SignInStep = 'email' | 'code' | 'create'

/** Create your account's fields, as typed. */
export type NewAccount = { firstName: string; lastName: string; mobile: string; news: boolean }

/** A Worker refusal of create names the field it is about (W85a: `firstName`, `lastName`, `phone`). */
export type CreateErrors = { firstName?: string; lastName?: string; mobile?: string }

export type SignInModalProps = {
  step: SignInStep
  /** The heading's id: the dialog's name (aria-labelledby). */
  titleId: string
  /**
   * The Terms and Privacy pages Site settings picks (their /info/ slugs; W85 Level 3, as the checkout's ticks, WQ94).
   * Null or left out: that page isn't set, and its words are shown with no link.
   */
  termsHref?: string | null
  privacyHref?: string | null
  onClose: () => void
  closeButton?: RefObject<HTMLButtonElement | null>
  /** A press is on its way (sending the email, checking the code, creating the account). */
  busy?: boolean

  email: string
  onEmail: (email: string) => void
  /** The email step's error line: a wrong address, a refusal in the Worker's words, a fault. */
  emailError?: string | null
  onSendCode: () => void

  code: string
  onCode: (code: string) => void
  /** Step=wrong code. */
  wrong?: boolean
  /** Step=code resent: "Code sent" in Resend code's place. */
  resent?: boolean
  /** The code step's own error line, when it isn't a wrong code (too soon, a fault). */
  codeError?: string | null
  keepSignedIn: boolean
  onKeepSignedIn: (keep: boolean) => void
  onChangeEmail: () => void
  onResend: () => void

  account: NewAccount
  onAccount: (account: NewAccount) => void
  createErrors?: CreateErrors
  /** Create's error line that is about no one field (a fault, the email linked elsewhere). */
  createError?: string | null
  onCreate: () => void
}

const TITLES: Record<SignInStep, string> = { email: COPY.emailTitle, code: COPY.codeTitle, create: COPY.createTitle }

/** Figma's text link in Copy 12: Link 12, muted, underlined (the "Change" and "Resend code" of the code step). */
function LinkButton({ onClick, disabled = false, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-disabled={disabled} className="text-link-12 text-text-muted-primary transition-colors duration-short ease-smooth hover:text-text-primary">
      {children}
    </button>
  )
}

/** A line that tells of something wrong: Copy 12 in Text/Error, read out at once (Figma's wrong code words). */
function ErrorLine({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="text-copy-12 text-text-error">
      {children}
    </p>
  )
}

/**
 * Figma "SignInModal" (05 Modules > Sign-in, 1174:12669): Sign in or create an account in one flow, Dark, 462px wide
 * on Surface/Primary with 4px corners, 16px inside and 32px between its parts. ModalHeader (1150:12011): the step's
 * title in Label 12 with Close at the right (Figma's MenuButton). Its steps:
 * - email (1174:12629): InputWithSubmit "Email", then "By continuing, you agree to our Terms & Conditions and Privacy
 *   Policy" in Copy 12, muted, the two as Link 12 to the pages Site settings picks (their /info/ slugs; W85 Level 3,
 *   WQ94), or the words alone while a page isn't set;
 * - code (1174:12637): CodeInput, "Keep me signed in" (ticked at first: Wayne, 30 Nov), then "Sent to <email>" with
 *   Change and Resend code; code resent (1174:12645): "Code sent" in Resend code's place, for 6 seconds; wrong code
 *   (1174:12655): every box in its error state and Figma's words 8px beneath;
 * - create account (1174:12668): the intro in Copy 12, the email as it was given (not to be changed: it is the
 *   login's), First Name and Last Name side by side, Mobile (Optional), "Email me with news and offers", and Create
 *   account (Button Type=primary, Big=Yes; Figma draws it 48px, the kit's Big button is 40: W73's nearest step).
 * Words Figma doesn't draw (a wrong address, too soon, a fault, the Worker's refusals) are an error line in Copy 12,
 * Text/Error, 8px beneath the field they are about, as the wrong code's.
 *
 * Only what is drawn: the popup round it (the shade, the motion, focus, closing) is SignInPopup's
 * (components/frame/SignInHost.tsx).
 */
export function SignInModal(props: SignInModalProps) {
  const { step, titleId, onClose, closeButton } = props
  return (
    <div data-theme="dark" data-sign-in="modal" data-step={step} className="flex flex-col gap-32 rounded-s bg-surface-primary p-16">
      <div className="flex items-center justify-between gap-16">
        <h2 id={titleId} className="text-label-12 text-text-primary">
          {TITLES[step]}
        </h2>
        {/* Figma's CloseButton is 12px tall with the MenuButton's 8px round it: the button reaches past the row. */}
        <button ref={closeButton} type="button" onClick={onClose} className={`-my-8 ${FRAME_BUTTON}`}>
          <Icon name="close" />
          <FrameButtonLabel>{COPY.close}</FrameButtonLabel>
        </button>
      </div>
      {step === 'email' ? <EmailStep {...props} /> : step === 'code' ? <CodeStep {...props} /> : <CreateStep {...props} />}
    </div>
  )
}

/** A legal page's words: Link 12 to its page when Site settings picks one, else the words alone. */
function LegalLink({ href, children }: { href: string | null; children: string }) {
  return href ? (
    <TextLink href={href} size={12}>
      {children}
    </TextLink>
  ) : (
    <>{children}</>
  )
}

function EmailStep({ email, onEmail, emailError = null, onSendCode, busy = false, termsHref = null, privacyHref = null }: SignInModalProps) {
  const send = (event: FormEvent) => {
    event.preventDefault()
    if (!busy) onSendCode()
  }
  return (
    <>
      <form onSubmit={send} noValidate>
        <InputWithSubmit
          label={COPY.email}
          submitLabel={COPY.emailSubmit}
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          required
          value={email}
          onValue={onEmail}
          error={emailError}
          sending={busy}
        />
      </form>
      <p className="text-copy-12 text-text-muted-primary">
        {COPY.agreeStart}
        <LegalLink href={termsHref}>{COPY.terms}</LegalLink>
        {COPY.agreeAnd}
        <LegalLink href={privacyHref}>{COPY.privacy}</LegalLink>
      </p>
    </>
  )
}

function CodeStep({ email, code, onCode, wrong = false, resent = false, codeError = null, keepSignedIn, onKeepSignedIn, onChangeEmail, onResend, busy = false }: SignInModalProps) {
  const messageId = useId()
  const message = wrong ? COPY.wrongCode : codeError
  return (
    <>
      <div className="flex flex-col gap-8">
        <CodeInput label={COPY.code} value={code} onValue={onCode} invalid={wrong} {...(message ? { describedBy: messageId } : {})} />
        <div aria-live="assertive" className="empty:hidden">
          {message ? <ErrorLine id={messageId}>{message}</ErrorLine> : null}
        </div>
      </div>
      <Checkbox checked={keepSignedIn} onChange={onKeepSignedIn}>
        {COPY.keepSignedIn}
      </Checkbox>
      <div className="flex flex-wrap items-start gap-8 text-copy-12">
        <p className="text-copy-12 text-text-primary">{COPY.sentTo(email.trim())}</p>
        <LinkButton onClick={onChangeEmail}>{COPY.change}</LinkButton>
        {/* "Code sent" stands where Resend code was for 6 seconds, as Figma's code resent; it can't be pressed meanwhile. */}
        <span aria-live="polite">
          {resent ? <span className="text-link-12 text-text-muted-primary">{COPY.resent}</span> : <LinkButton onClick={onResend} disabled={busy}>{COPY.resend}</LinkButton>}
        </span>
      </div>
    </>
  )
}

function CreateStep({ email, account, onAccount, createErrors = {}, createError = null, onCreate, busy = false }: SignInModalProps) {
  const set = (change: Partial<NewAccount>) => onAccount({ ...account, ...change })
  const create = (event: FormEvent) => {
    event.preventDefault()
    if (!busy) onCreate()
  }
  return (
    <>
      <p className="text-copy-12 text-text-primary">{COPY.createIntro}</p>
      <form onSubmit={create} noValidate className="flex flex-col gap-12">
        <div className="flex flex-col gap-8">
          {/* The login's own email: shown as given, never changed here (the Worker reads it from the sign-in). */}
          <TextInput label={COPY.email} type="email" value={email.trim()} onValue={() => {}} readOnly aria-readonly="true" />
          <div className="flex items-start gap-8">
            <TextInput
              className="min-w-0 flex-1"
              label={COPY.firstName}
              name="given-name"
              autoComplete="given-name"
              required
              value={account.firstName}
              onValue={(firstName) => set({ firstName })}
              error={createErrors.firstName ?? null}
            />
            <TextInput
              className="min-w-0 flex-1"
              label={COPY.lastName}
              name="family-name"
              autoComplete="family-name"
              required
              value={account.lastName}
              onValue={(lastName) => set({ lastName })}
              error={createErrors.lastName ?? null}
            />
          </div>
          <TextInput label={COPY.mobile} type="tel" name="tel" autoComplete="tel" value={account.mobile} onValue={(mobile) => set({ mobile })} error={createErrors.mobile ?? null} />
        </div>
        <Checkbox checked={account.news} onChange={(news) => set({ news })}>
          {COPY.news}
        </Checkbox>
        <div className="flex flex-col gap-8">
          <BigButton type="submit" loading={busy}>
            {COPY.create}
          </BigButton>
          <div aria-live="assertive" className="empty:hidden">
            {createError ? <ErrorLine>{createError}</ErrorLine> : null}
          </div>
        </div>
      </form>
    </>
  )
}
