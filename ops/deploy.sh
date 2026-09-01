#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$PROJECT_DIR"
. "$SCRIPT_DIR/env.sh"
load_fitgrid_environment
validate_fitgrid_environment

if [ "$(stat -c '%a' "${ENV_FILE:-.env}")" -gt 600 ]; then
  echo "Environment file must have mode 600 or stricter" >&2
  exit 1
fi

docker compose pull db caddy
if ! docker compose pull app; then
  docker compose build app
fi
docker compose up -d db

attempt=0
until docker compose exec -T db pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || { echo "Database did not become ready" >&2; exit 1; }
  sleep 2
done

# This must succeed before a new app container is started.
docker compose run --rm --no-deps -e DATABASE_URL="$MIGRATION_DATABASE_URL" app pnpm prisma migrate deploy
docker compose up -d app caddy
docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
curl --fail --silent --show-error "https://$DOMAIN/api/v1/health" >/dev/null

echo "Deployment complete: $APP_IMAGE"
echo "Database migrations and internal/public health checks passed"
