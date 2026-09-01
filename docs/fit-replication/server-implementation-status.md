# 服务端实现状态与验收追踪

日期：2026-09-01  
范围：Next.js `/api/v1`、Better Auth 标准数据库会话、领域算法、PostgreSQL/Prisma、导入导出与 VPS 运维资产。响应式页面行为不在本阶段范围内。

## 状态摘要

- 服务端代码与本机可运行的自动化门禁已经完成。
- Better Auth 使用 `sessions` 表保存标准数据库会话；浏览器只接收 `HttpOnly`、`Secure`、`SameSite=Lax` Cookie，不向前端返回长期 token。
- 产品查询、冲突检测、游标、导入与导出均绑定会话 owner；`grid_trades` 和 `import_previews` 同时启用 `FORCE ROW LEVEL SECURITY`。
- OpenAPI 中 16 个路径的每个 operationId 都有 Route Handler；Android 与 Web 导出均通过发布的 JSON Schema。
- 已实现 `/fitgrid` 固定生产子路径、Better Auth Cookie Path、GHCR 完整 SHA 流水线、2 GiB 低内存 Compose、现有 nginx 安全集成、迁移前置/应用回滚和 systemd 开机恢复。
- 当前主机没有 Docker，也没有提供 `TEST_DATABASE_URL`，因此真实 PostgreSQL RLS、GHCR 镜像拉取、HTTPS 部署、VPS 重启、备份和恢复演练仍是发布前环境门控。

## 功能验收

| ID | 服务端证据 | 状态 |
|---|---|---|
| FUN-01 | `grid-service.test.ts`：owner A/B 列表隔离；新 owner 返回空页 | 服务端通过；页面空态待前端 |
| FUN-02 | `grid-service.test.ts`：名称/代码搜索和清空查询的 owner 范围 | 通过 |
| FUN-03 | `grid-service.test.ts`：`sortOrder, createdAt, id` 稳定分页 | 通过 |
| FUN-04 | `grid-service.test.ts`：创建后直接返回权威计算；`dto.test.ts`：严格输入 | 通过 |
| FUN-05 | `grid-service.test.ts`：更新保留 ID/createdAt 并执行乐观锁 | 通过 |
| FUN-06 | `grid-service.test.ts`：保留自身代码成功，同 owner 另一代码返回 409 | 通过 |
| FUN-07 | `grid-service.test.ts`：删除后详情 404，跨 owner 删除 404 | 通过 |
| FUN-08 | `grid-service.test.ts`、`calculate-grid.test.ts`：详情包含输入、汇总和全行结果 | 服务端通过；移动/桌面展示待前端 |
| FUN-09 | `grid-service.test.ts`：重算幂等且不修改持久化元数据 | 通过 |
| FUN-10 | `calculate-grid.test.ts`：普通/中/大网 `GridItemResult` 逐字段匹配 | 服务端通过；页面展示待前端 |
| FUN-11 | `session.test.ts`、`grid-service.test.ts`：匿名 401、登录 owner UUID 隔离 | 服务端通过；登录后页面回跳待前端 |
| FUN-12 | `json-response.test.ts`、`route-factory.test.ts`：统一错误信封和 requestId | 服务端通过；表单保留与提示待前端 |

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
| OPS-05 | `backup.sh` 执行 custom dump、list、AES-256、SHA-256、异地目录校验后才清理；失败路径有测试 | 需 PostgreSQL/异地存储实跑 |
| OPS-06 | `restore.sh` 要求显式确认并拒绝生产/维护库 | 需完整空库恢复、RLS/算法验收与 RPO/RTO 记录 |
| OPS-07 | 运维文档给出冻结、恢复、DNS 切换和 72 小时回滚窗 | 需双 VPS 演练 |
| OPS-08 | 环境文件 600、目录 700、五秘密独立且升级保留；nginx 备份/幂等/失败恢复有测试 | 需容器/Git/日志人工审计 |
| OPS-09 | `fitgridweb.service` 仅启动/停止 `db app`，依赖 Docker/network-online；容器 `unless-stopped` | 需 `systemctl restart` 与整机 reboot 验收 |

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
./ops/backup.sh
./ops/restore.sh --target 'postgresql://.../fitgridweb_restore' --backup '/path/to/backup.dump.enc' --confirm
```

只有环境门控完成后，才能把 `SEC-10` 和 `OPS-01`–`OPS-08` 标为发布验收通过；完成前不能把“本机单元测试通过”等同于“生产恢复能力已验证”。
