'use client'

import { createContext, useContext } from 'react'

import type { Me } from '@/lib/sign-in/account'

/**
 * W85: who is signed in on this device, as the whole site sees it (components/frame/SignInHost.tsx):
 * - `checking`: not known yet (the page has just loaded, or a sign-in has just changed);
 * - `signed_out`: no one;
 * - `needs_details`: a login with no customer yet (a new email that hasn't finished Create your account);
 * - `signed_in`: a customer, with their first name, email and account sections (W85a's who am I);
 * - `unknown`: the Worker could not be asked: nothing is assumed, and no one is signed out for it.
 */
export type AccountState =
  | { status: 'checking' | 'signed_out' | 'unknown' }
  | { status: 'needs_details'; email: string }
  | { status: 'signed_in'; me: Me }

export type Account = {
  state: AccountState
  /** Asks again (after a sign-in, or when a page needs to be sure). */
  check: () => Promise<AccountState>
  /** Log out on this device: the session ends and the site is signed out. */
  logOut: () => Promise<void>
}

/** With no frame round it (a story of one component, a test): no one is signed in, and nothing can change that. */
const NO_ACCOUNT: Account = {
  state: { status: 'signed_out' },
  check: async () => ({ status: 'signed_out' }),
  logOut: async () => {},
}

export const AccountContext = createContext<Account>(NO_ACCOUNT)

export function useAccount(): Account {
  return useContext(AccountContext)
}
