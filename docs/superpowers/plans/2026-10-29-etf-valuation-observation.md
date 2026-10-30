# ETF Valuation Observation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本轮只完成计划；未获多代理执行指示，后续默认主会话执行。

**Goal:** 为网格产品增加免费、缓存优先、历史长期保存的价格/PE/PB估值观察页。

**Architecture:** 基金价格与指数估值分开建固定来源序列，公开历史在PostgreSQL共享保存。GET只读本地；POST按交易日/七天期限、共享租约及游标有界增量更新。React/SVG显示三张独立图表。

**Tech Stack:** 项目现有Next.js 16、React 19、TypeScript、Prisma/PostgreSQL、Decimal.js、Zod、Vitest/Testing Library和playwright-core。不新增Redis、Python运行时或图表依赖。

**Spec:** `docs/superpowers/specs/2026-10-29-etf-valuation-observation-design.md`

**Status:** 2026-10-29计划完成；设计默认待审阅，所有开发步骤尚未执行。用户已确认“基金价格＋指数估值 / 全部可用历史 / 最新收盘价”；不得重新套用旧研究脚本的五年窗口或200日均线。

## Global Constraints

- 0元来源；未支持/不适用/失败独立显示；不购买、不自动切源、不绕过访问限制。
- 默认不复权基金收盘价＋含当天收盘的MA250/MA500；该默认需随设计审阅。原有复权动态均线预警保持原样。
- PE/PB同系列固定来源、方法与采样频率；使用全部已验收历史，并显示实际跨度。
- 七天指成功检查后604800000毫秒；手动冷却60000毫秒，失败退避900000/3600000/21600000毫秒。
- 每批串行最多8请求；单请求5000毫秒、总45000毫秒、正文8MiB、系列租约120000毫秒。
- 历史独立表永久保存；普通GET不上游；不要复用 `parseDaily()` 的499条截断或三天缓存存储。
- 保持原网格算法、预警和部署行为。执行时采用隔离工作区；不带入当前主目录已有研究材料修改，不构建发布镜像或部署VPS。

## Review Focus

1. 暖缓存与多标签页同时进入：先见缓存，同系列只领取一次采集，不多次回补（任务4、5）。
2. 产品代码变更、同名不同指数、跨账号ID：准确映射，越权统一404，未知代码不猜（任务1、5）。
3. 月末重复、PE亏损、历史频率改变：不重复加权，不用旧正值冒充当前值（任务1、2）。
4. 分红/拆分、美国时区和未收盘日：价格口径可解释，MA不包含未完成记录（任务1、2）。
5. 上游403、半批成功、服务重启或清理/恢复：旧数据保留，游标可续，长期历史不消失（任务3、4、7）。

## 文件职责

新增服务端代码集中在 `src/server/valuation/`：`types.ts`（内部类型/DTO）、`catalog.ts`（精确映射）、`sources.ts`（固定源请求/校验）、`statistics.ts`（纯计算）、`repository.ts`（持久化/租约）、`service.ts`（读取和刷新编排）。每文件配对应测试；真实JSON样本放 `fixtures/`，禁止生成假数据冒充实测。

新增前端代码集中在 `src/features/valuation/`：`valuation-api.ts`（requestJson客户端）、`valuation-page.tsx`（页面/刷新流程）、`history-chart.tsx`（SVG和交互）、`valuation.module.css`（既有主题内的布局），各自有必要的行为测试。

其余接入仅触及：Prisma schema/新增migration、既有runtime services、OpenAPI合同、两条API路由、一个受保护页面及loading、网格详情桌面/移动入口、demo fixture、现有路由/保留/备份回归测试和README说明。

---

### Task 1: 固定产品映射与真实来源验收

**Files:**
- Create: `src/server/valuation/{types,catalog,sources}.ts`
- Create: `src/server/valuation/{catalog,sources}.test.ts`、`src/server/valuation/fixtures/`
- Create: `output/etf-valuation-observation-2026-10-29/source-acceptance.json`（执行时真实结果，不能预填成功）
- Read: 设计§4及已有product-source-map、history-audit归档，不改原研究证据。

**Interfaces:**
- Produces: `resolveValuationProduct(code: string): ValuationProduct | null`；仅接受目录中的规范化代码/明确别名。
- Produces: `fetchSeriesBatch(request: SeriesRequest, options: { signal: AbortSignal }): Promise<SeriesBatch>`。
- `SeriesRequest`: 固定series key、已验收catalog条目、from/to与可选cursor；这些值由服务器生成。
- `SeriesBatch`: observations、下一cursor、是否到源历史边界、实际频率/方法、warnings。每条含date、value/null、quality、必要原字段、sourcePublishedAt/null；不接受任意URL。
- `ValuationProduct`: 完整基金交易身份、benchmark/null、映射适用日期与price/pe/pb的固定系列定义或unsupported/not_applicable原因。系列身份包含source/method/frequency/adjustment。

- [x] **Step 1: 写失败测试。** 510880→000015、512890→H30269、VOO与513650共享指数key但价格key不同；161130保留LOF身份；24项映射与原证据一致；现行指数变更生效日保留。未知代码、伪造URL或歧义代码返回null。
- [x] **Step 2: 运行红测。** `pnpm exec vitest run src/server/valuation/catalog.test.ts src/server/valuation/sources.test.ts`；预期新模块缺失/断言失败。
- [x] **Step 3: 实现目录与适配器。** 使用现有标的规范化约定；固定腾讯原始日线、Yahoo quote.close、中证滚动PE、乐咕固定月频序列。复用已有fetch超时设计但加响应体上限，不修改旧预警解析器。
- [x] **Step 4: 写并通过解析测试。** 真实fixture必须覆盖腾讯只给qfq而无原始day时拒收、Yahoo原始/调整价格不同、跨美国夏令时的日期、当天未收盘排除、中证休市零成交占位、恒生同月重复标签、周末月末月频标签保留、频率变化拒绝追加、403/HTML/字段变更/超大响应/超时。按设计规则处理，不默认过滤一切零成交。
- [x] **Step 5: 做小量真实只读验收。** 至少覆盖510880、VOO/513650及目录中另外一个国内指数；记录URL参数、取数时间、实际范围、有效条数、字段/频率/口径和成功/失败。对其余目录系列逐项小样本确认；失败保持未支持或旧归档状态。不得为了全绿换成相似指数。
- [x] **Step 6: 复用并校验归档。** 将必要归档转换成源解析fixture并校验摘要；程序运行不依赖 `/private/tmp` 或 `output/` 的偶然文件。归档导入若需要单次脚本，放 `src/server/valuation/import-research.ts`，仅支持固定manifest和哈希，不自动在每次启动导入。
- [x] **Step 7: 运行任务测试并提交限定文件。** 真实源受限可继续实现空态/缓存路径；验收清单中保留“未连通”，fixture通过不能替代连通声明。

### Task 2: 全历史统计与收盘MA

**Files:** Create `src/server/valuation/statistics.ts`、`statistics.test.ts`。

**Interfaces:**
- Consumes: 任务1的规范化observations。
- Produces: `summarizeValuation(points: Observation[]): MetricSummary`；`buildPriceHistory(points: Observation[]): PriceHistory`。
- `MetricSummary`: min/max/p30/p50/p70/currentValue/currentPercentile、latestDate/latestValidDate、validCount/referenceCount、start/end、warnings；缺失数值为null。
- `PriceHistory`: 每点date/close/ma250/ma500、最新收盘摘要、数据质量；Decimal计算后输出字符串。

- [x] **Step 1: 写失败测试。** 既往[10,20,30]当前20→rank50；全部[10,20,20,30]→P30=19/P70=21；全相等rank50；单点只有min/max；两点rank为空；null/0/负值不参与传统统计，最新一期负PE使currentValue/currentPercentile为空。
- [x] **Step 2: 运行红测。** `pnpm exec vitest run src/server/valuation/statistics.test.ts`；确认测试在实现前失败。
- [x] **Step 3: 实现设计§6的线性分位/中秩排名。** 一个系列只用当前验收版本；排序、唯一日期、排除未完成与未来值，不裁剪合法极值。
- [x] **Step 4: 加MA精确样本。** 收盘1至500：MA250=375.5、MA500=250.5，最新500；249/499条对应MA为空；含当天的计数正确；已知缺口/重复冲突不能当成足量完整交易日；周末不填值；不能硬编码当前年份日历筛掉历史。
- [x] **Step 5: 实现线性时间滚动求和并运行绿测。** 统计用全样本，图表降采样不会传入本模块；提交这组文件。

### Task 3: 长期表、修订与数据库租约

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20261029000100_valuation_history/migration.sql`
- Create: `src/server/valuation/repository.ts`、`repository.integration.test.ts`

**Interfaces:**
- Consumes: 任务1系列定义与Observation。
- Produces `ValuationRepository`：`readSeries(key)`、`claimSeries(key, now)`、`commitBatch(claim, batch, now)`、`failBatch(claim, error, now)`。
- `claimSeries` 返回 `{token, expiresAt, cursor}` 或busy；token由服务端生成。读操作返回最新验收revision，保留全部旧revision。

- [x] **Step 1: 写数据库失败测试。** 原始导入重复两次不增加行；值变化追加revision；旧值仍可查；两个独立连接只一个claim成功；旧claim过期后提交被拒；服务重启后cursor仍在；删网格产品不删公开系列。
- [x] **Step 2: 在独立测试库运行红测。** `TEST_DATABASE_URL=<测试库> pnpm exec vitest run src/server/valuation/repository.integration.test.ts`；禁止指向生产库。缺少变量时明确未执行。
- [x] **Step 3: 增加设计§7的两表及索引。** observation按series/date/revision唯一，索引支持范围读取；series key唯一。租约与批次提交均短事务，外部HTTP不持锁；不增加公开历史到用户产品导出结构。
- [x] **Step 4: 应用迁移/生成客户端并运行绿测。** 在隔离数据库使用 `pnpm exec prisma migrate deploy`、`pnpm exec prisma generate`；按项目现有生成文件追踪规则处理结果。校验现有RLS的产品权限仍有效；公开表不给未登录HTTP访问能力。
- [x] **Step 5: 提交schema、migration、repository及必要生成变更。** 不提交数据库文件或环境凭证。

### Task 4: 缓存优先、到期和续传编排

**Files:** Create `src/server/valuation/service.ts`、`service.test.ts`。

**Interfaces:**
- Consumes: catalog、repository、source函数与statistics。
- Produces: `ValuationService.read(ownerId: string, gridId: string): Promise<ValuationPageData>`；`refresh(ownerId: string, gridId: string, mode: "due" | "manual"): Promise<ValuationPageData>`。
- 构造函数注入grid.get、repository、fetchSeriesBatch、clock和maintenance guard；统一返回设计§8的DTO。逐卡DTO含availability/freshness、source/method/frequency、asOf/checkedAt、coverage与stats/points；refresh含busy/hasMore/retryAfter。

- [x] **Step 1: 写失败测试。** read在有缓存/无缓存时上游次数都是0；refresh(due)暖缓存0请求；成功检查七天前1毫秒不刷、整七天刷；价格按本市场新完整交易日；请求成功但没有新增点仍推进checkedAt。
- [x] **Step 2: 运行红测。** `pnpm exec vitest run src/server/valuation/service.test.ts`。
- [x] **Step 3: 实现读取与单批刷新。** 获取owner产品后才resolve；同指数重复访问复用数据。按设计预算顺序执行；新增数据落库后返回新DTO，未完成历史保留hasMore/cursor；下一次due续传不受上批成功时间的七天期限限制。
- [x] **Step 4: 加并通过失败/并发测试。** 三卡中一个403仍保留旧数据与原asOf；同一系列忙不重复采集；成功但仍hasMore时可续传，且不把非预期空表当历史完成；冷却/15分钟至6小时退避；游标恢复；每批最多8请求且不超过总预算；维护模式不启动采集；unsupported不无限重试。手动刷新不重下已验收全量历史。
- [x] **Step 5: 验证输入与范围。** 增量从latestDate前30天起；首次历史从源已验收边界按游标取；全量专用接口仅到期/手动取一次并去重，不把网络全量标成增量；同源历史修订追加版本。
- [x] **Step 6: 任务测试通过后提交。** 不启动定时服务或常驻worker。

### Task 5: 登录保护路由与接口合同

**Files:**
- Modify: `src/server/runtime/services.ts`、`docs/fit-replication/contracts/openapi.yaml`
- Create: `src/app/api/v1/grid-trades/[id]/valuation/route.ts`
- Create: `src/app/api/v1/grid-trades/[id]/valuation/refresh/route.ts`
- Create: `src/server/valuation/http.test.ts`
- Create: `src/features/valuation/valuation-api.ts`、`valuation-api.test.ts`

**Interfaces:** Consumes任务4 DTO和服务；produces `getValuation(id)` 与 `refreshValuation(id, mode)`，使用既有requestJson/apiPath，不硬编码 `/api` 或 `/fitgrid`。

- [x] **Step 1: 补OpenAPI的GET/POST及DTO空值约定。** 严格mode枚举与现有错误响应，source/URL/ownerId不接受；不新增第二套API文档或外部Postman工作区。
- [x] **Step 2: 写失败测试并运行。** 登录401；其他owner/不存在统一404；无效id/额外body422；跨源POST403；GET缓存即使上游不可用仍200；部分卡失败200带状态；冷却429；维护POST503；`/fitgrid`正确拼接与request ID可见。
- [x] **Step 3: 实现最小route与runtime装配。** `requireSession`后调用服务；用户写请求限额在POST消费；外部请求从不出现在GET。
- [x] **Step 4: 执行客户端、HTTP与现有合同测试。** `pnpm exec vitest run src/server/valuation/http.test.ts src/features/valuation/valuation-api.test.ts src/server/http/api-contract.test.ts src/server/http/schema-contract.test.ts`；修正任何合同/代码不一致再提交。

### Task 6: 三图页面与详情入口

**Files:**
- Create: `src/app/(protected)/grids/[id]/valuation/{page,loading}.tsx`
- Create: `src/features/valuation/{valuation-page,history-chart}.tsx`、`valuation.module.css`
- Create: `src/features/valuation/{valuation-page,history-chart}.test.tsx`
- Create: `src/features/valuation/demo-valuation-data.ts`
- Modify: `src/features/grids/grid-detail.tsx`、`grid-detail.test.tsx`、`src/app/base-path-routing.test.tsx`

**Interfaces:** `ValuationPage({id}: {id:string})`；`HistoryChart({label, points, lines, references})`。points保留date、null断点；lines及references只描述设计要求，不发展通用图表框架。

- [x] **Step 1: 写入口与页面失败测试。** 桌面和移动菜单均“查看估值”且指向同产品；直接URL可加载；读缓存先呈现，然后才按服务端due状态POST；未到期不POST；用户一次点击只发一次manual刷新。
- [x] **Step 2: 写图表/空态断言。** 三卡独立、源日期与口径可读；MA不足为提示；PE/PB缺失不显示0；单点只有点；刷新失败旧图保持；无效最新PE不显示旧正值当前分位；不匹配与REIT文案不同。
- [x] **Step 3: 实现页面和SVG。** 使用现有主题/字体/动作样式，三卡纵向；P30/P50/P70参考线；latest/MA数值；两类刷新时间独立。统计摘要在SVG外，触摸/键盘可查点；压缩绘图保留端点/桶极值与断点，统计始终来自全量。
- [x] **Step 4: 实现刷新生命周期。** 冷启动/回补按hasMore顺序续传；busy按retryAfter只GET观察且最多120秒，超时显示重试入口；页面卸载取消后续请求；401由现有重定向处理；手动按钮pending时禁用；错误状态不无限自动重试。
- [x] **Step 5: 补demo与主题/路由测试。** demo模式只返回fixture，不请求真实免费源；浅/深主题、390px布局、键盘聚焦/移动点、basePath返回登录后仍定位估值页。
- [x] **Step 6: 运行前端测试并提交。** `pnpm exec vitest run src/features/valuation src/features/grids/grid-detail.test.tsx src/app/base-path-routing.test.tsx`。

### Task 7: 全链路验收、保留与交付

**Files:**
- Create: `src/server/valuation/retention.integration.test.ts`
- Create: `src/e2e/valuation.smoke.test.ts`
- Modify: `README.md`（来源、更新、统计与备份边界）
- Create: `output/etf-valuation-observation-2026-10-29/acceptance.md` 与必要截图（执行时产生）

- [x] **Step 1: 实测长期保留。** 插入超过三天的研究记录，运行现有预警清理后仍存在；标准整库dump/restore后最新值、旧revision、cursor仍在；检查便携导出不被宣称包含研究历史。不为通过测试改动原预警保留策略。
- [x] **Step 2: 完成有网络/离线两组端到端。** 510880价格/PE/PB，VOO/513650共享估值，REIT空态与未知代码；先成功缓存，再阻断上游，刷新失败保留旧图。记录上游请求数以证明暖缓存0请求、重复页面不重复回补。
- [x] **Step 3: 完成本地视觉验收。** 桌面和390px手机尺寸、深浅主题均截图核对；三图数据/日期、tooltip/键盘、返回详情和手动刷新可用。fixture视觉验收与真实取数验收分栏记录。
- [x] **Step 4: 运行必要全套检查。** `pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm build`；数据库测试需明确TEST_DATABASE_URL实际运行结果。只在新修改/失败时扩大或重复检查。
- [x] **Step 5: 审查范围并记录结果。** `git diff --check`、核对变更文件；acceptance说明真实支持的指标/频率/跨度、未连通项、测试通过/跳过、备份恢复结果；不写“所有ETF完整历史”或“无前视偏差回测”。
- [x] **Step 6: 提交已验收的限定变更并交付。** 提供页面位置、截图、实际数据覆盖与限制；需要发布或VPS测资源时另按用户明确指示执行，本计划不自动发布。

## 计划自检（2026-10-29）

- 已覆盖全部已确认需求：详情入口→任务6；价格/250/500→任务1/2/6；PE/PB四类统计与当前分位→任务2/6；缓存/刷新/周频/长期保存→任务3/4/5/7。
- 已区分已确认选择与实现默认，特别是不复权、按需周更新、SVG。
- 接口名和返回DTO在任务间一致；read不请求源，refresh为有界写操作。
- Review Focus五类风险均有对应任务的测试；实际源受限/数据库测试跳过不可写成已完成。
- 原对话研究文件不改写，所有开发任务均保持未勾选；本轮只新增设计与计划文档。

执行状态：2026-10-29全部七项任务完成；实际数据源限制、独立数据库/浏览器专项和全套验证结果见 `2026-10-29-etf-valuation-progress.md` 及 `output/etf-valuation-observation-2026-10-29/acceptance.md`。未发布。


## 已批准的后续增量（2026-10-29）

- [x] 提醒条件右侧显示服务端触发价，覆盖上下偏离、触及、固定价及未计算状态。
- [x] 统计、DTO和图表加入P50；与当前分位分开显示。
- [x] 两只REIT接入基金管理人分红公告核验，分派事件复用现有长期表及修订机制。
- [x] 按场内除息日计算12个自然月现金分派率，支持真实零、缺失留空、七天缓存及有界续传。
- [x] REIT展示价格＋分派率图，隐藏PE/PB；更新OpenAPI合同。
- [x] 完成数据库、真实来源、桌面/390px深浅主题、全套检查及独立代码审查；结果见 `output/reit-yield-2026-10-29/acceptance.md`。
