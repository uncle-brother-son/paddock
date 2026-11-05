-- One value of every column type the rules return. retool-driver-values.json is what the staff
-- app's real Retool resource gave for this exact query. To refresh it, run this through
-- paddockData.query with `retool resource explore` (read-only: no table is read).
SELECT
  '00000000-0000-4000-8000-000000000001'::uuid AS uuid_value,
  'text'::text AS text_value,
  true AS bool_value,
  NULL::boolean AS bool_null,
  3::smallint AS int2_value,
  10::integer AS int4_value,
  NULL::integer AS int4_null,
  42::bigint AS int8_value,
  COUNT(*) AS count_value,
  COUNT(*) FILTER (WHERE true) AS count_filter_value,
  20.00::numeric(10,2) AS numeric_scaled,
  15::numeric(5,2) AS numeric_percent,
  0::numeric AS numeric_zero,
  '12.5'::numeric AS numeric_unscaled,
  NULL::numeric AS numeric_null,
  '2026-11-04'::date AS date_value,
  '2026-11-04'::date::text AS date_text,
  NULL::date AS date_null,
  '09:30:00'::time AS time_value,
  '2026-11-04 19:56:05.983+00'::timestamptz AS timestamptz_value,
  '2026-11-04 10:00:00+00'::timestamptz AS timestamptz_whole,
  '2026-11-04 19:56:05.983'::timestamp AS timestamp_value,
  NULL::timestamptz AS timestamptz_null,
  ARRAY['booking','addon']::text[] AS text_array,
  ARRAY[]::text[] AS text_array_empty,
  '{"a":1}'::jsonb AS jsonb_value
FROM (SELECT 1) AS one
