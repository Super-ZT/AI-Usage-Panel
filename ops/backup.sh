#!/bin/sh
set -eu
umask 077

. /ops/lib/secrets.sh
load_usage_panel_secrets
for key in POSTGRES_HOST POSTGRES_PORT POSTGRES_DATABASE POSTGRES_USER POSTGRES_PASSWORD; do require_secret "$key"; done
case "$POSTGRES_PORT" in ''|*[!0-9]*) echo "POSTGRES_PORT must be numeric" >&2; exit 1 ;; esac

backup_dir=${BACKUP_DIR:-}
case "$backup_dir" in /*) ;; *) echo "BACKUP_DIR must be an absolute path" >&2; exit 1 ;; esac
[ "$backup_dir" != / ] || { echo "BACKUP_DIR cannot be /" >&2; exit 1; }
keep=${BACKUP_KEEP:-14}
case "$keep" in ''|*[!0-9]*) echo "BACKUP_KEEP must be an integer" >&2; exit 1 ;; esac
[ "$keep" -ge 1 ] && [ "$keep" -le 365 ] || { echo "BACKUP_KEEP must be between 1 and 365" >&2; exit 1; }

if [ -z "${BACKUP_RECIPIENT:-}" ] && [ "${BACKUP_DESTINATION_ENCRYPTED:-0}" != 1 ]; then
  echo "Set BACKUP_RECIPIENT or attest BACKUP_DESTINATION_ENCRYPTED=1" >&2
  exit 1
fi
if [ -n "${BACKUP_RECIPIENT:-}" ]; then command -v age >/dev/null 2>&1 || { echo "age is required for recipient encryption" >&2; exit 1; }; fi

mkdir -p "$backup_dir"
lock_dir="$backup_dir/.usage-panel-backup.lock"
mkdir "$lock_dir" 2>/dev/null || { echo "Another backup is already running" >&2; exit 1; }
temporary=
cleanup() {
  [ -z "$temporary" ] || rm -f "$temporary"
  rmdir "$lock_dir" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
temporary=$(mktemp "$backup_dir/.usage-panel-$timestamp.dump.XXXXXX")
PGHOST="$POSTGRES_HOST" PGPORT="$POSTGRES_PORT" PGDATABASE="$POSTGRES_DATABASE" \
PGUSER="$POSTGRES_USER" PGPASSWORD="$POSTGRES_PASSWORD" \
  pg_dump --format=custom --compress=9 --no-owner --no-acl --file="$temporary"
pg_restore --list "$temporary" >/dev/null

if [ -n "${BACKUP_RECIPIENT:-}" ]; then
  final="$backup_dir/usage-panel-$timestamp.dump.age"
  [ ! -e "$final" ] || { echo "Backup filename already exists" >&2; exit 1; }
  age --recipient "$BACKUP_RECIPIENT" --output "$final" "$temporary"
  rm -f "$temporary"
  temporary=
else
  final="$backup_dir/usage-panel-$timestamp.dump"
  [ ! -e "$final" ] || { echo "Backup filename already exists" >&2; exit 1; }
  mv "$temporary" "$final"
  temporary=
fi

base=${final##*/}
(cd "$backup_dir" && sha256sum "$base" > "$base.sha256")
printf 'created_at=%s\nfile=%s\npostgres_major=16\n' "$timestamp" "$base" > "$final.meta"

set -- "$backup_dir"/usage-panel-*.sha256
if [ -e "$1" ]; then
  count=$#
  if [ "$count" -gt "$keep" ]; then
    remove=$((count - keep))
    for checksum in $(ls -1tr "$backup_dir"/usage-panel-*.sha256); do
      [ "$remove" -gt 0 ] || break
      artifact=${checksum%.sha256}
      case "$artifact" in "$backup_dir"/usage-panel-*.dump|"$backup_dir"/usage-panel-*.dump.age) ;;
        *) echo "Unsafe retention target" >&2; exit 1 ;;
      esac
      rm -f "$artifact" "$checksum" "$artifact.meta"
      remove=$((remove - 1))
    done
  fi
fi

echo "backup_file=$final"
echo "integrity_file=$final.sha256"
