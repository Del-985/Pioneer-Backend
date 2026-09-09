-- One-time cleanup of Forms Library debugging data.
-- Preserves users, companies, permissions, bookkeeping, and unrelated file records.

DELETE FROM audit_log
WHERE resource_type = 'form'
   OR action LIKE 'form.%';

DELETE FROM forms;

DELETE FROM form_file_contents
WHERE file_id IN (
  SELECT id FROM files WHERE category = 'form'
);

DELETE FROM files
WHERE category = 'form';
