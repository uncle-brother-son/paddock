// Brief W72a item 5: the one-off content moves. Run by the lead, with Wayne's yes, AFTER the W72a Worker is live, the
// webhook's filter has `productCategory` and the Studio is deployed (each change here is a publish, so the webhook
// writes the category's row, the product's category id and the new pictures).
//
// From studio/:
//   npx sanity exec scripts/w72a-content-moves.ts --with-user-token                 prints the plan, changes nothing
//   npx sanity exec scripts/w72a-content-moves.ts --with-user-token -- --write      prints the plan, then makes it
//   add --unset-images after --write (or alone, for its plan) to also take the old `images` field off each document
//
// What it does is worked out in lib/contentMovesW72a.ts (tested in web/lib/sanity/content-moves.test.ts): an
// "Apparel" category made if there is none, each product whose category is the word "apparel" pointed at it, and the
// old `images` of each product, event and gift card copied into its gallery (the gift card's Physical gallery). All
// of it in one transaction: every change, or none. A second run finds nothing to change.
import {getCliClient} from 'sanity/cli'
import {describePlan, planContentMoves, type MovedDocument} from '../lib/contentMovesW72a'

// The two things of Node's `process` this script uses (the Studio has no Node type package).
declare const process: {argv: string[]; exitCode?: number}

const write = process.argv.includes('--write')
const unsetImages = process.argv.includes('--unset-images')

// Every version of every document: a draft is moved with its published document.
const client = getCliClient({apiVersion: '2025-02-19'}).withConfig({perspective: 'raw', useCdn: false})

const READ = `*[_type in ["product", "event", "giftCardType", "productCategory"]]{
  _id, _type, name, title, slug, category, images, gallery, physicalGallery
} | order(_type asc, _id asc)`

async function run(): Promise<void> {
  const {projectId, dataset} = client.config()
  const documents = await client.fetch<MovedDocument[]>(READ)
  const plan = planContentMoves(documents, {unsetImages})
  console.log(`W72a content moves on ${projectId}/${dataset}: ${documents.length} document(s) read.`)
  for (const line of describePlan(plan)) console.log(line)

  if (!write) {
    console.log('\nDRY RUN: nothing was changed. Run it again with -- --write to make these changes.')
    return
  }
  if (!plan.create && plan.patches.length === 0) {
    console.log('\nNothing was changed.')
    return
  }
  const transaction = client.transaction()
  if (plan.create) transaction.createIfNotExists(plan.create)
  for (const patch of plan.patches) {
    transaction.patch(patch.id, (builder) => {
      const withSet = Object.keys(patch.set).length > 0 ? builder.set(patch.set) : builder
      return patch.unset.length > 0 ? withSet.unset(patch.unset) : withSet
    })
  }
  const result = await transaction.commit()
  console.log(`\nWRITTEN in one transaction (${result.transactionId}): ${result.documentIds.join(', ')}`)
}

run().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
