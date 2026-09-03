#!/bin/sh

if ! command -v fitgrid_error >/dev/null 2>&1; then
  fitgrid_error() { printf '错误：%s\n' "$*" >&2; }
fi

FITGRID_NGINX_INSTALLER_PROTOCOL=2

nginx_tcp_port_available() {
  port=$1
  case $port in ""|*[!0-9]*) fitgrid_error "HTTPS 端口必须是数字"; return 1 ;; esac
  if ss -ltnH 2>/dev/null | awk '{ print $4 }' | grep -Eq "(^|:)$port$"; then
    return 1
  fi
}

resolve_nginx_public_port() {
  site=$1
  domain=$2
  candidate=$3

  if [ -f "$site" ] && validate_nginx_site "$site" "$domain" "$candidate" >/dev/null 2>&1; then
    printf '%s\n' "$candidate"
    return 0
  fi
  if nginx_tcp_port_available "$candidate"; then
    printf '%s\n' "$candidate"
    return 0
  fi
  fitgrid_error "HTTPS TCP 端口 $candidate 已被其他服务占用"
  return 1
}

choose_nginx_public_port() {
  site=$1
  domain=$2
  preferred=${3:-443}

  if resolved=$(resolve_nginx_public_port "$site" "$domain" "$preferred"); then
    printf '%s\n' "$resolved"
    return 0
  fi

  suggested=8443
  while :; do
    candidate=$(prompt_value "端口 $preferred 已占用，请填写 FitGrid 公网 HTTPS 端口" "$suggested")
    case $candidate in
      ""|*[!0-9]*) fitgrid_error "HTTPS 端口必须是数字"; continue ;;
    esac
    if [ "$candidate" -lt 1 ] || [ "$candidate" -gt 65535 ]; then
      fitgrid_error "HTTPS 端口必须在 1–65535 之间"
      continue
    fi
    if resolved=$(resolve_nginx_public_port "$site" "$domain" "$candidate"); then
      printf '%s\n' "$resolved"
      return 0
    fi
    suggested=$((candidate + 1))
    [ "$suggested" -le 65535 ] || suggested=8443
  done
}

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

discover_nginx_tls_pair() {
  domain=$1
  dump=$(mktemp)
  if ! nginx -T >"$dump" 2>&1; then
    rm -f "$dump"
    fitgrid_error "无法读取当前 nginx 配置"
    return 1
  fi

  pairs=$(awk -v wanted="$domain" '
    function trim(value) {
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      return value
    }
    function inspect(block, normalized, count, statements, idx, statement, fields, field, matched, certificate, key) {
      normalized = block
      gsub(/[{}]/, ";", normalized)
      count = split(normalized, statements, ";")
      matched = 0
      certificate = ""
      key = ""
      for (idx = 1; idx <= count; idx++) {
        statement = trim(statements[idx])
        if (statement == "") continue
        split(statement, fields, /[[:space:]]+/)
        if (fields[1] == "server_name") {
          for (field = 2; fields[field] != ""; field++) {
            if (fields[field] == wanted) matched = 1
          }
        } else if (fields[1] == "ssl_certificate") {
          certificate = fields[2]
        } else if (fields[1] == "ssl_certificate_key") {
          key = fields[2]
        }
      }
      if (matched && certificate != "" && key != "") print certificate "\t" key
    }
    {
      code = $0
      sub(/#.*/, "", code)
      if (!inside && code ~ /(^|[[:space:]])server[[:space:]]*\{/) {
        inside = 1
        depth = 0
        block = ""
      }
      if (inside) {
        block = block "\n" code
        braces = code
        opens = gsub(/\{/, "", braces)
        braces = code
        closes = gsub(/\}/, "", braces)
        depth += opens - closes
        if (depth == 0) {
          inspect(block)
          inside = 0
          block = ""
        }
      }
    }
  ' "$dump" | sort -u)
  rm -f "$dump"

  pair_count=$(printf '%s\n' "$pairs" | awk 'NF { count++ } END { print count + 0 }')
  if [ "$pair_count" -eq 0 ]; then
    fitgrid_error "未在当前 nginx 配置中找到域名 $domain 的 TLS 证书"
    return 1
  fi
  if [ "$pair_count" -ne 1 ]; then
    fitgrid_error "域名 $domain 使用了多组 TLS 证书，无法安全自动选择"
    return 1
  fi
  printf '%s\n' "$pairs"
}

render_dedicated_nginx_site() {
  domain=$1
  public_port=$2
  certificate=$3
  certificate_key=$4
  cat <<EOF
# fitgridweb-vhost-managed
server {
    listen ${public_port} ssl;
    server_name ${domain};

    ssl_certificate ${certificate};
    ssl_certificate_key ${certificate_key};

    location / {
        return 404;
    }
}
EOF
}

validate_local_nginx_https_endpoint() {
  domain=$1
  public_port=$2
  suffix=
  [ "$public_port" -eq 443 ] || suffix=":$public_port"
  curl --silent --show-error --output /dev/null --max-time 10 \
    --resolve "$domain:$public_port:127.0.0.1" "https://$domain$suffix/" \
    || { fitgrid_error "新 nginx vhost 未能在本机通过 HTTPS/TLS 验证"; return 1; }
}

validate_public_nginx_https_endpoint() {
  domain=$1
  public_port=$2
  suffix=
  [ "$public_port" -eq 443 ] || suffix=":$public_port"
  curl --silent --show-error --output /dev/null --max-time 10 "https://$domain$suffix/" \
    || { fitgrid_error "公网 HTTPS 地址无法连接：https://$domain$suffix/"; return 1; }
}

rollback_new_dedicated_nginx_site() {
  site=$1
  rm -f "$site"
  if ! nginx -t; then
    fitgrid_error "移除新 vhost 后 nginx -t 仍失败，请立即人工检查"
    return 1
  fi
  if ! systemctl reload nginx; then
    fitgrid_error "移除新 vhost 后 nginx reload 失败，请立即人工检查"
    return 1
  fi
}

prepare_dedicated_nginx_site() {
  site=$1
  domain=$2
  public_port=$3

  if [ -e "$site" ]; then
    [ -f "$site" ] || { fitgrid_error "nginx vhost 不是普通文件：$site"; return 1; }
    validate_nginx_site "$site" "$domain" "$public_port" \
      || { fitgrid_error "已存在的专用 vhost 与本次域名或端口不匹配，拒绝覆盖：$site"; return 1; }
    validate_local_nginx_https_endpoint "$domain" "$public_port" || return 1
    validate_public_nginx_https_endpoint "$domain" "$public_port" || return 1
    return 0
  fi

  nginx_tcp_port_available "$public_port" \
    || { fitgrid_error "HTTPS TCP 端口 $public_port 在配置期间被其他服务占用"; return 1; }

  tls_pair=$(discover_nginx_tls_pair "$domain") || return 1
  certificate=$(printf '%s\n' "$tls_pair" | awk -F '\t' 'NR == 1 { print $1 }')
  certificate_key=$(printf '%s\n' "$tls_pair" | awk -F '\t' 'NR == 1 { print $2 }')
  case $certificate in /*) : ;; *) fitgrid_error "TLS 证书路径不是绝对路径"; return 1 ;; esac
  case $certificate_key in /*) : ;; *) fitgrid_error "TLS 私钥路径不是绝对路径"; return 1 ;; esac
  [ -f "$certificate" ] || { fitgrid_error "TLS 证书文件不存在：$certificate"; return 1; }
  [ -f "$certificate_key" ] || { fitgrid_error "TLS 私钥文件不存在：$certificate_key"; return 1; }
  [ -d "$(dirname "$site")" ] || { fitgrid_error "nginx vhost 目录不存在：$(dirname "$site")"; return 1; }

  site_temp=$(mktemp "${site}.tmp.XXXXXX")
  render_dedicated_nginx_site "$domain" "$public_port" "$certificate" "$certificate_key" >"$site_temp"
  chmod 644 "$site_temp"
  mv "$site_temp" "$site"

  if ! nginx -t; then
    rm -f "$site"
    fitgrid_error "nginx -t 失败，已移除新建的 FitGrid vhost"
    return 1
  fi
  if ! systemctl reload nginx; then
    rm -f "$site"
    nginx -t >/dev/null 2>&1 || true
    fitgrid_error "nginx reload 失败，已移除新建的 FitGrid vhost；运行中的旧配置未改变"
    return 1
  fi
  if ! validate_local_nginx_https_endpoint "$domain" "$public_port"; then
    rollback_new_dedicated_nginx_site "$site" || true
    return 1
  fi
  if ! validate_public_nginx_https_endpoint "$domain" "$public_port"; then
    rollback_new_dedicated_nginx_site "$site" || true
    return 1
  fi
}

render_proxy_location() {
  qualifier=$1
  path=$2
  app_port=$3
  upload_mebibytes=$4
  cat <<EOF
location ${qualifier} ${path} {
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
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
    client_max_body_size ${upload_mebibytes}m;
}
EOF
}

render_nginx_snippet() {
  app_port=$1
  upload_max_bytes=${2:-536870912}
  case $app_port in ""|*[!0-9]*) fitgrid_error "应用端口无效"; return 1 ;; esac
  case $upload_max_bytes in ""|*[!0-9]*) fitgrid_error "上传字节上限无效"; return 1 ;; esac
  upload_mebibytes=$(awk -v bytes="$upload_max_bytes" 'BEGIN {
    if (bytes + 0 <= 0) exit 1
    printf "%.0f", int((bytes + 1048575) / 1048576)
  }') || { fitgrid_error "上传字节上限无效"; return 1; }
  render_proxy_location = /fitgrid "$app_port" "$upload_mebibytes"
  printf '\n'
  render_proxy_location '^~' /fitgrid/ "$app_port" "$upload_mebibytes"
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
