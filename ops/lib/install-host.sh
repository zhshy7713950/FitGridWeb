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
  systemctl daemon-reload
  systemctl enable fitgridweb.service
}
