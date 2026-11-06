-- Reads the live database's catalog as one JSON document, for scripts/generate-test-schema.mjs.
-- Catalog only: no table's rows are read. See server/rules/testing/README.md for how to run it.
SELECT json_build_object(
  'postgres', current_setting('server_version'),
  'extensions', (
    SELECT json_agg(json_build_object('name', e.extname, 'schema', n.nspname) ORDER BY e.extname)
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
  ),
  'tables', (
    SELECT json_agg(json_build_object(
      'name', c.relname,
      'columns', (
        SELECT json_agg(json_build_object(
          'name', a.attname,
          'type', format_type(a.atttypid, a.atttypmod),
          'notNull', a.attnotnull,
          'default', pg_get_expr(d.adbin, d.adrelid),
          'generated', a.attgenerated,
          'identity', a.attidentity
        ) ORDER BY a.attnum)
        FROM pg_attribute a
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      )
    ) ORDER BY c.relname)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  ),
  'constraints', (
    SELECT json_agg(json_build_object(
      'table', c.relname, 'name', k.conname, 'type', k.contype, 'definition', pg_get_constraintdef(k.oid)
    ) ORDER BY c.relname, k.conname)
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND k.contype <> 'n'
  ),
  'indexes', (
    SELECT json_agg(json_build_object('name', i.relname, 'definition', pg_get_indexdef(x.indexrelid)) ORDER BY i.relname)
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class c ON c.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = x.indexrelid AND k.contype IN ('p', 'u', 'x'))
  ),
  'views', (
    SELECT json_agg(json_build_object('name', c.relname, 'definition', pg_get_viewdef(c.oid, true)) ORDER BY c.relname)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'v'
  ),
  'viewDependencies', (
    SELECT json_agg(DISTINCT jsonb_build_object('view', v.relname, 'uses', u.relname))
    FROM pg_rewrite r
    JOIN pg_class v ON v.oid = r.ev_class
    JOIN pg_namespace n ON n.oid = v.relnamespace
    JOIN pg_depend d ON d.objid = r.oid AND d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass
    JOIN pg_class u ON u.oid = d.refobjid
    WHERE n.nspname = 'public' AND v.relkind = 'v' AND u.relkind = 'v' AND u.oid <> v.oid
  ),
  'functions', (
    SELECT json_agg(json_build_object(
      'name', p.proname, 'identity', pg_get_function_identity_arguments(p.oid), 'definition', pg_get_functiondef(p.oid)
    ) ORDER BY p.proname, pg_get_function_identity_arguments(p.oid))
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  ),
  'triggers', (
    SELECT json_agg(json_build_object('table', c.relname, 'name', t.tgname, 'definition', pg_get_triggerdef(t.oid)) ORDER BY c.relname, t.tgname)
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
  )
) AS catalog
