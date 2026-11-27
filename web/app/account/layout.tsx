import type { Metadata } from 'next'
import type { ReactNode } from 'react'

import { AccountShell } from '@/components/account/AccountShell'

// The account (W85; docs/url-map.md, Account: all signed in). Every /account page sits in AccountShell: the menu of the
// sections this customer sees, the sign-in popup for a visitor who isn't signed in, and /account for a section they
// can't see. Kept out of search (docs/build-standards.md, section 2: /account/**), as robots.txt says.

export const metadata: Metadata = {
  title: 'Account',
  robots: { index: false, follow: false },
}

export default function AccountLayout({ children }: { children: ReactNode }) {
  return <AccountShell>{children}</AccountShell>
}
