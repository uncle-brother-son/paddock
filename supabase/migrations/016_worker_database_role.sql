-- The Worker's own database login (applied by the lead on 4 Nov). Read and write on the app's tables
-- in the public schema, run its functions, and bypass RLS like the server it is. No schema changes,
-- no other schemas. The password is set separately by Wayne in the SQL editor, never in a migration.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paddock_worker') THEN
    CREATE ROLE paddock_worker WITH LOGIN BYPASSRLS NOINHERIT;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO paddock_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO paddock_worker;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO paddock_worker;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO paddock_worker;
GRANT USAGE ON SCHEMA extensions TO paddock_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO paddock_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO paddock_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO paddock_worker;
ALTER ROLE paddock_worker SET search_path = public, extensions;
