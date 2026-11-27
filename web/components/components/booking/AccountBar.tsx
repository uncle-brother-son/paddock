import { SecondaryButton } from '@/components/ui/buttons/Button'
import { signIn } from '@/lib/frame/sign-in'

/**
 * Figma "AccountBar" (04 Components > Booking, 1150:11972), State=Signed out: under the booking panel's calendar,
 * "Member? Log in to use your credits." with Log in at the right, which goes to the one sign-in seam (it opens
 * nothing yet). State=Signed in ("Logged in as", with Log out) waits for sign-in (WQ64).
 */
export function AccountBar() {
  return (
    <div data-book="account" className="flex items-center gap-16 rounded-s bg-surface-card py-8 pr-8 pl-16">
      <p className="min-w-0 flex-1 text-copy-12 text-text-primary">Member? Log in to use your credits.</p>
      <SecondaryButton onClick={() => signIn()}>Log in</SecondaryButton>
    </div>
  )
}
