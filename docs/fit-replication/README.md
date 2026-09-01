# FitGridWeb 安卓审计与 Web 复刻技术基线

## 文档目的

本目录是 `FitGridWeb` 端实现前的唯一业务与技术基线，产品展示名为 **F.I.T Grid Web**。审计对象为嵌套仓库 `FitProj` 的 `master` 分支、提交 `a6452ac`、标签 `v2.1.0`。安卓仓库仅作只读取证源，不接收 Web 代码、文档或提交。Web 首期只复刻当前仍可到达的网格交易能力；2025 年改版时删除的基金产品与投资明细页面仅作为遗留背景记录。

本文档定义功能、数据、算法、接口、安全和部署，不定义新 Web 的最终视觉。手机与 PC 的视觉方案应在实现阶段单独使用 `frontend-design` 确定。

## 结论摘要

- 安卓应用是单机、离线、Room 持久化的网格策略计算器，没有网络接口或账号体系。
- 当前主流程包括产品列表、搜索与分页、添加、编辑、删除、重新计算、做多/做空表格、行明细、JSON 导入导出。
- `GridTradeRepositoryImpl` 是算法权威实现；数据层保存输入参数、派生网格行和汇总值。
- Web 目标采用云端权威数据、私有邀请制和强制账号隔离。每个账号只能看到、搜索、修改、导入和导出自己的产品。
- Web 采用模块化单体：Next.js、PostgreSQL、Prisma、Better Auth、Caddy、Docker Compose。
- Web 服务端只持久化输入参数和算法版本，派生网格行按 `android-v2.1.0` 算法计算，避免数据失效。
- 金额和比例在 Web 内部使用十进制定点数；Android 兼容导出仍输出原格式 JSON 数字。

## 阅读顺序

1. [安卓项目审计](01-android-audit.md)
2. [现役功能规格](02-functional-spec.md)
3. [网格算法规格](03-grid-algorithm.md)
4. [数据迁移与兼容](04-data-migration.md)
5. [Web 目标架构](05-web-target-architecture.md)
6. [API、认证与安全](06-api-and-security.md)
7. [Ubuntu VPS 部署与迁移](07-deployment-and-operations.md)
8. [追踪矩阵与验收](08-traceability-and-acceptance.md)

## 机器可读契约

- [OpenAPI 3.1](contracts/openapi.yaml)
- [Android 导入 JSON Schema](contracts/android-grid-trade.schema.json)
- [Web 完整备份 JSON Schema](contracts/web-backup.schema.json)
- [v2.1.0 算法黄金用例](fixtures/grid-algorithm-v2.1.0.json)

## 范围边界

### 首期包含

- 私有邀请注册、登录、退出、修改密码和账号禁用
- 账号级产品数据隔离
- 网格产品列表、搜索、游标分页、创建、编辑、删除
- 做多、做空网格计算与表格详情
- Android JSON 导入预检、冲突处理、提交和兼容导出
- Web 完整备份导出
- Docker Compose 一键部署、HTTPS、备份恢复与 VPS 迁移

### 首期不包含

- 已删除的基金投资明细功能
- 行情、基金估值或交易平台网络接口
- 支付、公开注册、邮件发送、第三方登录
- 浏览器离线编辑和双向冲突合并
- 管理员读取其他用户业务数据
- 最终 UI 视觉、品牌和动效设计

## 基线验证记录

- 2026-09-01 使用 Zulu Java 8 `1.8.0_412` 执行 `./gradlew :app:assembleDebug`：成功。
- 生成 APK：`FitProj/app/build/outputs/apk/debug/Fit-v2.1.0-debug.apk`。
- 最终复检 `:app:assembleDebug`：`BUILD SUCCESSFUL in 22s`；APK SHA-256 为 `9d4bc4b007345744f091a301761f9d8f7e9234d8ede94482c5246d3bb269e2fb`。
- 临时 JUnit 特征测试直接调用 `GridTradeRepositoryImpl.buildGrid`：5 组计算用例通过，测试文件已删除，未修改安卓业务源码。
- 根仓库与嵌套安卓仓库相互独立；本文档不改变 `FitProj` 的 Git 历史。
