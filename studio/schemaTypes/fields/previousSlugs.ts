import { defineField } from 'sanity'

/**
 * The addresses a document had before (W72a; docs/build-standards.md: a changed slug keeps working). Nobody types
 * here: the Publish action adds the slug being replaced (actions/keepPreviousSlugs.ts), and the site answers each
 * with a 301 to the current address (web/lib/sanity/redirects.ts). No other document of its type can take one
 * (lib/slugs.ts).
 */
export const previousSlugs = defineField({
  name: 'previousSlugs',
  title: 'Previous Slugs',
  type: 'array',
  of: [{ type: 'string' }],
  description: 'The addresses this had before. Kept automatically: the site sends each on to the current address',
  hidden: true,
  readOnly: true,
})
