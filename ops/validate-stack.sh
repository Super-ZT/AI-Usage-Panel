#!/bin/sh
set -eu

[ "${OPS_ALLOW_DOCKER:-0}" = 1 ] || {
  echo "OPS_ALLOW_DOCKER=1 is required because this recreates disposable containers and volumes" >&2
  exit 1
}

repo_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
scratch=$(mktemp -d /tmp/usage-panel-stack.XXXXXX)
case "$scratch" in /tmp/usage-panel-stack.*) ;; *) echo "Unsafe scratch path" >&2; exit 1 ;; esac
project="usage-panel-offline-$$"
compose="docker compose -p $project -f $repo_root/ops/compose.yaml"

cleanup() {
  $compose --profile operations --profile restore down -v --remove-orphans --rmi local >/dev/null 2>&1 || true
  case "$scratch" in /tmp/usage-panel-stack.*) rm -rf "$scratch" ;; esac
}
trap cleanup EXIT INT TERM

sentinel_prefix=offline-stack
password="${sentinel_prefix}-password-secret-sentinel"
rate_secret="${sentinel_prefix}-rate-secret-sentinel-0000000000000000"
secrets_file="$scratch/usage-panel.env"
password_file="$scratch/postgres-password"
backup_dir="$scratch/backups"
mkdir -p "$backup_dir"
printf '%s\n' "$password" > "$password_file"
printf 'DATABASE_URL=postgresql://usage_panel:%s@postgres:5432/usage_panel\nRESTORE_DATABASE_URL=postgresql://usage_panel:%s@postgres:5432/usage_panel_restore\nRATE_LIMIT_SECRET=%s\nPOSTGRES_HOST=postgres\nPOSTGRES_PORT=5432\nPOSTGRES_DATABASE=usage_panel\nRESTORE_POSTGRES_DATABASE=usage_panel_restore\nPOSTGRES_USER=usage_panel\nPOSTGRES_PASSWORD=%s\nBACKUP_RECIPIENT=\nBACKUP_IDENTITY_FILE=\n' \
  "$password" "$password" "$rate_secret" "$password" > "$secrets_file"
chmod 600 "$password_file" "$secrets_file"
chmod 700 "$backup_dir"

export USAGE_PANEL_SECRETS_FILE="$secrets_file"
export POSTGRES_PASSWORD_FILE="$password_file"
export BACKUP_DIR="$backup_dir"
export BACKUP_DESTINATION_ENCRYPTED=1
export PUBLIC_DOMAIN=localhost
export CADDY_TLS_MODE=internal
export HTTP_BIND=127.0.0.1:18080
export HTTPS_BIND=127.0.0.1:18443

$compose config --quiet
$compose build app migrate retention
if ! $compose up -d --no-build postgres migrate app caddy; then
  $compose ps
  $compose logs --no-color
  exit 1
fi

ready=0
for attempt in $(seq 1 30); do
  if curl -ksSf --max-time 3 https://localhost:18443/ready >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
[ "$ready" = 1 ] || { $compose ps; $compose logs --no-color; echo "Offline stack did not become ready" >&2; exit 1; }

$compose exec -T --user node -e USAGE_PANEL_SECRETS_FILE=/tmp/usage-panel-runtime.env \
  app node --require ./server/config.js - < "$repo_root/ops/stack-seed.js"
OPS_STACK_URL=https://localhost:18443 node "$repo_root/ops/stack-http.js"
runtime_uid=$($compose exec -T app sh -c 'for process in /proc/[0-9]*; do [ "$(cat "$process/comm" 2>/dev/null)" = node ] && stat -c %u "$process"; done; true')
[ "$runtime_uid" = 1000 ] || { echo "Application did not drop to the node user" >&2; exit 1; }
runtime_caps=$($compose exec -T app sh -c 'for process in /proc/[0-9]*; do [ "$(cat "$process/comm" 2>/dev/null)" = node ] && sed -n "s/^CapEff:[[:space:]]*//p" "$process/status"; done; true')
[ "$runtime_caps" = 0000000000000000 ] || { echo "Application retained Linux capabilities" >&2; exit 1; }
$compose --profile operations run --rm backup

set -- "$backup_dir"/usage-panel-*.dump
[ -f "$1" ] || { echo "Backup artifact missing" >&2; exit 1; }
backup_file=$1
export RESTORE_FILE=${backup_file##*/}
$compose exec -T postgres createdb -U usage_panel usage_panel_restore
$compose --profile restore run --rm restore
$compose exec -T --user node -e USAGE_PANEL_SECRETS_FILE=/tmp/usage-panel-runtime.env \
  app node --require ./server/config.js - < "$repo_root/ops/stack-compare.js"

image=$($compose images -q app)
if docker history --no-trunc "$image" | grep -F "$password" >/dev/null; then echo "Secret found in image history" >&2; exit 1; fi
app_container=$($compose ps -q app)
if docker inspect "$app_container" | grep -F "$password" >/dev/null; then echo "Secret found in container inspection" >&2; exit 1; fi
if $compose logs --no-color | grep -E 'offline-stack-(password|rate)-secret-sentinel' >/dev/null; then echo "Secret found in service logs" >&2; exit 1; fi

echo "stack_ready=https://localhost:18443/ready"
echo "application_runtime_uid=$runtime_uid"
echo "application_effective_capabilities=$runtime_caps"
echo "image_secret_matches=0"
echo "config_secret_matches=0"
echo "log_secret_matches=0"
