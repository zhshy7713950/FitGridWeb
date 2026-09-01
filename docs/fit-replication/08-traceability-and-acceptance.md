# 安卓到 Web 追踪矩阵与验收

## 1. 使用方法

本矩阵是 `FitGridWeb` 开发与验收的总索引。每项现役安卓行为都必须同时落到 Web 行为、API、持久化字段、权限规则和自动化测试；缺少任一列即不能视为完成。

测试编号前缀：`FUN` 功能、`ALG` 算法、`DAT` 数据兼容、`SEC` 隔离安全、`OPS` 运维恢复、`LEG` 遗留边界。

## 2. 页面、功能与接口矩阵

| Android 取证点 | Web 页面/行为 | API | 数据字段/计算 | 权限 | 验收测试 |
|---|---|---|---|---|---|
| `HomeFragment` 初始加载 | `/grids` 显示当前账号产品；手机/PC 功能相同 | `GET /api/v1/grid-trades` | 当前账号输入字段；派生结果不落库 | 强制 owner scope | `FUN-01`, `SEC-01` |
| `HomeFragment` 搜索 | 名称或代码搜索，清空恢复列表 | `GET /api/v1/grid-trades?q=` | `productName`, `productCode` | 查询自动附加当前 owner | `FUN-02`, `SEC-05` |
| RecyclerView 分页 | 游标分页，滚动/按钮均保持稳定顺序 | `GET /api/v1/grid-trades?cursor=&limit=` | `sortOrder`, `createdAt`, `id` | 游标与结果不能跨 owner | `FUN-03`, `SEC-09` |
| `GridTradeEditFragment` 新增 | `/grids/new` 表单、校验、保存 | `POST /api/v1/grid-trades` | 全部 `GridTradeInput` + 服务端 owner/UUID/时间 | 不接受 `ownerId` | `FUN-04`, `SEC-04` |
| `GridTradeEditFragment` 编辑 | `/grids/{id}/edit` 预填并更新，允许保留原代码 | `GET`, `PATCH /api/v1/grid-trades/{id}` | 更新输入和 `updatedAt`，保留 ID/owner/createdAt | ID+owner 查询，越权 404 | `FUN-05`, `SEC-03` |
| 编辑产品代码 | 支持改代码；仅当前账号内检查冲突 | `PATCH /api/v1/grid-trades/{id}` | 唯一键 `(ownerId, productCode)` | 不检查其他用户代码 | `FUN-06`, `SEC-02` |
| 删除确认 | 详情/列表触发确认，成功后返回列表 | `DELETE /api/v1/grid-trades/{id}` | 删除当前产品输入 | ID+owner；越权 404 | `FUN-07`, `SEC-03` |
| `GridTradeActivity`/`GridTabFragment` | `/grids/{id}` 显示参数、汇总和长/短网格行 | `GET /api/v1/grid-trades/{id}` | 服务端按版本即时计算 | 只读当前 owner 产品 | `FUN-08`, `SEC-03` |
| 重新计算按钮 | 不改变输入，返回相同版本的新计算结果 | `POST /api/v1/grid-trades/{id}/recalculate` | `algorithmVersion`, 派生行与汇总 | ID+owner；越权 404 | `FUN-09`, `ALG-10`, `SEC-03` |
| 做多计算 | 表格与汇总完全匹配 v2.1.0 | 详情/重算响应 | `isShort=false`，Decimal 领域算法 | 当前 owner | `ALG-01`–`ALG-06` |
| 做空计算 | 表格与汇总完全匹配 v2.1.0 | 详情/重算响应 | `isShort=true`，Decimal 领域算法 | 当前 owner | `ALG-02`, `ALG-07` |
| 网格行详情 | 手机折叠/桌面表格均显示同一字段与精度 | 包含于详情/重算 | `GridItemResult` 全字段 | 随所属产品隔离 | `FUN-10`, `ALG-08` |
| `HomeFragment` JSON 导入 | 选文件→预检→选择 skip/overwrite→事务提交 | `POST /imports/android/preview`, `/commit` | Android 字段映射到当前账号输入 | owner 取自会话；冲突只看本账号 | `DAT-01`–`DAT-05`, `SEC-06` |
| `HomeFragment` JSON 导出 | 下载当前账号 Android 兼容 JSON | `GET /exports/android` | 兼容字段与重新生成的 `gridItems` | 只导出当前 owner | `DAT-06`, `SEC-07` |
| Web 完整备份 | 下载可保留 UUID/时间/算法版本的个人备份 | `GET /exports/backup` | `fitgridweb-backup` v1.0.0 | ownerRef 匿名化，无 ownerId | `DAT-07`, `SEC-07` |
| Android Room | 云端持久化、唯一约束和 RLS | 所有业务 API | PostgreSQL `GridTrade.ownerId NOT NULL` | 数据库+应用双重隔离 | `SEC-01`–`SEC-10` |
| Android 本地导航 | 响应式 Web 路由，刷新/深链可恢复 | 页面路由 + 同源 API | UUID 路由参数 | 未登录跳登录；越权仍 404 | `FUN-11`, `SEC-03` |

接口的精确定义见 [OpenAPI](contracts/openapi.yaml)，页面字段与状态见 [现役功能规格](02-functional-spec.md)。

## 3. 功能验收用例

| ID | 场景 | 预期 |
|---|---|---|
| `FUN-01` | 新账号首次进入列表 | 空态可直接新增或导入，无其他账号数据 |
| `FUN-02` | 按名称、完整/部分代码搜索并清空 | 匹配当前账号；清空恢复第一页 |
| `FUN-03` | 创建相同排序值的多条记录并翻页 | 不重复、不遗漏；顺序由 `sortOrder, createdAt, id` 稳定决定 |
| `FUN-04` | 填写合法做多/做空参数新增 | 创建成功并直接得到权威计算结果 |
| `FUN-05` | 编辑名称、代码和参数 | ID、owner、createdAt 不变，updatedAt 更新，结果重算 |
| `FUN-06` | 编辑时保留自身代码；改为自身另一产品代码 | 前者成功，后者 409 `PRODUCT_CODE_CONFLICT` |
| `FUN-07` | 删除并确认 | 返回 204，列表和直接详情均不再存在 |
| `FUN-08` | 查看详情 | 参数、汇总、所有网格行完整，手机与 PC 数值一致 |
| `FUN-09` | 重复重新计算 | 输入和持久化元数据不变，响应逐字段相同 |
| `FUN-10` | 查看普通/中网/大网行 | 类型、档位、买卖量价、利润、留存字段齐全 |
| `FUN-11` | 未登录深链详情、登录后再访问 | 未登录进入登录流程；登录后仅能解析自己的 UUID |
| `FUN-12` | 网络/服务端错误、字段错误和空结果 | 保留用户输入，显示统一错误；支持安全重试，不伪造成功状态 |

## 4. 算法与数据兼容矩阵

| ID | 覆盖 | 权威预期 |
|---|---|---|
| `ALG-01` | 默认做多 | fixture `long-default` 全行和汇总一致 |
| `ALG-02` | 默认做空 | fixture `short-default` 全行和汇总一致 |
| `ALG-03` | 逐格加码 | `increaseAmplitude` 触发的交易数量匹配 Android |
| `ALG-04` | 留存利润 | `keepShare` 对 `keepProfit` 的影响及 HALF_UP 时点一致 |
| `ALG-05` | 留存数量 | `keepCount` 与卖出数量/金额联动一致 |
| `ALG-06` | 中网、大网插入排序 | 网格类型、插入档位、最终排序一致 |
| `ALG-07` | 非整除振幅和做空边界 | fixture 对应长/短案例逐字段一致 |
| `ALG-08` | 自定义最小交易数量 | fixture `long-min-quantity-one` 一致 |
| `ALG-09` | 0、负数、超大数、非法组合 | Web 拒绝已列非法输入；Android 宽松行为仅作为风险记录 |
| `ALG-10` | 重复计算幂等 | 相同输入与算法版本得到字节级等价十进制响应 |
| `DAT-01` | Android 合法 JSON | 通过 Schema、预检并导入当前账号 |
| `DAT-02` | Gson 缺省/额外字段 | 按兼容字典补默认值或给明确 warning，不静默改变含义 |
| `DAT-03` | 非法字段/数值 | 逐项返回 fieldErrors，提交阶段不写入非法记录 |
| `DAT-04` | `skip` 冲突策略 | 当前账号同代码跳过，其他账号同代码不构成冲突 |
| `DAT-05` | `overwrite` 冲突策略 | 只覆盖当前账号同代码记录；整批事务行为符合规格 |
| `DAT-06` | Android 兼容导出再导回 | 字段、数字类型和计算结果可被 v2.1.0 接受 |
| `DAT-07` | Web 完整备份 Schema | UUID、时间、版本、输入齐全；不含明文 ownerId/用户名 |

算法真值来自 [算法规格](03-grid-algorithm.md) 和 [黄金 fixtures](fixtures/grid-algorithm-v2.1.0.json)；JSON 字段与取舍来自 [迁移规格](04-data-migration.md)。

## 5. 安全与账号隔离矩阵

测试夹具必须创建账号 A、账号 B 和管理员 M；A、B 各自至少有一个产品，并各自创建同一产品代码 `SAME-CODE`。

| ID | 操作 | 必须结果 | 防线 |
|---|---|---|---|
| `SEC-01` | A/B 分别列出产品 | 只出现各自记录 | owner-scoped store + RLS |
| `SEC-02` | A/B 都创建 `SAME-CODE` | 均成功；同账号再建才 409 | 唯一约束 `(ownerId, productCode)` |
| `SEC-03` | A 用 B UUID GET/PATCH/DELETE/recalculate | 全部返回与随机 UUID 相同的 404 | ID+owner 查询 + RLS |
| `SEC-04` | 新增/编辑体加入 `ownerId` | 作为未知字段拒绝，且不产生/转移记录 | 严格 DTO；owner 仅取会话 |
| `SEC-05` | A 搜 B 专属名称/代码 | 空结果且无计数、建议词等侧信道 | owner 限定搜索 |
| `SEC-06` | A 导入与 B 同代码文件 | 只与 A 数据判断 skip/overwrite | owner 限定预检和提交事务 |
| `SEC-07` | A 导出两种格式 | 不含 B 字段、产品、数量或统计 | owner 限定导出 |
| `SEC-08` | M 查看管理 API | 只能管理账号/邀请/禁用，不存在跨用户产品 API | 路由边界与角色测试 |
| `SEC-09` | 将 A 游标用于 B，或篡改游标 | 不泄露 A 数据；返回安全错误或 B 自身分页 | 签名/绑定 owner 的不透明游标 |
| `SEC-10` | 测试事务绕过仓储直接查询 | 数据库 RLS 仍阻止跨 owner；应用角色无 BYPASSRLS | FORCE RLS 与数据库测试 |
| `SEC-11` | 禁用账号 | 无法登录，既有会话失效，业务数据保留 | Better Auth 会话撤销 |
| `SEC-12` | 匿名/普通用户访问管理接口 | 分别 401/403；产品越权始终 404 | 认证与资源隐藏策略 |

安全要求详见 [API、认证与安全](06-api-and-security.md)。前端隐藏按钮不计作任何一项安全防线。

## 6. 运维与恢复验收

| ID | 场景 | 完成标准 |
|---|---|---|
| `OPS-01` | 全新 Ubuntu + 域名部署 | 一条部署脚本完成迁移和启动，HTTPS 健康检查通过 |
| `OPS-02` | 创建首个管理员 | 仅空数据库可执行；密码不出现在命令历史或日志 |
| `OPS-03` | 日常升级 | 固定镜像 SHA，可追踪迁移，功能/隔离冒烟通过 |
| `OPS-04` | 应用回滚 | 数据结构兼容时恢复上一镜像并通过健康检查 |
| `OPS-05` | 每日备份 | custom 格式、校验和、加密异机副本和保留策略均成功 |
| `OPS-06` | 空库恢复演练 | 用户/产品/约束/RLS/算法检查全部通过并记录 RPO/RTO |
| `OPS-07` | 更换 VPS | 最终冻结写入、恢复、验收、DNS 切换、72 小时回滚窗完成 |
| `OPS-08` | 秘密与日志审计 | Git、容器日志和错误响应均无密码、Cookie、token 或上传正文 |

执行步骤见 [部署、备份与迁移](07-deployment-and-operations.md)。

## 7. 遗留与非首期范围

| Android 遗留项 | 结论 | 测试 |
|---|---|---|
| 基金产品页面与路由 | 2025 年已从现役导航删除，不实现 | `LEG-01`：Web 路由/API 不出现基金 CRUD |
| 投资明细页面与路由 | 现役不可达，不实现 | `LEG-02`：Web 路由/API 不出现投资明细 CRUD |
| Room 遗留实体/DAO/布局/Manifest 项 | 只在审计附录记录，不迁移 | `LEG-03`：Prisma 模型无无用遗留表 |
| Android 本地数据库/SharedPreferences | 不同步到浏览器，不实现离线编辑 | `LEG-04`：断网写入不会产生待同步副本 |
| Android 旧依赖和构建警告 | 不复制技术债；以行为兼容为目标 | `LEG-05`：Web 依赖审计独立通过 |

## 8. 发布门禁与完成定义

首期发布必须同时满足：

1. `FUN-01`–`FUN-12` 全部通过，手机和 PC 可完成同样业务操作。
2. `ALG-01`–`ALG-10` 逐字段匹配 v2.1.0 黄金用例，非法输入按 Web 规则拒绝。
3. `DAT-01`–`DAT-07` 通过，Android 兼容导入导出与 Web 完整备份 Schema 均有效。
4. `SEC-01`–`SEC-12` 在应用集成测试和 PostgreSQL 约束/RLS 测试两层通过。
5. `OPS-01`–`OPS-08` 至少在一台全新 Ubuntu 演练机完成，尤其要实际恢复而不是只生成备份。
6. OpenAPI、两份 JSON Schema、fixture JSON、Mermaid 图和内部链接通过自动校验。
7. Android 基线仍为 `a6452ac`/`v2.1.0`，参考仓库工作树无 Web 修改。
8. 产品中不存在管理员读取他人业务数据、公开注册、客户端指定 owner 或无 owner 查询的路径。

视觉设计不属于本技术基线的完成门禁；进入页面实现前应使用 `frontend-design` 单独确定响应式视觉系统，但不得改变本文规定的字段、行为、权限和算法。

## 9. 文档与契约总索引

- [安卓项目审计](01-android-audit.md)
- [页面与操作规格](02-functional-spec.md)
- [做多/做空算法规格](03-grid-algorithm.md)
- [JSON 字典与迁移](04-data-migration.md)
- [Web 架构与数据隔离](05-web-target-architecture.md)
- [API、认证与安全](06-api-and-security.md)
- [部署、备份、恢复与迁移](07-deployment-and-operations.md)
- [OpenAPI](contracts/openapi.yaml)
- [Android JSON Schema](contracts/android-grid-trade.schema.json)
- [Web 备份 JSON Schema](contracts/web-backup.schema.json)
- [v2.1.0 黄金 fixtures](fixtures/grid-algorithm-v2.1.0.json)
