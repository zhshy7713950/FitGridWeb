'use client';
import Link from 'next/link';
import {useEffect,useMemo,useState} from 'react';
import {ClientApiError} from '@/lib/api-client';
import type {MetricCard,DividendYieldCard} from '@/server/valuation/types';
import {getValuation,refreshValuation} from './valuation-api';
import type {ValuationPageData} from '@/server/valuation/types';
import {HistoryChart,type ChartLine} from './history-chart';
import styles from './valuation.module.css';
const priceLines:ChartLine[]=[{key:'value',label:'收盘价',color:'var(--action-text)'},{key:'ma250',label:'250日均线',color:'var(--warning)'},{key:'ma500',label:'500日均线',color:'var(--positive)'}];
const metricLines:ChartLine[]=[{key:'value',label:'指数估值',color:'var(--action-text)'}];
const yieldLines:ChartLine[]=[{key:'value',label:'现金分派率',color:'var(--action-text)'}];
const indexYieldLines:ChartLine[]=[{key:'value',label:'指数股息率',color:'var(--action-text)'}];
function percent(value:string|null){return value===null?'—':Number(value).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})+'%';}
function format(value:string|null|undefined,digits=4){return value===null||value===undefined?'—':Number(value).toLocaleString('zh-CN',{maximumFractionDigits:digits});}
function checked(value:string|null){return value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'尚未在线更新';}
function wait(ms:number,signal:AbortSignal){return new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(new DOMException('已取消','AbortError'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);signal.addEventListener('abort',abort,{once:true});});}
function ChartCard({title,card,price=false,cash=false,yieldMetric=false,currency}:{title:string;card:MetricCard;price?:boolean;cash?:boolean;yieldMetric?:boolean;currency?:string|null}){
 const distribution=cash?card as DividendYieldCard:null;
 const percentage=cash||yieldMetric;
 const value=(v:string|null)=>percentage?percent(v):format(v,2);
 const last=card.prices?.at(-1);
 const points=useMemo(()=>price?(card.prices??[]).map(p=>({date:p.date,value:p.close,ma250:p.ma250,ma500:p.ma500})):card.points.map(p=>({date:p.date,value:p.quality==='valid'?p.value:null})),[card.points,card.prices,price]);
 const references=useMemo(()=>price?[]:[{label:'P30',value:card.stats.p30,color:'var(--positive)'},{label:'P50（中位数）',value:card.stats.p50,color:'var(--text-muted)'},{label:'P70',value:card.stats.p70,color:'var(--warning)'}],[price,card.stats.p30,card.stats.p50,card.stats.p70]);
 const stats=price?[['最新收盘价',`${format(last?.close)}${currency?' '+currency:''}`],['MA250',format(last?.ma250)],['MA500',format(last?.ma500)]]:[[cash?'当前分派率':yieldMetric?'当前股息率':'当前'+title.slice(0,2),value(card.stats.currentValue)],['最低值',value(card.stats.min)],['最高值',value(card.stats.max)],['30分位值',value(card.stats.p30)],['50分位值（中位数）',value(card.stats.p50)],['70分位值',value(card.stats.p70)],['当前分位',card.stats.currentPercentile===null?'—':format(card.stats.currentPercentile,2)+'%']];
 return <section className={styles.card} aria-label={title}>
  <header className={styles.cardHeading}><div><p className={styles.eyebrow}>{price?'基金交易价格':cash?'基金现金分派':yieldMetric?'对应指数股息率 · 非基金分派率':'对应指数估值'}</p><h2>{title}</h2></div><span className={styles.badge}>{card.stale?'已保存 · 待更新':card.availability==='ready'?'已缓存':'暂无数据'}</span></header>
  <dl className={`${styles.stats} ${price?styles.priceStats:''}`}>{stats.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
  {card.message?<p className={styles.notice}>{card.message}</p>:null}
  {price&&card.points.length&&(!last?.ma250||!last?.ma500)?<p className={styles.meta}>{!last?.ma250?'历史不足250个连续有效收盘记录，MA250留空。 ':''}{!last?.ma500?'历史不足500个连续有效收盘记录，MA500留空。':''}</p>:null}
  {!price&&card.stats.validCount>0&&card.stats.validCount<60?<p className={styles.meta}>有效样本较少，分位仅描述当前已保存历史。</p>:null}
  {distribution?<p className={styles.meta}>近12个月每份分派合计：{format(distribution.trailingDistribution,8)} {currency??'CNY'} · 分派数据截至：{distribution.distributionAsOf??'尚未核验'}；窗口为（当日减12个自然月，当日]，按场内除息日计入，历史不足或待核验时留空。</p>:null}
  <HistoryChart label={title+'历史图'} points={points} lines={price?priceLines:cash?yieldLines:yieldMetric?indexYieldLines:metricLines} references={references} unit={percentage?'%':undefined}/>
  <footer className={styles.cardFooter}><span>数据日期：{card.asOf??'—'} · {card.source??'暂无来源'} · {card.frequency==='monthly'?'月频':card.frequency==='weekly'?'周频':card.frequency==='daily'?'日频':'—'} · {card.method??'—'}</span><span>全部已保存历史：{card.stats.start??'—'} 至 {card.stats.end??'—'} · {card.stats.validCount}个有效样本{card.coverage==='partial'?' · 历史尚未补齐':''}</span><span>最近检查：{checked(card.checkedAt)}</span></footer>
 </section>;
}
export function ValuationLoading(){return <div className={styles.page} role="status"><h1>估值观察</h1><p>正在读取已保存数据…</p>{['价格走势','PE走势','PB走势','股息率走势'].map(t=><div className={styles.skeleton} key={t}>{t}</div>)}</div>;}
export function ValuationPage({id}:{id:string}){
 const [data,setData]=useState<ValuationPageData|null>(null),[error,setError]=useState<string|null>(null),[pending,setPending]=useState(false);
 const [request,setRequest]=useState({sequence:0,mode:'due' as 'due'|'manual'});
 useEffect(()=>{
  const controller=new AbortController(),signal=controller.signal;let active=true;
  async function load(){
   try {
    let current=await getValuation(id,signal);if(!active)return;setData(current);setError(null);
    const started=Date.now();let manual=request.mode==='manual',batches=0;
    while(active&&(manual||current.refresh.busy||current.refresh.hasMore)){
     if(current.refresh.busy){if(Date.now()-started>=120000){setError('更新仍在进行，请稍后重试。');break;}setPending(true);await wait(Math.min((current.refresh.retryAfter??3)*1000,120000-(Date.now()-started)),signal);current=await getValuation(id,signal);}
     else {if(batches++>=64){setError('更早历史尚未取完，可稍后手动继续。');break;}setPending(true);current=await refreshValuation(id,manual?'manual':'due',signal);manual=false;}
     if(active)setData(current);
    }
   }catch(e){if(active&&!signal.aborted)setError(e instanceof ClientApiError?`${e.message}${e.requestId?'（请求ID：'+e.requestId+'）':''}`:e instanceof Error?e.message:'暂时无法加载估值数据');}
   finally{if(active)setPending(false);}
  }
  void load();return()=>{active=false;controller.abort();};
 },[id,request]);
 const visible=data?.product.id===id?data:null;
 if(!visible&&!error)return <ValuationLoading/>;
 return <div className={styles.page}>
  <Link className={styles.back} href={`/grids/${id}`}>← 返回产品详情</Link>
  <header className={styles.heading}><div><p className={styles.eyebrow}>全部可用历史 · 参考观察</p><h1>{visible?.product.name??'产品'}<span>估值观察</span></h1><p className={styles.meta}>{visible?.product.code} {visible?.benchmark?` · 参考指数：${visible.benchmark.name}（${visible.benchmark.id}）`:visible?.product.kind==='reit'?' · REIT现金分派观察':' · 暂无已确认的参考指数'}</p></div><button className={styles.refresh} disabled={pending} onClick={()=>{setError(null);setRequest(r=>({sequence:r.sequence+1,mode:visible?'manual':'due'}));}}>{pending?'正在更新…':'刷新数据'}</button></header>
  {error?<p className={styles.error} role="alert">{error}</p>:null}
  {visible?<><p className={styles.intro}>基金价格使用不复权收盘价，均线按250/500个已完成交易日计算；分红、拆分可能产生价格跳变。{visible.product.kind==='reit'?'REIT展示实际现金分派率；使用近12个月每份税前分派与当日价格计算，缺少完整分派历史时留空。':'PE/PB与股息率使用对应指数的固定来源序列；指数股息率不代表基金实际分派率，缺少的指标留空。'}</p>{visible.note?<p className={styles.notice}>{visible.note}</p>:null}
   <ChartCard title="价格走势" card={visible.price} price currency={visible.product.currency}/>{visible.product.kind==='reit'?(visible.dividendYield?<ChartCard title="股息率（近12个月现金分派率）" card={visible.dividendYield} cash currency={visible.product.currency}/>:null):<><ChartCard title="PE走势" card={visible.pe}/><ChartCard title="PB走势" card={visible.pb}/>{visible.dividendYield?<ChartCard title="股息率走势（对应指数）" card={visible.dividendYield} yieldMetric/>:null}</>}
   <p className={styles.footnote}>价格按交易日检查，估值每七天按需检查；历史长期保存。分位使用各指标全部有效观测，当前分位与此前观测比较；不同指标的日期和频率可能不同，仅供参考。</p>
  </>:null}
 </div>;
}
