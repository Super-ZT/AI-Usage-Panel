#!/bin/sh
set -eu
umask 077

source_file=${USAGE_PANEL_SECRETS_FILE:-}
case "$source_file" in /run/secrets/*) ;; *) echo "Container secret must be mounted below /run/secrets" >&2; exit 1 ;; esac
[ -f "$source_file" ] && [ -r "$source_file" ] || { echo "Container secret is missing or unreadable" >&2; exit 1; }

runtime_dir=$(mktemp -d /tmp/usage-panel-runtime.XXXXXX)
chmod 0700 "$runtime_dir"
runtime_file=$runtime_dir/secrets.env
cp "$source_file" "$runtime_file"
chmod 0400 "$runtime_file"
chown -R node:node "$runtime_dir"
export USAGE_PANEL_SECRETS_FILE=$runtime_file

exec runuser -u node -- node --require ./server/config.js "$@"
