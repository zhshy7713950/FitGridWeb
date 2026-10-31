import {ApiError} from '@/server/http/api-error';
import {dateInZone,segments,ZONES,localTimeUtc} from '@/server/price-alerts/calendar';
import {resolveValuationProduct} from './catalog';
import {archivedObservations} from './archive';
import {summarizeValuation,buildPriceHistory} from './statistics';
import {fetchSeriesBatch} from './sources';
import {buildDividendYield} from './dividend-yield';
import type {HistoryStore} from './repository';
import type {Metric,MetricCard,SeriesDefinition,SeriesSnapshot,ValuationPageData,ValuationProduct,SeriesRequest,SeriesBatch,DividendYieldCard} from './types';

const DAY=86400000,WEEK=7*DAY;
const metrics:Metric[]=['price','pe','pb'];
function shift(d:string,days:number){return new Date(Date.parse(`${d}T12:00:00Z`)+days*DAY).toISOString().slice(0,10);}
function sourceMarket(s:SeriesDefinition):'cn'|'us'{return s.source==='yahoo'||['NDX','SP500'].includes(s.subject)?'us':'cn';}
/** Trading-day calendar is used only for recent complete sessions, never to invent historical rows. */
export function completedDate(s:SeriesDefinition,now:Date):string {
 const market=sourceMarket(s),zone=ZONES[market];let d=dateInZone(+now,zone);
 for(let i=0;i<30;i++,d=shift(d,-1)) {
  if([0,6].includes(new Date(`${d}T12:00:00Z`).getUTCDay()))continue;
  try {const sessions=segments(market,d);if(!sessions.length)continue;if(+now>=sessions.at(-1)!.end+300000)return d;}
  catch {if(+now>=localTimeUtc(d,market==='cn'?'15:05':'16:05',zone))return d;}
 }
 throw new Error('暂不能确定最近完整交易日');
}
function due(s:SeriesDefinition,r:SeriesSnapshot|null,now:Date):boolean{
 if(r?.retryAt && Date.parse(r.retryAt)>+now)return false;
 if(!r?.checkedAt || !r.complete)return true;
 return s.metric==='price'?completedDate(s,new Date(r.checkedAt))<completedDate(s,now):+now-Date.parse(r.checkedAt)>=WEEK;
}
function card(s:SeriesDefinition|null,r:SeriesSnapshot|null,product:ValuationProduct|null,metric:Metric,now:Date):MetricCard {
 const points=r?.observations??[],stats=summarizeValuation(points);
 if(!s)return {availability:product?.kind==='reit'&&metric!=='price'?'not_applicable':'unsupported',stale:false,refreshing:false,due:false,
   source:null,method:null,frequency:null,asOf:null,checkedAt:null,coverage:'none',message:product?.kind==='reit'?'REIT的PE/PB不适用，价格数据可单独查看。':product?'暂无已核验的免费历史数据，指标留空。':'暂未匹配到该产品的数据。',points:[],stats};
 const old=!!stats.latestValidDate && stats.latestValidDate<shift(completedDate(s,now),s.frequency==='monthly'?-93:s.metric==='price'?0:-14);
 const message=r?.error?(points.length?'更新失败，正在展示已保存数据。':'更新失败，暂无已保存数据，请稍后重试。'):!points.length?'尚无本地数据，正在等待首次获取。':!r?.checkedAt?'已保存的研究归档，数据日期见下方；尚未完成在线更新。':old?'来源暂未提供较新的观测，正在展示已保存数据。':!r.complete?'正在补充更早历史；统计基于当前已保存范围。':null;
 return {availability:points.length?'ready':r?.error?'error':'empty',stale:old||!r?.checkedAt||+now-Date.parse(r.checkedAt)>=WEEK,refreshing:!!r?.leaseUntil&&Date.parse(r.leaseUntil)>+now,
   due:due(s,r,now),source:s.sourceLabel,method:s.method,frequency:s.frequency==='event'?null:s.frequency,asOf:stats.latestDate,checkedAt:r?.checkedAt??null,
   coverage:points.length?(r?.complete?'source_history':'partial'):'none',message,points,stats,...(metric==='price'?{prices:buildPriceHistory(points)}:{})};
}
function dividendCard(product:ValuationProduct,snapshot:SeriesSnapshot|null,price:MetricCard,now:Date):DividendYieldCard {
 const definition=product.series.distribution!,base=card(definition,snapshot,product,'distribution',now);
 const distributionAsOf=snapshot?.checkedAt?dateInZone(Date.parse(snapshot.checkedAt),ZONES.cn):null;
 // Recompute daily prices against the verified event cache during its seven-day freshness period.
 const through=distributionAsOf?(snapshot?.checkedAt&&+now-Date.parse(snapshot.checkedAt)<WEEK?completedDate(product.series.price!,now):distributionAsOf):null;
 const history=buildDividendYield(price.points,snapshot?.observations??[],product.listedAt&&through?{from:product.listedAt,through}:null);
 const stats=summarizeValuation(history.points,{allowZero:true});
 const message=snapshot?.error?base.message:!snapshot?.checkedAt?'尚无已核验的分派缓存，正在等待首次获取。':!snapshot.complete?'正在逐条核验分派公告，受影响的分派率窗口留空。':stats.currentValue===null?'完整分派历史不足12个月，或窗口内有尚未核验的分派记录；分派率留空。':null;
 return {...base,availability:stats.validCount?'ready':snapshot?.error?'error':'empty',stale:!!snapshot?.error||!snapshot?.checkedAt||+now-Date.parse(snapshot.checkedAt)>=WEEK||price.stale,
  method:'近12个自然月每份税前现金分派合计 ÷ 当日不复权收盘价 × 100%；按场内除息日计入',frequency:'daily',asOf:price.asOf,
  points:history.points,stats,coverage:stats.validCount?(snapshot?.complete&&price.coverage==='source_history'?'source_history':'partial'):'none',message,
  trailingDistribution:history.trailingDistribution,distributionAsOf};
}

interface Dependencies {
 grid:{get(ownerId:string,id:string):Promise<{id:string;productCode:string;productName?:string|null}>};
 store:HistoryStore;fetch?: (request:SeriesRequest,options:{signal:AbortSignal})=>Promise<SeriesBatch>;
 clock?:()=>Date;beforeRequest:()=>Promise<void>;
}
export class ValuationService {
 private readonly clock:()=>Date;
 constructor(private readonly deps:Dependencies){this.clock=deps.clock??(()=>new Date());}
 async read(ownerId:string,id:string):Promise<ValuationPageData>{
  const grid=await this.deps.grid.get(ownerId,id),p=resolveValuationProduct(grid.productCode),now=this.clock();
  const snapshots=await Promise.all([...metrics.map(metric=>p?.series[metric]??null),p?.series.distribution??null,p?.series.dividend_yield??null].map(s=>s?this.deps.store.readSeries(s):null));
  const cards=metrics.map((metric,i)=>card(p?.series[metric]??null,snapshots[i],p,metric,now));
  const dividendYield=p?.kind==='reit'?dividendCard(p,snapshots[3],cards[0],now):{...card(p?.series.dividend_yield??null,snapshots[4],p,'dividend_yield',now),trailingDistribution:null,distributionAsOf:null};
  if(dividendYield)cards.push(dividendYield);
  const retryTimes=snapshots.map(s=>s?.retryAt);
  const retries=retryTimes.filter((r):r is string=>!!r&&Date.parse(r)>+now).map(r=>Math.ceil((Date.parse(r)-+now)/1000));
  return {product:{id:grid.id,code:p?.code??grid.productCode,name:grid.productName||p?.name||grid.productCode,currency:p?.currency??null,kind:p?.kind??null},
   benchmark:p?.benchmark??null,note:p?.note??null,price:cards[0],pe:cards[1],pb:cards[2],dividendYield,
   refresh:{busy:cards.some(c=>c.refreshing),hasMore:cards.some(c=>c.due&&!c.refreshing),retryAfter:cards.some(c=>c.refreshing)?3:retries.length?Math.min(...retries):null}};
 }
 async refresh(ownerId:string,id:string,mode:'due'|'manual',signal?:AbortSignal):Promise<ValuationPageData>{
  const grid=await this.deps.grid.get(ownerId,id),p=resolveValuationProduct(grid.productCode);
  await this.deps.beforeRequest();if(!p)return this.read(ownerId,id);
  const start=this.clock(),definitions=Object.values(p.series).filter((s):s is SeriesDefinition=>s!==null);
  let requests=0,httpRequests=0,cooling=false;const attempted=new Set<string>();
  // At most four source batches: global monthly sources may require two HTTP requests each.
  for(let round=0;round<4;round++){
   for(const s of definitions){
    const now=this.clock();if(requests>=4||httpRequests>=8||+now-+start>=40000||signal?.aborted)break;
    const cost=s.metric==='distribution'?Math.min(7,8-httpRequests):s.source==='legu'&&s.metric==='pe'&&s.symbol!=='HSI'?2:1;
    if(cost>8-httpRequests||s.metric==='distribution'&&cost<3)continue;
    const r=await this.deps.store.readSeries(s);
    if(r?.retryAt && Date.parse(r.retryAt)>+now)continue;
    if(r?.leaseUntil && Date.parse(r.leaseUntil)>+now)continue;
    const manual=mode==='manual'&&!attempted.has(s.key);
    if(manual&&r?.lastAttemptAt&&+now-Date.parse(r.lastAttemptAt)<60000){cooling=true;continue;}
    if(!manual&&!due(s,r,now))continue;
    const claim=await this.deps.store.claimSeries(s,now);if(!claim)continue;
    const latest=await this.deps.store.readSeries(s);
    // A concurrent request may have completed after our first read and before this lease.
    if(!manual&&latest&&latest.checkedAt!==r?.checkedAt&&!due(s,latest,now)){
      await this.deps.store.commitBatch(claim,{observations:[],reachedStart:false},now,{cursor:latest.cursor,complete:latest.complete});continue;
    }
    const to=completedDate(s,now),seeds=latest?.observations.length?[]:archivedObservations(s.key);
    const current=latest?.observations.at(-1)?.date;
    const refreshRecent=!!latest?.checkedAt && (s.metric==='price'?completedDate(s,new Date(latest.checkedAt))<to:+now-Date.parse(latest.checkedAt)>=WEEK);
    const backfill=s.frequency==='daily'&&!latest?.complete&&!refreshRecent;
    const end=backfill?(latest?.cursor??to):to;
    const floor=p.mappingSince&&s.metric!=='price'?p.mappingSince:'1990-01-01';
    const from=s.source==='multpl'?'1800-01-01':s.frequency==='monthly'||s.frequency==='weekly'?'1900-01-01':backfill?([floor,shift(end,-365)].sort().at(-1)!):shift(current??to,-30);
    await this.deps.beforeRequest();requests++;httpRequests+=cost;attempted.add(s.key);
    let batch:SeriesBatch;
    try {batch=await (this.deps.fetch??fetchSeriesBatch)({series:s,from,to:end,allowEmpty:backfill&&!!current,...(s.metric==='distribution'?{knownObservations:latest?.observations,requestBudget:cost,verifyRecent:latest?.complete??false}:{})},{signal:AbortSignal.any([AbortSignal.timeout(Math.max(1,45000-(+this.clock()-+start))),...(signal?[signal]:[])])});}
    catch(error){const raw=error instanceof Error?error.message:'';const message=/^(HTTP|数据源|公开估值|估值|腾讯|Yahoo|中证|同日|同月|缺少|分派)/.test(raw)?raw:'数据源暂不可用或请求超时';await this.deps.store.failBatch(claim,message,this.clock(),seeds);continue;}
    const complete=s.metric==='distribution'?batch.reachedStart:backfill?(batch.reachedStart||from<=floor):s.frequency==='monthly'||s.frequency==='weekly'||(latest?.complete??false);
    const cursor=complete?null:backfill?shift(from,-1):(latest?.cursor??null);
    await this.deps.store.commitBatch(claim,{...batch,observations:[...seeds,...batch.observations]},this.clock(),{cursor,complete});
   }
   if(requests>=4)break;
  }
  if(mode==='manual'&&!requests&&cooling)throw new ApiError(429,'VALUATION_COOLDOWN','请稍后再刷新，已有数据仍可查看。',undefined,{'retry-after':'60'});
  return this.read(ownerId,id);
 }
}
