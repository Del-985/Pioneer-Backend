-- One-time production verification after the Forms Library wipe.
-- This migration fails if any Forms-specific data survived cleanup.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM forms) THEN
    RAISE EXCEPTION 'Forms wipe verification failed: forms rows remain';
  END IF;

  IF EXISTS (SELECT 1 FROM files WHERE category = 'form') THEN
    RAISE EXCEPTION 'Forms wipe verification failed: form file metadata remains';
  END IF;

  IF EXISTS (SELECT 1 FROM form_file_contents) THEN
    RAISE EXCEPTION 'Forms wipe verification failed: stored form file bytes remain';
  END IF;

  IF EXISTS (
    SELECT 1 FROM audit_log
    WHERE resource_type = 'form' OR action LIKE 'form.%'
  ) THEN
    RAISE EXCEPTION 'Forms wipe verification failed: form audit rows remain';
  END IF;
END $$;
