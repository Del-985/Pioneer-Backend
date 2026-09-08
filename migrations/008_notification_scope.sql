ALTER TABLE notification_outbox
  ADD COLUMN legal_entity_id uuid REFERENCES legal_entities(id) ON DELETE CASCADE,
  ADD COLUMN business_unit_id uuid REFERENCES business_units(id) ON DELETE CASCADE,
  ADD CONSTRAINT notification_outbox_scope_check
    CHECK (num_nonnulls(legal_entity_id, business_unit_id) <= 1);

CREATE INDEX notification_outbox_legal_entity_idx
  ON notification_outbox(legal_entity_id, created_at DESC)
  WHERE legal_entity_id IS NOT NULL;
CREATE INDEX notification_outbox_business_unit_idx
  ON notification_outbox(business_unit_id, created_at DESC)
  WHERE business_unit_id IS NOT NULL;

CREATE OR REPLACE FUNCTION validate_notification_scope()
RETURNS trigger AS $$
DECLARE
  unit_entity uuid;
BEGIN
  IF NEW.business_unit_id IS NOT NULL THEN
    SELECT legal_entity_id INTO unit_entity FROM business_units WHERE id = NEW.business_unit_id;
    IF unit_entity IS NULL THEN
      RAISE EXCEPTION 'Notification business unit does not exist';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notification_outbox_validate_scope
BEFORE INSERT OR UPDATE OF business_unit_id ON notification_outbox
FOR EACH ROW EXECUTE FUNCTION validate_notification_scope();
