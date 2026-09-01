#!/bin/sh
set -eu

REPOSITORY_URL=https://github.com/zhshy7713950/FitGridWeb.git
RAW_ROOT=https://raw.githubusercontent.com/zhshy7713950/FitGridWeb
INSTALL_DIRECTORY=/opt/fitgridweb
ENVIRONMENT_FILE=/etc/fitgridweb/fitgridweb.env
BACKUP_KEY_FILE=/etc/fitgridweb/backup.key

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
temporary_bootstrap=

# Keep the standalone, pre-resolution bootstrap self-contained. A downloaded
# installer must not source mutable code from main while running as root.
fitgrid_error() { printf '错误：%s\n' "$*" >&2; }
require_root() {
  [ "$(id -u)" -eq 0 ] || { fitgrid_error "请使用 sudo 运行安装脚本"; return 1; }
}
bootstrap_environment_value() {
  key=$1
  file=$2
  [ -f "$file" ] || return 0
  awk -F= -v wanted="$key" '$1 == wanted { sub(/^[^=]*=/, ""); print; exit }' "$file"
}
environment_value() { bootstrap_environment_value "$@"; }
validate_host() {
  release_file=${1:-/etc/os-release}
  meminfo_file=${2:-/proc/meminfo}
  disk_path=${3:-/}
  architecture=${4:-$(uname -m)}
  os_id=$(awk -F= '$1 == "ID" { gsub(/"/, "", $2); print $2; exit }' "$release_file")
  os_version=$(awk -F= '$1 == "VERSION_ID" { gsub(/"/, "", $2); print $2; exit }' "$release_file")
  [ "$os_id" = ubuntu ] && [ "$os_version" = 24.04 ] \
    || { fitgrid_error "仅支持 Ubuntu 24.04 LTS"; return 1; }
  [ "$architecture" = x86_64 ] || [ "$architecture" = amd64 ] \
    || { fitgrid_error "仅支持 x86_64/amd64"; return 1; }
  memory_kb=$(awk '/^MemTotal:/ { print $2; exit }' "$meminfo_file")
  [ -n "$memory_kb" ] && [ "$memory_kb" -ge 1572864 ] \
    || { fitgrid_error "至少需要 1.5 GiB RAM"; return 1; }
  available_kb=$(df -Pk "$disk_path" | awk 'NR == 2 { print $4 }')
  [ -n "$available_kb" ] && [ "$available_kb" -ge 8388608 ] \
    || { fitgrid_error "至少需要 8 GiB 可用磁盘空间"; return 1; }
}
validate_disk_pressure() {
  used_percent=$(df -Pk "${1:-/}" | awk 'NR == 2 { value=$5; gsub(/%/, "", value); print value }')
  case $used_percent in ""|*[!0-9]*) fitgrid_error "无法读取磁盘使用率"; return 1 ;; esac
  [ "$used_percent" -lt 85 ] || { fitgrid_error "磁盘使用率 ${used_percent}% 已达到 85% 停止线"; return 1; }
  [ "$used_percent" -lt 70 ] || printf '警告：磁盘使用率已达到 %s%%；请安排清理或扩容。\n' "$used_percent" >&2
}
validate_domain() {
  case ${1:-} in ""|*://*|*/*|*:*|*[!A-Za-z0-9.-]*) fitgrid_error "域名格式无效"; return 1 ;; esac
}
validate_port() {
  port=${1:-}; minimum=${2:-1}
  case $port in ""|*[!0-9]*) fitgrid_error "端口必须是数字"; return 1 ;; esac
  [ "$port" -ge "$minimum" ] && [ "$port" -le 65535 ] \
    || { fitgrid_error "端口必须在 ${minimum}–65535 之间"; return 1; }
}
validate_distinct_ports() {
  public_port=$1; app_port=$2
  [ "$public_port" -ne "$app_port" ] \
    || { fitgrid_error "公网 HTTPS 端口不能与 FitGrid 本地应用端口相同"; return 1; }
}
validate_upgrade_invariants() {
  environment_file=$1; domain=$2; app_port=$3; public_port=$4; nginx_site=$5
  [ -f "$environment_file" ] || return 0
  [ "$domain" = "$(bootstrap_environment_value DOMAIN "$environment_file")" ] \
    && [ "$app_port" = "$(bootstrap_environment_value APP_PORT "$environment_file")" ] \
    && [ "$public_port" = "$(bootstrap_environment_value PUBLIC_HTTPS_PORT "$environment_file")" ] \
    && [ "$nginx_site" = "$(bootstrap_environment_value NGINX_SITE "$environment_file")" ] \
    || { fitgrid_error "--upgrade 不允许同时更换域名、端口或 nginx vhost"; return 1; }
}
assert_app_port_available() {
  port=$1
  ss -ltnH 2>/dev/null | awk '{ print $4 }' | grep -Eq "(^|:)$port$" || return 0
  owner=$(docker ps --filter "publish=$port" --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null \
    | awk '$0 == "fitgridweb" { print; exit }' || true)
  [ "$owner" = fitgridweb ] || { fitgrid_error "本地端口 $port 已被非 FitGrid 服务占用"; return 1; }
}
choose_app_port() {
  candidate=$1
  while :; do
    if validate_port "$candidate" 1024 && assert_app_port_available "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
    candidate=$(prompt_value "请重新输入 FitGrid 本地回环端口" "$candidate")
  done
}
resolve_ref() {
  git_ref=$2
  case $git_ref in ""|*[!A-Za-z0-9._/-]*) fitgrid_error "Git ref 格式无效"; return 1 ;; esac
  sha=$(curl -fsSL "https://api.github.com/repos/zhshy7713950/FitGridWeb/commits/$git_ref" 2>/dev/null \
    | sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([a-fA-F0-9]\{40\}\)".*/\1/p' | head -n 1 || true)
  case $sha in ""|*[!a-fA-F0-9]*) fitgrid_error "无法解析公开 Git ref：$git_ref"; return 1 ;; esac
  [ "${#sha}" -eq 40 ] || { fitgrid_error "Git ref 未解析为完整 commit SHA"; return 1; }
  printf '%s\n' "$(printf '%s' "$sha" | tr 'A-F' 'a-f')"
}
image_for_sha() { printf 'ghcr.io/zhshy7713950/fitgridweb:sha-%s\n' "$1"; }
assert_public_image() {
  image=$1; repository=${image#ghcr.io/}; tag=${repository##*:}; repository=${repository%:*}
  token=$(curl -fsSL "https://ghcr.io/token?service=ghcr.io&scope=repository:$repository:pull" \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p' || true)
  [ -n "$token" ] && curl -fsSI -H "Authorization: Bearer $token" \
    -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json" \
    "https://ghcr.io/v2/$repository/manifests/$tag" >/dev/null 2>&1 \
    || { fitgrid_error "镜像无法匿名读取：$image；请检查 https://github.com/zhshy7713950/FitGridWeb/actions 并确认 GHCR package 已设为 Public"; return 1; }
}
validate_https_endpoint() {
  suffix=; [ "$2" -eq 443 ] || suffix=":$2"
  curl --silent --show-error --output /dev/null --max-time 10 "https://$1$suffix/" \
    || { fitgrid_error "现有 nginx HTTPS 地址无法连接"; return 1; }
}

if [ -f "$script_directory/lib/install-common.sh" ]; then
  common_library=$script_directory/lib/install-common.sh
  # An installed copy is pinned to the current release and is safe to use for
  # collecting input. The selected release library is sourced again below.
  # shellcheck disable=SC1090
  . "$common_library"
fi

from_installed=false
upgrade=false
git_ref=main
domain=
app_port=3300
public_port=443
nginx_site=/etc/nginx/conf.d/fitgridweb.conf
swap_choice=yes
admin_choice=

while [ "$#" -gt 0 ]; do
  case $1 in
    --from-installed) from_installed=true; shift ;;
    --upgrade) upgrade=true; shift ;;
    --ref) git_ref=$2; shift 2 ;;
    --domain) domain=$2; shift 2 ;;
    --app-port) app_port=$2; shift 2 ;;
    --public-port) public_port=$2; shift 2 ;;
    --nginx-site) nginx_site=$2; shift 2 ;;
    --swap) swap_choice=$2; shift 2 ;;
    --create-admin) admin_choice=$2; shift 2 ;;
    *) fitgrid_error "未知参数：$1"; exit 1 ;;
  esac
done

if [ -z "$admin_choice" ]; then
  if [ "$upgrade" = true ]; then admin_choice=no; else admin_choice=yes; fi
fi

if [ "$from_installed" = false ] && [ -f "$ENVIRONMENT_FILE" ]; then
  saved_domain=$(environment_value DOMAIN "$ENVIRONMENT_FILE")
  saved_app_port=$(environment_value APP_PORT "$ENVIRONMENT_FILE")
  saved_public_port=$(environment_value PUBLIC_HTTPS_PORT "$ENVIRONMENT_FILE")
  saved_nginx_site=$(environment_value NGINX_SITE "$ENVIRONMENT_FILE")
  saved_image=$(environment_value APP_IMAGE "$ENVIRONMENT_FILE")
  [ -z "$saved_domain" ] || domain=$saved_domain
  [ -z "$saved_app_port" ] || app_port=$saved_app_port
  [ -z "$saved_public_port" ] || public_port=$saved_public_port
  [ -z "$saved_nginx_site" ] || nginx_site=$saved_nginx_site
  case $saved_image in *:sha-????????????????????????????????????????) git_ref=${saved_image##*:sha-} ;; esac
fi

prompt_value() {
  label=$1
  default_value=$2
  printf '%s [%s]: ' "$label" "$default_value" >&2
  IFS= read -r entered
  printf '%s\n' "${entered:-$default_value}"
}

prompt_yes_no() {
  label=$1
  default_value=$2
  while :; do
    answer=$(prompt_value "$label (yes/no)" "$default_value")
    case $answer in yes|no) printf '%s\n' "$answer"; return 0 ;; esac
    fitgrid_error "请输入 yes 或 no"
  done
}

require_root
validate_host /etc/os-release /proc/meminfo /

if [ "$from_installed" = false ]; then
  printf '\nFitGridWeb 低内存生产安装器（固定路径 /fitgrid）\n' >&2
  domain=$(prompt_value "现有 nginx HTTPS 域名（不含协议和路径）" "${domain:-grid.example.com}")
  app_port=$(prompt_value "FitGrid 本地回环端口" "$app_port")
  app_port=$(choose_app_port "$app_port")
  git_ref=$(prompt_value "要部署的公开 Git ref" "$git_ref")
  swap_choice=$(prompt_yes_no "总 Swap 不足 2 GiB 时补足" "$swap_choice")
  admin_choice=$(prompt_yes_no "部署成功后创建首个管理员" "$admin_choice")

  validate_domain "$domain"
  case $nginx_site in /*) : ;; *) fitgrid_error "nginx vhost 必须是绝对路径"; exit 1 ;; esac
  case $nginx_site in *[[:space:]]*) fitgrid_error "nginx vhost 路径不能含空白字符"; exit 1 ;; esac
  resolved_sha=$(resolve_ref "$REPOSITORY_URL" "$git_ref")
  image=$(image_for_sha "$resolved_sha")
  assert_public_image "$image"
  validate_disk_pressure /

  if [ -z "$temporary_bootstrap" ]; then
    temporary_bootstrap=$(mktemp -d)
    trap 'test -z "$temporary_bootstrap" || rm -rf "$temporary_bootstrap"' EXIT HUP INT TERM
  fi
  pinned_common_library=$temporary_bootstrap/install-common.sh
  preflight_nginx_library=$temporary_bootstrap/install-nginx.sh
  curl -fsSL "$RAW_ROOT/$resolved_sha/ops/lib/install-common.sh" -o "$pinned_common_library"
  curl -fsSL "$RAW_ROOT/$resolved_sha/ops/lib/install-nginx.sh" -o "$preflight_nginx_library"
  # shellcheck disable=SC1090
  . "$pinned_common_library"
  # shellcheck disable=SC1090
  . "$preflight_nginx_library"
  [ "${FITGRID_NGINX_INSTALLER_PROTOCOL:-0}" -ge 2 ] \
    || { fitgrid_error "所选 Git ref 的安装器协议过旧；请使用当前 main 或更新版本"; exit 1; }
  require_root
  validate_host /etc/os-release /proc/meminfo /
  validate_domain "$domain"
  app_port=$(choose_app_port "$app_port")
  if [ -f "$ENVIRONMENT_FILE" ] && [ -n "$(environment_value PUBLIC_HTTPS_PORT "$ENVIRONMENT_FILE")" ]; then
    public_port=$(environment_value PUBLIC_HTTPS_PORT "$ENVIRONMENT_FILE")
  else
    public_port=$(choose_nginx_public_port "$nginx_site" "$domain" 443)
  fi
  validate_port "$public_port" 1
  validate_distinct_ports "$public_port" "$app_port"
  [ "$upgrade" = false ] || validate_upgrade_invariants "$ENVIRONMENT_FILE" "$domain" "$app_port" "$public_port" "$nginx_site"
  assert_app_port_available "$app_port"
  assert_public_image "$image"
  validate_disk_pressure /
  prepare_dedicated_nginx_site "$nginx_site" "$domain" "$public_port"
  validate_nginx_site "$nginx_site" "$domain" "$public_port"

  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl git
  ensure_checkout "$REPOSITORY_URL" "$resolved_sha" "$INSTALL_DIRECTORY"
  rm -rf "$temporary_bootstrap"
  temporary_bootstrap=
  set -- --from-installed --ref "$resolved_sha" --domain "$domain" \
    --app-port "$app_port" --public-port "$public_port" \
    --nginx-site "$nginx_site" --swap "$swap_choice" --create-admin "$admin_choice"
  [ "$upgrade" = false ] || set -- "$@" --upgrade
  exec "$INSTALL_DIRECTORY/ops/install-production.sh" "$@"
fi

resolved_sha=$git_ref
case $resolved_sha in ""|*[!a-fA-F0-9]*) fitgrid_error "内部 commit SHA 无效"; exit 1 ;; esac
[ "${#resolved_sha}" -eq 40 ] || { fitgrid_error "内部 commit SHA 长度无效"; exit 1; }

for library in install-nginx.sh install-host.sh install-deploy.sh; do
  [ -f "$script_directory/lib/$library" ] || { fitgrid_error "安装组件缺失：$library"; exit 1; }
  # shellcheck disable=SC1090
  . "$script_directory/lib/$library"
done

fitgrid_install_main "$domain" "$app_port" "$public_port" "$nginx_site" \
  "$resolved_sha" "$swap_choice" "$admin_choice" "$upgrade" \
  "$INSTALL_DIRECTORY" "$ENVIRONMENT_FILE" "$BACKUP_KEY_FILE"
