import { AccountSectionToCome } from '@/components/account/AccountDashboard'
import { SECTION_PAGES, sectionOf } from '@/lib/account/sections'

// Every other /account address (W85): the sections whose pages come with the Account brief, and anything else.
// AccountShell (the layout) shows a section the customer sees with its menu, and sends a section they can't see, or
// an address that is no section, to /account (docs/url-map.md, Redirects). A section's own page, when it is built,
// is a folder of its own beside this one (/account/bookings/page.tsx), which Next takes before this.

type Props = { params: Promise<{ section: string[] }> }

export default async function AccountSectionPage({ params }: Props) {
  const { section } = await params
  const found = sectionOf(`/account/${section.join('/')}`)
  return found ? <AccountSectionToCome label={SECTION_PAGES[found].label} /> : null
}
