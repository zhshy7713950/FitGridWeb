'use client';
import {useEffect,useRef,useState} from 'react';
import {alertApi} from '@/features/price-alerts/price-alert-api';
import type {Instrument,InstrumentCandidate} from '@/features/price-alerts/types';
import {ClientApiError} from '@/lib/api-client';
import styles from './grid-form.module.css';

const kinds={stock:'股票',etf:'ETF',lof:'LOF',reit:'REIT'};
export function ProductPicker({onSelect,disabled=false}:{onSelect:(instrument:Instrument|null)=>void;disabled?:boolean}){
 const [market,setMarket]=useState<'cn'|'us'>('cn'),[query,setQuery]=useState('');
 const [candidates,setCandidates]=useState<InstrumentCandidate[]>([]),[selected,setSelected]=useState<Instrument|null>(null);
 const [pending,setPending]=useState(false),[searched,setSearched]=useState(false),[error,setError]=useState<string|null>(null);
 const generation=useRef(0);
 useEffect(()=>()=>{generation.current++;},[]);
 function invalidate(){generation.current++;setSelected(null);onSelect(null);setCandidates([]);setSearched(false);setError(null);setPending(false);}
 async function search(){
  if(!query.trim()||pending||disabled)return;
  invalidate();const current=++generation.current;setPending(true);
  try{const result=await alertApi.search(market,query.trim());if(current===generation.current){setCandidates(result.items);setSearched(true);}}
  catch(e){if(current===generation.current)setError(e instanceof ClientApiError?e.message:'产品搜索暂时不可用，请稍后重试。');}
  finally{if(current===generation.current)setPending(false);}
 }
 async function confirm(candidate:InstrumentCandidate){
  if(pending||disabled)return;const current=++generation.current;setPending(true);setError(null);
  try{
   const instrument=await alertApi.resolve(market,candidate.code);
   if(current===generation.current){
    if(instrument.market!==market||instrument.code!==candidate.code)throw new Error('identity mismatch');
    setSelected(instrument);setCandidates([]);setSearched(false);onSelect(instrument);
   }
  }catch(e){if(current===generation.current)setError(e instanceof ClientApiError?e.message:'产品核验失败，请重新选择或稍后重试。');}
  finally{if(current===generation.current)setPending(false);}
 }
 return <div className={styles.productPicker}>
  <div className={styles.fields}>
   <div className={styles.field}><label htmlFor="grid-market">交易市场</label><div className={styles.inputFrame}><select id="grid-market" disabled={disabled} value={market} onChange={e=>{invalidate();setMarket(e.target.value as 'cn'|'us');}}><option value="cn">中国市场 · 沪深</option><option value="us">美股</option></select></div></div>
   <div className={styles.field}><label htmlFor="grid-search">搜索产品代码或名称</label><div className={styles.searchRow}><div className={styles.inputFrame}><input id="grid-search" disabled={disabled} value={query} maxLength={64} autoComplete="off" placeholder={market==='cn'?'例如：510880、红利':'例如：QQQ、Apple'} onChange={e=>{invalidate();setQuery(e.target.value);}} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();void search();}}}/></div><button type="button" disabled={disabled||pending||!query.trim()} onClick={()=>void search()}>{pending?'正在查询…':'搜索产品'}</button></div></div>
  </div>
  {error?<p className={styles.fieldError} role="alert">{error}</p>:null}
  {searched&&!candidates.length?<p role="status">未找到支持的产品，请调整代码或名称。</p>:null}
  {candidates.length?<ul className={styles.productResults} aria-label="产品搜索结果">{candidates.map(c=><li key={c.code}><div><strong>{c.name}</strong><p>{c.code} · {c.exchange} · {kinds[c.kind]}</p></div><button type="button" disabled={disabled||pending} aria-label={`确认选择 ${c.name} ${c.code}`} onClick={()=>void confirm(c)}>确认选择</button></li>)}</ul>:null}
  {selected?<p className={styles.confirmedProduct} role="status">已确认：{selected.name} · {selected.code} · {selected.currency} · {kinds[selected.kind]}</p>:null}
  <p className={styles.pickerHint}>选择产品后自动匹配行情和估值资料；暂缺的估值指标不影响创建网格。</p>
 </div>;
}
