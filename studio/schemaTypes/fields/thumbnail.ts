import { defineField } from 'sanity'

/** A thumbnail field: `linkTo` is what the menu's link goes to, as its description says it ("this page", "the shop"). */
const menuPicture = (name: string, title: string, linkTo: string) =>
  defineField({
    name,
    title,
    type: 'media',
    description: `A picture or a video, shown in the menu when someone points at the link to ${linkTo}. A video shows its poster first, and plays while the link is pointed at`,
  })

/**
 * A content page's or an info page's thumbnail (W82, WQ90): the one media block (WQ43), a picture or a video. The
 * menu shows it while someone points at the link to the page: a picture as it is, a video as its poster, playing
 * while the link is pointed at (web/components/frame/Menu.tsx). Optional: a page with none shows none.
 */
export const thumbnail = menuPicture('thumbnail', 'Thumbnail', 'this page')

/**
 * W84 (WQ92): the menu's links to the shop and to the gift card are not pages, so each has a thumbnail of its own,
 * the same media block, shown the same way. The shop's is Shop Settings' Thumbnail; the gift card's is its Menu
 * Thumbnail, apart from its galleries (whose first picture stays its shop and staff-app picture, the one the
 * Worker's Sanity webhook reads: it reads neither of these two fields).
 */
export const shopThumbnail = menuPicture('thumbnail', 'Thumbnail', 'the shop')
export const giftCardMenuThumbnail = menuPicture('menuThumbnail', 'Menu Thumbnail', 'the gift card')

/**
 * The thumbnail starts empty on a new page. Sanity fills a new document's fields from their types' defaults, and the
 * media block's (Kind: Image) would give every new page an empty picture that may not be published ("Add a
 * picture."). A document's own initial value is laid over those defaults, so this one takes the thumbnail away again.
 * W84: Shop Settings starts the same way, and the gift card without its Menu Thumbnail.
 */
export const NO_THUMBNAIL_AT_FIRST = { thumbnail: undefined }
export const NO_MENU_THUMBNAIL_AT_FIRST = { menuThumbnail: undefined }

/** A document preview's picture: the thumbnail's picture or poster. (W83: a thumbnail saved before W82 is no longer shown.) */
export const THUMBNAIL_PREVIEW = { thumbnailKind: 'thumbnail.kind', thumbnailImage: 'thumbnail.image', thumbnailPoster: 'thumbnail.poster' }

type ThumbnailPreview = { thumbnailKind?: string; thumbnailImage?: unknown; thumbnailPoster?: unknown }

export function thumbnailMedia({ thumbnailKind, thumbnailImage, thumbnailPoster }: ThumbnailPreview): never {
  if (thumbnailKind === 'video') return thumbnailPoster as never
  if (thumbnailKind === 'image') return thumbnailImage as never
  return undefined as never
}
