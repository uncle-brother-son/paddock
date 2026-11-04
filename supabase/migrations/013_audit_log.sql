-- Brief W01: who did what, written by the Worker in the same transaction as the change.

CREATE TABLE public.audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL CHECK (actor_type IN ('staff', 'customer', 'system')),
  actor_id text,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  request_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_entity_idx ON public.audit_log (entity_type, entity_id);
CREATE INDEX audit_log_actor_idx ON public.audit_log (actor_id, at);
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.audit_log IS 'Who did what through the Worker. action is noun.verb, e.g. booking.cancel. actor_id is the staff or customer id; null for the system.';
