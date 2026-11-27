'use client'

import { usePathname, useRouter } from 'next/navigation'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'

import { SignInModal, type CreateErrors, type NewAccount, type SignInStep } from '@/components/modules/sign-in/SignInModal'
import { Overlay } from '@/components/ui/media/Overlay'
import { usePopup } from '@/components/ui/usePopup'
import { listenForSignIn, type SignInRequest } from '@/lib/frame/sign-in'
import { looksLikeEmail, subscribeToNewsletter } from '@/lib/frame/newsletter'
import { PAGE_TRANSITION_TYPES } from '@/lib/motion/page-transition'
import { askCreate, askLink, askMe, type Linked, type Outcome } from '@/lib/sign-in/account'
import { FINISH_SIGN_IN } from '@/lib/sign-in/next'
import { noteKeepSignedIn, sendCode, signedInLogin, signOutHere, verifyCode, watchSignIn } from '@/lib/sign-in/supabase'
import { SIGN_IN_COPY as COPY } from '@/lib/sign-in/words'

import { AccountContext, type Account, type AccountState } from './useAccount'

/** How long "Code sent" stands in Resend code's place (Figma's code resent: 6 seconds). */
export const RESENT_FOR_MS = 6000

const EMPTY_ACCOUNT: NewAccount = { firstName: '', lastName: '', mobile: '', news: false }

/** A refusal of create, by the field it names (W85a: `firstName`, `lastName`, `phone`), or for the form. */
function createRefusal(field: string | null, message: string): { errors: CreateErrors; general: string | null } {
  if (field === 'firstName') return { errors: { firstName: message }, general: null }
  if (field === 'lastName') return { errors: { lastName: message }, general: null }
  if (field === 'phone') return { errors: { mobile: message }, general: null }
  return { errors: {}, general: message }
}

/**
 * Who is signed in on this device, asked of the Worker (W85a's who am I) with the login's token. A login the Worker
 * finds no customer for is linked (W85a's link: safe to ask again), so a member imported, a customer staff served or
 * a past guest has their account the first time they sign in. A login the Worker refuses (its email linked to
 * another sign-in) is signed out here, and its words given back.
 */
async function whoIsSignedIn(): Promise<{ state: AccountState; refusal: string | null }> {
  const login = await signedInLogin()
  if (!login) return { state: { status: 'signed_out' }, refusal: null }
  const me = await askMe(login.token)
  if (me.kind === 'ok') return { state: { status: 'signed_in', me: me.answer }, refusal: null }
  if (me.kind === 'signed_out') return { state: { status: 'signed_out' }, refusal: null }
  if (me.kind !== 'not_linked') return { state: { status: 'unknown' }, refusal: null }
  const linked = await askLink(login.token)
  if (linked.kind === 'refused') {
    await signOutHere()
    return { state: { status: 'signed_out' }, refusal: linked.refusal.message }
  }
  if (linked.kind === 'signed_out') return { state: { status: 'signed_out' }, refusal: null }
  if (linked.kind !== 'ok') return { state: { status: 'unknown' }, refusal: null }
  if (linked.answer.status === 'needs_details') return { state: { status: 'needs_details', email: login.email }, refusal: null }
  const again = await askMe(login.token)
  return { state: again.kind === 'ok' ? { status: 'signed_in', me: again.answer } : { status: 'unknown' }, refusal: null }
}

/** Where the popup starts: Create your account for a login with no customer yet, else the email. */
type Opening = { request: SignInRequest; step: SignInStep; email: string; emailError: string | null }

/**
 * The frame's sign-in (W85; docs/url-map.md: a popup over the page the visitor is on, with no address of its own):
 * gives everything inside the frame `useAccount()`, listens on the one `signIn()` seam (lib/frame/sign-in.ts), and
 * draws SignInPopup after the page and the booking panel, so it sits over both.
 */
export function SignInHost({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AccountState>({ status: 'checking' })
  const [opening, setOpening] = useState<Opening | null>(null)
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  const check = useCallback(async (): Promise<AccountState> => {
    const { state: now, refusal } = await whoIsSignedIn()
    setState(now)
    // Back from the email's link (/auth/confirm): what is left to do is shown at once.
    if (sessionStorage.getItem(FINISH_SIGN_IN) !== null) {
      sessionStorage.removeItem(FINISH_SIGN_IN)
      if (now.status === 'needs_details') setOpening({ request: {}, step: 'create', email: now.email, emailError: null })
      else if (refusal) setOpening({ request: {}, step: 'email', email: '', emailError: refusal })
    }
    return now
  }, [])

  // The first look (Supabase's first word on this browser's session), then again whenever it signs in or out.
  useEffect(() => watchSignIn(() => void check()), [check])

  useEffect(
    () =>
      listenForSignIn((request) => {
        const now = stateRef.current
        setOpening({ request, step: now.status === 'needs_details' ? 'create' : 'email', email: now.status === 'needs_details' ? now.email : '', emailError: null })
      }),
    []
  )

  const logOut = useCallback(async () => {
    await signOutHere()
    setState({ status: 'signed_out' })
  }, [])

  const account = useMemo<Account>(() => ({ state, check, logOut }), [state, check, logOut])

  return (
    <AccountContext value={account}>
      {children}
      <SignInPopup opening={opening} onDone={() => setOpening(null)} check={check} status={state.status} />
    </AccountContext>
  )
}

type SignInPopupProps = {
  /** Open, and how it starts; null: shut. */
  opening: Opening | null
  /** Shut it (closed, or signed in). */
  onDone: () => void
  check: () => Promise<AccountState>
  /** Who is signed in, marked on the popup's layer for tests (`data-account`). */
  status: AccountState['status']
}

/**
 * The sign-in popup (W85; Figma SignInModal over a page, 917:2996; on a phone 1176:19632, 1176:19680, 1176:19757):
 * SignInModal on Wayne's Overlay, in the middle of the window from 768px and 16px in from the sides, 80px down, on a
 * phone. It slides up from below the window as the booking panel does, with no fade of its own, while the shade fades
 * in, over the short duration with the smooth curve (WQ88, 320 ms); with reduced motion it is just there or not.
 *
 * Passwordless (Supabase): the email is sent a code and a link back to the page (lib/sign-in/supabase.ts); the six
 * digits, once all are in, are checked; then W85a's link: a customer is signed in, and the popup closes back to the
 * page (or goes on to the page asked for: /account from the header's Account); a new email is shown Create your
 * account. The Worker's refusals are shown in its own words. A popup by the build standards (usePopup): focus moves to
 * the step's first field; the page (and the booking panel, when it opened over it) is inert and still; Esc, Close and
 * the shade close it; focus goes back to what opened it.
 */
function SignInPopup({ opening, onDone, check, status }: SignInPopupProps) {
  const router = useRouter()
  const pathname = usePathname()
  const titleId = useId()
  const popup = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const open = opening !== null

  const [step, setStep] = useState<SignInStep>('email')
  const [email, setEmail] = useState('')
  const [emailError, setEmailError] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [wrong, setWrong] = useState(false)
  const [resent, setResent] = useState(false)
  const [codeError, setCodeError] = useState<string | null>(null)
  const [keepSignedIn, setKeepSignedIn] = useState(true)
  const [account, setAccount] = useState<NewAccount>(EMPTY_ACCOUNT)
  const [createErrors, setCreateErrors] = useState<CreateErrors>({})
  const [createError, setCreateError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Each opening starts afresh, where the opening says.
  const [shown, setShown] = useState<Opening | null>(null)
  if (opening !== shown) {
    setShown(opening)
    if (opening) {
      setStep(opening.step)
      setEmail(opening.email)
      setEmailError(opening.emailError)
      setCode('')
      setWrong(false)
      setResent(false)
      setCodeError(null)
      setKeepSignedIn(true)
      setAccount(EMPTY_ACCOUNT)
      setCreateErrors({})
      setCreateError(null)
      setBusy(false)
    }
  }

  const request = opening?.request
  const giveUp = useCallback(() => {
    request?.onGiveUp?.()
    onDone()
  }, [request, onDone])

  // usePopup focuses Close first; the step's first field to type in then takes it (and again at each new step).
  usePopup({ open, onClose: giveUp, popup, firstFocus: closeButton })
  useEffect(() => {
    if (!open) return
    // Without scrolling: while it slides in from below, the layer would scroll to where the field isn't yet.
    popup.current?.querySelector<HTMLInputElement>('input:not([readonly])')?.focus({ preventScroll: true })
  }, [open, step])

  // "Code sent" goes back to Resend code after 6 seconds.
  useEffect(() => {
    if (!resent) return
    const timer = window.setTimeout(() => setResent(false), RESENT_FOR_MS)
    return () => window.clearTimeout(timer)
  }, [resent])

  /** Signed in with a customer: shut, and on to the page asked for when it isn't this one. */
  const signedIn = useCallback(async () => {
    await check()
    const next = request?.next
    onDone()
    if (next && next !== pathname) router.push(next, { transitionTypes: PAGE_TRANSITION_TYPES })
  }, [check, request, pathname, onDone, router])

  /** After the code: W85a's link, and what it says next. */
  const afterCode = async () => {
    const login = await signedInLogin()
    const linked: Outcome<Linked> = login ? await askLink(login.token) : { kind: 'signed_out' }
    if (linked.kind === 'ok') {
      if (linked.answer.status === 'linked') return signedIn()
      setStep('create')
      void check()
      return
    }
    if (linked.kind === 'refused') {
      await signOutHere()
      void check()
      setStep('email')
      setEmailError(linked.refusal.message)
      return
    }
    setCodeError(COPY.fault)
  }

  const sendTo = async (): Promise<'sent' | string> => {
    const result = await sendCode(email, request?.next ?? pathname)
    if (result === 'sent') return 'sent'
    return result === 'too_soon' ? COPY.tooSoon : result === 'invalid_email' ? COPY.invalidEmail : COPY.fault
  }

  const onSendCode = async () => {
    if (!looksLikeEmail(email)) return setEmailError(COPY.invalidEmail)
    setBusy(true)
    setEmailError(null)
    const result = await sendTo()
    setBusy(false)
    if (result !== 'sent') return setEmailError(result)
    // A sign-in lasts until log out unless the box is unticked (Wayne, 30 Nov: ticked at first).
    setKeepSignedIn(true)
    noteKeepSignedIn(true)
    setCode('')
    setWrong(false)
    setCodeError(null)
    setStep('code')
  }

  const onResend = async () => {
    if (busy || resent) return
    setBusy(true)
    setCodeError(null)
    const result = await sendTo()
    setBusy(false)
    if (result !== 'sent') return setCodeError(result)
    setCode('')
    setWrong(false)
    setResent(true)
  }

  const onCode = async (typed: string) => {
    setCode(typed)
    setWrong(false)
    setCodeError(null)
    if (typed.length < 6 || busy) return
    setBusy(true)
    noteKeepSignedIn(keepSignedIn)
    const result = await verifyCode(email, typed)
    if (result === 'signed_in') await afterCode()
    else if (result === 'wrong') setWrong(true)
    else setCodeError(result === 'too_soon' ? COPY.tooSoon : COPY.fault)
    setBusy(false)
  }

  const onKeepSignedIn = (keep: boolean) => {
    setKeepSignedIn(keep)
    noteKeepSignedIn(keep)
  }

  const onChangeEmail = () => {
    setStep('email')
    setCode('')
    setWrong(false)
    setCodeError(null)
  }

  const onCreate = async () => {
    setBusy(true)
    setCreateErrors({})
    setCreateError(null)
    const login = await signedInLogin()
    const made: Outcome<Linked> = login
      ? await askCreate(login.token, { firstName: account.firstName, lastName: account.lastName, phone: account.mobile.trim() || null, marketingConsent: account.news })
      : { kind: 'signed_out' }
    if (made.kind === 'ok') {
      // Kept for the newsletter's own sign-up (Klaviyo, later): the tick itself is saved by the Worker.
      if (account.news && login) void subscribeToNewsletter(login.email)
      setBusy(false)
      return signedIn()
    }
    setBusy(false)
    if (made.kind === 'refused') {
      if (made.refusal.reason === 'email_linked_elsewhere') {
        await signOutHere()
        void check()
      }
      const { errors, general } = createRefusal(made.refusal.field, made.refusal.message)
      setCreateErrors(errors)
      setCreateError(general)
      return
    }
    setCreateError(COPY.fault)
  }

  return (
    // A layer of its own above the booking panel (both are z-30; this one comes later), holding its own shade.
    <div data-frame-popup="" className="pointer-events-none fixed inset-0 z-30">
      {/* The shade is drawn here; a press on it lands on the layer above it, which closes the popup as the shade would. */}
      <Overlay open={open} />
      <div
        data-lenis-prevent=""
        data-sign-in="layer"
        data-account={status}
        className={`absolute inset-0 flex flex-col overflow-y-auto ${open ? 'pointer-events-auto' : ''}`}
        onClick={(event) => event.target === event.currentTarget && giveUp()}
      >
        <div
          ref={popup}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          data-sign-in="popup"
          // On a phone 16px in from the sides and 80px down (Figma 1176:19632 draws 96, which is no step of the spacing
          // scale: the nearest, 80, as W73's rule); from 768px 462px wide in the middle of the window (917:2996), by
          // its margins, so a popup taller than the window scrolls from its top. Shut, it waits below the window; shown
          // at once on opening, so focus can move in, and hidden once it has slid away.
          className={`mx-16 mt-80 mb-16 duration-short ease-smooth md:m-auto md:w-[462px] ${open ? 'visible translate-y-0 transition-[translate]' : 'invisible translate-y-[100dvh] transition-[translate,visibility]'}`}
        >
          {shown ? (
            <SignInModal
              step={step}
              titleId={titleId}
              onClose={giveUp}
              closeButton={closeButton}
              busy={busy}
              email={email}
              onEmail={(typed) => {
                setEmail(typed)
                setEmailError(null)
              }}
              emailError={emailError}
              onSendCode={() => void onSendCode()}
              code={code}
              onCode={(typed) => void onCode(typed)}
              wrong={wrong}
              resent={resent}
              codeError={codeError}
              keepSignedIn={keepSignedIn}
              onKeepSignedIn={onKeepSignedIn}
              onChangeEmail={onChangeEmail}
              onResend={() => void onResend()}
              account={account}
              onAccount={setAccount}
              createErrors={createErrors}
              createError={createError}
              onCreate={() => void onCreate()}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}
