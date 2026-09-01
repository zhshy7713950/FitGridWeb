#!/bin/sh

load_fitgrid_environment() {
  environment_file=${ENV_FILE:-.env}
  [ -f "$environment_file" ] || { echo "Missing environment file: $environment_file" >&2; exit 1; }
  set -a
  # shellcheck disable=SC1090
  . "$environment_file"
  set +a
}

require_fitgrid_value() {
  variable_name=$1
  eval "variable_value=\${$variable_name:-}"
  [ -n "$variable_value" ] || { echo "$variable_name is required" >&2; exit 1; }
}

validate_fitgrid_environment() {
  for variable_name in DOMAIN APP_IMAGE POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD \
    APP_DATABASE_USER APP_DATABASE_PASSWORD DATABASE_URL MIGRATION_DATABASE_URL \
    BETTER_AUTH_SECRET OWNER_REF_SECRET
  do
    require_fitgrid_value "$variable_name"
  done

  case "$DOMAIN" in http://*|https://*|*/*) echo "DOMAIN must not include a scheme or path" >&2; exit 1 ;; esac
  case "$APP_IMAGE" in *:latest|*:latest@*) echo "APP_IMAGE must not use latest" >&2; exit 1 ;; esac
  case "$APP_IMAGE" in *:*|*@sha256:*) : ;; *) echo "APP_IMAGE must use a fixed tag or digest" >&2; exit 1 ;; esac
  case "$POSTGRES_PASSWORD" in password|postgres|changeme|change-me) echo "POSTGRES_PASSWORD uses a default value" >&2; exit 1 ;; esac
  [ "${#POSTGRES_PASSWORD}" -ge 32 ] || { echo "POSTGRES_PASSWORD must contain at least 32 characters" >&2; exit 1; }
  [ "${#APP_DATABASE_PASSWORD}" -ge 32 ] || { echo "APP_DATABASE_PASSWORD must contain at least 32 characters" >&2; exit 1; }
  [ "${#BETTER_AUTH_SECRET}" -ge 32 ] || { echo "BETTER_AUTH_SECRET must contain at least 32 characters" >&2; exit 1; }
  [ "${#OWNER_REF_SECRET}" -ge 32 ] || { echo "OWNER_REF_SECRET must contain at least 32 characters" >&2; exit 1; }
  [ "$BETTER_AUTH_SECRET" != "$OWNER_REF_SECRET" ] || { echo "Authentication and owner reference secrets must differ" >&2; exit 1; }
  [ "$DATABASE_URL" != "$MIGRATION_DATABASE_URL" ] || { echo "Runtime and migration database URLs must differ" >&2; exit 1; }
}
