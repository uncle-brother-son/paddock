# Webhooks: Sanity and Stripe

Both are routes of the one Worker (`web/`, https://paddock.paddock-55d.workers.dev), on the Worker's own database
connection (the role `paddock_worker`, through Hyperdrive). Neither uses a Supabase key: the service-role key is read by
nothing since W66 (`web/server/no-service-role-key.test.ts`).

## Sanity: `/api/sanity/webhook`

Keeps a row in Postgres for each catalogue document published in Sanity Studio (`web/server/rules/catalog/sanity-sync.ts`).
Sanity owns the content. Prices, stock and whether an item is on sale are set in the staff app and never come from here.

| Document | Row | What Sanity's publish writes |
|---|---|---|
| `serviceType` | `service_types` | name, thumbnail (the first of its `images`) |
| `product` | `products` | name, its category's Sanity id, thumbnail (the first image of its gallery) |
| `addon` | `addons` | name, category (one of its three words), thumbnail (the first of its `images`) |
| `membershipPlan` | `membership_plans` | name, thumbnail (the first of its `images`); its Stripe product made once and renamed (below) |
| `sessionPassType` | `session_pass_types` | name, thumbnail (the first of its `images`) |
| `giftCardType` | `gift_card_types` | name, thumbnail (the first image of its Physical gallery, else of its Digital one) |
| `event` | `events` | name, thumbnail (the first image of its gallery), whether it has an extra waiver and that waiver's version |
| `productCategory` | `product_categories` | title, order (W72a; migration 035) |

Every other document (pages, info pages, blog posts, families, size guides, settings) stays in Sanity: the webhook answers 200 and writes nothing.

**Galleries (W72a).** A product's, an event's and the gift card's pictures are galleries of images and videos. The
thumbnail is the first **image** in the gallery: a video is skipped, wherever it is. A gallery with no image (empty, or
videos only) gives no thumbnail; it is never an error.

**Product categories (W72a).** A category is a document of its own, and a product's row holds its category's Sanity
id (never its title), so renaming a category in Sanity changes one row and every product shows the new name. The staff
app lists the categories from `product_categories`.

**What happens on each delivery**
- **Published for the first time:** the row is made **off sale** (Q57). Staff set its price and put it on sale in the
  staff app, which refuses "on" until it has one (Q61, "Set its price first.").
- **Published again:** only the fields above change. On or off sale, prices and stock are left as staff set them.
- **Deleted or unpublished:** the item goes **off sale**, with an audit row by the system as `sanity`. The row is never
  deleted. One already off sale is left alone. The document is the one named in the **signed body** (`_id`): the
  `sanity-document-id` header isn't signed, and one that differs is refused (400), as is a body that names none.
- **A membership plan deleted while a price change on it is open** stays on sale (the plan rule's own guard), and is a
  line on the Orders page's list of things that need attention until it is taken off sale or marked sorted.
- **A product category published** (new, renamed or reordered): its row is made or brought up to date. No product row
  is written.
- **A product category deleted:** its row is deleted, unless a product row still names it. Then the row is left, the
  delivery answers 200 with `kept: "category_in_use"` and how many products name it, and the Worker's log says so.
  (Sanity itself refuses to delete a category a published product points to, so this is a delete that arrived out of
  order, or a product row behind its document: publish that product again, then delete the category again.)
- **A membership plan's Stripe product** is made under a key from the plan's id (two deliveries make one), and its name
  and picture are sent on every publish. A Stripe failure is logged, the delivery still answers 200, and the next publish
  puts it right. No other document touches Stripe.
- **Drafts** are ignored.

**The signature:** `sanity-webhook-signature: t=<time>,v1=<hash>`, checked with `SANITY_WEBHOOK_SECRET` (a Cloudflare
secret) before anything is read, in constant time. One signed more than 5 minutes ago is refused, so a captured request
can't be sent again later.

**Answers:** 200 done (or nothing to do); 400 a delete whose document can't be trusted; 401 a bad, missing or old
signature; 500 the database couldn't be written (Sanity sends it again twice, 30 seconds apart).

### Set-up in Sanity

sanity.io/manage, project `qx4gqx7t`, API, Webhooks:

- **URL:** `https://paddock.paddock-55d.workers.dev/api/sanity/webhook` (the live site's address at go-live)
- **Dataset:** `production`. **Trigger on:** Create, Update **and Delete**. **Drafts and versions:** off.
- **Filter:** `_type in ["serviceType", "product", "addon", "membershipPlan", "sessionPassType", "giftCardType", "event", "productCategory"]`

  This is a fixed list, not a wildcard. A new catalogue type in the webhook's code does nothing until its name is added
  here too: Sanity never calls for a type that isn't listed, and no delivery even shows in its log. (`giftCardType` was
  missing once, for weeks.) `productCategory` was added for W72a: without it no category ever gets a row, and the staff
  app shows every product under "No category".
- **Projection:** left empty (the whole document). A delete must carry the document's `_id` in its body (step 3 below proves
  it). If one is answered 400 "No document id in the signed body", Sanity sends no document on a delete: set a projection
  that does (for example `{..., "_id": coalesce(_id, before()._id)}`, not tried yet).
- **HTTP method:** POST. **HTTP headers:** none (Sanity adds the signature itself).
- **Secret:** the value of the Worker's `SANITY_WEBHOOK_SECRET`. To change it: a new one (`openssl rand -base64 32`) in
  Cloudflare and in Sanity, one straight after the other.

### Checking it

1. In the Studio, publish a small change to a product. In Sanity's webhook, the attempts log shows 200.
2. In the staff app, the product has its new name, with its price and On sale as they were.
3. A delete (or an unpublish) of a test item: 200, and the item is off sale.

| What you see | Look at |
|---|---|
| 401 | The secret in Sanity and in Cloudflare differ, or the delivery is more than 5 minutes old |
| 400 | A delete: the Worker's log says which document; the body it was sent has no `_id` (the projection was changed) or another document's |
| 500 | The Worker's logs for that delivery (Cloudflare, Workers, `paddock`, Logs). Sanity sends it again |
| No delivery at all | The Filter: is the document's `_type` in it? Was it published, not only saved as a draft? |
| No picture | `thumbnail_url` should be `https://cdn.sanity.io/images/...`: does the document's first image have an asset? A product, an event or the gift card: is there an image in its gallery (a video gives none)? |
| A product under "No category" in the staff app | Is `productCategory` in the Filter? Has the category been published? Has the product been published since its category was picked? |

## Stripe: `/api/stripe/webhook`

Subscription and invoice events (`web/app/api/stripe/webhook/`). Each is checked against `STRIPE_WEBHOOK_SECRET`, claimed
once in `stripe_webhook_events` (a second delivery of an event already taken answers 200 and does nothing), read live from
Stripe where its own data may be old, and written by one database function in one short transaction. A failure answers
500, so Stripe sends it again for three days. Notices in error for over an hour are a line on the Orders page's list.
What each event does is in `web/server/rules/README.md` (W46, W66).
