// Brief W85a item 5 (backend log 9, 27), rebuilt at Level 3 (Wayne, 28 Nov) from Figma 05 Emails "Sign-in code" as he
// updated it: desktop 1322:3780, mobile 1932:39373; Header 1932:39358 (the full "THE paddock WELLNESS CLUB" wordmark,
// no links beside it) and Footer 1932:39368 (the copyright line only). No "Your code" label. Supabase sends it
// (through Resend, its custom SMTP) for two of its templates, Magic Link and Confirm signup, with its own Go template
// fields left in the HTML for it to fill: {{ .Token }} (the 6-digit code), {{ .TokenHash }}, {{ .SiteURL }},
// {{ .RedirectTo }}. It is rendered once to HTML (sign-in-code.test.ts, SIGN_IN_EMAIL_OUT) and pasted into Supabase:
// nothing renders it at run time.
//
// Email clients: inline styles only (no <style> block, so no media queries), tables for layout (react-email's
// Container, Section), solid colours (Outlook has no rgba: Surface/Card and Text/Muted Primary are mixed onto
// Surface/Primary here), the wordmark as a PNG on the site (no client shows an SVG reliably), and the brand fonts named
// first with system fonts after them (they are web fonts: Apple Mail may show them, Gmail and Outlook the fallbacks).
//
// Figma trims every text to its capitals and its baseline, and its gaps are between those (32px between blocks, 16px
// inside the code's card, 12px inside the button). No email client trims text, so each block's padding is Figma's gap
// less where its line puts the capitals and the baseline, measured with the site's fonts (`TRIM` below): what is seen
// between the words is Figma's gap.
import { Body, Button, Container, Head, Heading, Html, Img, Link, Preview, Section, Text } from 'react-email'
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

/** Figma's words, in its order. */
export const SIGN_IN_EMAIL_WORDS = {
  title: 'Your sign-in code',
  intro: 'Enter this code where you asked to sign in.',
  orButton: 'Or sign in with this button.',
  button: 'Sign in',
  ignore: 'If you didn’t ask to sign in, you can ignore this email.',
  copyright: '©2026 The Paddock Wellness Club',
} as const

/**
 * The wordmark (Figma's Header: "THE paddock WELLNESS CLUB", drawn 283.6 by 34.4) on the site, as a PNG three times its
 * size (852 by 105) for sharp screens, drawn at 284 by 35. Made from Figma's own asset. The older, shorter logo
 * (`paddock-logo.png`) stays on the site for the template Supabase holds until this one is pasted in.
 */
export const EMAIL_WORDMARK = { path: '/email/paddock-wordmark.png', width: 284, height: 35 } as const

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

/**
 * Figma's text styles, each with a line height (H1 and Label 100%, Copy 1.4 as Figma's) and where that line puts the
 * capitals: `top` from the line's top to the cap top, `bottom` from the baseline to the line's bottom, in px, measured
 * with GT Sectra Fine and GT America (rounded to the half pixel).
 */
const TRIM = {
  h1: { top: 4, bottom: 3 },
  copy12: { top: 4.5, bottom: 4 },
  label12: { top: 2, bottom: 1.5 },
  label10: { top: 1.5, bottom: 1.5 },
} as const

const h1: CSSProperties = { fontFamily: SERIF, fontWeight: 400, fontSize: '24px', lineHeight: '24px', letterSpacing: '0.6px', color: EMAIL_COLOURS.text, margin: 0 }
const copy12: CSSProperties = { fontFamily: SANS, fontWeight: 400, fontSize: '12px', lineHeight: '17px', color: EMAIL_COLOURS.text, margin: 0 }
const label12: CSSProperties = { fontFamily: SANS, fontWeight: 500, fontSize: '12px', lineHeight: '12px', letterSpacing: '0.3px', textTransform: 'uppercase', margin: 0, textDecoration: 'none' }
const label10: CSSProperties = { fontFamily: SANS, fontWeight: 500, fontSize: '10px', lineHeight: '10px', letterSpacing: '0.3px', textTransform: 'uppercase', color: EMAIL_COLOURS.muted, margin: 0 }

/** Figma's gaps: 32 between blocks and round the content, the grid margin 16 at each side. */
const GAP = 32
const MARGIN = 16
const px = (value: number): string => `${value}px`

/** A block of the content with the space above it that Figma's gap leaves once the line's own space is taken off. */
const gapAbove = (above: number): CSSProperties => ({ padding: `${px(above)} ${px(MARGIN)} 0` })

export function SignInCodeEmail() {
  const site = SUPABASE_FIELDS.siteUrl
  return (
    <Html lang="en-GB">
      <Head />
      <Preview>{SIGN_IN_EMAIL_WORDS.intro}</Preview>
      <Body style={{ backgroundColor: EMAIL_COLOURS.surface, margin: 0, padding: 0 }}>
        <Container style={{ maxWidth: '600px', width: '100%', backgroundColor: EMAIL_COLOURS.surface }}>
          {/* Header (1932:39358): the wordmark alone. Figma's header is 89px: 32 above and below a 25px box the 34.4px
              wordmark overflows evenly, so 27 + 35 + 27 here. */}
          <Section style={{ padding: `27px ${px(MARGIN)}` }}>
            <Link href={site}>
              <Img src={`${site}${EMAIL_WORDMARK.path}`} width={String(EMAIL_WORDMARK.width)} height={String(EMAIL_WORDMARK.height)} alt="The Paddock Wellness Club" style={{ display: 'block', border: 0 }} />
            </Link>
          </Section>

          {/* The content (32 round it and between its blocks). */}
          <Section style={gapAbove(GAP - TRIM.h1.top)}>
            <Heading as="h1" style={h1}>
              {SIGN_IN_EMAIL_WORDS.title}
            </Heading>
          </Section>
          <Section style={gapAbove(GAP - TRIM.h1.bottom - TRIM.copy12.top)}>
            <Text style={copy12}>{SIGN_IN_EMAIL_WORDS.intro}</Text>
          </Section>
          {/* The code in H1's size on Surface/Card, 16 round it, 4px corners. */}
          <Section style={gapAbove(GAP - TRIM.copy12.bottom)}>
            <Section style={{ backgroundColor: EMAIL_COLOURS.card, borderRadius: '4px' }}>
              <Text style={{ ...h1, padding: `${px(16 - TRIM.h1.top)} 16px ${px(16 - TRIM.h1.bottom)}` }}>{SUPABASE_FIELDS.token}</Text>
            </Section>
          </Section>
          <Section style={gapAbove(GAP - TRIM.copy12.top)}>
            <Text style={copy12}>{SIGN_IN_EMAIL_WORDS.orButton}</Text>
          </Section>
          {/* Button Type=primary: 32 each side, 12 above and below its words, 4px corners. */}
          <Section style={gapAbove(GAP - TRIM.copy12.bottom)}>
            <Button
              href={SIGN_IN_LINK}
              style={{ ...label12, color: EMAIL_COLOURS.buttonText, backgroundColor: EMAIL_COLOURS.button, borderRadius: '4px', padding: `${px(12 - TRIM.label12.top)} 32px ${px(12 - TRIM.label12.bottom)}`, display: 'inline-block' }}
            >
              {SIGN_IN_EMAIL_WORDS.button}
            </Button>
          </Section>
          <Section style={{ ...gapAbove(GAP - TRIM.copy12.top), paddingBottom: px(GAP - TRIM.copy12.bottom) }}>
            <Text style={copy12}>{SIGN_IN_EMAIL_WORDS.ignore}</Text>
          </Section>

          {/* Footer (1932:39368): the copyright line alone, in Label 10, Text/Muted Primary, 32 above and below. */}
          <Section style={{ padding: `${px(GAP - TRIM.label10.top)} ${px(MARGIN)} ${px(GAP - TRIM.label10.bottom)}` }}>
            <Text style={label10}>{SIGN_IN_EMAIL_WORDS.copyright}</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

export default SignInCodeEmail
