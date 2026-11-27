import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, fn } from 'storybook/test'

import { AccountContext, type Account } from '@/components/frame/useAccount'
import type { AccountSection } from '@/contracts/sign-in'

import { AccountDashboard } from './AccountDashboard'
import { AccountShell } from './AccountShell'

// Brief W85: the account's layout with its Dashboard (Figma "Account — Dashboard (Sparse)", 1231:27378; on a phone
// 1231:28363): the menu and the greeting. Its cards come with the Account brief.

const signedIn = (sections: AccountSection[]): Account => ({
  state: { status: 'signed_in', me: { firstName: 'Bob', email: 'bob@gmail.com', sections } },
  check: fn(async () => ({ status: 'signed_out' as const })),
  logOut: fn(async () => {}),
})

const meta = {
  title: 'Account/Dashboard',
  component: AccountShell,
  parameters: { layout: 'fullscreen', nextjs: { appDirectory: true, navigation: { pathname: '/account' } } },
  args: { children: <AccountDashboard /> },
  render: (args) => (
    <AccountContext value={signedIn(['dashboard', 'orders', 'store_credit', 'details', 'preferences'])}>
      <main className="flex min-h-dvh flex-col">
        <AccountShell {...args} />
      </main>
    </AccountContext>
  ),
} satisfies Meta<typeof AccountShell>

export default meta
type Story = StoryObj<typeof meta>

/** "Hey Bob" in H1, the menu in the grid's first 5 columns and the page from the 7th, as Figma's Dashboard (Sparse). */
export const Sparse: Story = {
  name: 'Dashboard (Sparse)',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const heading = canvas.getByRole('heading', { level: 1, name: 'Hey Bob' })
    await expect(getComputedStyle(heading).fontSize).toBe('28px')
    await expect(canvas.getAllByRole('link').map((link) => link.textContent)).toEqual(['Dashboard', 'Orders', 'Store credit', 'Personal info', 'Preferences'])
    const nav = canvasElement.querySelector('[data-account="nav"]') as HTMLElement
    const page = canvasElement.querySelector('[data-account="page"]') as HTMLElement
    await expect(page.getBoundingClientRect().left).toBeGreaterThan(nav.getBoundingClientRect().right)
  },
}

/** On a phone: Figma's Select, then the page 32px under it. */
export const SparseMobile: Story = {
  name: 'Dashboard (Sparse), on a phone',
  globals: { viewport: { value: 'mobile', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const select = canvasElement.querySelector('[data-select]') as HTMLElement
    const heading = canvas.getByRole('heading', { level: 1, name: 'Hey Bob' })
    await expect(Math.round(heading.getBoundingClientRect().top - select.getBoundingClientRect().bottom)).toBe(32)
  },
}
