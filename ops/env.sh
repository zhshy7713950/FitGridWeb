#!/bin/sh

load_fitgrid_environment() {
  if [ -n "${ENV_FILE:-}" ]; then
    environment_file=$ENV_FILE
  elif [ -f "${FITGRID_DEFAULT_ENV_FILE:-/etc/fitgridweb/fitgridweb.env}" ]; then
    environment_file=${FITGRID_DEFAULT_ENV_FILE:-/etc/fitgridweb/fitgridweb.env}
  else
    environment_file=.env
  fi
  [ -f "$environment_file" ] || { echo "Missing environment file: $environment_file" >&2; exit 1; }
  ENV_FILE=$environment_file
  export ENV_FILE
  set -a
  # shellcheck disable=SC1090
  . "$environment_file"
  set +a
}

fitgrid_compose() {
  compose_project_directory=${PROJECT_DIR:-$(pwd)}
  docker compose --project-name fitgridweb \
    --env-file "$ENV_FILE" \
    -f "$compose_project_directory/docker-compose.yml" \
    -f "$compose_project_directory/docker-compose.low-memory.yml" "$@"
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
  for variable_value in "$APP_IMAGE" "$POSTGRES_PASSWORD" "$APP_DATABASE_PASSWORD" "$BETTER_AUTH_SECRET" "$OWNER_REF_SECRET" "$DATABASE_URL" "$MIGRATION_DATABASE_URL"; do
    case "$variable_value" in *REPLACE*|*replace_with*|*APP_PASSWORD*|*MIGRATION_PASSWORD*) echo "Environment still contains an example placeholder" >&2; exit 1 ;; esac
  done
  [ "${#POSTGRES_PASSWORD}" -ge 32 ] || { echo "POSTGRES_PASSWORD must contain at least 32 characters" >&2; exit 1; }
  [ "${#APP_DATABASE_PASSWORD}" -ge 32 ] || { echo "APP_DATABASE_PASSWORD must contain at least 32 characters" >&2; exit 1; }
  [ "${#BETTER_AUTH_SECRET}" -ge 32 ] || { echo "BETTER_AUTH_SECRET must contain at least 32 characters" >&2; exit 1; }
  [ "${#OWNER_REF_SECRET}" -ge 32 ] || { echo "OWNER_REF_SECRET must contain at least 32 characters" >&2; exit 1; }
  [ "$BETTER_AUTH_SECRET" != "$OWNER_REF_SECRET" ] || { echo "Authentication and owner reference secrets must differ" >&2; exit 1; }
  [ "$DATABASE_URL" != "$MIGRATION_DATABASE_URL" ] || { echo "Runtime and migration database URLs must differ" >&2; exit 1; }
  [ "$APP_DATABASE_USER" != "$POSTGRES_USER" ] || { echo "Runtime and migration database roles must differ" >&2; exit 1; }
  case "$DATABASE_URL" in postgres://"$APP_DATABASE_USER":*|postgresql://"$APP_DATABASE_USER":*) : ;; *) echo "DATABASE_URL must use APP_DATABASE_USER" >&2; exit 1 ;; esac
  case "$MIGRATION_DATABASE_URL" in postgres://"$POSTGRES_USER":*|postgresql://"$POSTGRES_USER":*) : ;; *) echo "MIGRATION_DATABASE_URL must use POSTGRES_USER" >&2; exit 1 ;; esac
}

require_private_file() {
  private_file=$1
  private_label=$2
  if private_mode=$(stat -c '%a' "$private_file" 2>/dev/null); then
    :
  else
    private_mode=$(stat -f '%Lp' "$private_file")
  fi
  case "$private_mode" in
    ?00|??00) : ;;
    *) echo "$private_label must not be readable or writable by group/others" >&2; exit 1 ;;
  esac
}
