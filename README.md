# FitGridWeb

F.I.T Grid Web 是对 Android `FitProj` v2.1.0 网格交易能力的 Web 迁移项目，目标覆盖手机与 PC，并提供私有邀请账号、强制数据隔离、Android JSON 兼容和可恢复的 VPS 部署。

服务端已经实现：Better Auth 标准数据库会话、私有邀请、管理员账号状态、owner 范围内的网格 CRUD、Android v2.1.0 权威计算、严格 JSON 导入、Android/Web 双格式导出、PostgreSQL FORCE RLS 和 `/api/v1` OpenAPI 路由。技术与验收基线请从 [安卓审计与 Web 复刻技术文档](docs/fit-replication/README.md) 开始阅读；服务端实施顺序记录在 [实施计划](docs/superpowers/plans/2026-09-01-fitgridweb-server.md)。

Android 源仓库仅作为只读行为参考，不属于本仓库，也不得把 Web 代码提交到 Android 仓库。

## 本地服务端开发

需要 Node.js 22.12+、pnpm 11 和 PostgreSQL 17。复制 `.env.example` 为 `.env`，替换全部占位秘密，并确保运行连接使用无 `BYPASSRLS` 的受限账号。

```bash
pnpm install
pnpm prisma generate
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

生产环境先将 `.env.example` 复制为权限 `600` 的 `.env`，使用固定提交标签填写 `APP_IMAGE`，然后运行：

```bash
./ops/deploy.sh
./ops/backup.sh
./ops/restore.sh --target 'postgresql://.../fitgridweb_restore' --backup '/path/to/file.dump.enc' --confirm
```

部署脚本在迁移失败时不会启动新应用；备份只有完成 dump、可读性检查、加密、校验及异地目录复制后才执行保留期清理；恢复脚本拒绝生产连接和 PostgreSQL 默认维护库。完整流程见 [部署与运维文档](docs/fit-replication/07-deployment-and-operations.md)。
