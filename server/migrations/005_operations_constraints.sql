ALTER TABLE usage_events
  ALTER COLUMN pricing_status SET NOT NULL,
  ALTER COLUMN pricing_catalogue_version SET NOT NULL,
  ADD CONSTRAINT usage_events_pricing_status_check
    CHECK (pricing_status IN ('priced', 'partial', 'unknown')),
  ADD CONSTRAINT usage_events_pricing_amount_check
    CHECK (
      (pricing_status = 'unknown' AND pricing_amount IS NULL AND pricing_flat_amount IS NULL)
      OR
      (pricing_status IN ('priced', 'partial') AND pricing_amount IS NOT NULL AND pricing_flat_amount IS NOT NULL)
    );
