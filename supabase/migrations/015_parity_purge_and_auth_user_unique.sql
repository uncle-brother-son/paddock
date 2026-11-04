-- Lead, 4 Nov (from the W01 report): parity_log holds real screen data, so rows older than 30 days
-- are purged nightly; and one login can belong to only one customer.

CREATE OR REPLACE FUNCTION public.purge_parity_log()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  DELETE FROM parity_log WHERE at < now() - interval '30 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.purge_parity_log() FROM public, anon, authenticated;

SELECT cron.schedule('purge-parity-log', '35 3 * * *', 'select public.purge_parity_log();');

CREATE UNIQUE INDEX customers_auth_user_id_key ON public.customers (auth_user_id) WHERE auth_user_id IS NOT NULL;
