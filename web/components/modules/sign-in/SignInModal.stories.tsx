import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useState } from 'react'
import { expect, fn, userEvent, waitFor } from 'storybook/test'

import { SIGN_IN_COPY as COPY } from '@/lib/sign-in/words'

import { SignInModal, type NewAccount, type SignInModalProps } from './SignInModal'

// Brief W85: Figma's SignInModal (05 Modules > Sign-in, 1174:12669), each of its steps under Figma's own name, on a
// desktop (462px, as drawn) and on a phone (16px in from the window's sides, 1176:19632, 1176:19680, 1176:19757), and the
// states Figma doesn't draw: an error from W85a, and a name W85a asks for. The popup round it (the shade, the slide,
// focus, closing) is the frame's: Frame/Sign-in popup.

const BOB = 'bob@gmail.com'
const NO_ACCOUNT: NewAccount = { firstName: '', lastName: '', mobile: '', news: false }

const base: SignInModalProps = {
  step: 'email',
  titleId: 'sign-in-title',
  onClose: fn(),
  email: '',
  onEmail: fn(),
  onSendCode: fn(),
  code: '',
  onCode: fn(),
  keepSignedIn: true,
  onKeepSignedIn: fn(),
  onChangeEmail: fn(),
  onResend: fn(),
  account: NO_ACCOUNT,
  onAccount: fn(),
  onCreate: fn(),
}

/** The modal with what is typed into it kept, as the popup keeps it: so a story can be typed into. */
function Typed(props: SignInModalProps) {
  const [email, setEmail] = useState(props.email)
  const [code, setCode] = useState(props.code)
  const [keep, setKeep] = useState(props.keepSignedIn)
  const [account, setAccount] = useState(props.account)
  return (
    <div role="dialog" aria-modal="true" aria-labelledby={props.titleId}>
      <SignInModal
        {...props}
        email={email}
        onEmail={(typed) => {
          setEmail(typed)
          props.onEmail(typed)
        }}
        code={code}
        onCode={(typed) => {
          setCode(typed)
          props.onCode(typed)
        }}
        keepSignedIn={keep}
        onKeepSignedIn={(ticked) => {
          setKeep(ticked)
          props.onKeepSignedIn(ticked)
        }}
        account={account}
        onAccount={(typed) => {
          setAccount(typed)
          props.onAccount(typed)
        }}
      />
    </div>
  )
}

const meta = {
  title: 'Modules/Sign-in/SignInModal',
  component: SignInModal,
  parameters: { layout: 'fullscreen', nextjs: { appDirectory: true } },
  args: base,
  render: (args) => <Typed {...args} />,
  // As the popup places it: 462px wide from 768px (Figma 917:2996), 16px in from the sides on a phone.
  decorators: [
    (Story) => (
      <div className="p-16 md:p-32">
        <div className="md:w-[462px]">
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof SignInModal>

export default meta
type Story = StoryObj<typeof meta>

const DESKTOP = { viewport: { value: 'desktop', isRotated: false } }
const MOBILE = { viewport: { value: 'mobile', isRotated: false } }

const box = (element: Element) => element.getBoundingClientRect()

/** Step=email (1174:12629): the heading, Close, the email field with its arrow, and the terms in Copy 12. */
export const Email: Story = {
  name: 'Step=email',
  globals: DESKTOP,
  play: async ({ canvas, canvasElement, args }) => {
    const modal = canvasElement.querySelector('[data-sign-in="modal"]') as HTMLElement
    await expect(Math.round(box(modal).width)).toBe(462)
    await expect(canvas.getByRole('heading', { name: COPY.emailTitle })).toBeVisible()
    await expect(canvas.getByRole('link', { name: COPY.terms })).toHaveAttribute('href', '/info/terms')
    await expect(canvas.getByRole('link', { name: COPY.privacy })).toHaveAttribute('href', '/info/privacy')
    // The arrow sends the email: the field's form is submitted.
    await userEvent.type(canvas.getByRole('textbox', { name: COPY.email }), BOB)
    await userEvent.click(canvas.getByRole('button', { name: COPY.emailSubmit }))
    await expect(args.onSendCode).toHaveBeenCalledTimes(1)
    await userEvent.click(canvas.getByRole('button', { name: COPY.close }))
    await expect(args.onClose).toHaveBeenCalledTimes(1)
  },
}

export const EmailMobile: Story = { ...Email, name: 'Step=email, on a phone', globals: MOBILE, play: undefined }

/** Step=code (1174:12637): six boxes, "Keep me signed in" ticked at first (Wayne, 30 Nov), "Sent to" with Change and Resend code. */
export const Code: Story = {
  name: 'Step=code',
  globals: DESKTOP,
  args: { step: 'code', email: BOB },
  play: async ({ canvas, args }) => {
    await expect(canvas.getByRole('heading', { name: COPY.codeTitle })).toBeVisible()
    await expect(canvas.getByRole('group', { name: COPY.code })).toBeVisible()
    await expect(canvas.getByRole('checkbox', { name: COPY.keepSignedIn })).toBeChecked()
    await expect(canvas.getByText(`Sent to ${BOB}`)).toBeVisible()
    // A whole code pasted fills the six boxes (the phone's one-time-code autofill arrives the same way).
    const first = canvas.getByRole('textbox', { name: 'Digit 1 of 6' })
    await userEvent.click(first)
    await userEvent.paste('123456')
    await waitFor(() => expect(args.onCode).toHaveBeenLastCalledWith('123456'))
    await userEvent.click(canvas.getByRole('checkbox', { name: COPY.keepSignedIn }))
    await expect(args.onKeepSignedIn).toHaveBeenLastCalledWith(false)
    await userEvent.click(canvas.getByRole('button', { name: COPY.resend }))
    await expect(args.onResend).toHaveBeenCalledTimes(1)
    await userEvent.click(canvas.getByRole('button', { name: COPY.change }))
    await expect(args.onChangeEmail).toHaveBeenCalledTimes(1)
  },
}

export const CodeMobile: Story = { ...Code, name: 'Step=code, on a phone', globals: MOBILE, play: undefined }

/** Step=code resent (1174:12645): "Code sent" where Resend code was (for 6 seconds: the popup's). */
export const CodeResent: Story = {
  name: 'Step=code resent',
  globals: DESKTOP,
  args: { step: 'code', email: BOB, resent: true },
  play: async ({ canvas }) => {
    await expect(canvas.getByText(COPY.resent)).toBeVisible()
    await expect(canvas.queryByRole('button', { name: COPY.resend })).toBeNull()
  },
}

/** Step=wrong code (1174:12655): every box in its error state, and Figma's words 8px beneath, read with each box. */
export const WrongCode: Story = {
  name: 'Step=wrong code',
  globals: DESKTOP,
  args: { step: 'code', email: BOB, code: '123456', wrong: true },
  play: async ({ canvas }) => {
    const words = canvas.getByText(COPY.wrongCode)
    await expect(words).toBeVisible()
    const boxes = canvas.getAllByRole('textbox')
    await expect(boxes.every((field) => field.getAttribute('aria-invalid') === 'true')).toBe(true)
    await expect(boxes[0]?.getAttribute('aria-describedby')).toBe(words.id)
    await expect(Math.round(box(words).top - box(boxes[0]!).bottom)).toBe(8)
  },
}

export const WrongCodeMobile: Story = { ...WrongCode, name: 'Step=wrong code, on a phone', globals: MOBILE, play: undefined }

/** Step=create account (1174:12668): the intro, the login's email (not to be changed), the names, the mobile, the tick, Create account. */
export const CreateAccount: Story = {
  name: 'Step=create account',
  globals: DESKTOP,
  args: { step: 'create', email: BOB },
  play: async ({ canvas, args }) => {
    await expect(canvas.getByRole('heading', { name: COPY.createTitle })).toBeVisible()
    const email = canvas.getByRole('textbox', { name: COPY.email })
    await expect(email).toHaveValue(BOB)
    await expect(email).toHaveAttribute('readonly')
    await userEvent.type(canvas.getByRole('textbox', { name: COPY.firstName }), 'Bob')
    await userEvent.type(canvas.getByRole('textbox', { name: COPY.lastName }), 'Test')
    await userEvent.click(canvas.getByRole('checkbox', { name: COPY.news }))
    await expect(args.onAccount).toHaveBeenLastCalledWith({ firstName: 'Bob', lastName: 'Test', mobile: '', news: true })
    await userEvent.click(canvas.getByRole('button', { name: COPY.create }))
    await expect(args.onCreate).toHaveBeenCalledTimes(1)
  },
}

export const CreateAccountMobile: Story = { ...CreateAccount, name: 'Step=create account, on a phone', globals: MOBILE, play: undefined }

/** Not drawn: W85a refuses (the email is linked to another sign-in), and its own words are shown under the email. */
export const ErrorFromTheWorker: Story = {
  name: 'An error from W85a (email linked elsewhere)',
  globals: DESKTOP,
  args: { step: 'email', email: BOB, emailError: 'This email is linked to another sign-in. Please contact us.' },
  play: async ({ canvas }) => {
    const field = canvas.getByRole('textbox', { name: COPY.email })
    await expect(field).toHaveAttribute('aria-invalid', 'true')
    await expect(canvas.getByText('This email is linked to another sign-in. Please contact us.')).toBeVisible()
  },
}

/** Not drawn: W85a asks for a name (first_name_required), shown under its field as an Input's error. */
export const NameAskedFor: Story = {
  name: 'Create account: a name W85a asks for',
  globals: DESKTOP,
  args: { step: 'create', email: BOB, account: { ...NO_ACCOUNT, lastName: 'Test' }, createErrors: { firstName: 'Please enter your first name.' } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('textbox', { name: COPY.firstName })).toHaveAttribute('aria-invalid', 'true')
    await expect(canvas.getByText('Please enter your first name.')).toBeVisible()
  },
}

/** Not drawn: Supabase or the Worker could not be reached. */
export const Fault: Story = {
  name: 'Create account: no answer',
  globals: MOBILE,
  args: { step: 'create', email: BOB, createError: COPY.fault },
  play: async ({ canvas }) => {
    await expect(canvas.getByText(COPY.fault)).toBeVisible()
  },
}
