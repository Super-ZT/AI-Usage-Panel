CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_salt bytea NOT NULL,
  password_hash bytea NOT NULL,
  password_params jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);
CREATE UNIQUE INDEX users_email_lower_unique ON users (lower(email));

-- Existing managers become real people without changing their password or
-- invalidating their reviewed manager sessions. Manager rows remain as a
-- compatibility projection for the existing company dashboard.
INSERT INTO users(email, password_salt, password_hash, password_params, created_at, disabled_at)
SELECT email, password_salt, password_hash, password_params, created_at, disabled_at
  FROM managers;

ALTER TABLE managers ADD COLUMN user_id uuid REFERENCES users(id) ON DELETE CASCADE;
UPDATE managers m SET user_id=u.id FROM users u WHERE lower(u.email)=lower(m.email);
ALTER TABLE managers ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE managers ADD CONSTRAINT managers_company_user_unique UNIQUE (company_id, user_id);

CREATE TABLE company_memberships (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'administrator', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (company_id, user_id)
);
INSERT INTO company_memberships(company_id, user_id, role, created_at)
SELECT company_id, user_id, 'owner', created_at FROM managers;

CREATE TABLE user_sessions (
  token_hash bytea PRIMARY KEY,
  csrf_hash bytea NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX user_sessions_active_idx ON user_sessions (expires_at) WHERE revoked_at IS NULL;
CREATE INDEX company_memberships_user_active_idx
  ON company_memberships (user_id, company_id) WHERE revoked_at IS NULL;

ALTER TABLE devices ADD COLUMN owner_user_id uuid;
UPDATE devices d
   SET owner_user_id=COALESCE(
     (SELECT m.user_id
        FROM enrollment_codes ec
        JOIN managers m ON m.id=ec.created_by_manager_id
       WHERE ec.used_by_device_id=d.id
       ORDER BY ec.created_at, ec.id LIMIT 1),
     (SELECT m.user_id FROM managers m
       WHERE m.company_id=d.company_id ORDER BY m.created_at, m.id LIMIT 1)
   );
ALTER TABLE devices ALTER COLUMN owner_user_id SET NOT NULL;
ALTER TABLE devices ADD CONSTRAINT devices_owner_user_fkey
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE devices ADD CONSTRAINT devices_owner_id_unique UNIQUE (owner_user_id, id);
ALTER TABLE devices ALTER COLUMN company_id DROP NOT NULL;
ALTER TABLE devices ADD CONSTRAINT devices_company_owner_membership_fkey
  FOREIGN KEY (company_id, owner_user_id)
  REFERENCES company_memberships(company_id, user_id) ON DELETE CASCADE;
CREATE INDEX devices_owner_company_created_idx
  ON devices (owner_user_id, company_id, created_at);

ALTER TABLE enrollment_codes ADD COLUMN owner_user_id uuid;
UPDATE enrollment_codes ec SET owner_user_id=m.user_id
  FROM managers m WHERE m.id=ec.created_by_manager_id;
ALTER TABLE enrollment_codes ALTER COLUMN owner_user_id SET NOT NULL;
ALTER TABLE enrollment_codes ADD CONSTRAINT enrollment_codes_owner_user_fkey
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE enrollment_codes ALTER COLUMN company_id DROP NOT NULL;
ALTER TABLE enrollment_codes ALTER COLUMN created_by_manager_id DROP NOT NULL;
ALTER TABLE enrollment_codes ADD CONSTRAINT enrollment_codes_company_owner_membership_fkey
  FOREIGN KEY (company_id, owner_user_id)
  REFERENCES company_memberships(company_id, user_id) ON DELETE CASCADE;
CREATE INDEX enrollment_codes_owner_active_idx
  ON enrollment_codes (owner_user_id, expires_at) WHERE used_at IS NULL;

ALTER TABLE usage_events ADD COLUMN owner_user_id uuid;
UPDATE usage_events e SET owner_user_id=d.owner_user_id FROM devices d WHERE d.id=e.device_id;
ALTER TABLE usage_events ALTER COLUMN owner_user_id SET NOT NULL;
ALTER TABLE usage_events DROP CONSTRAINT usage_events_company_id_device_id_fkey;
ALTER TABLE usage_events DROP CONSTRAINT usage_events_pkey;
ALTER TABLE usage_events ALTER COLUMN company_id DROP NOT NULL;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_pkey PRIMARY KEY (device_id, event_id);
ALTER TABLE usage_events ADD CONSTRAINT usage_events_owner_device_fkey
  FOREIGN KEY (owner_user_id, device_id)
  REFERENCES devices(owner_user_id, id) ON DELETE CASCADE;
CREATE INDEX usage_events_owner_company_time_idx
  ON usage_events (owner_user_id, company_id, occurred_at DESC);

ALTER TABLE usage_rejections ADD COLUMN owner_user_id uuid;
UPDATE usage_rejections r SET owner_user_id=d.owner_user_id FROM devices d WHERE d.id=r.device_id;
ALTER TABLE usage_rejections ALTER COLUMN owner_user_id SET NOT NULL;
ALTER TABLE usage_rejections ALTER COLUMN company_id DROP NOT NULL;
ALTER TABLE usage_rejections DROP CONSTRAINT usage_rejections_company_id_device_id_fkey;
ALTER TABLE usage_rejections ADD CONSTRAINT usage_rejections_owner_device_fkey
  FOREIGN KEY (owner_user_id, device_id)
  REFERENCES devices(owner_user_id, id) ON DELETE CASCADE;
CREATE INDEX usage_rejections_owner_time_idx
  ON usage_rejections (owner_user_id, created_at DESC);

-- A nullable company id cannot be protected by a normal composite foreign key
-- because PostgreSQL skips that check when any key column is NULL. These
-- triggers make the personal/team scope equality structural: neither direct
-- SQL nor a future repository bug can attach a device event or rejection to a
-- different company (or disguise a team event as personal).
CREATE FUNCTION enforce_usage_device_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM devices d
     WHERE d.id=NEW.device_id
       AND d.owner_user_id=NEW.owner_user_id
       AND d.company_id IS NOT DISTINCT FROM NEW.company_id
  ) THEN
    RAISE EXCEPTION 'usage device scope mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER usage_events_device_scope
  BEFORE INSERT OR UPDATE OF company_id, owner_user_id, device_id ON usage_events
  FOR EACH ROW EXECUTE FUNCTION enforce_usage_device_scope();
CREATE TRIGGER usage_rejections_device_scope
  BEFORE INSERT OR UPDATE OF company_id, owner_user_id, device_id ON usage_rejections
  FOR EACH ROW EXECUTE FUNCTION enforce_usage_device_scope();

ALTER TABLE audit_facts DROP CONSTRAINT audit_facts_actor_type_check;
ALTER TABLE audit_facts ADD CONSTRAINT audit_facts_actor_type_check
  CHECK (actor_type IN ('manager', 'user', 'device', 'system'));
