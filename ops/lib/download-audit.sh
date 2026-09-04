#!/bin/sh

download_audit_claimed_directory() {
  printf '%s/download-audit-claimed\n' "$ADMIN_OPS_ROOT_DIR"
}

download_audit_prepare_directories() {
  maintenance_require_directory "$ADMIN_OPS_DIR/inbox" "Download audit inbox" || return 1
  maintenance_require_directory "$ADMIN_OPS_DIR/status" "Download audit status" || return 1
  maintenance_ensure_root_directory "$(download_audit_claimed_directory)"
}

download_audit_validate_request() {
  download_audit_request=$1
  jq -e '
    type == "object" and
    (keys | sort) == ["actorId", "backupId", "event", "id", "requestId", "schemaVersion"] and
    .schemaVersion == 1 and
    (.id | type == "string" and test("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")) and
    (.event == "download-token-issued" or .event == "download-completed") and
    (.actorId | type == "string" and test("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")) and
    (.requestId | type == "string" and test("^[A-Za-z0-9_-]{1,64}$")) and
    (.backupId | type == "string" and length >= 1 and length <= 128 and
      test("^[A-Za-z0-9.][A-Za-z0-9._-]*$") and . != "." and . != "..")
  ' "$download_audit_request" >/dev/null 2>&1
}

download_audit_root_contains() {
  download_audit_existing_id=$1
  download_audit_existing_event=$2
  download_audit_existing_actor=$3
  download_audit_existing_request=$4
  download_audit_existing_backup=$5
  case "$download_audit_existing_event" in
    download-token-issued)
      download_audit_existing_operation=download-token
      download_audit_existing_status=issued ;;
    download-completed)
      download_audit_existing_operation=download
      download_audit_existing_status=completed ;;
    *) return 2 ;;
  esac
  download_audit_file="$ADMIN_OPS_ROOT_DIR/audit.jsonl"
  [ -e "$download_audit_file" ] || [ -L "$download_audit_file" ] || return 1
  maintenance_require_root_file "$download_audit_file" 600 || return 2
  jq -s -e \
    --arg operation "$download_audit_existing_operation" \
    --arg auditId "$download_audit_existing_id" \
    --arg actorId "$download_audit_existing_actor" \
    --arg requestId "$download_audit_existing_request" \
    --arg backupId "$download_audit_existing_backup" \
    --arg status "$download_audit_existing_status" '
      [.[] | select(type == "object" and .auditId? == $auditId)] as $records |
      if ($records | length) == 0 then false
      elif ($records | length) == 1 and
        ($records[0] |
          (keys | sort) == ["actorId", "auditId", "backupId", "operation", "requestId", "status", "time"] and
          .operation == $operation and .auditId == $auditId and .actorId == $actorId and
          .requestId == $requestId and .backupId == $backupId and .status == $status and
          (.time | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")))
      then true
      else error("conflicting or invalid download audit record")
      end
    ' "$download_audit_file" >/dev/null 2>&1
}

download_audit_root_contains_id() {
  download_audit_existing_id=$1
  download_audit_file="$ADMIN_OPS_ROOT_DIR/audit.jsonl"
  [ -e "$download_audit_file" ] || [ -L "$download_audit_file" ] || return 1
  maintenance_require_root_file "$download_audit_file" 600 || return 2
  jq -s -e --arg auditId "$download_audit_existing_id" '
    [.[] | select(type == "object" and .auditId? == $auditId)] as $records |
    ($records | length) == 1 and
    ($records[0] |
      (keys | sort) == ["actorId", "auditId", "backupId", "operation", "requestId", "status", "time"] and
      ((.operation == "download-token" and .status == "issued") or
       (.operation == "download" and .status == "completed")) and
      (.auditId | type == "string" and test("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")) and
      (.actorId | type == "string" and test("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")) and
      (.requestId | type == "string" and test("^[A-Za-z0-9_-]{1,64}$")) and
      (.backupId | type == "string" and length >= 1 and length <= 128 and
        test("^[A-Za-z0-9.][A-Za-z0-9._-]*$") and . != "." and . != "..") and
      (.time | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")))
  ' "$download_audit_file" >/dev/null 2>&1
}

download_audit_durability_barrier() {
  download_audit_file="$ADMIN_OPS_ROOT_DIR/audit.jsonl"
  maintenance_require_root_file "$download_audit_file" 600 || return 1
  portable_sync_filesystem "$download_audit_file" || return 1
  portable_sync_filesystem "$ADMIN_OPS_ROOT_DIR"
}

download_audit_append() {
  download_audit_append_id=$1
  download_audit_append_event=$2
  download_audit_append_actor=$3
  download_audit_append_request=$4
  download_audit_append_backup=$5
  case "$download_audit_append_event" in
    download-token-issued)
      download_audit_operation=download-token
      download_audit_status=issued ;;
    download-completed)
      download_audit_operation=download
      download_audit_status=completed ;;
    *) return 1 ;;
  esac
  download_audit_file="$ADMIN_OPS_ROOT_DIR/audit.jsonl"
  download_audit_time=$(maintenance_now_iso) || return 1
  download_audit_line=$(jq -nc \
    --arg operation "$download_audit_operation" \
    --arg auditId "$download_audit_append_id" \
    --arg actorId "$download_audit_append_actor" \
    --arg requestId "$download_audit_append_request" \
    --arg backupId "$download_audit_append_backup" \
    --arg time "$download_audit_time" \
    --arg status "$download_audit_status" '
      {
        operation: $operation,
        auditId: $auditId,
        actorId: $actorId,
        requestId: $requestId,
        backupId: $backupId,
        time: $time,
        status: $status
      }
    ') || return 1
  umask 077
  download_audit_tmp=$(mktemp "$ADMIN_OPS_ROOT_DIR/.audit.jsonl.XXXXXX") || return 1
  if [ -e "$download_audit_file" ] || [ -L "$download_audit_file" ]; then
    maintenance_require_root_file "$download_audit_file" 600 \
      && cp "$download_audit_file" "$download_audit_tmp" || {
        rm -f "$download_audit_tmp"
        return 1
      }
  fi
  if ! printf '%s\n' "$download_audit_line" >>"$download_audit_tmp" \
    || ! maintenance_normalize_root_file "$download_audit_tmp" 600 \
    || ! portable_sync_filesystem "$download_audit_tmp" \
    || ! mv "$download_audit_tmp" "$download_audit_file"; then
    rm -f "$download_audit_tmp"
    return 1
  fi
  download_audit_durability_barrier
}

download_audit_validate_acknowledgment_schema() {
  download_audit_ack_file=$1
  download_audit_ack_id=$2
  [ -f "$download_audit_ack_file" ] && [ ! -L "$download_audit_ack_file" ] || return 1
  download_audit_expected_uid=$(maintenance_root_uid) || return 1
  download_audit_expected_gid=$(portable_reader_gid) || return 1
  [ "$(maintenance_file_uid "$download_audit_ack_file")" = "$download_audit_expected_uid" ] || return 1
  [ "$(maintenance_file_gid "$download_audit_ack_file")" = "$download_audit_expected_gid" ] || return 1
  [ "$(maintenance_file_mode "$download_audit_ack_file")" = 640 ] || return 1
  jq -e --arg id "$download_audit_ack_id" '
    type == "object" and
    (keys | sort) == ["expiresAt", "id", "schemaVersion", "state"] and
    .schemaVersion == 1 and .id == $id and .state == "persisted" and
    (.expiresAt | type == "number" and floor == . and . > 0)
  ' "$download_audit_ack_file" >/dev/null 2>&1
}

download_audit_validate_acknowledgment() {
  download_audit_validate_acknowledgment_schema "$1" "$2" || return 1
  download_audit_ack_now=$(maintenance_now_epoch) || return 1
  download_audit_ack_expires=$(jq -er '.expiresAt' "$1") || return 1
  [ "$download_audit_ack_expires" -gt "$download_audit_ack_now" ]
}

download_audit_publish_acknowledgment() {
  download_audit_publish_id=$1
  download_audit_ack="$ADMIN_OPS_DIR/status/$download_audit_publish_id.audit"
  if [ -e "$download_audit_ack" ] || [ -L "$download_audit_ack" ]; then
    download_audit_validate_acknowledgment "$download_audit_ack" "$download_audit_publish_id"
    return
  fi
  download_audit_ack_now=$(maintenance_now_epoch) || return 1
  download_audit_ack_expires=$((download_audit_ack_now + 60))
  download_audit_ack_tmp=$(mktemp "$ADMIN_OPS_DIR/status/.${download_audit_publish_id}.XXXXXX") || return 1
  if ! jq -nc --arg id "$download_audit_publish_id" --argjson expiresAt "$download_audit_ack_expires" \
    '{schemaVersion:1,id:$id,state:"persisted",expiresAt:$expiresAt}' >"$download_audit_ack_tmp" \
    || ! maintenance_publish_public_file "$download_audit_ack_tmp" \
    || ! mv "$download_audit_ack_tmp" "$download_audit_ack"; then
    rm -f "$download_audit_ack_tmp"
    return 1
  fi
  portable_sync_filesystem "$download_audit_ack" \
    && portable_sync_filesystem "$ADMIN_OPS_DIR/status"
}

download_audit_purge_expired_acknowledgments() {
  download_audit_purge_now=$(maintenance_now_epoch) || return 1
  download_audit_purge_status=0
  for download_audit_purge_ack in "$ADMIN_OPS_DIR"/status/*.audit; do
    [ -e "$download_audit_purge_ack" ] || [ -L "$download_audit_purge_ack" ] || continue
    download_audit_purge_id=$(basename "$download_audit_purge_ack" .audit)
    download_audit_validate_acknowledgment_schema "$download_audit_purge_ack" "$download_audit_purge_id" \
      || continue
    download_audit_purge_expires=$(jq -er '.expiresAt' "$download_audit_purge_ack") || continue
    [ "$download_audit_purge_now" -ge "$download_audit_purge_expires" ] || continue
    download_audit_root_contains_id "$download_audit_purge_id" || continue
    download_audit_durability_barrier || {
      download_audit_purge_status=1
      continue
    }
    rm -f "$download_audit_purge_ack" || {
      download_audit_purge_status=1
      continue
    }
    portable_sync_filesystem "$ADMIN_OPS_DIR/status" || download_audit_purge_status=1
  done
  return "$download_audit_purge_status"
}

download_audit_process_claimed() {
  download_audit_claim=$1
  download_audit_claim_basename=$(basename "$download_audit_claim")
  if ! download_audit_validate_request "$download_audit_claim"; then
    rm -f "$download_audit_claim"
    portable_sync_filesystem "$(download_audit_claimed_directory)" || :
    return 1
  fi
  download_audit_id=$(jq -er '.id' "$download_audit_claim") || return 1
  [ "$download_audit_claim_basename" = "$download_audit_id.audit" ] || {
    rm -f "$download_audit_claim"
    portable_sync_filesystem "$(download_audit_claimed_directory)" || :
    return 1
  }
  download_audit_event=$(jq -er '.event' "$download_audit_claim") || return 1
  download_audit_actor=$(jq -er '.actorId' "$download_audit_claim") || return 1
  download_audit_request_id=$(jq -er '.requestId' "$download_audit_claim") || return 1
  download_audit_backup=$(jq -er '.backupId' "$download_audit_claim") || return 1

  download_audit_seen=0
  download_audit_root_contains "$download_audit_id" "$download_audit_event" \
    "$download_audit_actor" "$download_audit_request_id" "$download_audit_backup" \
    || download_audit_seen=$?
  case "$download_audit_seen" in
    0) : ;;
    1) download_audit_append "$download_audit_id" "$download_audit_event" \
         "$download_audit_actor" "$download_audit_request_id" "$download_audit_backup" || return 1 ;;
    *) return 1 ;;
  esac
  download_audit_durability_barrier || return 1
  download_audit_publish_acknowledgment "$download_audit_id" || return 1
  rm -f "$download_audit_claim" || return 1
  portable_sync_filesystem "$(download_audit_claimed_directory)"
}

download_audit_drain() {
  download_audit_drain_status=0
  download_audit_claimed=$(download_audit_claimed_directory) || return 1
  for download_audit_pending in "$download_audit_claimed"/*.audit; do
    [ -e "$download_audit_pending" ] || [ -L "$download_audit_pending" ] || continue
    download_audit_process_claimed "$download_audit_pending" || download_audit_drain_status=1
  done
  for download_audit_queued in "$ADMIN_OPS_DIR"/inbox/*.audit; do
    [ -e "$download_audit_queued" ] || [ -L "$download_audit_queued" ] || continue
    download_audit_name=$(basename "$download_audit_queued")
    download_audit_claim="$download_audit_claimed/$download_audit_name"
    if ! maintenance_claim_app_file "$download_audit_queued" "$download_audit_claim" 600; then
      [ ! -L "$download_audit_queued" ] || rm -f "$download_audit_queued"
      download_audit_drain_status=1
      continue
    fi
    download_audit_process_claimed "$download_audit_claim" || download_audit_drain_status=1
  done
  return "$download_audit_drain_status"
}
