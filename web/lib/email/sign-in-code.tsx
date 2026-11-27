// Brief W85a item 5 (backend log 9, 27): the sign-in email, from Figma 05 Emails "Sign-in code" (desktop 1322:3780,
// the later of the two desktop frames, with the "Your code" label above the code box; mobile 1218:334). Supabase sends
// it (through Resend, its custom SMTP) for two of its templates, Magic Link and Confirm signup, with its own Go
// template fields left in the HTML for it to fill: {{ .Token }} (the 6-digit code), {{ .TokenHash }}, {{ .SiteURL }},
// {{ .RedirectTo }}. It is rendered once to HTML (sign-in-code.test.ts, SIGN_IN_EMAIL_OUT) and pasted into Supabase:
// nothing renders it at run time.
//
// Email clients: inline styles only (no <style> block, so no media queries), tables for layout (react-email's
// Container, Section, Row, Column), solid colours (Outlook has no rgba: Surface/Card and Text/Muted Primary are mixed
// onto Surface/Primary here), the logo as a PNG on the site (no client shows an SVG reliably), and the brand fonts
// named first with system fonts after them (they are web fonts: Apple Mail may show them, Gmail and Outlook show the
// fallbacks).
import { Body, Button, Column, Container, Head, Heading, Html, Img, Link, Preview, Row, Section, Text } from 'react-email'
import type { CSSProperties } from 'react'

/** Supabase's own template fields, left as they are for Supabase to fill. */
export const SUPABASE_FIELDS = {
  token: '{{ .Token }}',
  tokenHash: '{{ .TokenHash }}',
  siteUrl: '{{ .SiteURL }}',
  redirectTo: '{{ .RedirectTo }}',
} as const

/**
 * The Sign in button's address: the site's link page (W85, docs/url-map.md `/auth/confirm?token_hash=&next=`), which
 * signs in only when its own button is pressed, so a mail scanner opening the link can't use it up. `next` is the page
 * they were on: W85 passes it to Supabase as `emailRedirectTo` (an address on this site, in Supabase's allowed redirect
 * URLs), and the link page goes there only when it is a path on this site.
 */
export const SIGN_IN_LINK = `${SUPABASE_FIELDS.siteUrl}/auth/confirm?token_hash=${SUPABASE_FIELDS.tokenHash}&type=email&next=${SUPABASE_FIELDS.redirectTo}`

/** The subject line for both templates (Figma draws none). The code itself stays out of the subject. */
export const SIGN_IN_SUBJECT = 'Your sign-in code for The Paddock'

export const SIGN_IN_EMAIL_WORDS = {
  title: 'Your sign-in code',
  intro: 'Enter this code where you asked to sign in.',
  codeLabel: 'Your code',
  orButton: 'Or sign in with this button.',
  button: 'Sign in',
  ignore: 'If you didn’t ask to sign in, you can ignore this email.',
} as const

/** Figma's variables, as solid colours. */
export const EMAIL_COLOURS = {
  /** Surface/Primary. */
  surface: '#f1eee3',
  /** Text/Primary. */
  text: '#222222',
  /** Surface/Card, rgba(34,34,34,0.04), mixed onto Surface/Primary. */
  card: '#e9e6db',
  /** Text/Muted Primary, rgba(34,34,34,0.65), mixed onto Surface/Primary. */
  muted: '#6a6966',
  /** Surface/Secondary (the button). */
  button: '#193028',
  /** Text/Secondary (the button's words). */
  buttonText: '#f1eee3',
} as const

const SERIF = "'GT Sectra Fine', Georgia, 'Times New Roman', serif"
const SANS = "'GT America', 'Helvetica Neue', Helvetica, Arial, sans-serif"

/** Figma's text styles. */
const h1: CSSProperties = { fontFamily: SERIF, fontWeight: 400, fontSize: '24px', lineHeight: '28px', letterSpacing: '0.6px', color: EMAIL_COLOURS.text, margin: 0 }
const copy14: CSSProperties = { fontFamily: SANS, fontWeight: 400, fontSize: '14px', lineHeight: '20px', color: EMAIL_COLOURS.text, margin: 0 }
const copy12: CSSProperties = { fontFamily: SANS, fontWeight: 400, fontSize: '12px', lineHeight: '17px', color: EMAIL_COLOURS.text, margin: 0 }
const label12: CSSProperties = { fontFamily: SANS, fontWeight: 500, fontSize: '12px', lineHeight: '14px', letterSpacing: '0.3px', textTransform: 'uppercase', color: EMAIL_COLOURS.text, margin: 0, textDecoration: 'none' }
const label10: CSSProperties = { fontFamily: SANS, fontWeight: 500, fontSize: '10px', lineHeight: '12px', letterSpacing: '0.3px', textTransform: 'uppercase', color: EMAIL_COLOURS.muted, textDecoration: 'none' }

/** Spacing: the grid margin is 16px each side; blocks are 32px apart. */
const block: CSSProperties = { padding: '0 16px 32px' }

export function SignInCodeEmail() {
  const site = SUPABASE_FIELDS.siteUrl
  return (
    <Html lang="en-GB">
      <Head />
      <Preview>{SIGN_IN_EMAIL_WORDS.intro}</Preview>
      <Body style={{ backgroundColor: EMAIL_COLOURS.surface, margin: 0, padding: 0 }}>
        <Container style={{ maxWidth: '600px', width: '100%', backgroundColor: EMAIL_COLOURS.surface }}>
          {/* Header: the logo, Account and Book. Figma's header is 89px: 32px above and below a 25px box the 34px logo
              overflows, so 28 + 34 + 27 here. */}
          <Section style={{ padding: '28px 16px 27px' }}>
            <Row>
              <Column style={{ verticalAlign: 'middle' }}>
                <Link href={site}>
                  <Img src={`${site}/email/paddock-logo.png`} width="106" height="34" alt="The Paddock" style={{ display: 'block', border: 0 }} />
                </Link>
              </Column>
              <Column align="right" style={{ verticalAlign: 'middle' }}>
                <Link href={`${site}/account`} style={{ ...label12, padding: '8px' }}>
                  Account
                </Link>
                <Link href={`${site}/book`} style={{ ...label12, padding: '8px', marginLeft: '8px' }}>
                  Book
                </Link>
              </Column>
            </Row>
          </Section>

          {/* The content. */}
          <Section style={{ paddingTop: '32px' }}>
            <Section style={block}>
              <Heading as="h1" style={h1}>
                {SIGN_IN_EMAIL_WORDS.title}
              </Heading>
            </Section>
            <Section style={block}>
              <Text style={copy14}>{SIGN_IN_EMAIL_WORDS.intro}</Text>
            </Section>
            <Section style={block}>
              <Text style={{ ...label12, paddingBottom: '16px' }}>{SIGN_IN_EMAIL_WORDS.codeLabel}</Text>
              <Section style={{ backgroundColor: EMAIL_COLOURS.card, borderRadius: '4px' }}>
                <Text style={{ ...h1, padding: '16px', letterSpacing: '0.6px' }}>{SUPABASE_FIELDS.token}</Text>
              </Section>
            </Section>
            <Section style={block}>
              <Text style={copy14}>{SIGN_IN_EMAIL_WORDS.orButton}</Text>
            </Section>
            <Section style={block}>
              <Button href={SIGN_IN_LINK} style={{ ...label12, color: EMAIL_COLOURS.buttonText, backgroundColor: EMAIL_COLOURS.button, borderRadius: '4px', padding: '12px 32px', display: 'inline-block' }}>
                {SIGN_IN_EMAIL_WORDS.button}
              </Button>
            </Section>
            <Section style={block}>
              <Text style={copy12}>{SIGN_IN_EMAIL_WORDS.ignore}</Text>
            </Section>
          </Section>

          {/* Footer: Terms & Conditions, Privacy Policy, the copyright line. On a phone the line wraps under the links
              (as Figma's mobile frame); on a wider screen it follows them on the same line. */}
          <Section style={{ padding: '0 16px 32px' }}>
            <Text style={{ margin: 0 }}>
              <span style={{ display: 'inline-block', paddingRight: '16px', paddingBottom: '16px' }}>
                <Link href={`${site}/info/terms-and-conditions`} style={label10}>
                  Terms &amp; Conditions
                </Link>
                <Link href={`${site}/info/privacy-policy`} style={{ ...label10, marginLeft: '16px' }}>
                  Privacy Policy
                </Link>
              </span>
              <span style={{ ...label10, display: 'inline-block' }}>©2026 The Paddock Wellness Club</span>
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

export default SignInCodeEmail
