ALTER TABLE usage_events
  ADD COLUMN pricing_status text,
  ADD COLUMN pricing_amount numeric(30,15),
  ADD COLUMN pricing_flat_amount numeric(30,15),
  ADD COLUMN pricing_catalogue_version text,
  ADD COLUMN pricing_unpriced_model text;

CREATE INDEX usage_events_company_harness_time_idx
  ON usage_events (company_id, harness, occurred_at DESC);

CREATE TABLE api_rate_limits (
  key_hash bytea NOT NULL,
  window_start timestamptz NOT NULL,
  request_count bigint NOT NULL CHECK (request_count > 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (key_hash, window_start)
);

CREATE INDEX api_rate_limits_expiry_idx ON api_rate_limits (expires_at);
