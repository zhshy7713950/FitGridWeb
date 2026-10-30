# FitGridWeb

F.I.T Grid Web 是对 Android `FitProj` v2.1.0 网格交易能力的 Web 迁移项目，目标覆盖手机与 PC，并提供私有邀请账号、强制数据隔离、Android JSON 兼容和可恢复的 VPS 部署。

服务端已经实现：Better Auth 标准数据库会话、私有邀请、管理员账号状态、owner 范围内的网格 CRUD、Android v2.1.0 权威计算、严格 JSON 导入、Android/Web 双格式导出、PostgreSQL FORCE RLS 和 `/api/v1` OpenAPI 路由。技术与验收基线请从 [安卓审计与 Web 复刻技术文档](docs/fit-replication/README.md) 开始阅读；服务端实施顺序记录在 [实施计划](docs/superpowers/plans/2026-09-01-fitgridweb-server.md)。

Android 源仓库仅作为只读行为参考，不属于本仓库，也不得把 Web 代码提交到 Android 仓库。

股价预警支持沪深及美股股票、场内 ETF，提供指定价格、动态日均线和均线百分比条件，使用 Bark 通知。操作与升级见[股价预警部署与恢复](docs/price-alerts.md)，主备行情检查见[行情诊断](docs/price-alerts-diagnostics.md)，本地证据与待完成的 VPS 验收见[验证记录](docs/price-alerts-verification.md)。

## ETF 估值观察

产品详情的“查看估值”进入 `/grids/{id}/valuation`，分别展示基金不复权收盘价（含250/500日简单均线）、对应指数PE/PB历史及最低/最高、P30/P70和当前分位。分位基于全部已保存的有效历史，当前分位只与此前样本比较；无效最新估值不会用旧正值代替。分红、拆分会使不复权价格跳变，本页均线与股价预警的复权口径不同。

价格使用腾讯或Yahoo，指数PE使用中证或乐咕乐股，已核验的部分指数PB使用乐咕乐股月频数据。目录覆盖24个研究产品及沪深300/中证500两项对照；未匹配代码、未支持指标及REIT估值均明确留空。不同来源日期与频率不一致，免费来源可能限流或拒绝访问；首次刷新可载入经过摘要校验的研究归档，并展示真实数据日期和未在线更新状态，不能据此认定来源当前可用。

页面先读本地PostgreSQL，GET不访问上游；价格在新的完整交易日后按需检查，估值在成功检查满七天后按需检查，也可手动刷新。回补按批次续传，同指数的估值缓存共用；失败时保留旧数据并退避重试。历史保存在独立的 `research_series` / `research_observations` 表中，不参与预警三日清理，修订值按版本追加。升级前执行现有Prisma迁移；标准整库备份包含这些表，产品JSON导出和便携迁移不包含估值研究历史。

[估值功能验收记录](output/etf-valuation-observation-2026-10-29/acceptance.md)区分真实源验证与演示截图。页面演示可通过 `pnpm dev:ui` 查看 `/grids/demo-grid-05/valuation`。浏览器专项测试使用 `FITGRID_VALUATION_E2E_URL=http://127.0.0.1:3000 pnpm exec vitest run src/e2e/valuation.smoke.test.ts`；数据库测试需配置隔离的 `TEST_DATABASE_URL`。

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

管理员登录 `/fitgrid/admin` 后，可在“数据保险库”创建、下载、上传预检并整库恢复便携备份。便携备份使用独立的 12–128 字符密码，服务器只保留最近 5 份；它与 `backup.sh` 使用服务器密钥、复制到真实异机挂载的手动异机备份是两条不同的恢复路径。不要把个人 JSON 导出或同机最近 5 份当作异机灾备。

逐步操作、升级、nginx 恢复、开机验收、密码保管、手动异机备份、恢复失败处理、季度演练和 VPS 更换见 [2 GiB VPS 一键部署与运维手册](docs/fit-replication/low-memory-vps-runbook.md)；完整架构约束见 [部署与运维文档](docs/fit-replication/07-deployment-and-operations.md)。


### 估值中位线与REIT现金分派率

PE/PB使用全部有效历史显示P30/P50（中位数）/P70，当前分位单独计算。股价提醒详情的条件行直接显示服务端最近有效判断的触发价；均线尚未计算时显示待计算。

508000、508056的估值页显示价格/MA250/MA500和“股息率（近12个月现金分派率）”，隐藏PE/PB。分派率=过去12个自然月每份税前现金分派合计÷当日不复权收盘价×100%，按官方公告的场内除息日计入。天天基金用于发现事件，基金管理人公告正文核验金额和日期；每10份金额先除以10。完整历史不足12个月、分派待核验或份额口径变化时留空，只有完整窗口没有分派时显示0%。

分派记录每七天按需检查，期间随价格更新重算，界面展示分派数据截至日期；采集失败保留历史，价格图独立可用。事件与公告证据/修订长期保存在既有研究表，随整库备份保存；本轮无需新增数据库迁移。首次核验分批续传，每次刷新最多8个上游请求。免费来源的异常、列表截断或无法核验的场内日期不会降级成推测值。
