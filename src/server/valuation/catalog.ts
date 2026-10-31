import type { Metric, SeriesDefinition, ValuationProduct } from "./types";

function series(subject: string, metric: Metric, source: SeriesDefinition["source"], symbol: string): SeriesDefinition {
  const frequency = metric === "dividend_yield" && source === "legu" && symbol !== "HSI" ? "weekly" : source === "legu" || source === "multpl" ? "monthly" : source === "eastmoney_disclosures" ? "event" : "daily";
  const method = metric === "dividend_yield" ? source === "multpl" ? "标普500及前身历史股息率：12个月每股股息/指数价格；来源标记的估算值留空" : "对应指数股息率（供方历史口径，非基金分派率；未核验零值留空）" : metric === "distribution" ? "基金管理人分红公告：每份税前现金分派，场内除息日" : metric === "price" ? "不复权收盘价" : source === "csi" ? "滚动PE（中证peg字段）" : metric === "pb" ? "整体法PB（addPb）" : "供方历史PE";
  return { key: `${subject}:${metric}:${source}:${frequency}:v1:raw`, subject, metric, source, symbol, method, frequency,
    sourceLabel: { tencent: "腾讯行情", yahoo: "Yahoo Finance", csi: "中证指数", legu: "乐咕乐股", eastmoney_disclosures: "基金管理人分红公告（东方财富转载）", multpl: "Multpl（S&P / Shiller历史资料）" }[source] };
}
const definitions: Array<[string,string,string|null,string|null,ValuationProduct["kind"]?]> = [
  ["512980","传媒ETF","399971","中证传媒"],["159920","恒生指数ETF","HSI","恒生指数"],
  ["159938","医药ETF","000991","中证全指医药卫生"],["512880","证券ETF","399975","中证全指证券公司"],
  ["513180","恒生科技ETF","HSTECH","恒生科技"],["159928","消费ETF","000990","中证全指主要消费"],
  ["510880","上证红利ETF","000015","上证红利"],["515400","大数据ETF","930902","中证大数据产业"],
  ["512890","红利低波ETF","H30269","中证红利低波动"],["515120","创新药ETF","931152","中证创新药产业"],
  ["159399","现金流ETF","FTSE_CASHFLOW","富时中国A股自由现金流聚焦指数"],
  ["161130","纳斯达克100联接LOF","NDX","纳斯达克100","lof"],["159766","旅游ETF","930633","中证旅游主题"],
  ["513650","标普500ETF南方","SP500","S&P 500"],["508000","张江产业园REIT",null,null,"reit"],
  ["508056","普洛斯REIT",null,null,"reit"],["159209","红利质量ETF","932315","中证全指红利质量"],
  ["VOO","标普500指数ETF","SP500","S&P 500"],["512040","价值100ETF","931052","中证国信价值"],
  ["512260","中证500低波ETF","930782","中证500行业中性低波动"],
  ["159638","航空航天ETF","931521","中证智选航空航天科技"],["588680","科创100增强ETF","000698","上证科创板100"],
  ["159338","中证A500ETF","000510","中证A500"],["SCHD","美国股息100ETF","DJDIV100","Dow Jones U.S. Dividend 100"],
  ["510300","沪深300ETF","000300","沪深300"],["510500","中证500ETF","000905","中证500"],
];
export const PRODUCTS: ValuationProduct[] = definitions.map(([code,name,index,indexName,kind="etf"]) => {
  const market = /^[A-Z]/.test(code) ? "us" : "cn";
  const exchange = code.startsWith("1") ? "SZ" : "SH";
  const canonical = `${code}.${market === "us" ? "US" : exchange}`;
  const domestic = index !== null && /^(?:\d{6}|H\d{5})$/.test(index);
  const global = index !== null && ["HSI","SP500","NDX"].includes(index);
  // Only PB mappings with archived field/method evidence are enabled.
  const pb = index !== null && ["000015","000300","000905"].includes(index);
  return { code: canonical, name, market, currency: market === "us" ? "USD" : "CNY", kind,
    benchmark: index && indexName ? {id:index,name:indexName}:null,
    listedAt: kind === "reit" ? "2021-06-21" : null,
    mappingSince: code === "159638" ? "2026-08-28" : null,
    note: code === "588680" ? "增强策略基金：指数仅为参考基准，不代表实际组合估值。" : code === "159638" ? "指数方法于2026-08-28变更，变更前历史不拼接到现行方法。" : kind === "lof" ? "场内价格为本基金LOF价格，指数估值仅供参考。" : null,
    series: { price: series(canonical,"price",market === "us" ? "yahoo" : "tencent",market === "us" ? code : `${exchange.toLowerCase()}${code}`),
      pe: domestic ? series(index!,"pe","csi",index!) : global ? series(index!,"pe","legu",index!):null,
      pb: pb ? series(index!,"pb","legu",`${index}.SH`):null,
      distribution: kind === "reit" ? series(canonical,"distribution","eastmoney_disclosures",code) : null,
      dividend_yield: pb ? series(index!,"dividend_yield","legu",`${index}.SH`) : index === "HSI" ? series(index,"dividend_yield","legu",index) : index === "SP500" ? series(index,"dividend_yield","multpl",index) : null } };
});
export function resolveValuationProduct(code: string): ValuationProduct | null {
  const value=code.trim().toUpperCase();
  return PRODUCTS.find(p=>p.code === value || p.code.split(".")[0] === value) ?? null;
}
export function knownSeries(key: string): SeriesDefinition | undefined {
  return PRODUCTS.flatMap(p=>Object.values(p.series)).find((s): s is SeriesDefinition=>s?.key===key);
}
