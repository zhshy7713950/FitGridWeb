#!/bin/sh

# Stop new wakeups, then allow an in-flight HTTP request to finish. Killing curl
# would disconnect the client while its server-side tick could still be running.
stop_price_alerts() {
  alert_load_state=$(systemctl show --property=LoadState --value fitgridweb-price-alerts.timer) || return 1
  case "$alert_load_state" in
    not-found|'') : ;;
    loaded) systemctl stop fitgridweb-price-alerts.timer || return 1 ;;
    *) echo "Could not inspect alert timer" >&2; return 1 ;;
  esac
  alert_load_state=$(systemctl show --property=LoadState --value fitgridweb-price-alerts.service) || return 1
  case "$alert_load_state" in
    not-found|'') return 0 ;;
    loaded) : ;;
    *) echo "Could not inspect alert service" >&2; return 1 ;;
  esac
  alert_wait=0
  while :; do
    alert_active_state=$(systemctl show --property=ActiveState --value fitgridweb-price-alerts.service) || return 1
    case "$alert_active_state" in
      inactive|failed) break ;;
      active|activating|deactivating)
        [ "$alert_wait" -lt 135 ] || { echo "Alert tick did not drain; refusing database changes" >&2; return 1; }
        sleep 1
        alert_wait=$((alert_wait + 1)) ;;
      *) echo "Could not inspect active alert tick" >&2; return 1 ;;
    esac
  done
  systemctl stop fitgridweb-price-alerts.service
}

# Exit 0 means active, 1 intentionally inactive/absent, and 2 uninspectable.
price_alerts_timer_active() {
  alert_timer_load=$(systemctl show --property=LoadState --value fitgridweb-price-alerts.timer) || return 2
  case "$alert_timer_load" in
    not-found|'') return 1 ;;
    loaded) : ;;
    *) return 2 ;;
  esac
  alert_timer_state=$(systemctl show --property=ActiveState --value fitgridweb-price-alerts.timer) || return 2
  case "$alert_timer_state" in
    active|activating) return 0 ;;
    inactive|failed|deactivating) return 1 ;;
    *) return 2 ;;
  esac
}
