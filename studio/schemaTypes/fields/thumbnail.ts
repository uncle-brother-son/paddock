import { defineField } from 'sanity'

/**
 * A content page's or an info page's thumbnail (W82, WQ90): the one media block (WQ43), a picture or a video. The
 * menu shows it while someone points at the link to the page: a picture as it is, a video as its poster, playing
 * while the link is pointed at (web/components/frame/Menu.tsx). Optional: a page with none shows none.
 */
export const thumbnail = defineField({
  name: 'thumbnail',
  title: 'Thumbnail',
  type: 'media',
  description: 'A picture or a video, shown in the menu when someone points at the link to this page. A video shows its poster first, and plays while the link is pointed at',
})

/**
 * The thumbnail starts empty on a new page. Sanity fills a new document's fields from their types' defaults, and the
 * media block's (Kind: Image) would give every new page an empty picture that may not be published ("Add a
 * picture."). A document's own initial value is laid over those defaults, so this one takes the thumbnail away again.
 */
export const NO_THUMBNAIL_AT_FIRST = { thumbnail: undefined }

/** A document preview's picture: the thumbnail's picture or poster. `old` is a thumbnail saved before W82, a plain picture. */
export const THUMBNAIL_PREVIEW = { thumbnailKind: 'thumbnail.kind', thumbnailImage: 'thumbnail.image', thumbnailPoster: 'thumbnail.poster', thumbnailOld: 'thumbnail' }

type ThumbnailPreview = { thumbnailKind?: string; thumbnailImage?: unknown; thumbnailPoster?: unknown; thumbnailOld?: { _type?: string } }

export function thumbnailMedia({ thumbnailKind, thumbnailImage, thumbnailPoster, thumbnailOld }: ThumbnailPreview): never {
  if (thumbnailKind === 'video') return thumbnailPoster as never
  if (thumbnailKind === 'image') return thumbnailImage as never
  return (thumbnailOld?._type === 'picture' ? thumbnailOld : undefined) as never
}
