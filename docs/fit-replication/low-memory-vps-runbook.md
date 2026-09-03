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
- `/var/lib/fitgridweb/admin-ops/web`：UID/GID 1001 的任务 inbox、upload 和公开 status；
- `/var/lib/fitgridweb/admin-ops/root`：root-only `0700` 的 authoritative marker、prepared、work、completed、intervention 和审计状态；
- `/var/lib/fitgridweb/portable-backups`：root 拥有、GID 1001 可读的便携备份目录；完成文件模式 `0640`；
- `/etc/nginx/snippets/fitgridweb-location.conf`：受管 `/fitgrid` 代理片段；
- `/etc/nginx/conf.d/fitgridweb.conf`：自动创建或复用的单-server专用 vhost，只使用现有域名证书；
- `/var/backups/fitgridweb/nginx`：nginx 修改前的带时间戳备份；
- `/etc/systemd/system/fitgridweb.service`：开机恢复 `db app`；
- `/etc/systemd/system/fitgridweb-maintenance.{path,service}`：监听固定 inbox 并以 root 串行执行维护任务；path 会默认启用；
- `/etc/systemd/system/fitgridweb-backup.{timer,service}`：已安装的每日异机备份 unit；只有真实异机挂载通过安装检查时才启用 timer；
- `/etc/logrotate.d/fitgridweb-ops`：模式 `0600`，轮转 root-only audit 180 天；
- 用户同意且现有 Swap 不足时：`/swapfile-fitgridweb` 和 `/etc/fstab` 中的一条受管记录；
- Docker 官方 apt source、Docker Engine/Compose plugin、`jq`、`util-linux`，以及通过固定 SHA-256 校验的官方 age v1.3.2 `age`/`age-plugin-batchpass` 二进制对；匹配版本已存在时幂等跳过下载。

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

## 两类完整备份：不要混用密码或保留策略

用户级 Android/Web JSON 导出只覆盖当前账号，不能恢复认证、邀请、其他账号、RLS 或迁移记录。完整数据库有两条互补路径：

| 路径 | 加密与解密材料 | 保存位置与保留 | 适用场景 |
|---|---|---|---|
| 网页或 `backup-portable.sh` 便携备份 | 操作者另设的 12–128 字符密码；官方 age v1.3.2 + `age-plugin-batchpass`，密码仅走文件描述符 | `/var/lib/fitgridweb/portable-backups`，网页与 CLI 共用同一历史，最多 5 份成功文件 | 浏览器下载、上传预检、整库恢复、更换 VPS |
| `backup.sh` 无人值守异机备份 | `/etc/fitgridweb/backup.key`；AES-256-CBC/PBKDF2 | 本机 `/var/lib/fitgridweb/backups` 按 `BACKUP_RETENTION_DAYS` 清理，并复制到 `BACKUP_REMOTE_DIR`；不进入网页历史、不受 5 份限制 | 每日定时、主机丢失后的异机恢复 |

便携备份密码不是管理员登录密码，也不是 `backup.key`。把 `.fitgridbackup` 与其密码放在不同的受控位置；密码只进受信密码管理器或离线保管，不要放入文件名、命令参数、shell history、工单、聊天或与备份同位置的文本文件。忘记便携密码时无法恢复该文件。服务器密钥也必须通过与异机备份不同的安全通道离机保存。

## 管理员网页：创建、下载、上传预检和整库恢复

1. 以 `active admin` 登录 `https://你的域名[:非标准HTTPS端口]/fitgrid/admin`，进入“数据保险库”。普通用户、匿名用户和 disabled admin 均不能调用维护接口。
2. 点击“创建备份”，输入当前管理员密码、独立备份密码和再次确认。独立密码必须为 12–128 个 Unicode 字符且两次相同。页面不会把密码写入浏览器存储；提交后字段会清空。
3. 等待状态依次经过“正在生成 → 正在加密 → 可以下载”。主机先检查可用空间至少为数据库估算值的四倍再加 256 MiB，以覆盖 dump、密文、解密校验 tar 与解出的校验 dump 同时存在的峰值。v2 只生成 data-only custom dump，排除 `_prisma_migrations`，并逐条限制 TOC；内部 SHA-256、age + batchpass 加密、解密复检、reader 权限与归档/父目录文件系统同步屏障全部成功后才发布历史和 `ready`。同步使用 Ubuntu GNU `sync -f` 的文件系统级屏障，不是逐文件 `fsync`；任一同步失败即任务失败。
4. “历史备份”只显示成功且文件仍存在、大小匹配的最近 5 份，按时间倒序显示 Asia/Shanghai 时间、IEC 大小、SHA-256 前 12 位和下载按钮。第 6 份通过全部检查后才删除最旧一份；失败文件不占名额。网页和 CLI 创建的便携备份共用这 5 个名额。
5. 点击“下载”。页面先申请绑定当前管理员与该备份的 60 秒单次令牌，再由浏览器直接流式下载；重放、过期、换管理员或换备份均返回 404。下载不会删除服务器副本。下载后运行 `sha256sum /安全路径/fitgridweb-YYYYMMDDTHHMMSSZ.fitgridbackup`，与历史行完整 SHA-256 的悬停提示逐字比较；前 12 位只用于快速识别。
6. 恢复时选择文件名形如 `fitgridweb-YYYYMMDDTHHMMSSZ.fitgridbackup` 的文件，输入该文件的独立备份密码，点击“上传并检查”。默认上传上限为 536870912 字节（512 MiB），nginx 与应用都限制大小；上传和解密采用流式处理。
7. 预检在生产替换前完成。错误密码、损坏密文、非法/额外/重复 tar 成员、路径穿越、内部摘要不匹配、旧 v1/未知格式、PostgreSQL 主版本不匹配、不可读 dump，或 TOC 含 PRE-DATA、POST-DATA、FUNCTION、ACL、DDL、迁移记录及任何 allowlist 外对象，都会以失败结束，不修改生产数据库。成功页面只显示服务端公开并验证的备份时间、PostgreSQL 主版本、数据库名、用户/网格产品/邀请/导入预检数和完整性结果；当前公开状态不会显示 manifest 的应用镜像或服务器验证的归档大小。
8. 预检挑战固定 10 分钟有效并绑定管理员、请求与已验证 dump 摘要。页面打开不等于无限续期；超时后重新上传预检。点击“恢复全部数据”，再次输入当前管理员密码，并逐字输入 `恢复全部数据`。服务器接受后对话框锁定，预计会短暂离线，页面显示“服务器正在恢复数据，请勿关闭页面”。
9. 执行器重新校验准备区 data-only TOC，先用服务器 `backup.key` 创建并验证本次恢复前受信任完整快照，之后才停止 `app`、终止运行角色连接、删除并重建 `public` schema、运行已审核版本的 Prisma migrations，再以 `pg_restore --data-only --no-owner --no-privileges --exit-on-error --single-transaction` 导入业务数据，删除全部 `sessions`、启动应用并检查回环与公网健康。恢复成功会清除所有登录状态并转到 `/fitgrid/login`；临时管理员可能已被备份数据库替换，必须用备份中的管理员登录。若失败，自动回滚仍使用刚创建的受信任完整快照，而不是放宽上传文件 allowlist。

当前恢复执行器的公网健康地址固定为 `https://$DOMAIN/fitgrid/api/v1/health`，没有拼接 `PUBLIC_HTTPS_PORT`。因此网页生产恢复目前只支持公网 443 上可访问该地址的部署；若 FitGridWeb 只在非标准 HTTPS 端口提供服务，不要开始生产恢复，应先修正并重新验收执行器。

底层 HTTP 顺序是 `POST /api/v1/admin/backups` → `GET /api/v1/admin/maintenance/jobs/{id}` → `POST /api/v1/admin/backups/{id}/download-token`/`GET .../download?token=...`；恢复是 raw-stream `POST /api/v1/admin/restores/uploads?fileName=...` → 轮询 job → `POST /api/v1/admin/restores/{inspectionId}/confirm` → 继续轮询。正常操作应使用页面，不能绕过同源、重新验证和单次令牌边界自行拼请求。

## 主机交互式便携备份

在真实 TTY 中运行；脚本拒绝非 root 或标准输入不是 TTY 的调用：

```bash
sudo /opt/fitgridweb/ops/backup-portable.sh
```

按提示隐藏输入两次相同的独立备份密码。过短、过长或不一致会重新提示。成功时退出码为 0；脚本不打印密码，也不保证打印生成文件名，因此以网页“历史备份”或下列只读检查确认结果：

```bash
sudo ls -lt /var/lib/fitgridweb/portable-backups
systemctl status fitgridweb-maintenance.path --no-pager
journalctl -u fitgridweb-maintenance.service --since today --no-pager
```

CLI 与网页使用相同的 v2 data-only 格式、目录、历史索引和最近 5 份规则。它只生成同机便携副本，不会复制到 `BACKUP_REMOTE_DIR`。底层官方 batchpass 插件只从受限文件描述符读取密码；不要把密码放入管道、普通环境变量或命令行，也不要尝试从无 TTY 的 cron/systemd 调用该脚本。

## 配置真正的异机定时备份

首次安装将 `BACKUP_REMOTE_DIR` 留空并禁用 timer，打印“自动异机备份未启用：请配置并挂载 BACKUP_REMOTE_DIR”。先由系统管理员建立持久的 NFS/块存储/其他故障域挂载；同一 VPS 根磁盘上的普通目录不合格。然后：

```bash
sudoedit /etc/fitgridweb/fitgridweb.env
sudo realpath /mnt/fitgridweb-offsite
sudo test -d /mnt/fitgridweb-offsite
sudo test ! -L /mnt/fitgridweb-offsite
sudo test -w /mnt/fitgridweb-offsite
findmnt --target / --noheadings --output MAJ:MIN
findmnt --target /mnt/fitgridweb-offsite --noheadings --output MAJ:MIN
```

把 `BACKUP_REMOTE_DIR=/mnt/fitgridweb-offsite` 写入环境文件并保持文件模式 `600`。`realpath` 必须成功且仍是预期路径；两个 `findmnt` 的 `MAJ:MIN` 必须非空且不同。安装/升级流程运行时的启用检查还要求安全的绝对路径、非 `/`、现有目录、非符号链接、root 可写；systemd timer 和 service 本身不运行这项检查。无论首次手工启用还是掉挂载后的重新启用，都要当场重新执行上面的 `realpath`、`test` 和 `findmnt` 命令，再手工运行一次并核验远端副本：

```bash
sudo /opt/fitgridweb/ops/backup.sh
cd /mnt/fitgridweb-offsite
sha256sum -c fitgridweb-fitgridweb-YYYYMMDDTHHMMSSZ.dump.enc.sha256
```

期望脚本打印 `Backup complete: fitgridweb-fitgridweb-YYYYMMDDTHHMMSSZ`，远端校验打印对应 `.dump.enc: OK`；同名 `.json` 元数据也应存在。只有这一整套检查成功后才启用每日定时器。`systemctl enable --now` 只启用并启动 timer，不会验证 `BACKUP_REMOTE_DIR`：

```bash
sudo systemctl enable --now fitgridweb-backup.timer
systemctl status fitgridweb-backup.timer --no-pager
systemctl list-timers fitgridweb-backup.timer --no-pager
journalctl -u fitgridweb-backup.service --since today --no-pager
```

timer 的计划是每天 02:30，`Persistent=true`，随机延迟最多 10 分钟。只有安装/升级流程会在当次流程中验证挂载；直接启用 timer 没有验证步骤，`backup.sh` 自身还会 `mkdir -p`，不能识别后来掉线的挂载。必须监控挂载和日志；挂载失效、只读或目标设备变回根设备时立即禁用，避免把“远端”副本写回本机根盘：

```bash
sudo systemctl disable --now fitgridweb-backup.timer
systemctl status fitgridweb-backup.timer --no-pager
```

修复后必须重新执行上述 `realpath`/`test`/`findmnt`/手工备份/远端 checksum 全流程，才能再次 `enable --now`；不能把直接重新启用 timer 当作验证。若通过安装器的 `--upgrade` 流程重新部署，安装器会在该次升级中执行同样的目录/设备检查并据此启用或禁用 timer，但后续每次手工重启 timer 仍不带检查。`backup.sh` 在本机保存加密 dump、`.sha256` 和 `.json`；只有远端复制及远端摘要校验成功后，才按 `BACKUP_RETENTION_DAYS`（默认 180）删除本机过期匹配文件。它不清理远端历史，远端保留/不可变策略由存储侧负责。

维护执行器日常检查：

```bash
systemctl status fitgridweb-maintenance.path --no-pager
systemctl status fitgridweb-backup.timer --no-pager
journalctl -u fitgridweb-maintenance.service --since today --no-pager
journalctl -u fitgridweb-backup.service --since today --no-pager
```

## 恢复失败、自动回滚和人工介入

失败处理取决于生产库是否已经进入替换路径：

- 替换前失败：准备目录、权限、challenge、摘要、hard-link claim 或 `pg_restore --list` 验证失败，worker 直接返回对应 `PREPARED_*`/`CHALLENGE_*` 失败；恢复前快照的 dump、可读性、加密或解密复检失败则返回 `SNAPSHOT_FAILED`。此时生产数据库没有被替换，不执行回滚。
- 替换路径失败：只有恢复前快照成功、维护标记建立并进入停应用/替换生产库路径后，后续 restore、migration、session 清除、启动或健康检查失败才自动尝试一次回滚，不会重试第二次。
- 回滚成功：维护标记被清除，应用重新健康；job 状态为 `failed`、代码 `RESTORE_FAILED`、`rolledBack=true`。这表示原数据已恢复，不表示请求的备份已恢复成功。
- 恢复与这一次回滚都失败，或恢复在维护阶段被重启/中断，或关键 marker/status/终态记录无法可靠发布：状态为 `intervention-required`，常见代码包括 `ROLLBACK_FAILED`、`RESTORE_INTERRUPTED`、`MARKER_CLEAR_FAILED`、`STATUS_PUBLISH_FAILED` 或 `TERMINAL_STATE_WRITE_FAILED`。root 权威维护标记保持 active，worker 重启后也不会自动继续或再次回滚。

先记录页面 request ID/job ID，并只做读取和取证：

```bash
systemctl status fitgridweb-maintenance.path --no-pager
systemctl status fitgridweb-maintenance.service --no-pager
journalctl -u fitgridweb-maintenance.service --since today --no-pager
sudo cat /var/lib/fitgridweb/admin-ops/root/maintenance.json
sudo cat /var/lib/fitgridweb/admin-ops/web/status/JOB_ID.json
sudo find /var/lib/fitgridweb/admin-ops/root/intervention/JOB_ID -maxdepth 1 -type f -printf '%M %u:%g %p\n'
```

有效保留目录为 root 拥有的 `0700` 目录，至少含只读 `0400 job.json`；如果恢复前快照已经生成，还会含 `0400 rollback.dump.enc`，它由当前 `/etc/fitgridweb/backup.key` 加密。立即备份主机/块存储快照并保护该 key，但不要在故障主机上试验性解密或覆盖数据库。

仓库没有通用的“解除 intervention”或“继续恢复”命令。不要手工删除/编辑 `maintenance.json`，不要删除 `intervention/JOB_ID`，不要改权限，不要盲目重启 app/worker，也不要把 `rollback.dump.enc` 直接交给 `pg_restore`。由能审阅 journal、当前数据库状态和保留快照的数据库负责人决定唯一权威数据线；无法证明原地恢复安全时，在新的隔离 VPS 上从最后一份已验证的便携或异机备份恢复并验收，再切换 DNS。

## 每季度隔离恢复演练

演练环境必须是独立、可销毁的 VPS/VM 或 Docker 主机，不得与生产共用 Compose project、卷、环境文件、端口、挂载或 DNS。仓库脚本内部固定使用 Compose project 名 `fitgridweb`；仅给外层命令加 `--project-name fitgridweb-drill` 不能改变脚本目标。因此脚本级演练应在一台没有任何既有 `fitgridweb` project/volume 的独立主机进行，不能在生产 Docker 主机上冒险。

每季度至少完成：

1. 记录 reviewed commit SHA、待测备份 UTC `createdAt`、演练开始 UTC、配置的镜像引用和实际 `SELECT version()` 输出；先检查主机不存在任何既有 FitGrid project/volume。
2. 创建两个账号 A/B、一个管理员和已知网格产品；记录用户、产品、邀请和导入预检数，A/B 使用相同产品代码。创建并下载便携备份，另算外层 SHA-256。
3. 在演练数据库增加或删除可识别数据，证明当前状态已经偏离恢复点；上传备份、等待预检并逐项核对备份时间、PostgreSQL 主版本、数据库和计数。
4. 输入当前临时管理员密码与准确短语 `恢复全部数据`；计时从最终确认被接受开始，到公网健康、备份内管理员重新登录和关键功能通过为止。确认旧会话及临时管理员会话失效。
5. 核验恢复后的原始计数；以 A/B 分别登录并验证列表隔离、跨 owner UUID 为 404、相同代码可跨 owner 共存；导入 Android v2.1.0 样本并抽样重算，与 `docs/fit-replication/fixtures/grid-algorithm-v2.1.0.json` 对比。
6. 记录 `free -h`、`docker stats --no-stream`、OOM 状态和 app 640 MiB/db 512 MiB 限制下的峰值，完成回环及公网 `/fitgrid/api/v1/health` 检查。
7. 先列出并复核演练 project/volume 的准确名称，再仅按演练主机的销毁流程清理；绝不执行会命中生产的 `docker compose down -v`。

记录模板（没有实际测量就写“未测量”，不能填配置值冒充实测）：

```text
演练日期/操作者：
隔离主机/项目标识：
reviewed commit SHA / 实际 APP_IMAGE digest：
实际 PostgreSQL version()：
备份 createdAt / 最后包含写入时间 / 恢复确认时间 / 完成时间：
实际 RPO / 实际 RTO：
外层 SHA-256 / 内部预检：
恢复前后 users/gridTrades/invitations/importPreviews：
会话清除、RLS、Android v2.1.0 重算、健康、2 GiB 内存结果：
清理前 project/volume 清单与清理结果：
结论、故障代码与跟进：
```

`ops/restore.sh` 是服务器密钥备份的隔离数据库工具，不是网页便携备份恢复器。它只能指向明确的非生产数据库：

```bash
sudo /opt/fitgridweb/ops/restore.sh \
  --target 'postgresql://restore_user:密码@隔离数据库主机:5432/fitgridweb_restore_YYYYMMDD' \
  --backup '/var/lib/fitgridweb/backups/fitgridweb-fitgridweb-YYYYMMDDTHHMMSSZ.dump.enc' \
  --confirm
```

脚本要求旁边存在同名 `.sha256`，拒绝当前生产连接、同端点生产库和 `postgres/template0/template1`。URI 中的密码会出现在命令参数/history，因此生产演练应使用受控的临时演练凭据和受限 shell 处理；不要把真实生产秘密复制进文档或工单。

## 完整更换 VPS

1. 至少提前一个 DNS TTL 周期降低 TTL。记录旧 VPS 当前完整 commit SHA、`APP_IMAGE`、数据库版本、迁移版本和最新可恢复点；冻结用户写入窗口。网页便携备份的预检不会公开 `appImage`，所以 SHA 必须从部署记录另行核对。
2. 在旧 VPS 创建最终便携备份，下载后核对外层 SHA-256，并把文件和独立备份密码分渠道保管。随后把旧 VPS 置为只读，确保备份时间后的写入不会分叉。
3. 在新 VPS 下载并审阅与旧站完全相同的 reviewed SHA 安装器；安装提示中的 Git ref 输入该完整 SHA，部署对应 `ghcr.io/zhshy7713950/fitgridweb:sha-<同一SHA>`。在空数据库选择创建临时管理员。不要从移动分支下载 root installer 后却声称它是被审核版本：

   ```bash
   REVIEWED_SHA=<旧站已审核的40位commit SHA>
   curl -fsSLo /tmp/fitgridweb-install.sh \
     "https://raw.githubusercontent.com/zhshy7713950/FitGridWeb/$REVIEWED_SHA/ops/install-production.sh"
   less /tmp/fitgridweb-install.sh
   sudo sh /tmp/fitgridweb-install.sh --ref "$REVIEWED_SHA"
   ```

   DNS 仍指向旧站；通过已审核、TLS 有效的运维访问方式打开新站 `/fitgrid/admin`，不要为绕过证书校验把备份密码送入不受信连接。
4. 用临时管理员上传最终 `.fitgridbackup` 和输入独立备份密码。等待“恢复预检已通过”，逐项核对时间、PostgreSQL 主版本、数据库及四项计数，再用临时管理员当前密码和准确短语确认恢复。
5. 恢复成功后所有 session 被删除，临时管理员通常也被整库替换。只用备份内原有管理员重新登录；在确认此账号可用前不得切 DNS。
6. 需要认证/匿名 ownerRef/游标签名连续性时，通过独立安全通道把旧 VPS 的 `BETTER_AUTH_SECRET`、`OWNER_REF_SECRET`、`CURSOR_SIGNING_SECRET` 三个原值分别写入新 VPS `/etc/fitgridweb/fitgridweb.env`；不要覆盖新主机数据库凭据、域名、端口、路径或 backup key。不要用会把秘密打印到终端的 `grep`/`cat` 传递它们；在新机运行：

   ```bash
   sudoedit /etc/fitgridweb/fitgridweb.env
   sudo chmod 600 /etc/fitgridweb/fitgridweb.env
   sudo systemctl restart fitgridweb
   ```

   然后再次用备份内管理员登录。便携恢复本身不需要旧 `/etc/fitgridweb/backup.key`；若还要恢复历史 server-key 异机备份，则须另行保管旧 key。
7. 在新 VPS 验证 loopback/公网健康、管理员登录、A/B owner 隔离、已知网格详情与 Android v2.1.0 重算、导入/导出、维护 path 和异机 timer 状态。确认新主机已配置自己的真实 `BACKUP_REMOTE_DIR` 并完成一次远端 checksum。
8. 只有上述验收全通过才切换 DNS A/AAAA。观察 TLS、健康、登录、HTTP 5xx 和新写入。旧 VPS 至少 72 小时不得再接受写入并保留磁盘/卷不动；仓库没有通用只读切换脚本，若没有经审核的 nginx 写入阻断规则，至少运行 `sudo systemctl stop fitgridweb` 停止旧站 app/db 而保留数据。不要 disable unit、不要删容器/卷。72 小时内回退 DNS 前先确认新站是否已接受写入；两边数据不能自动合并，必须先选定唯一权威时间线。

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
