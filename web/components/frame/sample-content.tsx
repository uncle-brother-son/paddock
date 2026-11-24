import type { FrameContent } from '@/lib/frame/content'
import type { SizedImage } from '@/lib/sanity/image'

// For the Frame stories only: the frame's content as Figma draws it (the menu's six links, the footer's four
// groups), and a stand-in page to sit beneath the header. The site's own content comes from Sanity.

/** A flat block of colour, 4 by 5, standing in for a page's thumbnail: a story fetches nothing. */
const thumbnail = (colour: string): SizedImage => {
  const src = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 5"><rect width="4" height="5" fill="${colour}"/></svg>`)}`
  return { src, srcSet: `${src} 240w`, width: 240, height: 300 }
}

const page = (key: string, label: string, href: string) => ({ key, label, href, outside: false })
const outside = (key: string, label: string, href: string) => ({ key, label, href, outside: true })

export const SAMPLE_FRAME: FrameContent = {
  menuLinks: [
    { ...page('m1', 'The experience', '/the-experience'), thumbnail: thumbnail('#6e6258') },
    { ...page('m2', 'Bookings & Memberships', '/bookings-memberships'), thumbnail: thumbnail('#193028') },
    { ...page('m3', 'Exclusive Hire', '/exclusive-hire'), thumbnail: thumbnail('#a7bbc8') },
    { ...page('m4', 'Smoothies', '/smoothies'), thumbnail: null },
    { ...page('m5', 'Shop', '/shop'), thumbnail: null },
    { ...page('m6', 'Gift Cards', '/gift-card'), thumbnail: thumbnail('#bd9b5d') },
  ],
  footer: {
    groups: [
      { key: 'g1', links: [outside('f1', 'TikTok', 'https://www.tiktok.com/'), outside('f2', 'Instagram', 'https://www.instagram.com/'), outside('f3', 'Facebook', 'https://www.facebook.com/')] },
      { key: 'g2', links: [page('f4', 'The Experience', '/the-experience'), page('f5', 'Bookings & Memberships', '/bookings-memberships'), page('f6', 'Events', '/events'), page('f7', 'Shop', '/shop')] },
      { key: 'g3', links: [page('f8', 'Our Story', '/our-story'), page('f9', 'Health & Safety', '/info/health-safety'), page('f10', 'Shipping & Returns', '/info/shipping-returns'), page('f11', 'Contact us', '/contact')] },
      { key: 'g4', links: [page('f12', 'Terms & Conditions', '/info/terms'), page('f13', 'Privacy Policy', '/info/privacy')] },
    ],
    newsletter: { heading: 'Sign up to the Paddock newsletter', text: 'Get early access to new releases & updates.' },
    legalLinks: [page('terms', 'Terms & Conditions', '/info/terms'), page('privacy', 'Privacy Policy', '/info/privacy')],
    copyright: '©2026 The Paddock Wellness Club',
  },
}

/** What the frame holds when Sanity has no Site settings and no Navigation yet. */
export const EMPTY_FRAME: FrameContent = {
  menuLinks: [],
  footer: { groups: [], newsletter: { heading: null, text: null }, legalLinks: [], copyright: '©2026 The Paddock Wellness Club' },
}

/** A stand-in page taller than the window: a dark first section, as the home hero is, then light ones. */
export function SamplePage({ firstSection = 'dark' }: { firstSection?: 'dark' | 'light' }) {
  return (
    <>
      <section data-theme={firstSection} className="flex h-320 items-end bg-surface-primary p-16">
        <h1 className="text-h1">The Paddock Wellness Club</h1>
      </section>
      {['Sauna', 'Cold plunge', 'Rest', 'Smoothies', 'Shop'].map((name) => (
        <section key={name} className="flex h-320 items-end p-16">
          <h2 className="text-h2">{name}</h2>
        </section>
      ))}
    </>
  )
}
