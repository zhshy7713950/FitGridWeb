#!/bin/sh
set -eu
# systemd supplies the root-owned environment file. Never place the bearer in argv.
[ ! -e /run/fitgridweb/maintenance.flag ] || exit 0
case "${APP_PORT:-}" in ''|*[!0-9]*) echo "Invalid alert loopback port" >&2; exit 1 ;; esac
[ "$APP_PORT" -ge 1024 ] && [ "$APP_PORT" -le 65535 ] || exit 1
case "${PRICE_ALERTS_TASK_SECRET:-}" in ''|*[!A-Za-z0-9_+/=.-]*) echo "Invalid alert task secret" >&2; exit 1 ;; esac
[ "${#PRICE_ALERTS_TASK_SECRET}" -ge 32 ] || exit 1
# Drop the secret from curl's environment as well as its argument list.
alert_secret=$PRICE_ALERTS_TASK_SECRET
unset PRICE_ALERTS_TASK_SECRET NOTIFICATION_ENCRYPTION_KEY
printf 'url = "http://127.0.0.1:%s/fitgrid/api/internal/price-alerts/tick"\nrequest = "POST"\nheader = "Authorization: Bearer %s"\n' "$APP_PORT" "$alert_secret" |
  curl --disable --config - --fail --silent --show-error --output /dev/null --max-time 120 --noproxy '*'
