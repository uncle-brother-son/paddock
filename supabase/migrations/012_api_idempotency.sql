-- Brief W01: idempotency records for /api/v1 writes. One row per (actor, endpoint, key): the first
-- call claims it as 'in_progress' and the Worker stores the response when the handler ends, so a
-- double click or retry gets the stored answer instead of running the write twice.

CREATE TABLE public.api_idempotency (
  key text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('staff', 'customer', 'public')),
  actor_id text NOT NULL,
  endpoint text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'done')),
  response jsonb,
  http_status integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_type, actor_id, endpoint, key),
  CHECK (status <> 'done' OR (response IS NOT NULL AND http_status IS NOT NULL))
);
CREATE INDEX api_idempotency_created_at_idx ON public.api_idempotency (created_at);
ALTER TABLE public.api_idempotency ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.api_idempotency IS 'One row per Idempotency-Key on an /api/v1 write. Written only by the Worker; rows older than 7 days are purged nightly.';

CREATE OR REPLACE FUNCTION public.purge_api_idempotency()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  DELETE FROM api_idempotency WHERE created_at < now() - interval '7 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.purge_api_idempotency() FROM public, anon, authenticated;

SELECT cron.schedule('purge-api-idempotency', '25 3 * * *', 'select public.purge_api_idempotency();');
