import { serviceType } from './serviceType'
import { product } from './product'
import { addon } from './addon'
import { membershipPlan } from './membershipPlan'
import { sessionPassType } from './sessionPassType'
import { giftCardType } from './giftCardType'
import { event } from './event'
import { productFamily } from './productFamily'
import { sizeGuide } from './sizeGuide'
import { contentPage } from './contentPage'
import { infoPage } from './infoPage'
import { blogPost } from './blogPost'
import { siteSettings } from './siteSettings'
import { navigation } from './navigation'
import { shopSettings } from './shopSettings'
import { eventsSettings } from './eventsSettings'
import { hero } from './objects/hero'
import { linkTo } from './objects/linkTo'
import { media } from './objects/media'
import { navLink } from './objects/navLink'
import { picture } from './objects/picture'
import { richText } from './objects/richText'
import { seo } from './objects/seo'
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
  hero,
  upcomingEvents,
]
