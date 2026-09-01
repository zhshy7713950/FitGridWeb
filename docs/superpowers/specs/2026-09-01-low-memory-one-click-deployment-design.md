# FitGridWeb 低内存生产环境一键部署设计

## 1. 目标与已确认约束

本设计面向一台 Ubuntu 24.04 VPS：2 个虚拟 CPU、2 GiB RAM、20 GiB 磁盘，预计只有 1–2 人偶尔使用 FitGridWeb。宿主机同时运行现有 `sing-box` 和 nginx，FitGridWeb 挂载在现有 HTTPS 域名的固定子路径 `/fitgrid`，不独占或写死公网 `80/443`。

交付目标是：运维人员下载并运行一个交互式安装脚本后，由脚本安装依赖、生成秘密、配置低内存容器、接入现有 nginx、执行迁移、创建首个管理员、验证服务，并配置 VPS 重启后的自动恢复。安装过程不得覆盖 sing-box，也不得无备份地修改 nginx 或已有 FitGridWeb 数据。

## 2. 采用的架构

GitHub Actions 在 GitHub 托管 runner 上构建固定 `basePath=/fitgrid` 的 Next.js standalone 镜像，并以不可变提交标签发布到公开 GHCR：

```text
ghcr.io/zhshy7713950/fitgridweb:sha-<40位Git提交>
```

VPS 不执行 `next build`。运行链路为：

```text
浏览器
  -> 现有 nginx 的 https://<domain>:<public-port>/fitgrid/*
  -> 127.0.0.1:<app-port>
  -> Next.js standalone 容器
  -> Compose 私有网络中的 PostgreSQL 17 容器
```

宿主机 nginx 是唯一 Web 反向代理；低内存部署不启动 Caddy。PostgreSQL 不发布宿主机端口。Next.js 仅绑定 IPv4 loopback，默认端口为 `3300`，端口由安装器交互配置。

GHCR 包在第一次发布后必须设为公开。安装器在修改系统前先执行匿名镜像清单检查；若包不可公开拉取则立即停止，不索取或保存 GitHub Token。

## 3. 子路径和认证行为

Next.js 构建配置固定为：

```text
basePath=/fitgrid
```

所有页面、静态资源和 API 都位于该前缀下，例如：

```text
/fitgrid/api/v1/health
/fitgrid/api/v1/auth/login
/fitgrid/api/v1/grid-trades
```

运行环境设置：

```text
APP_BASE_PATH=/fitgrid
BETTER_AUTH_URL=https://<domain>[:<public-port>]/fitgrid
```

Better Auth 仍使用标准数据库 Session。生产 Session Cookie 的 Path 改为 `/fitgrid`，继续保持 `HttpOnly`、`Secure` 和 `SameSite=Lax`。nginx 必须把原始 `Host`（包括非标准端口）、HTTPS 协议和客户端地址传给应用，从而保持现有同源写请求检查有效。

## 4. GitHub 镜像流水线

新增 GitHub Actions workflow，在以下事件构建：

- 推送到 `main`；
- 推送形如 `v*` 的发布标签；
- 手工触发。

workflow 使用 BuildKit cache，传入构建参数 `NEXT_BASE_PATH=/fitgrid`，只构建 `linux/amd64`，以完整 Git SHA 发布不可变标签。发布标签可额外获得相同版本标签，但 VPS 环境文件最终只保存 SHA 标签。workflow 必须运行测试、类型检查和生产构建后才能推送镜像。

## 5. 一键安装器

入口文件为 `ops/install-production.sh`。推荐调用方式是先下载、查看，再以 root 执行，避免直接把网络内容管道输入 shell：

```bash
curl -fsSLo /tmp/fitgridweb-install.sh \
  https://raw.githubusercontent.com/zhshy7713950/FitGridWeb/main/ops/install-production.sh
sudo bash /tmp/fitgridweb-install.sh
```

安装器仅支持 Ubuntu 24.04 x86_64，必须以 root 运行。它交互收集：

- HTTPS 域名；
- 现有 nginx HTTPS 监听端口，默认 `443`，只验证、不重写 listen；
- 只包含一个目标 `server {}` 的 nginx 站点文件；
- 应用 loopback 端口，默认 `3300`；
- Git ref 或完整提交，默认 `main`；
- 是否把总 Swap 扩充到 2 GiB；
- 是否在部署成功后创建首个管理员。

脚本把仓库安装到 `/opt/fitgridweb`，持久配置放在 `/etc/fitgridweb/fitgridweb.env`，备份目录默认为 `/var/lib/fitgridweb/backups`。重复运行执行幂等升级：保留数据库卷和既有秘密，仅更新仓库、镜像与受管配置。

## 6. 依赖与主机准备

安装器执行以下主机检查：

- Ubuntu 版本、架构、至少 1.5 GiB 总内存、至少 8 GiB可用磁盘；
- 目标应用端口当前未被其他进程占用，或已由 FitGridWeb 占用；
- nginx 站点文件存在、只有一个 server block、包含目标域名和输入的监听端口；
- 现有 HTTPS 地址可连接；
- 不打印 `.env`、数据库 URL、密码、Cookie 或 token。

脚本通过 Docker 官方 apt 仓库安装或升级 Docker Engine、Compose plugin、Git、curl、OpenSSL、CA 证书、nginx 和必要的基础工具。它启用 Docker 和 nginx systemd 服务，但不重写 nginx 的全局配置。

若用户同意扩充 Swap，脚本只在当前 Swap 小于 2 GiB 时创建 `/swapfile-fitgridweb` 补足差额，设置权限 `600`，执行 `mkswap`/`swapon`，并以受管标记幂等写入 `/etc/fstab`。它不删除或缩小现有 Swap。

## 7. 生产配置与秘密

首次安装使用 `openssl rand -hex 32` 分别生成：

- PostgreSQL migration/owner 密码；
- PostgreSQL 受限运行账号密码；
- `BETTER_AUTH_SECRET`；
- `OWNER_REF_SECRET`；
- `CURSOR_SIGNING_SECRET`。

秘密之间不得相同。环境文件权限必须为 `600`，目录权限为 `700`。升级时若文件已存在且通过校验，不重新生成秘密，避免会话失效、ownerRef 变化或数据库失联。

配置记录固定 SHA 镜像、域名、公众 HTTPS 端口、应用本地端口、`/fitgrid`、数据库连接和备份路径。脚本输出只显示非秘密字段及秘密文件路径。

## 8. 低内存 Compose 配置

新增独立的低内存 Compose overlay，仅启动 `db` 和 `app`：

### PostgreSQL

- 容器内存上限：512 MiB；
- CPU 上限：0.75 核；
- `shared_buffers=128MB`；
- `effective_cache_size=512MB`；
- `work_mem=4MB`；
- `maintenance_work_mem=64MB`；
- `max_connections=30`；
- `max_wal_size=512MB`；
- 健康检查和 `restart: unless-stopped`；
- 数据使用命名卷，数据库端口不发布。

### Next.js

- 容器内存上限：640 MiB；
- CPU 上限：1.0 核；
- `NODE_OPTIONS=--max-old-space-size=512`；
- 单实例运行；
- 只发布 `127.0.0.1:<app-port>:3000`；
- 只读根文件系统和 64 MiB `/tmp`；
- 健康检查路径 `/fitgrid/api/v1/health`；
- `restart: unless-stopped`。

常态目标是给 Ubuntu、Docker、nginx、sing-box、文件缓存和瞬时峰值保留约 400–700 MiB；容器上限用于阻止单个服务失控，并不代表两个容器应同时达到上限。若运行期持续出现容器 OOM、Swap 持续增长或 `MemAvailable` 低于 400 MiB，应升级到 4 GiB，而不是继续提高容器限制。

## 9. nginx 安全修改

安装器创建 `/etc/nginx/snippets/fitgridweb-location.conf`，内容包括：

- `/fitgrid` 到 `/fitgrid/` 的永久重定向；
- 保留 `/fitgrid` 前缀的 `proxy_pass http://127.0.0.1:<app-port>`；
- 10 MiB 请求体上限；
- `Host`/`X-Forwarded-Host` 使用原始 host 和端口；
- `X-Forwarded-Proto=https`；
- `X-Forwarded-For` 和 WebSocket 头；
- 关闭代理缓冲以兼容 Next.js streaming；
- 合理的连接、读取和发送超时。

安装器只向用户选择的单-server站点文件插入一行带受管标记的 include。修改前把站点文件和已有同名 snippet 复制到带 UTC 时间戳的备份目录。写入后运行 `nginx -t`：失败时原子恢复两个文件并再次验证；成功后使用 reload，不中断其他 nginx 站点。重复安装不得产生重复 include 或 location。

## 10. 迁移、启动和管理员

安装/升级顺序固定为：

1. 匿名验证 SHA 镜像可拉取；
2. 保存旧 `APP_IMAGE`；
3. 拉取新镜像和固定 PostgreSQL 镜像；
4. 启动 db 并等待健康；
5. 使用 migration URL 执行 `prisma migrate deploy`；
6. migration 成功后更新 app；
7. 等待容器内部健康；
8. 写入并验证 nginx；
9. 检查 loopback 和公网 `/fitgrid/api/v1/health`；
10. 首次部署时运行交互式 `pnpm admin:create`。

迁移失败时不更新 app。新 app 健康失败时恢复旧 SHA 并重新启动旧 app；数据库 migration 不执行危险的自动逆向 SQL，因此所有 migration 必须保持旧版本可启动的向后兼容性。

## 11. 开机自动恢复

Docker 和 nginx 都执行 `systemctl enable --now`。新增 `/etc/systemd/system/fitgridweb.service`：

- `Requires=docker.service`；
- `After=network-online.target docker.service`；
- `Wants=network-online.target`；
- `ExecStart` 使用低内存 Compose 文件执行 `up -d --wait db app`；
- `ExecStop` 只停止 app/db，不删除卷；
- `RemainAfterExit=yes`。

容器自身同时使用 `restart: unless-stopped`，处理单容器异常退出；systemd 负责整机重启后的 Compose 恢复。安装器执行 `systemctl daemon-reload`、`enable --now fitgridweb.service`，再做一次 `restart fitgridweb.service` 与健康检查，但不自动重启整台 VPS。nginx reload 失败不能影响 sing-box。

## 12. 备份、升级与日常命令

安装器保留现有加密备份和显式恢复保护。备份密钥存放在 `/etc/fitgridweb/backup.key`，权限 `600`，不会随 Git 或数据库备份复制。`BACKUP_REMOTE_DIR` 必须由用户配置为异机挂载或独立故障域；未配置时安装器明确标记“灾难恢复未完成”，但不伪造备份成功。

安装完成后输出以下受管命令：

```bash
systemctl status fitgridweb
journalctl -u fitgridweb
docker compose --env-file /etc/fitgridweb/fitgridweb.env ps
/opt/fitgridweb/ops/install-production.sh --upgrade
/opt/fitgridweb/ops/backup.sh
```

升级仍要求固定 SHA。磁盘达到 70% 时告警，达到 85% 时安装/升级中止。镜像清理只删除 FitGridWeb 的未使用旧镜像，不执行全局 `docker system prune`。

## 13. 错误处理与审计

脚本使用 POSIX shell 严格模式、带权限的临时目录和明确的退出码。每个外部变更前先验证目标：nginx 文件、应用端口、环境文件、Swap 文件、systemd unit 和 Compose project name 都必须是精确路径或固定名称。

日志只记录步骤、版本、耗时和公开健康状态。命令失败时给出恢复位置和诊断命令，不输出秘密。脚本不修改 SSH、防火墙、sing-box、其他 nginx server、其他 Docker project 或全局 Docker 数据。

## 14. 测试与验收

自动化测试使用临时目录和伪命令验证：

- 不支持的系统、内存不足、磁盘不足、端口冲突和私有镜像在任何写入前失败；
- 首次生成秘密，重复运行保留秘密；
- Swap 只补足且 `/etc/fstab` 不重复；
- nginx 单-server校验、幂等插入、`nginx -t` 失败恢复；
- migration 失败不更新 app；
- app 健康失败恢复旧 SHA；
- systemd unit 包含正确依赖、Compose 文件和启用行为；
- Compose overlay 不启动 Caddy、不发布数据库端口，并包含内存/CPU/PostgreSQL参数；
- workflow 使用 `/fitgrid` 构建参数和完整 SHA 镜像标签；
- `/fitgrid/api/v1/health`、Session Cookie Path 和同源请求在生产构建中正确。

本机门禁继续运行 `pnpm test`、类型检查、Lint、Next.js production build、shell 语法检查和 `git diff --check`。真实发布门禁必须在一台干净的 2 vCPU/2 GiB Ubuntu 24.04 VPS 上完成安装、重启服务、整机重启、升级、回滚、账号隔离、备份和空库恢复演练。

## 15. 非目标

- 不自动申请或替换现有域名的 TLS 证书；目标 nginx server 必须已经可通过 HTTPS 工作。
- 不把 FitGridWeb 挂载到可变子路径；首期固定 `/fitgrid`。
- 不配置多实例、负载均衡、Redis 或外部 PostgreSQL。
- 不修改 sing-box、SSH 或防火墙规则。
- 不把 2 GiB 主机描述为高并发环境；出现持续资源压力时直接升级内存。
