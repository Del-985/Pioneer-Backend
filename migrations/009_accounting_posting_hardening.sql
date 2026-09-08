CREATE OR REPLACE FUNCTION sync_accounting_event_on_journal_post()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'posted'
     AND OLD.status IS DISTINCT FROM 'posted'
     AND NEW.source_type IS NOT NULL
     AND NEW.source_id IS NOT NULL THEN
    UPDATE accounting_events
    SET status = 'posted',
        journal_entry_id = NEW.id,
        updated_at = now()
    WHERE business_unit_id = NEW.business_unit_id
      AND legal_entity_id = NEW.legal_entity_id
      AND source_type = NEW.source_type
      AND source_id = NEW.source_id
      AND status = 'pending';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_entries_sync_accounting_event ON journal_entries;
CREATE TRIGGER journal_entries_sync_accounting_event
AFTER UPDATE OF status ON journal_entries
FOR EACH ROW EXECUTE FUNCTION sync_accounting_event_on_journal_post();

CREATE OR REPLACE FUNCTION guard_accounting_event_journal_link()
RETURNS trigger AS $$
DECLARE
  journal_business_unit_id uuid;
  journal_legal_entity_id uuid;
  journal_source_type text;
  journal_source_id uuid;
BEGIN
  IF NEW.journal_entry_id IS NULL OR NEW.journal_entry_id IS NOT DISTINCT FROM OLD.journal_entry_id THEN
    RETURN NEW;
  END IF;

  SELECT business_unit_id, legal_entity_id, source_type, source_id
    INTO journal_business_unit_id, journal_legal_entity_id, journal_source_type, journal_source_id
  FROM journal_entries
  WHERE id = NEW.journal_entry_id;

  IF journal_business_unit_id IS NULL
     OR journal_source_type IS NULL
     OR journal_source_id IS NULL
     OR journal_business_unit_id <> NEW.business_unit_id
     OR journal_legal_entity_id <> NEW.legal_entity_id
     OR journal_source_type <> NEW.source_type
     OR journal_source_id <> NEW.source_id THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS accounting_events_guard_journal_link ON accounting_events;
CREATE TRIGGER accounting_events_guard_journal_link
BEFORE UPDATE OF journal_entry_id, status ON accounting_events
FOR EACH ROW EXECUTE FUNCTION guard_accounting_event_journal_link();
