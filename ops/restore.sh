#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$PROJECT_DIR"
. "$SCRIPT_DIR/env.sh"
load_fitgrid_environment

target_url=
backup_file=
confirmed=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --target) [ "$#" -ge 2 ] || { echo "--target requires a value" >&2; exit 1; }; target_url=$2; shift 2 ;;
    --backup) [ "$#" -ge 2 ] || { echo "--backup requires a value" >&2; exit 1; }; backup_file=$2; shift 2 ;;
    --confirm) confirmed=true; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

[ "$confirmed" = true ] || { echo "Restore requires --confirm" >&2; exit 1; }
[ -n "$target_url" ] || { echo "Restore target is required" >&2; exit 1; }
[ "$target_url" != "${DATABASE_URL:-}" ] || { echo "Refusing to restore into the production database" >&2; exit 1; }
[ "$target_url" != "${MIGRATION_DATABASE_URL:-}" ] || { echo "Refusing to restore into the production database" >&2; exit 1; }
target_endpoint=${target_url#*://}
target_endpoint=${target_endpoint#*@}
runtime_endpoint=${DATABASE_URL#*://}
runtime_endpoint=${runtime_endpoint#*@}
migration_endpoint=${MIGRATION_DATABASE_URL#*://}
migration_endpoint=${migration_endpoint#*@}
[ "$target_endpoint" != "$runtime_endpoint" ] || { echo "Refusing alternate credentials for the production database" >&2; exit 1; }
[ "$target_endpoint" != "$migration_endpoint" ] || { echo "Refusing alternate credentials for the production database" >&2; exit 1; }
case "$target_url" in
  postgres://*/|postgresql://*/|postgres://*/postgres|postgresql://*/postgres|postgres://*/postgres\?*|postgresql://*/postgres\?*|postgres://*/template0|postgresql://*/template0|postgres://*/template0\?*|postgresql://*/template0\?*|postgres://*/template1|postgresql://*/template1|postgres://*/template1\?*|postgresql://*/template1\?*)
    echo "Refusing to restore into a PostgreSQL maintenance database" >&2; exit 1 ;;
esac
[ -f "$backup_file" ] || { echo "Encrypted backup does not exist" >&2; exit 1; }
[ -f "$backup_file.sha256" ] || { echo "Backup checksum does not exist" >&2; exit 1; }
require_fitgrid_value BACKUP_ENCRYPTION_KEY_FILE
[ -f "$BACKUP_ENCRYPTION_KEY_FILE" ] || { echo "Backup encryption key file is missing" >&2; exit 1; }
require_private_file "$BACKUP_ENCRYPTION_KEY_FILE" "Backup encryption key"

backup_directory=$(CDPATH= cd -- "$(dirname -- "$backup_file")" && pwd)
backup_name=$(basename "$backup_file")
(cd "$backup_directory" && sha256sum -c "$backup_name.sha256") >/dev/null
temporary_directory=$(mktemp -d)
trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM
dump_file="$temporary_directory/restore.dump"
openssl enc -d -aes-256-cbc -pbkdf2 \
  -pass "file:$BACKUP_ENCRYPTION_KEY_FILE" -in "$backup_file" -out "$dump_file"
[ -s "$dump_file" ] || { echo "Decrypted backup is empty" >&2; exit 1; }
pg_restore --list "$dump_file" >/dev/null
pg_restore --clean --if-exists --no-owner --dbname="$target_url" "$dump_file"
echo "Restore completed for the explicitly selected non-production database"
