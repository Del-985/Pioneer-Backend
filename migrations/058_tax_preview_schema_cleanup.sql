-- Remove the superseded unused payroll_native_tax_* prototype.
-- The canonical v0.4.4 tax system is payroll_tax_* from
-- 057_payroll_tax_withholding.sql. Never discard employee tax evidence.
DO $$
DECLARE table_name text; record_count bigint;
BEGIN
 FOR table_name IN SELECT unnest(ARRAY[
   'payroll_native_tax_elections',
   'payroll_native_tax_previews',
   'payroll_native_tax_lines'
 ]) LOOP
  IF to_regclass('public.'||table_name) IS NOT NULL THEN
   EXECUTE format('SELECT count(*) FROM %I',table_name) INTO record_count;
   IF record_count <> 0 THEN
    RAISE EXCEPTION 'Cannot remove %. It has % records',table_name,record_count;
   END IF;
  END IF;
 END LOOP;
END $$;
DROP TABLE IF EXISTS payroll_native_tax_lines;
DROP TABLE IF EXISTS payroll_native_tax_previews;
DROP TABLE IF EXISTS payroll_native_tax_elections;
