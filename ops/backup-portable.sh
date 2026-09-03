#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$PROJECT_DIR"

[ "$(id -u)" -eq 0 ] || { echo "便携备份必须由 root 运行" >&2; exit 1; }
[ -t 0 ] || { echo "便携备份必须在交互式终端运行" >&2; exit 1; }

. "$SCRIPT_DIR/env.sh"
. "$SCRIPT_DIR/lib/portable-backup.sh"
load_fitgrid_environment
validate_fitgrid_environment
for variable_name in PORTABLE_BACKUP_DIR PORTABLE_BACKUP_HISTORY_FILE; do
  require_fitgrid_value "$variable_name"
done

terminal_state=
passphrase_file=
restore_terminal() {
  [ -z "$terminal_state" ] || stty "$terminal_state" </dev/tty || :
}
cleanup() {
  restore_terminal
  [ -z "$passphrase_file" ] || rm -f "$passphrase_file"
}
trap cleanup EXIT HUP INT TERM

while :; do
  portable_read_secret "独立备份密码（12–128 个字符）" first
  portable_read_secret "再次输入独立备份密码" second
  portable_validate_secret_values "$first" "$second" && break
done
passphrase_file=$(portable_secret_file "$first")
unset first second
create_portable_backup "$passphrase_file" "$PORTABLE_BACKUP_DIR" "$PORTABLE_BACKUP_HISTORY_FILE"
