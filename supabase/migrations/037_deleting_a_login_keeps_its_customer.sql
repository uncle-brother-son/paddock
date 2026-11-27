-- 037: deleting a website login never deletes its customer (Wayne, WQ99, 27 Nov 2026; W85a report "Noticed" 1).
-- NOT APPLIED by W85a. The lead applies it, with Wayne's yes, BEFORE the W85a Worker is pushed: from then on website
-- logins are linked to customers (POST /api/v1/customer/sign-in/link and /create), and a login deleted in Supabase
-- must leave its customer as it was.
-- APPLY IT AS ONE TRANSACTION (`apply_migration`, or the SQL editor's one multi-statement run).
--
-- Before:
--   * customers_auth_user_id_fkey is ON DELETE CASCADE: deleting a login in Supabase (Authentication > Users, or the
--     login closing their account) deletes the customer row it is linked to, and with it, by their own cascades, the
--     customer's bookings, memberships and passes; or the delete fails if the customer has an order, an event booking
--     or a store credit row (those keys don't cascade). Example: Wayne deletes a test sign-in linked to Sam Test: Sam's
--     row and their bookings go, or the delete is refused because Sam has an order.
-- After:
--   * ON DELETE SET NULL: the login goes and the customer stays, with everything they have, no longer linked
--     (auth_user_id empty). Signing in again with the same email links them again (link finds the customer by email
--     with no login). Example: the same delete leaves Sam's row, bookings, credits and orders untouched, with
--     auth_user_id empty.
--
-- What changes, exactly: the one foreign key is dropped and made again with ON DELETE SET NULL, under the same name,
-- on the same column, to the same table. No row is written. Adding it checks every customer's auth_user_id against
-- auth.users once (every live value is there already: the old key held them to it).
--
-- Locks: customers and auth.users are taken for a moment (dropping and adding a foreign key: ACCESS EXCLUSIVE on
-- customers, SHARE ROW EXCLUSIVE on auth.users while the key is checked; a few hundred rows). lock_timeout is 5s: if a
-- long transaction holds either, it stops rather than queueing every sale and every sign-in behind it; run it again.
--
-- Checks after applying (each answers as shown):
--   * the key now sets the login to empty:
--         SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'customers_auth_user_id_fkey';
--     -> FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL
--   * still one such key on customers:
--         SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.customers'::regclass AND contype = 'f' AND confrelid = 'auth.users'::regclass;
--     -> 1

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.customers DROP CONSTRAINT customers_auth_user_id_fkey;
ALTER TABLE public.customers ADD CONSTRAINT customers_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

-- Down (puts the cascade back: a login deleted after that deletes its customer again; only with Wayne's yes):
--   ALTER TABLE public.customers DROP CONSTRAINT customers_auth_user_id_fkey;
--   ALTER TABLE public.customers ADD CONSTRAINT customers_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
