import { getPublishedId, type SlugIsUniqueValidator } from 'sanity'
import { SLUG_FREE_QUERY } from './checks'

/**
 * A slug's uniqueness check (W72a): free when no other document of the same type has it now or had it before (its
 * `previousSlugs`), so an old address always leads to the one document that left it. Drafts count: the client reads
 * every version, and the document's own versions are left out by the query.
 */
export const isSlugFree: SlugIsUniqueValidator = async (slug, context) => {
  const { document, getClient } = context
  if (!document?._id || !slug) return true
  const client = getClient({ apiVersion: '2025-02-19' }).withConfig({ perspective: 'raw' })
  return client.fetch<boolean>(SLUG_FREE_QUERY, { type: document._type, published: getPublishedId(document._id), slug })
}
