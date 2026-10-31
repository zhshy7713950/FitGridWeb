'use client';
import type {ReferenceOptions} from './reference-plan';
import styles from './valuation.module.css';

export function ReferenceControls({value,onChange,currency,existingIncrease}:{value:ReferenceOptions;onChange:(next:ReferenceOptions)=>void;currency:string;existingIncrease?:number}){
 const choices=[...new Set([0,5,10,...(existingIncrease!==undefined&&existingIncrease<=100?[existingIncrease]:[])])].sort((a,b)=>a-b);
 return <section className={styles.referenceControls} aria-label="参考方案预算">
  <div><h2>独立参考方案</h2><p className={styles.meta}>零持仓 · 3～5年观察 · 每套方案使用同一笔本金，不能叠加投入。仅在本页试算，由你手动采用。</p></div>
  <div className={styles.referenceFields}>
   <label>最大投资本金（{currency}）<input aria-label={`最大投资本金（${currency}）`} inputMode="decimal" placeholder="请输入预算" value={value.budget} onChange={e=>onChange({...value,budget:e.target.value})}/></label>
   <label>买入费用率（%）<input inputMode="decimal" value={value.feeRate} onChange={e=>onChange({...value,feeRate:e.target.value})}/></label>
   <label>每笔最低费用（{currency}）<input inputMode="decimal" value={value.minimumFee} onChange={e=>onChange({...value,minimumFee:e.target.value})}/></label>
   <label>加码情景<select value={value.increase} onChange={e=>onChange({...value,increase:Number(e.target.value)})}>{choices.map(n=><option value={n} key={n}>{n}%{n===existingIncrease?'（当前网格值）':''}</option>)}</select></label>
  </div>
  <p className={styles.meta}>费用为可编辑的示例假设，不额外预留现金。间距、最大振幅、最小交易数量和留存份数沿用当前网格；加码为候选情景。尚未完成3～5年历史回测，不代表最优参数或预测最大跌幅。</p>
 </section>;
}
