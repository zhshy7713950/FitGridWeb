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

portable_reader_gid() {
  portable_gid=${PORTABLE_BACKUP_READER_GID:-1001}
  if ! awk -v candidate="$portable_gid" 'BEGIN {
    exit !(candidate ~ /^[0-9]+$/ && candidate + 0 >= 1 && candidate + 0 <= 2147483647)
  }'; then
    portable_fail "PORTABLE_BACKUP_READER_GID must be a numeric non-root GID"
    return 1
  fi
  printf '%s\n' "$portable_gid"
}

portable_publish_for_reader() {
  portable_publish_file=$1
  [ -f "$portable_publish_file" ] && [ ! -L "$portable_publish_file" ] \
    || { portable_fail "Portable backup publication target is not a regular file"; return 1; }
  portable_publish_gid=$(portable_reader_gid) || return 1
  chown "0:$portable_publish_gid" "$portable_publish_file" || {
    portable_publish_status=$?
    echo "Could not assign portable backup reader ownership" >&2
    return "$portable_publish_status"
  }
  chmod 0640 "$portable_publish_file" || {
    portable_publish_status=$?
    echo "Could not set portable backup reader permissions" >&2
    return "$portable_publish_status"
  }
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

# Ubuntu's GNU coreutils sync -f issues a filesystem-wide durability barrier for
# the filesystem containing the path. This is intentionally stronger than a
# best-effort flush of one file and must fail the operation if it is unavailable.
portable_sync_filesystem() {
  portable_sync_target=$1
  sync -f "$portable_sync_target" || {
    portable_sync_status=$?
    portable_fail "Could not durably synchronize portable backup storage"
    return "$portable_sync_status"
  }
}

portable_durable_replace() {
  portable_replace_source=$1
  portable_replace_destination=$2
  portable_replace_parent=$(dirname "$portable_replace_destination")
  portable_sync_filesystem "$portable_replace_source" || return $?
  mv "$portable_replace_source" "$portable_replace_destination" || return $?
  portable_sync_filesystem "$portable_replace_destination" || return $?
  portable_sync_filesystem "$portable_replace_parent"
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
  # Creation can concurrently retain the custom dump, ciphertext, decrypted
  # verification tar, and extracted verification dump on the same filesystem.
  portable_required_kb=$(awk -v size="$portable_estimate" 'BEGIN { print int((4 * size + 268435456 + 1023) / 1024) }')
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
    '{format:"fitgridweb-portable-backup",formatVersion:"2.0.0",dumpMode:"data-only",createdAt:$createdAt,appImage:$appImage,postgresMajor:$postgresMajor,database:$database,counts:{users:$users,gridTrades:$gridTrades,invitations:$invitations,importPreviews:$importPreviews}}' \
    >"$portable_manifest"
}

portable_age_run() (
  portable_age_passphrase_file=$1
  shift
  # age's built-in passphrase mode is terminal-only. The official batchpass
  # plugin accepts a caller-owned descriptor, so the secret never enters argv,
  # the process environment, or a command substitution.
  exec 3<"$portable_age_passphrase_file" || exit 1
  unset AGE_PASSPHRASE
  AGE_PASSPHRASE_FD=3
  export AGE_PASSPHRASE_FD
  age "$@"
  portable_age_status=$?
  unset AGE_PASSPHRASE_FD
  exec 3<&-
  exit "$portable_age_status"
)

portable_age_encrypt() {
  portable_encrypt_passphrase=$1
  portable_encrypt_work=$2
  portable_encrypt_output=$3
  (cd "$portable_encrypt_work" && tar -cf - manifest.json database.dump database.dump.sha256) |
    (umask 077; portable_age_run "$portable_encrypt_passphrase" -e -j batchpass >"$portable_encrypt_output")
}

portable_age_decrypt() {
  portable_decrypt_passphrase=$1
  portable_decrypt_archive=$2
  portable_decrypt_output=$3
  portable_age_run "$portable_decrypt_passphrase" -d -j batchpass <"$portable_decrypt_archive" >"$portable_decrypt_output"
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
    .formatVersion == "2.0.0" and
    .dumpMode == "data-only" and
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

portable_validate_data_only_toc() {
  portable_toc=$1
  LC_ALL=C awk '
    BEGIN {
      allowed_table["accounts"] = 1
      allowed_table["grid_trades"] = 1
      allowed_table["import_previews"] = 1
      allowed_table["invitations"] = 1
      allowed_table["sessions"] = 1
      allowed_table["users"] = 1
      allowed_table["verifications"] = 1
    }
    /^[[:space:]]*$/ || /^[[:space:]]*;/ { next }
    {
      if ($1 !~ /^[0-9]+;$/ || $2 !~ /^[0-9]+$/ || $3 !~ /^[0-9]+$/) {
        invalid = 1
        exit
      }
      if ($4 == "TABLE" && $5 == "DATA" && $6 == "public" && allowed_table[$7] && NF >= 8) {
        accepted++
        next
      }
      if ($4 == "SEQUENCE" && $5 == "SET" && $6 == "public" && $7 ~ /^[a-z_][a-z0-9_]*$/ && NF >= 8) {
        accepted++
        next
      }
      invalid = 1
      exit
    }
    END { exit (invalid || accepted == 0) }
  ' "$portable_toc" || {
    portable_fail "Portable database dump contains records outside the data-only allowlist"
    return 1
  }
}

portable_validate_data_only_dump() {
  portable_data_dump=$1
  portable_toc_directory=$2
  portable_toc_file=$(mktemp "$portable_toc_directory/.database-toc.XXXXXX") || return 1
  fitgrid_compose exec -T db pg_restore --list <"$portable_data_dump" >"$portable_toc_file" || {
    portable_toc_status=$?
    rm -f "$portable_toc_file"
    return "$portable_toc_status"
  }
  portable_validate_data_only_toc "$portable_toc_file" || {
    portable_toc_status=$?
    rm -f "$portable_toc_file"
    return "$portable_toc_status"
  }
  rm -f "$portable_toc_file"
}

portable_validate_plain_archive() {
  portable_tar=$1
  portable_directory=$2
  portable_validate_members "$portable_tar" "$portable_directory" || return 1
  awk '
    NR == 1 && $0 ~ /^[0-9a-f]{64}  database\.dump$/ { valid = 1; next }
    { exit 1 }
    END { exit !(valid && NR == 1) }
  ' "$portable_directory/database.dump.sha256" || {
    portable_fail "Portable backup checksum record is invalid"
    return 1
  }
  (cd "$portable_directory" && sha256sum -c database.dump.sha256) >/dev/null || {
    portable_fail "Portable backup checksum is invalid"
    return 1
  }
  portable_validate_manifest "$portable_directory/manifest.json" || return 1
  portable_validate_data_only_dump "$portable_directory/database.dump" "$portable_directory"
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
  portable_publish_for_reader "$portable_history_tmp" || {
    portable_history_status=$?
    rm -f "$portable_history_tmp"
    return "$portable_history_status"
  }
  portable_durable_replace "$portable_history_tmp" "$portable_history_file" || {
    portable_history_status=$?
    rm -f "$portable_history_tmp"
    return "$portable_history_status"
  }
}

prune_portable_backups() {
  portable_prune_directory=$1
  portable_prune_history=$2
  portable_keep=$3
  case "$portable_keep" in ''|*[!0-9]*) portable_fail "Portable backup retention must be an integer"; return 1 ;; esac
  if [ -f "$portable_prune_history" ]; then
    jq -e 'type == "object" and ((.entries // []) | type == "array")' "$portable_prune_history" >/dev/null || {
      portable_fail "Portable backup history is invalid"
      return 1
    }
  fi
  portable_old=$(find "$portable_prune_directory" -maxdepth 1 -type f -name 'fitgridweb-*.fitgridbackup' -print | LC_ALL=C sort -r | awk -v keep="$portable_keep" 'NR > keep')
  if [ -n "$portable_old" ]; then
    printf '%s\n' "$portable_old" | while IFS= read -r portable_old_file; do rm -f "$portable_old_file"; done
    portable_sync_filesystem "$portable_prune_directory" || return $?
  fi
  if [ -f "$portable_prune_history" ]; then
    portable_filtered=$(mktemp "$(dirname "$portable_prune_history")/.history-filter.XXXXXX") || return 1
    # Retain only real portable archives, the first entry per filename, and five entries at most.
    jq -c '.entries[]?' "$portable_prune_history" | while IFS= read -r portable_entry; do
      portable_filename=$(printf '%s\n' "$portable_entry" | jq -r '.filename')
      case "$portable_filename" in
        fitgridweb-????????T??????Z.fitgridbackup)
          [ -f "$portable_prune_directory/$portable_filename" ] && printf '%s\n' "$portable_entry" ;;
      esac
    done | jq -s 'reduce .[] as $entry ([]; if any(.[]; .filename == $entry.filename) then . else . + [$entry] end) | .[:5] | {entries:.}' >"$portable_filtered" || { rm -f "$portable_filtered"; return 1; }
    portable_publish_for_reader "$portable_filtered" || {
      portable_prune_status=$?
      rm -f "$portable_filtered"
      return "$portable_prune_status"
    }
    portable_durable_replace "$portable_filtered" "$portable_prune_history" || {
      portable_prune_status=$?
      rm -f "$portable_filtered"
      return "$portable_prune_status"
    }
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
  fitgrid_compose exec -T db pg_dump --format=custom --data-only --no-owner --no-privileges \
    --exclude-table-data=public._prisma_migrations \
    --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" >"$portable_work/database.dump"
  [ -s "$portable_work/database.dump" ] || { portable_fail "pg_dump produced an empty file"; exit 1; }
  portable_validate_data_only_dump "$portable_work/database.dump" "$portable_work"
  (cd "$portable_work" && sha256sum database.dump >database.dump.sha256)
  portable_write_manifest "$portable_work/manifest.json" "$timestamp"
  portable_status "$status_file" encrypting
  portable_age_encrypt "$passphrase_file" "$portable_work" "$portable_partial"
  chmod 600 "$portable_partial"
  [ -s "$portable_partial" ] || { portable_fail "Encrypted portable backup is empty"; exit 1; }
  portable_validate_ciphertext "$portable_partial" "$passphrase_file"
  portable_publish_for_reader "$portable_partial"
  portable_archive_file="$output_directory/$base.fitgridbackup"
  portable_durable_replace "$portable_partial" "$portable_archive_file"
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
  portable_result_tmp=
  portable_prepared_dump=
  portable_inspect_cleanup() {
    rm -rf "$portable_work"
    [ -z "$portable_result_tmp" ] || rm -f "$portable_result_tmp"
    [ -z "$portable_prepared_dump" ] || rm -f "$portable_prepared_dump"
    return 0
  }
  trap 'portable_inspect_status=$?; portable_inspect_cleanup; exit "$portable_inspect_status"' EXIT HUP INT TERM
  portable_age_decrypt "$passphrase_file" "$archive" "$portable_work/archive.tar"
  portable_validate_plain_archive "$portable_work/archive.tar" "$portable_work"
  portable_result_parent=$(dirname "$result_file")
  mkdir -p "$portable_result_parent"
  portable_result_tmp=$(mktemp "$portable_result_parent/.result.XXXXXX")
  cp "$portable_work/manifest.json" "$portable_result_tmp"
  chmod 600 "$portable_result_tmp"
  chmod 600 "$portable_work/database.dump"
  portable_prepared_dump="$prepared_directory/database.dump"
  mv "$portable_work/database.dump" "$portable_prepared_dump"
  mv "$portable_result_tmp" "$result_file"
  portable_result_tmp=
  portable_prepared_dump=
)
