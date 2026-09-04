#!/bin/sh

if ! command -v fitgrid_error >/dev/null 2>&1; then
  fitgrid_error() { printf '错误：%s\n' "$*" >&2; }
fi

fitgrid_compose() {
  project_directory=$1
  environment_file=$2
  shift 2
  docker compose --project-name fitgridweb \
    --env-file "$environment_file" \
    -f "$project_directory/docker-compose.yml" \
    -f "$project_directory/docker-compose.low-memory.yml" "$@"
}

verify_health() {
  health_url=$1
  attempts=${FITGRID_HEALTH_ATTEMPTS:-12}
  count=1
  while [ "$count" -le "$attempts" ]; do
    if curl --fail --silent --show-error --max-time 10 "$health_url" >/dev/null; then
      return 0
    fi
    count=$((count + 1))
    [ "$count" -gt "$attempts" ] || sleep 5
  done
  fitgrid_error "健康检查失败：$health_url"
  return 1
}

restore_environment() {
  environment_file=$1
  old_environment=${2:-}
  [ -n "$old_environment" ] && [ -f "$old_environment" ] || return 1
  temporary=$(mktemp "${environment_file}.rollback.XXXXXX")
  cp "$old_environment" "$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$environment_file"
}

restore_or_remove_environment() {
  environment_file=$1
  old_environment=${2:-}
  restore_environment "$environment_file" "$old_environment" || rm -f "$environment_file"
}

rollback_app() {
  project_directory=$1
  environment_file=$2
  old_environment=${3:-}
  if restore_environment "$environment_file" "$old_environment"; then
    fitgrid_error "新应用不健康；已恢复旧 APP_IMAGE。数据库迁移未逆向回滚。"
    fitgrid_compose "$project_directory" "$environment_file" up --no-build -d --wait app
  else
    fitgrid_error "首次安装没有旧镜像可恢复；数据库保持运行以便诊断"
    fitgrid_compose "$project_directory" "$environment_file" stop app >/dev/null 2>&1 || true
    rm -f "$environment_file"
  fi
  return 1
}

rollback_release() {
  project_directory=$1
  environment_file=$2
  old_environment=${3:-}
  app_port=$4
  public_health=$5
  rollback_app "$project_directory" "$environment_file" "$old_environment" || true
  if [ -n "$old_environment" ] && [ -f "$old_environment" ]; then
    verify_health "http://127.0.0.1:$app_port/fitgrid/api/v1/health" || true
    verify_health "$public_health" || true
  fi
  return 1
}

deploy_release() {
  project_directory=$1
  environment_file=$2
  old_environment=${3:-}
  app_port=$4

  set -a
  # shellcheck disable=SC1090
  . "$environment_file"
  set +a

  fitgrid_compose "$project_directory" "$environment_file" pull db app
  fitgrid_compose "$project_directory" "$environment_file" up --no-build -d --wait db
  runtime_database_url=$DATABASE_URL
  DATABASE_URL=$MIGRATION_DATABASE_URL
  export DATABASE_URL
  migration_status=0
  fitgrid_compose "$project_directory" "$environment_file" run --rm --no-deps \
    -e DATABASE_URL app node_modules/.bin/prisma migrate deploy || migration_status=$?
  DATABASE_URL=$runtime_database_url
  export DATABASE_URL
  if [ "$migration_status" -ne 0 ]; then
    restore_environment "$environment_file" "$old_environment" || true
    fitgrid_error "数据库迁移失败；新应用未启动"
    return 1
  fi
  if ! fitgrid_compose "$project_directory" "$environment_file" up --no-build -d --wait app; then
    rollback_app "$project_directory" "$environment_file" "$old_environment"
    return 1
  fi
  if ! verify_health "http://127.0.0.1:$app_port/fitgrid/api/v1/health"; then
    rollback_app "$project_directory" "$environment_file" "$old_environment"
    return 1
  fi
}

create_initial_admin() {
  project_directory=$1
  environment_file=$2
  fitgrid_compose "$project_directory" "$environment_file" run --rm --no-deps \
    app node_modules/.bin/tsx src/server/cli/create-admin.ts
}

cleanup_old_app_images() {
  environment_file=$1
  current_image=$(awk -F= '$1 == "APP_IMAGE" { sub(/^[^=]*=/, ""); print; exit }' "$environment_file")
  current_tag=${current_image##*:}
  current_repository=${current_image%:*}
  current_sha=${current_tag#sha-}

  if [ -z "$current_repository" ] || [ "$current_repository" = "$current_image" ] \
    || [ "$current_tag" = "$current_sha" ] || [ "${#current_sha}" -ne 40 ]; then
    printf '警告：APP_IMAGE 不是可识别的 SHA 镜像，跳过旧镜像清理。\n' >&2
    return 1
  fi
  case $current_sha in
    *[!a-fA-F0-9]*)
      printf '警告：APP_IMAGE 的 SHA 格式无效，跳过旧镜像清理。\n' >&2
      return 1
      ;;
  esac

  local_images=$(docker image ls \
    --filter "reference=$current_repository:sha-*" \
    --format '{{.Repository}}:{{.Tag}}') || {
      printf '警告：无法列出本地应用镜像。\n' >&2
      return 1
    }

  cleanup_status=0
  removed_count=0
  while IFS= read -r candidate_image; do
    [ -n "$candidate_image" ] || continue
    [ "$candidate_image" != "$current_image" ] || continue
    case $candidate_image in
      "$current_repository":sha-*) : ;;
      *) continue ;;
    esac
    candidate_tag=${candidate_image##*:}
    candidate_sha=${candidate_tag#sha-}
    [ "${#candidate_sha}" -eq 40 ] || continue
    case $candidate_sha in *[!a-fA-F0-9]*) continue ;; esac

    if docker image rm "$candidate_image" >/dev/null; then
      removed_count=$((removed_count + 1))
    else
      printf '警告：旧镜像仍被占用或无法删除：%s\n' "$candidate_image" >&2
      cleanup_status=1
    fi
  done <<EOF
$local_images
EOF

  if [ "$removed_count" -gt 0 ]; then
    printf '已清理 %s 个旧应用镜像。\n' "$removed_count"
  fi
  return "$cleanup_status"
}

fitgrid_install_main() {
  domain=$1
  app_port=$2
  public_port=$3
  nginx_site=$4
  resolved_sha=$5
  swap_choice=$6
  admin_choice=$7
  upgrade=$8
  project_directory=$9
  shift 9
  environment_file=$1
  backup_key_file=$2

  validate_domain "$domain"
  validate_port "$app_port" 1024
  validate_port "$public_port" 1
  validate_nginx_site "$nginx_site" "$domain" "$public_port"
  assert_public_image "$(image_for_sha "$resolved_sha")"

  install_dependencies /etc/apt /etc/os-release
  assert_app_port_available "$app_port"

  backup_root=/var/lib/fitgridweb/install-backups
  nginx_backup_root=/var/backups/fitgridweb/nginx
  mkdir -p "$backup_root" "$nginx_backup_root"
  old_environment=
  if [ -f "$environment_file" ]; then
    backup_id=$(date -u +%Y%m%dT%H%M%SZ)
    old_environment=$(mktemp "$backup_root/fitgridweb.env.$backup_id.XXXXXX")
    cp -p "$environment_file" "$old_environment"
  fi

  ensure_environment "$environment_file" "$backup_key_file" \
    "$domain" "$app_port" "$public_port" "$resolved_sha" "$nginx_site"
  ensure_swap "$swap_choice" /swapfile-fitgridweb /etc/fstab /proc/swaps

  if ! install_maintenance_components "$project_directory" "$environment_file"; then
    restore_or_remove_environment "$environment_file" "$old_environment"
    fitgrid_error "维护组件安装失败；新 FitGridWeb 应用尚未启动"
    return 1
  fi
  if ! install_systemd_unit "$project_directory/ops/templates/fitgridweb.service" /etc/systemd/system/fitgridweb.service; then
    restore_or_remove_environment "$environment_file" "$old_environment"
    fitgrid_error "systemd 应用 unit 安装失败；新 FitGridWeb 应用尚未启动"
    return 1
  fi
  if ! deploy_release "$project_directory" "$environment_file" "$old_environment" "$app_port"; then
    restore_or_remove_environment "$environment_file" "$old_environment"
    return 1
  fi

  nginx_temporary=$(mktemp -d)
  trap 'rm -rf "$nginx_temporary"' EXIT HUP INT TERM
  portable_backup_max_bytes=$(awk -F= '$1 == "PORTABLE_BACKUP_MAX_BYTES" { sub(/^[^=]*=/, ""); print; exit }' "$environment_file")
  portable_backup_max_bytes=${portable_backup_max_bytes:-536870912}
  render_nginx_snippet "$app_port" "$portable_backup_max_bytes" >"$nginx_temporary/fitgridweb-location.conf"
  public_suffix=
  [ "$public_port" -eq 443 ] || public_suffix=":$public_port"
  public_health="https://$domain$public_suffix/fitgrid/api/v1/health"
  if ! install_nginx_include "$nginx_site" "$nginx_temporary/fitgridweb-location.conf" "$nginx_backup_root"; then
    rollback_release "$project_directory" "$environment_file" "$old_environment" "$app_port" "$public_health" || true
    return 1
  fi
  if ! verify_health "$public_health"; then
    rollback_release "$project_directory" "$environment_file" "$old_environment" "$app_port" "$public_health" || true
    return 1
  fi

  if ! systemctl restart fitgridweb.service; then
    rollback_release "$project_directory" "$environment_file" "$old_environment" "$app_port" "$public_health" || true
    return 1
  fi
  if ! verify_health "$public_health"; then
    rollback_release "$project_directory" "$environment_file" "$old_environment" "$app_port" "$public_health" || true
    return 1
  fi
  if ! enable_maintenance_components "$environment_file"; then
    fitgrid_error "维护组件启用失败；应用保持当前健康版本，请修复后重试安装"
    return 1
  fi
  if ! systemctl enable fitgridweb.service; then
    fitgrid_error "systemd 应用 unit 启用失败；应用保持当前健康版本，请修复后重试安装"
    return 1
  fi
  if [ "$admin_choice" = yes ]; then
    create_initial_admin "$project_directory" "$environment_file"
  fi

  if ! cleanup_old_app_images "$environment_file"; then
    printf '警告：旧镜像清理失败；部署保持成功，请稍后手动检查 Docker 磁盘占用。\n' >&2
  fi

  printf '\nFitGridWeb 部署完成：https://%s%s/fitgrid/\n' "$domain" "$public_suffix"
  printf '服务状态：systemctl status fitgridweb\n'
  printf '服务日志：journalctl -u fitgridweb\n'
  printf '升级命令：%s/ops/install-production.sh --upgrade\n' "$project_directory"
  printf '备份命令：%s/ops/backup.sh\n' "$project_directory"
  printf '警告：请把 BACKUP_REMOTE_DIR 配置为异机存储，并完成一次隔离恢复演练。\n'
  [ "$upgrade" = true ] && printf '本次操作类型：升级\n' || true
}
