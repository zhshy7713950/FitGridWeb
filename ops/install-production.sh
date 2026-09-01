#!/bin/sh
set -eu

REPOSITORY_URL=https://github.com/zhshy7713950/FitGridWeb.git
RAW_ROOT=https://raw.githubusercontent.com/zhshy7713950/FitGridWeb
INSTALL_DIRECTORY=/opt/fitgridweb
ENVIRONMENT_FILE=/etc/fitgridweb/fitgridweb.env
BACKUP_KEY_FILE=/etc/fitgridweb/backup.key

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
temporary_bootstrap=
if [ -f "$script_directory/lib/install-common.sh" ]; then
  common_library=$script_directory/lib/install-common.sh
else
  temporary_bootstrap=$(mktemp -d)
  trap 'test -z "$temporary_bootstrap" || rm -rf "$temporary_bootstrap"' EXIT HUP INT TERM
  common_library=$temporary_bootstrap/install-common.sh
  curl -fsSL "$RAW_ROOT/main/ops/lib/install-common.sh" -o "$common_library"
fi
# shellcheck disable=SC1090
. "$common_library"

from_installed=false
upgrade=false
git_ref=main
domain=
app_port=3300
public_port=443
nginx_site=
swap_choice=yes
admin_choice=yes

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
  public_port=$(prompt_value "该 nginx 站点的公网 HTTPS 端口" "$public_port")
  nginx_site=$(prompt_value "仅含一个 server 块的 nginx vhost 文件绝对路径" "${nginx_site:-/etc/nginx/sites-available/default}")
  app_port=$(prompt_value "FitGrid 本地回环端口" "$app_port")
  git_ref=$(prompt_value "要部署的公开 Git ref" "$git_ref")
  swap_choice=$(prompt_yes_no "总 Swap 不足 2 GiB 时补足" "$swap_choice")
  admin_choice=$(prompt_yes_no "部署成功后创建首个管理员" "$admin_choice")

  validate_domain "$domain"
  validate_port "$public_port" 1
  validate_port "$app_port" 1024
  case $nginx_site in /*) : ;; *) fitgrid_error "nginx vhost 必须是绝对路径"; exit 1 ;; esac
  [ -f "$nginx_site" ] || { fitgrid_error "nginx vhost 文件不存在：$nginx_site"; exit 1; }
  assert_app_port_available "$app_port"
  resolved_sha=$(resolve_ref "$REPOSITORY_URL" "$git_ref")
  image=$(image_for_sha "$resolved_sha")
  assert_public_image "$image"

  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl git
  ensure_checkout "$REPOSITORY_URL" "$resolved_sha" "$INSTALL_DIRECTORY"
  exec "$INSTALL_DIRECTORY/ops/install-production.sh" \
    --from-installed --ref "$resolved_sha" --domain "$domain" \
    --app-port "$app_port" --public-port "$public_port" \
    --nginx-site "$nginx_site" --swap "$swap_choice" --create-admin "$admin_choice" \
    $( [ "$upgrade" = true ] && printf '%s' '--upgrade' || true )
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
