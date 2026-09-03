#!/bin/sh

# Portable backups deliberately use age passphrases and do not share the
# server-key encryption scheme in ops/backup.sh.

portable_fail() {
  echo "$1" >&2
  return 1
}

portable_file_size() {
  if stat -c '%s' "$1" 2>/dev/null; then
    return
  fi
  stat -f '%z' "$1"
}

portable_max_bytes() {
  portable_max=${PORTABLE_BACKUP_MAX_BYTES:-536870912}
  case "$portable_max" in
    ''|*[!0-9]*) portable_fail "PORTABLE_BACKUP_MAX_BYTES must be a positive integer"; return 1 ;;
  esac
  [ "$portable_max" -gt 0 ] || { portable_fail "PORTABLE_BACKUP_MAX_BYTES must be a positive integer"; return 1; }
  printf '%s\n' "$portable_max"
}

portable_require_passphrase() {
  portable_passphrase_file=$1
  [ -f "$portable_passphrase_file" ] || { portable_fail "Portable backup passphrase is missing"; return 1; }
  portable_bytes=$(LC_ALL=C wc -c <"$portable_passphrase_file" | tr -d '[:space:]')
  [ "$portable_bytes" -gt 0 ] || { portable_fail "Portable backup passphrase is empty"; return 1; }
  portable_clean_bytes=$(LC_ALL=C tr -d '\000\n' <"$portable_passphrase_file" | LC_ALL=C wc -c | tr -d '[:space:]')
  [ "$portable_clean_bytes" = "$portable_bytes" ] || { portable_fail "Portable backup passphrase must not contain newlines or NUL bytes"; return 1; }
  portable_characters=$(wc -m <"$portable_passphrase_file" | tr -d '[:space:]')
  case "$portable_characters" in ''|*[!0-9]*) portable_fail "Portable backup passphrase must be valid UTF-8"; return 1 ;; esac
  [ "$portable_characters" -ge 12 ] && [ "$portable_characters" -le 128 ] || {
    portable_fail "Portable backup passphrase must contain 12–128 characters"
    return 1
  }
}

portable_validate_secret_values() {
  portable_first=$1
  portable_second=$2
  [ "$portable_first" = "$portable_second" ] || { echo "两次输入的密码不一致，请重试" >&2; return 1; }
  portable_secret_check=$(mktemp "${TMPDIR:-/tmp}/fitgrid-portable-check.XXXXXX") || return 1
  chmod 600 "$portable_secret_check"
  printf '%s' "$portable_first" >"$portable_secret_check"
  if portable_require_passphrase "$portable_secret_check"; then
    rm -f "$portable_secret_check"
    return 0
  fi
  rm -f "$portable_secret_check"
  return 1
}

portable_secret_file() {
  portable_secret_value=$1
  portable_secret_path=$(mktemp "${TMPDIR:-/tmp}/fitgrid-portable-passphrase.XXXXXX") || return 1
  chmod 600 "$portable_secret_path"
  printf '%s' "$portable_secret_value" >"$portable_secret_path"
  printf '%s\n' "$portable_secret_path"
}

portable_read_secret() {
  portable_prompt=$1
  portable_variable=$2
  portable_stty_state=$(stty -g </dev/tty) || return 1
  terminal_state=$portable_stty_state
  stty -echo </dev/tty
  printf '%s: ' "$portable_prompt" >&2
  if ! IFS= read -r portable_value </dev/tty; then
    stty "$portable_stty_state" </dev/tty
    terminal_state=
    printf '\n' >&2
    return 1
  fi
  stty "$portable_stty_state" </dev/tty
  terminal_state=
  printf '\n' >&2
  case "$portable_variable" in
    first|second) eval "$portable_variable=\$portable_value" ;;
    *) portable_fail "Unsupported portable secret target"; return 1 ;;
  esac
}

portable_status() {
  portable_status_file=${1:-}
  portable_status_value=$2
  [ -n "$portable_status_file" ] || return 0
  portable_status_dir=$(dirname "$portable_status_file")
  mkdir -p "$portable_status_dir"
  portable_status_tmp=$(mktemp "$portable_status_dir/.status.XXXXXX") || return 1
  printf '{"state":"%s"}\n' "$portable_status_value" >"$portable_status_tmp"
  chmod 640 "$portable_status_tmp"
  mv "$portable_status_tmp" "$portable_status_file"
}

portable_cleanup() {
  [ -n "${portable_work:-}" ] && rm -rf "$portable_work"
  [ -n "${portable_partial:-}" ] && rm -f "$portable_partial"
  return 0
}

portable_require_space() {
  portable_directory=$1
  case "$portable_directory" in ''|/) portable_fail "Unsafe portable backup directory"; return 1 ;; esac
  mkdir -p "$portable_directory"
  portable_estimate=$(fitgrid_compose exec -T db psql --tuples-only --no-align \
    --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
    --command 'SELECT pg_database_size(current_database())' | tr -d '[:space:]')
  case "$portable_estimate" in ''|*[!0-9]*) portable_fail "Could not estimate database size"; return 1 ;; esac
  portable_available_kb=$(df -Pk "$portable_directory" | awk 'END { print $4 }')
  case "$portable_available_kb" in ''|*[!0-9]*) portable_fail "Could not determine free space for portable backup"; return 1 ;; esac
  portable_required_kb=$(awk -v size="$portable_estimate" 'BEGIN { print int((2 * size + 268435456 + 1023) / 1024) }')
  [ "$portable_available_kb" -ge "$portable_required_kb" ] || {
    portable_fail "Insufficient free space for portable backup"
    return 1
  }
}

portable_postgres_major() {
  portable_version=$(fitgrid_compose exec -T db psql --tuples-only --no-align \
    --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
    --command 'SHOW server_version_num' | tr -d '[:space:]')
  case "$portable_version" in ''|*[!0-9]*) portable_fail "Could not determine PostgreSQL version"; return 1 ;; esac
  awk -v version="$portable_version" 'BEGIN { print int(version / 10000) }'
}

portable_counts() {
  fitgrid_compose exec -T db psql --tuples-only --no-align \
    --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
    --command 'SELECT (SELECT COUNT(*) FROM users), (SELECT COUNT(*) FROM grid_trades), (SELECT COUNT(*) FROM invitations), (SELECT COUNT(*) FROM import_previews)' |
    tr -d '[:space:]'
}

portable_timestamp_iso() {
  printf '%s\n' "$1" | awk '
    /^[0-9]{8}T[0-9]{6}Z$/ {
      print substr($0, 1, 4) "-" substr($0, 5, 2) "-" substr($0, 7, 2) "T" substr($0, 10, 2) ":" substr($0, 12, 2) ":" substr($0, 14, 2) "Z"
    }'
}

portable_write_manifest() {
  portable_manifest=$1
  portable_timestamp=$2
  portable_created_at=$(portable_timestamp_iso "$portable_timestamp")
  [ -n "$portable_created_at" ] || { portable_fail "Invalid portable backup timestamp"; return 1; }
  portable_major=$(portable_postgres_major) || return 1
  portable_count_values=$(portable_counts) || return 1
  IFS='|' read -r portable_users portable_trades portable_invitations portable_previews <<EOF
$portable_count_values
EOF
  for portable_count in "$portable_users" "$portable_trades" "$portable_invitations" "$portable_previews"; do
    case "$portable_count" in ''|*[!0-9]*) portable_fail "Could not collect portable backup counts"; return 1 ;; esac
  done
  jq -n \
    --arg createdAt "$portable_created_at" \
    --arg appImage "$APP_IMAGE" \
    --arg database "$POSTGRES_DB" \
    --argjson postgresMajor "$portable_major" \
    --argjson users "$portable_users" \
    --argjson gridTrades "$portable_trades" \
    --argjson invitations "$portable_invitations" \
    --argjson importPreviews "$portable_previews" \
    '{format:"fitgridweb-portable-backup",formatVersion:"1.0.0",createdAt:$createdAt,appImage:$appImage,postgresMajor:$postgresMajor,database:$database,counts:{users:$users,gridTrades:$gridTrades,invitations:$invitations,importPreviews:$importPreviews}}' \
    >"$portable_manifest"
}

portable_age_run() (
  portable_age_passphrase_file=$1
  shift
  portable_age_passphrase=$(cat "$portable_age_passphrase_file") || exit 1
  AGE_PASSPHRASE=$portable_age_passphrase
  export AGE_PASSPHRASE
  age "$@"
  portable_age_status=$?
  unset AGE_PASSPHRASE
  portable_age_passphrase=
  exit "$portable_age_status"
)

portable_age_encrypt() {
  portable_encrypt_passphrase=$1
  portable_encrypt_work=$2
  portable_encrypt_output=$3
  (cd "$portable_encrypt_work" && tar -cf - manifest.json database.dump database.dump.sha256) |
    portable_age_run "$portable_encrypt_passphrase" -p >"$portable_encrypt_output"
}

portable_age_decrypt() {
  portable_decrypt_passphrase=$1
  portable_decrypt_archive=$2
  portable_decrypt_output=$3
  portable_age_run "$portable_decrypt_passphrase" -d <"$portable_decrypt_archive" >"$portable_decrypt_output"
}

portable_validate_members() {
  portable_tar=$1
  portable_directory=$2
  portable_expected='database.dump
database.dump.sha256
manifest.json'
  portable_members=$(LC_ALL=C tar -tf "$portable_tar") || return 1
  portable_sorted_members=$(printf '%s\n' "$portable_members" | LC_ALL=C sort)
  [ "$portable_sorted_members" = "$portable_expected" ] || { portable_fail "Portable archive members are invalid"; return 1; }
  portable_max=$(portable_max_bytes) || return 1
  portable_total=0
  for portable_member in manifest.json database.dump database.dump.sha256; do
    portable_listing=$(LC_ALL=C tar -tvf "$portable_tar" "$portable_member") || return 1
    case "$portable_listing" in -*) : ;; *) portable_fail "Portable archive contains a non-regular member"; return 1 ;; esac
    portable_remaining=$((portable_max - portable_total))
    portable_sentinel=$((portable_remaining + 1))
    tar -xOf "$portable_tar" "$portable_member" | head -c "$portable_sentinel" >"$portable_directory/$portable_member" || return 1
    portable_size=$(portable_file_size "$portable_directory/$portable_member") || return 1
    case "$portable_size" in ''|*[!0-9]*) portable_fail "Portable archive member size is invalid"; return 1 ;; esac
    [ "$portable_size" -le "$portable_remaining" ] || { portable_fail "Portable archive expands beyond the configured limit"; return 1; }
    portable_total=$((portable_total + portable_size))
  done
}

portable_validate_manifest() {
  portable_manifest=$1
  portable_current_major=$(portable_postgres_major) || return 1
  jq -e --argjson expectedMajor "$portable_current_major" '
    .format == "fitgridweb-portable-backup" and
    .formatVersion == "1.0.0" and
    (.createdAt | type == "string") and
    (.appImage | type == "string") and
    (.database | type == "string") and
    (.postgresMajor | type == "number" and . == $expectedMajor) and
    (.counts | type == "object") and
    (.counts.users | type == "number") and
    (.counts.gridTrades | type == "number") and
    (.counts.invitations | type == "number") and
    (.counts.importPreviews | type == "number")
  ' "$portable_manifest" >/dev/null || { portable_fail "Portable backup manifest is incompatible"; return 1; }
}

portable_validate_plain_archive() {
  portable_tar=$1
  portable_directory=$2
  portable_validate_members "$portable_tar" "$portable_directory" || return 1
  (cd "$portable_directory" && sha256sum -c database.dump.sha256) >/dev/null || {
    portable_fail "Portable backup checksum is invalid"
    return 1
  }
  portable_validate_manifest "$portable_directory/manifest.json" || return 1
  fitgrid_compose exec -T db pg_restore --list <"$portable_directory/database.dump" >/dev/null
}

portable_validate_ciphertext() (
  set -e
  portable_ciphertext=$1
  portable_passphrase=$2
  portable_validate_parent=$(dirname "$portable_ciphertext")
  portable_validate_work=$(mktemp -d "$portable_validate_parent/.portable-validate.XXXXXX") || exit 1
  trap 'portable_validate_status=$?; rm -rf "$portable_validate_work"; exit "$portable_validate_status"' EXIT HUP INT TERM
  portable_age_decrypt "$portable_passphrase" "$portable_ciphertext" "$portable_validate_work/archive.tar" || exit $?
  portable_validate_plain_archive "$portable_validate_work/archive.tar" "$portable_validate_work" || exit $?
)

portable_record_success() {
  portable_history_file=$1
  portable_base=$2
  portable_created_at=$3
  portable_history_directory=$(dirname "$portable_history_file")
  mkdir -p "$portable_history_directory"
  portable_history_tmp=$(mktemp "$portable_history_directory/.history.XXXXXX") || return 1
  portable_archive_size=$(portable_file_size "$portable_archive_file") || { rm -f "$portable_history_tmp"; return 1; }
  portable_archive_sha=$(sha256sum "$portable_archive_file" | awk '{print $1}') || { rm -f "$portable_history_tmp"; return 1; }
  portable_identifier_path=$(mktemp "$portable_history_directory/.id.XXXXXX") || { rm -f "$portable_history_tmp"; return 1; }
  portable_identifier=$(basename "$portable_identifier_path")
  rm -f "$portable_identifier_path"
  if [ -f "$portable_history_file" ]; then
    jq --arg id "$portable_identifier" --arg filename "${portable_base}.fitgridbackup" \
      --arg createdAt "$(portable_timestamp_iso "$portable_created_at")" --argjson size "$portable_archive_size" --arg sha256 "$portable_archive_sha" \
      '.entries = ([{id:$id,filename:$filename,createdAt:$createdAt,size:$size,sha256:$sha256,status:"ready"}] + (.entries // []))' \
      "$portable_history_file" >"$portable_history_tmp" || { rm -f "$portable_history_tmp"; return 1; }
  else
    jq -n --arg id "$portable_identifier" --arg filename "${portable_base}.fitgridbackup" \
      --arg createdAt "$(portable_timestamp_iso "$portable_created_at")" --argjson size "$portable_archive_size" --arg sha256 "$portable_archive_sha" \
      '{entries:[{id:$id,filename:$filename,createdAt:$createdAt,size:$size,sha256:$sha256,status:"ready"}]}' >"$portable_history_tmp" || { rm -f "$portable_history_tmp"; return 1; }
  fi
  chmod 640 "$portable_history_tmp"
  mv "$portable_history_tmp" "$portable_history_file"
}

prune_portable_backups() {
  portable_prune_directory=$1
  portable_prune_history=$2
  portable_keep=$3
  case "$portable_keep" in ''|*[!0-9]*) portable_fail "Portable backup retention must be an integer"; return 1 ;; esac
  portable_old=$(find "$portable_prune_directory" -maxdepth 1 -type f -name 'fitgridweb-*.fitgridbackup' -print | LC_ALL=C sort -r | awk -v keep="$portable_keep" 'NR > keep')
  if [ -n "$portable_old" ]; then
    printf '%s\n' "$portable_old" | while IFS= read -r portable_old_file; do rm -f "$portable_old_file"; done
  fi
  if [ -f "$portable_prune_history" ]; then
    portable_prune_tmp=$(mktemp "$(dirname "$portable_prune_history")/.history-prune.XXXXXX") || return 1
    jq --arg directory "$portable_prune_directory" '
      .entries = [(.entries // [])[] | select((.filename | type == "string") and ($directory + "/" + .filename | test("^.*$")))]
    ' "$portable_prune_history" >"$portable_prune_tmp" || { rm -f "$portable_prune_tmp"; return 1; }
    # Keep only index entries whose final backup file still exists.
    portable_filtered=$(mktemp "$(dirname "$portable_prune_history")/.history-filter.XXXXXX") || { rm -f "$portable_prune_tmp"; return 1; }
    jq -c '.entries[]?' "$portable_prune_tmp" | while IFS= read -r portable_entry; do
      portable_filename=$(printf '%s\n' "$portable_entry" | jq -r '.filename')
      [ -f "$portable_prune_directory/$portable_filename" ] && printf '%s\n' "$portable_entry"
    done | jq -s '{entries:.}' >"$portable_filtered"
    chmod 640 "$portable_filtered"
    mv "$portable_filtered" "$portable_prune_history"
    rm -f "$portable_prune_tmp"
  fi
}

create_portable_backup() (
  set -e
  passphrase_file=$1
  output_directory=$2
  history_file=$3
  status_file=${4:-}
  require_private_file "$passphrase_file" "Portable backup passphrase"
  portable_require_passphrase "$passphrase_file"
  portable_require_space "$output_directory"

  timestamp=${FITGRID_BACKUP_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}
  base="fitgridweb-$timestamp"
  portable_work=$(mktemp -d "$output_directory/.${base}.XXXXXX")
  portable_partial="$output_directory/$base.fitgridbackup.partial"
  trap 'portable_create_status=$?; portable_cleanup; exit "$portable_create_status"' EXIT HUP INT TERM
  portable_status "$status_file" dumping
  fitgrid_compose exec -T db pg_dump --format=custom \
    --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" >"$portable_work/database.dump"
  [ -s "$portable_work/database.dump" ] || { portable_fail "pg_dump produced an empty file"; exit 1; }
  fitgrid_compose exec -T db pg_restore --list <"$portable_work/database.dump" >/dev/null
  (cd "$portable_work" && sha256sum database.dump >database.dump.sha256)
  portable_write_manifest "$portable_work/manifest.json" "$timestamp"
  portable_status "$status_file" encrypting
  portable_age_encrypt "$passphrase_file" "$portable_work" "$portable_partial"
  [ -s "$portable_partial" ] || { portable_fail "Encrypted portable backup is empty"; exit 1; }
  portable_validate_ciphertext "$portable_partial" "$passphrase_file"
  portable_archive_file="$output_directory/$base.fitgridbackup"
  mv "$portable_partial" "$portable_archive_file"
  portable_partial=
  portable_record_success "$history_file" "$base" "$timestamp"
  prune_portable_backups "$output_directory" "$history_file" 5
  portable_status "$status_file" ready
)

inspect_portable_backup() (
  set -e
  archive=$1
  passphrase_file=$2
  prepared_directory=$3
  result_file=$4
  [ -f "$archive" ] && [ ! -L "$archive" ] || { portable_fail "Portable archive is missing"; exit 1; }
  case "$(basename "$archive")" in *.fitgridbackup) : ;; *) portable_fail "Portable archive must use the .fitgridbackup extension"; exit 1 ;; esac
  require_private_file "$passphrase_file" "Portable backup passphrase"
  portable_require_passphrase "$passphrase_file"
  portable_limit=$(portable_max_bytes)
  portable_archive_size=$(portable_file_size "$archive")
  [ "$portable_archive_size" -le "$portable_limit" ] || { portable_fail "Portable archive exceeds the configured limit"; exit 1; }
  mkdir -p "$prepared_directory"
  [ -z "$(find "$prepared_directory" -mindepth 1 -maxdepth 1 -print -quit)" ] || { portable_fail "Prepared directory is not empty"; exit 1; }
  portable_parent=$(dirname "$prepared_directory")
  portable_work=$(mktemp -d "$portable_parent/.portable-inspect.XXXXXX")
  trap 'portable_inspect_status=$?; rm -rf "$portable_work"; exit "$portable_inspect_status"' EXIT HUP INT TERM
  portable_age_decrypt "$passphrase_file" "$archive" "$portable_work/archive.tar"
  portable_validate_plain_archive "$portable_work/archive.tar" "$portable_work"
  chmod 600 "$portable_work/database.dump"
  mv "$portable_work/database.dump" "$prepared_directory/database.dump"
  portable_result_parent=$(dirname "$result_file")
  mkdir -p "$portable_result_parent"
  portable_result_tmp=$(mktemp "$portable_result_parent/.result.XXXXXX")
  cp "$portable_work/manifest.json" "$portable_result_tmp"
  chmod 600 "$portable_result_tmp"
  mv "$portable_result_tmp" "$result_file"
)
