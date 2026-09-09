-- Database-backed fallback for reusable form files when S3-compatible object storage is not configured.
-- Object storage remains the preferred provider when configured; this table is only used by the Forms library fallback.

CREATE TABLE form_file_contents (
  file_id uuid PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(content) <= 26214400)
);

COMMENT ON TABLE form_file_contents IS
  'Fallback binary storage for Forms Library files when external object storage is unavailable.';
