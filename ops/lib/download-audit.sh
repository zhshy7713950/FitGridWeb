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
  download_audit_file="$ADMIN_OPS_ROOT_DIR/audit.jsonl"
  [ -e "$download_audit_file" ] || [ -L "$download_audit_file" ] || return 1
  maintenance_require_root_file "$download_audit_file" 600 || return 2
  grep -F '"auditId":"'"$download_audit_existing_id"'"' "$download_audit_file" >/dev/null 2>&1
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
  printf '%s\n' "$download_audit_line" >>"$download_audit_file" || return 1
  maintenance_normalize_root_file "$download_audit_file" 600 || return 1
  portable_sync_filesystem "$download_audit_file" || return 1
  portable_sync_filesystem "$ADMIN_OPS_ROOT_DIR"
}

download_audit_validate_acknowledgment() {
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
    (keys | sort) == ["id", "schemaVersion", "state"] and
    .schemaVersion == 1 and .id == $id and .state == "persisted"
  ' "$download_audit_ack_file" >/dev/null 2>&1
}

download_audit_publish_acknowledgment() {
  download_audit_publish_id=$1
  download_audit_ack="$ADMIN_OPS_DIR/status/$download_audit_publish_id.audit"
  if [ -e "$download_audit_ack" ] || [ -L "$download_audit_ack" ]; then
    download_audit_validate_acknowledgment "$download_audit_ack" "$download_audit_publish_id"
    return
  fi
  download_audit_ack_tmp=$(mktemp "$ADMIN_OPS_DIR/status/.${download_audit_publish_id}.XXXXXX") || return 1
  if ! jq -nc --arg id "$download_audit_publish_id" \
    '{schemaVersion:1,id:$id,state:"persisted"}' >"$download_audit_ack_tmp" \
    || ! maintenance_publish_public_file "$download_audit_ack_tmp" \
    || ! mv "$download_audit_ack_tmp" "$download_audit_ack"; then
    rm -f "$download_audit_ack_tmp"
    return 1
  fi
  portable_sync_filesystem "$download_audit_ack" \
    && portable_sync_filesystem "$ADMIN_OPS_DIR/status"
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
  download_audit_root_contains "$download_audit_id" || download_audit_seen=$?
  case "$download_audit_seen" in
    0) : ;;
    1) download_audit_append "$download_audit_id" "$download_audit_event" \
         "$download_audit_actor" "$download_audit_request_id" "$download_audit_backup" || return 1 ;;
    *) return 1 ;;
  esac
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
