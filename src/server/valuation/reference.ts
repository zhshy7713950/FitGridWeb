import {PriceDecimal as Decimal} from '@/server/price-alerts/decimal';
import {summarizeValuation} from './statistics';
import type {MetricCard,Observation,ReferenceBasis,ReferenceMetric,ValuationProduct} from './types';

const DAY=86400000;
function valid(row:Observation|undefined,allowZero=false):row is Observation&{value:string}{
 if(!row||row.quality!=='valid'||row.value===null)return false;
 try{return new Decimal(row.value).isFinite()&&(allowZero?new Decimal(row.value).gte(0):new Decimal(row.value).gt(0));}catch{return false;}
}
function age(date:string,other:string){return (Date.parse(other+'T00:00:00Z')-Date.parse(date+'T00:00:00Z'))/DAY;}
/** Analysis windows are separate from chart statistics; no new collection or persistence. */
export function buildReferenceBasis(metric:ReferenceMetric,card:MetricCard|null,price:MetricCard,kind:ValuationProduct['kind']|null,now:Date):ReferenceBasis {
 const result:ReferenceBasis={metric,status:'unavailable',reason:null,target:null,current:null,metricDate:null,anchorPrice:null,anchorDate:null,latestPrice:null,latestPriceDate:null,conditionPrice:null,startPrice:null,changePercent:null,months:0,years:null,windowStart:null,windowEnd:null,warnings:[]};
 const unavailable=(reason:string)=>({...result,reason});
 if(!kind||!card||card.availability!=='ready'||(kind==='reit'&&metric!=='dividendYield'))return unavailable('暂无适用且已核验的估值数据。');
 const today=now.toISOString().slice(0,10),current=card.points.at(-1),latest=price.points.at(-1);
 if(!valid(current))return unavailable('最新指标缺失、为零或未核验，不能用更早值替代。');
 const maximumAge=card.frequency==='monthly'?93:card.frequency==='weekly'?21:14;
 if(age(current.date,today)<0||age(current.date,today)>maximumAge)return unavailable('指标日期过旧或尚未发生，暂不换算启动价。');
 if(!valid(latest)||age(latest.date,today)<0||age(latest.date,today)>7)return unavailable('缺少最近7日内的有效基金收盘价。');
 const anchor=price.points.filter(row=>row.date<=current.date).at(-1);
 if(!valid(anchor)||age(anchor.date,current.date)>7)return unavailable('缺少指标同日或此前7日内的有效价格，暂不跨日期推算。');
 const monthStart=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1));
 const end=new Date(+monthStart-DAY).toISOString().slice(0,10);
 const months=new Map<string,Observation>();
 for(const row of card.points)if(row.date<=end)months.set(row.date.slice(0,7),row);
 let sample:Observation[]=[];
 for(const years of [10,5]){
  const start=new Date(Date.UTC(now.getUTCFullYear()-years,now.getUTCMonth(),1)).toISOString().slice(0,10);
  const selected=[...months.values()].filter(row=>row.date>=start&&valid(row,kind==='reit'&&metric==='dividendYield'));
  const minimum=years===10?108:kind==='reit'?24:54;
  if(selected.length<minimum)continue;
  sample=selected;result.years=years;result.windowStart=start;result.windowEnd=end;break;
 }
 if(!sample.length)return unavailable(kind==='reit'?'不足24个完整月的有效分派率历史。':'最近10年或5年的有效月份不足，参考方案留空。');
 const stats=summarizeValuation(sample,{allowZero:kind==='reit'&&metric==='dividendYield'}),target=metric==='dividendYield'?stats.p70:stats.p30;
 if(!target||new Decimal(target).lte(0))return unavailable('参考分位无法计算。');
 const condition=new Decimal(anchor.value).mul(metric==='dividendYield'?new Decimal(current.value).div(target):new Decimal(target).div(current.value));
 const start=Decimal.min(condition,latest.value).toDecimalPlaces(3,Decimal.ROUND_FLOOR);
 if(!start.gt(0))return unavailable('条件价格低于现有网格的价格精度。');
 const warnings=['条件换算假设盈利、净资产或每份分红不变；未核验跟踪差异、汇率及折溢价，不能据此判断当前可以买入。'];
 if(card.stale||price.stale||!card.checkedAt||!price.checkedAt)warnings.push('依据包含已保存缓存，来源更新状态与日期见图表。');
 if(result.years===5)warnings.push('十年历史不足，使用五年窗口；短历史可能显著影响结果。');
 if(kind==='reit')warnings.push('分派不变仅为情景假设；尚未评估出租率、资产经营及未来分派可持续性。');
 if(condition.gt(latest.value))warnings.push('条件价高于最新收盘价，启动演算价取最新收盘价后向下取整，不抬高买入价格。');
 return {...result,status:'conditional',target,current:current.value,metricDate:current.date,anchorPrice:anchor.value,anchorDate:anchor.date,latestPrice:latest.value,latestPriceDate:latest.date,conditionPrice:condition.toDecimalPlaces(8).toString(),startPrice:start.toString(),changePercent:start.div(latest.value).minus(1).mul(100).toDecimalPlaces(2).toString(),months:sample.length,warnings};
}
