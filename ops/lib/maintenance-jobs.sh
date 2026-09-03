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
  mkdir -p "$ADMIN_OPS_ROOT_DIR/claimed" "$ADMIN_OPS_ROOT_DIR/intervention" "$ADMIN_OPS_ROOT_DIR/work"
  chmod 700 "$ADMIN_OPS_ROOT_DIR/claimed" "$ADMIN_OPS_ROOT_DIR/intervention" "$ADMIN_OPS_ROOT_DIR/work"
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
          appImage: $manifest[0].appImage,
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
  chmod 640 "$maintenance_status_tmp"
  mv "$maintenance_status_tmp" "$maintenance_status"
}

# Task 1 reports only a state. The worker replaces that callback so public
# status retains the immutable job identity and actor binding on every stage.
portable_status() {
  [ -n "${1:-}" ] || return 0
  maintenance_write_status "$2"
}

maintenance_write_marker() {
  maintenance_active=$1
  maintenance_marker_job=${2:-}
  maintenance_marker="$ADMIN_OPS_DIR/status/maintenance.json"
  maintenance_marker_tmp=$(mktemp "$ADMIN_OPS_DIR/status/.maintenance.XXXXXX") || return 1
  maintenance_updated_at=$(maintenance_now_iso)
  jq -n \
    --arg active "$maintenance_active" \
    --arg jobId "$maintenance_marker_job" \
    --arg updatedAt "$maintenance_updated_at" '
      {
        active: ($active == "true"),
        jobId: (if $jobId == "" then null else $jobId end),
        updatedAt: $updatedAt
      } | with_entries(select(.value != null))
    ' >"$maintenance_marker_tmp" || { rm -f "$maintenance_marker_tmp"; return 1; }
  chmod 640 "$maintenance_marker_tmp"
  mv "$maintenance_marker_tmp" "$maintenance_marker"
}

maintenance_is_active_for() {
  maintenance_expected_job=$1
  maintenance_marker="$ADMIN_OPS_DIR/status/maintenance.json"
  [ -f "$maintenance_marker" ] && [ ! -L "$maintenance_marker" ] || return 1
  jq -e --arg jobId "$maintenance_expected_job" '.active == true and .jobId == $jobId' "$maintenance_marker" >/dev/null 2>&1
}

maintenance_any_active() {
  maintenance_marker="$ADMIN_OPS_DIR/status/maintenance.json"
  [ -f "$maintenance_marker" ] && [ ! -L "$maintenance_marker" ] || return 1
  jq -e '.active == true' "$maintenance_marker" >/dev/null 2>&1
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
  printf '%s\n' "$maintenance_audit_line" >>"$maintenance_audit_file"
  chmod 600 "$maintenance_audit_file"
  if command -v logger >/dev/null 2>&1; then
    logger -t fitgridweb-maintenance -- "$maintenance_audit_line" 2>/dev/null || :
  fi
}

maintenance_claim_secret() {
  maintenance_secret_source="$ADMIN_OPS_DIR/inbox/$maintenance_job_id.secret"
  maintenance_secret_claim="$ADMIN_OPS_ROOT_DIR/claimed/$maintenance_job_id.secret"
  [ -f "$maintenance_secret_source" ] && [ ! -L "$maintenance_secret_source" ] || return 1
  require_private_file "$maintenance_secret_source" "Maintenance passphrase"
  mv "$maintenance_secret_source" "$maintenance_secret_claim" || return 1
  maintenance_current_secret=$maintenance_secret_claim
}

maintenance_cleanup_current() {
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
  if [ -n "${maintenance_current_claim:-}" ] && ! maintenance_is_active_for "${maintenance_job_id:-invalid}"; then
    rm -f "$maintenance_current_claim"
  fi
  maintenance_current_secret=
  maintenance_current_upload=
  maintenance_current_work=
  maintenance_current_prepared=
  maintenance_current_claim=
  maintenance_cleanup_prepared=false
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
  maintenance_current_upload="$ADMIN_OPS_DIR/uploads/$maintenance_job_id.fitgridbackup"
  maintenance_current_prepared="$ADMIN_OPS_ROOT_DIR/prepared/$maintenance_job_id"
  maintenance_cleanup_prepared=true
  if ! maintenance_claim_secret; then
    maintenance_write_status failed MISSING_SECRET
    maintenance_audit inspect-restore "$maintenance_job_id" "$maintenance_actor_id" "$maintenance_request_id" failed MISSING_SECRET
    return 1
  fi
  [ -f "$maintenance_current_upload" ] && [ ! -L "$maintenance_current_upload" ] || {
    maintenance_write_status failed INVALID_UPLOAD
    maintenance_audit inspect-restore "$maintenance_job_id" "$maintenance_actor_id" "$maintenance_request_id" failed INVALID_UPLOAD
    return 1
  }
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
  maintenance_dump="$maintenance_current_prepared/database.dump"
  maintenance_dump_sha=$(sha256sum "$maintenance_dump" | awk '{print $1}') || return 1
  maintenance_now=$(maintenance_now_epoch) || return 1
  maintenance_ttl=${MAINTENANCE_CHALLENGE_TTL_SECONDS:-600}
  case "$maintenance_ttl" in ''|*[!0-9]*) maintenance_ttl=600 ;; esac
  [ "$maintenance_ttl" -gt 0 ] || maintenance_ttl=600
  maintenance_expires=$((maintenance_now + maintenance_ttl))
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
  chmod 400 "$maintenance_dump" "$maintenance_current_prepared/manifest.json" "$maintenance_current_prepared/challenge.json" || return 1
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
  maintenance_prepared_dump="$maintenance_current_prepared/database.dump"
  maintenance_prepared_manifest="$maintenance_current_prepared/manifest.json"
  maintenance_challenge="$maintenance_current_prepared/challenge.json"
  for maintenance_required in "$maintenance_current_prepared" "$maintenance_prepared_dump" "$maintenance_prepared_manifest" "$maintenance_challenge"; do
    [ -e "$maintenance_required" ] && [ ! -L "$maintenance_required" ] || {
      maintenance_validation_code=PREPARED_NOT_FOUND
      return 1
    }
  done
  [ -d "$maintenance_current_prepared" ] && [ -f "$maintenance_prepared_dump" ] \
    && [ -f "$maintenance_prepared_manifest" ] && [ -f "$maintenance_challenge" ] || return 1
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
  maintenance_actual_sha=$(sha256sum "$maintenance_prepared_dump" | awk '{print $1}') || return 1
  [ "$maintenance_actual_sha" = "$maintenance_bound_sha" ] || {
    maintenance_validation_code=PREPARED_DUMP_CHANGED
    return 1
  }
  fitgrid_compose exec -T db pg_restore --list <"$maintenance_prepared_dump" >/dev/null || {
    maintenance_validation_code=PREPARED_DUMP_INVALID
    return 1
  }
  maintenance_validation_code=
}

maintenance_snapshot_before_restore() {
  [ -f "$BACKUP_ENCRYPTION_KEY_FILE" ] && [ ! -L "$BACKUP_ENCRYPTION_KEY_FILE" ] || return 1
  require_private_file "$BACKUP_ENCRYPTION_KEY_FILE" "Backup encryption key"
  maintenance_current_work=$(mktemp -d "$ADMIN_OPS_ROOT_DIR/work/${maintenance_job_id}.XXXXXX") || return 1
  chmod 700 "$maintenance_current_work"
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
}

maintenance_terminate_runtime_connections() {
  fitgrid_compose exec -T db psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --set=ON_ERROR_STOP=1 \
    --set="runtime_user=$APP_DATABASE_USER" \
    --command "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND usename = :'runtime_user' AND pid <> pg_backend_pid()" >/dev/null
}

maintenance_restore_dump() {
  maintenance_restore_input=$1
  fitgrid_compose exec -T db pg_restore --clean --if-exists --no-owner --exit-on-error --single-transaction \
    --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" <"$maintenance_restore_input"
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

maintenance_attempt_rollback() {
  maintenance_write_status rollback
  maintenance_audit restore "$maintenance_job_id" "$maintenance_actor_id" "$maintenance_request_id" rollback ROLLBACK_STARTED "$maintenance_bound_sha"
  maintenance_rollback_plain="$maintenance_current_work/rollback.restore.dump"
  if openssl enc -d -aes-256-cbc -pbkdf2 -pass "file:$BACKUP_ENCRYPTION_KEY_FILE" \
      -in "$maintenance_rollback_encrypted" -out "$maintenance_rollback_plain" \
    && fitgrid_compose exec -T db pg_restore --list <"$maintenance_rollback_plain" >/dev/null \
    && MAINTENANCE_RESTORE_SOURCE=rollback maintenance_restore_dump "$maintenance_rollback_plain" \
    && maintenance_run_migrations \
    && fitgrid_compose up --no-build -d --wait app \
    && maintenance_verify_health rollback
  then
    maintenance_write_marker false
    maintenance_write_status failed RESTORE_FAILED true
    maintenance_audit restore "$maintenance_job_id" "$maintenance_actor_id" "$maintenance_request_id" failed RESTORE_FAILED "$maintenance_bound_sha"
    maintenance_audit rollback "$maintenance_job_id" "$maintenance_actor_id" "$maintenance_request_id" succeeded "" "$maintenance_bound_sha"
    return 0
  fi
  maintenance_write_status intervention-required ROLLBACK_FAILED false
  maintenance_audit rollback "$maintenance_job_id" "$maintenance_actor_id" "$maintenance_request_id" intervention-required ROLLBACK_FAILED "$maintenance_bound_sha"
  if [ -n "${maintenance_current_claim:-}" ] && [ -f "$maintenance_current_claim" ]; then
    mv "$maintenance_current_claim" "$ADMIN_OPS_ROOT_DIR/intervention/$maintenance_job_id.json" || :
    maintenance_current_claim=
  fi
  return 1
}

maintenance_handle_restore() {
  if ! maintenance_validate_prepared; then
    maintenance_write_status failed "$maintenance_validation_code"
    maintenance_audit restore "$maintenance_job_id" "$maintenance_actor_id" "$maintenance_request_id" failed "$maintenance_validation_code"
    return 1
  fi
  maintenance_write_status snapshotting
  if ! maintenance_snapshot_before_restore; then
    maintenance_write_status failed SNAPSHOT_FAILED
    maintenance_audit restore "$maintenance_job_id" "$maintenance_actor_id" "$maintenance_request_id" failed SNAPSHOT_FAILED "$maintenance_bound_sha"
    return 1
  fi

  maintenance_write_marker true "$maintenance_job_id" || return 1
  maintenance_write_status restoring
  MAINTENANCE_RESTORE_SOURCE=upload
  export MAINTENANCE_RESTORE_SOURCE
  if fitgrid_compose stop app \
    && maintenance_terminate_runtime_connections \
    && maintenance_restore_dump "$maintenance_prepared_dump"
  then
    maintenance_write_status migrating
    if maintenance_run_migrations \
      && maintenance_delete_all_sessions \
      && fitgrid_compose up --no-build -d --wait app
    then
      maintenance_write_status checking
      if maintenance_verify_health restored; then
        maintenance_write_marker false
        maintenance_write_status succeeded
        maintenance_audit restore "$maintenance_job_id" "$maintenance_actor_id" "$maintenance_request_id" succeeded "" "$maintenance_bound_sha"
        return 0
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
    maintenance_audit job "" "" "" rejected INVALID_JOB
    case "$maintenance_claim_basename" in
      ????????-????-????-????-????????????.json)
        rm -f "$ADMIN_OPS_DIR/inbox/${maintenance_claim_basename%.json}.secret" \
          "$ADMIN_OPS_ROOT_DIR/claimed/${maintenance_claim_basename%.json}.secret" \
          "$ADMIN_OPS_DIR/uploads/${maintenance_claim_basename%.json}.fitgridbackup" ;;
    esac
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
      maintenance_current_upload="$ADMIN_OPS_DIR/uploads/$maintenance_job_id.fitgridbackup"
      maintenance_current_work=
      maintenance_current_prepared="$ADMIN_OPS_ROOT_DIR/prepared/${maintenance_restore_id:-$maintenance_job_id}"
      maintenance_cleanup_prepared=true
      if [ "$maintenance_job_type" = restore ] && maintenance_is_active_for "$maintenance_job_id"; then
        maintenance_write_status intervention-required RESTORE_INTERRUPTED false
        maintenance_audit restore "$maintenance_job_id" "$maintenance_actor_id" "$maintenance_request_id" intervention-required RESTORE_INTERRUPTED
        mv "$maintenance_stale" "$ADMIN_OPS_ROOT_DIR/intervention/$maintenance_job_id.json"
        maintenance_current_claim=
      else
        maintenance_write_status failed STALE_JOB
        maintenance_audit "$maintenance_job_type" "$maintenance_job_id" "$maintenance_actor_id" "$maintenance_request_id" failed STALE_JOB
      fi
      maintenance_cleanup_current
      rm -f "$ADMIN_OPS_DIR/inbox/$maintenance_job_id.secret"
      for maintenance_stale_work in "$ADMIN_OPS_ROOT_DIR"/work/"$maintenance_job_id".*; do
        [ -e "$maintenance_stale_work" ] || continue
        rm -rf "$maintenance_stale_work"
      done
    else
      maintenance_audit job "" "" "" rejected INVALID_JOB
      rm -f "$maintenance_stale"
      maintenance_current_claim=
    fi
    maintenance_recovery_status=1
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
    maintenance_write_status failed CHALLENGE_EXPIRED || return 1
    maintenance_audit inspect-restore "$maintenance_job_id" "$maintenance_actor_id" "$maintenance_request_id" failed CHALLENGE_EXPIRED
    chmod 700 "$maintenance_expiry_directory"
    rm -rf "$maintenance_expiry_directory"
  done
}

maintenance_drain_inbox() {
  maintenance_drain_status=0
  for maintenance_queued in "$ADMIN_OPS_DIR"/inbox/*.json; do
    [ -e "$maintenance_queued" ] || [ -L "$maintenance_queued" ] || continue
    maintenance_claim="$ADMIN_OPS_ROOT_DIR/claimed/$(basename "$maintenance_queued")"
    if ! mv "$maintenance_queued" "$maintenance_claim"; then
      maintenance_drain_status=1
      continue
    fi
    maintenance_process_claimed_job "$maintenance_claim" || maintenance_drain_status=1
  done
  return "$maintenance_drain_status"
}
