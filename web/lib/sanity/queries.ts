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

/**
 * A video's poster (WQ42): a plain image with a hotspot. It has no alt text of its own, so its `alt` is always ""
 * here, whatever an older document still holds under it: the video's description describes the film and its posters.
 */
const POSTER = `{
  "ref": asset._ref,
  "width": asset->metadata.dimensions.width,
  "height": asset->metadata.dimensions.height,
  "alt": "",
  "crop": crop{top, bottom, left, right},
  "hotspot": hotspot{x, y, width, height}
}`

/**
 * A picture or a video. W73b: `hasSound` is the editor's "Has Sound" switch, off unless it was switched on.
 * WQ35: a video is one film with a file for desktops and, when an editor adds them, a file and a poster for phones
 * (`mobileUrl`, `mobilePoster`: each null without one); its description, captions and sound are shared by both.
 */
const MEDIA = `select(
  kind == "video" && defined(video.asset._ref) && defined(poster.asset._ref) => {
    "kind": "video",
    "url": video.asset->url,
    "mobileUrl": mobileVideo.asset->url,
    "poster": poster${POSTER},
    "mobilePoster": select(defined(mobilePoster.asset._ref) => mobilePoster${POSTER}, null),
    "description": coalesce(videoDescription, ""),
    "captionsUrl": captions.asset->url,
    "hasSound": coalesce(hasSound, false)
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
  "url": select(destination == "external" => url, null),
  "sectionId": select(destination == "section" => sectionId, null)
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

/** W80: a module's button (PageHeader's, TextMediaSticky's, TextBlock's): null without both its words and its link. */
const MODULE_BUTTON = `{text, "link": link${LINK}}`

const moduleButtonAt = (field: string): string => `select(defined(${field}.text) && defined(${field}.link.destination) => ${field}${MODULE_BUTTON}, null)`

/** The kinds of module the site draws. `hero` is HeroMedia's old name (W79). */
const MODULE_TYPES =
  '["hero", "heroMedia", "upcomingEvents", "pageHeader", "galleryCarousel", "accordionList", "textMediaSticky", "textBlock", "sectionSpacer", "memberships", "sessionPasses"]'

/**
 * W73b: a page's modules, top to bottom, each with the fields of its own kind. A kind the site doesn't know is left
 * out. HeroMedia is one of them (Wayne, 24 Nov), no longer a field of the page: its picture or video (null until an
 * editor adds one) and its button, which is there only when it is switched on and has words. A button with no link
 * opens the booking panel.
 *
 * W79 (WQ79): the module's Sanity type was `hero` until W79 and is `heroMedia` now. A module still saved as `hero`
 * (Home's, until the lead moves it after the Studio is deployed) is read as `heroMedia`, so the live site never
 * loses its hero. Remove `"hero"` from both lists and the `select` in the tidy-up.
 *
 * W80: the content modules (PageHeader, GalleryCarousel, AccordionList, TextMediaSticky, TextBlock, SectionSpacer),
 * and on every module its section's theme (WQ81: null is Light, the page's own; any word but the four is null) and
 * its Section ID (WQ83: null with none). A module's button is there only with both its words and its link; a
 * question only with its words; a gallery's item only with its file. A choice an editor has not made is its default.
 *
 * W81: the Memberships and Session Passes modules. An editor gives each its heading, and Memberships the note under
 * its cards; the cards themselves are the Membership and Session Pass documents (the two queries after the pages').
 */
const MODULES = `coalesce(modules[_type in ${MODULE_TYPES}]{
  "type": select(_type == "hero" => "heroMedia", _type),
  "key": _key,
  "theme": select(theme in ["light", "dark", "fjord", "mud"] => theme, null),
  "sectionId": sectionId,
  _type == "pageHeader" => {
    title,
    "intro": ${richTextAt('intro')},
    "layout": select(layout == "stacked" => "stacked", "split"),
    "buttons": coalesce(buttons[defined(text) && defined(link.destination)]{"key": _key, text, "link": link${LINK}}, [])
  },
  _type == "galleryCarousel" => {
    "items": coalesce(items[]{"key": _key, "media": ${MEDIA}}[defined(media)], [])
  },
  _type == "accordionList" => {
    heading,
    "padding": coalesce(padding, true),
    "items": coalesce(items[defined(question)]{"key": _key, question, "answer": ${richTextAt('answer')}}, [])
  },
  _type == "textMediaSticky" => {
    heading,
    "text": ${richTextAt('text')},
    "button": ${moduleButtonAt('button')},
    "media": select(defined(media) => media{"item": ${MEDIA}}.item, null),
    "size": select(size == "big" => "big", "small"),
    "flip": coalesce(flip, false)
  },
  _type == "textBlock" => {
    heading,
    "text": ${richTextAt('text')},
    "button": ${moduleButtonAt('button')},
    "align": select(alignment in ["center", "right"] => alignment, "left")
  },
  _type in ["hero", "heroMedia"] => {
    "media": select(defined(media) => media{"item": ${MEDIA}}.item, null),
    "button": select(
      showButton == true && defined(buttonText) => {
        "text": buttonText,
        "link": select(defined(buttonLink.destination) => buttonLink${LINK}, null)
      },
      null
    )
  },
  _type == "upcomingEvents" => {heading},
  _type == "memberships" => {heading, "note": ${richTextAt('note')}},
  _type == "sessionPasses" => {heading}
}, [])`

const CONTENT_PAGE = `{
  "id": _id,
  title,
  "slug": slug.current,
  "isHome": ${IS_HOME},
  "thumbnail": ${pictureAt('thumbnail')},
  "modules": ${MODULES},
  "seo": ${seoAt('seo')}
}`

/** The page Site settings picks as the home page: what `/` shows. */
export const HOME_PAGE_QUERY = `*[_type == "contentPage" && ${PUBLISHED} && ${IS_HOME}][0]${CONTENT_PAGE}`

/** The page at /[slug] ($slug). */
export const CONTENT_PAGE_QUERY = `*[_type == "contentPage" && ${PUBLISHED} && slug.current == $slug][0]${CONTENT_PAGE}`

/** W81 (WQ86): a card's benefits, each with the billing it shows for: any word but the two is both. One with no words is left out. */
const benefitsAt = (field: string): string => `coalesce(${field}[defined(text)]{"key": _key, text, "showFor": select(showFor in ["monthly", "yearly"] => showFor, "both")}, [])`

/** A card's place in its row: its Order, the lowest first; one with none comes after those with one, the first made first. */
const CARD_ORDER = 'order(coalesce(order, 1000000) asc, _createdAt asc)'

/**
 * W81 (WQ84): the Membership cards, in their order: each one's name, the line above it, its benefits, and its two
 * plans by their document ids (null with none chosen, or one that is not published). Which plans are on sale, and
 * every price, come from the Worker by those ids (lib/memberships/cards.ts).
 */
export const MEMBERSHIP_CARDS_QUERY = `*[_type == "membershipCard" && ${PUBLISHED} && defined(name)] | ${CARD_ORDER}{
  "id": _id, name, line,
  "corePlan": corePlan->_id,
  "allAccessPlan": allAccessPlan->_id,
  "benefits": ${benefitsAt('benefits')},
  "herdBenefits": ${benefitsAt('herdBenefits')}
}`

/** W81 (WQ84): the Session Pass cards, in their order, each with its two passes by their document ids. */
export const SESSION_PASS_CARDS_QUERY = `*[_type == "sessionPassCard" && ${PUBLISHED} && defined(name)] | ${CARD_ORDER}{
  "id": _id, name, line,
  "corePass": corePass->_id,
  "allAccessPass": allAccessPass->_id
}`

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

/**
 * W75 (WQ60): the page that holds the Upcoming Events list, which is where an Event page's "All Events" goes
 * (/exclusive-hire#events: the slug is Sanity's, never typed into the site). The first made, should two pages hold one.
 * W80 (WQ83): `sectionId` is the Section ID an editor gave that page's first list, null with none: the list is then
 * `events`, as it always was.
 */
export const EVENTS_LIST_PAGE_QUERY = `*[_type == "contentPage" && ${PUBLISHED} && defined(slug.current) && count(modules[_type == "upcomingEvents"]) > 0]
  | order(_createdAt asc)[0]{"slug": slug.current, "isHome": ${IS_HOME}, "sectionId": modules[_type == "upcomingEvents"][0].sectionId}`

/** The one gift card (WQ19): the first made, should there ever be two. Its two galleries, swapped by the page's switch. */
export const GIFT_CARD_QUERY = `*[_type == "giftCardType" && ${PUBLISHED}] | order(_createdAt asc)[0]{
  "id": _id, name, ${CATEGORY},
  "physicalGallery": ${galleryAt('physicalGallery')},
  "digitalGallery": ${galleryAt('digitalGallery')},
  "description": ${richTextAt('description')}, "terms": ${richTextAt('terms')}, "seo": ${seoAt('seo')}
}`

/**
 * W77: every add-on's picture, for the booking panel's add-on cards: its first image (the one the staff app shows), null
 * with none or one that has no file. An add-on's `images` is a list of plain images each with its own alt text, older
 * than the `media` block (WQ43) and read by the Worker's Sanity webhook, so it is read as it is. Which add-ons are on
 * sale, their names and their prices come from the Worker.
 */
export const ADDONS_QUERY = `*[_type == "addon" && ${PUBLISHED}] | order(_createdAt asc){"id": _id, "picture": ${pictureAt('images[0]')}}`

/**
 * W72a: the document of one type ($type) that had this slug ($slug) before and has another now: where an old
 * address has moved to (./redirects.ts). Never the document that has the slug now, so an address can't be sent to
 * itself. The Studio lets one document of a type hold an old slug; should two, the one changed last.
 */
export const MOVED_SLUG_QUERY = `*[_type == $type && ${PUBLISHED} && $slug in previousSlugs && defined(slug.current) && slug.current != $slug]
  | order(_updatedAt desc)[0]{"slug": slug.current, "isHome": ${IS_HOME}}`
