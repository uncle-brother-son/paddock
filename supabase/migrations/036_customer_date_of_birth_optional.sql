-- 036: a customer's date of birth may be left empty (brief W85a item 1; backend log 10; the lead, 27 Nov 2026).
-- NOT APPLIED by W85a. The lead applies it, with Wayne's yes, BEFORE the W85a Worker is pushed: the website's sign-up
-- (POST /api/v1/customer/sign-in/create) writes a customer with no date of birth, and is refused by the database
-- without it. The sign-in link (POST /api/v1/customer/sign-in/link) and "who am I" (GET /api/v1/customer/me) don't
-- need it.
-- APPLY IT AS ONE TRANSACTION (`apply_migration`, or the SQL editor's one multi-statement run).
--
-- Before:
--   * customers.date_of_birth is NOT NULL, so every customer must give one when the row is made. Example: someone who
--     signs up on the website to buy a gift card would have to type a date of birth nobody needs.
-- After:
--   * it may be empty. Only the account holder gives one, and only when it is needed: attending a session or an event,
--     or buying a membership or a pass (the website's checkout asks then; the checkout brief). Example: the website's
--     sign-up (first name, last name, phone optional) makes a customer with no date of birth; staff's New customer form
--     still asks for one, as now (server/rules/customers/create.ts is unchanged).
--
-- What changes, exactly: the one column loses NOT NULL. No row is written or rewritten, no default is added, nothing
-- else in the schema changes. Every reader of the column copes with an empty one (brief W85a's report lists them).
--
-- Locks: ALTER COLUMN ... DROP NOT NULL takes customers for a moment (ACCESS EXCLUSIVE, no table scan). lock_timeout is
-- 5s: if a long transaction holds customers, it stops rather than queueing every sale behind it; run it again.
--
-- Checks after applying (each answers as shown):
--   * the column may be empty:
--         SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'date_of_birth';
--     -> YES
--   * no row changed (the same count of customers with a date of birth as before):
--         SELECT count(*) FILTER (WHERE date_of_birth IS NULL) AS without_one FROM public.customers;
--     -> 0

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.customers ALTER COLUMN date_of_birth DROP NOT NULL;

-- Down (only while no customer has an empty date of birth: the first statement must answer 0, or SET NOT NULL fails;
-- a website customer made after 036 has none, so the Down then needs a decision, not a script):
--   SELECT count(*) FROM public.customers WHERE date_of_birth IS NULL;
--   ALTER TABLE public.customers ALTER COLUMN date_of_birth SET NOT NULL;
