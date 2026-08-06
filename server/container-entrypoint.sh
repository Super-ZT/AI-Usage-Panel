#!/bin/sh
set -eu
umask 077

source_file=${USAGE_PANEL_SECRETS_FILE:-}
case "$source_file" in /run/secrets/*) ;; *) echo "Container secret must be mounted below /run/secrets" >&2; exit 1 ;; esac
[ -f "$source_file" ] && [ -r "$source_file" ] || { echo "Container secret is missing or unreadable" >&2; exit 1; }

runtime_file=/tmp/usage-panel-runtime.env
rm -f "$runtime_file"
cp "$source_file" "$runtime_file"
chmod 0400 "$runtime_file"
chown node:node "$runtime_file"
export USAGE_PANEL_SECRETS_FILE=$runtime_file

exec runuser -u node -- node --require ./server/config.js "$@"
