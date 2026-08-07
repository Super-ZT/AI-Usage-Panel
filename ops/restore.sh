#!/bin/sh
set -eu
umask 077

. /ops/lib/secrets.sh
load_usage_panel_secrets
for key in POSTGRES_HOST POSTGRES_PORT RESTORE_POSTGRES_DATABASE POSTGRES_USER POSTGRES_PASSWORD; do require_secret "$key"; done
case "$POSTGRES_PORT" in ''|*[!0-9]*) echo "POSTGRES_PORT must be numeric" >&2; exit 1 ;; esac

backup_file=${BACKUP_FILE:-}
case "$backup_file" in /*/usage-panel-*.dump|/*/usage-panel-*.dump.age) ;; *) echo "BACKUP_FILE has an unsafe name" >&2; exit 1 ;; esac
[ -f "$backup_file" ] || { echo "BACKUP_FILE is missing" >&2; exit 1; }
[ -f "$backup_file.sha256" ] || { echo "Backup integrity file is missing" >&2; exit 1; }
[ ! -L "$backup_file" ] && [ ! -L "$backup_file.sha256" ] || { echo "Backup inputs must not be symbolic links" >&2; exit 1; }
backup_dir=${backup_file%/*}
base=${backup_file##*/}
(cd "$backup_dir" && sha256sum -c "$base.sha256") >/dev/null

restore_input=$backup_file
temporary=
cleanup() { [ -z "$temporary" ] || rm -f "$temporary"; }
trap cleanup EXIT INT TERM
case "$backup_file" in
  *.age)
    require_secret BACKUP_IDENTITY_FILE
    case "$BACKUP_IDENTITY_FILE" in /run/secrets/*) ;; *) echo "BACKUP_IDENTITY_FILE must be a mounted container secret" >&2; exit 1 ;; esac
    [ -f "$BACKUP_IDENTITY_FILE" ] && [ -r "$BACKUP_IDENTITY_FILE" ] || {
      echo "Backup identity is missing or unreadable" >&2; exit 1;
    }
    command -v age >/dev/null 2>&1 || { echo "age is required to decrypt this backup" >&2; exit 1; }
    temporary=$(mktemp /tmp/usage-panel-restore.dump.XXXXXX)
    age --decrypt --identity "$BACKUP_IDENTITY_FILE" --output "$temporary" "$backup_file"
    restore_input=$temporary
    ;;
  *)
    [ "${BACKUP_DESTINATION_ENCRYPTED:-0}" = 1 ] || { echo "Unencrypted backup requires an encrypted destination boundary" >&2; exit 1; }
    ;;
esac
pg_restore --list "$restore_input" >/dev/null

table_count=$(PGHOST="$POSTGRES_HOST" PGPORT="$POSTGRES_PORT" PGDATABASE="$RESTORE_POSTGRES_DATABASE" \
  PGUSER="$POSTGRES_USER" PGPASSWORD="$POSTGRES_PASSWORD" \
  psql -X -v ON_ERROR_STOP=1 -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public'")
[ "$table_count" = 0 ] || { echo "Restore target must have an empty public schema" >&2; exit 1; }
PGHOST="$POSTGRES_HOST" PGPORT="$POSTGRES_PORT" PGDATABASE="$RESTORE_POSTGRES_DATABASE" \
PGUSER="$POSTGRES_USER" PGPASSWORD="$POSTGRES_PASSWORD" \
  pg_restore --dbname="$RESTORE_POSTGRES_DATABASE" --exit-on-error --no-owner --no-acl "$restore_input"

# Disaster recovery deliberately invalidates every manager and user browser session, enrollment
# code and device upload credential. Durable companies, device identities and
# usage totals survive; operators must explicitly re-enroll devices.
PGHOST="$POSTGRES_HOST" PGPORT="$POSTGRES_PORT" PGDATABASE="$RESTORE_POSTGRES_DATABASE" \
PGUSER="$POSTGRES_USER" PGPASSWORD="$POSTGRES_PASSWORD" \
  psql -X -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
BEGIN;
TRUNCATE manager_sessions, user_sessions, enrollment_codes;
UPDATE devices
   SET credential_hash=NULL,
       revoked_at=COALESCE(revoked_at, now())
 WHERE credential_hash IS NOT NULL;
DELETE FROM api_rate_limits;
COMMIT;
SQL

echo "restore_file=$backup_file"
echo "active_sessions=0"
echo "active_device_credentials=0"
