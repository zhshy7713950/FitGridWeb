#!/bin/sh
set -eu

case "${APP_DATABASE_USER:-}" in
  ""|*[!a-zA-Z0-9_]*) echo "APP_DATABASE_USER is invalid" >&2; exit 1 ;;
esac
[ -n "${APP_DATABASE_PASSWORD:-}" ] || { echo "APP_DATABASE_PASSWORD is required" >&2; exit 1; }

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=db_name="$POSTGRES_DB" \
  --set=app_user="$APP_DATABASE_USER" \
  --set=app_password="$APP_DATABASE_PASSWORD" <<-'EOSQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', :'app_user', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user') \gexec
GRANT CONNECT ON DATABASE :"db_name" TO :"app_user";
GRANT USAGE ON SCHEMA public TO :"app_user";
ALTER DEFAULT PRIVILEGES GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_user";
ALTER DEFAULT PRIVILEGES GRANT USAGE, SELECT ON SEQUENCES TO :"app_user";
EOSQL
