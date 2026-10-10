-- Employee time and correction history are confidential personnel records.
-- Keep them readable only by authorized management, not general business viewers.
DELETE FROM role_permissions rp
USING roles r, permissions p
WHERE rp.role_id=r.id AND rp.permission_id=p.id
  AND r.key='business_viewer' AND p.key='timekeeping.read';
