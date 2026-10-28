# 股价提醒行情诊断

此命令供管理员手动检查 VPS 到行情来源的真实连通性、十根完整分钟线，以及动态 MA 所需的 N−1 根同来源复权日线。它独立于监控任务运行，不连接数据库、不写缓存、不修改提醒、不发送 Bark，也不会启动定时任务。

## 在现有 VPS 容器中执行

使用已经部署了此版本的应用容器；命令不会拉取镜像或升级应用，也不依赖主机上的 APP_PORT。

```sh
cd /opt/fitgridweb
sudo docker compose --project-name fitgridweb \
  --env-file /etc/fitgridweb/fitgridweb.env \
  -f /opt/fitgridweb/docker-compose.yml \
  -f /opt/fitgridweb/docker-compose.low-memory.yml \
  exec -T app node_modules/.bin/tsx src/server/price-alerts/diagnose.ts all --days 20
```

可将末尾参数改为：

| 参数 | 含义 |
| --- | --- |
| 不传参数 | 全部五个产品，N=20，分别检查主、备用来源 |
| `cn --days 20` | 600519.SH、510300.SH、159919.SZ |
| `us --days 250` | AAPL.US、SPY.US；N 可以为 2–250 的整数 |
| `all --days 20 --force-failover` | 主来源标为模拟失败，只真实请求备用来源的分钟线和日线 |

在源码环境中可直接运行 `node_modules/.bin/tsx src/server/price-alerts/diagnose.ts cn --days 20`。参数只允许市场选择、均线天数和受控故障开关，不接受自定义 URL、设备 Key 或数据库参数。

固定标的映射为：

| 产品 | 主来源标识 | 备用来源标识 |
| --- | --- | --- |
| 贵州茅台 | 腾讯 `sh600519` | 东方财富 `1.600519` |
| 沪深 300 ETF | 腾讯 `sh510300` | 东方财富 `1.510300` |
| 沪深 300 ETF 嘉实 | 腾讯 `sz159919` | 东方财富 `0.159919` |
| Apple | Yahoo `AAPL` | 东方财富 `105.AAPL` |
| SPDR S&P 500 ETF | Yahoo `SPY` | 东方财富 `107.SPY` |

## 检查时间窗口

盘中使用当前交易时段内、从开盘开始对齐的最近一个已完成十分钟窗口。例如 A 股 10:03 运行时检查 09:50–10:00，不跨越午休。上午或下午刚开盘、尚不足十个完整分钟时，输出 `coverage: "insufficient"`，不请求网络，也不会用更早的窗口冒充本次检查通过。

午休、收盘后或开盘前会寻找当天或最近 22 个自然日中，已发布日历覆盖的最近一个完整交易时段，检查其最后十分钟。输出明确标为 **“历史覆盖检查，不能代表盘中新鲜度”**，`freshnessConfirmed` 为 `false`。历史检查仍需要来源实际返回所选窗口；如果来源只保留最近数据，应如实失败，不补造数据。日历未覆盖的年份直接报告不可检查。

腾讯与东方财富分钟标签使用北京时间，且标签表示该分钟的**结束**时间；东方财富的美股分钟标签同样使用北京时间。Yahoo 分钟标签表示该分钟的**开始**时间，报告标为 `America/New_York`。解析器将它们统一为 UTC 起止时间后再校验。不要因为东方财富美股标签使用北京时间而改成纽约时间解析。

## 读取结果

每个产品打印一行 JSON。只输出汇总，不打印原始响应、逐日日线价格、设备 Key 或环境变量。

- `coverage` / `label` / `window`：盘中、历史、不足十分钟或不可检查，以及实际使用的 UTC 起止时间和交易日期。
- `providers[]`：主、备用来源各自的结果。普通模式即使主来源成功，也会检查备用来源。
- `completeMinuteCount` / `minuteError`：去重并检查完整覆盖后的分钟数与失败原因，必须完整覆盖十分钟。失败适配器可能返回空数组，此时计数为 0，并保留具体覆盖错误，不代表来源原始响应完全没有分钟线。
- `daily.count` / `daily.requiredCount`：返回的此前复权日线数量及所需 N−1 数量。`from` / `to` 是返回基数的日期范围。
- `daily.historySum`：最近 N−1 个复权收盘价之和 S，以十进制字符串输出。动态 MA 使用 `(S + 当前价格) / N`；这项诊断不把静态收盘均线当成动态均线。
- `daily.adjustment` / `dailyError`：来源报告的复权口径及日线错误。沿用生产适配器：分钟完整后才请求日线；分钟请求失败时，不会把未检查的日线标为通过。
- `fetchedAt` / `durationMs`：实际请求完成时间和适配器耗时。主来源的受控模拟失败没有请求，时间为 `null`、耗时为 0。
- `primaryError`：主来源分钟失败摘要。若分钟正常但日线失败，应查看对应来源的 `dailyError`。

每个来源的 `pass` 必须同时满足十分钟完整、日线来自同一来源与同一交易日基准、数量不少于 N−1，且没有分钟或日线错误。普通模式的顶层 `pass` 和 `dualSourcePass` 只有两个来源都通过才为 `true`。

`--force-failover` 会输出 `mode: "forced-failover"`，主来源标为 `simulatedFailure: true`，不会请求主来源或生成模拟行情。备用来源仍通过真实适配器请求分钟线和日线。顶层 `pass` 表示备用来源本次覆盖通过，`dualSourcePass` 始终为 `false`；它不能证明主来源也正常，更不能证明真实自动切换、Bark 交付或整场监控已经通过。

退出码：全部选定产品的本次覆盖检查通过为 0；有失败、不足十分钟或不可检查为 1；参数或执行入口错误为 2。历史覆盖通过也可能返回 0，必须同时检查 `coverage` 和 `freshnessConfirmed`，不能据此宣布盘中新鲜度验收完成。

## 手动验收记录

分别在 A 股和美股正常交易时段、开盘至少十分钟后运行对应市场；保留运行时间、当前部署 commit 和 JSON 汇总。再运行同市场的 `--force-failover`，核对备用来源实际完成分钟与复权日线请求。闭市检查只能补充历史覆盖证据。

本命令不检查通知设备、Bark 接收、设备显示、监控定时器、去重、重启恢复或整场持续运行。这些仍需按正式验收步骤单独验证。
