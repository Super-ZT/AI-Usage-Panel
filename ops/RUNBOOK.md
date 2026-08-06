# Usage Panel staging operations

This runbook separates repeatable offline validation from the later, explicitly approved staging deployment. The repository commands below do not require a public domain, a certificate request, customer data, or a production database.

## Safety boundary

- `ops/validate-stack.sh` binds only to `127.0.0.1`, creates disposable Docker volumes, and removes them when it exits.
- `scripts/ops-load.js` refuses to run unless `OPS_ALLOW_SCHEMA_RESET=1` and destroys the `public` schema named by `TEST_DATABASE_URL`. Use a new disposable database only.
- `ops/restore.sh` refuses a target containing any public table. After restoring durable records, it deletes manager sessions and enrollment codes and revokes every device credential.
- The example files contain key names only. Never put an actual secret in Git, Compose environment values, a command line, or a support bundle.

## Required host inputs

Create a root-owned directory outside this checkout. The path below is an example; the later operator may select another root-only location.

```bash
install -d -m 0700 /etc/usage-panel
install -m 0600 ops/secrets.env.example /etc/usage-panel/secrets.env
install -m 0600 /dev/null /etc/usage-panel/postgres-password
install -m 0600 ops/compose.env.example /etc/usage-panel/compose.env
```

Fill the files locally. Required secret-file values are:

- `DATABASE_URL`: PostgreSQL URL for the application role.
- `RESTORE_DATABASE_URL`: separate empty restore target, used only by a restore operation.
- `RATE_LIMIT_SECRET`: at least 32 random characters used to hash rate-limit identities.
- `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DATABASE`, `RESTORE_POSTGRES_DATABASE`, `POSTGRES_USER`, and `POSTGRES_PASSWORD`: split libpq values used by the one-shot PostgreSQL client images so the password never appears in their command arguments.
- `BACKUP_RECIPIENT`: an `age` recipient when backups are encrypted individually.
- `BACKUP_IDENTITY_FILE`: absolute path to the restore identity; it is needed only for `.age` restores.

The PostgreSQL password file contains only the database role password. `compose.env` supplies paths and non-secret settings: external secret paths, backup directory and retention, a domain, and the Caddy certificate mode. Keep all three files mode `0600`; keep the parent directory mode `0700`.

The backup job requires one encryption boundary:

- Preferred: set `BACKUP_RECIPIENT` and use a backup image that includes the pinned `age` executable.
- Supported boundary: put `BACKUP_DIR` on an already encrypted, access-controlled filesystem and set `BACKUP_DESTINATION_ENCRYPTED=1`.

The stock PostgreSQL image intentionally does not contain `age`; it fails closed if a recipient is supplied. Build and review a small derived backup image with a pinned `age` package before choosing recipient encryption.

## Offline validation

Validate Compose rendering first:

```bash
set -a
. /etc/usage-panel/compose.env
set +a
docker compose -f ops/compose.yaml config --quiet
```

Run the complete loopback-only production-like stack check:

```bash
OPS_ALLOW_DOCKER=1 sh ops/validate-stack.sh
```

It builds the non-root application image, applies the ordered migrations before application start, waits on HTTPS readiness, inserts disposable data, backs it up, restores into a fresh database, compares durable rows/totals/constraints/migrations, checks that sessions and device credentials are inactive in the restore, scans image history/container configuration/logs for planted secrets, and tears down its containers and volumes.

Run the repository suite and load/outage profile against a separate fresh PostgreSQL 16 database:

```bash
TEST_DATABASE_URL=postgresql://usage_panel:password@127.0.0.1:5432/usage_panel_test npm test
TEST_DATABASE_URL=postgresql://usage_panel:password@127.0.0.1:5432/usage_panel_load \
  OPS_ALLOW_SCHEMA_RESET=1 OPS_EVENTS_PER_DEVICE=100 OPS_SOAK_SECONDS=10 node scripts/ops-load.js
```

The load harness documents its finite local profile in JSON: two companies, ten devices, accepted and replayed events, poison rejection, concurrent reads, queue recovery during an outage, revocation, restart durability, latency, throughput and Node resident memory. It is evidence for that machine and profile only, not a capacity promise.

## Later approved staging start

Do not run this section until the owner has separately approved a live staging host, domain, Domain Name System change, firewall exposure, certificate flow, database location, backup destination, and test computers.

```bash
set -a
. /etc/usage-panel/compose.env
set +a
docker compose -f ops/compose.yaml pull --quiet
docker compose -f ops/compose.yaml build --pull app migrate retention
docker compose -f ops/compose.yaml run --rm migrate
docker compose -f ops/compose.yaml up -d postgres app caddy
```

`PUBLIC_DOMAIN` is required. `CADDY_TLS_MODE=internal` is for loopback/offline validation only. A later public staging configuration must supply the approved Automatic Certificate Management Environment email syntax supported by Caddy; this repository does not request a live certificate.

The reverse proxy is the only service with published ports. PostgreSQL and the application stay on an internal Docker network. Caddy enforces request-size limits and proxy timeouts; the application enforces database-shared per-client and global rate limits after trusted-proxy resolution.

## Health, readiness and migrations

```bash
curl --fail --silent --show-error https://STAGING_DOMAIN/live
curl --fail --silent --show-error https://STAGING_DOMAIN/ready
docker compose -f ops/compose.yaml ps
docker compose -f ops/compose.yaml logs --no-color --tail 200 app caddy postgres
```

`/live` proves the process can answer. `/ready` also verifies PostgreSQL access, every ordered migration, and the current pricing snapshot backfill. The application starts only after the one-shot migration service completes.

## Backup, integrity and restore rehearsal

Run backup from the pinned PostgreSQL 16 client image:

```bash
docker compose -f ops/compose.yaml --profile operations run --rm backup
```

The job takes a lock, writes a safe UTC filename, uses PostgreSQL custom format, validates the archive with `pg_restore --list`, writes a SHA-256 checksum and metadata, and retains `BACKUP_KEEP` generations. It exits nonzero on contention, missing encryption boundary, dump failure, integrity failure, or unsafe configuration.

The one-shot backup and restore containers run as root with every Linux capability dropped so they can read the root-only secret and backup mount. They expose no port, have a read-only image filesystem, and exit after the operation; the long-running Node application runs as uid 1000 with zero effective capabilities.

Restore only to a new isolated empty database:

For an age-encrypted backup, set `BACKUP_IDENTITY_FILE` in `compose.env` to the
host's owner-only identity file. Compose mounts it read-only at
`/run/secrets/backup-identity`; the restore rejects any other container path.

```bash
RESTORE_FILE=usage-panel-YYYYMMDDTHHMMSSZ.dump \
  docker compose -f ops/compose.yaml --profile restore run --rm restore
```

After restore, compare company, manager, device and event counts; token/cost aggregates; migrations; and constraints. Manager sessions, enrollment codes, rate counters and active device credentials must be zero before the restored database is ever connected to a reachable service. Managers sign in again and every device is re-enrolled.

## Retention

The application runs operational retention at start and every ten minutes. Run it manually with:

```bash
docker compose -f ops/compose.yaml --profile operations run --rm retention
```

Defaults retain privacy-safe upload rejections for 30 days, audit facts for 180 days, and expired/revoked session and enrollment facts for seven days. Per-company caps are 100,000 rejection rows and 500,000 audit rows. Rate counters expire after two minutes. Retention never deletes usage events.

## Credentials and access changes

- Revoke a computer from the manager dashboard; the stored credential hash is erased and uploads return unauthorized.
- Create a new one-use, 15-minute enrollment code and enroll the replacement computer. Never record the displayed code in a ticket or log.
- Rotate `RATE_LIMIT_SECRET` by changing the root-only file and restarting the app. Existing short-lived rate rows become unreachable and expire naturally.
- Rotate the PostgreSQL password by changing it in PostgreSQL and both root-only files during one maintenance window, then restart the affected services.
- Manager password changes require an audited administrative procedure before production; no unauthenticated password-reset route exists.

## Graceful stop, rollback and teardown

The application handles `SIGTERM` and `SIGINT`, stops accepting connections, allows active requests up to ten seconds, closes its pool, and exits. Before rollback, take and validate a backup.

```bash
docker compose -f ops/compose.yaml stop -t 15 app
docker compose -f ops/compose.yaml up -d --no-deps app
```

Rollback uses a previously reviewed immutable application image whose schema is compatible with the already-applied migrations. Database migrations are forward-only; do not delete columns or migration rows. If compatibility is uncertain, keep the service offline and restore the validated pre-change backup into a new isolated database before switching anything.

Staging teardown:

```bash
docker compose -f ops/compose.yaml down --remove-orphans
```

Do not add `-v` on a staging host until the operator has validated an external backup and received explicit approval to delete staging data.

## Logs, alerts and outage recovery

Collect service status and structured application errors without environment dumps. Alert on readiness failures, restart loops, PostgreSQL disk/connection pressure, backup nonzero exits or missing daily backups, retention failures, sustained HTTP 401/403/429/500 rates, queue growth, and rejected-event growth. Never attach container inspection output, secret files, database URLs, cookies, enrollment codes or device credentials to diagnostics.

During a collector outage, computers retain their local outbox and retry. Restore PostgreSQL first, wait for `/ready`, then restore Caddy reachability. Replays are idempotent by `(device_id,event_id)`; permanently invalid records quarantine individually. After recovery, verify outboxes drain, totals do not inflate, and rejected-event growth returns to normal.

## Approval and input gate still required

Live staging remains blocked until the owner explicitly supplies or approves: staging host, domain and Domain Name System change; public port/firewall change; certificate account/flow; root-only production secret values; database volume and encrypted backup destination; backup retention; alert destination; rollback image; and the selected non-customer test computers. A Windows installer, signing certificate, updater and production release remain separate work.
