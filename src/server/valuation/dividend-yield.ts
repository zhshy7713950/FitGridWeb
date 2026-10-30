import {PriceDecimal as Decimal} from '@/server/price-alerts/decimal';
import type {Observation} from './types';
export interface DistributionCoverage {from:string;through:string}
function yearAgo(date:string):string{
 const [year,month,day]=date.split('-').map(Number),last=new Date(Date.UTC(year-1,month,0)).getUTCDate();
 return `${year-1}-${String(month).padStart(2,'0')}-${String(Math.min(day,last)).padStart(2,'0')}`;
}
export function buildDividendYield(prices:Observation[],distributions:Observation[],coverage:DistributionCoverage|null):{points:Observation[];trailingDistribution:string|null}{
 const unique=new Map<string,Observation>();
 for(const event of distributions){const id=event.distribution?.noticeId??event.date,prior=unique.get(id);if(prior&&JSON.stringify(prior)!==JSON.stringify(event))throw new Error('分派事件重复冲突');unique.set(id,event);}
 const events=[...unique.values()];let trailingDistribution:string|null=null;
 const points=prices.map((price,i):Observation=>{
  const left=yearAgo(price.date);
  const uncertain=events.some(e=>!e.distribution?.verified&&price.date>=(e.distribution?.announcedAt??e.date));
  if(!coverage||left<coverage.from||price.date>coverage.through||price.quality!=='valid'||price.value===null||!new Decimal(price.value).gt(0)||uncertain)return {date:price.date,value:null,quality:'missing'};
  let sum=new Decimal(0);
  for(const event of events){const ex=event.distribution?.exDate;if(!event.distribution?.verified||!ex||ex<=left||ex>price.date)continue;if(event.quality!=='valid'||event.value===null||new Decimal(event.value).lt(0))return {date:price.date,value:null,quality:'missing'};sum=sum.plus(event.value);}
  if(i===prices.length-1)trailingDistribution=sum.toString();
  return {date:price.date,value:sum.div(price.value).mul(100).toString(),quality:'valid'};
 });
 return {points,trailingDistribution};
}
