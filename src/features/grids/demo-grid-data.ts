import type { GridTradePage, GridTradeSummary } from "./types";

const products = [
  ["黄金 ETF", "518880", "6.9200", "1500"],
  ["沪深 300 ETF", "510300", "4.1200", "2000"],
  ["创业板 ETF", "159915", "2.7800", "1800"],
  ["科创 50 ETF", "588000", "1.1600", "2400"],
  ["红利 ETF", "510880", "3.4200", "1600"],
  ["纳指 ETF", "513100", "1.7900", "2200"],
  ["标普 500 ETF", "513500", "2.1100", "2100"],
  ["恒生科技 ETF", "513180", "0.8200", "2600"],
  ["中概互联网 ETF", "513050", "1.3500", "2300"],
  ["医药 ETF", "512010", "0.4600", "2800"],
  ["消费 ETF", "159928", "0.9100", "2500"],
  ["证券 ETF", "512880", "1.2400", "2000"],
  ["军工 ETF", "512660", "1.1800", "1900"],
  ["新能源车 ETF", "515030", "1.0500", "2100"],
  ["芯片 ETF", "512760", "1.3300", "2400"],
  ["半导体 ETF", "512480", "1.2700", "2200"],
  ["银行 ETF", "512800", "1.4900", "1800"],
  ["煤炭 ETF", "515220", "1.6100", "1700"],
  ["有色金属 ETF", "512400", "1.2600", "1950"],
  ["原油 LOF", "162411", "1.4500", "2050"],
  ["白银 LOF", "161226", "1.1200", "2150"],
  ["日经 ETF", "513520", "1.6300", "2250"],
  ["德国 ETF", "513030", "1.5800", "2350"],
  ["法国 CAC40 ETF", "513080", "1.3900", "2450"],
] as const;

const createdAt = "2026-09-01T00:00:00.000Z";

const demoProducts: GridTradeSummary[] = products.map(
  ([productName, productCode, maxPrice, perShare], index) => ({
    id: `demo-grid-${String(index + 1).padStart(2, "0")}`,
    productName,
    productCode,
    maxPrice,
    perShare,
    isShort: index % 7 === 6,
    algorithmVersion: "android-v2.1.0",
    createdAt,
    updatedAt: createdAt,
  }),
);

export function listDemoGridTrades({
  q,
  cursor,
}: {
  q?: string;
  cursor?: string;
} = {}): GridTradePage {
  const normalized = q?.trim().toLocaleLowerCase("zh-CN") ?? "";
  const filtered = normalized
    ? demoProducts.filter((item) =>
        `${item.productName} ${item.productCode}`.toLocaleLowerCase("zh-CN").includes(normalized),
      )
    : demoProducts;
  const start = cursor?.startsWith("demo:")
    ? Number.parseInt(cursor.slice("demo:".length), 10)
    : 0;
  const safeStart = Number.isSafeInteger(start) && start >= 0 ? start : 0;
  const items = filtered.slice(safeStart, safeStart + 20);
  const nextOffset = safeStart + items.length;

  return {
    items,
    nextCursor: nextOffset < filtered.length ? `demo:${nextOffset}` : null,
  };
}
