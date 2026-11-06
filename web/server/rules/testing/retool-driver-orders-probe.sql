-- The expressions and parameters the order code uses that retool-driver-probe.sql does not cover.
-- retool-driver-orders-values.json is what the real Retool resource gave on 5 Nov 2026, through
-- `retool resource explore` (classified read-only; no table is read).
SELECT
  (SELECT json_agg(t) FROM (SELECT 1 AS a, 'b'::text AS c) t) AS json_agg_value,
  jsonb_build_object('at', '2026-11-04 19:56:05.983+00'::timestamptz, 'amount', 12.50::numeric) AS jsonb_built,
  '[1,{"a":null}]'::jsonb AS jsonb_array,
  'null'::jsonb AS jsonb_json_null,
  sum(x)::numeric(10,2) AS sum_numeric,
  sum(1) AS sum_int,
  extract(epoch FROM '2026-11-04'::date) AS extract_value,
  1.5::float8 AS float8_value,
  2.5::real AS real_value,
  ARRAY['00000000-0000-4000-8000-000000000001'::uuid] AS uuid_array,
  ARRAY[1.50::numeric] AS numeric_array,
  ARRAY[1, 2]::int[] AS int_array,
  ARRAY[true] AS bool_array,
  ('2026-11-04 10:00:00+00'::timestamptz)::date AS timestamptz_as_date,
  '09:30:00'::time + '00:30:00'::interval AS time_plus_interval
FROM (SELECT 1.5 AS x) s
