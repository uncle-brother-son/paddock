-- 035: product categories are rows, mirrored from Sanity (brief W72a; Wayne's WQ7, 23 Nov 2026; the lead's design,
-- 24 Nov 2026).
-- NOT APPLIED by W72a. The lead applies it BEFORE the W72a Worker is pushed: the Worker's products read
-- (GET /api/v1/staff/catalog/products), its categories read (GET /api/v1/staff/catalog/product-categories) and the
-- Sanity webhook all name the new table, and fail without it.
-- APPLY IT AS ONE TRANSACTION (`apply_migration`, or the SQL editor's one multi-statement run).
--
-- Before:
--   * a product's category is one of three words fixed in the Studio's code (apparel, accessories, equipment), copied
--     into products.category by the Sanity webhook. The client can't add a category, and the staff app's filter shows
--     the stored word. Example: a "Books" category needs a code change in the Studio and a deploy.
-- After:
--   * a category is a document in Sanity (productCategory: title, slug, order). The webhook keeps one row for each in
--     product_categories, and a product's row holds its category's Sanity id in products.category. The staff app lists
--     the categories by title from this table, so a category renamed in Sanity shows its new name everywhere at once.
--     Example: "Apparel" renamed "Clothing" in Sanity: one row's title changes, and every product in it reads
--     "Clothing" on the next page load; no product row is written.
--
-- What changes, exactly: one new table (empty), with its primary key's index, row level security on and the Worker's
-- role's rights; and a comment on products.category. products.category stays text and no product row is written or
-- rewritten: the one live product keeps the word `apparel` until its Sanity document is pointed at a category (the
-- W72a content move), when the webhook writes the category's id over it. Until then the new staff app shows it under
-- "No category". Add-ons are not touched (addons.category stays one of its three words).
-- No foreign key from products.category: Sanity's deliveries come in any order (a product can arrive before its
-- category), and a category deleted in Sanity while a product row still names it keeps its row (the Worker's rule,
-- web/server/rules/catalog/sanity-sync.ts).
--
-- Locks: a new table and a comment. The comment takes products for a moment (SHARE UPDATE EXCLUSIVE: a sale reading
-- or writing a product is not held up). lock_timeout is 5s.
--
-- PRE-CHECKS (read-only; the lead runs them first, and stops if one isn't as said).
--   P1. The table isn't there yet. Expect null.
--        SELECT to_regclass('public.product_categories');
--   P2. What the product rows hold now, to compare after the content move. Expect one row: apparel, 1 (24 Nov 2026).
--        SELECT category, count(*) FROM public.products GROUP BY category ORDER BY category;
--
-- Checks after applying (read-only), each with what to expect:
--   1. The table is there, empty, with row level security on: 0, true.
--        SELECT count(*) FROM public.product_categories;
--        SELECT relrowsecurity FROM pg_class WHERE oid = 'public.product_categories'::regclass;
--   2. The Worker's role can read, insert, update and delete a category: true, true, true, true.
--        SELECT has_table_privilege('paddock_worker', 'public.product_categories', 'SELECT');
--        SELECT has_table_privilege('paddock_worker', 'public.product_categories', 'INSERT');
--        SELECT has_table_privilege('paddock_worker', 'public.product_categories', 'UPDATE');
--        SELECT has_table_privilege('paddock_worker', 'public.product_categories', 'DELETE');
--   3. No product row changed: the same answer as P2.
--        SELECT category, count(*) FROM public.products GROUP BY category ORDER BY category;
--   4. Standing, once the W72a Worker is live, the webhook's filter has `productCategory` and the content move has
--      run (expect no row): a product whose category is not a category's id.
--        SELECT p.id, p.name, p.category FROM public.products p
--         WHERE p.category IS NOT NULL
--           AND NOT EXISTS (SELECT 1 FROM public.product_categories c WHERE c.sanity_category_id = p.category);
-- Then refresh the saved schema (web/server/rules/testing/README.md, "Refreshing the live schema"): the diff should
-- show nothing (the saved schema carries 035 already).
--
-- ROLLBACK. The W72a Worker needs the table, so roll the Worker back first; then the Down at the end. A product row
-- whose category the webhook has already set to a Sanity id keeps it (the older staff app shows that id as the
-- category's name; publishing the product again from the older Studio writes its word back).
-- BEFORE ANY DOWN (read-only; go ahead only on false):
--        SELECT count(*) > 0 AS categories_would_be_lost FROM public.product_categories;
--   True: the rows are only a copy of Sanity's documents, so nothing is lost for good, but note them first
--   (SELECT * FROM public.product_categories ORDER BY sort_order, title): publishing each category again in Sanity
--   is what brings them back after a later re-apply.

SET LOCAL lock_timeout = '5s';

-- 1. The categories. One row for each productCategory document published in Sanity, by the document's id. The
--    Sanity webhook makes the row and brings it up to date (title, order), and deletes it when the document is deleted
--    and no product row names it. `sort_order` is the document's Order (lowest first; empty sorts last).
CREATE TABLE public.product_categories (
  sanity_category_id text PRIMARY KEY,
  title text NOT NULL,
  sort_order integer,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.product_categories ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.product_categories IS 'Product categories, mirrored from Sanity (productCategory documents) by the Worker''s Sanity webhook. products.category holds a row''s sanity_category_id. Never edited by hand: rename or reorder a category in Sanity.';
-- The Worker's role: the webhook writes and deletes, the staff app's reads read. (Migration 016's default privileges
-- give these already; said here so the file stands by itself.)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_categories TO paddock_worker;

-- 2. What products.category now holds. No row is changed.
COMMENT ON COLUMN public.products.category IS 'The Sanity id of the product''s category: product_categories.sanity_category_id (W72a). Written by the Sanity webhook from the product document''s category reference. No foreign key: Sanity''s deliveries come in any order. A value with no row there is a word from before W72a, or a category whose row has not arrived yet.';

-- Down (the table gone, the comment gone):
--   DROP TABLE public.product_categories;
--   COMMENT ON COLUMN public.products.category IS NULL;
