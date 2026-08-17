import { serviceType } from './serviceType'
import { product } from './product'
import { addon } from './addon'
import { membershipPlan } from './membershipPlan'
import { sessionPassType } from './sessionPassType'
import { page } from './page'
import { blogPost } from './blogPost'
import { galleryImage } from './galleryImage'

export const schemaTypes = [
  // Catalog types (sync to Supabase via webhook)
  serviceType,
  product,
  addon,
  membershipPlan,
  sessionPassType,
  
  // Content types (Sanity-only)
  page,
  blogPost,
  galleryImage,
]
