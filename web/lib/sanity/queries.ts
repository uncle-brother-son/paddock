// The site's GROQ queries (W72), one per read. Each asks only for fields the Studio's schemas have
// (studio/schemaTypes), in the shapes of ./schemas.ts. They read published documents only (./read.ts).

/** The documents with no draft's id: the published perspective already leaves drafts out, and this says so in the query. */
const PUBLISHED = '!(_id in path("drafts.**"))'

const IS_HOME = '_id == *[_id == "siteSettings"][0].homePage._ref'

/** An image's fields. An image with no file answers null, through `pictureAt`. */
const PICTURE = `{
  "ref": asset._ref,
  "width": asset->metadata.dimensions.width,
  "height": asset->metadata.dimensions.height,
  "alt": select(decorative == true => "", coalesce(alt, "")),
  "crop": crop{top, bottom, left, right},
  "hotspot": hotspot{x, y, width, height}
}`

const pictureAt = (field: string): string => `select(defined(${field}.asset._ref) => ${field}${PICTURE}, null)`

const MEDIA = `select(
  kind == "video" && defined(video.asset._ref) && defined(poster.asset._ref) => {
    "kind": "video",
    "url": video.asset->url,
    "poster": poster${PICTURE},
    "description": coalesce(videoDescription, ""),
    "captionsUrl": captions.asset->url
  },
  kind != "video" && defined(image.asset._ref) => {"kind": "image", "image": image${PICTURE}},
  null
)`

/** A gallery (W72a; WQ15): its pictures and videos in order. An item with no file is left out. */
const galleryAt = (field: string): string => `coalesce(${field}[]{"item": ${MEDIA}}[defined(item)].item, [])`

/** A product's (or the gift card's) category (W72a; WQ7): null when it has none, or its category isn't published. */
const CATEGORY = `"category": category->{"id": _id, title, "slug": slug.current, order}`

const LINK = `{
  destination,
  "document": select(
    destination == "page" => page->{"type": _type, "slug": slug.current, "isHome": ${IS_HOME}, "thumbnail": ${pictureAt('thumbnail')}},
    destination == "event" => event->{"type": _type, "slug": slug.current, "isHome": false, "thumbnail": null},
    null
  ),
  "url": select(destination == "external" => url, null)
}`

const RICH_TEXT = `{
  _type, _key, "style": coalesce(style, "normal"), "listItem": listItem, "level": level,
  "children": coalesce(children[]{_type, _key, text, "marks": coalesce(marks, [])}, []),
  "markDefs": coalesce(markDefs[_type == "link" && defined(destination)]{_key, _type, "link": @${LINK}}, [])
}`

const richTextAt = (field: string): string => `coalesce(${field}[]${RICH_TEXT}, [])`

const seoAt = (field: string): string => `select(defined(${field}) => ${field}{title, description, "shareImage": ${pictureAt('shareImage')}}, null)`

const INFO_PAGE_LINK = '{title, "slug": slug.current}'

export const SITE_SETTINGS_QUERY = `*[_id == "siteSettings"][0]{
  siteName,
  "defaultSeo": ${seoAt('defaultSeo')},
  "termsPage": termsPage->${INFO_PAGE_LINK},
  "privacyPage": privacyPage->${INFO_PAGE_LINK},
  "shippingReturnsPage": shippingReturnsPage->${INFO_PAGE_LINK},
  "address": address{line1, line2, town, county, postcode},
  phone,
  "openingHours": coalesce(openingHours[]{"days": coalesce(days, []), opens, closes}, []),
  "socialLinks": socialLinks{tiktok, instagram, facebook},
  newsletterHeading,
  newsletterText,
  copyrightName
}`

const NAV_LINKS = `{"key": _key, label, "link": link${LINK}}`

/** W73: `footerGroups` are the footer's columns, left to right, each a list of links an editor fills (Wayne, 24 Nov). */
export const NAVIGATION_QUERY = `*[_id == "navigation"][0]{
  "menuLinks": coalesce(menuLinks[defined(link.destination)]${NAV_LINKS}, []),
  "footerGroups": coalesce(footerGroups[]{"key": _key, "links": coalesce(links[defined(link.destination)]${NAV_LINKS}, [])}, [])
}`

const CONTENT_PAGE = `{
  "id": _id,
  title,
  "slug": slug.current,
  "isHome": ${IS_HOME},
  "thumbnail": ${pictureAt('thumbnail')},
  "hero": select(defined(hero) => {
    "media": select(defined(hero.media) => hero.media{"item": ${MEDIA}}.item, null),
    "button": select(
      hero.showButton == true && defined(hero.buttonText) => {
        "text": hero.buttonText,
        "link": select(defined(hero.buttonLink.destination) => hero.buttonLink${LINK}, null)
      },
      null
    )
  }, null),
  "modules": coalesce(modules[_type == "upcomingEvents"]{"type": _type, "key": _key, heading}, []),
  "seo": ${seoAt('seo')}
}`

/** The page Site settings picks as the home page: what `/` shows. */
export const HOME_PAGE_QUERY = `*[_type == "contentPage" && ${PUBLISHED} && ${IS_HOME}][0]${CONTENT_PAGE}`

/** The page at /[slug] ($slug). */
export const CONTENT_PAGE_QUERY = `*[_type == "contentPage" && ${PUBLISHED} && slug.current == $slug][0]${CONTENT_PAGE}`

/** The info page at /info/[slug] ($slug). */
export const INFO_PAGE_QUERY = `*[_type == "infoPage" && ${PUBLISHED} && slug.current == $slug][0]{
  "id": _id, title, "slug": slug.current, "thumbnail": ${pictureAt('thumbnail')}, "body": ${richTextAt('body')}, "seo": ${seoAt('seo')}
}`

export const INFO_MENU_QUERY = `*[_type == "infoPage" && ${PUBLISHED} && defined(slug.current)] | order(menuOrder asc, title asc)${INFO_PAGE_LINK}`

const PRODUCT_CARD = `"id": _id, name, colourName, "slug": slug.current, ${CATEGORY}, "family": family._ref, newInUntil, "gallery": ${galleryAt('gallery')}`

/** Every product with an address. Which are on sale, their prices and stock come from the Worker. */
export const PRODUCT_CARDS_QUERY = `*[_type == "product" && ${PUBLISHED} && defined(slug.current)] | order(_createdAt desc){${PRODUCT_CARD}}`

/** The product at /shop/[slug] ($slug). */
export const PRODUCT_QUERY = `*[_type == "product" && ${PUBLISHED} && slug.current == $slug][0]{
  ${PRODUCT_CARD},
  "description": ${richTextAt('description')},
  "info": productInfo{composition, madeIn, careInstructions},
  "colours": select(
    defined(family._ref) => *[_type == "product" && ${PUBLISHED} && defined(slug.current) && family._ref == ^.family._ref && _id != ^._id]
      | order(colourName asc){"id": _id, name, colourName, "slug": slug.current, "gallery": ${galleryAt('gallery')}},
    []
  ),
  "sizeGuide": sizeGuide->{
    title,
    "columns": coalesce(columns, []),
    "rows": coalesce(rows[]{"cells": coalesce(cells, [])}.cells, []),
    "notes": ${richTextAt('notes')}
  },
  "similarIds": coalesce(similarProducts[defined(@->_id)]._ref, []),
  "seo": ${seoAt('seo')}
}`

export const SHOP_SETTINGS_QUERY = `*[_id == "shopSettings"][0]{
  title,
  intro,
  "featuredIds": coalesce(featuredOrder[defined(@->_id)]._ref, []),
  "shippingReturnsSummary": ${richTextAt('shippingReturnsSummary')},
  "seo": ${seoAt('seo')}
}`

const EVENT_CARD = `"id": _id, name, "slug": slug.current, "gallery": ${galleryAt('gallery')}`

/** Every event with an address. Their dates, prices and spaces, and which are on sale, come from the Worker. */
export const EVENT_CARDS_QUERY = `*[_type == "event" && ${PUBLISHED} && defined(slug.current)] | order(_createdAt desc){${EVENT_CARD}}`

/** The event at /events/[slug] ($slug). */
export const EVENT_QUERY = `*[_type == "event" && ${PUBLISHED} && slug.current == $slug][0]{
  ${EVENT_CARD}, "description": ${richTextAt('description')}, extraWaiver, "seo": ${seoAt('seo')}
}`

export const EVENTS_SETTINGS_QUERY = `*[_id == "eventsSettings"][0]{"termsSummary": ${richTextAt('termsSummary')}}`

/** The one gift card (WQ19): the first made, should there ever be two. Its two galleries, swapped by the page's switch. */
export const GIFT_CARD_QUERY = `*[_type == "giftCardType" && ${PUBLISHED}] | order(_createdAt asc)[0]{
  "id": _id, name, ${CATEGORY},
  "physicalGallery": ${galleryAt('physicalGallery')},
  "digitalGallery": ${galleryAt('digitalGallery')},
  "description": ${richTextAt('description')}, "terms": ${richTextAt('terms')}, "seo": ${seoAt('seo')}
}`

/**
 * W72a: the document of one type ($type) that had this slug ($slug) before and has another now: where an old
 * address has moved to (./redirects.ts). Never the document that has the slug now, so an address can't be sent to
 * itself. The Studio lets one document of a type hold an old slug; should two, the one changed last.
 */
export const MOVED_SLUG_QUERY = `*[_type == $type && ${PUBLISHED} && $slug in previousSlugs && defined(slug.current) && slug.current != $slug]
  | order(_updatedAt desc)[0]{"slug": slug.current, "isHome": ${IS_HOME}}`
