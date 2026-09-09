-- Database-backed fallback for bookkeeping attachment bytes when external object storage is unavailable.

CREATE TABLE bookkeeping_attachment_contents (
  file_id uuid PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(content) <= 104857600)
);

COMMENT ON TABLE bookkeeping_attachment_contents IS
  'Fallback binary storage for bookkeeping attachments when S3-compatible object storage is unavailable.';
