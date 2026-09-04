#!/bin/sh

if ! command -v fitgrid_error >/dev/null 2>&1; then
  fitgrid_error() { printf '错误：%s\n' "$*" >&2; }
fi

FITGRID_AGE_VERSION=v1.3.2
FITGRID_AGE_LINUX_AMD64_SHA256=cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10

install_age_with_batchpass() {
  age_architecture=$1
  age_install_directory=${2:-/usr/local/bin}
  [ "$age_architecture" = amd64 ] || {
    fitgrid_error "age batchpass 仅支持已校验的 Ubuntu amd64 安装包"
    return 1
  }

  if [ -x "$age_install_directory/age" ] \
    && [ -x "$age_install_directory/age-plugin-batchpass" ] \
    && [ "$("$age_install_directory/age" --version 2>/dev/null)" = "$FITGRID_AGE_VERSION" ] \
    && [ "$("$age_install_directory/age-plugin-batchpass" --version 2>/dev/null)" = "$FITGRID_AGE_VERSION" ]; then
    return 0
  fi

  age_download_directory=$(mktemp -d) || return 1
  age_archive=$age_download_directory/age.tar.gz
  age_release_url="https://github.com/FiloSottile/age/releases/download/$FITGRID_AGE_VERSION/age-$FITGRID_AGE_VERSION-linux-amd64.tar.gz"
  curl -fsSLo "$age_archive" "$age_release_url" || {
    age_install_status=$?
    rm -rf "$age_download_directory"
    fitgrid_error "age 官方发布包下载失败"
    return "$age_install_status"
  }
  printf '%s  %s\n' "$FITGRID_AGE_LINUX_AMD64_SHA256" "$age_archive" | sha256sum -c - >/dev/null || {
    age_install_status=$?
    rm -rf "$age_download_directory"
    fitgrid_error "age 官方发布包 SHA-256 校验失败"
    return "$age_install_status"
  }
  tar -xzf "$age_archive" -C "$age_download_directory" age/age age/age-plugin-batchpass || {
    age_install_status=$?
    rm -rf "$age_download_directory"
    fitgrid_error "age 官方发布包解压失败"
    return "$age_install_status"
  }

  for age_binary in age age-plugin-batchpass; do
    age_source=$age_download_directory/age/$age_binary
    [ -f "$age_source" ] && [ ! -L "$age_source" ] || {
      rm -rf "$age_download_directory"
      fitgrid_error "age 官方发布包缺少 $age_binary"
      return 1
    }
    [ "$("$age_source" --version 2>/dev/null)" = "$FITGRID_AGE_VERSION" ] || {
      rm -rf "$age_download_directory"
      fitgrid_error "age 官方发布包版本不匹配"
      return 1
    }
  done

  install -d -m 0755 -o root -g root "$age_install_directory" || {
    rm -rf "$age_download_directory"
    return 1
  }
  age_program_tmp=$(mktemp "$age_install_directory/.age.XXXXXX") || {
    rm -rf "$age_download_directory"
    return 1
  }
  age_plugin_tmp=$(mktemp "$age_install_directory/.age-plugin-batchpass.XXXXXX") || {
    rm -f "$age_program_tmp"
    rm -rf "$age_download_directory"
    return 1
  }
  install -m 0755 "$age_download_directory/age/age" "$age_program_tmp" \
    && install -m 0755 "$age_download_directory/age/age-plugin-batchpass" "$age_plugin_tmp" \
    && mv "$age_plugin_tmp" "$age_install_directory/age-plugin-batchpass" \
    && mv "$age_program_tmp" "$age_install_directory/age" || {
    age_install_status=$?
    rm -f "$age_program_tmp" "$age_plugin_tmp"
    rm -rf "$age_download_directory"
    return "$age_install_status"
  }
  rm -rf "$age_download_directory"

  [ "$("$age_install_directory/age" --version 2>/dev/null)" = "$FITGRID_AGE_VERSION" ] \
    && [ "$("$age_install_directory/age-plugin-batchpass" --version 2>/dev/null)" = "$FITGRID_AGE_VERSION" ] \
    || { fitgrid_error "age batchpass 安装后版本校验失败"; return 1; }
}

install_dependencies() {
  apt_root=${1:-/etc/apt}
  release_file=${2:-/etc/os-release}
  age_install_directory=${3:-/usr/local/bin}
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
  apt-get install -y --no-install-recommends jq util-linux
  install_age_with_batchpass "$architecture" "$age_install_directory" || return 1
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
  temporary=
  if ! temporary=$(mktemp "${destination}.tmp.XXXXXX"); then
    return 1
  fi
  if ! cp "$template" "$temporary"; then
    rm -f "$temporary" || true
    return 1
  fi
  if ! chmod 644 "$temporary"; then
    rm -f "$temporary" || true
    return 1
  fi
  if ! mv "$temporary" "$destination"; then
    rm -f "$temporary" || true
    return 1
  fi
  if ! systemctl daemon-reload; then
    return 1
  fi
  return 0
}

capture_fitgrid_unit_states() {
  for fitgrid_state_unit in \
    fitgridweb-maintenance-recovery.service \
    fitgridweb-maintenance.path \
    fitgridweb-maintenance-sweep.timer \
    fitgridweb-backup.timer \
    fitgridweb.service
  do
    fitgrid_state_enabled=false
    fitgrid_state_active=false
    if systemctl is-enabled --quiet "$fitgrid_state_unit" >/dev/null 2>&1; then
      fitgrid_state_enabled=true
    fi
    if systemctl is-active --quiet "$fitgrid_state_unit" >/dev/null 2>&1; then
      fitgrid_state_active=true
    fi
    printf '%s|%s|%s\n' "$fitgrid_state_unit" "$fitgrid_state_enabled" "$fitgrid_state_active"
  done
}

restore_fitgrid_unit_states() {
  fitgrid_saved_unit_states=$1
  fitgrid_restore_allow_starts=${2:-true}
  fitgrid_restore_state_status=0
  while IFS='|' read -r fitgrid_state_unit fitgrid_was_enabled fitgrid_was_active; do
    [ -n "$fitgrid_state_unit" ] || continue
    fitgrid_is_enabled=false
    fitgrid_is_active=false
    if systemctl is-enabled --quiet "$fitgrid_state_unit" >/dev/null 2>&1; then
      fitgrid_is_enabled=true
    fi
    if systemctl is-active --quiet "$fitgrid_state_unit" >/dev/null 2>&1; then
      fitgrid_is_active=true
    fi
    if [ "$fitgrid_was_active" = false ] && [ "$fitgrid_is_active" = true ]; then
      systemctl stop "$fitgrid_state_unit" || fitgrid_restore_state_status=1
    fi
    if [ "$fitgrid_was_enabled" != "$fitgrid_is_enabled" ]; then
      if [ "$fitgrid_was_enabled" = true ]; then
        systemctl enable "$fitgrid_state_unit" || fitgrid_restore_state_status=1
      else
        systemctl disable "$fitgrid_state_unit" || fitgrid_restore_state_status=1
      fi
    fi
    if [ "$fitgrid_restore_allow_starts" = true ] \
      && [ "$fitgrid_was_active" = true ] && [ "$fitgrid_is_active" = false ]; then
      systemctl start "$fitgrid_state_unit" || fitgrid_restore_state_status=1
    fi
  done <<EOF
$fitgrid_saved_unit_states
EOF
  return "$fitgrid_restore_state_status"
}

restore_fitgrid_systemd_unit() {
  fitgrid_unit_destination=$1
  fitgrid_unit_backup=${2:-}
  fitgrid_unit_had_previous=$3
  case $fitgrid_unit_had_previous in
    true) install_atomic_host_file "$fitgrid_unit_backup" "$fitgrid_unit_destination" 644 || return 1 ;;
    false) rm -f "$fitgrid_unit_destination" || return 1 ;;
    *) return 1 ;;
  esac
  systemctl daemon-reload
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
    ""|/|[!/]*|*[!A-Za-z0-9_./-]*|*//*|*/./*|*/../*|*/.|*/..|*/)
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

normalize_portable_backup_history_permissions() {
  portable_history_file=$1
  portable_reader_gid_value=$2
  [ -e "$portable_history_file" ] || [ -L "$portable_history_file" ] || return 0
  if [ ! -f "$portable_history_file" ] || [ -L "$portable_history_file" ]; then
    fitgrid_error "维护组件安装失败：便携备份历史文件不是安全的常规文件"
    return 1
  fi
  if ! jq -e '
    type == "object" and
    (keys == ["entries"]) and
    (.entries | type == "array" and length <= 5) and
    all(.entries[];
      type == "object" and
      (keys | sort) == ["createdAt", "filename", "id", "sha256", "size", "status"] and
      (.id | type == "string" and test("^\\.id\\.[A-Za-z0-9]{6}$")) and
      (.filename | type == "string" and test("^fitgridweb-[0-9]{8}T[0-9]{6}Z\\.fitgridbackup$")) and
      (.createdAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
      (.size | type == "number" and floor == . and . >= 0) and
      (.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
      .status == "ready"
    )
  ' "$portable_history_file" >/dev/null 2>&1; then
    fitgrid_error "维护组件安装失败：便携备份历史文件内容无效"
    return 1
  fi
  chown "root:$portable_reader_gid_value" "$portable_history_file" \
    || { fitgrid_error "维护组件安装失败：便携备份历史文件所有权"; return 1; }
  chmod 0640 "$portable_history_file" \
    || { fitgrid_error "维护组件安装失败：便携备份历史文件权限"; return 1; }
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

install_maintenance_components() {
  maintenance_project_directory=$1
  maintenance_environment_file=$2
  maintenance_systemd_directory=${3:-/etc/systemd/system}
  maintenance_logrotate_destination=${4:-/etc/logrotate.d/fitgridweb-ops}
  maintenance_template_directory=$maintenance_project_directory/ops/templates
  maintenance_portable_library=$maintenance_project_directory/ops/lib/portable-backup.sh
  [ -f "$maintenance_portable_library" ] && [ ! -L "$maintenance_portable_library" ] \
    || { fitgrid_error "维护组件安装失败：便携备份库缺失"; return 1; }
  # shellcheck disable=SC1090
  . "$maintenance_portable_library"

  maintenance_web=$(host_environment_value ADMIN_OPS_WEB_DIR "$maintenance_environment_file")
  maintenance_root=$(host_environment_value ADMIN_OPS_ROOT_DIR "$maintenance_environment_file")
  maintenance_portable=$(host_environment_value PORTABLE_BACKUP_DIR "$maintenance_environment_file")
  maintenance_history=$(host_environment_value PORTABLE_BACKUP_HISTORY_FILE "$maintenance_environment_file")
  maintenance_reader_gid=$(host_environment_value PORTABLE_BACKUP_READER_GID "$maintenance_environment_file")
  maintenance_reader_gid=${maintenance_reader_gid:-1001}

  validate_maintenance_path "$maintenance_web" ADMIN_OPS_WEB_DIR || return 1
  validate_maintenance_path "$maintenance_root" ADMIN_OPS_ROOT_DIR || return 1
  validate_maintenance_path "$maintenance_portable" PORTABLE_BACKUP_DIR || return 1
  validate_maintenance_path "$maintenance_history" PORTABLE_BACKUP_HISTORY_FILE || return 1
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
  if ! (
    exec 9>"$maintenance_root/maintenance.lock"
    flock -w 30 9 || exit $?
    PORTABLE_BACKUP_READER_GID=$maintenance_reader_gid
    export PORTABLE_BACKUP_READER_GID
    reconcile_portable_backups "$maintenance_portable" "$maintenance_history" 5
  ); then
    fitgrid_error "维护组件安装失败：便携备份历史文件恢复"
    return 1
  fi
  normalize_portable_backup_permissions "$maintenance_portable" "$maintenance_reader_gid" || return 1
  normalize_portable_backup_history_permissions "$maintenance_history" "$maintenance_reader_gid" || return 1

  mkdir -p "$maintenance_systemd_directory"
  if ! render_maintenance_host_file \
    "$maintenance_template_directory/fitgridweb-maintenance.path" \
    "$maintenance_systemd_directory/fitgridweb-maintenance.path" 644 \
    /var/lib/fitgridweb/admin-ops/web "$maintenance_web"; then
    fitgrid_error "维护组件安装失败：fitgridweb-maintenance.path"
    return 1
  fi
  for maintenance_unit in \
    fitgridweb-maintenance.service \
    fitgridweb-maintenance-recovery.service \
    fitgridweb-maintenance-sweep.timer
  do
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
}

enable_maintenance_components() {
  systemctl enable fitgridweb-maintenance-recovery.service \
    || { fitgrid_error "维护组件安装失败：fitgridweb-maintenance-recovery.service 启用"; return 1; }
  systemctl start fitgridweb-maintenance-recovery.service \
    || { fitgrid_error "维护组件安装失败：fitgridweb-maintenance-recovery.service 启动"; return 1; }
  systemctl enable --now fitgridweb-maintenance.path \
    || { fitgrid_error "维护组件安装失败：fitgridweb-maintenance.path 启用"; return 1; }
  systemctl enable --now fitgridweb-maintenance-sweep.timer \
    || { fitgrid_error "维护组件安装失败：fitgridweb-maintenance-sweep.timer 启用"; return 1; }

  if systemctl is-enabled --quiet fitgridweb-backup.timer >/dev/null 2>&1 \
    || systemctl is-active --quiet fitgridweb-backup.timer >/dev/null 2>&1; then
    systemctl disable --now fitgridweb-backup.timer \
      || { fitgrid_error "维护组件安装失败：旧版 fitgridweb-backup.timer 禁用"; return 1; }
  fi
  printf '自动定时备份已禁用；请使用管理页面或 ops/backup.sh 手动备份\n'
}
