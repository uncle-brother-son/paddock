import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, fn, userEvent } from 'storybook/test'

import { painted } from '@/components/ui/story-kit'
import { ACCOUNT_SECTIONS } from '@/contracts/sign-in'
import { LOG_OUT } from '@/lib/account/sections'

import { AccountNav, LOG_OUT_CHOICE } from './AccountNav'

// Brief W85: Figma's AccountNav (05 Modules > Account, 1137:10804) with the fewest sections a customer can have (a new
// account: Dashboard, Personal info, Preferences) and with all of them (backend log 25), on a desktop (the list) and on
// a phone (Figma's Select, Log out its last choice: Wayne, 30 Nov).

const FEWEST = ['dashboard', 'details', 'preferences'] as const

const meta = {
  title: 'Modules/Account/AccountNav',
  component: AccountNav,
  parameters: { nextjs: { appDirectory: true } },
  args: { sections: [...FEWEST], active: 'dashboard', onLogOut: fn() },
  decorators: [
    (Story) => (
      <div className="w-[284px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AccountNav>

export default meta
type Story = StoryObj<typeof meta>

const DESKTOP = { viewport: { value: 'desktop', isRotated: false } }
const MOBILE = { viewport: { value: 'mobile', isRotated: false } }

/** Active=Dashboard with a new account's three sections: the page's own in Text/Primary, the rest muted; Log out 32px under them. */
export const Fewest: Story = {
  name: 'Active=Dashboard, the fewest sections',
  globals: DESKTOP,
  play: async ({ canvas, args }) => {
    const links = canvas.getAllByRole('link')
    await expect(links.map((link) => link.textContent)).toEqual(['Dashboard', 'Personal info', 'Preferences'])
    await expect(links.map((link) => link.getAttribute('href'))).toEqual(['/account', '/account/details', '/account/preferences'])
    await expect(links[0]).toHaveAttribute('aria-current', 'page')
    const [primary, muted] = [painted(links[0]!, 'text-text-primary', 'color'), painted(links[0]!, 'text-text-muted-primary', 'color')]
    await expect(links.map((link) => getComputedStyle(link).color)).toEqual([primary, muted, muted])
    const logOut = canvas.getByRole('button', { name: LOG_OUT })
    await expect(Math.round(logOut.getBoundingClientRect().top - links[2]!.getBoundingClientRect().bottom)).toBe(32)
    await userEvent.click(logOut)
    await expect(args.onLogOut).toHaveBeenCalledTimes(1)
  },
}

/** Active=Bookings with every section, in the menu's order. */
export const All: Story = {
  name: 'Active=Bookings, every section',
  globals: DESKTOP,
  args: { sections: [...ACCOUNT_SECTIONS], active: 'bookings' },
  play: async ({ canvas }) => {
    await expect(canvas.getAllByRole('link').map((link) => link.textContent)).toEqual(['Dashboard', 'Bookings', 'Events', 'Orders', 'Membership', 'Passes', 'Store credit', 'Personal info', 'Preferences'])
    await expect(canvas.getByRole('link', { name: 'Bookings' })).toHaveAttribute('aria-current', 'page')
  },
}

/** On a phone, Figma's Select showing the page's section; its choices are the sections, then Log out. */
export const FewestMobile: Story = {
  name: 'On a phone, the fewest sections',
  globals: MOBILE,
  parameters: { layout: 'fullscreen' },
  play: async ({ canvas, args }) => {
    const select = canvas.getByRole('combobox', { name: 'Account section' })
    await expect(select).toHaveValue('dashboard')
    await expect([...(select as HTMLSelectElement).options].map((option) => option.textContent)).toEqual(['Dashboard', 'Personal info', 'Preferences', LOG_OUT])
    await userEvent.selectOptions(select, LOG_OUT_CHOICE)
    await expect(args.onLogOut).toHaveBeenCalledTimes(1)
  },
}

export const AllMobile: Story = {
  name: 'On a phone, every section',
  globals: MOBILE,
  parameters: { layout: 'fullscreen' },
  args: { sections: [...ACCOUNT_SECTIONS], active: 'store_credit' },
  play: async ({ canvas, canvasElement }) => {
    const select = canvas.getByRole('combobox', { name: 'Account section' })
    await expect((select as HTMLSelectElement).options).toHaveLength(ACCOUNT_SECTIONS.length + 1)
    await expect(canvasElement.querySelector('[data-select] span')?.textContent).toBe('Store credit')
  },
}
