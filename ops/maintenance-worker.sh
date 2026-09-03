#!/bin/sh
set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$PROJECT_DIR"

. "$SCRIPT_DIR/env.sh"
. "$SCRIPT_DIR/lib/portable-backup.sh"
. "$SCRIPT_DIR/lib/maintenance-jobs.sh"

load_fitgrid_environment
validate_fitgrid_environment
ADMIN_OPS_DIR=${ADMIN_OPS_DIR:-${ADMIN_OPS_WEB_DIR:-}}
for variable_name in ADMIN_OPS_DIR ADMIN_OPS_ROOT_DIR PORTABLE_BACKUP_DIR \
  PORTABLE_BACKUP_HISTORY_FILE BACKUP_ENCRYPTION_KEY_FILE
do
  require_fitgrid_value "$variable_name"
done
[ "$(id -u)" -eq 0 ] || { maintenance_fail "Maintenance worker must run as root"; exit 1; }

maintenance_prepare_directories || exit 1
exec 9>"$ADMIN_OPS_ROOT_DIR/maintenance.lock"
flock -n 9 || exit 0

maintenance_current_claim=
maintenance_current_secret=
maintenance_current_upload=
maintenance_current_work=
maintenance_current_prepared=
maintenance_cleanup_prepared=false
trap 'maintenance_worker_status=$?; maintenance_cleanup_current; exit "$maintenance_worker_status"' EXIT HUP INT TERM

maintenance_worker_status=0
maintenance_recover_claimed_jobs || maintenance_worker_status=1
if maintenance_any_active; then
  exit 1
fi
maintenance_drain_inbox || maintenance_worker_status=1
if maintenance_any_active; then
  exit 1
fi
maintenance_expire_prepared || maintenance_worker_status=1
exit "$maintenance_worker_status"
