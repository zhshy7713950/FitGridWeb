# 网格算法规格

## 1. 权威版本

- 来源：`FitProj/app/src/main/java/com/zsy/fit/data/repository/GridTradeRepositoryImpl.kt`
- 源码基线：`a6452ac` / `v2.1.0`
- Web 算法标识：`android-v2.1.0`
- 黄金数据：[grid-algorithm-v2.1.0.json](fixtures/grid-algorithm-v2.1.0.json)

Web 实现必须把算法放在独立领域模块，由 API、导入和重新计算共同调用。客户端可以显示预览，但服务端结果始终是权威结果。

## 2. 数值语义

### 2.1 Android 行为

- 输入与实体使用 Kotlin `Float`。
- 部分乘除使用 `BigDecimal(String)`，最后又转换回 `Float`。
- `roundHalfUp` 通过 `BigDecimal(Float.toDouble())` 和 `ROUND_HALF_UP` 实现。
- 价格通常保留 3 位，金额保留 2 位，行盈利率保留 4 位。
- 显示层再按字段执行去尾零或百分比转换。

### 2.2 Web 等价规则

- 使用十进制定点库，不允许直接使用 JavaScript `number` 执行业务计算。
- 每一步必须在与 Android 相同的位置进行 `ROUND_HALF_UP`，不能只在最终结果取整。
- API 中所有十进制值使用字符串，例如 `"1.050"`；显示层可以去除无意义尾零。
- Android 兼容导出将最终十进制安全转换为 JSON 数字。
- 黄金 fixtures 中的数字是 Android Gson 特征输出，用于比对，不代表 Web API 线格式。

## 3. 公共函数

定义：

- `R2(x)`：四舍五入到 2 位，`ROUND_HALF_UP`。
- `R3(x)`：四舍五入到 3 位，`ROUND_HALF_UP`。
- `R4(x)`：四舍五入到 4 位，`ROUND_HALF_UP`。
- `Q(amount, price, minQty)`：按最小交易数量取整后的数量。

```text
Q(amount, price, minQty) =
  if price = 0 or minQty = 0: 0
  else ROUND_HALF_UP_TO_INTEGER(amount / price / minQty) * minQty
```

`ROUND_HALF_UP_TO_INTEGER` 表示恰好半档时向绝对值更大的方向取整，与 `BigDecimal.setScale(0, ROUND_HALF_UP)` 一致。

## 4. 做多算法

### 4.1 网格数量

```text
小网数量 = floor(maxAmplitude / gearAmplitude) + 1
中网数量 = mediumAmplitude 有值时 floor(maxAmplitude / mediumAmplitude)，否则 0
大网数量 = bigAmplitude 有值时 floor(maxAmplitude / bigAmplitude)，否则 0
```

小网包含 `gear = 100` 的首档。中网和大网从 `100 - amplitude` 开始，因此不重复 100 档。

### 4.2 档位与插入顺序

每种网格自己的档位：

```text
gear(k) = 100 - k * amplitude
```

- 小网 `k` 从 0 开始。
- 中网和大网 `k` 从 1 开始。
- 全部行按 `gear` 由高到低合并。
- 同一 `gear` 下顺序固定为小网、中网、大网。
- 最终按合并顺序从 1 编号。

### 4.3 逐格加码

对当前行，先统计 `gear >= 当前 gear` 的已有小网数量 `n`。如果当前不是小网且 `n > 0`，令 `n = n - 1`。

```text
rowBudget = perShare * (1 + increaseAmplitude / 100) ^ n
```

Android 在这里保留 BigDecimal 中间精度，进入数量计算前转为 Float。Web 使用十进制幂运算，并按黄金用例验证结果。

### 4.4 价格

```text
buyPrice = R3(maxPrice * gear / 100)
```

每个网格种类的首个卖出价格：

- 小网：`R3(maxPrice * (1 + trunc(gearAmplitude) / 100))`
- 中网：`maxPrice`
- 大网：`maxPrice`

后续行：

```text
sellPrice(k) = 前一条同种网格的 buyPrice
```

注意：Android 小网首档把浮点 `gearAmplitude` 截断为整数后计算卖价。例如 `7.5` 使用 `7%` 得到 `10.7`，不是 `10.75`。这是 v2.1.0 的真实行为。Web 首期为保持黄金结果而保留，并在未来算法升级时通过新的 `algorithmVersion` 修正。

### 4.5 数量、盈利与留存

```text
buyCount    = Q(rowBudget, buyPrice, minTradeQuantity)
buyAmount   = R2(buyPrice * buyCount)
profitAmount= R2((sellPrice - buyPrice) * buyCount)
profitRate  = buyAmount = 0 ? 0 : R4(profitAmount / buyAmount)
```

只有小网计算留存：

```text
keepCount  = Q(profitAmount * keepShare, sellPrice, minTradeQuantity)
keepProfit = R2(keepCount * sellPrice)
sellCount  = max(0, buyCount - keepCount)
sellAmount = R2(sellCount * sellPrice)
```

中网和大网的 `keepCount`、`keepProfit` 固定为 0。

`keepShare` 在源码中的实际含义不是百分比，而是用于放大本期利润金额后换算可留存数量的非负整数倍数。

### 4.6 汇总

```text
totalBuyAmount    = R2(sum(row.buyAmount))
totalProfitAmount = R2(sum(row.profitAmount))
totalProfitRate   = totalBuyAmount = 0
                  ? 0
                  : R4(totalProfitAmount / totalBuyAmount)
```

汇总包含小网、中网和大网的所有行。

## 5. 做空算法

做空只生成小网，不使用 `keepShare`、`mediumAmplitude` 和 `bigAmplitude`。

### 5.1 数量与遍历

```text
countPerSide = floor(maxAmplitude / gearAmplitude)
```

循环 `i = countPerSide ... 0`，从最高卖出价向当前价排列，因此共生成 `countPerSide + 1` 行。

### 5.2 价格与预算

令：

```text
priceBase  = 1 + gearAmplitude / 100
amountBase = 1 + increaseAmplitude / 100
```

当 `i > 0`：

```text
sellPrice    = R3(maxPrice * priceBase ^ i)
referenceAmt = R2(perShare * amountBase ^ i)
```

当 `i = 0`：

```text
sellPrice    = maxPrice
referenceAmt = perShare
```

其余字段：

```text
sellCount   = Q(referenceAmt, sellPrice, minTradeQuantity)
sellAmount  = R2(sellCount * sellPrice)
buyPrice    = R3(sellPrice * (1 - gearAmplitude / 100))
buyCount    = sellCount
buyAmount   = R2(buyCount * buyPrice)
profitAmount= R2(sellAmount - buyAmount)
profitRate  = sellAmount = 0 ? 0 : R4(profitAmount / sellAmount)
gear        = 100 - (countPerSide - i) * gearAmplitude
```

注意：做空行盈利率使用 `sellAmount` 作分母，做多使用 `buyAmount` 作分母。这是 v2.1.0 的既有语义。

### 5.3 汇总

汇总公式与做多相同，`totalProfitRate` 仍以总 `buyAmount` 为分母，因此它与各做空行的盈利率分母并不一致。首期保持此行为并用黄金 fixtures 锁定。

## 6. 输入校验与防护

Web 在调用算法前必须执行：

- `maxPrice > 0`
- `minTradeQuantity > 0`
- `gearAmplitude > 0 && gearAmplitude <= 100`
- `perShare > 0`
- `maxAmplitude` 为整数，`1..100`
- `increaseAmplitude` 为非负整数
- `keepShare` 为非负整数
- 做多的中网/大网幅度为空或 `> 0`
- 做空时服务端忽略并归零/置空留存、中网和大网参数
- 预估总行数不得超过 10,000；超过时返回 `GRID_SIZE_LIMIT_EXCEEDED`
- 所有十进制输入必须是有限值，禁止 `NaN`、无穷、指数溢出和超过数据库精度

这些规则修复 Android 中 0 幅度可能触发超大循环的问题，不属于算法版本差异。

## 7. 算法版本与升级

- 新记录固定保存创建时使用的 `algorithmVersion`。
- 首期只实现 `android-v2.1.0`。
- 重新计算默认使用记录保存的版本，不自动改变历史策略结果。
- 未来修复浮点截断或分母差异时必须新增版本，不得静默修改旧版本。
- 导入 Android JSON 时默认标记为 `android-v2.1.0`。

## 8. 特征测试结果摘要

| 用例 | 行数 | 总买入金额 | 总盈利 | 总盈利率 |
|---|---:|---:|---:|---:|
| 默认做多 | 19 | 53225.00 | 9880.00 | 0.1856 |
| 默认做空 | 13 | 33652.00 | 1772.00 | 0.0527 |
| 做多非整除振幅 | 11 | 18030.00 | 3341.50 | 0.1853 |
| 做多最小数量 1 | 8 | 7898.94 | 2676.77 | 0.3389 |
| 做空非整除振幅 | 3 | 4647.03 | 323.29 | 0.0696 |
