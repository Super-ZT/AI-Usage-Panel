CREATE INDEX manager_sessions_active_idx ON manager_sessions (expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX devices_company_last_seen_idx ON devices (company_id, last_seen_at DESC);
CREATE INDEX enrollment_codes_active_idx ON enrollment_codes (company_id, expires_at)
  WHERE used_at IS NULL;
CREATE INDEX usage_events_company_time_idx ON usage_events (company_id, occurred_at DESC);
CREATE INDEX usage_events_company_device_time_idx ON usage_events (company_id, device_id, occurred_at DESC);
CREATE INDEX usage_rejections_company_time_idx ON usage_rejections (company_id, created_at DESC);
CREATE INDEX audit_facts_company_time_idx ON audit_facts (company_id, created_at DESC);
