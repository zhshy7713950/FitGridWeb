'use client';
import {useState} from 'react';
import type {GridTradeInput} from '@/server/grid-domain/types';
import type {ReferenceBasis} from '@/server/valuation/types';
import type {ReferenceOptions,ReferencePlan} from './reference-plan';
import styles from './valuation.module.css';

function number(value:string|null|undefined,digits=2){return value==null?'—':Number(value).toLocaleString('zh-CN',{maximumFractionDigits:digits});}
export function ReferencePanel({basis,grid,options,currency,snapshot,cash=false}:{basis:ReferenceBasis;grid:GridTradeInput|null;options:ReferenceOptions;currency:string;snapshot:object;cash?:boolean}){
 const [busy,setBusy]=useState(false),[calculation,setCalculation]=useState<{snapshot:object;options:ReferenceOptions;plan?:ReferencePlan;error?:string}|null>(null);
 const current=calculation?.snapshot===snapshot&&calculation.options===options?calculation:null;
 const name=basis.metric==='pe'?'PE':basis.metric==='pb'?'PB':cash?'现金分派率':'股息率';
 async function calculate(){
  if(!grid||!basis.startPrice)return;
  setBusy(true);setCalculation(null);
  try{const {calculateReferencePlan}=await import('./reference-plan');const plan=calculateReferencePlan(grid,basis.startPrice,options);setCalculation({snapshot,options,plan});}
  catch(error){setCalculation({snapshot,options,error:error instanceof Error?error.message:'参考计算暂不可用。'});}
  finally{setBusy(false);}
 }
 const plan=current?.plan;
 return <aside className={styles.referencePanel} aria-label={name+'参考方案'}>
  <p className={styles.eyebrow}>独立情景 · 条件换算</p><h3>{name}参考方案</h3>
  {basis.status==='unavailable'?<p className={styles.meta}>{basis.reason}</p>:<>
   <dl className={styles.referenceStats}>
    <div><dt>目标估值 · {basis.metric==='dividendYield'?'P70':'P30'}</dt><dd>{number(basis.target,4)}{basis.metric==='dividendYield'?'%':''}</dd></div>
    <div><dt>条件换算价</dt><dd>{number(basis.conditionPrice,4)} {currency}</dd></div>
    <div><dt>启动演算价</dt><dd>{number(basis.startPrice,3)} {currency}</dd></div>
    <div><dt>距最新收盘价</dt><dd>{number(basis.changePercent)}%</dd></div>
   </dl>
   <p className={styles.meta}>分析窗口：{basis.windowStart}～{basis.windowEnd}，{basis.months}个有效月（最近{basis.years}年内）；与图表全历史分位独立。</p>
   <p className={styles.meta}>当期指标 {number(basis.current,4)}{basis.metric==='dividendYield'?'%':''}（{basis.metricDate}）；匹配收盘 {number(basis.anchorPrice,4)} {currency}（{basis.anchorDate}）。最新收盘 {number(basis.latestPrice,4)}（{basis.latestPriceDate}）。</p>
   {basis.warnings.map(w=><p className={styles.meta} key={w}>{w}</p>)}
   {!grid?<p className={styles.meta}>缺少原网格输入，暂不能反推资金参数。</p>:grid.isShort?<p className={styles.meta}>参考方案仅支持从零持仓做多。</p>:<button type="button" className={styles.referenceButton} disabled={busy||!options.budget.trim()} onClick={()=>void calculate()}>{busy?'正在计算…':`计算${name}参考参数`}</button>}
  </>}
  {current?.error?<p className={styles.error} role="alert">{current.error}</p>:null}
  {plan&&grid?<div aria-live="polite">
   <dl className={styles.referenceStats}>
    <div><dt>每份金额参数</dt><dd>{number(plan.baseAmount)} {currency}</dd></div>
    <div><dt>实际首笔金额</dt><dd>{number(plan.firstAmount)} {currency}</dd></div>
    <div><dt>首笔数量</dt><dd>{number(plan.firstCount,8)}</dd></div>
    <div><dt>买入总金额</dt><dd>{number(plan.buyAmount)} {currency}</dd></div>
   </dl>
   <details className={styles.referenceDetails}><summary>查看完整参数与下跌情景</summary>
    <dl className={styles.referenceStats}>
     <div><dt>小／中／大网间距</dt><dd>{grid.gearAmplitude}%／{grid.mediumAmplitude===null?'关闭':grid.mediumAmplitude+'%'}／{grid.bigAmplitude===null?'关闭':grid.bigAmplitude+'%'}</dd></div>
     <div><dt>最大振幅输入</dt><dd>{grid.maxAmplitude}%</dd></div>
     <div><dt>候选加码</dt><dd>{options.increase}%</dd></div>
     <div><dt>留存份数</dt><dd>{grid.keepShare}</dd></div>
     <div><dt>最小交易数量</dt><dd>{grid.minTradeQuantity}</dd></div>
     <div><dt>买入档数</dt><dd>{plan.orderCount}</dd></div>
     <div><dt>实际最低买价</dt><dd>{number(plan.lowestPrice,3)} {currency}</dd></div>
     <div><dt>买入费用</dt><dd>{number(plan.fees)} {currency}</dd></div>
     <div><dt>取整后剩余现金</dt><dd>{number(plan.remaining)} {currency}</dd></div>
    </dl>
    <p className={styles.meta}>假设本金 {number(options.budget)} {currency}，每笔买费 max（{options.minimumFee}，金额×{options.feeRate}%）。取整与叠加订单按当前网格规则计算。</p>
    <p className={styles.notice}>以下相对启动演算价单向下跌，限价完全成交、无滑点，期间没有卖出，不计未来分红；亏损包含买入费用。覆盖下限不是预测底部。循环交易与留存后的现金需求尚未验证，未完成3～5年收益回测。</p>
    <div className={styles.pressureList}>{plan.pressure.map(p=><div key={p.drop} className={styles.pressureRow}>
     <strong>下跌 {p.drop}% · 价格 {number(p.price,4)}</strong><span>亏损 {number(p.loss)} {currency}（预算的 {number(String(Number(p.loss)/Number(options.budget)*100))}%）</span><span>持仓 {number(p.quantity,8)} · 含费均价 {number(p.averageCost,4)}</span><span>已买 {number(p.buyAmount)} · 买费 {number(p.fees)} · 余款 {number(p.cash)} {currency}</span>
    </div>)}</div>
   </details>
  </div>:null}
 </aside>;
}
