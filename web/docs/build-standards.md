# Paddock website: build standards (accessibility, SEO, metadata, sharing, analytics, performance)

Written 23 Nov 2026 for Claude Code and reviewers. Every page, component and module follows this. Draft for Wayne's review: anything he changes is recorded in `briefs/W03-decisions.md` and updated here. Routes come from the URL map (`claude/paddock-url-map.md`). The site lives at `https://thepaddockwellness.co.uk` (no www).

**Hard rule (Wayne, 23 Nov): the Figma designs are the source of truth for how everything looks. Nothing in this document changes a design. Where an accessibility or SEO need would change how something looks, it goes to Wayne as a question first, and is built only once he has answered.** Everything below is either invisible (code, markup, behaviour) or already in the designs. Open design questions are listed in section 11 until Wayne answers them.

## 1. Accessibility (WCAG 2.2 AA)

**Structure**
- Semantic HTML first: `header`, `nav`, `main`, `footer`, real `button` and `a` (a link goes somewhere, a button does something).
- One `h1` per page; headings never skip a level.
- `lang="en-GB"` on `html`.
- A "Skip to content" link (WQ13): hidden until the first Tab press, then shown top-left over the header as the small primary Button, with the focus ring.

**Keyboard and focus**
- Everything usable with the mouse is usable with the keyboard, in a sensible order.
- Focus style: inputs use their designed focus state. Buttons, links, cards and every other control get a keyboard-only ring (WQ12): 2px in Text/Primary (Sand Light in Dark mode) with a 2px gap. Mouse and touch users never see it, a list chosen from with the mouse included (Wayne, 25 Nov): the ring follows what was last used, a key or a pointer, not `:focus-visible` alone, which counts a clicked `select` as the keyboard's. Never `outline: none` with nothing in its place for the keyboard.
- Nothing is hidden behind the sticky header when focused (2.2: focus not obscured).

**Popups (menu, booking panel, bag, sign-in, product info panel, size guide, confirm dialogs)**
- Open: focus moves into the popup; the page behind is `inert` and does not scroll.
- Esc and the close button close it; focus returns to the button that opened it.
- `role="dialog"` with `aria-modal="true"` and a label from its heading.
- Tabs (Description / Materials & Care / Shipping & Returns) follow the tabs pattern: arrow keys move between tabs.

**Forms (as designed: the placeholder text inside the field is its prompt)**
- Each field also gets an accessible name in the code (a visually hidden `label` with the same words as the placeholder), so screen readers and voice control can find it after the placeholder disappears. Nothing changes on screen.
- `autocomplete` on name, email, phone, address and postcode fields.
- Errors, as designed: the error fill and the error message under the field. In the code the message is linked with `aria-describedby` and the field gets `aria-invalid`. The checkout notice (CheckoutNotice) lists each error with a link to its field; focus moves to the notice on a failed submit.
- Required fields: the designs don't mark them, and nothing is added. The code marks them `required` (read out by screen readers, not shown).
- Checkboxes, radios, toggles, size buttons, steppers and the code input use real form controls (or the matching ARIA roles) under the designed look.
- The sign-in code input accepts paste and works with the phone's one-time-code autofill (2.2: accessible authentication). Turnstile runs in its non-interactive mode.

**Things that change on their own**
- Toasts, the bag count, price changes and "Checking code..." are announced through a polite live region.
- Errors that block an action use an assertive live region.

**Colour and size**
- Colours are the designed tokens. Contrast is measured, and any shortfall goes to Wayne; the code never adjusts a colour by itself. Answered 23 Nov (Wayne updates the Figma variables, the build uses them):
  - Text/Error: Light #7f6434 (4.8:1), Dark keeps Mustard #bd9b5d (5.4:1) (WQ9).
  - Text/Muted Primary: 65% in every mode (was 60%); Light 4.7:1 on the page, 4.55:1 in a field (WQ10).
  - Unticked checkboxes and radios stay as designed, accepting 1.1:1 (WQ11).
  - Fjord and Mud are never used for forms or error messages.
- The designs already pair colour with something else (error messages in words, the sold-out styling, the selected size's fill); keep it that way.
- Touch targets: the designed sizes stay. Where a control is small (25 px icon buttons and size buttons, the stepper buttons, the 20 px checkbox), the tappable area is extended invisibly around it to at least 24 by 24 px (44 where there's room), with no change to how it looks.
- The site works at 200% zoom and at 320 px wide with no sideways scroll. Zoom is never disabled.

**Motion**
- Libraries: Lenis for smooth scroll, Motion for every animation (WQ20). GSAP only if a later module needs it, flagged to Wayne first.
- One shared motion tokens file holds the easing and durations, read by both the CSS (as variables) and Motion (as constants), so a change there changes the whole site (WQ21, WQ23): `ease-smooth` for every animation, and only two durations: `duration-short` 320 ms (hovers; the menu) and `duration-long` 640 ms (page transitions; each of the intro's 3 transitions; the Product Info Panel's slide, WQ49, as the Bag is prototyped). No animation uses its own curve or a typed-in duration.
- The curve (WQ55, WQ56, 25 Nov): `ease-smooth` is Figma's spring preset "Slow" (mass 1, stiffness 80, damping 20: no bounce), the one Wayne's prototypes use, in real time: its first 640 ms from rest, brought to end on 1. An animation of the long duration moves as the spring does (half-way at about 190 ms); one of the short duration plays the same shape in half the time. The durations stay as they are (WQ56 corrected). `npm run ease:build` (`scripts/build-ease.mjs`) makes it from the spring: a `linear(...)` curve for CSS and the same points for Motion.
- Intro: Wayne's Figma intro, once per browser session on the first page landed on, with its pauses (WQ53, 25 Nov): 480 ms on the full Moss panel, 640 ms the logo fades in, 640 ms the logo moves up and the location fades in, 480 ms held, 640 ms the panel masks up: 2,880 ms. Page transitions: on every page-to-page click (W73b; WQ57, 25 Nov) and on the browser's Back and Forward (W78a; WQ68, 25 Nov), each page's background stays solid and still and only its content moves: the content of the page being left drifts up a fifth of the window and fades to 40% over its own backgrounds, and the new page, with its own solid background, slides up from below the window into its place (WQ67, 25 Nov: it moves, nothing masks it), so nothing of the old page shows through it. Back and Forward arrive where the browser would put them. A product's colour swatch swaps the page at once where the window is (WQ52, as amended again; W78b: no transition; the window then scrolls smoothly to the top with Lenis over the long duration, and focus goes to the product's name once it is there; reduced motion jumps), and so does a browser without the Navigation API on Back and Forward.
- The scroll effect and page transitions respect `prefers-reduced-motion`: with it on, transitions become a short fade or none, and the scroll effect is switched off. Built once in the site shell so every module inherits it.
- Anything that moves for more than 5 seconds by itself can be paused. No autoplaying sound.

**Video (WQ15, WQ18)**
- Everywhere an image can be added, a video can be added instead (galleries on products, events, gift cards and pages like them; later every content module). Videos are MP4 files uploaded to Sanity.
- Each video needs a poster image (with alt text) and a short description for screen readers.
- Videos in galleries and modules play muted, looped and inline (`muted loop playsinline autoplay`), start only when on screen, and stop when scrolled away.
- With reduced motion on, the poster image shows and the video doesn't play.
- A video that plays for more than 5 seconds gets a pause control. Designed (W73b, HeroMedia module): Figma's IconButton, Style=image, two of them at the bottom right of the picture, sound and Pause; each shows what a press will do.
- A video with speech needs captions (a WebVTT file uploaded next to it).
- File size: Sanity serves one file to everyone, so editors keep videos short and compressed (guide: under 10 MB, 1080 px wide, H.264). Sanity's file field shows the limit; the site never preloads a video below the fold.

**Images and icons**
- Alt text is required in Sanity on every content image (already enforced). Decorative images get `alt=""`.
- Icon-only buttons (Menu, close, bag) have an accessible name. The bag button reads "Bag, 3 items".
- A sold-out size reads "M, sold out".

**Checks**
- Storybook a11y add-on set to fail on errors, on every story.
- Playwright with axe on every page type on the preview site.
- A manual keyboard pass and a VoiceOver (iPhone and Mac) pass at each flow sign-off.

## 2. Page titles, descriptions and search (SEO)

**How it's built:** Next.js `generateMetadata` on every route. Defaults come from the Sanity Site settings document; each page's values are generated from its content, and editors can override title, description and share image in an optional SEO section (decided WQ6 for products; the same pattern for every page type).

**Patterns**

| Page | Title | Description |
|---|---|---|
| Home | The Paddock Wellness Club, Hebden Bridge (from Site settings) | Site settings |
| Product | {Product name} - {Colour} \| The Paddock | First 155 characters of the description |
| Shop | {Shop title} \| The Paddock | Shop settings |
| Event | {Event name}, {date} \| The Paddock | First 155 characters of the description |
| Events, Memberships, Gift card | {Page title} \| The Paddock | Page's own, or Site settings |
| Content pages, blog | {Title} \| The Paddock | Page's own, or excerpt |

- Titles under 60 characters where possible; descriptions 120-155 characters.

**Canonical URLs**
- Every public page has an absolute canonical URL on `https://thepaddockwellness.co.uk`, lowercase, no trailing slash, no query string (Shop filters, sort and page numbers point to the clean `/shop` URL).
- `/book?...` (the booking panel over a page) is canonical to the page underneath.

**Kept out of search (`noindex`)**
- `/account/**`, `/checkout/**`, `/auth/**`, `/waiver/**`.
- Every preview and `workers.dev` deploy: an `X-Robots-Tag: noindex` header on the whole site, so test copies never appear in Google.

**sitemap.xml and robots.txt**
- `sitemap.xml` is generated from Sanity and the routes: public pages only, products and events that are on sale (sold-out products stay; ended events drop out), with last-modified dates.
- `robots.txt` allows everything public, disallows the noindex paths above, and points to the sitemap. On preview deploys it disallows everything.

**Changed web addresses**
- When an editor changes a slug, the old address keeps working: Sanity keeps a list of previous slugs on the document and the site redirects them (301) to the new one.
- Ended events and deleted products: the page returns 404 with links to Events or Shop (no soft 404s).

## 3. Link previews (Open Graph and social)

- Every public page sets `og:title`, `og:description`, `og:url` (the canonical), `og:site_name` ("The Paddock Wellness Club"), `og:locale` (`en_GB`), `og:type` (`website`; `product` for products; `article` for blog posts).
- `og:image` at 1200 by 630, cropped from the Sanity image with its hotspot (first product picture, event image, or the page's share image), with `og:image:alt`. Fallback: the default share image in Site settings.
- `twitter:card` = `summary_large_image`.
- Checked with the Facebook, LinkedIn and Slack link preview tools at sign-off.

## 4. Structured data (JSON-LD)

Helps Google show prices, stock, dates and opening times. Values must match what the page shows.

- **Home:** `LocalBusiness` (sub-type `HealthClub`) with name, address, geo, phone, opening hours, logo, image and `sameAs` (Instagram, TikTok, Facebook), from Site settings. Plus `WebSite`.
- **Product (each colour):** `Product` with name, image, description, colour, SKU, brand, and an `Offer`: price in GBP (the public price; sale price when on sale), `availability` InStock or OutOfStock from the database, URL.
- **Event:** `Event` with name, start and end date (Europe/London), `location` (the Paddock's address), image, description, `eventStatus`, and an `Offer` with the public price and availability.
- **Every page below the top level:** `BreadcrumbList`.
- Checked with Google's Rich Results Test at sign-off.

## 5. Analytics (Google Analytics 4) and tracking

- GA4 loads only after the visitor accepts analytics cookies (UK PECR). Consent Mode v2 with everything denied by default. The cookie banner is stage 2; the site goes live after stage 2, so GA is never on before consent exists.
- Klaviyo's tracking script follows the same consent. Stripe, Turnstile and the sign-in cookies are strictly necessary and need no consent.
- GA loads after the page is interactive (`lazyOnload`), as on epitomeplus. The Measurement ID comes from an environment variable; preview deploys have none, so nothing is tracked there.
- Shop events (GA4 recommended names): `view_item_list`, `select_item`, `view_item`, `add_to_cart`, `remove_from_cart`, `view_cart`, `begin_checkout`, `add_payment_info`, `purchase`.
- `purchase` is sent once, from the confirmation page, with `transaction_id` = the order id, the amount actually charged, and the items. Reloading the page never sends it again.
- No personal data in analytics: no names, emails, phone numbers or customer ids.

## 6. Performance

- Targets (Core Web Vitals, 75th percentile, mobile): LCP 2.5 s or less, INP 200 ms or less, CLS 0.1 or less.
- **Images:** from the Sanity image CDN with `auto=format` (AVIF/WebP), widths matched to the `sizes` attribute, width and height (or aspect ratio) always set so nothing jumps. Only the first visible image (the hero or the first product picture) loads with priority; everything else is lazy.
- **Fonts:** self-hosted woff2 in `web/app/fonts` (web licence), loaded with `next/font/local`, `font-display: swap`, only the weights used, the one or two above-the-fold faces preloaded, with a size-matched fallback so text doesn't jump.
- **JavaScript:** pages are server components by default; client code only where something is interactive. The animation library is loaded only by the parts that use it.
- **Caching:** Sanity content is cached and refreshed by the Sanity webhook. Prices, stock and session times are always read live from the Worker. Never `dynamicParams = false` on Sanity routes (it caused permanent 404s on epitomeplus with this OpenNext set-up).
- Lighthouse and the Web Vitals report run on the preview at each sign-off.

## 7. Formats and wording

- UK English throughout.
- Times in 24-hour format (16:00), decided 4 Nov. Dates and prices are written exactly as the designs show them. Every date and time is in Europe/London, whatever the visitor's own time zone.
- Capitals and letter case follow the designs. Where a design shows capitals (buttons, labels), they're applied with CSS so screen readers read normal words.

## 8. Security and privacy basics

- No personal data in URLs (one-time tokens in email links are the only exception).
- Security headers on every response: HSTS, Content-Security-Policy (allowing only Stripe, Turnstile, Sanity images, GA and Klaviyo after consent), `X-Content-Type-Options`, `Referrer-Policy: strict-origin-when-cross-origin`, and `frame-ancestors 'none'` except where Stripe needs it.
- Cookies: `Secure`, `HttpOnly` where possible, `SameSite=Lax`.

## 9. Found by AI tools (ChatGPT, Claude, Perplexity, Google AI Overviews, Copilot)

AI search tools read pages much like search engines, but many don't run JavaScript, so what they can't see in the raw HTML doesn't exist for them.
- **Everything in the server HTML.** Pages are rendered on the server. Product and event prices, stock, session times and opening hours are fetched on the server and written into the HTML, not loaded later in the browser. The product info panel's tabs (Description, Materials & Care, Shipping & Returns) and the size guide are in the page HTML, hidden until opened, not fetched on click.
- **Facts written as text.** Address, opening hours, prices, what's included, what to bring and how to book appear as words on the page, never only inside an image.
- **Structured data** (section 4) and **sitemap.xml** with last-modified dates (section 2).
- **robots.txt names the AI crawlers.** AI search and assistant crawlers are allowed: `OAI-SearchBot` and `ChatGPT-User` (OpenAI), `Claude-SearchBot` and `Claude-User` (Anthropic), `PerplexityBot` and `Perplexity-User`, plus Googlebot (AI Overviews), Bingbot (Copilot) and Applebot. Crawlers that only collect pages to train AI models are blocked (WQ14): `GPTBot`, `ClaudeBot`, `Google-Extended`, `Applebot-Extended`, `CCBot`.
- **Cloudflare settings match robots.txt.** Cloudflare can block AI crawlers by default (AI Crawl Control, its managed robots.txt, Bot Fight Mode). When the domain moves into the Paddock account, set these to match the rules above, or Cloudflare blocks the AI tools before they reach the site.
- **Fresh pages are announced.** Cloudflare Crawler Hints (IndexNow) is switched on, so Bing and Copilot pick up new products and events quickly.
- **`/llms.txt`.** A short plain-text guide to the site generated from Sanity: what the Paddock is, the address and opening hours, and links to the main pages (booking, memberships, shop, events, FAQs). It's a newer convention that not every AI tool reads yet, so it's cheap extra cover, not a replacement for the above.

## 10. Checklist at every sign-off

- [ ] Storybook a11y: no errors. Playwright + axe: no errors.
- [ ] Keyboard pass and VoiceOver pass on the flow.
- [ ] Reduced motion on: no scroll effect, transitions faded or off.
- [ ] Title, description, canonical, Open Graph and JSON-LD checked on each new page type.
- [ ] Preview site is noindex.
- [ ] Lighthouse mobile and Web Vitals within the targets.
- [ ] The page's text, prices and facts are in the raw HTML (checked with JavaScript turned off).

## 11. Design questions answered (23 Nov)

All six answered by Wayne; decisions WQ9-WQ14 in `briefs/W03-decisions.md`. Figma variable changes Wayne makes himself:
1. Text/Error: Light #7f6434 (new palette colour), Dark stays Mustard #bd9b5d.
2. Text/Muted Primary: 65% in every mode (new 65% palette colours).
3. Unticked checkbox and radio edges: as designed.
4. Focus: keyboard-only ring (section 1).
5. Skip to content: yes, small primary Button (section 1).
6. AI training crawlers: blocked (section 9).

New questions found during the build go to Wayne one at a time, never built first.
