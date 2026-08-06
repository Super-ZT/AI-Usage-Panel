CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE managers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email text NOT NULL,
  password_salt bytea NOT NULL,
  password_hash bytea NOT NULL,
  password_params jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  UNIQUE (company_id, id)
);
CREATE UNIQUE INDEX managers_email_lower_unique ON managers (lower(email));

CREATE TABLE manager_sessions (
  token_hash bytea PRIMARY KEY,
  manager_id uuid NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  platform text NOT NULL DEFAULT 'unknown' CHECK (length(platform) BETWEEN 1 AND 40),
  credential_hash bytea UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  CHECK (credential_hash IS NOT NULL OR revoked_at IS NOT NULL),
  UNIQUE (company_id, id)
);

CREATE TABLE enrollment_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code_hash bytea NOT NULL UNIQUE,
  created_by_manager_id uuid NOT NULL REFERENCES managers(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_by_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  CHECK (expires_at > created_at)
);

CREATE TABLE usage_events (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 8 AND 128),
  device_id uuid NOT NULL,
  harness text NOT NULL CHECK (length(harness) BETWEEN 1 AND 64),
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  model text,
  pricing_model text,
  occurred_at timestamptz NOT NULL,
  tokens jsonb NOT NULL,
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 32),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, event_id),
  FOREIGN KEY (company_id, device_id) REFERENCES devices(company_id, id) ON DELETE RESTRICT
);

CREATE TABLE usage_rejections (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  event_id text,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, device_id) REFERENCES devices(company_id, id) ON DELETE CASCADE
);

CREATE TABLE audit_facts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id uuid REFERENCES companies(id) ON DELETE CASCADE,
  actor_type text NOT NULL CHECK (actor_type IN ('manager', 'device', 'system')),
  actor_id uuid,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 80),
  subject_id uuid,
  outcome text NOT NULL CHECK (outcome IN ('allowed', 'denied')),
  reason text CHECK (reason IS NULL OR length(reason) <= 200),
  created_at timestamptz NOT NULL DEFAULT now()
);
