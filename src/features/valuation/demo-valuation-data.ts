import type {MetricCard,Observation,ValuationPageData} from '@/server/valuation/types';
import {summarizeValuation,buildPriceHistory} from '@/server/valuation/statistics';
/** Deterministic demonstration values, never used by production collection or persisted as market data. */
export function demoValuation(id:string):ValuationPageData {
 const observations:Observation[]=[];
 for(let d=Date.parse('2022-01-03'),i=0;d<=Date.parse('2026-10-28');d+=86400000){if([0,6].includes(new Date(d).getUTCDay()))continue;observations.push({date:new Date(d).toISOString().slice(0,10),value:(2.8+i*.00065+Math.sin(i/55)*.27+Math.cos(i/17)*.08).toFixed(4),quality:'valid'});i++;}
 const make=(rows:Observation[],price=false):MetricCard=>({availability:'ready',stale:false,refreshing:false,due:false,source:'演示数据',method:price?'不复权收盘价':'指数整体法（演示）',frequency:price?'daily':'monthly',asOf:rows.at(-1)!.date,checkedAt:'2026-10-29T08:00:00Z',coverage:'source_history',message:null,points:rows,stats:summarizeValuation(rows),...(price?{prices:buildPriceHistory(rows)}:{})});
 const month=observations.filter((p,i)=>!observations[i+1]||observations[i+1].date.slice(0,7)!==p.date.slice(0,7));
 return {product:{id,code:'510880.SH',name:'上证红利ETF',currency:'CNY'},benchmark:{id:'000015',name:'上证红利'},note:'演示模式：图表使用示例数据。',price:make(observations,true),pe:make(month.map((p,i)=>({...p,value:(7+Math.sin(i/4)*1.5+i*.035).toFixed(2)}))),pb:make(month.map((p,i)=>({...p,value:(.8+Math.sin(i/6)*.14+i*.002).toFixed(2)}))),refresh:{busy:false,hasMore:false,retryAfter:null}};
}
