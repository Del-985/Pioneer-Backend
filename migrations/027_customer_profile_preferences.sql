ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS preferred_contact_method text NOT NULL DEFAULT 'text'
    CHECK (preferred_contact_method IN ('text', 'phone', 'email')),
  ADD COLUMN IF NOT EXISTS notify_service_confirmations boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_schedule_changes boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_weather_updates boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_marketing boolean NOT NULL DEFAULT false;
