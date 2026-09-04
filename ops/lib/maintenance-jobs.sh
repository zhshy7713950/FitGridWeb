#!/bin/sh

maintenance_fail() {
  printf '%s\n' "$1" >&2
  return 1
}

maintenance_is_uuid() {
  printf '%s\n' "$1" | LC_ALL=C grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
}

maintenance_is_request_id() {
  printf '%s\n' "$1" | LC_ALL=C grep -Eq '^[A-Za-z0-9_-]{1,64}$'
}

maintenance_now_epoch() {
  maintenance_epoch=${MAINTENANCE_NOW_EPOCH:-$(date -u +%s)}
  case "$maintenance_epoch" in
    ''|*[!0-9]*) maintenance_fail "Maintenance clock is invalid"; return 1 ;;
  esac
  printf '%s\n' "$maintenance_epoch"
}

maintenance_now_iso() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

maintenance_require_directory() {
  maintenance_directory=$1
  maintenance_label=$2
  case "$maintenance_directory" in
    ''|/) maintenance_fail "$maintenance_label is unsafe"; return 1 ;;
  esac
  [ -d "$maintenance_directory" ] && [ ! -L "$maintenance_directory" ] || {
    maintenance_fail "$maintenance_label is missing or unsafe"
    return 1
  }
}

maintenance_file_uid() {
  if stat -c '%u' "$1" 2>/dev/null; then
    return
  fi
  stat -f '%u' "$1"
}

maintenance_file_gid() {
  if stat -c '%g' "$1" 2>/dev/null; then
    return
  fi
  stat -f '%g' "$1"
}

maintenance_root_uid() {
  maintenance_root_uid_value=${MAINTENANCE_ROOT_UID:-0}
  case "$maintenance_root_uid_value" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$maintenance_root_uid_value"
}

maintenance_root_gid() {
  maintenance_root_gid_value=${MAINTENANCE_ROOT_GID:-0}
  case "$maintenance_root_gid_value" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$maintenance_root_gid_value"
}

maintenance_file_mode() {
  if stat -c '%a' "$1" 2>/dev/null; then
    return
  fi
  stat -f '%Lp' "$1"
}

maintenance_require_root_directory() {
  maintenance_root_directory=$1
  maintenance_expected_mode=$2
  case "$maintenance_root_directory" in /*) : ;; *) maintenance_fail "Root maintenance path must be absolute"; return 1 ;; esac
  maintenance_canonical=$(realpath "$maintenance_root_directory" 2>/dev/null) || return 1
  [ "$maintenance_canonical" = "$maintenance_root_directory" ] || {
    maintenance_fail "Root maintenance path must be canonical"
    return 1
  }
  [ -d "$maintenance_root_directory" ] && [ ! -L "$maintenance_root_directory" ] || return 1
  maintenance_expected_uid=$(maintenance_root_uid) || return 1
  maintenance_expected_gid=$(maintenance_root_gid) || return 1
  [ "$(maintenance_file_uid "$maintenance_root_directory")" = "$maintenance_expected_uid" ] || {
    maintenance_fail "Root maintenance path must be owned by root"
    return 1
  }
  [ "$(maintenance_file_gid "$maintenance_root_directory")" = "$maintenance_expected_gid" ] || {
    maintenance_fail "Root maintenance path must be owned by the root group"
    return 1
  }
  [ "$(maintenance_file_mode "$maintenance_root_directory")" = "$maintenance_expected_mode" ] || {
    maintenance_fail "Root maintenance path permissions are unsafe"
    return 1
  }
}

maintenance_require_root_file() {
  maintenance_root_file=$1
  maintenance_expected_mode=$2
  [ -f "$maintenance_root_file" ] && [ ! -L "$maintenance_root_file" ] || return 1
  maintenance_file_canonical=$(realpath "$maintenance_root_file" 2>/dev/null) || return 1
  case "$maintenance_file_canonical" in "$ADMIN_OPS_ROOT_DIR"/*) : ;; *) return 1 ;; esac
  maintenance_expected_uid=$(maintenance_root_uid) || return 1
  maintenance_expected_gid=$(maintenance_root_gid) || return 1
  [ "$(maintenance_file_uid "$maintenance_root_file")" = "$maintenance_expected_uid" ] || return 1
  [ "$(maintenance_file_gid "$maintenance_root_file")" = "$maintenance_expected_gid" ] || return 1
  [ "$(maintenance_file_mode "$maintenance_root_file")" = "$maintenance_expected_mode" ] || return 1
}

maintenance_normalize_root_file() {
  maintenance_normalize_file=$1
  maintenance_normalize_mode=$2
  maintenance_expected_uid=$(maintenance_root_uid) || return 1
  maintenance_expected_gid=$(maintenance_root_gid) || return 1
  chown "$maintenance_expected_uid:$maintenance_expected_gid" "$maintenance_normalize_file" || return 1
  chmod "$maintenance_normalize_mode" "$maintenance_normalize_file" || return 1
  [ -f "$maintenance_normalize_file" ] && [ ! -L "$maintenance_normalize_file" ] \
    && [ "$(maintenance_file_uid "$maintenance_normalize_file")" = "$maintenance_expected_uid" ] \
    && [ "$(maintenance_file_gid "$maintenance_normalize_file")" = "$maintenance_expected_gid" ] \
    && [ "$(maintenance_file_mode "$maintenance_normalize_file")" = "$maintenance_normalize_mode" ]
}

maintenance_claim_app_file() {
  maintenance_claim_source=$1
  maintenance_claim_destination=$2
  maintenance_claim_mode=$3
  [ -f "$maintenance_claim_source" ] && [ ! -L "$maintenance_claim_source" ] || return 1
  [ ! -e "$maintenance_claim_destination" ] && [ ! -L "$maintenance_claim_destination" ] || return 1
  maintenance_claim_parent=$(dirname "$maintenance_claim_destination")
  maintenance_require_root_directory "$maintenance_claim_parent" 700 || return 1
  maintenance_claim_tmp=$(mktemp "$maintenance_claim_parent/.claim.XXXXXX") || return 1
  if ! cp "$maintenance_claim_source" "$maintenance_claim_tmp" \
    || ! maintenance_normalize_root_file "$maintenance_claim_tmp" "$maintenance_claim_mode" \
    || ! portable_sync_filesystem "$maintenance_claim_tmp" \
    || ! mv "$maintenance_claim_tmp" "$maintenance_claim_destination" \
    || ! portable_sync_filesystem "$maintenance_claim_destination" \
    || ! portable_sync_filesystem "$maintenance_claim_parent"; then
    rm -f "$maintenance_claim_tmp"
    return 1
  fi
  maintenance_require_root_file "$maintenance_claim_destination" "$maintenance_claim_mode" || return 1
  rm -f "$maintenance_claim_source" || return 1
  portable_sync_filesystem "$(dirname "$maintenance_claim_source")" || return 1
}

maintenance_ensure_root_directory() {
  maintenance_root_child=$1
  if [ ! -e "$maintenance_root_child" ] && [ ! -L "$maintenance_root_child" ]; then
    umask 077
    mkdir "$maintenance_root_child" 2>/dev/null || :
  fi
  maintenance_require_root_directory "$maintenance_root_child" 700
}

maintenance_prepare_directories() {
  maintenance_require_directory "$ADMIN_OPS_DIR" "ADMIN_OPS_DIR" || return 1
  maintenance_require_directory "$ADMIN_OPS_ROOT_DIR" "ADMIN_OPS_ROOT_DIR" || return 1
  maintenance_require_directory "$PORTABLE_BACKUP_DIR" "PORTABLE_BACKUP_DIR" || return 1
  for maintenance_directory in \
    "$ADMIN_OPS_DIR/inbox" "$ADMIN_OPS_DIR/uploads" "$ADMIN_OPS_DIR/status" \
    "$ADMIN_OPS_ROOT_DIR/prepared"
  do
    maintenance_require_directory "$maintenance_directory" "Maintenance directory" || return 1
  done
  maintenance_require_root_directory "$ADMIN_OPS_ROOT_DIR" 700 || return 1
  maintenance_require_root_directory "$ADMIN_OPS_ROOT_DIR/prepared" 700 || return 1
  maintenance_ensure_root_directory "$ADMIN_OPS_ROOT_DIR/claimed" || return 1
  maintenance_ensure_root_directory "$ADMIN_OPS_ROOT_DIR/completed" || return 1
  maintenance_ensure_root_directory "$ADMIN_OPS_ROOT_DIR/intervention" || return 1
  maintenance_ensure_root_directory "$ADMIN_OPS_ROOT_DIR/work" || return 1
}

maintenance_fence_path() {
  printf '%s\n' "${MAINTENANCE_FENCE_FILE:-/run/fitgridweb/maintenance.flag}"
}

maintenance_prepare_fence_directory() {
  maintenance_fence=$(maintenance_fence_path)
  case "$maintenance_fence" in /*) : ;; *) maintenance_fail "Maintenance fence path must be absolute"; return 1 ;; esac
  case "$maintenance_fence" in "$ADMIN_OPS_DIR"|"$ADMIN_OPS_DIR"/*) maintenance_fail "Maintenance fence must be outside app-writable storage"; return 1 ;; esac
  maintenance_fence_directory=$(dirname "$maintenance_fence")
  if [ ! -e "$maintenance_fence_directory" ] && [ ! -L "$maintenance_fence_directory" ]; then
    mkdir -p "$maintenance_fence_directory" || return 1
  fi
  [ -d "$maintenance_fence_directory" ] && [ ! -L "$maintenance_fence_directory" ] || return 1
  maintenance_fence_canonical=$(realpath "$maintenance_fence_directory" 2>/dev/null) || return 1
  [ "$maintenance_fence_canonical" = "$maintenance_fence_directory" ] || return 1
  maintenance_expected_uid=$(maintenance_root_uid) || return 1
  maintenance_expected_gid=$(maintenance_root_gid) || return 1
  chown "$maintenance_expected_uid:$maintenance_expected_gid" "$maintenance_fence_directory" || return 1
  chmod 755 "$maintenance_fence_directory" || return 1
  [ "$(maintenance_file_uid "$maintenance_fence_directory")" = "$maintenance_expected_uid" ] || return 1
  [ "$(maintenance_file_gid "$maintenance_fence_directory")" = "$maintenance_expected_gid" ] || return 1
}

maintenance_write_fence() {
  maintenance_prepare_fence_directory || return 1
  maintenance_fence=$(maintenance_fence_path)
  maintenance_fence_directory=$(dirname "$maintenance_fence")
  maintenance_fence_tmp=$(mktemp "$maintenance_fence_directory/.maintenance.XXXXXX") || return 1
  if ! printf '%s\n' "${maintenance_job_id:-maintenance}" >"$maintenance_fence_tmp" \
    || ! maintenance_normalize_root_file "$maintenance_fence_tmp" 644 \
    || ! mv "$maintenance_fence_tmp" "$maintenance_fence"; then
    rm -f "$maintenance_fence_tmp"
    return 1
  fi
  [ -f "$maintenance_fence" ] && [ ! -L "$maintenance_fence" ] \
    && [ "$(maintenance_file_uid "$maintenance_fence")" = "$(maintenance_root_uid)" ] \
    && [ "$(maintenance_file_gid "$maintenance_fence")" = "$(maintenance_root_gid)" ] \
    && [ "$(maintenance_file_mode "$maintenance_fence")" = 644 ] \
    && portable_sync_filesystem "$maintenance_fence" \
    && portable_sync_filesystem "$maintenance_fence_directory"
}

maintenance_clear_fence() {
  maintenance_fence=$(maintenance_fence_path)
  maintenance_fence_directory=$(dirname "$maintenance_fence")
  [ -e "$maintenance_fence" ] || [ -L "$maintenance_fence" ] || return 0
  rm -f "$maintenance_fence" || return 1
  portable_sync_filesystem "$maintenance_fence_directory"
}

maintenance_claimed_job_required() {
  for maintenance_claimed_entry in "$ADMIN_OPS_ROOT_DIR"/claimed/*.json; do
    [ -e "$maintenance_claimed_entry" ] || [ -L "$maintenance_claimed_entry" ] || continue
    return 0
  done
  return 1
}

maintenance_guard_authority() {
  maintenance_guard_marker_state=0
  maintenance_authoritative_marker_state || maintenance_guard_marker_state=$?
  if [ "$maintenance_guard_marker_state" -eq 0 ] \
    || [ "$maintenance_guard_marker_state" -eq 2 ] \
    || maintenance_intervention_required \
    || maintenance_claimed_job_required; then
    maintenance_write_fence || :
    return 1
  fi
  maintenance_clear_fence
}

maintenance_parse_job() {
  maintenance_job_file=$1
  maintenance_job_basename=$(basename "$maintenance_job_file")
  [ -f "$maintenance_job_file" ] && [ ! -L "$maintenance_job_file" ] || return 1
  jq -e '
    type == "object" and
    (
      if .type == "restore" then
        (keys | sort) == ["actorId", "id", "requestId", "restoreId", "schemaVersion", "type"]
      elif (.type == "backup" or .type == "inspect-restore") then
        (keys | sort) == ["actorId", "id", "requestId", "schemaVersion", "type"]
      else false end
    ) and
    .schemaVersion == 1 and
    (.id | type == "string") and
    (.actorId | type == "string") and
    (.requestId | type == "string") and
    (if .type == "restore" then (.restoreId | type == "string") else true end)
  ' "$maintenance_job_file" >/dev/null 2>&1 || return 1

  maintenance_job_type=$(jq -er '.type' "$maintenance_job_file") || return 1
  maintenance_job_id=$(jq -er '.id' "$maintenance_job_file") || return 1
  maintenance_actor_id=$(jq -er '.actorId' "$maintenance_job_file") || return 1
  maintenance_request_id=$(jq -er '.requestId' "$maintenance_job_file") || return 1
  maintenance_restore_id=
  [ "$maintenance_job_type" != restore ] || maintenance_restore_id=$(jq -er '.restoreId' "$maintenance_job_file") || return 1

  maintenance_is_uuid "$maintenance_job_id" || return 1
  maintenance_is_uuid "$maintenance_actor_id" || return 1
  maintenance_is_request_id "$maintenance_request_id" || return 1
  [ "$maintenance_job_basename" = "$maintenance_job_id.json" ] || return 1
  if [ "$maintenance_job_type" = restore ]; then
    maintenance_is_uuid "$maintenance_restore_id" || return 1
  fi
}

maintenance_status_file() {
  printf '%s/status/%s.json\n' "$ADMIN_OPS_DIR" "$maintenance_job_id"
}

maintenance_publish_public_file() {
  maintenance_public_file=$1
  maintenance_reader_gid=$(portable_reader_gid) || return 1
  chown "0:$maintenance_reader_gid" "$maintenance_public_file" || return 1
  chmod 640 "$maintenance_public_file"
}

maintenance_write_status() {
  maintenance_state=$1
  case "$maintenance_state" in
    queued|dumping|encrypting|ready|uploading|inspecting|awaiting-confirmation|snapshotting|restoring|migrating|checking|succeeded|failed|rollback|intervention-required) : ;;
    *) maintenance_fail "Invalid maintenance state"; return 1 ;;
  esac
  maintenance_code=${2:-}
  maintenance_rolled_back=${3:-}
  maintenance_expires_at=${4:-}
  maintenance_preview_file=${5:-}
  maintenance_status=$(maintenance_status_file)
  maintenance_status_tmp=$(mktemp "$ADMIN_OPS_DIR/status/.${maintenance_job_id}.XXXXXX") || return 1
  maintenance_updated_at=$(maintenance_now_iso)

  if [ -n "$maintenance_preview_file" ]; then
    jq -n \
      --arg id "$maintenance_job_id" \
      --arg type "$maintenance_job_type" \
      --arg actorId "$maintenance_actor_id" \
      --arg requestId "$maintenance_request_id" \
      --arg state "$maintenance_state" \
      --arg updatedAt "$maintenance_updated_at" \
      --arg code "$maintenance_code" \
      --arg rolledBack "$maintenance_rolled_back" \
      --arg expiresAt "$maintenance_expires_at" \
      --slurpfile manifest "$maintenance_preview_file" '
        {
          schemaVersion: 1,
          id: $id,
          type: $type,
          actorId: $actorId,
          requestId: $requestId,
          state: $state,
          updatedAt: $updatedAt,
          code: (if $code == "" then null else $code end),
          rolledBack: (if $rolledBack == "true" then true elif $rolledBack == "false" then false else null end),
          expiresAt: (if $expiresAt == "" then null else ($expiresAt | tonumber) end),
          backupCreatedAt: $manifest[0].createdAt,
          postgresMajor: $manifest[0].postgresMajor,
          database: $manifest[0].database,
          preview: $manifest[0].counts
        } | with_entries(select(.value != null))
      ' >"$maintenance_status_tmp" || { rm -f "$maintenance_status_tmp"; return 1; }
  else
    jq -n \
      --arg id "$maintenance_job_id" \
      --arg type "$maintenance_job_type" \
      --arg actorId "$maintenance_actor_id" \
      --arg requestId "$maintenance_request_id" \
      --arg state "$maintenance_state" \
      --arg updatedAt "$maintenance_updated_at" \
      --arg code "$maintenance_code" \
      --arg rolledBack "$maintenance_rolled_back" '
        {
          schemaVersion: 1,
          id: $id,
          type: $type,
          actorId: $actorId,
          requestId: $requestId,
          state: $state,
          updatedAt: $updatedAt,
          code: (if $code == "" then null else $code end),
          rolledBack: (if $rolledBack == "true" then true elif $rolledBack == "false" then false else null end)
        } | with_entries(select(.value != null))
      ' >"$maintenance_status_tmp" || { rm -f "$maintenance_status_tmp"; return 1; }
  fi
  maintenance_publish_public_file "$maintenance_status_tmp" \
    || { rm -f "$maintenance_status_tmp"; return 1; }
  if ! mv "$maintenance_status_tmp" "$maintenance_status"; then
    rm -f "$maintenance_status_tmp"
    return 1
  fi
  portable_sync_filesystem "$maintenance_status" \
    && portable_sync_filesystem "$ADMIN_OPS_DIR/status"
}

# Task 1 reports only a state. The worker replaces that callback so public
# status retains the immutable job identity and actor binding on every stage.
portable_status() {
  [ -n "${1:-}" ] || return 0
  maintenance_write_status "$2"
}

maintenance_render_marker() {
  maintenance_marker_output=$1
  maintenance_active=$2
  maintenance_marker_job=${3:-}
  maintenance_updated_at=$(maintenance_now_iso)
  jq -n \
    --arg active "$maintenance_active" \
    --arg jobId "$maintenance_marker_job" \
    --arg updatedAt "$maintenance_updated_at" '
      {
        schemaVersion: 1,
        active: ($active == "true"),
        jobId: (if $jobId == "" then null else $jobId end),
        updatedAt: $updatedAt
      } | with_entries(select(.value != null))
    ' >"$maintenance_marker_output"
}

maintenance_validate_marker_schema() {
  jq -e '
    type == "object" and
    .schemaVersion == 1 and
    (.active | type == "boolean") and
    (.updatedAt | type == "string") and
    (
      if .active then
        (keys | sort) == ["active", "jobId", "schemaVersion", "updatedAt"] and
        (.jobId | type == "string" and test("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"))
      else
        (keys | sort) == ["active", "schemaVersion", "updatedAt"]
      end
    )
  ' "$1" >/dev/null 2>&1
}

maintenance_marker_matches() {
  maintenance_marker_candidate=$1
  maintenance_expected_active=$2
  maintenance_expected_job=${3:-}
  maintenance_validate_marker_schema "$maintenance_marker_candidate" || return 1
  jq -e --arg active "$maintenance_expected_active" --arg jobId "$maintenance_expected_job" '
    if $active == "true" then .active == true and .jobId == $jobId
    else .active == false and (has("jobId") | not)
    end
  ' "$maintenance_marker_candidate" >/dev/null 2>&1
}

maintenance_write_authoritative_marker() {
  maintenance_active=$1
  maintenance_marker_job=${2:-}
  maintenance_authoritative_marker="$ADMIN_OPS_ROOT_DIR/maintenance.json"
  maintenance_marker_tmp=$(mktemp "$ADMIN_OPS_ROOT_DIR/.maintenance.XXXXXX") || return 1
  maintenance_render_marker "$maintenance_marker_tmp" "$maintenance_active" "$maintenance_marker_job" \
    || { rm -f "$maintenance_marker_tmp"; return 1; }
  chmod 600 "$maintenance_marker_tmp" || { rm -f "$maintenance_marker_tmp"; return 1; }
  if ! mv "$maintenance_marker_tmp" "$maintenance_authoritative_marker"; then
    rm -f "$maintenance_marker_tmp"
    return 1
  fi
  maintenance_require_root_file "$maintenance_authoritative_marker" 600 \
    && maintenance_marker_matches "$maintenance_authoritative_marker" "$maintenance_active" "$maintenance_marker_job" \
    && portable_sync_filesystem "$maintenance_authoritative_marker" \
    && portable_sync_filesystem "$ADMIN_OPS_ROOT_DIR"
}

# Fixed web mirror for Task 3/API consumers. This file is informational only;
# admission and reboot recovery never consult it.
maintenance_write_public_marker() {
  maintenance_active=$1
  maintenance_marker_job=${2:-}
  maintenance_public_marker="$ADMIN_OPS_DIR/status/maintenance.json"
  maintenance_marker_tmp=$(mktemp "$ADMIN_OPS_DIR/status/.maintenance.XXXXXX") || return 1
  maintenance_render_marker "$maintenance_marker_tmp" "$maintenance_active" "$maintenance_marker_job" \
    || { rm -f "$maintenance_marker_tmp"; return 1; }
  maintenance_publish_public_file "$maintenance_marker_tmp" \
    || { rm -f "$maintenance_marker_tmp"; return 1; }
  if ! mv "$maintenance_marker_tmp" "$maintenance_public_marker"; then
    rm -f "$maintenance_marker_tmp"
    return 1
  fi
  maintenance_marker_matches "$maintenance_public_marker" "$maintenance_active" "$maintenance_marker_job"
}

maintenance_write_marker() {
  maintenance_active=$1
  maintenance_marker_job=${2:-}
  maintenance_write_authoritative_marker "$maintenance_active" "$maintenance_marker_job" || return 1
  maintenance_write_public_marker "$maintenance_active" "$maintenance_marker_job"
}

maintenance_authoritative_marker_state() {
  maintenance_authoritative_marker="$ADMIN_OPS_ROOT_DIR/maintenance.json"
  if [ ! -e "$maintenance_authoritative_marker" ] && [ ! -L "$maintenance_authoritative_marker" ]; then
    return 1
  fi
  maintenance_require_root_file "$maintenance_authoritative_marker" 600 || return 2
  maintenance_validate_marker_schema "$maintenance_authoritative_marker" || return 2
  jq -e '.active == true' "$maintenance_authoritative_marker" >/dev/null 2>&1 && return 0
  return 1
}

maintenance_is_active_for() {
  maintenance_expected_job=$1
  maintenance_authoritative_state=0
  maintenance_authoritative_marker_state || maintenance_authoritative_state=$?
  case "$maintenance_authoritative_state" in
    0)
      jq -e --arg jobId "$maintenance_expected_job" '.jobId == $jobId' \
        "$ADMIN_OPS_ROOT_DIR/maintenance.json" >/dev/null 2>&1 ;;
    1) return 1 ;;
    *) return 2 ;;
  esac
}

maintenance_any_active() {
  maintenance_authoritative_marker_state
}

maintenance_intervention_required() {
  for maintenance_intervention_entry in "$ADMIN_OPS_ROOT_DIR"/intervention/*; do
    [ -e "$maintenance_intervention_entry" ] || [ -L "$maintenance_intervention_entry" ] || continue
    return 0
  done
  return 1
}

maintenance_sync_public_marker() {
  maintenance_authoritative_marker="$ADMIN_OPS_ROOT_DIR/maintenance.json"
  if [ ! -e "$maintenance_authoritative_marker" ] && [ ! -L "$maintenance_authoritative_marker" ]; then
    return 0
  fi
  maintenance_authoritative_state=0
  maintenance_authoritative_marker_state || maintenance_authoritative_state=$?
  case "$maintenance_authoritative_state" in
    0)
      maintenance_authoritative_job=$(jq -er '.jobId' "$maintenance_authoritative_marker") || return 1
      maintenance_write_public_marker true "$maintenance_authoritative_job" ;;
    1) maintenance_write_public_marker false ;;
    *) return 1 ;;
  esac
}

maintenance_audit() {
  maintenance_audit_operation=$1
  maintenance_audit_job=${2:-}
  maintenance_audit_actor=${3:-}
  maintenance_audit_request=${4:-}
  maintenance_audit_status=$5
  maintenance_audit_code=${6:-}
  maintenance_audit_sha=${7:-}
  maintenance_audit_file="$ADMIN_OPS_ROOT_DIR/audit.jsonl"
  maintenance_audit_time=$(maintenance_now_iso)
  maintenance_audit_line=$(jq -nc \
    --arg operation "$maintenance_audit_operation" \
    --arg jobId "$maintenance_audit_job" \
    --arg actorId "$maintenance_audit_actor" \
    --arg requestId "$maintenance_audit_request" \
    --arg time "$maintenance_audit_time" \
    --arg status "$maintenance_audit_status" \
    --arg code "$maintenance_audit_code" \
    --arg backupSha256 "$maintenance_audit_sha" '
      {
        operation: $operation,
        jobId: (if $jobId == "" then null else $jobId end),
        actorId: (if $actorId == "" then null else $actorId end),
        requestId: (if $requestId == "" then null else $requestId end),
        time: $time,
        backupSha256: (if $backupSha256 == "" then null else $backupSha256 end),
        status: $status,
        code: (if $code == "" then null else $code end)
      } | with_entries(select(.value != null))
    ') || return 1
  umask 077
  printf '%s\n' "$maintenance_audit_line" >>"$maintenance_audit_file" || return 1
  maintenance_normalize_root_file "$maintenance_audit_file" 600 || return 1
  portable_sync_filesystem "$maintenance_audit_file" || return 1
  portable_sync_filesystem "$ADMIN_OPS_ROOT_DIR" || return 1
  if command -v logger >/dev/null 2>&1; then
    logger -t fitgridweb-maintenance -- "$maintenance_audit_line" 2>/dev/null || :
  fi
  return 0
}

maintenance_claim_secret() {
  maintenance_secret_source="$ADMIN_OPS_DIR/inbox/$maintenance_job_id.secret"
  maintenance_secret_claim="$ADMIN_OPS_ROOT_DIR/claimed/$maintenance_job_id.secret"
  [ -f "$maintenance_secret_source" ] && [ ! -L "$maintenance_secret_source" ] || return 1
  require_private_file "$maintenance_secret_source" "Maintenance passphrase"
  maintenance_claim_app_file "$maintenance_secret_source" "$maintenance_secret_claim" 400 || return 1
  maintenance_current_secret=$maintenance_secret_claim
}

maintenance_claim_upload() {
  maintenance_claim_upload_code=INVALID_UPLOAD
  maintenance_upload_source="$ADMIN_OPS_DIR/uploads/$maintenance_job_id.fitgridbackup"
  maintenance_upload_claim="$ADMIN_OPS_ROOT_DIR/claimed/$maintenance_job_id.fitgridbackup"
  [ -f "$maintenance_upload_source" ] && [ ! -L "$maintenance_upload_source" ] || return 1
  maintenance_upload_bytes=$(portable_file_size "$maintenance_upload_source") || return 1
  maintenance_upload_available_kb=$(portable_available_kilobytes "$ADMIN_OPS_ROOT_DIR/claimed") || return 1
  maintenance_upload_required_kb=$(awk -v size="$maintenance_upload_bytes" \
    'BEGIN { print int((size + 67108864 + 1023) / 1024) }') || return 1
  if [ "$maintenance_upload_available_kb" -lt "$maintenance_upload_required_kb" ]; then
    maintenance_claim_upload_code=INSUFFICIENT_DISK_SPACE
    return 1
  fi
  maintenance_claim_app_file "$maintenance_upload_source" "$maintenance_upload_claim" 400 || return 1
  maintenance_current_upload=$maintenance_upload_claim
}

maintenance_purge_derived_job_artifacts() {
  rm -f "$ADMIN_OPS_DIR/inbox/$maintenance_job_id.secret" \
    "$ADMIN_OPS_ROOT_DIR/claimed/$maintenance_job_id.secret" \
    "$ADMIN_OPS_ROOT_DIR/claimed/$maintenance_job_id.fitgridbackup" \
    "$ADMIN_OPS_DIR/uploads/$maintenance_job_id.fitgridbackup"
}

maintenance_terminal_file() {
  printf '%s/completed/%s.json\n' "$ADMIN_OPS_ROOT_DIR" "$maintenance_job_id"
}

maintenance_terminal_matches_current() {
  maintenance_terminal_candidate=$(maintenance_terminal_file)
  maintenance_terminal_status=$(maintenance_status_file)
  maintenance_require_root_file "$maintenance_terminal_candidate" 400 || return 1
  [ -f "$maintenance_terminal_status" ] && [ ! -L "$maintenance_terminal_status" ] || return 1
  jq -e \
    --arg id "$maintenance_job_id" \
    --arg type "$maintenance_job_type" \
    --slurpfile status "$maintenance_terminal_status" '
      . as $terminal |
      type == "object" and
      (keys | sort) == ["finishedAt", "id", "schemaVersion", "state", "type"] and
      .schemaVersion == 1 and
      .id == $id and
      .type == $type and
      (.finishedAt | type == "string") and
      (.state == "ready" or .state == "succeeded" or .state == "failed" or .state == "intervention-required") and
      ($status | length == 1) and
      $status[0].id == $id and
      $status[0].type == $type and
      $status[0].state == $terminal.state
    ' "$maintenance_terminal_candidate" >/dev/null 2>&1
}

maintenance_record_terminal() {
  maintenance_terminal_status=$(maintenance_status_file)
  maintenance_terminal_state=$(jq -er \
    --arg id "$maintenance_job_id" \
    --arg type "$maintenance_job_type" '
      select(.id == $id and .type == $type) |
      .state | select(. == "ready" or . == "succeeded" or . == "failed" or . == "intervention-required")
    ' "$maintenance_terminal_status" 2>/dev/null) || return 1
  maintenance_terminal_destination=$(maintenance_terminal_file)
  [ ! -e "$maintenance_terminal_destination" ] && [ ! -L "$maintenance_terminal_destination" ] || return 1
  maintenance_terminal_tmp=$(mktemp "$ADMIN_OPS_ROOT_DIR/completed/.${maintenance_job_id}.XXXXXX") || return 1
  jq -n \
    --arg id "$maintenance_job_id" \
    --arg type "$maintenance_job_type" \
    --arg state "$maintenance_terminal_state" \
    --arg finishedAt "$(maintenance_now_iso)" \
    '{schemaVersion:1,id:$id,type:$type,state:$state,finishedAt:$finishedAt}' \
    >"$maintenance_terminal_tmp" || { rm -f "$maintenance_terminal_tmp"; return 1; }
  maintenance_normalize_root_file "$maintenance_terminal_tmp" 400 \
    || { rm -f "$maintenance_terminal_tmp"; return 1; }
  if ! mv "$maintenance_terminal_tmp" "$maintenance_terminal_destination"; then
    rm -f "$maintenance_terminal_tmp"
    return 1
  fi
  maintenance_terminal_matches_current \
    && portable_sync_filesystem "$maintenance_terminal_destination" \
    && portable_sync_filesystem "$ADMIN_OPS_ROOT_DIR/completed"
}

maintenance_replay_exists() {
  maintenance_replay_file=$(maintenance_terminal_file)
  if [ -e "$maintenance_replay_file" ] || [ -L "$maintenance_replay_file" ]; then
    maintenance_require_root_file "$maintenance_replay_file" 400 || return 0
    return 0
  fi
  maintenance_replay_intervention="$ADMIN_OPS_ROOT_DIR/intervention/$maintenance_job_id/job.json"
  [ -e "$maintenance_replay_intervention" ] || [ -L "$maintenance_replay_intervention" ] || return 1
  return 0
}

maintenance_cleanup_current() {
  if [ "${maintenance_preserve_recovery:-false}" != true ]; then
    [ -z "${maintenance_current_secret:-}" ] || rm -f "$maintenance_current_secret"
    [ -z "${maintenance_current_upload:-}" ] || rm -f "$maintenance_current_upload"
    [ -z "${maintenance_current_work:-}" ] || rm -rf "$maintenance_current_work"
    if [ "${maintenance_cleanup_prepared:-false}" = true ] && [ -n "${maintenance_current_prepared:-}" ]; then
      if [ -L "$maintenance_current_prepared" ]; then
        rm -f "$maintenance_current_prepared"
      elif [ -d "$maintenance_current_prepared" ]; then
        chmod 700 "$maintenance_current_prepared"
        rm -rf "$maintenance_current_prepared"
      else
        rm -f "$maintenance_current_prepared"
      fi
    fi
    if [ -n "${maintenance_current_claim:-}" ]; then
      maintenance_cleanup_marker_state=0
      maintenance_is_active_for "${maintenance_job_id:-invalid}" || maintenance_cleanup_marker_state=$?
      [ "$maintenance_cleanup_marker_state" -ne 1 ] || rm -f "$maintenance_current_claim"
    fi
  fi
  maintenance_current_secret=
  maintenance_current_upload=
  maintenance_current_work=
  maintenance_current_prepared=
  maintenance_current_claim=
  maintenance_cleanup_prepared=false
  maintenance_preserve_recovery=false
}

maintenance_handle_backup() {
  if ! maintenance_claim_secret; then
    maintenance_write_status failed MISSING_SECRET
    maintenance_audit backup "$maintenance_job_id" "$maintenance_actor_id" "$maintenance_request_id" failed MISSING_SECRET
    return 1
  fi
  if create_portable_backup "$maintenance_current_secret" "$PORTABLE_BACKUP_DIR" "$PORTABLE_BACKUP_HISTORY_FILE" "$(maintenance_status_file)"; then
    maintenance_audit backup "$maintenance_job_id" "$maintenance_actor_id" "$maintenance_request_id" ready
    return 0
  fi
  maintenance_write_status failed BACKUP_FAILED
  maintenance_audit backup "$maintenance_job_id" "$maintenance_actor_id" "$maintenance_request_id" failed BACKUP_FAILED
  return 1
}

maintenance_handle_inspection() {
  maintenance_current_upload=
  maintenance_current_prepared="$ADMIN_OPS_ROOT_DIR/prepared/$maintenance_job_id"
  maintenance_cleanup_prepared=true
  if ! maintenance_claim_secret; then
    maintenance_write_status failed MISSING_SECRET
    maintenance_audit inspect-restore "$maintenance_job_id" "$maintenance_actor_id" "$maintenance_request_id" failed MISSING_SECRET
    return 1
  fi
  if ! maintenance_claim_upload; then
    maintenance_write_status failed "$maintenance_claim_upload_code"
    maintenance_audit inspect-restore "$maintenance_job_id" "$maintenance_actor_id" "$maintenance_request_id" failed "$maintenance_claim_upload_code"
    return 1
  fi
  [ ! -e "$maintenance_current_prepared" ] && [ ! -L "$maintenance_current_prepared" ] || {
    maintenance_write_status failed PREPARED_EXISTS
    maintenance_audit inspect-restore "$maintenance_job_id" "$maintenance_actor_id" "$maintenance_request_id" failed PREPARED_EXISTS
    return 1
  }
  maintenance_current_work=$(mktemp -d "$ADMIN_OPS_ROOT_DIR/work/${maintenance_job_id}.XXXXXX") || return 1
  chmod 700 "$maintenance_current_work"
  maintenance_write_status inspecting
  maintenance_manifest_result="$maintenance_current_work/manifest.json"
  if ! inspect_portable_backup "$maintenance_current_upload" "$maintenance_current_secret" "$maintenance_current_prepared" "$maintenance_manifest_result"; then
    maintenance_write_status failed INSPECTION_FAILED
    maintenance_audit inspect-restore "$maintenance_job_id" "$maintenance_actor_id" "$maintenance_request_id" failed INSPECTION_FAILED
    return 1
  fi
  maintenance_payload="$maintenance_current_prepared/payload.tar"
  maintenance_dump_sha=$(sha256sum "$maintenance_payload" | awk '{print $1}') || return 1
  maintenance_now=$(maintenance_now_epoch) || return 1
  maintenance_expires=$((maintenance_now + 600))
  maintenance_challenge_tmp=$(mktemp "$maintenance_current_prepared/.challenge.XXXXXX") || return 1
  if ! jq -n \
    --arg jobId "$maintenance_job_id" \
    --arg actorId "$maintenance_actor_id" \
    --arg requestId "$maintenance_request_id" \
    --arg dumpSha256 "$maintenance_dump_sha" \
    --argjson expiresAt "$maintenance_expires" '
      {schemaVersion:1,jobId:$jobId,actorId:$actorId,requestId:$requestId,dumpSha256:$dumpSha256,expiresAt:$expiresAt}
    ' >"$maintenance_challenge_tmp"; then
    rm -f "$maintenance_challenge_tmp"
    return 1
  fi
  mv "$maintenance_manifest_result" "$maintenance_current_prepared/manifest.json" || return 1
  mv "$maintenance_challenge_tmp" "$maintenance_current_prepared/challenge.json" || return 1
  chmod 400 "$maintenance_payload" "$maintenance_current_prepared/manifest.json" "$maintenance_current_prepared/challenge.json" || return 1
  chmod 500 "$maintenance_current_prepared" || return 1
  maintenance_write_status awaiting-confirmation "" "" "$maintenance_expires" "$maintenance_current_prepared/manifest.json" || return 1
  maintenance_audit inspect-restore "$maintenance_job_id" "$maintenance_actor_id" "$maintenance_request_id" awaiting-confirmation "" "$maintenance_dump_sha"
  maintenance_cleanup_prepared=false
}

maintenance_validation_code=
maintenance_validate_prepared() {
  maintenance_validation_code=PREPARED_INVALID
  maintenance_current_prepared="$ADMIN_OPS_ROOT_DIR/prepared/$maintenance_restore_id"
  maintenance_cleanup_prepared=true
  maintenance_prepared_payload="$maintenance_current_prepared/payload.tar"
  maintenance_prepared_manifest="$maintenance_current_prepared/manifest.json"
  maintenance_challenge="$maintenance_current_prepared/challenge.json"
  for maintenance_required in "$maintenance_current_prepared" "$maintenance_prepared_payload" "$maintenance_prepared_manifest" "$maintenance_challenge"; do
    [ -e "$maintenance_required" ] && [ ! -L "$maintenance_required" ] || {
      maintenance_validation_code=PREPARED_NOT_FOUND
      return 1
    }
  done
  [ -d "$maintenance_current_prepared" ] && [ -f "$maintenance_prepared_payload" ] \
    && [ -f "$maintenance_prepared_manifest" ] && [ -f "$maintenance_challenge" ] || return 1
  maintenance_require_root_directory "$maintenance_current_prepared" 500 || {
    maintenance_validation_code=PREPARED_PERMISSIONS_INVALID
    return 1
  }
  for maintenance_required_file in "$maintenance_prepared_payload" "$maintenance_prepared_manifest" "$maintenance_challenge"; do
    maintenance_require_root_file "$maintenance_required_file" 400 || {
      maintenance_validation_code=PREPARED_PERMISSIONS_INVALID
      return 1
    }
  done
  jq -e '
    type == "object" and
    (keys | sort) == ["actorId", "dumpSha256", "expiresAt", "jobId", "requestId", "schemaVersion"] and
    .schemaVersion == 1 and
    (.jobId | type == "string") and
    (.actorId | type == "string") and
    (.requestId | type == "string") and
    (.dumpSha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    (.expiresAt | type == "number" and floor == .)
  ' "$maintenance_challenge" >/dev/null 2>&1 || {
    maintenance_validation_code=CHALLENGE_INVALID
    return 1
  }
  maintenance_bound_job=$(jq -r '.jobId' "$maintenance_challenge")
  maintenance_bound_actor=$(jq -r '.actorId' "$maintenance_challenge")
  maintenance_bound_request=$(jq -r '.requestId' "$maintenance_challenge")
  maintenance_bound_sha=$(jq -r '.dumpSha256' "$maintenance_challenge")
  maintenance_bound_expiry=$(jq -r '.expiresAt' "$maintenance_challenge")
  maintenance_is_request_id "$maintenance_bound_request" || {
    maintenance_validation_code=CHALLENGE_INVALID
    return 1
  }
  [ "$maintenance_bound_job" = "$maintenance_restore_id" ] && [ "$maintenance_bound_actor" = "$maintenance_actor_id" ] || {
    maintenance_validation_code=CHALLENGE_MISMATCH
    return 1
  }
  maintenance_now=$(maintenance_now_epoch) || return 1
  [ "$maintenance_now" -lt "$maintenance_bound_expiry" ] || {
    maintenance_validation_code=CHALLENGE_EXPIRED
    return 1
  }
  maintenance_actual_sha=$(sha256sum "$maintenance_prepared_payload" | awk '{print $1}') || return 1
  [ "$maintenance_actual_sha" = "$maintenance_bound_sha" ] || {
    maintenance_validation_code=PREPARED_DUMP_CHANGED
    return 1
  }
  if [ -z "${maintenance_current_work:-}" ]; then
    maintenance_current_work=$(mktemp -d "$ADMIN_OPS_ROOT_DIR/work/${maintenance_job_id}.XXXXXX") || return 1
    chmod 700 "$maintenance_current_work" || return 1
  fi
  maintenance_claimed_payload="$maintenance_current_work/prepared.claim.tar"
  ln "$maintenance_prepared_payload" "$maintenance_claimed_payload" || {
    maintenance_validation_code=PREPARED_DUMP_CHANGED
    return 1
  }
  maintenance_require_root_file "$maintenance_claimed_payload" 400 || {
    maintenance_validation_code=PREPARED_PERMISSIONS_INVALID
    return 1
  }
  maintenance_claimed_sha=$(sha256sum "$maintenance_claimed_payload" | awk '{print $1}') || return 1
  [ "$maintenance_claimed_sha" = "$maintenance_bound_sha" ] || {
    maintenance_validation_code=PREPARED_DUMP_CHANGED
    return 1
  }
  maintenance_prepared_data="$maintenance_current_work/prepared-data"
  mkdir "$maintenance_prepared_data" || return 1
  chmod 700 "$maintenance_prepared_data" || return 1
  portable_validate_plain_archive "$maintenance_claimed_payload" "$maintenance_prepared_data" || {
    maintenance_validation_code=PREPARED_DUMP_INVALID
    return 1
  }
  cmp "$maintenance_prepared_manifest" "$maintenance_prepared_data/manifest.json" >/dev/null 2>&1 || {
    maintenance_validation_code=PREPARED_DUMP_CHANGED
    return 1
  }
  maintenance_validation_code=
}

maintenance_snapshot_before_restore() {
  [ -f "$BACKUP_ENCRYPTION_KEY_FILE" ] && [ ! -L "$BACKUP_ENCRYPTION_KEY_FILE" ] || return 1
  require_private_file "$BACKUP_ENCRYPTION_KEY_FILE" "Backup encryption key"
  if [ -z "${maintenance_current_work:-}" ]; then
    maintenance_current_work=$(mktemp -d "$ADMIN_OPS_ROOT_DIR/work/${maintenance_job_id}.XXXXXX") || return 1
    chmod 700 "$maintenance_current_work" || return 1
  fi
  maintenance_rollback_plain="$maintenance_current_work/rollback.dump"
  maintenance_rollback_encrypted="$maintenance_current_work/rollback.dump.enc"
  maintenance_rollback_verify="$maintenance_current_work/rollback.verify.dump"
  MAINTENANCE_OPERATION=restore
  export MAINTENANCE_OPERATION
  fitgrid_compose exec -T db pg_dump --format=custom --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" >"$maintenance_rollback_plain" || return 1
  [ -s "$maintenance_rollback_plain" ] || return 1
  fitgrid_compose exec -T db pg_restore --list <"$maintenance_rollback_plain" >/dev/null || return 1
  openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$BACKUP_ENCRYPTION_KEY_FILE" \
    -in "$maintenance_rollback_plain" -out "$maintenance_rollback_encrypted" || return 1
  [ -s "$maintenance_rollback_encrypted" ] || return 1
  openssl enc -d -aes-256-cbc -pbkdf2 -pass "file:$BACKUP_ENCRYPTION_KEY_FILE" \
    -in "$maintenance_rollback_encrypted" -out "$maintenance_rollback_verify" || return 1
  fitgrid_compose exec -T db pg_restore --list <"$maintenance_rollback_verify" >/dev/null || return 1
  rm -f "$maintenance_rollback_plain" "$maintenance_rollback_verify"
  portable_sync_filesystem "$maintenance_rollback_encrypted" || return 1
  portable_sync_filesystem "$maintenance_current_work" || return 1
  portable_sync_filesystem "$ADMIN_OPS_ROOT_DIR/work" || return 1
}

maintenance_require_restore_space() {
  maintenance_restore_max=$(portable_max_bytes) || return 1
  maintenance_restore_available_kb=$(portable_available_kilobytes "$ADMIN_OPS_ROOT_DIR") || return 1
  # The prepared payload already occupies disk. Before extracting it, reserve
  # four configured payload ceilings for extracted canonical data plus the
  # rollback plaintext, ciphertext, and verification plaintext, with headroom.
  maintenance_restore_required_kb=$(awk -v size="$maintenance_restore_max" \
    'BEGIN { print int((4 * size + 268435456 + 1023) / 1024) }') || return 1
  [ "$maintenance_restore_available_kb" -ge "$maintenance_restore_required_kb" ]
}

maintenance_terminate_runtime_connections() {
  fitgrid_compose exec -T db psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --set=ON_ERROR_STOP=1 \
    --set="runtime_user=$APP_DATABASE_USER" \
    --command "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND usename = :'runtime_user' AND pid <> pg_backend_pid()" >/dev/null
}

maintenance_restore_trusted_dump() {
  maintenance_restore_input=$1
  fitgrid_compose exec -T db pg_restore --clean --if-exists --no-owner --exit-on-error --single-transaction \
    --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" <"$maintenance_restore_input"
}

maintenance_reset_portable_schema() {
  fitgrid_compose exec -T db psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
    --set=ON_ERROR_STOP=1 --set=migration_user="$POSTGRES_USER" --set=runtime_user="$APP_DATABASE_USER" <<'EOSQL'
DROP SCHEMA public CASCADE;
CREATE SCHEMA public AUTHORIZATION :"migration_user";
GRANT USAGE ON SCHEMA public TO :"runtime_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_user" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"runtime_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_user" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"runtime_user";
EOSQL
}

maintenance_restore_portable_data() {
  maintenance_restore_directory=$1
  portable_restore_canonical_data "$maintenance_restore_directory"
}

maintenance_run_migrations() {
  maintenance_saved_database_url=$DATABASE_URL
  DATABASE_URL=$MIGRATION_DATABASE_URL
  export DATABASE_URL
  maintenance_migration_status=0
  fitgrid_compose run --rm --no-deps -e DATABASE_URL app node_modules/.bin/prisma migrate deploy || maintenance_migration_status=$?
  DATABASE_URL=$maintenance_saved_database_url
  export DATABASE_URL
  return "$maintenance_migration_status"
}

maintenance_delete_all_sessions() {
  fitgrid_compose exec -T db psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --set=ON_ERROR_STOP=1 \
    --command 'DELETE FROM sessions' >/dev/null
}

maintenance_verify_health() {
  maintenance_health_phase=$1
  MAINTENANCE_HEALTH_PHASE=$maintenance_health_phase
  export MAINTENANCE_HEALTH_PHASE
  maintenance_attempts=${FITGRID_HEALTH_ATTEMPTS:-12}
  maintenance_count=1
  while [ "$maintenance_count" -le "$maintenance_attempts" ]; do
    if curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:${APP_PORT:-3000}/fitgrid/api/v1/health" >/dev/null \
      && curl --fail --silent --show-error --max-time 10 "https://$DOMAIN/fitgrid/api/v1/health" >/dev/null; then
      return 0
    fi
    maintenance_count=$((maintenance_count + 1))
    [ "$maintenance_count" -gt "$maintenance_attempts" ] || sleep 5
  done
  return 1
}

maintenance_retain_intervention_state() {
  maintenance_intervention_directory="$ADMIN_OPS_ROOT_DIR/intervention/$maintenance_job_id"
  if [ ! -e "$maintenance_intervention_directory" ] && [ ! -L "$maintenance_intervention_directory" ]; then
    mkdir "$maintenance_intervention_directory" || return 1
    chown "$(maintenance_root_uid):$(maintenance_root_gid)" "$maintenance_intervention_directory" || return 1
    chmod 700 "$maintenance_intervention_directory" || return 1
  fi
  maintenance_require_root_directory "$maintenance_intervention_directory" 700 || return 1
  if [ -n "${maintenance_rollback_encrypted:-}" ] \
    && [ -f "$maintenance_rollback_encrypted" ] && [ ! -L "$maintenance_rollback_encrypted" ]; then
    mv "$maintenance_rollback_encrypted" "$maintenance_intervention_directory/rollback.dump.enc" || return 1
    maintenance_normalize_root_file "$maintenance_intervention_directory/rollback.dump.enc" 400 || return 1
    portable_sync_filesystem "$maintenance_intervention_directory/rollback.dump.enc" || return 1
  fi
  if [ -n "${maintenance_current_claim:-}" ] && [ -f "$maintenance_current_claim" ]; then
    mv "$maintenance_current_claim" "$maintenance_intervention_directory/job.json" || return 1
    maintenance_normalize_root_file "$maintenance_intervention_directory/job.json" 400 || return 1
    portable_sync_filesystem "$maintenance_intervention_directory/job.json" || return 1
    maintenance_current_claim=
  fi
  maintenance_require_root_file "$maintenance_intervention_directory/job.json" 400 \
    && portable_sync_filesystem "$maintenance_intervention_directory" \
    && portable_sync_filesystem "$ADMIN_OPS_ROOT_DIR/intervention"
}

maintenance_quarantine_corrupt_claim() {
  maintenance_corrupt_basename=$(basename "$maintenance_current_claim")
  maintenance_corrupt_directory="$ADMIN_OPS_ROOT_DIR/intervention/corrupt-claims"
  maintenance_corrupt_destination="$maintenance_corrupt_directory/$maintenance_corrupt_basename"
  maintenance_write_fence || :
  if maintenance_ensure_root_directory "$maintenance_corrupt_directory" \
    && portable_sync_filesystem "$ADMIN_OPS_ROOT_DIR/intervention" \
    && [ ! -e "$maintenance_corrupt_destination" ] \
    && [ ! -L "$maintenance_corrupt_destination" ] \
    && maintenance_normalize_root_file "$maintenance_current_claim" 400 \
    && mv "$maintenance_current_claim" "$maintenance_corrupt_destination" \
    && maintenance_require_root_file "$maintenance_corrupt_destination" 400 \
    && portable_sync_filesystem "$maintenance_corrupt_destination" \
    && portable_sync_filesystem "$maintenance_corrupt_directory"; then
    maintenance_current_claim=
  fi
  maintenance_audit job "" "" "" rejected INVALID_JOB || :
  return 1
}

maintenance_enter_intervention() {
  maintenance_intervention_code=$1
  maintenance_write_fence || :
  maintenance_write_marker true "$maintenance_job_id" || :
  maintenance_write_status intervention-required "$maintenance_intervention_code" false || :
  maintenance_audit "${maintenance_job_type:-job}" "$maintenance_job_id" "$maintenance_actor_id" "$maintenance_request_id" intervention-required "$maintenance_intervention_code" "${maintenance_bound_sha:-}" || :
  if ! maintenance_retain_intervention_state; then
    maintenance_audit "${maintenance_job_type:-job}" "$maintenance_job_id" "$maintenance_actor_id" "$maintenance_request_id" intervention-required INTERVENTION_PERSIST_FAILED "${maintenance_bound_sha:-}" || :
  fi
  return 1
}

maintenance_finalize_restored_success() {
  if ! maintenance_write_status succeeded; then
    maintenance_enter_intervention STATUS_PUBLISH_FAILED
    return 1
  fi
  if ! maintenance_audit restore "$maintenance_job_id" "$maintenance_actor_id" "$maintenance_request_id" succeeded "" "$maintenance_bound_sha"; then
    maintenance_enter_intervention AUDIT_PERSIST_FAILED
    return 1
  fi
  if ! maintenance_record_terminal; then
    maintenance_enter_intervention TERMINAL_STATE_WRITE_FAILED
    return 1
  fi
  if ! maintenance_write_marker false; then
    maintenance_enter_intervention MARKER_CLEAR_FAILED
    return 1
  fi
  if ! maintenance_clear_fence; then
    maintenance_enter_intervention FENCE_CLEAR_FAILED
    return 1
  fi
}

maintenance_finalize_successful_rollback() {
  if ! maintenance_write_status failed RESTORE_FAILED true; then
    maintenance_enter_intervention STATUS_PUBLISH_FAILED
    return 1
  fi
  if ! maintenance_audit restore "$maintenance_job_id" "$maintenance_actor_id" "$maintenance_request_id" failed RESTORE_FAILED "$maintenance_bound_sha" \
    || ! maintenance_audit rollback "$maintenance_job_id" "$maintenance_actor_id" "$maintenance_request_id" succeeded "" "$maintenance_bound_sha"; then
    maintenance_enter_intervention AUDIT_PERSIST_FAILED
    return 1
  fi
  if ! maintenance_record_terminal; then
    maintenance_enter_intervention TERMINAL_STATE_WRITE_FAILED
    return 1
  fi
  if ! maintenance_write_marker false; then
    maintenance_enter_intervention MARKER_CLEAR_FAILED
    return 1
  fi
  if ! maintenance_clear_fence; then
    maintenance_enter_intervention FENCE_CLEAR_FAILED
    return 1
  fi
}

maintenance_attempt_rollback() {
  maintenance_write_status rollback
  maintenance_audit restore "$maintenance_job_id" "$maintenance_actor_id" "$maintenance_request_id" rollback ROLLBACK_STARTED "$maintenance_bound_sha"
  maintenance_rollback_plain="$maintenance_current_work/rollback.restore.dump"
  MAINTENANCE_RESTORE_SOURCE=rollback
  export MAINTENANCE_RESTORE_SOURCE
  if fitgrid_compose stop app \
    && maintenance_terminate_runtime_connections \
    && openssl enc -d -aes-256-cbc -pbkdf2 -pass "file:$BACKUP_ENCRYPTION_KEY_FILE" \
      -in "$maintenance_rollback_encrypted" -out "$maintenance_rollback_plain" \
    && fitgrid_compose exec -T db pg_restore --list <"$maintenance_rollback_plain" >/dev/null \
    && maintenance_restore_trusted_dump "$maintenance_rollback_plain" \
    && maintenance_run_migrations \
    && fitgrid_compose up --no-build -d --wait app \
    && maintenance_verify_health rollback
  then
    maintenance_finalize_successful_rollback
    return $?
  fi
  rm -f "$maintenance_rollback_plain" "$maintenance_current_work/rollback.verify.dump" "$maintenance_current_work/rollback.dump"
  maintenance_enter_intervention ROLLBACK_FAILED
}

maintenance_handle_restore() {
  maintenance_current_prepared="$ADMIN_OPS_ROOT_DIR/prepared/$maintenance_restore_id"
  maintenance_cleanup_prepared=true
  if ! maintenance_require_restore_space; then
    maintenance_write_status failed INSUFFICIENT_DISK_SPACE || :
    maintenance_audit restore "$maintenance_job_id" "$maintenance_actor_id" "$maintenance_request_id" failed INSUFFICIENT_DISK_SPACE || :
    return 1
  fi
  if ! maintenance_validate_prepared; then
    maintenance_write_status failed "$maintenance_validation_code"
    maintenance_audit restore "$maintenance_job_id" "$maintenance_actor_id" "$maintenance_request_id" failed "$maintenance_validation_code"
    return 1
  fi
  if ! maintenance_write_status snapshotting; then
    maintenance_enter_intervention STATUS_PUBLISH_FAILED || :
    return 1
  fi
  if ! maintenance_snapshot_before_restore; then
    maintenance_write_status failed SNAPSHOT_FAILED
    maintenance_audit restore "$maintenance_job_id" "$maintenance_actor_id" "$maintenance_request_id" failed SNAPSHOT_FAILED "$maintenance_bound_sha"
    return 1
  fi

  if ! maintenance_write_fence; then
    maintenance_enter_intervention FENCE_ACTIVATION_FAILED || :
    return 1
  fi
  if ! maintenance_write_marker true "$maintenance_job_id"; then
    maintenance_enter_intervention MARKER_ACTIVATION_FAILED || :
    return 1
  fi
  if ! maintenance_write_status restoring; then
    maintenance_enter_intervention STATUS_PUBLISH_FAILED || :
    return 1
  fi
  MAINTENANCE_RESTORE_SOURCE=upload
  export MAINTENANCE_RESTORE_SOURCE
  if fitgrid_compose stop app \
    && maintenance_terminate_runtime_connections \
    && maintenance_reset_portable_schema
  then
    if ! maintenance_write_status migrating; then
      maintenance_enter_intervention STATUS_PUBLISH_FAILED || :
      return 1
    fi
    if maintenance_run_migrations
    then
      if ! maintenance_write_status restoring; then
        maintenance_enter_intervention STATUS_PUBLISH_FAILED || :
        return 1
      fi
      if maintenance_restore_portable_data "$maintenance_prepared_data" \
        && maintenance_delete_all_sessions \
        && fitgrid_compose up --no-build -d --wait app
      then
        if ! maintenance_write_status checking; then
          maintenance_enter_intervention STATUS_PUBLISH_FAILED || :
          return 1
        fi
        if maintenance_verify_health restored; then
          maintenance_finalize_restored_success
          return $?
        fi
      fi
    fi
  fi
  maintenance_attempt_rollback
}

maintenance_process_claimed_job() {
  maintenance_current_claim=$1
  maintenance_current_secret=
  maintenance_current_upload=
  maintenance_current_work=
  maintenance_current_prepared=
  maintenance_cleanup_prepared=false
  maintenance_claim_basename=$(basename "$maintenance_current_claim")
  if ! maintenance_parse_job "$maintenance_current_claim"; then
    maintenance_quarantine_corrupt_claim || :
    return 1
  fi
  if maintenance_replay_exists; then
    maintenance_purge_derived_job_artifacts
    maintenance_audit "$maintenance_job_type" "$maintenance_job_id" "$maintenance_actor_id" "$maintenance_request_id" rejected REPLAYED_JOB
    rm -f "$maintenance_current_claim"
    maintenance_current_claim=
    return 1
  fi
  maintenance_write_status queued || return 1
  maintenance_job_status=0
  case "$maintenance_job_type" in
    backup) maintenance_handle_backup || maintenance_job_status=$? ;;
    inspect-restore) maintenance_handle_inspection || maintenance_job_status=$? ;;
    restore) maintenance_handle_restore || maintenance_job_status=$? ;;
    *) maintenance_job_status=1 ;;
  esac
  maintenance_finished_state=$(jq -er '.state | strings' "$(maintenance_status_file)" 2>/dev/null) || maintenance_finished_state=
  if [ "$maintenance_finished_state" = awaiting-confirmation ]; then
    maintenance_cleanup_current
    return "$maintenance_job_status"
  fi
  maintenance_terminal_destination=$(maintenance_terminal_file)
  if [ -e "$maintenance_terminal_destination" ] || [ -L "$maintenance_terminal_destination" ]; then
    if ! maintenance_terminal_matches_current \
      && ! maintenance_intervention_is_terminal_id "$maintenance_job_id"; then
      maintenance_cleanup_prepared=true
      maintenance_enter_intervention TERMINAL_STATE_WRITE_FAILED || :
      maintenance_job_status=1
    fi
  elif ! maintenance_record_terminal; then
    maintenance_cleanup_prepared=true
    maintenance_enter_intervention TERMINAL_STATE_WRITE_FAILED || :
    maintenance_job_status=1
  fi
  maintenance_cleanup_current
  return "$maintenance_job_status"
}

maintenance_recover_claimed_jobs() {
  maintenance_recovery_status=0
  for maintenance_stale in "$ADMIN_OPS_ROOT_DIR"/claimed/*.json; do
    [ -e "$maintenance_stale" ] || continue
    maintenance_current_claim=$maintenance_stale
    maintenance_stale_basename=$(basename "$maintenance_stale")
    if maintenance_parse_job "$maintenance_stale"; then
      maintenance_current_secret="$ADMIN_OPS_ROOT_DIR/claimed/$maintenance_job_id.secret"
      maintenance_current_upload="$ADMIN_OPS_ROOT_DIR/claimed/$maintenance_job_id.fitgridbackup"
      maintenance_current_work=
      maintenance_current_prepared="$ADMIN_OPS_ROOT_DIR/prepared/${maintenance_restore_id:-$maintenance_job_id}"
      maintenance_cleanup_prepared=true
      maintenance_recovery_marker_state=0
      maintenance_is_active_for "$maintenance_job_id" || maintenance_recovery_marker_state=$?
      if [ "$maintenance_recovery_marker_state" -eq 2 ]; then
        maintenance_recovery_status=1
        continue
      fi
      if maintenance_terminal_matches_current; then
        maintenance_recovery_terminalized=true
        maintenance_recovery_authority_state=0
        maintenance_authoritative_marker_state || maintenance_recovery_authority_state=$?
        if [ "$maintenance_recovery_authority_state" -eq 0 ] \
          && { [ "$maintenance_job_type" != restore ] || [ "$maintenance_recovery_marker_state" -ne 0 ]; }; then
          maintenance_recovery_terminalized=false
        fi
        if [ "$maintenance_recovery_terminalized" = true ]; then
          maintenance_reconcile_admission "$maintenance_job_id" || maintenance_recovery_terminalized=false
        fi
        if [ "$maintenance_recovery_terminalized" = true ] && [ "$maintenance_job_type" = restore ]; then
          maintenance_write_marker false || maintenance_recovery_terminalized=false
        fi
        if [ "$maintenance_recovery_terminalized" = true ] && [ "$maintenance_job_type" = restore ]; then
          maintenance_clear_fence || maintenance_recovery_terminalized=false
        fi
        if [ "$maintenance_recovery_terminalized" != true ]; then
          maintenance_preserve_recovery=true
          maintenance_cleanup_current
          maintenance_recovery_status=1
          continue
        fi
        maintenance_cleanup_current
        rm -f "$ADMIN_OPS_DIR/inbox/$maintenance_job_id.secret"
        for maintenance_stale_work in "$ADMIN_OPS_ROOT_DIR"/work/"$maintenance_job_id".*; do
          [ -e "$maintenance_stale_work" ] || continue
          rm -rf "$maintenance_stale_work"
        done
        continue
      fi
      if [ "$maintenance_job_type" = restore ] && [ "$maintenance_recovery_marker_state" -eq 0 ]; then
        maintenance_rollback_encrypted=
        for maintenance_interrupted_work in "$ADMIN_OPS_ROOT_DIR"/work/"$maintenance_job_id".*; do
          [ -d "$maintenance_interrupted_work" ] && [ ! -L "$maintenance_interrupted_work" ] || continue
          maintenance_interrupted_cipher="$maintenance_interrupted_work/rollback.dump.enc"
          if [ -z "$maintenance_rollback_encrypted" ] \
            && [ -f "$maintenance_interrupted_cipher" ] && [ ! -L "$maintenance_interrupted_cipher" ]; then
            maintenance_rollback_encrypted=$maintenance_interrupted_cipher
          fi
        done
        maintenance_enter_intervention RESTORE_INTERRUPTED || :
        if ! maintenance_intervention_is_terminal_id "$maintenance_job_id"; then
          maintenance_preserve_recovery=true
          maintenance_cleanup_current
          maintenance_recovery_status=1
          continue
        fi
      else
        maintenance_recovery_terminalized=true
        maintenance_write_status failed STALE_JOB || maintenance_recovery_terminalized=false
        maintenance_audit "$maintenance_job_type" "$maintenance_job_id" "$maintenance_actor_id" "$maintenance_request_id" failed STALE_JOB \
          || maintenance_recovery_terminalized=false
        if [ "$maintenance_recovery_terminalized" = true ]; then
          maintenance_record_terminal || maintenance_recovery_terminalized=false
        fi
        if [ "$maintenance_recovery_terminalized" = true ]; then
          maintenance_reconcile_admission "$maintenance_job_id" || maintenance_recovery_terminalized=false
        fi
        if [ "$maintenance_recovery_terminalized" != true ]; then
          maintenance_preserve_recovery=true
          maintenance_cleanup_current
          maintenance_recovery_status=1
          continue
        fi
        maintenance_cleanup_current
        rm -f "$ADMIN_OPS_DIR/inbox/$maintenance_job_id.secret"
        for maintenance_stale_work in "$ADMIN_OPS_ROOT_DIR"/work/"$maintenance_job_id".*; do
          [ -e "$maintenance_stale_work" ] || continue
          rm -rf "$maintenance_stale_work"
        done
        continue
      fi
      maintenance_cleanup_current
      rm -f "$ADMIN_OPS_DIR/inbox/$maintenance_job_id.secret"
      maintenance_record_terminal || maintenance_recovery_status=1
      maintenance_reconcile_admission "$maintenance_job_id" || maintenance_recovery_status=1
      for maintenance_stale_work in "$ADMIN_OPS_ROOT_DIR"/work/"$maintenance_job_id".*; do
        [ -e "$maintenance_stale_work" ] || continue
        rm -rf "$maintenance_stale_work"
      done
    else
      maintenance_quarantine_corrupt_claim || :
      maintenance_recovery_status=1
    fi
  done
  return "$maintenance_recovery_status"
}

maintenance_expire_prepared() {
  maintenance_expiry_now=$(maintenance_now_epoch) || return 1
  for maintenance_expiry_directory in "$ADMIN_OPS_ROOT_DIR"/prepared/*; do
    [ -d "$maintenance_expiry_directory" ] && [ ! -L "$maintenance_expiry_directory" ] || continue
    maintenance_expiry_id=$(basename "$maintenance_expiry_directory")
    maintenance_is_uuid "$maintenance_expiry_id" || continue
    maintenance_expiry_challenge="$maintenance_expiry_directory/challenge.json"
    [ -f "$maintenance_expiry_challenge" ] && [ ! -L "$maintenance_expiry_challenge" ] || continue
    jq -e '
      type == "object" and
      (keys | sort) == ["actorId", "dumpSha256", "expiresAt", "jobId", "requestId", "schemaVersion"] and
      .schemaVersion == 1 and
      (.jobId | type == "string") and
      (.actorId | type == "string") and
      (.requestId | type == "string") and
      (.expiresAt | type == "number" and floor == .)
    ' "$maintenance_expiry_challenge" >/dev/null 2>&1 || continue
    maintenance_expiry_bound_id=$(jq -r '.jobId' "$maintenance_expiry_challenge")
    maintenance_expiry_actor=$(jq -r '.actorId' "$maintenance_expiry_challenge")
    maintenance_expiry_request=$(jq -r '.requestId' "$maintenance_expiry_challenge")
    maintenance_expiry_epoch=$(jq -r '.expiresAt' "$maintenance_expiry_challenge")
    [ "$maintenance_expiry_bound_id" = "$maintenance_expiry_id" ] || continue
    maintenance_is_uuid "$maintenance_expiry_actor" || continue
    maintenance_is_request_id "$maintenance_expiry_request" || continue
    [ "$maintenance_expiry_now" -ge "$maintenance_expiry_epoch" ] || continue

    maintenance_job_id=$maintenance_expiry_id
    maintenance_job_type=inspect-restore
    maintenance_actor_id=$maintenance_expiry_actor
    maintenance_request_id=$maintenance_expiry_request
    maintenance_expiry_status=0
    chmod 700 "$maintenance_expiry_directory"
    rm -rf "$maintenance_expiry_directory" || maintenance_expiry_status=1
    portable_sync_filesystem "$ADMIN_OPS_ROOT_DIR/prepared" || maintenance_expiry_status=1
    maintenance_expiry_published=true
    maintenance_write_status failed CHALLENGE_EXPIRED || {
      maintenance_expiry_published=false
      maintenance_expiry_status=1
    }
    maintenance_audit inspect-restore "$maintenance_job_id" "$maintenance_actor_id" "$maintenance_request_id" failed CHALLENGE_EXPIRED \
      || maintenance_expiry_status=1
    if [ "$maintenance_expiry_published" = true ]; then
      maintenance_record_terminal || maintenance_expiry_status=1
    fi
    maintenance_reconcile_admission "$maintenance_job_id" || maintenance_expiry_status=1
    [ "$maintenance_expiry_status" -eq 0 ] || return 1
  done
}

maintenance_reconcile_admission() {
  maintenance_reconcile_job=$1
  maintenance_admission_file="$ADMIN_OPS_DIR/status/active-job.json"
  [ -e "$maintenance_admission_file" ] || [ -L "$maintenance_admission_file" ] || return 0
  [ -f "$maintenance_admission_file" ] && [ ! -L "$maintenance_admission_file" ] || return 1
  jq -e --arg jobId "$maintenance_reconcile_job" '
    type == "object" and
    (keys | sort) == ["createdAt", "jobId", "schemaVersion"] and
    .schemaVersion == 1 and
    .jobId == $jobId and
    (.createdAt | type == "string")
  ' "$maintenance_admission_file" >/dev/null 2>&1 || return 0
  rm -f "$maintenance_admission_file" || return 1
  portable_sync_filesystem "$ADMIN_OPS_DIR/status"
}

maintenance_purge_derived_id_artifacts() {
  maintenance_purge_id=$1
  maintenance_is_uuid "$maintenance_purge_id" || return 1
  rm -f "$ADMIN_OPS_DIR/inbox/$maintenance_purge_id.secret" \
    "$ADMIN_OPS_ROOT_DIR/claimed/$maintenance_purge_id.secret" \
    "$ADMIN_OPS_ROOT_DIR/claimed/$maintenance_purge_id.fitgridbackup" \
    "$ADMIN_OPS_DIR/uploads/$maintenance_purge_id.fitgridbackup"
}

maintenance_intervention_is_terminal_id() {
  maintenance_intervention_id=$1
  maintenance_intervention_candidate="$ADMIN_OPS_ROOT_DIR/intervention/$maintenance_intervention_id"
  maintenance_intervention_job="$maintenance_intervention_candidate/job.json"
  maintenance_require_root_directory "$maintenance_intervention_candidate" 700 || return 1
  maintenance_require_root_file "$maintenance_intervention_job" 400 || return 1
  jq -e --arg id "$maintenance_intervention_id" '
    type == "object" and
    .schemaVersion == 1 and
    .id == $id and
    (.actorId | type == "string" and test("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")) and
    (.requestId | type == "string" and test("^[A-Za-z0-9_-]{1,64}$")) and
    (
      if .type == "restore" then
        (keys | sort) == ["actorId", "id", "requestId", "restoreId", "schemaVersion", "type"] and
        (.restoreId | type == "string" and test("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"))
      elif (.type == "backup" or .type == "inspect-restore") then
        (keys | sort) == ["actorId", "id", "requestId", "schemaVersion", "type"]
      else false end
    )
  ' "$maintenance_intervention_job" >/dev/null 2>&1
}

# Publishers must make the secret/upload durable first and atomically rename the
# JSON job into inbox last. The worker therefore purges only artifacts whose
# UUID already has root-owned completed or validated intervention state; it
# never races an unpublished job and never uses a stored path.
maintenance_purge_terminal_orphans() {
  for maintenance_orphan in "$ADMIN_OPS_DIR"/inbox/*.secret "$ADMIN_OPS_DIR"/uploads/*.fitgridbackup; do
    [ -e "$maintenance_orphan" ] || [ -L "$maintenance_orphan" ] || continue
    maintenance_orphan_name=$(basename "$maintenance_orphan")
    maintenance_orphan_id=${maintenance_orphan_name%.secret}
    maintenance_orphan_id=${maintenance_orphan_id%.fitgridbackup}
    maintenance_is_uuid "$maintenance_orphan_id" || continue
    maintenance_orphan_terminal="$ADMIN_OPS_ROOT_DIR/completed/$maintenance_orphan_id.json"
    [ -e "$maintenance_orphan_terminal" ] || [ -L "$maintenance_orphan_terminal" ] || continue
    maintenance_purge_derived_id_artifacts "$maintenance_orphan_id" || return 1
  done
  for maintenance_intervention_candidate in "$ADMIN_OPS_ROOT_DIR"/intervention/*; do
    [ -d "$maintenance_intervention_candidate" ] && [ ! -L "$maintenance_intervention_candidate" ] || continue
    maintenance_intervention_id=$(basename "$maintenance_intervention_candidate")
    maintenance_is_uuid "$maintenance_intervention_id" || continue
    maintenance_intervention_is_terminal_id "$maintenance_intervention_id" || continue
    maintenance_purge_derived_id_artifacts "$maintenance_intervention_id" || return 1
  done
}

maintenance_drain_inbox() {
  maintenance_drain_status=0
  for maintenance_queued in "$ADMIN_OPS_DIR"/inbox/*.json; do
    [ -e "$maintenance_queued" ] || [ -L "$maintenance_queued" ] || continue
    maintenance_claim="$ADMIN_OPS_ROOT_DIR/claimed/$(basename "$maintenance_queued")"
    if ! maintenance_claim_app_file "$maintenance_queued" "$maintenance_claim" 400; then
      [ ! -L "$maintenance_queued" ] || rm -f "$maintenance_queued"
      maintenance_drain_status=1
      continue
    fi
    maintenance_process_claimed_job "$maintenance_claim" || maintenance_drain_status=1
    maintenance_drain_authority=0
    maintenance_any_active || maintenance_drain_authority=$?
    case "$maintenance_drain_authority" in
      0) return 1 ;;
      1) : ;;
      *) return 1 ;;
    esac
    maintenance_intervention_required && return 1
  done
  return "$maintenance_drain_status"
}
