import { sizedImage, type SizedImage } from '@/lib/sanity/image'
import { linkHref } from '@/lib/sanity/links'
import { stillOf, videoOf } from '@/lib/sanity/media'
import type { Media, NavLink, Navigation, SiteSettings } from '@/lib/sanity/schemas'
import { SITE_NAME } from '@/lib/site'

// What the header, the menu and the footer show (W73), made from Sanity's Site settings and Navigation documents.
// Nothing here reads Sanity: ./read.ts does, and hands the two documents (or null for one that isn't there) to
// `frameContent`.

/** A link as the frame draws it. `outside`: an address off the site (https, mailto, tel), a plain <a>. */
export type FrameLink = { key: string; label: string; href: string; outside: boolean }

/**
 * What the desktop menu shows while a link is hovered: its page's thumbnail (WQ24). W82 (WQ90): a picture, or a
 * video: `picture` is then its poster and `videoUrl` its file. The menu shows it from 768px only, so it is the
 * film's desktop file and poster (WQ35). W84 (WQ92): a link to the shop shows Shop Settings' Thumbnail and a link to
 * the gift card the gift card's Menu Thumbnail, each the same way as a page's.
 */
export type MenuThumbnail = { picture: SizedImage; videoUrl: string | null }

/** A menu link, with its hover picture or video (null: its page, the shop or the gift card has none; an event and an outside address never have one). */
export type FrameMenuLink = FrameLink & { thumbnail: MenuThumbnail | null }

export type FrameFooterGroup = { key: string; links: FrameLink[] }

export type FrameContent = {
  menuLinks: FrameMenuLink[]
  footer: {
    /** The footer's columns of links, left to right, as the editor grouped them. */
    groups: FrameFooterGroup[]
    newsletter: { heading: string | null; text: string | null }
    /** The checkout footer's two links: the Terms and Privacy pages Site settings picks, each only once published. */
    legalLinks: FrameLink[]
    /** "©2026 The Paddock Wellness Club". */
    copyright: string
  }
  /**
   * W85 Level 3 (Wayne, 30 Nov; as the checkout's ticks will, WQ94): the addresses of the Terms and Privacy pages Site
   * settings picks (their /info/ slugs), for the sign-in popup's "By continuing, you agree to..."; null while a page
   * isn't picked or isn't published, and the popup then shows its words with no link.
   */
  legalPages: { terms: string | null; privacy: string | null }
}

const infoAddress = (page: { slug: string } | null | undefined): string | null => (page ? `/info/${page.slug}` : null)

/** The menu picture's shape in Figma (Menu Hover, MenuImage: 400 by 500). */
const MENU_THUMBNAIL_RATIO = 400 / 500

/** Four grid columns is 228px at Figma's desktop frame: that, and two and three times it for sharper screens. */
const MENU_THUMBNAIL_WIDTHS = [240, 480, 720] as const

const isOutside = (link: NavLink['link']): boolean => link.destination === 'external'

/** A thumbnail as the menu draws it: the picture, or the video's poster, cropped 4 by 5; and the video's file. */
const menuThumbnail = (media: Media): MenuThumbnail => ({
  picture: sizedImage(stillOf(media).wide, MENU_THUMBNAIL_RATIO, MENU_THUMBNAIL_WIDTHS),
  videoUrl: videoOf(media)?.url ?? null,
})

/** A link the site shows, or null for one it hides: its page or event isn't published (WQ24), or it has no address. */
function frameLink({ key, label, link }: NavLink): FrameLink | null {
  const href = linkHref(link)
  return href ? { key, label, href, outside: isOutside(link) } : null
}

const shown = <T,>(items: (T | null)[]): T[] => items.filter((item): item is T => item !== null)

/**
 * The frame's content from the two documents. With neither (Sanity not filled in yet, or not reachable) the frame
 * still stands: no menu links, no footer links, the site's own name in the copyright line.
 */
export function frameContent(settings: SiteSettings | null, navigation: Navigation | null, year: string): FrameContent {
  const menuLinks = shown(
    (navigation?.menuLinks ?? []).map((navLink) => {
      const link = frameLink(navLink)
      if (!link) return null
      // A page's thumbnail comes with its document; the shop's and the gift card's with the menu link itself (W84).
      const thumbnail = navLink.link.document?.thumbnail ?? navLink.thumbnail
      return { ...link, thumbnail: thumbnail ? menuThumbnail(thumbnail) : null }
    }),
  )

  // A group with nothing to show (not filled yet, or every page in it unpublished) takes no column.
  const groups = (navigation?.footerGroups ?? [])
    .map((group) => ({ key: group.key, links: shown(group.links.map(frameLink)) }))
    .filter((group) => group.links.length > 0)

  const legalLinks = shown(
    [settings?.termsPage ?? null, settings?.privacyPage ?? null].map((page) =>
      page ? { key: page.slug, label: page.title, href: infoAddress(page) ?? '', outside: false } : null,
    ),
  )

  return {
    menuLinks,
    footer: {
      groups,
      newsletter: { heading: settings?.newsletterHeading ?? null, text: settings?.newsletterText ?? null },
      legalLinks,
      copyright: `©${year} ${settings?.copyrightName ?? settings?.siteName ?? SITE_NAME}`,
    },
    legalPages: { terms: infoAddress(settings?.termsPage), privacy: infoAddress(settings?.privacyPage) },
  }
}

/** This year in London, where the club is. */
export const londonYear = (now: Date = new Date()): string => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric' }).format(now)
