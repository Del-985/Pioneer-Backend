-- One-time cleanup before replacing the current reusable forms with the newly branded set.
-- Deletes only the three archived Pioneer Outdoor Services form records that existed
-- before the replacement package, then removes their now-orphaned stored files.

CREATE TEMP TABLE obsolete_outdoor_form_files ON COMMIT DROP AS
SELECT DISTINCT f.file_id
FROM forms f
JOIN business_units bu ON bu.id = f.business_unit_id
WHERE bu.name = 'Pioneer Outdoor Services'
  AND f.name IN ('Incident Report', 'Mileage Log', 'Snow Service Log')
  AND f.version = '1'
  AND f.status = 'archived'
  AND f.file_id IS NOT NULL;

DELETE FROM forms f
USING business_units bu
WHERE f.business_unit_id = bu.id
  AND bu.name = 'Pioneer Outdoor Services'
  AND f.name IN ('Incident Report', 'Mileage Log', 'Snow Service Log')
  AND f.version = '1'
  AND f.status = 'archived';

DELETE FROM files fi
USING obsolete_outdoor_form_files old
WHERE fi.id = old.file_id
  AND NOT EXISTS (
    SELECT 1
    FROM forms remaining
    WHERE remaining.file_id = fi.id
  );
