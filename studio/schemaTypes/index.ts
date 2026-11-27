import { serviceType } from './serviceType'
import { product } from './product'
import { addon } from './addon'
import { membershipPlan } from './membershipPlan'
import { sessionPassType } from './sessionPassType'
import { giftCardType } from './giftCardType'
import { event } from './event'
import { productCategory } from './productCategory'
import { productFamily } from './productFamily'
import { sizeGuide } from './sizeGuide'
import { contentPage } from './contentPage'
import { infoPage } from './infoPage'
import { blogPost } from './blogPost'
import { siteSettings } from './siteSettings'
import { navigation } from './navigation'
import { shopSettings } from './shopSettings'
import { eventsSettings } from './eventsSettings'
import { accordionItem, accordionList } from './objects/accordionList'
import { galleryCarousel } from './objects/galleryCarousel'
import { heroMedia } from './objects/heroMedia'
import { leadText } from './objects/leadText'
import { linkTo } from './objects/linkTo'
import { media } from './objects/media'
import { moduleButton } from './objects/moduleButton'
import { navLink } from './objects/navLink'
import { pageHeader } from './objects/pageHeader'
import { picture } from './objects/picture'
import { richText } from './objects/richText'
import { sectionSpacer } from './objects/sectionSpacer'
import { seo } from './objects/seo'
import { textBlock } from './objects/textBlock'
import { textMediaSticky } from './objects/textMediaSticky'
import { upcomingEvents } from './objects/upcomingEvents'

export const schemaTypes = [
  // Catalog types (sync to Supabase via webhook)
  serviceType,
  product,
  addon,
  membershipPlan,
  sessionPassType,
  giftCardType,
  event,
  // A product's category: a row of its own through the webhook (W72a)
  productCategory,

  // Content types (Sanity-only)
  contentPage,
  infoPage,
  blogPost,
  productFamily,
  sizeGuide,

  // Single documents (Sanity-only): one of each, see structure.ts
  siteSettings,
  navigation,
  shopSettings,
  eventsSettings,

  // Building blocks
  picture,
  media,
  richText,
  seo,
  linkTo,
  navLink,
  leadText,
  moduleButton,

  // A page's modules (05 Modules > Content)
  heroMedia,
  upcomingEvents,
  pageHeader,
  galleryCarousel,
  accordionItem,
  accordionList,
  textMediaSticky,
  textBlock,
  sectionSpacer,
]
