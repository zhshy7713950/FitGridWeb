#!/bin/sh

fitgrid_error() {
  printf '错误：%s\n' "$*" >&2
}

require_root() {
  if [ "$(id -u)" -ne 0 ] && [ "${FITGRID_ALLOW_NON_ROOT:-0}" != "1" ]; then
    fitgrid_error "请使用 sudo 运行安装脚本"
    return 1
  fi
}

validate_host() {
  release_file=${1:-/etc/os-release}
  meminfo_file=${2:-/proc/meminfo}
  disk_path=${3:-/}
  architecture=${4:-$(uname -m)}

  os_id=$(awk -F= '$1 == "ID" { gsub(/"/, "", $2); print $2; exit }' "$release_file")
  os_version=$(awk -F= '$1 == "VERSION_ID" { gsub(/"/, "", $2); print $2; exit }' "$release_file")
  if [ "$os_id" != "ubuntu" ] || [ "$os_version" != "24.04" ]; then
    fitgrid_error "仅支持 Ubuntu 24.04 LTS"
    return 1
  fi
  if [ "$architecture" != "x86_64" ] && [ "$architecture" != "amd64" ]; then
    fitgrid_error "仅支持 x86_64/amd64"
    return 1
  fi

  memory_kb=$(awk '/^MemTotal:/ { print $2; exit }' "$meminfo_file")
  if [ -z "$memory_kb" ] || [ "$memory_kb" -lt 1572864 ]; then
    fitgrid_error "至少需要 1.5 GiB RAM"
    return 1
  fi

  available_kb=$(df -Pk "$disk_path" | awk 'NR == 2 { print $4 }')
  if [ -z "$available_kb" ] || [ "$available_kb" -lt 8388608 ]; then
    fitgrid_error "至少需要 8 GiB 可用磁盘空间"
    return 1
  fi
}

validate_disk_pressure() {
  disk_path=${1:-/}
  used_percent=$(df -Pk "$disk_path" | awk 'NR == 2 { value=$5; gsub(/%/, "", value); print value }')
  case $used_percent in ""|*[!0-9]*) fitgrid_error "无法读取磁盘使用率"; return 1 ;; esac
  if [ "$used_percent" -ge 85 ]; then
    fitgrid_error "磁盘使用率 ${used_percent}% 已达到 85% 停止线"
    return 1
  fi
  if [ "$used_percent" -ge 70 ]; then
    printf '警告：磁盘使用率已达到 %s%%；请安排清理或扩容。\n' "$used_percent" >&2
  fi
}

validate_https_endpoint() {
  domain=$1
  public_port=$2
  suffix=
  [ "$public_port" -eq 443 ] || suffix=":$public_port"
  if ! curl --silent --show-error --output /dev/null --max-time 10 "https://$domain$suffix/"; then
    fitgrid_error "现有 nginx HTTPS 地址无法连接：https://$domain$suffix/"
    return 1
  fi
}

validate_domain() {
  case ${1:-} in
    ""|*://*|*/*|*:*|*[!A-Za-z0-9.-]*)
      fitgrid_error "域名格式无效；不要包含协议、端口或路径"
      return 1
      ;;
  esac
}

validate_port() {
  port=${1:-}
  minimum=${2:-1}
  case $port in
    ""|*[!0-9]*) fitgrid_error "端口必须是数字"; return 1 ;;
  esac
  if [ "$port" -lt "$minimum" ] || [ "$port" -gt 65535 ]; then
    fitgrid_error "端口必须在 ${minimum}–65535 之间"
    return 1
  fi
}

validate_distinct_ports() {
  public_port=$1
  app_port=$2
  [ "$public_port" -ne "$app_port" ] \
    || { fitgrid_error "公网 HTTPS 端口不能与 FitGrid 本地应用端口相同"; return 1; }
}

resolve_ref() {
  repository=$1
  git_ref=$2
  case $git_ref in
    [a-fA-F0-9][a-fA-F0-9][a-fA-F0-9][a-fA-F0-9][a-fA-F0-9][a-fA-F0-9][a-fA-F0-9][a-fA-F0-9]*)
      if [ "${#git_ref}" -eq 40 ]; then
        requested_sha=$(printf '%s' "$git_ref" | tr 'A-F' 'a-f')
        api_sha=$(curl -fsSL "https://api.github.com/repos/zhshy7713950/FitGridWeb/commits/$requested_sha" 2>/dev/null \
          | sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([a-fA-F0-9]\{40\}\)".*/\1/p' | head -n 1 || true)
        api_sha=$(printf '%s' "$api_sha" | tr 'A-F' 'a-f')
        if [ "$api_sha" = "$requested_sha" ]; then
          printf '%s\n' "$requested_sha"
          return 0
        fi
        fitgrid_error "完整 commit SHA 不存在于公开仓库"
        return 1
      fi
      ;;
  esac
  if command -v git >/dev/null 2>&1; then
    refs=$(git ls-remote "$repository" "$git_ref" "$git_ref^{}" 2>/dev/null) || {
      fitgrid_error "无法解析 Git ref：$git_ref"
      return 1
    }
    sha=$(printf '%s\n' "$refs" | awk '/\^\{\}$/ { selected=$1 } !selected && NF { first=$1 } END { print selected ? selected : first }')
  else
    case $git_ref in ""|*[!A-Za-z0-9._/-]*) fitgrid_error "Git ref 格式无效"; return 1 ;; esac
    sha=$(curl -fsSL "https://api.github.com/repos/zhshy7713950/FitGridWeb/commits/$git_ref" \
      | sed -n 's/^[[:space:]]*"sha": "\([a-fA-F0-9]\{40\}\)",$/\1/p' | head -n 1)
  fi
  case $sha in
    ""|*[!a-fA-F0-9]*) fitgrid_error "Git ref 未解析为完整 commit SHA"; return 1 ;;
  esac
  if [ "${#sha}" -ne 40 ]; then
    fitgrid_error "Git ref 未解析为完整 commit SHA"
    return 1
  fi
  printf '%s\n' "$(printf '%s' "$sha" | tr 'A-F' 'a-f')"
}

image_for_sha() {
  printf 'ghcr.io/zhshy7713950/fitgridweb:sha-%s\n' "$1"
}

assert_public_image() {
  image=$1
  if command -v docker >/dev/null 2>&1; then
    docker manifest inspect "$image" >/dev/null 2>&1 && return 0
  fi
  repository=${image#ghcr.io/}
  tag=${repository##*:}
  repository=${repository%:*}
  token=$(curl -fsSL "https://ghcr.io/token?service=ghcr.io&scope=repository:$repository:pull" \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p') || token=
  if [ -n "$token" ] && curl -fsSI \
    -H "Authorization: Bearer $token" \
    -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json" \
    "https://ghcr.io/v2/$repository/manifests/$tag" >/dev/null 2>&1; then
    return 0
  fi
  fitgrid_error "镜像无法匿名读取：$image；请检查 https://github.com/zhshy7713950/FitGridWeb/actions 并确认 GHCR package 已设为 Public"
  return 1
}

assert_app_port_available() {
  port=$1
  if ! ss -ltnH 2>/dev/null | awk '{ print $4 }' | grep -Eq "(^|:)$port$"; then
    return 0
  fi
  owner=$(docker ps --filter "publish=127.0.0.1:$port" --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null | head -n 1 || true)
  if [ "$owner" = "fitgridweb" ]; then
    return 0
  fi
  fitgrid_error "本地端口 $port 已被非 FitGrid 服务占用"
  return 1
}

ensure_checkout() {
  repository=$1
  sha=$2
  target=$3
  parent=$(dirname "$target")
  mkdir -p "$parent"
  if [ ! -d "$target/.git" ]; then
    git clone --filter=blob:none --no-checkout "$repository" "$target"
  fi
  git -C "$target" fetch --depth 1 origin "$sha"
  git -C "$target" checkout --detach --force "$sha"
  checked_out=$(git -C "$target" rev-parse HEAD)
  if [ "$checked_out" != "$sha" ]; then
    fitgrid_error "检出的代码与镜像 commit 不一致"
    return 1
  fi
}

environment_value() {
  key=$1
  file=$2
  [ -f "$file" ] || return 0
  awk -F= -v wanted="$key" '$1 == wanted { sub(/^[^=]*=/, ""); print; exit }' "$file"
}

validate_upgrade_invariants() {
  environment_file=$1
  domain=$2
  app_port=$3
  public_port=$4
  nginx_site=$5
  [ -f "$environment_file" ] || return 0

  saved_domain=$(environment_value DOMAIN "$environment_file")
  saved_app_port=$(environment_value APP_PORT "$environment_file")
  saved_public_port=$(environment_value PUBLIC_HTTPS_PORT "$environment_file")
  saved_nginx_site=$(environment_value NGINX_SITE "$environment_file")
  if [ "$domain" != "$saved_domain" ] || [ "$app_port" != "$saved_app_port" ] \
    || [ "$public_port" != "$saved_public_port" ] || [ "$nginx_site" != "$saved_nginx_site" ]; then
    fitgrid_error "--upgrade 只允许更换应用版本；域名、端口或 nginx vhost 变更需单独维护窗口"
    return 1
  fi
}

secret_or_new() {
  key=$1
  file=$2
  value=$(environment_value "$key" "$file")
  case $value in
    [a-fA-F0-9][a-fA-F0-9][a-fA-F0-9][a-fA-F0-9][a-fA-F0-9][a-fA-F0-9][a-fA-F0-9][a-fA-F0-9]*)
      if [ "${#value}" -eq 64 ]; then printf '%s\n' "$value"; return 0; fi
      ;;
  esac
  openssl rand -hex 32
}

ensure_environment() {
  environment_file=$1
  backup_key_file=$2
  domain=$3
  app_port=$4
  public_port=$5
  sha=$6
  nginx_site=${7:-}

  validate_domain "$domain"
  validate_port "$app_port" 1024
  validate_port "$public_port" 1

  environment_directory=$(dirname "$environment_file")
  key_directory=$(dirname "$backup_key_file")
  umask 077
  mkdir -p "$environment_directory" "$key_directory"
  chmod 700 "$environment_directory" "$key_directory"

  postgres_password=$(secret_or_new POSTGRES_PASSWORD "$environment_file")
  app_database_password=$(secret_or_new APP_DATABASE_PASSWORD "$environment_file")
  auth_secret=$(secret_or_new BETTER_AUTH_SECRET "$environment_file")
  owner_secret=$(secret_or_new OWNER_REF_SECRET "$environment_file")
  cursor_secret=$(secret_or_new CURSOR_SIGNING_SECRET "$environment_file")

  log_level=$(environment_value LOG_LEVEL "$environment_file")
  case $log_level in debug|info|warn|error) : ;; *) log_level=info ;; esac
  backup_directory=$(environment_value BACKUP_DIR "$environment_file")
  case $backup_directory in /*) : ;; *) backup_directory=/var/lib/fitgridweb/backups ;; esac
  case $backup_directory in *[[:space:]]*) backup_directory=/var/lib/fitgridweb/backups ;; esac
  backup_remote_directory=$(environment_value BACKUP_REMOTE_DIR "$environment_file")
  case $backup_remote_directory in ""|/*) : ;; *) backup_remote_directory= ;; esac
  case $backup_remote_directory in *[[:space:]]*) backup_remote_directory= ;; esac
  retention_days=$(environment_value BACKUP_RETENTION_DAYS "$environment_file")
  case $retention_days in ""|*[!0-9]*) retention_days=180 ;; esac
  if [ "$retention_days" -lt 1 ] || [ "$retention_days" -gt 3650 ]; then retention_days=180; fi

  if [ ! -s "$backup_key_file" ]; then
    backup_key_temp=$(mktemp "${backup_key_file}.tmp.XXXXXX")
    openssl rand -hex 32 >"$backup_key_temp"
    chmod 600 "$backup_key_temp"
    mv "$backup_key_temp" "$backup_key_file"
  fi

  public_suffix=
  if [ "$public_port" -ne 443 ]; then
    public_suffix=":$public_port"
  fi
  image=$(image_for_sha "$sha")
  temporary=$(mktemp "${environment_file}.tmp.XXXXXX")
  {
    printf 'DOMAIN=%s\n' "$domain"
    printf 'APP_BASE_PATH=/fitgrid\n'
    printf 'APP_PORT=%s\n' "$app_port"
    printf 'PUBLIC_HTTPS_PORT=%s\n' "$public_port"
    printf 'PUBLIC_PORT_SUFFIX=%s\n' "$public_suffix"
    printf 'BETTER_AUTH_URL=https://%s%s/fitgrid\n' "$domain" "$public_suffix"
    [ -z "$nginx_site" ] || printf 'NGINX_SITE=%s\n' "$nginx_site"
    printf 'APP_IMAGE=%s\n' "$image"
    printf 'POSTGRES_DB=fitgridweb\n'
    printf 'POSTGRES_USER=fitgrid_migrate\n'
    printf 'POSTGRES_PASSWORD=%s\n' "$postgres_password"
    printf 'APP_DATABASE_USER=fitgrid_app\n'
    printf 'APP_DATABASE_PASSWORD=%s\n' "$app_database_password"
    printf 'DATABASE_URL=postgresql://fitgrid_app:%s@db:5432/fitgridweb\n' "$app_database_password"
    printf 'MIGRATION_DATABASE_URL=postgresql://fitgrid_migrate:%s@db:5432/fitgridweb\n' "$postgres_password"
    printf 'BETTER_AUTH_SECRET=%s\n' "$auth_secret"
    printf 'OWNER_REF_SECRET=%s\n' "$owner_secret"
    printf 'CURSOR_SIGNING_SECRET=%s\n' "$cursor_secret"
    printf 'LOG_LEVEL=%s\n' "$log_level"
    printf 'BACKUP_DIR=%s\n' "$backup_directory"
    printf 'BACKUP_REMOTE_DIR=%s\n' "$backup_remote_directory"
    printf 'BACKUP_ENCRYPTION_KEY_FILE=%s\n' "$backup_key_file"
    printf 'BACKUP_RETENTION_DAYS=%s\n' "$retention_days"
  } >"$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$environment_file"
}
