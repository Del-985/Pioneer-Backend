-- Uploaded files are hidden until object storage verifies their existence.
ALTER TABLE field_job_photos ADD COLUMN uploaded_at timestamptz;
