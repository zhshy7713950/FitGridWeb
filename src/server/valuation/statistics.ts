import { PriceDecimal as Decimal } from '@/server/price-alerts/decimal';
import type { MetricSummary, Observation, PricePoint } from './types';

function positive(p:Observation,allowZero=false):boolean {
  return p.quality==='valid' && p.value!==null && new Decimal(p.value).isFinite() && (allowZero?new Decimal(p.value).gte(0):new Decimal(p.value).gt(0));
}
function ordered(points:Observation[]) {
  for(let i=1;i<points.length;i++) if(points[i].date<=points[i-1].date) throw new Error('历史日期必须唯一并按升序排列');
}
export function summarizeValuation(points:Observation[],options:{allowZero?:boolean}={}):MetricSummary {
  ordered(points);
  const valid=points.filter(p=>positive(p,options.allowZero)), values=valid.map(p=>new Decimal(p.value!)).sort((a,b)=>a.cmp(b));
  const latest=points.at(-1), current=latest && positive(latest,options.allowZero)?new Decimal(latest.value!):null;
  const reference=current?valid.slice(0,-1):valid;
  const quantile=(q:string)=>{
    if(values.length<2)return null;
    const h=new Decimal(values.length-1).mul(q),i=h.floor().toNumber();
    return values[i].plus((values[i+1]??values[i]).minus(values[i]).mul(h.minus(i))).toDecimalPlaces(8).toString();
  };
  let rank:string|null=null;
  if(current && reference.length>=2) {
    const score=reference.reduce((n,p)=>n.plus(new Decimal(p.value!).lt(current)?1:new Decimal(p.value!).eq(current)?'0.5':0),new Decimal(0));
    rank=score.mul(100).div(reference.length).toDecimalPlaces(4).toString();
  }
  return {min:values[0]?.toString()??null,max:values.at(-1)?.toString()??null,p30:quantile('0.3'),p50:quantile('0.5'),p70:quantile('0.7'),
    currentValue:current?.toString()??null,currentPercentile:rank,latestDate:latest?.date??null,latestValidDate:valid.at(-1)?.date??null,
    validCount:valid.length,referenceCount:reference.length,start:valid[0]?.date??null,end:valid.at(-1)?.date??null};
}
export function buildPriceHistory(points:Observation[]):PricePoint[] {
  ordered(points);
  let run:string[]=[];const sums={250:new Decimal(0),500:new Decimal(0)};
  return points.map(p=>{
    if(!positive(p)) {run=[];sums[250]=new Decimal(0);sums[500]=new Decimal(0);return {date:p.date,close:null,ma250:null,ma500:null};}
    run.push(p.value!);
    for(const n of [250,500] as const){sums[n]=sums[n].plus(p.value!);if(run.length>n)sums[n]=sums[n].minus(run[run.length-n-1]);}
    const row={date:p.date,close:p.value,ma250:run.length>=250?sums[250].div(250).toDecimalPlaces(8).toString():null,ma500:run.length>=500?sums[500].div(500).toDecimalPlaces(8).toString():null};
    // Retain at most 501 entries for constant-memory rolling sums.
    if(run.length>501)run=run.slice(-501);
    return row;
  });
}
