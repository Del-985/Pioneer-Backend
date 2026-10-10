-- Imported provider files are retried only when the same request key AND payload match.
ALTER TABLE payroll_provider_batches
  ADD COLUMN import_digest text CHECK(import_digest IS NULL OR
    (length(import_digest)=64 AND import_digest ~ '^[0-9a-f]+$'));
