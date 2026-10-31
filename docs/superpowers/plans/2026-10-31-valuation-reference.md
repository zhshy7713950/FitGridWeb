# Valuation reference scenarios implementation plan

> **For agentic workers:** Use superpowers:executing-plans, native implementation. Steps use checkbox tracking.

**Goal:** 在各估值旁提供独立、可核对且不修改已有网格的参考情景。

**Architecture:** 缓存服务构建估值换算依据，现有GET增加可选reference；客户端点击时懒加载纯预算计算，复用原引擎；独立卡片显示结果。

**Tech Stack:** TypeScript / Decimal / React / Next / Vitest / existing browser acceptance.

**Spec:** docs/superpowers/specs/2026-10-31-valuation-reference-design.md

## Global Constraints

- 不修改现有网格引擎、验证器、交易或保存逻辑；无新依赖、表或写接口。
- 所有金额与结果为条件情景；不输出未经验证的最优参数/风险概率。
- 仅已有权限缓存数据；不回退无效最新指标，不使用未来价格。
- 用户预算；示例费用可编辑；输入或数据变化使旧结果失效。

## Review Focus

- 最新指标为估算/缺失时不能使用更早值伪造当期数据。
- 指标日期与价格必须不前视对齐，月度窗口不能含未完成月。
- 原引擎float32数量取整后可能超出基准预算，必须逐笔Decimal复核。
- 大规模或零价格网格必须明确不可行，不冻结页面或输出NaN。
- 改产品、改预算或刷新后不能混合旧结果和新输入。

### Task 1: 参考依据与预算计算

Files: `src/server/valuation/reference.ts`, `src/server/valuation/reference.test.ts`, `src/features/valuation/reference-plan.ts`, `src/features/valuation/reference-plan.test.ts`, reference DTO types.

Interfaces: `buildReferenceBasis(metric,card,price,kind,now): ReferenceBasis`; `calculateReferencePlan(input,basis,options): ReferencePlan`.

- [x] 编写并运行失败测试：手算PE/PB/股息率、月份窗口、无效末值、旧价、未来值、预算/费用/叠加数量/不可行情景。
- [x] 实现最小纯函数，运行新增测试及原网格测试，确认通过。

### Task 2: 缓存服务与API合同

Files: valuation `types.ts`, `service.ts`, `service.test.ts`, demo data, OpenAPI and schema contract tests.

- [x] 测试通过owner验证后提供原网格输入与三个独立依据，GET不采集，不增加写行为。
- [x] 扩展可选reference合同、demo，运行服务/HTTP/schema tests。

### Task 3: 页面与整体验证

Files: `reference-panel.tsx`, `reference-controls.tsx`, valuation page/CSS/tests, dedicated reference browser test.

- [x] 页面失败测试：提交预算产生独立结果，无数据可读，输入变更隐藏结果，刷新使旧数据计算失效。
- [x] 实现共享预算及示例费用、候选加码；每图卡独立参考块，懒加载计算模块，不自动保存。
- [x] 运行相关测试、原网格测试、全套测试、类型、lint、build；浏览器390/1440深浅主题，保留截图。
- [x] 请求一次独立代码评审，修复重要问题并重跑受影响验证。
