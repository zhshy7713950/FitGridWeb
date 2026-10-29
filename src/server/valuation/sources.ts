import { createHash } from "node:crypto";
import { PriceDecimal as Decimal } from "@/server/price-alerts/decimal";
import { dateInZone, segments, ZONES } from "@/server/price-alerts/calendar";
import { knownSeries } from "./catalog";
import type { Observation, SeriesDefinition, SeriesRequest, SeriesBatch } from "./types";

const MAX_BYTES=8*1024*1024;
function record(value: unknown): Record<string,unknown> { if(!value || typeof value!=="object" || Array.isArray(value)) throw new Error("数据源返回格式异常"); return value as Record<string,unknown>; }
function list(value:unknown): unknown[] { if(!Array.isArray(value)) throw new Error("数据源缺少历史字段"); return value; }
function date(value:unknown): string {
  const raw=String(value); const d=/^\d{8}$/.test(raw)?`${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}`:raw;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(d)) || new Date(`${d}T00:00:00Z`).toISOString().slice(0,10)!==d) throw new Error("数据源日期异常");
  return d;
}
function point(d:unknown,value:unknown): Observation {
  if(value===null || value===undefined || value==="") return {date:date(d),value:null,quality:"missing"};
  if(typeof value!=="number" && typeof value!=="string") throw new Error("数据源数值异常");
  const number=new Decimal(value);
  if(!number.isFinite() || number.abs().gte("1e20")) throw new Error("数据源数值异常");
  return {date:date(d),value:number.toString(),quality:number.gt(0)?"valid":"non_positive"};
}
function closed(d:string) {
  if([0,6].includes(new Date(`${d}T12:00:00Z`).getUTCDay()) || d==="2018-06-18") return true;
  if(d.startsWith("2026-")) return segments("cn",d).length===0;
  return false;
}
export function parseSeries(s:SeriesDefinition,body:unknown,to:string,allowEmpty=false):Observation[] {
  let rows:Observation[];
  if(s.source==="tencent") {
    const root=record(body); if(root.code!==0) throw new Error("腾讯返回业务错误");
    rows=list(record(record(root.data)[s.symbol]).day).map(v=>{const a=list(v);return point(a[0],a[2]);});
  } else if(s.source==="yahoo") {
    const chart=record(record(body).chart); if(chart.error) throw new Error("Yahoo返回业务错误");
    const r=record(list(chart.result)[0]),m=record(r.meta);
    if(m.symbol!==s.symbol || m.currency!=="USD" || m.dataGranularity!=="1d") throw new Error("Yahoo标的、币种或粒度不符");
    const closes=list(record(list(record(r.indicators).quote)[0]).close);
    const stamps=list(r.timestamp);if(stamps.length!==closes.length) throw new Error("Yahoo历史长度不匹配");
    rows=stamps.map((t,i)=>point(dateInZone(Number(t)*1000,ZONES.us),closes[i]));
  } else if(s.source==="csi") {
    const root=record(body); if(String(root.code)!=="200") throw new Error("中证返回业务错误");
    rows=list(root.data).flatMap(v=>{const r=record(v);if(r.indexCode!==s.symbol || !("peg" in r)) throw new Error("中证指数或估值字段不匹配");const d=date(r.tradeDate);return closed(d)?[]:[point(d,r.peg)];});
  } else if(s.symbol==="HSI") rows=list(body).map(v=>{const r=record(v);if(!("pe" in r))throw new Error("缺少PE字段");return point(r.date,r.pe);});
  else if(s.metric==="pb") rows=list(record(body).data).map(v=>{const r=record(v);if(!("addPb" in r))throw new Error("缺少PB字段");return point(r.date,r.addPb);});
  else {
    const root=record(body),dates=list(root.xAxis),values=list(list(root.series)[1]);
    if(dates.length!==values.length) throw new Error("估值历史长度不符");
    // Empty plotting coordinates are not independent observations.
    rows=dates.flatMap((d,i)=>values[i]===null?[]:[point(d,values[i])]);
  }
  const byDate=new Map<string,Observation>();
  for(const row of rows) {
    if(row.date>to) continue;
    if(s.frequency==="daily" && [0,6].includes(new Date(`${row.date}T12:00:00Z`).getUTCDay())) continue;
    const previous=byDate.get(row.date);if(previous && previous.value!==row.value) throw new Error("同日数据冲突");
    if(s.metric==="price" && row.quality==="non_positive") throw new Error("基金价格必须大于零");
    byDate.set(row.date,row);
  }
  rows=[...byDate.values()].sort((a,b)=>a.date.localeCompare(b.date));
  if(s.frequency==="monthly") {
    const months=new Map<string,Observation[]>();
    for(const row of rows){const m=row.date.slice(0,7);months.set(m,[...(months.get(m)??[]),row]);}
    rows=[...months.values()].map(group=>{
      if(group.length>2) throw new Error("估值采样频率改变");
      if(group.length===2 && group[0].value!==group[1].value) throw new Error("同月估值冲突");
      return group.at(-1)!;
    });
  }
  if(!rows.length && !allowEmpty) throw new Error("数据源未返回可用历史");
  return rows;
}
export function requestFor(s:SeriesDefinition,from:string,to:string):{url:string;init?:RequestInit} {
  const known=knownSeries(s.key);
  if(!known || known.symbol!==s.symbol || known.source!==s.source || known.metric!==s.metric) throw new Error("未允许的数据序列");
  date(from);date(to);
  if(s.source==="tencent") return {url:`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${s.symbol},day,${from},${to},640,`};
  if(s.source==="yahoo") return {url:`https://query1.finance.yahoo.com/v8/finance/chart/${s.symbol}?interval=1d&period1=${Date.parse(from)/1000}&period2=${Date.parse(to)/1000+86400}&includePrePost=false`};
  if(s.source==="csi") return {url:`https://www.csindex.com.cn/csindex-home/perf/index-perf?indexCode=${s.symbol}&startDate=${from.replaceAll("-","")}&endDate=${to.replaceAll("-","")}`};
  const token=createHash("md5").update(dateInZone(Date.now(),ZONES.cn)).digest("hex");
  if(s.metric==="pb")return {url:`https://legulegu.com/api/stockdata/index-basic-pb?indexCode=${s.symbol}&freq=month&token=${token}`};
  if(s.symbol==="HSI") return {url:`https://legulegu.com/api/stockdata/market/hk/dv/hsi?token=${token}`};
  return {url:`https://legulegu.com/stockdata/market/${s.symbol==="SP500"?"sandp":"nasdaq100"}`};
}
async function readResponse(r:Response):Promise<string> {
  if(!r.ok) throw new Error(`数据源返回HTTP ${r.status}`);
  if(Number(r.headers.get("content-length"))>MAX_BYTES) throw new Error("数据源响应过大");
  if(!r.body) throw new Error("数据源响应为空");
  const reader=r.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try {for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>MAX_BYTES)throw new Error("数据源响应过大");chunks.push(part.value);}} finally {await reader.cancel();}
  return Buffer.concat(chunks).toString("utf8");
}
export async function fetchSeriesBatch(request:SeriesRequest, options:{signal:AbortSignal;fetcher?:typeof fetch}):Promise<SeriesBatch> {
  const {series:s,from,to}=request, spec=requestFor(s,from,to), fetcher=options.fetcher??fetch;
  const signal=AbortSignal.any([options.signal,AbortSignal.timeout(5000)]);
  const r=await fetcher(spec.url,{...spec.init,signal,cache:"no-store",redirect:"error",headers:{Accept:"application/json, text/html"}});
  let text=await readResponse(r);
  if(s.source==="legu" && s.metric==="pe" && s.symbol!=="HSI") {
    const csrf=text.match(/name="_csrf"[^>]*content="([^"]+)"/)?.[1];
    if(!csrf)throw new Error("公开估值页面暂不可访问");
    const token=createHash("md5").update(dateInZone(Date.now(),ZONES.cn)).digest("hex");
    const cookie=r.headers.getSetCookie().map(v=>v.split(";")[0]).join("; ");
    const body={requestedDataKeys:[s.symbol==="SP500"?"sp500Index":"nasdaq100Index",s.symbol==="SP500"?"sp500Pe":"nasdaq100Pe"],types:["line","line"],requestedDataColors:["#e74c3c","#1f97c4"],splitLines:[false,true]};
    text=await readResponse(await fetcher(`https://legulegu.com/api/get-aggregation-data/${s.symbol==="SP500"?"exp":"preview"}?token=${token}`,{method:"POST",signal,cache:"no-store",redirect:"error",headers:{"Content-Type":"application/json","X-CSRF-Token":csrf,Cookie:cookie},body:JSON.stringify(body)}));
  }
  const parsed:unknown=JSON.parse(text);
  const observations=parseSeries(s,parsed,to,request.allowEmpty);
  return {observations:observations.filter(p=>p.date>=from),reachedStart:observations.length===0 || s.frequency==="monthly"};
}
