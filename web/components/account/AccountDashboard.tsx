'use client'

import { useAccount } from '@/components/frame/useAccount'

/**
 * The Dashboard (W85; Figma "Account — Dashboard (Sparse)", 1231:27378): for now its greeting, "Hey <first name>",
 * in H1, the page's heading. Its cards (store credit, your next visit, your info, your preferences) and their 24px
 * gaps come with the Account brief. Drawn inside AccountShell, which shows it only to a signed-in customer.
 */
export function AccountDashboard() {
  const { state } = useAccount()
  if (state.status !== 'signed_in') return null
  return (
    <div data-account="dashboard" className="flex flex-col gap-24">
      <h1 className="text-h1 text-text-primary">Hey {state.me.firstName}</h1>
    </div>
  )
}

/**
 * An account section whose page comes with the Account brief (W85 builds the menu and its redirects only): its name,
 * for a screen reader, so the page has its heading.
 */
export function AccountSectionToCome({ label }: { label: string }) {
  return <h1 className="sr-only">{label}</h1>
}
