#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$PROJECT_DIR"
. "$SCRIPT_DIR/env.sh"
load_fitgrid_environment
validate_fitgrid_environment

for variable_name in BACKUP_DIR BACKUP_REMOTE_DIR BACKUP_ENCRYPTION_KEY_FILE; do
  require_fitgrid_value "$variable_name"
done
[ -f "$BACKUP_ENCRYPTION_KEY_FILE" ] || { echo "Backup encryption key file is missing" >&2; exit 1; }
case "$BACKUP_DIR" in ""|/) echo "Unsafe BACKUP_DIR" >&2; exit 1 ;; esac
case "$BACKUP_REMOTE_DIR" in ""|/) echo "Unsafe BACKUP_REMOTE_DIR" >&2; exit 1 ;; esac

mkdir -p "$BACKUP_DIR" "$BACKUP_REMOTE_DIR"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
base="fitgridweb-${POSTGRES_DB}-${timestamp}"
temporary_directory=$(mktemp -d "$BACKUP_DIR/.${base}.XXXXXX")
trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM
dump_file="$temporary_directory/$base.dump"
encrypted_file="$BACKUP_DIR/$base.dump.enc"
checksum_file="$BACKUP_DIR/$base.dump.enc.sha256"
metadata_file="$BACKUP_DIR/$base.json"

PGDATABASE="$MIGRATION_DATABASE_URL" pg_dump --format=custom --file="$dump_file"
[ -s "$dump_file" ] || { echo "pg_dump produced an empty file" >&2; exit 1; }
pg_restore --list "$dump_file" >/dev/null
openssl enc -aes-256-cbc -pbkdf2 -salt \
  -pass "file:$BACKUP_ENCRYPTION_KEY_FILE" -in "$dump_file" -out "$encrypted_file"
[ -s "$encrypted_file" ] || { echo "Encrypted backup is empty" >&2; exit 1; }
(cd "$BACKUP_DIR" && sha256sum "$(basename "$encrypted_file")") >"$checksum_file"
(cd "$BACKUP_DIR" && sha256sum -c "$(basename "$checksum_file")") >/dev/null
printf '{"createdAt":"%s","database":"%s","appImage":"%s","format":"pg_dump-custom+aes-256-cbc"}\n' \
  "$timestamp" "$POSTGRES_DB" "$APP_IMAGE" >"$metadata_file"

cp "$encrypted_file" "$checksum_file" "$metadata_file" "$BACKUP_REMOTE_DIR/"
(cd "$BACKUP_REMOTE_DIR" && sha256sum -c "$(basename "$checksum_file")") >/dev/null

retention_days=${BACKUP_RETENTION_DAYS:-180}
case "$retention_days" in ""|*[!0-9]*) echo "BACKUP_RETENTION_DAYS must be an integer" >&2; exit 1 ;; esac
find "$BACKUP_DIR" -type f -name 'fitgridweb-*.dump.enc' -mtime "+$retention_days" -delete
find "$BACKUP_DIR" -type f \( -name 'fitgridweb-*.dump.enc.sha256' -o -name 'fitgridweb-*.json' \) -mtime "+$retention_days" -delete
echo "Backup complete: $base"
