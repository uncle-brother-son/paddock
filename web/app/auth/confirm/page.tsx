import type { Metadata } from 'next'

import { SignInLinkPage } from '@/components/auth/SignInLinkPage'

import { confirmSignIn } from './actions'

// /auth/confirm?token_hash=&type=email&next= (W85; backend log 27; docs/url-map.md, Links from emails): where the sign-in
// email's Sign in button lands. A page with a Sign in button: nothing is used up until it is pressed. Kept out of
// search (docs/build-standards.md, section 2: /auth/**).

export const metadata: Metadata = {
  title: 'Sign in',
  robots: { index: false, follow: false },
}

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

const one = (value: string | string[] | undefined): string | null => (typeof value === 'string' ? value : null)

export default async function SignInLink({ searchParams }: Props) {
  const params = await searchParams
  return <SignInLinkPage tokenHash={one(params.token_hash)} next={one(params.next)} confirm={confirmSignIn} />
}
