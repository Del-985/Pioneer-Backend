-- Follow-up cleanup: one active Incident Report was created while the prior cleanup deploy was running.
-- Remove that remaining current form and its orphaned stored file so the library is empty
-- before the replacement Pioneer Outdoor Services form set is uploaded.

CREATE TEMP TABLE remaining_outdoor_incident_files ON COMMIT DROP AS
SELECT DISTINCT f.file_id
FROM forms f
JOIN business_units bu ON bu.id = f.business_unit_id
WHERE bu.name = 'Pioneer Outdoor Services'
  AND f.name = 'Incident Report'
  AND f.version = '1'
  AND f.status = 'active'
  AND f.file_id IS NOT NULL;

DELETE FROM forms f
USING business_units bu
WHERE f.business_unit_id = bu.id
  AND bu.name = 'Pioneer Outdoor Services'
  AND f.name = 'Incident Report'
  AND f.version = '1'
  AND f.status = 'active';

DELETE FROM files fi
USING remaining_outdoor_incident_files old
WHERE fi.id = old.file_id
  AND NOT EXISTS (
    SELECT 1
    FROM forms remaining
    WHERE remaining.file_id = fi.id
  );
