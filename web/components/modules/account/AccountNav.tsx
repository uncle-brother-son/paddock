'use client'

import { useRouter } from 'next/navigation'

import { Select } from '@/components/ui/form-controls/Select'
import { SiteLink } from '@/components/ui/SiteLink'
import type { AccountSection } from '@/contracts/sign-in'
import { LOG_OUT, SECTION_PAGES } from '@/lib/account/sections'
import { PAGE_TRANSITION_TYPES } from '@/lib/motion/page-transition'

/** The phone's list: the value that is Log out rather than a section. */
export const LOG_OUT_CHOICE = 'log-out'

type AccountNavProps = {
  /** The sections this customer sees, in the menu's order (W85a's who am I). */
  sections: readonly AccountSection[]
  /** The section the page belongs to (a detail page is its section's). */
  active: AccountSection
  onLogOut: () => void
}

/**
 * Figma "AccountNav" (05 Modules > Account, 1137:10804; on the Dashboard 1231:27378): the account's menu, only the
 * sections this customer sees (backend log 25). From 768px a list in Label 12, 16px apart, the page's own section in
 * Text/Primary and the rest in Text/Muted Primary, with Log out 32px under them in Copy 14, muted. On a phone it is
 * Figma's Select (1231:28748) showing the page's section, a choice of which goes to that section; Log out is its last
 * choice (Wayne, 30 Nov).
 */
export function AccountNav({ sections, active, onLogOut }: AccountNavProps) {
  const router = useRouter()
  const choices = [...sections.map((section) => ({ value: section, label: SECTION_PAGES[section].label })), { value: LOG_OUT_CHOICE, label: LOG_OUT }]

  const choose = (value: string) => {
    if (value === LOG_OUT_CHOICE) return onLogOut()
    const page = sections.find((section) => section === value)
    if (page && page !== active) router.push(SECTION_PAGES[page].path, { transitionTypes: PAGE_TRANSITION_TYPES })
  }

  return (
    <nav aria-label="Account" data-account="nav">
      <Select className="md:hidden" label="Account section" value={active} options={choices} onValue={choose} />
      <div className="hidden flex-col gap-32 md:flex">
        <ul className="flex flex-col gap-16">
          {sections.map((section) => (
            <li key={section}>
              <SiteLink
                href={SECTION_PAGES[section].path}
                {...(section === active ? { 'aria-current': 'page' as const } : {})}
                className={`relative block text-label-12 after:absolute after:-inset-y-4 after:inset-x-0 ${section === active ? 'text-text-primary' : 'text-text-muted-primary'}`}
              >
                {SECTION_PAGES[section].label}
              </SiteLink>
            </li>
          ))}
        </ul>
        <button type="button" onClick={onLogOut} className="self-start text-copy-14 text-text-muted-primary">
          {LOG_OUT}
        </button>
      </div>
    </nav>
  )
}
