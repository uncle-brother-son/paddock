# Paddock website: URL map (for the build)

Agreed 4 Nov 2026; updated 24 Nov to match the Figma "00 Sitemap" page (Wayne's latest), which is the source of truth: numbers below are the Figma page numbers. The Figma "00 Sitemap" page is the source of truth; this file mirrors it for the build. Stage 1 = booking, checkout and account, built and tested end to end first. Stage 2 = content still to come. The site goes live to the public only after stage 2 (decided 4 Nov).

## Conventions
- Lowercase, words joined with hyphens, no trailing slash.
- Products and events use their Sanity slug. Account records use their ID. A changed slug redirects (301) from the old one (build standards).
- The booking panel, bag and sign-in are popups over the current page. Only the booking panel has a URL (so emails and the menu can link to it); the bag and sign-in have none.
- Access: Public, Signed in (signed-out visitors are asked to sign in, then returned to the page), or Email link (a one-time token in the URL).
- Times are shown in 24-hour format (16:00) everywhere (decided 4 Nov).

## Main site
| No. | URL | Page | Type | Access | Stage | Notes |
|---|---|---|---|---|---|---|
| 0 | / | Home | Page | Public | 1 | |
| 1 | /experience | The Experience | Page | Public | 2 | |
| 3 | /memberships | Bookings & Memberships | Page | Public | 1 | Monthly / yearly toggle. Add to bag. Design still in progress (parked) |
| 4 | /exclusive-hire | Exclusive Hire | Page & Listing | Public | 1 | Content page; stage 1 builds only its Upcoming Events list module: every upcoming event on sale, soonest first, whole card links to the event, sold out shown. No categories or filters (WQ17). Other content modules later |
| 4.1 | /events/[slug] | Event | Detail | Public | 1 | One Sanity event per date; slug typed by editors, unique (WQ17). Sanity content + events table. Add to bag. Price personalised (backend log 30) |
| 5 | /smoothies | Smoothies | Page | Public | 2 | |
| 6 | /shop | Shop | Listing | Public | 1 | Filter by dynamic categories (empty ones hidden), sort, pages (WQ6, WQ7). The gift card shows here too (WQ19) |
| 6.1 | /shop/[slug] | Product | Detail | Public | 1 | One page per colour; slug from name + colour (WQ6). Sizes, member price |
| 6.2 | /shop/gift-card | Gift card | Detail | Public | 1 | Amount, how it is sent, recipient (WQ19) |
| 8 | /blog | Blog | Listing | Public | 2 | |
| 8.1 | /blog/[slug] | Blog post | Detail | Public | 2 | |
| 9 | /about | About | Page | Public | 2 | Footer link "Our Story" |
| 10 | /contact | Contact | Page | Public | 2 | |

## Booking and checkout
| URL | Page | Type | Access | Stage | Notes |
|---|---|---|---|---|---|
| /book?date=&type= (G1) | Booking panel | Popup | Public | 1 | Opens over the current page. Steps: sessions, add-ons. type = public or private |
| (no URL) | Bag | Popup | Public | 1 | Drawer from the header |
| (no URL) | Sign in | Popup | Public | 1 | Email, code, create account; opens where the customer is |
| /checkout (11) | Checkout | Flow step | Public | 1 | Guest or signed in. Empty bag: no checkout |
| /checkout/confirmation/[order] (11.1) | Confirmation | Page | Signed in or Email link | 1 | Guests use a one-time token |

## Links from emails
| URL | Page | Type | Access | Stage | Notes |
|---|---|---|---|---|---|
| /auth/confirm?token_hash=&next= | Sign-in link | Link | Email link | 1 | Page with a Sign in button (so email scanners can't use up the link). States: loading, link expired or used. Then goes to `next`. See backend log 27 |
| /waiver/[token] | Guest waiver | Link | Email link | 1 | States: sign, signed, no longer valid. See backend log 18 |
| /checkout/confirmation/[order]?token= | Order (guest) | Link | Email link | 1 | "View your order" in the order confirmation email |

## Account (all Signed in)
| URL | Page | Type | Stage | Notes |
|---|---|---|---|---|
| /account | Dashboard | Page | 1 | Must work for a brand-new account |
| /account/bookings | Bookings | Listing | 1 | Upcoming and past tabs. Shown after the first booking |
| /account/bookings/[id] | Booking | Detail | 1 | Popups: Cancel booking, Add add-ons (until 2 hours before; add only) |
| /account/bookings/[id]/move | Move booking | Flow step | 1 | Booking panel move step, then a confirm popup |
| /account/events | Events | Listing | 1 | Shown after the first event booking |
| /account/events/[id] | Event booking | Detail | 1 | Cancel is a popup |
| /account/orders | Orders | Listing | 1 | Shown after the first order |
| /account/orders/[id] | Order | Detail | 1 | Download receipt, resend gift card |
| /account/membership | Membership | Page | 1 | Popups: replace card, cancel. Change plan is stage 3. Stays after the membership ends |
| /account/passes | Passes | Page | 1 | Shown once they have had a pass |
| /account/store-credit | Store credit | Page | 1 | Shown once they have had store credit |
| /account/details | Personal info | Page | 1 | Popups: change email, replace card (one saved card) |
| /account/preferences | Preferences | Page | 1 | |
| /account/close | Close account | Flow step | 1 | Blocked, confirm, code, closed |

Which account sections show is in backend log 25.

## Legal
| URL | Page | Type | Access | Stage | Notes |
|---|---|---|---|---|---|
| /health-and-safety (L1) | Health & Safety | Page | Public | 2 | |
| /info/terms (L2) | Terms & Conditions | Page | Public | 2 | Footer and email links hidden until this exists |
| /info/privacy (L3) | Privacy | Page | Public | 2 | Footer and email links hidden until this exists |
| /shipping-and-returns (L4) | Shipping & Returns | Page | Public | 2 | Sanity content; footer link hidden until published. The product page's Shipping & Returns link opens the info panel on that tab, not this page |
| /lost-and-found (L5) | Lost & Found Policy | Page | Public | 2 | Sanity content; footer legal link hidden until published |
| (no URL) | Manage cookies | Popup | Public | 2 | |

## Redirects
| From | To | Notes |
|---|---|---|
| /account/[section] the customer can't see | /account | e.g. an old email link or bookmark |
| /account/... when signed out | sign in, then back to the page asked for | |
| /checkout with an empty bag | / | The bag shows an empty message and checkout can't be opened from it; a direct checkout link goes to the homepage |
| an old product or event slug | its current slug (301) | Sanity keeps previous slugs (build standards) |
