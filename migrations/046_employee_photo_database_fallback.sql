-- Photo binary fallback for employee field reports.
-- Matches the established database-backed bookkeeping attachment pattern.
-- Keep binary content private; it is served only after checking employee
-- assignment or business-unit manager permissions.
ALTER TABLE field_job_photos
  ADD COLUMN storage_provider text NOT NULL DEFAULT 'object_storage'
  CONSTRAINT field_job_photos_storage_provider_check
    CHECK (storage_provider IN ('database','object_storage'));

CREATE TABLE field_job_photo_contents (
  photo_id uuid PRIMARY KEY REFERENCES field_job_photos(id) ON DELETE CASCADE,
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(content) > 0 AND octet_length(content) <= 10485760)
);

COMMENT ON TABLE field_job_photo_contents IS
  'Private employee job photograph binary data for installations without an S3-compatible object store.';
