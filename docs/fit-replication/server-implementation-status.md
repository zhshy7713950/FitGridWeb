# 服务端实现状态与验收追踪

日期：2026-09-03
范围：Next.js `/api/v1`、Better Auth 标准数据库会话、领域算法、PostgreSQL/Prisma、导入导出、前端基础与 VPS 运维资产。

## 状态摘要

- 服务端主体和自动化覆盖已实现；本机门禁已执行，但当前完整结果包含下述 1 个可复现 UI-demo 产品失败，不能整体标记为通过。
- Better Auth 使用 `sessions` 表保存标准数据库会话；浏览器只接收 `HttpOnly`、`Secure`、`SameSite=Lax` Cookie，不向前端返回长期 token。
- 产品查询、冲突检测、游标、导入与导出均绑定会话 owner；`grid_trades` 和 `import_previews` 同时启用 `FORCE ROW LEVEL SECURITY`。
- OpenAPI 中 16 个路径的每个 operationId 都有 Route Handler；Android 与 Web 导出均通过发布的 JSON Schema。
- 已实现 `/fitgrid` 固定生产子路径、Better Auth Cookie Path、GHCR 完整 SHA 流水线、2 GiB 低内存 Compose、现有 nginx 安全集成、迁移前置/应用回滚和 systemd 开机恢复。
- 管理员数据保险库、age 便携备份、最近 5 份下载历史、流式上传预检、整库恢复/单次自动回滚、root-only intervention state、维护 path unit 和可选异机 timer 已实现，相关自动化套件已运行；但完整本机测试门禁当前并非全绿：可复现的 Task 6 `dev:ui` 数据保险库配置问题会令 UI-demo smoke 捕获一次 HTTP 500。它是待修复的产品/demo 配置问题，不是环境跳过。
- 与上述本机测试失败分开，本次 Task 7 主机没有 Docker、age、systemd、`pg_restore` 或 `TEST_DATABASE_URL`，因此真实 PostgreSQL RLS、GHCR 镜像拉取、HTTPS 部署、VPS 重启、真实加解密和生产等价恢复演练仍是发布前环境门控；`pnpm typecheck`、`pnpm lint`、`pnpm build` 和 `git diff --check` 均通过。

## 前端基础

- 登录、会话恢复和受保护布局使用现有 Better Auth 数据库会话；浏览器不读取 token。
- `/grids` 已连接 owner-scoped `GET /api/v1/grid-trades`，覆盖搜索、清除、稳定游标分页和保留数据重试。
- TradingView 风格桌面表格和手机卡片通过组件测试与 `/fitgrid` 生产构建。
- 新增/编辑/详情、导入导出、账号与邀请管理及管理员数据保险库均已接入对应 API；真实数据库浏览器联调仍受下述环境门控。

证据边界：完整自动化门禁和 `/fitgrid` 生产构建已在本机执行；1440×900 与 390×844 浏览器检查覆盖匿名入口、受保护路由回跳、登录键盘顺序、装饰动画、响应式登录布局、静态资源和控制台。当前主机没有 Docker、Podman 或 PostgreSQL 工具，未设置 `DATABASE_URL`/`TEST_DATABASE_URL`，也没有项目环境文件或本地 PostgreSQL 监听，因此没有绕过 Better Auth 会话门禁；登录成功、用户数据隔离、搜索/清除/刷新/加载更多/失败重试/退出和登录后桌面表格/手机卡片仍等待可丢弃的本地 PostgreSQL 环境实跑。当前浏览器控制面也不提供 reduced-motion 模拟；代码中的 `prefers-reduced-motion` 规则和单次动画自动化证据不记作 reduced-motion 浏览器实跑。

## 功能验收

| ID | 自动化证据 | 状态 |
|---|---|---|
| FUN-01 | `grid-service.test.ts`：owner A/B 列表隔离；`grid-workspace.test.tsx`：空账号与搜索无结果分离 | 服务端与前端组件自动化通过；真实登录数据库浏览器验收受环境门控 |
| FUN-02 | `grid-service.test.ts`：名称/代码搜索和清空查询的 owner 范围 | 通过 |
| FUN-03 | `grid-service.test.ts`：`sortOrder, createdAt, id` 稳定分页 | 通过 |
| FUN-04 | `grid-service.test.ts`：创建后直接返回权威计算；`dto.test.ts`：严格输入 | 通过 |
| FUN-05 | `grid-service.test.ts`：更新保留 ID/createdAt 并执行乐观锁 | 通过 |
| FUN-06 | `grid-service.test.ts`：保留自身代码成功，同 owner 另一代码返回 409 | 通过 |
| FUN-07 | `grid-service.test.ts`：删除后详情 404，跨 owner 删除 404 | 通过 |
| FUN-08 | `grid-service.test.ts`、`calculate-grid.test.ts`：详情包含输入、汇总和全行结果 | 服务端通过；移动/桌面展示待前端 |
| FUN-09 | `grid-service.test.ts`：重算幂等且不修改持久化元数据 | 通过 |
| FUN-10 | `calculate-grid.test.ts`：普通/中/大网 `GridItemResult` 逐字段匹配 | 服务端通过；页面展示待前端 |
| FUN-11 | `session.test.ts`、`grid-service.test.ts`、`session-routing.test.ts`、`login-form.test.tsx`：匿名 401、owner UUID 隔离与安全登录回跳 | 服务端与前端路由/表单自动化通过；真实 Better Auth + 数据库浏览器登录受环境门控 |
| FUN-12 | `json-response.test.ts`、`route-factory.test.ts`、`login-form.test.tsx`、`use-grid-trades.test.tsx`：统一错误信封、输入保留、requestId 与重试提示 | 服务端与前端错误状态自动化通过；真实数据库浏览器错误流程受环境门控 |

## 算法与数据兼容

| ID | 自动化证据 | 状态 |
|---|---|---|
| ALG-01 | `calculate-grid.test.ts` 的 `long-default` 全字段黄金对比 | 通过 |
| ALG-02 | `calculate-grid.test.ts` 的 `short-default` 全字段黄金对比 | 通过 |
| ALG-03 | `long-increase-every-grid` fixture | 通过 |
| ALG-04 | 做多 fixtures 的 `keepProfit` 逐字段对比 | 通过 |
| ALG-05 | 做多 fixtures 的 `keepCount`、卖出量价联动对比 | 通过 |
| ALG-06 | `long-default`/`long-non-divisible-amplitude` 的中大网插入顺序 | 通过 |
| ALG-07 | `long-non-divisible-amplitude` 与做空 fixture | 通过 |
| ALG-08 | `long-min-quantity-one` fixture | 通过 |
| ALG-09 | `validation.test.ts`：0、负数、精度、范围、非法组合和整数约束 | 通过 |
| ALG-10 | `grid-service.test.ts` 重算相等；全部 golden fixture 输出稳定 | 通过 |
| DAT-01 | `strict-json.test.ts`、`android-normalizer.test.ts`、`import-service.test.ts` | 通过 |
| DAT-02 | `android-normalizer.test.ts`：v2 缺省、文本清理、派生字段忽略与 warning | 通过 |
| DAT-03 | `strict-json.test.ts`、`android-normalizer.test.ts`：UTF-8、重复键、逐项错误、5000/10 MiB 上限 | 通过 |
| DAT-04 | `import-service.test.ts`：skip 只跳过当前 owner 冲突 | 通过 |
| DAT-05 | `import-service.test.ts`：overwrite owner 绑定和一次性预检 token | 通过；真实事务随 PostgreSQL 门控 |
| DAT-06 | `export-service.test.ts`、`schema-contract.test.ts`：Android 数字类型、重算行及 Schema | 通过 |
| DAT-07 | `export-service.test.ts`、`schema-contract.test.ts`：UUID/时间/版本、匿名 HMAC ownerRef、无 ownerId | 通过 |

## 安全验收

| ID | 自动化证据 | 状态 |
|---|---|---|
| SEC-01 | `grid-service.test.ts` owner 列表；`prisma-grid-trade-store.integration.test.ts` | 应用层通过；RLS 测试环境门控 |
| SEC-02 | `grid-service.test.ts` 同代码跨 owner 成功、同 owner 409；数据库复合唯一键 | 通过；数据库实测门控 |
| SEC-03 | `grid-service.test.ts` 对跨 owner GET/PATCH/DELETE/recalculate 均 404 | 通过 |
| SEC-04 | `dto.test.ts` 明确拒绝 `ownerId`、`algorithmVersion` 和未知字段 | 通过 |
| SEC-05 | `grid-service.test.ts` 搜索始终先限定 owner | 通过 |
| SEC-06 | `import-service.test.ts` 预检、skip/overwrite 和 token 均绑定 owner | 通过 |
| SEC-07 | `export-service.test.ts` 两种导出都不含 B 的产品或身份 | 通过 |
| SEC-08 | `admin-service.test.ts` 只返回账号字段；OpenAPI 不存在跨用户产品路径 | 通过 |
| SEC-09 | `grid-service.test.ts` 拒绝跨 owner 游标；`signed-token.test.ts` 拒绝篡改/过期 token | 通过 |
| SEC-10 | migration 启用 FORCE RLS；integration test 验证无 scope 直查为空 | 等待受限 `TEST_DATABASE_URL` 实跑 |
| SEC-11 | `admin-service.test.ts` 禁用即撤销会话；`session.test.ts` 拒绝 disabled；登录 hook 再查状态 | 应用层通过；Better Auth+DB 联调门控 |
| SEC-12 | `session.test.ts`：匿名 401、member 管理边界 403、active admin 通过 | 通过 |

补充安全门禁：`request-protection.test.ts` 覆盖同源写请求、429/`Retry-After`、登录失败清零；Route Handler 对登录、邀请、导入和其余 owner 写操作应用文档规定的窗口限流。

## 运维验收

| ID | 代码/测试证据 | 发布前状态 |
|---|---|---|
| OPS-01 | `Dockerfile`、低内存 Compose、公开 GHCR workflow、一键安装器；固定 `/fitgrid` 且 migration-before-start | 代码/本机契约通过；需全新 Ubuntu、现有 nginx 与 HTTPS 实跑 |
| OPS-02 | `create-admin.ts` 强制 TTY 隐藏输入、拒绝密码参数、仅空用户表 | 需空生产等价数据库演练 |
| OPS-03 | 配置测试只接受完整 40 位 commit SHA/digest；升级保留秘密和数据库卷 | 需 GHCR 发布与实际升级冒烟 |
| OPS-04 | 状态机测试验证迁移失败不更新 app、健康失败恢复旧 SHA；不逆向 migration | 需实际回滚演练 |
| OPS-05 | `backup.sh`：custom dump/list、AES-256/PBKDF2、SHA-256、远端 copy+checksum 后才清理本机过期文件；installer 在安装/升级时只为异设备有效挂载启用 timer，直接启用 timer 不做检查 | shell/installer 自动化通过；需真实 PostgreSQL、异机挂载、掉挂载监控和 timer 实跑 |
| OPS-06 | `restore.sh` 要求显式确认并拒绝生产/维护库；portable worker 固定执行预检和恢复前快照，替换前失败不回滚，进入替换路径后失败只尝试一次 rollback | 状态机/失败注入自动化通过；需完整隔离恢复、RLS/算法/2 GiB 验收与 RPO/RTO 记录 |
| OPS-07 | 文档要求同一 reviewed SHA、临时管理员、portable upload/preview/restore、备份内管理员、三项秘密连续性、验收、DNS 和旧 VPS 只读 72 小时 | 操作顺序已文档化；需双 VPS 实跑 |
| OPS-08 | 环境文件 600；web/root/portable 权限边界；密码/上传/状态/audit 清理与脱敏；下载 token 单次持久化 | 自动化通过；需容器挂载、Git、journal/logrotate 和实际文件权限人工审计 |
| OPS-09 | `fitgridweb.service` 仅启动/停止 `db app`；maintenance path 与 off-host timer 分离；容器 `unless-stopped` | unit/installer 契约通过；需 `systemctl restart`、path 激活、timer 和整机 reboot 验收 |
| OPS-10 | 管理员数据保险库与 root TTY 便携备份共享最多 5 份；raw-stream upload、10 分钟 challenge、精确短语、恢复后 logout | 专项 API/UI/shell 自动化通过；完整本机门禁仍有上述 Task 6 UI-demo 500；需 HTTPS 浏览器端到端下载/上传/恢复实跑 |

## 2026-09-03 Task 7 验证记录

本机自动化（本次文档变更后新鲜执行）：

```text
pnpm test
Test Files  1 failed | 77 passed | 2 skipped (80)
Tests       1 failed | 772 passed | 3 skipped (776)
exit 1

pnpm typecheck  # exit 0
pnpm lint       # exit 0
pnpm build      # exit 0；23/23 static pages generated
git diff --check  # exit 0
```

受限 sandbox 内第一次 `pnpm test` 得到 73 files/734 tests passed、2 files/8 tests skipped、4 files/18 tests failed；失败均来自内核权限门禁：loopback `listen EPERM`、维护/download-token kernel lock 不可用、伪 TTY `stty: TIOCGETD`。允许本机 loopback/PTY 后，一次完整 run 曾得到 77 files/757 tests passed、2 files/3 tests skipped、exit 0。最终复跑得到上方单一失败：`src/e2e/ui-demo.smoke.test.ts` 的管理员邀请场景捕获到一个 HTTP 500 console error；相同 case 的 focused rerun仍为 1 failed/4 skipped。

根因已定位到本任务基线：demo `AdminWorkspace` 挂载 live `<DataVault />`，其 mount effect 请求 `/api/v1/admin/backups`，而 `dev:ui` 按设计清空 `BETTER_AUTH_SECRET`/maintenance 配置，`getRuntimeServices()` 因此返回 500；现有 smoke test 要求 console error 为空。Task 7 没有修改 Task 6 产品代码，该 gate 留给 Task 6/final fix 修复并重新跑完整套件。backup/maintenance 单元与集成套件在最终 full run 中没有失败。

生产等价 Docker restore drill：**未执行，环境门控**。检查结果为 `docker`、`age`、`systemctl`、`pg_restore` 均不可用；主机是 Darwin arm64，不是 Ubuntu 24.04。由于仓库脚本内部固定 Compose project 名 `fitgridweb`，也不能在共享主机上仅用外层 `fitgridweb-drill` 名称证明隔离。本次没有创建、检查或删除任何 Docker project/volume，也没有触碰 VPS。

因此以下值均为 **未测量**，不能从配置或 fake-executable 测试推断：实际 RPO、实际 RTO、运行镜像 digest/SHA、运行 PostgreSQL `version()`、2 GiB restore 峰值、真实 RLS/会话清除、真实公网健康。仓库配置声明 `postgres:17.6-alpine`、app 640 MiB/db 512 MiB，但这些不是本次运行测量。季度隔离演练模板和安全边界见 [2 GiB VPS 手册](low-memory-vps-runbook.md#每季度隔离恢复演练)。

## 可复现门禁

本机执行：

```bash
pnpm test
pnpm typecheck
pnpm lint
NEXT_BASE_PATH=/fitgrid pnpm build
sh -n ops/*.sh ops/lib/*.sh docker/postgres/init-app-role.sh
git diff --check
```

发布环境额外执行：

```bash
TEST_DATABASE_URL='postgresql://受限运行角色@测试库/fitgridweb' pnpm test
docker manifest inspect ghcr.io/zhshy7713950/fitgridweb:sha-<完整SHA>
sudo /opt/fitgridweb/ops/install-production.sh --upgrade
systemctl restart fitgridweb
systemctl status fitgridweb-maintenance.path --no-pager
systemctl status fitgridweb-backup.timer --no-pager
journalctl -u fitgridweb-maintenance.service --since today --no-pager
journalctl -u fitgridweb-backup.service --since today --no-pager
sudo /opt/fitgridweb/ops/backup-portable.sh
sudo /opt/fitgridweb/ops/backup.sh
sudo /opt/fitgridweb/ops/restore.sh --target 'postgresql://.../fitgridweb_restore' --backup '/path/to/backup.dump.enc' --confirm
```

只有环境门控完成后，才能把 `SEC-10` 和 `OPS-01`–`OPS-10` 标为发布验收通过；完成前不能把“本机单元测试通过”或“文件已生成”等同于“生产恢复能力已验证”。
