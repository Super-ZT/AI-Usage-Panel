#!/bin/sh

load_usage_panel_secrets() {
  secret_file=${USAGE_PANEL_SECRETS_FILE:-}
  case "$secret_file" in
    /*) ;;
    *) echo "USAGE_PANEL_SECRETS_FILE must be an absolute path" >&2; return 1 ;;
  esac
  [ -f "$secret_file" ] || { echo "USAGE_PANEL_SECRETS_FILE is missing" >&2; return 1; }
  [ -r "$secret_file" ] || { echo "USAGE_PANEL_SECRETS_FILE is not readable" >&2; return 1; }
  file_size=$(wc -c < "$secret_file")
  [ "$file_size" -le 65536 ] || { echo "USAGE_PANEL_SECRETS_FILE is too large" >&2; return 1; }

  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    case "$line" in *=*) ;; *) echo "Invalid secret-file entry" >&2; return 1 ;; esac
    key=${line%%=*}
    value=${line#*=}
    if [ "$key" = BACKUP_RECIPIENT ] && [ -n "${BACKUP_RECIPIENT:-}" ]; then
      [ -z "$value" ] || [ "$value" = "$BACKUP_RECIPIENT" ] || {
        echo "BACKUP_RECIPIENT conflicts with the secret file" >&2; return 1;
      }
      continue
    fi
    if [ "$key" = BACKUP_IDENTITY_FILE ] && [ -n "${BACKUP_IDENTITY_FILE:-}" ]; then
      [ -z "$value" ] || [ "$value" = "$BACKUP_IDENTITY_FILE" ] || {
        echo "BACKUP_IDENTITY_FILE conflicts with the mounted identity path" >&2; return 1;
      }
      continue
    fi
    case "$key" in
      DATABASE_URL|RESTORE_DATABASE_URL|RATE_LIMIT_SECRET|BACKUP_RECIPIENT|BACKUP_IDENTITY_FILE|POSTGRES_HOST|POSTGRES_PORT|POSTGRES_DATABASE|POSTGRES_USER|POSTGRES_PASSWORD|RESTORE_POSTGRES_DATABASE) export "$key=$value" ;;
      *) echo "Unsupported secret-file key: $key" >&2; return 1 ;;
    esac
  done < "$secret_file"
}

require_secret() {
  key=$1
  case "$key" in
    DATABASE_URL) value=${DATABASE_URL:-} ;;
    RESTORE_DATABASE_URL) value=${RESTORE_DATABASE_URL:-} ;;
    BACKUP_IDENTITY_FILE) value=${BACKUP_IDENTITY_FILE:-} ;;
    POSTGRES_HOST) value=${POSTGRES_HOST:-} ;;
    POSTGRES_PORT) value=${POSTGRES_PORT:-} ;;
    POSTGRES_DATABASE) value=${POSTGRES_DATABASE:-} ;;
    POSTGRES_USER) value=${POSTGRES_USER:-} ;;
    POSTGRES_PASSWORD) value=${POSTGRES_PASSWORD:-} ;;
    RESTORE_POSTGRES_DATABASE) value=${RESTORE_POSTGRES_DATABASE:-} ;;
    *) echo "Unsupported required secret" >&2; return 1 ;;
  esac
  [ -n "$value" ] || { echo "$key is required and must not be empty" >&2; return 1; }
}
