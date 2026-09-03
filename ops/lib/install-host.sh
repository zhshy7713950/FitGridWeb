#!/bin/sh

if ! command -v fitgrid_error >/dev/null 2>&1; then
  fitgrid_error() { printf '错误：%s\n' "$*" >&2; }
fi

install_dependencies() {
  apt_root=${1:-/etc/apt}
  release_file=${2:-/etc/os-release}
  keyring=$apt_root/keyrings/docker.asc
  source_file=$apt_root/sources.list.d/docker.sources

  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl openssl
  mkdir -p "$apt_root/keyrings" "$apt_root/sources.list.d"
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o "$keyring"
  chmod a+r "$keyring"
  codename=$(awk -F= '$1 == "UBUNTU_CODENAME" { print $2; found=1 } $1 == "VERSION_CODENAME" && !found { fallback=$2 } END { print found ? "" : fallback }' "$release_file" | head -n 1)
  codename=$(printf '%s' "$codename" | tr -d '"')
  architecture=$(dpkg --print-architecture)
  temporary=$(mktemp "${source_file}.tmp.XXXXXX")
  {
    printf 'Types: deb\n'
    printf 'URIs: https://download.docker.com/linux/ubuntu\n'
    printf 'Suites: %s\n' "$codename"
    printf 'Components: stable\n'
    printf 'Architectures: %s\n' "$architecture"
    printf 'Signed-By: %s\n' "$keyring"
  } >"$temporary"
  chmod 644 "$temporary"
  mv "$temporary" "$source_file"
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  apt-get install -y --no-install-recommends age jq util-linux
  systemctl enable --now docker.service
  systemctl enable --now nginx.service
}

ensure_swap() {
  consent=$1
  swapfile=${2:-/swapfile-fitgridweb}
  fstab=${3:-/etc/fstab}
  swaps_file=${4:-/proc/swaps}
  target_kb=2097152
  marker='# fitgridweb-managed'

  [ "$consent" = yes ] || return 0
  current_kb=$(awk 'NR > 1 { total += $3 } END { print total + 0 }' "$swaps_file")
  [ "$current_kb" -lt "$target_kb" ] || return 0
  if [ -f "$swapfile" ] && grep -Fq "$marker" "$fstab"; then
    return 0
  fi

  missing_kb=$((target_kb - current_kb))
  fallocate -l "${missing_kb}K" "$swapfile"
  chmod 600 "$swapfile"
  mkswap "$swapfile" >/dev/null
  swapon "$swapfile"
  if ! grep -Fq "$marker" "$fstab"; then
    printf '%s none swap sw 0 0 %s\n' "$swapfile" "$marker" >>"$fstab"
  fi
}

install_systemd_unit() {
  template=$1
  destination=${2:-/etc/systemd/system/fitgridweb.service}
  temporary=$(mktemp "${destination}.tmp.XXXXXX")
  cp "$template" "$temporary"
  chmod 644 "$temporary"
  mv "$temporary" "$destination"
  systemctl daemon-reload || return 1
  systemctl enable fitgridweb.service || return 1
}

host_environment_value() {
  host_environment_key=$1
  host_environment_file=$2
  [ -f "$host_environment_file" ] || return 0
  awk -F= -v wanted="$host_environment_key" '$1 == wanted { sub(/^[^=]*=/, ""); print; exit }' "$host_environment_file"
}

validate_maintenance_path() {
  maintenance_path=$1
  maintenance_label=$2
  case $maintenance_path in
    ""|/|*[!A-Za-z0-9_./-]*|*//*|*/./*|*/../*|*/.|*/..|*/)
      fitgrid_error "$maintenance_label 不是安全的绝对路径"
      return 1
      ;;
  esac
}

maintenance_paths_overlap() {
  maintenance_left=$1
  maintenance_right=$2
  [ "$maintenance_left" = "$maintenance_right" ] && return 0
  case "$maintenance_left/" in "$maintenance_right/"*) return 0 ;; esac
  case "$maintenance_right/" in "$maintenance_left/"*) return 0 ;; esac
  return 1
}

validate_portable_reader_gid() {
  portable_reader_gid_value=$1
  if ! awk -v candidate="$portable_reader_gid_value" 'BEGIN {
    exit !(candidate ~ /^[0-9]+$/ && candidate + 0 >= 1 && candidate + 0 <= 2147483647)
  }'; then
    fitgrid_error "PORTABLE_BACKUP_READER_GID 必须是非 root 的数字 GID"
    return 1
  fi
}

normalize_portable_backup_permissions() {
  portable_directory=$1
  portable_reader_gid_value=$2
  for portable_archive in "$portable_directory"/fitgridweb-*.fitgridbackup; do
    [ -e "$portable_archive" ] || [ -L "$portable_archive" ] || continue
    [ -f "$portable_archive" ] && [ ! -L "$portable_archive" ] || continue
    portable_archive_name=$(basename "$portable_archive")
    printf '%s\n' "$portable_archive_name" \
      | grep -Eq '^fitgridweb-[0-9]{8}T[0-9]{6}Z\.fitgridbackup$' || continue
    chown "root:$portable_reader_gid_value" "$portable_archive" \
      || { fitgrid_error "维护组件安装失败：便携备份读者所有权"; return 1; }
    chmod 0640 "$portable_archive" \
      || { fitgrid_error "维护组件安装失败：便携备份读者权限"; return 1; }
  done
}

install_atomic_host_file() {
  host_source=$1
  host_destination=$2
  host_mode=$3
  [ -f "$host_source" ] && [ ! -L "$host_source" ] \
    || { fitgrid_error "维护组件模板缺失：$(basename "$host_source")"; return 1; }
  mkdir -p "$(dirname "$host_destination")"
  host_temporary=$(mktemp "${host_destination}.tmp.XXXXXX") || return 1
  if ! cp "$host_source" "$host_temporary" \
    || ! chmod "$host_mode" "$host_temporary" \
    || ! mv "$host_temporary" "$host_destination"; then
    rm -f "$host_temporary"
    return 1
  fi
}

render_maintenance_host_file() {
  host_source=$1
  host_destination=$2
  host_mode=$3
  host_default_path=$4
  host_configured_path=$5
  host_rendered=$(mktemp) || return 1
  if ! sed "s|$host_default_path|$host_configured_path|g" "$host_source" >"$host_rendered" \
    || ! install_atomic_host_file "$host_rendered" "$host_destination" "$host_mode"; then
    rm -f "$host_rendered"
    return 1
  fi
  rm -f "$host_rendered"
}

backup_remote_is_distinct_mount() {
  backup_remote=$1
  validate_maintenance_path "$backup_remote" BACKUP_REMOTE_DIR || return 1
  [ -d "$backup_remote" ] && [ ! -L "$backup_remote" ] && [ -w "$backup_remote" ] || return 1
  backup_remote_canonical=$(realpath "$backup_remote" 2>/dev/null) || return 1
  backup_root_device=$(findmnt --target / --noheadings --output MAJ:MIN 2>/dev/null | awk 'NF { print $1; exit }')
  backup_remote_device=$(findmnt --target "$backup_remote_canonical" --noheadings --output MAJ:MIN 2>/dev/null | awk 'NF { print $1; exit }')
  [ -n "$backup_root_device" ] && [ -n "$backup_remote_device" ] \
    && [ "$backup_root_device" != "$backup_remote_device" ]
}

install_maintenance_components() {
  maintenance_project_directory=$1
  maintenance_environment_file=$2
  maintenance_systemd_directory=${3:-/etc/systemd/system}
  maintenance_logrotate_destination=${4:-/etc/logrotate.d/fitgridweb-ops}
  maintenance_template_directory=$maintenance_project_directory/ops/templates

  maintenance_web=$(host_environment_value ADMIN_OPS_WEB_DIR "$maintenance_environment_file")
  maintenance_root=$(host_environment_value ADMIN_OPS_ROOT_DIR "$maintenance_environment_file")
  maintenance_portable=$(host_environment_value PORTABLE_BACKUP_DIR "$maintenance_environment_file")
  maintenance_history=$(host_environment_value PORTABLE_BACKUP_HISTORY_FILE "$maintenance_environment_file")
  maintenance_reader_gid=$(host_environment_value PORTABLE_BACKUP_READER_GID "$maintenance_environment_file")
  maintenance_reader_gid=${maintenance_reader_gid:-1001}
  backup_remote=$(host_environment_value BACKUP_REMOTE_DIR "$maintenance_environment_file")

  validate_maintenance_path "$maintenance_web" ADMIN_OPS_WEB_DIR || return 1
  validate_maintenance_path "$maintenance_root" ADMIN_OPS_ROOT_DIR || return 1
  validate_maintenance_path "$maintenance_portable" PORTABLE_BACKUP_DIR || return 1
  validate_portable_reader_gid "$maintenance_reader_gid" || return 1
  if maintenance_paths_overlap "$maintenance_web" "$maintenance_root" \
    || maintenance_paths_overlap "$maintenance_web" "$maintenance_portable" \
    || maintenance_paths_overlap "$maintenance_root" "$maintenance_portable"; then
    fitgrid_error "管理员 web、root 与便携备份目录不得重叠"
    return 1
  fi
  [ "$maintenance_history" = "$maintenance_web/status/backups.json" ] \
    || { fitgrid_error "PORTABLE_BACKUP_HISTORY_FILE 必须位于管理员状态目录"; return 1; }

  install -d -m 0700 -o 1001 -g 1001 "$maintenance_web" || { fitgrid_error "维护组件安装失败：web spool 根目录"; return 1; }
  install -d -m 0700 -o 1001 -g 1001 "$maintenance_web/inbox" "$maintenance_web/uploads" \
    || { fitgrid_error "维护组件安装失败：web inbox/uploads"; return 1; }
  install -d -m 0750 -o 1001 -g 1001 "$maintenance_web/status" \
    || { fitgrid_error "维护组件安装失败：web status"; return 1; }
  install -d -m 0700 -o root -g root "$maintenance_root" "$maintenance_root/prepared" \
    || { fitgrid_error "维护组件安装失败：root 状态目录"; return 1; }
  install -d -m 0750 -o root -g "$maintenance_reader_gid" "$maintenance_portable" \
    || { fitgrid_error "维护组件安装失败：便携备份目录"; return 1; }
  normalize_portable_backup_permissions "$maintenance_portable" "$maintenance_reader_gid" || return 1

  mkdir -p "$maintenance_systemd_directory"
  if ! render_maintenance_host_file \
    "$maintenance_template_directory/fitgridweb-maintenance.path" \
    "$maintenance_systemd_directory/fitgridweb-maintenance.path" 644 \
    /var/lib/fitgridweb/admin-ops/web "$maintenance_web"; then
    fitgrid_error "维护组件安装失败：fitgridweb-maintenance.path"
    return 1
  fi
  for maintenance_unit in fitgridweb-maintenance.service fitgridweb-backup.service fitgridweb-backup.timer; do
    if ! install_atomic_host_file "$maintenance_template_directory/$maintenance_unit" \
      "$maintenance_systemd_directory/$maintenance_unit" 644; then
      fitgrid_error "维护组件安装失败：$maintenance_unit"
      return 1
    fi
  done
  if ! render_maintenance_host_file \
    "$maintenance_template_directory/fitgridweb-ops.logrotate" \
    "$maintenance_logrotate_destination" 600 \
    /var/lib/fitgridweb/admin-ops/root "$maintenance_root"; then
    fitgrid_error "维护组件安装失败：logrotate"
    return 1
  fi
  systemctl daemon-reload || { fitgrid_error "维护组件安装失败：systemd daemon-reload"; return 1; }
  systemctl enable --now fitgridweb-maintenance.path \
    || { fitgrid_error "维护组件安装失败：fitgridweb-maintenance.path 启用"; return 1; }

  if [ -n "$backup_remote" ] && backup_remote_is_distinct_mount "$backup_remote"; then
    systemctl enable --now fitgridweb-backup.timer \
      || { fitgrid_error "维护组件安装失败：fitgridweb-backup.timer 启用"; return 1; }
  else
    systemctl disable --now fitgridweb-backup.timer >/dev/null 2>&1 \
      || { fitgrid_error "维护组件安装失败：fitgridweb-backup.timer 禁用"; return 1; }
    printf '自动异机备份未启用：请配置并挂载 BACKUP_REMOTE_DIR\n'
  fi
}
