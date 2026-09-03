# FitGridWeb

F.I.T Grid Web 是对 Android `FitProj` v2.1.0 网格交易能力的 Web 迁移项目，目标覆盖手机与 PC，并提供私有邀请账号、强制数据隔离、Android JSON 兼容和可恢复的 VPS 部署。

服务端已经实现：Better Auth 标准数据库会话、私有邀请、管理员账号状态、owner 范围内的网格 CRUD、Android v2.1.0 权威计算、严格 JSON 导入、Android/Web 双格式导出、PostgreSQL FORCE RLS 和 `/api/v1` OpenAPI 路由。技术与验收基线请从 [安卓审计与 Web 复刻技术文档](docs/fit-replication/README.md) 开始阅读；服务端实施顺序记录在 [实施计划](docs/superpowers/plans/2026-09-01-fitgridweb-server.md)。

Android 源仓库仅作为只读行为参考，不属于本仓库，也不得把 Web 代码提交到 Android 仓库。

## 本地前端调试

只检查登录页、应用框架、响应式布局、搜索和分页时，不需要 PostgreSQL、Docker 或生产镜像：

```bash
pnpm install
pnpm dev:ui
```

浏览器打开 `http://localhost:3000/login`，使用演示账号 `demo` 和密码 `fitgrid-demo`。该模式提供 24 条只读演示产品，覆盖 20 条首屏、第二页、名称/代码搜索、桌面表格和手机卡片；修改代码后由 Next.js 自动热更新。演示模式只在 `next dev` 下生效，生产构建检测到 `NEXT_PUBLIC_UI_DEMO_MODE=1` 会直接失败，演示账号和数据不会进入 VPS 数据库。

## 本地服务端开发

需要 Node.js 22.12+、pnpm 11 和 PostgreSQL 17。复制 `.env.example` 为 `.env`，替换全部占位秘密，并确保运行连接使用无 `BYPASSRLS` 的受限账号。

```bash
pnpm install
pnpm prisma generate
set -a
. ./.env
set +a
DATABASE_URL="$MIGRATION_DATABASE_URL" pnpm prisma migrate deploy
pnpm admin:create
pnpm dev
```

`admin:create` 仅在数据库没有任何用户时工作，并从隐藏的终端输入读取密码。后续账号必须由管理员创建一次性邀请。

## 验证

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

设置 `TEST_DATABASE_URL` 后会额外运行真实 PostgreSQL 的 RLS 隔离测试；未设置时该项会明确跳过。

## VPS 部署与恢复

面向 2 vCPU/2 GiB、已有 `sing-box + nginx` 的 Ubuntu 24.04 VPS，使用固定 `/fitgrid` 子路径的一键安装器。它自动安装 Docker 依赖、生成并保留秘密、配置低内存 PostgreSQL/Next.js、接入用户选择的现有 nginx HTTPS vhost，并安装 `fitgridweb.service` 实现重启自动恢复：

```bash
curl -fsSLo /tmp/fitgridweb-install.sh \
  https://raw.githubusercontent.com/zhshy7713950/FitGridWeb/main/ops/install-production.sh
less /tmp/fitgridweb-install.sh
sudo sh /tmp/fitgridweb-install.sh
```

镜像必须是公开 GHCR 中的完整 commit SHA，应用只绑定 `127.0.0.1:<可配置端口>`，数据库不暴露端口，低内存部署不启动 Caddy。迁移失败时不会更新应用，新应用健康失败时恢复旧 SHA，但不会执行危险的数据库逆向迁移。

逐步操作、升级、nginx 恢复、开机验收、内存观察、备份与隔离恢复见 [2 GiB VPS 一键部署与运维手册](docs/fit-replication/low-memory-vps-runbook.md)；完整架构约束见 [部署与运维文档](docs/fit-replication/07-deployment-and-operations.md)。
