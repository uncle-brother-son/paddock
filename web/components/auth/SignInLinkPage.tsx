'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Fence } from '@/components/brand/Logo'
import { useAccount } from '@/components/frame/useAccount'
import { Grid } from '@/components/layout/Grid'
import { SecondaryButton } from '@/components/ui/buttons/Button'
import { signIn } from '@/lib/frame/sign-in'
import { PAGE_TRANSITION_TYPES } from '@/lib/motion/page-transition'
import { FINISH_SIGN_IN, returnPath } from '@/lib/sign-in/next'
import { LINK_COPY as COPY, SIGN_IN_COPY } from '@/lib/sign-in/words'

/** Where the page stands: the button, using the link up, or a link that can't be used. */
export type SignInLinkState = 'ready' | 'signing_in' | 'expired'

type SignInLinkPageProps = {
  /** The email's token hash; null when the address has none (then the link is as good as used). */
  tokenHash: string | null
  /** The page to go back to, as the email gave it (W85a: this site's address and path). */
  next: string | null
  /** Uses the link up on the server (app/auth/confirm/actions.ts). */
  confirm: (tokenHash: string) => Promise<'signed_in' | 'expired' | 'fault'>
  /** For Storybook: where the page starts. */
  initialState?: SignInLinkState
}

/**
 * The email link page (W85; backend log 27). Figma draws two states: "Signing in" (1180:24731; on a phone 1180:24786),
 * Figma's generic loading screen, the Fence alone in the middle; and "Link expired or used" (1180:24831; 1180:24885):
 * SIGN IN in Label 12, the heading in H1, a line in Copy 12, muted, and "Send a new link" (Button Type=secondary), 32px
 * apart, in 12 of the grid's columns from the 7th, 160px down (the header's height and Figma's 80; 120 on a phone).
 * The page before the button is pressed is not drawn: it is the expired page's layout with its own words and a Sign
 * in button (Wayne, 30 Nov).
 *
 * Sign in uses the link up on the server, then goes to the page the visitor started from, only when it is a page of
 * this site (else home). There the frame links the login to its customer (W85a), and a new email is shown Create your
 * account at once. "Send a new link" opens the sign-in popup, going back to the same page.
 */
export function SignInLinkPage({ tokenHash, next, confirm, initialState }: SignInLinkPageProps) {
  const router = useRouter()
  const { check } = useAccount()
  const [state, setState] = useState<SignInLinkState>(initialState ?? (tokenHash ? 'ready' : 'expired'))
  const [fault, setFault] = useState(false)

  const goBackTo = (): string => returnPath(next, window.location.origin)

  const press = async () => {
    if (!tokenHash || state === 'signing_in') return
    setFault(false)
    setState('signing_in')
    const result = await confirm(tokenHash)
    if (result === 'expired') return setState('expired')
    if (result === 'fault') {
      setFault(true)
      return setState('ready')
    }
    // Signed in: the page gone back to finishes it (a new email: Create your account, over that page).
    sessionStorage.setItem(FINISH_SIGN_IN, '1')
    router.replace(goBackTo(), { transitionTypes: PAGE_TRANSITION_TYPES })
    void check()
  }

  if (state === 'signing_in') {
    return (
      <section data-sign-in-link="signing-in" className="flex min-h-dvh flex-1 items-center justify-center">
        <h1 className="sr-only">{COPY.signingIn}</h1>
        <Fence decorative className="text-text-primary" />
        <p role="status" className="sr-only">
          {COPY.signingIn}
        </p>
      </section>
    )
  }

  const expired = state === 'expired'
  return (
    <Grid as="section" data-sign-in-link={state} className="pt-120 pb-120 md:pt-160">
      <div className="col-span-full flex flex-col items-start gap-32 md:col-span-12 md:col-start-7">
        <p className="text-label-12 text-text-primary">{COPY.eyebrow}</p>
        <h1 className="text-h1 text-text-primary">{expired ? COPY.expiredTitle : COPY.readyTitle}</h1>
        <p className="text-copy-12 text-text-muted-primary">{expired ? COPY.expiredText : COPY.readyText}</p>
        <div className="flex flex-col items-start gap-8">
          {expired ? (
            <SecondaryButton onClick={() => signIn({ next: goBackTo() })}>{COPY.sendNewLink}</SecondaryButton>
          ) : (
            <SecondaryButton onClick={() => void press()}>{COPY.signIn}</SecondaryButton>
          )}
          <div aria-live="assertive" className="empty:hidden">
            {fault ? <p className="text-copy-12 text-text-error">{SIGN_IN_COPY.fault}</p> : null}
          </div>
        </div>
      </div>
    </Grid>
  )
}
