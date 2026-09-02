# 2 GiB VPS 一键部署与运维手册

本手册适用于 Ubuntu 24.04 x86_64、2 vCPU、2 GiB RAM、至少 20 GiB 磁盘的 VPS。FitGridWeb 与现有 `sing-box + nginx` 共存，由现有 HTTPS 站点代理固定子路径 `/fitgrid`。预期负载是 1–2 人偶尔使用，不是高并发配置。

## 部署前确认

- 至少 1.5 GiB 总内存和 8 GiB 可用磁盘；建议允许安装器把总 Swap 补到 2 GiB。
- 现有域名已经在当前 nginx 配置中使用有效的 TLS 证书；安装器会复用证书，但不会申请、续期或替换证书，也不会修改防火墙或触碰 sing-box。
- 安装器优先检查 `443/TCP`：空闲时自动创建 `/etc/nginx/conf.d/fitgridweb.conf` 并使用标准 HTTPS；已占用时才要求填写另一个空闲端口。UDP 端口不参与该判断，因此 sing-box 使用 `443/UDP` 不会阻止 nginx 使用 `443/TCP`。
- 选择未占用的本地端口，默认 `3300`。应用只绑定 `127.0.0.1`；PostgreSQL 不发布宿主端口。
- GitHub Actions 已为所选完整 commit 生成 `ghcr.io/zhshy7713950/fitgridweb:sha-<40位SHA>`。首次发布后，在 GitHub Packages 设置中把该 GHCR package 设为 **Public**；安装器不保存 GitHub Token。

安装器先完成镜像公开性、应用端口和磁盘检查，再以可回滚方式创建独立 nginx vhost，并完成 nginx 配置和 HTTPS 连通性检查，之后才修改 apt、`/opt` 或启动应用。磁盘达到 70% 会警告，达到 85% 会停止安装或升级。

## 一键安装

先下载再运行，便于执行前查看脚本；不要使用 `curl | sudo sh`：

```bash
curl -fsSLo /tmp/fitgridweb-install.sh \
  https://raw.githubusercontent.com/zhshy7713950/FitGridWeb/main/ops/install-production.sh
less /tmp/fitgridweb-install.sh
sudo sh /tmp/fitgridweb-install.sh
```

安装器依次询问：

1. 现有 HTTPS 域名，不含协议、端口和路径；
2. FitGrid 本地回环端口，默认 `3300`；
3. 公开仓库的 Git ref，默认 `main`，最终总会解析为完整 SHA；
4. 是否把总 Swap 补到 2 GiB；
5. 是否在部署后创建首个管理员。

如果 `443/TCP` 已被占用，安装器会额外要求填写一个空闲的公网 HTTPS 端口；否则不会询问端口或 nginx 文件路径。
公网 HTTPS 端口不能与本地应用端口相同。安装器只支持带 `FITGRID_NGINX_INSTALLER_PROTOCOL=2` 的当前发布；若显式选择更早的 Git ref，会给出兼容性错误并停止。

管理员密码由容器内管理员 CLI 直接以隐藏 TTY 输入读取，不会出现在参数、shell history 或安装日志中。它只允许在用户表为空时执行一次。

安装成功地址为：

```text
https://你的域名[:非标准HTTPS端口]/fitgrid/
```

健康检查：

```bash
curl --fail --silent --show-error \
  https://你的域名[:非标准HTTPS端口]/fitgrid/api/v1/health
```

## 安装器会修改什么

- `/opt/fitgridweb`：固定 commit 的公开仓库检出；
- `/etc/fitgridweb/fitgridweb.env`：权限 `600` 的运行配置和五个独立随机秘密；
- `/etc/fitgridweb/backup.key`：权限 `600` 的备份加密密钥；
- `/etc/nginx/snippets/fitgridweb-location.conf`：受管 `/fitgrid` 代理片段；
- `/etc/nginx/conf.d/fitgridweb.conf`：自动创建或复用的单-server专用 vhost，只使用现有域名证书；
- `/var/backups/fitgridweb/nginx`：nginx 修改前的带时间戳备份；
- `/etc/systemd/system/fitgridweb.service`：开机恢复 `db app`；
- 用户同意且现有 Swap 不足时：`/swapfile-fitgridweb` 和 `/etc/fstab` 中的一条受管记录；
- Docker 官方 apt source 和 Docker Engine/Compose plugin。

全部部署步骤和健康检查成功后，安装器会从当前 `APP_IMAGE` 动态识别镜像仓库，只删除该仓库中不再使用的旧 `sha-<40位SHA>` 镜像，并保留当前运行镜像。镜像仍被容器占用或 Docker 清理失败时只输出警告，不会使用强制删除，也不会回滚已经成功的部署。

它不会执行 `docker system prune`，不会清理其他镜像仓库，不会删除 PostgreSQL 卷，也不会修改 SSH、防火墙、sing-box、其他 nginx server 或其他 Docker Compose project。若同域名存在多组不同证书、证书文件不存在或专用 vhost 已被其他服务占用，安装器会停止而不是猜测或覆盖。

## 日常检查与重启

```bash
systemctl status fitgridweb
systemctl status docker nginx
journalctl -u fitgridweb -n 200 --no-pager

cd /opt/fitgridweb
docker compose --project-name fitgridweb \
  --env-file /etc/fitgridweb/fitgridweb.env \
  -f docker-compose.yml -f docker-compose.low-memory.yml ps

curl --fail http://127.0.0.1:3300/fitgrid/api/v1/health
sudo systemctl restart fitgridweb
sudo nginx -t
```

`fitgridweb.service` 已启用开机启动，并依赖 `docker.service` 与 `network-online.target`。容器同时采用 `restart: unless-stopped`。首次上线应执行一次计划内重启验收：

```bash
sudo reboot
# SSH 重新连接后
systemctl status fitgridweb --no-pager
curl --fail https://你的域名/fitgrid/api/v1/health
```

## 内存与磁盘观察

```bash
free -h
swapon --show
df -h /
docker stats --no-stream
ps aux --sort=-%mem | head -20
```

应用容器上限为 640 MiB，PostgreSQL 为 512 MiB。持续出现以下任一情况时，建议把 VPS 升级到 4 GiB，而不是继续提高容器上限：

- `MemAvailable` 长时间低于 400 MiB；
- Swap 持续增长且不能回落；
- `docker inspect` 显示 app 或 db 因 OOM 被终止；
- 磁盘使用达到 85%。

## 升级与应用回滚

先确认目标 commit 的 GitHub Actions 已成功且对应 GHCR SHA 镜像可公开读取，然后运行：

```bash
/opt/fitgridweb/ops/install-production.sh --upgrade
```

请在 root shell 中运行；如果当前不是 root，可在命令前加 `sudo`。Git-ref 提示输入 `main`，或输入已经审核的不可变完整 commit SHA；域名、应用端口、Swap 和不创建管理员均接受现有默认值。前端与 API 仍由同一个 `ghcr.io/zhshy7713950/fitgridweb:sha-<40位SHA>` 镜像提供，不需要新增服务、端口、Compose 文件或前端专用部署步骤。

升级完成后执行前端与健康检查：

```bash
curl -fsSIL --max-redirs 5 https://YOUR_DOMAIN/fitgrid/
curl -fsS https://YOUR_DOMAIN/fitgrid/api/v1/health
```

浏览器打开 `/fitgrid/`，登录后搜索一个已知产品，清除搜索并确认仍显示同一账号的数据，最后退出登录。若站点使用非标准 HTTPS 端口，应在 `YOUR_DOMAIN` 后补上该端口。

FitGrid 升级不修改 sing-box、订阅端口 `30127`、订阅路径 `/s` 或对应 nginx vhost。升级后仍须保留原订阅冒烟：

```bash
curl -fsS https://YOUR_DOMAIN:30127/s >/dev/null
```

升级默认复用已保存的域名、端口、nginx 文件和当前 SHA，并默认不再创建管理员。输入新的 tag、分支或完整 SHA 即可升级。为了保证应用、nginx 和回滚端点保持原子一致，`--upgrade` 不允许同时更换域名、本地端口、公网端口或 vhost；这类变更应在单独维护窗口完成。脚本保留既有数据库卷、秘密和已验证的备份路径/保留期，先迁移再更新 app；迁移失败时不启动新 app；nginx、systemd 或最终健康检查失败时恢复旧 `APP_IMAGE` 并重新验证旧服务。

数据库 migration 不做自动逆向 SQL。migration 必须向后兼容旧应用；如果新 migration 破坏了旧版兼容性，应用镜像回滚并不等于数据库回滚，必须按隔离恢复流程处理。

## nginx 失败恢复

安装器写入后自动执行 `nginx -t` 和 reload，再分别使用本机 SNI/TLS 与公网域名验证 HTTPS。任一步失败都会删除新建 vhost，并再次执行 `nginx -t` 与 reload恢复旧配置；已有受管文件修改失败则恢复原 vhost 和原 snippet。需要人工检查时：

```bash
sudo nginx -t
sudo ls -lt /var/backups/fitgridweb/nginx | head
sudo grep -R "fitgridweb-managed" /etc/nginx
```

如需人工恢复，先把对应 `.bak` 文件复制回原位置，再执行：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

不要在未通过 `nginx -t` 时 reload 或 restart nginx，以免影响同机其他网站。

## 备份与隔离恢复

首次安装会把 `/etc/fitgridweb/fitgridweb.env` 中的 `BACKUP_REMOTE_DIR` 留空，备份命令会明确拒绝运行。先把它改为真实异机挂载或独立故障域目录；仅复制到同一块 VPS 磁盘不算灾难恢复。后续 `--upgrade` 会保留该配置。

```bash
sudo /opt/fitgridweb/ops/backup.sh
```

备份完成必须同时存在加密 dump、SHA-256 校验和与元数据文件，并已复制到 `BACKUP_REMOTE_DIR`。备份密钥 `/etc/fitgridweb/backup.key` 必须用另一条安全通道离机保存，不能与数据库备份只放在同一位置。

恢复只能指向明确的非生产数据库：

```bash
sudo /opt/fitgridweb/ops/restore.sh \
  --target 'postgresql://restore_user:密码@隔离数据库主机:5432/fitgridweb_restore_20260901' \
  --backup '/var/lib/fitgridweb/backups/fitgridweb-日期.dump.enc' \
  --confirm
```

脚本拒绝当前生产连接、同端点生产库和 `postgres/template0/template1`。上线前至少完成一次空库恢复、两账号 owner 隔离和黄金算法抽查。

## 停用或卸载而不删数据

只停服务，不删除容器、卷和配置：

```bash
sudo systemctl disable --now fitgridweb
cd /opt/fitgridweb
sudo docker compose --project-name fitgridweb \
  --env-file /etc/fitgridweb/fitgridweb.env \
  -f docker-compose.yml -f docker-compose.low-memory.yml stop app db
```

不要运行 `docker compose down -v`，也不要删除名为 `fitgridweb_postgres_data` 的卷。确认已有可恢复的异机备份后，才可另行安排数据销毁。nginx include、systemd unit、环境文件、Swap 和 Docker 软件的删除属于人工卸载步骤，必须逐项核对；安装器不会自动删除它们。

## 生产验收清单

- GHCR 完整 SHA 镜像可以匿名 `docker manifest inspect`；
- 安装后回环和公网健康检查均通过；
- `systemctl restart fitgridweb` 后仍健康；
- VPS `reboot` 后自动恢复；
- 创建两个用户并完成跨 owner 404/数据隔离测试；
- 生成加密异机备份并在隔离数据库完成恢复；
- 观察内存、Swap、磁盘和容器 OOM 状态至少一个使用周期。
