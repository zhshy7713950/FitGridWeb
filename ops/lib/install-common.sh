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

resolve_ref() {
  repository=$1
  git_ref=$2
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
  else
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
  fi
  fitgrid_error "镜像无法匿名读取：$image；请确认 GitHub Actions 已完成且 GHCR package 已设为 Public"
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
    printf 'LOG_LEVEL=info\n'
    printf 'BACKUP_DIR=/var/lib/fitgridweb/backups\n'
    printf 'BACKUP_REMOTE_DIR=/mnt/fitgridweb-offsite\n'
    printf 'BACKUP_ENCRYPTION_KEY_FILE=%s\n' "$backup_key_file"
    printf 'BACKUP_RETENTION_DAYS=180\n'
  } >"$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$environment_file"
}
