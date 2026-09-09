ALTER TABLE contact_submissions
  ADD COLUMN IF NOT EXISTS client_request_id text;

CREATE UNIQUE INDEX IF NOT EXISTS contact_submissions_site_client_request_id_uidx
  ON contact_submissions(site_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
