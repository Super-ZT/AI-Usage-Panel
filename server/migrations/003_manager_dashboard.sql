ALTER TABLE manager_sessions ADD COLUMN csrf_hash bytea;

-- Sessions created before browser request forgery protection existed cannot be
-- safely upgraded because the raw session token is deliberately never stored.
UPDATE manager_sessions
   SET revoked_at = COALESCE(revoked_at, now())
 WHERE csrf_hash IS NULL;
