import {PriceDecimal as Decimal} from '@/server/price-alerts/decimal';
import type {Observation} from './types';
const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const text=(s:string)=>s.replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&(?:#x2002|#8194|nbsp);/gi,' ').replace(/\s+/g,' ').trim();
/** Parse only the provider's dividend-yield table; estimated observations stay gaps. */
export function parseMultplYield(html:string):Observation[]{
 const heading=text(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]??'');
 const table=html.match(/<table\b[^>]*\bid=["']datatable["'][^>]*>([\s\S]*?)<\/table>/i)?.[1];
 if(heading!=='S&P 500 Dividend Yield by Month'||!table)throw new Error('股息率页面身份或历史表不匹配');
 const headers=[...table.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(m=>text(m[1]));
 if(headers.join('|')!=='Date|Value')throw new Error('股息率历史列不匹配');
 const rows:Observation[]=[];
 for(const match of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){
  const cells=[...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m=>m[1]);
  if(!cells.length)continue;
  if(cells.length!==2)throw new Error('股息率历史列不匹配');
  const label=text(cells[0]),parts=label.match(/^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/),month=parts?months.indexOf(parts[1]):-1;
  if(!parts||month<0)throw new Error('股息率日期异常');
  const date=`${parts[3]}-${String(month+1).padStart(2,'0')}-${parts[2].padStart(2,'0')}`;
  if(new Date(`${date}T00:00:00Z`).toISOString().slice(0,10)!==date)throw new Error('股息率日期异常');
  const value=text(cells[1]).replace(/†/g,'').trim();
  if(!/^-?\d+(?:\.\d+)?%$/.test(value))throw new Error('股息率百分比单位或数值异常');
  const n=new Decimal(value.slice(0,-1)),valid=n.gt(0)&&!(/Estimate|†/i.test(cells[1]));
  rows.push({date,value:valid?n.toString():null,quality:valid?'valid':'missing'});
 }
 if(!rows.length)throw new Error('股息率历史为空');
 return rows;
}
