-- Brief W01: results of comparing an old Retool function with its new Worker endpoint while
-- read-only actions are being moved (shadowCompare in the staff app). The stored results are real
-- screen data, so this table is emptied when the migration ends.

CREATE TABLE public.parity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at timestamptz NOT NULL DEFAULT now(),
  action text NOT NULL,
  request_id text,
  old_result jsonb,
  new_result jsonb,
  matches boolean NOT NULL,
  diff jsonb
);
CREATE INDEX parity_log_action_idx ON public.parity_log (action, at DESC);
ALTER TABLE public.parity_log ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.parity_log IS 'Old-versus-new comparisons from shadowCompare during the move to the Worker. Written only by the Worker.';
