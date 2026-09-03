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
  portable_replace_rollback=
  if [ -e "$portable_replace_destination" ] || [ -L "$portable_replace_destination" ]; then
    [ -f "$portable_replace_destination" ] && [ ! -L "$portable_replace_destination" ] \
      || { portable_fail "Portable backup publication destination is unsafe"; return 1; }
    portable_replace_rollback=$(mktemp "$portable_replace_parent/.durable-rollback.XXXXXX") || return 1
    cp -p "$portable_replace_destination" "$portable_replace_rollback" || {
      portable_replace_status=$?
      rm -f "$portable_replace_rollback"
      return "$portable_replace_status"
    }
    portable_sync_filesystem "$portable_replace_rollback" || {
      portable_replace_status=$?
      rm -f "$portable_replace_rollback"
      return "$portable_replace_status"
    }
    portable_sync_filesystem "$portable_replace_parent" || {
      portable_replace_status=$?
      rm -f "$portable_replace_rollback"
      return "$portable_replace_status"
    }
  fi
  portable_sync_filesystem "$portable_replace_source" || return $?
  mv "$portable_replace_source" "$portable_replace_destination" || {
    portable_replace_status=$?
    rm -f "$portable_replace_rollback"
    return "$portable_replace_status"
  }
  portable_replace_status=0
  portable_sync_filesystem "$portable_replace_destination" || portable_replace_status=$?
  if [ "$portable_replace_status" -eq 0 ]; then
    portable_sync_filesystem "$portable_replace_parent" || portable_replace_status=$?
  fi
  if [ "$portable_replace_status" -eq 0 ]; then
    rm -f "$portable_replace_rollback"
    return 0
  fi
  rm -f "$portable_replace_destination" || :
  if [ -n "$portable_replace_rollback" ]; then
    mv "$portable_replace_rollback" "$portable_replace_destination" || :
  fi
  # A failed sync means crash persistence cannot be proven. Restore the prior
  # visible namespace in this process and make one best-effort parent barrier;
  # callers must still treat the filesystem and the operation as failed.
  portable_sync_filesystem "$portable_replace_parent" || :
  return "$portable_replace_status"
}

portable_available_kilobytes() {
  portable_directory=$1
  case "$portable_directory" in ''|/) portable_fail "Unsafe portable backup directory"; return 1 ;; esac
  mkdir -p "$portable_directory"
  portable_available_kb=$(df -Pk "$portable_directory" | awk 'END { print $4 }')
  case "$portable_available_kb" in ''|*[!0-9]*) portable_fail "Could not determine free space for portable backup"; return 1 ;; esac
  printf '%s\n' "$portable_available_kb"
}

portable_require_creation_space() {
  portable_directory=$1
  portable_max=$(portable_max_bytes) || return 1
  portable_available_kb=$(portable_available_kilobytes "$portable_directory") || return 1
  # pg_database_size is not an upper bound for canonical JSON/base64 CSV.
  # Reserve from the configured hard payload limit for source CSV, ciphertext,
  # decrypted verification tar, and extracted verification CSV simultaneously.
  portable_required_kb=$(awk -v size="$portable_max" 'BEGIN { print int((4 * size + 268435456 + 1023) / 1024) }')
  [ "$portable_available_kb" -ge "$portable_required_kb" ] || {
    portable_fail "Insufficient free space for portable backup"
    return 1
  }
}

portable_require_inspection_space() {
  portable_directory=$1
  portable_archive_bytes=$2
  portable_max=$(portable_max_bytes) || return 1
  portable_available_kb=$(portable_available_kilobytes "$portable_directory") || return 1
  # The encrypted upload already exists. Inspection additionally retains one
  # decrypted tar (bounded by archive bytes) and up to the configured expanded
  # payload limit while checksums and canonical row framing are validated.
  portable_required_kb=$(awk -v archive="$portable_archive_bytes" -v size="$portable_max" \
    'BEGIN { print int((archive + size + 268435456 + 1023) / 1024) }')
  [ "$portable_available_kb" -ge "$portable_required_kb" ] || {
    portable_fail "Insufficient free space for portable backup inspection"
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

portable_timestamp_iso() {
  printf '%s\n' "$1" | awk '
    /^[0-9]{8}T[0-9]{6}Z$/ {
      print substr($0, 1, 4) "-" substr($0, 5, 2) "-" substr($0, 7, 2) "T" substr($0, 10, 2) ":" substr($0, 12, 2) ":" substr($0, 14, 2) "Z"
    }'
}

portable_write_manifest() {
  portable_manifest=$1
  portable_timestamp=$2
  portable_users=$3
  portable_trades=$4
  portable_invitations=$5
  portable_previews=$6
  portable_created_at=$(portable_timestamp_iso "$portable_timestamp")
  [ -n "$portable_created_at" ] || { portable_fail "Invalid portable backup timestamp"; return 1; }
  portable_major=$(portable_postgres_major) || return 1
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
    '{format:"fitgridweb-portable-backup",formatVersion:"3.0.0",dumpMode:"canonical-csv",dataEncoding:"base64-json-row-v1",createdAt:$createdAt,appImage:$appImage,postgresMajor:$postgresMajor,database:$database,counts:{users:$users,gridTrades:$gridTrades,invitations:$invitations,importPreviews:$importPreviews}}' \
    >"$portable_manifest"
}

portable_csv_files() {
  printf '%s\n' \
    accounts.csv \
    grid_trades.csv \
    import_previews.csv \
    invitations.csv \
    sessions.csv \
    users.csv \
    verifications.csv
}

portable_export_sql() {
  cat <<'EOSQL'
\set ON_ERROR_STOP on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
\echo __FITGRID_PORTABLE_V3_ACCOUNTS__
COPY (
  SELECT pg_catalog.replace(pg_catalog.encode(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'id', id, 'account_id', account_id, 'provider_id', provider_id, 'issuer', issuer,
    'user_id', user_id, 'access_token', access_token, 'refresh_token', refresh_token,
    'id_token', id_token, 'access_token_expires_at', access_token_expires_at,
    'refresh_token_expires_at', refresh_token_expires_at, 'scope', scope, 'password', password,
    'created_at', created_at, 'updated_at', updated_at
  )::text, 'UTF8'), 'base64'), E'\n', '') AS payload
  FROM public.accounts ORDER BY id
) TO STDOUT WITH (FORMAT csv, FORCE_QUOTE *);
\echo __FITGRID_PORTABLE_V3_GRID_TRADES__
COPY (
  SELECT pg_catalog.replace(pg_catalog.encode(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'id', id, 'owner_id', owner_id, 'product_code', product_code, 'product_name', product_name,
    'max_price', max_price, 'min_trade_quantity', min_trade_quantity,
    'gear_amplitude', gear_amplitude, 'per_share', per_share, 'keep_share', keep_share,
    'increase_amplitude', increase_amplitude, 'medium_amplitude', medium_amplitude,
    'big_amplitude', big_amplitude, 'max_amplitude', max_amplitude, 'is_short', is_short,
    'category', category, 'sort_order', sort_order, 'algorithm_version', algorithm_version,
    'created_at', created_at, 'updated_at', updated_at
  )::text, 'UTF8'), 'base64'), E'\n', '') AS payload
  FROM public.grid_trades ORDER BY id
) TO STDOUT WITH (FORMAT csv, FORCE_QUOTE *);
\echo __FITGRID_PORTABLE_V3_IMPORT_PREVIEWS__
COPY (
  SELECT pg_catalog.replace(pg_catalog.encode(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'id', id, 'owner_id', owner_id, 'token_digest', token_digest, 'file_digest', file_digest,
    'payload', payload, 'expires_at', expires_at, 'consumed_at', consumed_at, 'created_at', created_at
  )::text, 'UTF8'), 'base64'), E'\n', '') AS payload
  FROM public.import_previews ORDER BY id
) TO STDOUT WITH (FORMAT csv, FORCE_QUOTE *);
\echo __FITGRID_PORTABLE_V3_INVITATIONS__
COPY (
  SELECT pg_catalog.replace(pg_catalog.encode(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'id', id, 'token_digest', token_digest, 'created_by_id', created_by_id,
    'expires_at', expires_at, 'used_at', used_at, 'used_by_id', used_by_id, 'created_at', created_at
  )::text, 'UTF8'), 'base64'), E'\n', '') AS payload
  FROM public.invitations ORDER BY id
) TO STDOUT WITH (FORMAT csv, FORCE_QUOTE *);
\echo __FITGRID_PORTABLE_V3_SESSIONS__
COPY (
  SELECT pg_catalog.replace(pg_catalog.encode(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'id', id, 'expires_at', expires_at, 'token', token, 'created_at', created_at,
    'updated_at', updated_at, 'ip_address', ip_address, 'user_agent', user_agent, 'user_id', user_id
  )::text, 'UTF8'), 'base64'), E'\n', '') AS payload
  FROM public.sessions ORDER BY id
) TO STDOUT WITH (FORMAT csv, FORCE_QUOTE *);
\echo __FITGRID_PORTABLE_V3_USERS__
COPY (
  SELECT pg_catalog.replace(pg_catalog.encode(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'id', id, 'name', name, 'email', email, 'email_verified', email_verified, 'image', image,
    'username', username, 'role', role, 'status', status, 'created_at', created_at, 'updated_at', updated_at
  )::text, 'UTF8'), 'base64'), E'\n', '') AS payload
  FROM public.users ORDER BY id
) TO STDOUT WITH (FORMAT csv, FORCE_QUOTE *);
\echo __FITGRID_PORTABLE_V3_VERIFICATIONS__
COPY (
  SELECT pg_catalog.replace(pg_catalog.encode(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'id', id, 'identifier', identifier, 'value', value, 'expires_at', expires_at,
    'created_at', created_at, 'updated_at', updated_at
  )::text, 'UTF8'), 'base64'), E'\n', '') AS payload
  FROM public.verifications ORDER BY id
) TO STDOUT WITH (FORMAT csv, FORCE_QUOTE *);
COMMIT;
\echo __FITGRID_PORTABLE_V3_END__
EOSQL
}

portable_split_export() {
  portable_export_directory=$1
  portable_export_limit=$2
  portable_csv_files | while IFS= read -r portable_csv; do : >"$portable_export_directory/$portable_csv"; done
  if LC_ALL=C awk -v directory="$portable_export_directory" -v limit="$portable_export_limit" '
    function begin_section(file) {
      if (ended || seen[file]) { invalid = 1; exit }
      current = file
      seen[file] = 1
    }
    $0 == "__FITGRID_PORTABLE_V3_ACCOUNTS__" { begin_section("accounts.csv"); next }
    $0 == "__FITGRID_PORTABLE_V3_GRID_TRADES__" { begin_section("grid_trades.csv"); next }
    $0 == "__FITGRID_PORTABLE_V3_IMPORT_PREVIEWS__" { begin_section("import_previews.csv"); next }
    $0 == "__FITGRID_PORTABLE_V3_INVITATIONS__" { begin_section("invitations.csv"); next }
    $0 == "__FITGRID_PORTABLE_V3_SESSIONS__" { begin_section("sessions.csv"); next }
    $0 == "__FITGRID_PORTABLE_V3_USERS__" { begin_section("users.csv"); next }
    $0 == "__FITGRID_PORTABLE_V3_VERIFICATIONS__" { begin_section("verifications.csv"); next }
    $0 == "__FITGRID_PORTABLE_V3_END__" {
      if (ended) { invalid = 1; exit }
      current = ""
      ended = 1
      next
    }
    current != "" {
      projected = total + length($0) + 1
      if (projected > limit) { oversized = 1; exit }
      total = projected
      print > (directory "/" current)
      next
    }
    { invalid = 1; exit }
    END {
      expected[1] = "accounts.csv"
      expected[2] = "grid_trades.csv"
      expected[3] = "import_previews.csv"
      expected[4] = "invitations.csv"
      expected[5] = "sessions.csv"
      expected[6] = "users.csv"
      expected[7] = "verifications.csv"
      for (position = 1; position <= 7; position++) if (!seen[expected[position]]) invalid = 1
      if (oversized) exit 2
      exit (invalid || !ended)
    }
  '; then
    return 0
  else
    portable_split_status=$?
  fi
  if [ "$portable_split_status" -eq 2 ]; then
    portable_fail "Portable canonical export exceeds the configured limit"
  else
    portable_fail "Portable canonical export framing is invalid"
  fi
  return "$portable_split_status"
}

portable_export_canonical_data() {
  portable_export_directory=$1
  portable_export_limit=$(portable_max_bytes) || return 1
  portable_export_sql_file="$portable_export_directory/.export.sql"
  portable_export_fifo="$portable_export_directory/.export.fifo"
  portable_export_sql >"$portable_export_sql_file" || return 1
  mkfifo "$portable_export_fifo" || { rm -f "$portable_export_sql_file"; return 1; }
  portable_split_export "$portable_export_directory" "$portable_export_limit" <"$portable_export_fifo" &
  portable_split_pid=$!
  if fitgrid_compose exec -T db psql --no-psqlrc --quiet --set=ON_ERROR_STOP=1 \
    --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
    <"$portable_export_sql_file" >"$portable_export_fifo"; then
    portable_psql_status=0
  else
    portable_psql_status=$?
  fi
  if wait "$portable_split_pid"; then
    portable_split_status=0
  else
    portable_split_status=$?
  fi
  rm -f "$portable_export_fifo" "$portable_export_sql_file"
  [ "$portable_psql_status" -eq 0 ] || return "$portable_psql_status"
  return "$portable_split_status"
}

portable_csv_count() {
  LC_ALL=C awk 'END { print NR + 0 }' "$1"
}

portable_write_payload_checksums() {
  portable_checksum_directory=$1
  (cd "$portable_checksum_directory" && sha256sum \
    accounts.csv grid_trades.csv import_previews.csv invitations.csv \
    sessions.csv users.csv verifications.csv >payload.sha256)
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
  (cd "$portable_encrypt_work" && tar -cf - \
    accounts.csv grid_trades.csv import_previews.csv invitations.csv \
    sessions.csv users.csv verifications.csv manifest.json payload.sha256) |
    (umask 077; portable_age_run "$portable_encrypt_passphrase" -e -j batchpass >"$portable_encrypt_output")
}

portable_age_decrypt() {
  portable_decrypt_passphrase=$1
  portable_decrypt_archive=$2
  portable_decrypt_output=$3
  portable_age_run "$portable_decrypt_passphrase" -d -j batchpass <"$portable_decrypt_archive" >"$portable_decrypt_output"
}

portable_extract_member_bounded() {
  portable_extract_tar=$1
  portable_extract_member=$2
  portable_extract_output=$3
  portable_extract_limit=$4
  portable_extract_fifo="$portable_extract_output.fifo"
  rm -f "$portable_extract_fifo"
  mkfifo "$portable_extract_fifo" || return 1
  head -c "$portable_extract_limit" <"$portable_extract_fifo" >"$portable_extract_output" &
  portable_extract_head_pid=$!
  if tar -xOf "$portable_extract_tar" "$portable_extract_member" >"$portable_extract_fifo"; then
    portable_extract_tar_status=0
  else
    portable_extract_tar_status=$?
  fi
  if wait "$portable_extract_head_pid"; then
    portable_extract_head_status=0
  else
    portable_extract_head_status=$?
  fi
  rm -f "$portable_extract_fifo"
  [ "$portable_extract_tar_status" -eq 0 ] || return "$portable_extract_tar_status"
  return "$portable_extract_head_status"
}

portable_validate_members() {
  portable_tar=$1
  portable_directory=$2
  portable_expected='accounts.csv
grid_trades.csv
import_previews.csv
invitations.csv
manifest.json
payload.sha256
sessions.csv
users.csv
verifications.csv'
  portable_members=$(LC_ALL=C tar -tf "$portable_tar") || return 1
  portable_sorted_members=$(printf '%s\n' "$portable_members" | LC_ALL=C sort)
  [ "$portable_sorted_members" = "$portable_expected" ] || { portable_fail "Portable archive members are invalid"; return 1; }
  portable_max=$(portable_max_bytes) || return 1
  portable_total=0
  for portable_member in accounts.csv grid_trades.csv import_previews.csv invitations.csv \
    sessions.csv users.csv verifications.csv manifest.json payload.sha256; do
    portable_listing=$(LC_ALL=C tar -tvf "$portable_tar" "$portable_member") || return 1
    case "$portable_listing" in -*) : ;; *) portable_fail "Portable archive contains a non-regular member"; return 1 ;; esac
    portable_remaining=$((portable_max - portable_total))
    portable_sentinel=$((portable_remaining + 1))
    portable_extract_member_bounded "$portable_tar" "$portable_member" \
      "$portable_directory/$portable_member" "$portable_sentinel" || return $?
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
    type == "object" and
    (keys | sort) == ["appImage", "counts", "createdAt", "dataEncoding", "database", "dumpMode", "format", "formatVersion", "postgresMajor"] and
    .format == "fitgridweb-portable-backup" and
    .formatVersion == "3.0.0" and
    .dumpMode == "canonical-csv" and
    .dataEncoding == "base64-json-row-v1" and
    (.createdAt | type == "string") and
    (.appImage | type == "string") and
    (.database | type == "string") and
    (.postgresMajor | type == "number" and . == $expectedMajor) and
    (.counts | type == "object" and (keys | sort) == ["gridTrades", "importPreviews", "invitations", "users"]) and
    all([.counts.users, .counts.gridTrades, .counts.invitations, .counts.importPreviews][];
      type == "number" and floor == . and . >= 0)
  ' "$portable_manifest" >/dev/null || { portable_fail "Portable backup manifest is incompatible"; return 1; }
}

portable_validate_manifest_counts() {
  portable_count_directory=$1
  portable_expected_users=$(jq -r '.counts.users' "$portable_count_directory/manifest.json") || return 1
  portable_expected_trades=$(jq -r '.counts.gridTrades' "$portable_count_directory/manifest.json") || return 1
  portable_expected_invitations=$(jq -r '.counts.invitations' "$portable_count_directory/manifest.json") || return 1
  portable_expected_previews=$(jq -r '.counts.importPreviews' "$portable_count_directory/manifest.json") || return 1
  [ "$(portable_csv_count "$portable_count_directory/users.csv")" = "$portable_expected_users" ] \
    && [ "$(portable_csv_count "$portable_count_directory/grid_trades.csv")" = "$portable_expected_trades" ] \
    && [ "$(portable_csv_count "$portable_count_directory/invitations.csv")" = "$portable_expected_invitations" ] \
    && [ "$(portable_csv_count "$portable_count_directory/import_previews.csv")" = "$portable_expected_previews" ] \
    || { portable_fail "Portable backup manifest counts do not match its canonical data"; return 1; }
}

portable_validate_payload_checksums() {
  portable_checksum_directory=$1
  LC_ALL=C awk '
    BEGIN {
      expected[1] = "accounts.csv"
      expected[2] = "grid_trades.csv"
      expected[3] = "import_previews.csv"
      expected[4] = "invitations.csv"
      expected[5] = "sessions.csv"
      expected[6] = "users.csv"
      expected[7] = "verifications.csv"
    }
    {
      if (NR > 7 || $1 !~ /^[0-9a-f]{64}$/ || substr($0, 65, 2) != "  " || substr($0, 67) != expected[NR]) {
        invalid = 1
        exit
      }
    }
    END { exit (invalid || NR != 7) }
  ' "$portable_checksum_directory/payload.sha256" || {
    portable_fail "Portable backup checksum record is invalid"
    return 1
  }
  (cd "$portable_checksum_directory" && sha256sum -c payload.sha256) >/dev/null || {
    portable_fail "Portable backup checksum is invalid"
    return 1
  }
}

portable_validate_csv_file() {
  portable_csv_file=$1
  LC_ALL=C awk '
    $0 !~ /^"[A-Za-z0-9+\/]+={0,2}"$/ { invalid = 1; exit }
    { encoded = substr($0, 2, length($0) - 2); if (length(encoded) % 4 != 0) { invalid = 1; exit } }
    END { exit invalid }
  ' "$portable_csv_file" || {
    portable_fail "Portable backup contains invalid canonical CSV rows"
    return 1
  }
}

portable_validate_payload_size() {
  portable_payload_directory=$1
  portable_payload_limit=$(portable_max_bytes) || return 1
  portable_payload_total=0
  for portable_payload_member in accounts.csv grid_trades.csv import_previews.csv invitations.csv \
    sessions.csv users.csv verifications.csv manifest.json payload.sha256; do
    portable_payload_size=$(portable_file_size "$portable_payload_directory/$portable_payload_member") || return 1
    case "$portable_payload_size" in ''|*[!0-9]*) portable_fail "Portable archive member size is invalid"; return 1 ;; esac
    portable_payload_total=$((portable_payload_total + portable_payload_size))
    [ "$portable_payload_total" -le "$portable_payload_limit" ] || {
      portable_fail "Portable archive expands beyond the configured limit"
      return 1
    }
  done
}

portable_validate_plain_archive() {
  portable_tar=$1
  portable_directory=$2
  portable_validate_members "$portable_tar" "$portable_directory" || return 1
  portable_validate_manifest "$portable_directory/manifest.json" || return 1
  portable_validate_payload_checksums "$portable_directory" || return 1
  portable_validate_payload_size "$portable_directory" || return 1
  portable_csv_files | while IFS= read -r portable_csv; do
    portable_validate_csv_file "$portable_directory/$portable_csv" || exit $?
  done || return $?
  portable_validate_manifest_counts "$portable_directory"
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

portable_emit_copy_section() {
  portable_copy_file=$1
  cat <<'EOSQL'
COPY pg_temp.portable_rows (payload) FROM STDIN WITH (FORMAT csv);
EOSQL
  cat "$portable_copy_file"
  printf '\\.\n'
}

portable_emit_restore_sql() {
  portable_restore_directory=$1
  cat <<'EOSQL'
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE portable_rows (payload text NOT NULL) ON COMMIT DROP;
EOSQL
  portable_emit_copy_section "$portable_restore_directory/users.csv"
  cat <<'EOSQL'
INSERT INTO public.users
  (id, name, email, email_verified, image, username, role, status, created_at, updated_at)
SELECT
  (data->>'id')::uuid, data->>'name', data->>'email', (data->>'email_verified')::boolean,
  data->>'image', data->>'username', (data->>'role')::public.user_role,
  (data->>'status')::public.user_status, (data->>'created_at')::timestamp(3),
  (data->>'updated_at')::timestamp(3)
FROM (
  SELECT pg_catalog.convert_from(pg_catalog.decode(payload, 'base64'), 'UTF8')::jsonb AS data
  FROM pg_temp.portable_rows
) AS decoded;
TRUNCATE pg_temp.portable_rows;
EOSQL
  portable_emit_copy_section "$portable_restore_directory/accounts.csv"
  cat <<'EOSQL'
INSERT INTO public.accounts
  (id, account_id, provider_id, issuer, user_id, access_token, refresh_token, id_token,
   access_token_expires_at, refresh_token_expires_at, scope, password, created_at, updated_at)
SELECT
  (data->>'id')::uuid, data->>'account_id', data->>'provider_id', data->>'issuer',
  (data->>'user_id')::uuid, data->>'access_token', data->>'refresh_token', data->>'id_token',
  (data->>'access_token_expires_at')::timestamp(3),
  (data->>'refresh_token_expires_at')::timestamp(3), data->>'scope', data->>'password',
  (data->>'created_at')::timestamp(3), (data->>'updated_at')::timestamp(3)
FROM (
  SELECT pg_catalog.convert_from(pg_catalog.decode(payload, 'base64'), 'UTF8')::jsonb AS data
  FROM pg_temp.portable_rows
) AS decoded;
TRUNCATE pg_temp.portable_rows;
EOSQL
  portable_emit_copy_section "$portable_restore_directory/verifications.csv"
  cat <<'EOSQL'
INSERT INTO public.verifications
  (id, identifier, value, expires_at, created_at, updated_at)
SELECT
  (data->>'id')::uuid, data->>'identifier', data->>'value',
  (data->>'expires_at')::timestamp(3), (data->>'created_at')::timestamp(3),
  (data->>'updated_at')::timestamp(3)
FROM (
  SELECT pg_catalog.convert_from(pg_catalog.decode(payload, 'base64'), 'UTF8')::jsonb AS data
  FROM pg_temp.portable_rows
) AS decoded;
TRUNCATE pg_temp.portable_rows;
EOSQL
  portable_emit_copy_section "$portable_restore_directory/invitations.csv"
  cat <<'EOSQL'
INSERT INTO public.invitations
  (id, token_digest, created_by_id, expires_at, used_at, used_by_id, created_at)
SELECT
  (data->>'id')::uuid, data->>'token_digest', (data->>'created_by_id')::uuid,
  (data->>'expires_at')::timestamp(3), (data->>'used_at')::timestamp(3),
  (data->>'used_by_id')::uuid, (data->>'created_at')::timestamp(3)
FROM (
  SELECT pg_catalog.convert_from(pg_catalog.decode(payload, 'base64'), 'UTF8')::jsonb AS data
  FROM pg_temp.portable_rows
) AS decoded;
TRUNCATE pg_temp.portable_rows;
EOSQL
  portable_emit_copy_section "$portable_restore_directory/grid_trades.csv"
  cat <<'EOSQL'
INSERT INTO public.grid_trades
  (id, owner_id, product_code, product_name, max_price, min_trade_quantity, gear_amplitude,
   per_share, keep_share, increase_amplitude, medium_amplitude, big_amplitude, max_amplitude,
   is_short, category, sort_order, algorithm_version, created_at, updated_at)
SELECT
  (data->>'id')::uuid, (data->>'owner_id')::uuid, data->>'product_code', data->>'product_name',
  (data->>'max_price')::numeric, (data->>'min_trade_quantity')::numeric,
  (data->>'gear_amplitude')::numeric, (data->>'per_share')::numeric,
  (data->>'keep_share')::integer, (data->>'increase_amplitude')::integer,
  (data->>'medium_amplitude')::integer, (data->>'big_amplitude')::integer,
  (data->>'max_amplitude')::integer, (data->>'is_short')::boolean, data->>'category',
  (data->>'sort_order')::integer, (data->>'algorithm_version')::public.algorithm_version,
  (data->>'created_at')::timestamp(3), (data->>'updated_at')::timestamp(3)
FROM (
  SELECT pg_catalog.convert_from(pg_catalog.decode(payload, 'base64'), 'UTF8')::jsonb AS data
  FROM pg_temp.portable_rows
) AS decoded;
TRUNCATE pg_temp.portable_rows;
EOSQL
  portable_emit_copy_section "$portable_restore_directory/import_previews.csv"
  cat <<'EOSQL'
INSERT INTO public.import_previews
  (id, owner_id, token_digest, file_digest, payload, expires_at, consumed_at, created_at)
SELECT
  (data->>'id')::uuid, (data->>'owner_id')::uuid, data->>'token_digest', data->>'file_digest',
  data->'payload', (data->>'expires_at')::timestamp(3),
  (data->>'consumed_at')::timestamp(3), (data->>'created_at')::timestamp(3)
FROM (
  SELECT pg_catalog.convert_from(pg_catalog.decode(payload, 'base64'), 'UTF8')::jsonb AS data
  FROM pg_temp.portable_rows
) AS decoded;
TRUNCATE pg_temp.portable_rows;
EOSQL
  portable_emit_copy_section "$portable_restore_directory/sessions.csv"
  cat <<'EOSQL'
INSERT INTO public.sessions
  (id, expires_at, token, created_at, updated_at, ip_address, user_agent, user_id)
SELECT
  (data->>'id')::uuid, (data->>'expires_at')::timestamp(3), data->>'token',
  (data->>'created_at')::timestamp(3), (data->>'updated_at')::timestamp(3),
  data->>'ip_address', data->>'user_agent', (data->>'user_id')::uuid
FROM (
  SELECT pg_catalog.convert_from(pg_catalog.decode(payload, 'base64'), 'UTF8')::jsonb AS data
  FROM pg_temp.portable_rows
) AS decoded;
COMMIT;
EOSQL
}

portable_restore_canonical_data() {
  portable_restore_directory=$1
  portable_csv_files | while IFS= read -r portable_csv; do
    [ -f "$portable_restore_directory/$portable_csv" ] && [ ! -L "$portable_restore_directory/$portable_csv" ] \
      || { portable_fail "Portable restore CSV is missing"; exit 1; }
    portable_validate_csv_file "$portable_restore_directory/$portable_csv" || exit $?
  done || return $?
  portable_restore_sql=$(mktemp "$portable_restore_directory/.restore.XXXXXX") || return 1
  if portable_emit_restore_sql "$portable_restore_directory" >"$portable_restore_sql"; then
    portable_restore_emit_status=0
  else
    portable_restore_emit_status=$?
  fi
  if [ "$portable_restore_emit_status" -ne 0 ]; then
    rm -f "$portable_restore_sql"
    return "$portable_restore_emit_status"
  fi
  if fitgrid_compose exec -T db psql --no-psqlrc --quiet --set=ON_ERROR_STOP=1 \
    --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" <"$portable_restore_sql"; then
    portable_restore_status=0
  else
    portable_restore_status=$?
  fi
  rm -f "$portable_restore_sql"
  return "$portable_restore_status"
}

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
  portable_require_creation_space "$output_directory"

  timestamp=${FITGRID_BACKUP_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}
  base="fitgridweb-$timestamp"
  portable_work=$(mktemp -d "$output_directory/.${base}.XXXXXX")
  portable_partial="$output_directory/$base.fitgridbackup.partial"
  portable_archive_file="$output_directory/$base.fitgridbackup"
  trap 'portable_create_status=$?; portable_cleanup; exit "$portable_create_status"' EXIT HUP INT TERM
  portable_status "$status_file" dumping
  portable_export_canonical_data "$portable_work"
  portable_users=$(portable_csv_count "$portable_work/users.csv")
  portable_trades=$(portable_csv_count "$portable_work/grid_trades.csv")
  portable_invitations=$(portable_csv_count "$portable_work/invitations.csv")
  portable_previews=$(portable_csv_count "$portable_work/import_previews.csv")
  portable_write_manifest "$portable_work/manifest.json" "$timestamp" \
    "$portable_users" "$portable_trades" "$portable_invitations" "$portable_previews"
  portable_write_payload_checksums "$portable_work"
  portable_validate_payload_size "$portable_work"
  portable_csv_files | while IFS= read -r portable_csv; do
    portable_validate_csv_file "$portable_work/$portable_csv" || exit $?
  done
  portable_status "$status_file" encrypting
  portable_age_encrypt "$passphrase_file" "$portable_work" "$portable_partial"
  chmod 600 "$portable_partial"
  [ -s "$portable_partial" ] || { portable_fail "Encrypted portable backup is empty"; exit 1; }
  portable_ciphertext_size=$(portable_file_size "$portable_partial")
  portable_ciphertext_limit=$(portable_max_bytes)
  [ "$portable_ciphertext_size" -le "$portable_ciphertext_limit" ] \
    || { portable_fail "Encrypted portable backup exceeds the configured limit"; exit 1; }
  portable_validate_ciphertext "$portable_partial" "$passphrase_file"
  portable_publish_for_reader "$portable_partial"
  portable_durable_replace "$portable_partial" "$portable_archive_file"
  portable_partial=
  portable_record_success "$history_file" "$base" "$timestamp" || {
    portable_history_status=$?
    rm -f "$portable_archive_file" || :
    portable_sync_filesystem "$output_directory" || :
    exit "$portable_history_status"
  }
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
  portable_require_inspection_space "$(dirname "$prepared_directory")" "$portable_archive_size"
  mkdir -p "$prepared_directory"
  [ -z "$(find "$prepared_directory" -mindepth 1 -maxdepth 1 -print -quit)" ] || { portable_fail "Prepared directory is not empty"; exit 1; }
  portable_parent=$(dirname "$prepared_directory")
  portable_work=$(mktemp -d "$portable_parent/.portable-inspect.XXXXXX")
  portable_result_tmp=
  portable_prepared_payload=
  portable_inspect_cleanup() {
    rm -rf "$portable_work"
    [ -z "$portable_result_tmp" ] || rm -f "$portable_result_tmp"
    [ -z "$portable_prepared_payload" ] || rm -f "$portable_prepared_payload"
    return 0
  }
  trap 'portable_inspect_status=$?; portable_inspect_cleanup; exit "$portable_inspect_status"' EXIT HUP INT TERM
  portable_age_decrypt "$passphrase_file" "$archive" "$portable_work/archive.tar"
  portable_plain_size=$(portable_file_size "$portable_work/archive.tar")
  [ "$portable_plain_size" -le "$portable_limit" ] || { portable_fail "Portable plaintext exceeds the configured limit"; exit 1; }
  portable_validate_plain_archive "$portable_work/archive.tar" "$portable_work"
  portable_result_parent=$(dirname "$result_file")
  mkdir -p "$portable_result_parent"
  portable_result_tmp=$(mktemp "$portable_result_parent/.result.XXXXXX")
  cp "$portable_work/manifest.json" "$portable_result_tmp"
  chmod 600 "$portable_result_tmp"
  chmod 600 "$portable_work/archive.tar"
  portable_prepared_payload="$prepared_directory/payload.tar"
  mv "$portable_work/archive.tar" "$portable_prepared_payload"
  mv "$portable_result_tmp" "$result_file"
  portable_result_tmp=
  portable_prepared_payload=
)
