#!/bin/sh

if ! command -v fitgrid_error >/dev/null 2>&1; then
  fitgrid_error() { printf '错误：%s\n' "$*" >&2; }
fi

validate_nginx_site() {
  site=$1
  domain=$2
  public_port=$3

  [ -f "$site" ] || { fitgrid_error "nginx vhost 不是普通文件：$site"; return 1; }
  server_count=$(sed 's/#.*$//' "$site" | grep -Ec '(^|[[:space:]])server[[:space:]]*\{' || true)
  if [ "$server_count" -ne 1 ]; then
    fitgrid_error "所选 nginx vhost 必须恰好包含一个 server 块"
    return 1
  fi
  if ! awk -v wanted="$domain" '
    { sub(/#.*/, "") }
    $1 == "server_name" {
      for (field = 2; field <= NF; field++) {
        value = $field; sub(/;$/, "", value); if (value == wanted) found = 1
      }
    }
    END { exit(found ? 0 : 1) }
  ' "$site"; then
    fitgrid_error "所选 vhost 的 server_name 不包含 $domain"
    return 1
  fi
  if ! sed 's/#.*$//' "$site" | grep -Eq "^[[:space:]]*listen[[:space:]]+([^;[:space:]]*:)?${public_port}([[:space:]]|;).*ssl"; then
    fitgrid_error "所选 vhost 未监听 HTTPS 端口 $public_port"
    return 1
  fi
}

render_nginx_snippet() {
  app_port=$1
  case $app_port in ""|*[!0-9]*) fitgrid_error "应用端口无效"; return 1 ;; esac
  cat <<EOF
location = /fitgrid {
    return 308 /fitgrid/;
}

location ^~ /fitgrid/ {
    proxy_pass http://127.0.0.1:${app_port};
    proxy_http_version 1.1;
    proxy_set_header Host \$http_host;
    proxy_set_header X-Forwarded-Host \$http_host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_connect_timeout 10s;
    proxy_read_timeout 60s;
    proxy_send_timeout 60s;
    client_max_body_size 10m;
}
EOF
}

portable_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

install_nginx_include() {
  site=$1
  desired_snippet=$2
  backup_directory=$3
  managed_snippet=${FITGRID_NGINX_SNIPPET_PATH:-/etc/nginx/snippets/fitgridweb-location.conf}
  backup_id=${FITGRID_BACKUP_ID:-$(date -u +%Y%m%dT%H%M%SZ)}
  marker='# fitgridweb-managed'
  include="include $managed_snippet; $marker"

  [ -f "$site" ] || { fitgrid_error "nginx vhost 不存在：$site"; return 1; }
  [ -f "$desired_snippet" ] || { fitgrid_error "待安装 nginx snippet 不存在"; return 1; }
  mkdir -p "$backup_directory" "$(dirname "$managed_snippet")"
  site_backup=$backup_directory/$(basename "$site").$backup_id.bak
  snippet_backup=$backup_directory/$(basename "$managed_snippet").$backup_id.bak
  cp -p "$site" "$site_backup"
  snippet_existed=false
  if [ -f "$managed_snippet" ]; then
    cp -p "$managed_snippet" "$snippet_backup"
    snippet_existed=true
  fi

  snippet_temp=$(mktemp "${managed_snippet}.tmp.XXXXXX")
  cp "$desired_snippet" "$snippet_temp"
  chmod 644 "$snippet_temp"
  mv "$snippet_temp" "$managed_snippet"

  if ! grep -Fq "$marker" "$site"; then
    site_temp=$(mktemp "${site}.tmp.XXXXXX")
    awk -v managed_include="$include" '
      {
        lines[NR] = $0
        code = $0; sub(/#.*/, "", code)
        if (!inside && code ~ /(^|[[:space:]])server[[:space:]]*\{/) {
          inside = 1; server_depth = depth + 1
        }
        open_code = code; close_code = code
        opens = gsub(/\{/, "", open_code); closes = gsub(/\}/, "", close_code)
        depth += opens - closes
        if (inside && depth < server_depth) { closing = NR; inside = 0 }
      }
      END {
        if (!closing) exit 2
        for (line = 1; line <= NR; line++) {
          if (line == closing) print "    " managed_include
          print lines[line]
        }
      }
    ' "$site" >"$site_temp" || {
      rm -f "$site_temp"
      cp -p "$site_backup" "$site"
      if [ "$snippet_existed" = true ]; then cp -p "$snippet_backup" "$managed_snippet"; else rm -f "$managed_snippet"; fi
      fitgrid_error "无法定位 nginx server 块的结束位置"
      return 1
    }
    chmod "$(portable_mode "$site")" "$site_temp"
    mv "$site_temp" "$site"
  fi

  if ! nginx -t; then
    cp -p "$site_backup" "$site"
    if [ "$snippet_existed" = true ]; then
      cp -p "$snippet_backup" "$managed_snippet"
    else
      rm -f "$managed_snippet"
    fi
    fitgrid_error "nginx -t 失败，已恢复原文件"
    return 1
  fi
  if ! systemctl reload nginx; then
    cp -p "$site_backup" "$site"
    if [ "$snippet_existed" = true ]; then
      cp -p "$snippet_backup" "$managed_snippet"
    else
      rm -f "$managed_snippet"
    fi
    nginx -t >/dev/null 2>&1 || true
    fitgrid_error "nginx reload 失败，已恢复受管文件；运行中的旧配置未被替换"
    return 1
  fi
}
