import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { render } from 'react-email'
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { EMAIL_COLOURS, EMAIL_WORDMARK, SIGN_IN_EMAIL_WORDS, SIGN_IN_LINK, SIGN_IN_SUBJECT, SignInCodeEmail, SUPABASE_FIELDS } from './sign-in-code'

// Brief W85a item 5: the sign-in email as Supabase is given it. One HTML for both of Supabase's templates (Magic Link
// and Confirm signup). With SIGN_IN_EMAIL_OUT=<folder> set, the two files are written there for Wayne to paste into
// Supabase (Authentication > Emails), each with its subject line at the top as a comment to copy into the Subject box.

const html = async (): Promise<string> => render(createElement(SignInCodeEmail))
/** The HTML with `&amp;` read back as `&`, as a browser reads an attribute. */
const asRead = (text: string) => text.replaceAll('&amp;', '&')

describe('the sign-in email (W85a item 5)', () => {
  it("leaves Supabase's fields for Supabase: the code large, and the Sign in button to the link page with the token's hash and the page they were on", async () => {
    const page = asRead(await html())
    expect(page).toContain(SUPABASE_FIELDS.token)
    expect(SIGN_IN_LINK).toBe('{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next={{ .RedirectTo }}')
    expect(page).toContain(`href="${SIGN_IN_LINK}"`)
    // The code in the H1 size (24px), in its own box.
    expect(page).toMatch(/background-color:#e9e6db[^>]*>[\s\S]*?font-size:24px[^>]*>\{\{ \.Token \}\}</)
    // No other Go template text: nothing Supabase would refuse or fill wrongly.
    expect([...page.matchAll(/\{\{[^}]*\}\}/g)].map(([field]) => field).filter((field) => !Object.values(SUPABASE_FIELDS).includes(field as never))).toEqual([])
  })

  it("Figma's words, in its order, and the line to ignore it", async () => {
    // From the heading on: the inbox preview line (hidden, before it) repeats the intro.
    const full = await html()
    const page = full.slice(full.indexOf('<h1'))
    expect(full).toMatch(/display:none[^>]*>Enter this code where you asked to sign in\./)
    const at = Object.values(SIGN_IN_EMAIL_WORDS).map((words) => page.indexOf(words))
    expect(at.every((index) => index >= 0)).toBe(true)
    expect(at).toEqual([...at].sort((a, b) => a - b))
    expect(SIGN_IN_EMAIL_WORDS.ignore).toBe('If you didn’t ask to sign in, you can ignore this email.')
  })

  it('works in mail clients: inline styles only (no <style> block, no class), solid colours, the wordmark as a PNG with its size, no script', async () => {
    const page = await html()
    expect(page).not.toMatch(/<style|<script|<link |class="|rgba\(|var\(--/)
    for (const colour of Object.values(EMAIL_COLOURS)) expect(page).toContain(colour)
    expect(page).toContain('lang="en-GB"')
  })

  // Level 3 (Wayne, 28 Nov): Figma's new Header (1932:39358) and Footer (1932:39368).
  it('the header is the full wordmark alone, as a PNG on the site three times its drawn size', async () => {
    const page = await html()
    expect(page).toContain(`src="{{ .SiteURL }}${EMAIL_WORDMARK.path}"`)
    expect(page).toMatch(/<img[^>]*width="284"[^>]*height="35"|<img[^>]*height="35"[^>]*width="284"/)
    const file = path.join(__dirname, '../../public', EMAIL_WORDMARK.path)
    expect(existsSync(file)).toBe(true)
    // A PNG's width and height are bytes 16 to 24 of its header.
    const header = readFileSync(file)
    expect([header.readUInt32BE(16), header.readUInt32BE(20)]).toEqual([EMAIL_WORDMARK.width * 3, EMAIL_WORDMARK.height * 3])
    // The older logo stays for the template Supabase holds until this one is pasted in.
    expect(existsSync(path.join(__dirname, '../../public/email/paddock-logo.png'))).toBe(true)
  })

  it('no menu links and no "Your code" label: the only links are the wordmark (home) and Sign in; the footer is the copyright line', async () => {
    const page = asRead(await html())
    expect([...page.matchAll(/<a [^>]*href="([^"]*)"/g)].map(([, href]) => href)).toEqual(['{{ .SiteURL }}', SIGN_IN_LINK])
    expect(page).not.toMatch(/Your code|Account|>Book<|Terms|Privacy/)
    const footer = page.slice(page.indexOf(SIGN_IN_EMAIL_WORDS.ignore))
    expect(footer).toMatch(/font-size:10px[^>]*>©2026 The Paddock Wellness Club</)
  })

  it("Figma's gaps between the words: 32 between blocks, less where each line puts its capitals", async () => {
    const page = await html()
    // The heading's capitals 32 below the header (its line puts them 4 down), the intro 32 below the heading's baseline.
    expect(page).toMatch(/padding:28px 16px 0[^>]*>[\s\S]*?<h1/)
    expect(page).toMatch(/padding:24\.5px 16px 0[^>]*>[\s\S]*?Enter this code/)
    // The code: 16 round it inside its card. The button: 12 above and below its words.
    expect(page).toContain('padding:12px 16px 13px')
    expect(page).toMatch(/padding:10px 32px 10\.5px/)
  })

  it('writes the two templates for Supabase when SIGN_IN_EMAIL_OUT is set', async () => {
    const out = process.env.SIGN_IN_EMAIL_OUT
    if (!out) return
    mkdirSync(out, { recursive: true })
    const page = await html()
    for (const [file, template] of [
      ['magic-link.html', 'Magic Link'],
      ['confirm-signup.html', 'Confirm signup'],
    ] as const) {
      writeFileSync(path.join(out, file), `<!-- Supabase template: ${template}. Subject: ${SIGN_IN_SUBJECT} -->\n${page}`)
    }
    writeFileSync(path.join(out, 'subjects.txt'), `Magic Link: ${SIGN_IN_SUBJECT}\nConfirm signup: ${SIGN_IN_SUBJECT}\n`)
  })
})
