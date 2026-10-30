import {createHash} from 'node:crypto';
import {PriceDecimal as Decimal} from '@/server/price-alerts/decimal';
import type {Observation,SeriesRequest,SeriesBatch} from './types';

interface Candidate { recordDate:string; previousRecordDate:string; perShare:string }
interface Notice { FUNDCODE:string; ID:string; PUBLISHDATEDesc:string; TITLE:string }
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('分派公告格式异常');return value as Record<string,unknown>;}
function validDate(value:string):string{if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw new Error('分派公告日期异常');return value;}
const strip=(s:string)=>s.replace(/<[^>]*>/g,'').replace(/&nbsp;|&#160;/g,' ').trim();
export function parseDistributionTable(code:string,html:string):Candidate[]{
 if(!['508000','508056'].includes(code)||!html.includes(`(${code})`)&&!html.includes(`（${code}）`))throw new Error('分派产品不匹配');
 const section=html.split('分红送配详情')[1]?.split('拆分详情');
 if(!section||section.length<2||!section[1].split('分红送配公告')[0].includes('暂无拆分信息'))throw new Error('分派份额拆分或口径变化，需重新核验');
 const table=section[0].match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1];if(!table)throw new Error('分派历史缺少表格');
 const rows=[...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m=>[...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c=>strip(c[1])));
 if(!rows.length)throw new Error('分派历史为空，不能确认零分派');
 const candidates=rows.map(c=>{
  const amount=c[3]?.match(/^每10份派现金(\d+(?:\.\d+)?)元$/);if(c.length!==5||!amount)throw new Error('分派金额或单位改变');
  const perShare=new Decimal(amount[1]).div(10);if(!perShare.isFinite()||!perShare.gt(0))throw new Error('分派金额无效');
  return {recordDate:validDate(c[1]),perShare:perShare.toString(),previousRecordDate:'1900-01-01'};
 }).sort((a,b)=>a.recordDate.localeCompare(b.recordDate));
 for(let i=0;i<candidates.length;i++){if(i&&candidates[i].recordDate===candidates[i-1].recordDate)throw new Error('分派同日记录冲突');candidates[i].previousRecordDate=candidates[i-1]?.recordDate??'1900-01-01';}
 return candidates;
}
function chineseDate(y:string,m:string,d:string){return validDate(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`);}
const datePattern='(\\d{4})年(\\d{1,2})月(\\d{1,2})日';
export function parseDistributionNotice(code:string,candidate:Candidate,notice:Notice,body:unknown):Observation{
 const root=record(body),data=record(root.data),text=String(data.notice_content??''),compact=text.replace(/\s/g,'');
 if(root.success!==1||notice.FUNDCODE!==code||data.art_code!==notice.ID||Number(data.page_size)!==1||!new RegExp(`公募REITs代码${code}`).test(compact)||!compact.includes('分红对象')||!compact.includes('基金份额持有人'))throw new Error('分派公告身份、页数或分配权不明');
 const amountSection=text.split('分红方案')[1]?.split('有关年度')[0];
 const amounts=amountSection?.match(/\d+\.\d+/g);
 if(!/元\s*\/\s*10(?![\d.])/.test(amountSection??'')||amounts?.length!==1||!new Decimal(amounts[0]).div(10).eq(candidate.perShare))throw new Error('分派公告金额与汇总表冲突');
 const exSection=compact.split('除息日')[1]?.split('现金红利发放日')[0];if(!exSection)throw new Error('分派公告缺少场内除息日');
 const before=exSection.match(new RegExp('场内[：:]'+datePattern));
 // Two-column PDF extraction can interleave the two parenthesized labels.
 const interleaved=exSection.match(new RegExp('^'+datePattern+'（场'+datePattern+'（场内）外）$'));
 const after=exSection.match(new RegExp(datePattern+'[（(]场内[）)]'));
 let exDate:string|null=null;
 if(before)exDate=chineseDate(before[1],before[2],before[3]);
 else if(interleaved&&chineseDate(interleaved[4],interleaved[5],interleaved[6])===candidate.recordDate)exDate=chineseDate(interleaved[1],interleaved[2],interleaved[3]);
 else if(after)exDate=chineseDate(after[1],after[2],after[3]);
 const recordSection=compact.split('权益登记日')[1]?.split('除息日')[0],recordDate=recordSection?.match(new RegExp(datePattern));
 const announcedAt=validDate(notice.PUBLISHDATEDesc);
 if(!recordDate||chineseDate(recordDate[1],recordDate[2],recordDate[3])!==candidate.recordDate||!exDate||exDate<candidate.recordDate||announcedAt>candidate.recordDate)throw new Error('分派公告场内日期无法核验');
 return {date:candidate.recordDate,value:candidate.perShare,quality:'valid',distribution:{verified:true,recordDate:candidate.recordDate,exDate,announcedAt,noticeId:notice.ID,evidenceUrl:`https://data.eastmoney.com/notices/detail/${code}/${notice.ID}.html`,contentHash:createHash('sha256').update(text).digest('hex')}};
}
export async function fetchDistributionBatch(request:SeriesRequest,fetchText:(url:string)=>Promise<string>):Promise<SeriesBatch>{
 const code=request.series.symbol,budget=Math.min(7,request.requestBudget??7);if(budget<3)throw new Error('分派核验请求预算不足');
 const candidates=parseDistributionTable(code,await fetchText(`https://fundf10.eastmoney.com/fhsp_${code}.html`));
 const feed=record(JSON.parse(await fetchText(`https://api.fund.eastmoney.com/f10/FHGG?fundcode=${code}&pageSize=100&pageIndex=1`)));
 if(feed.ErrCode!==0||!Array.isArray(feed.Data)||feed.TotalCount!==feed.Data.length||feed.Data.length!==candidates.length)throw new Error('分派公告列表不完整');
 const notices=feed.Data.map(value=>{const r=record(value);if(r.FUNDCODE!==code||!/^AN\d{18}$/.test(String(r.ID))||!String(r.TITLE).match(/分红|收益分配/))throw new Error('分派公告列表身份异常');validDate(String(r.PUBLISHDATEDesc));return r as unknown as Notice;});
 const known=new Map((request.knownObservations??[]).map(p=>[p.date,p]));
 if([...known.keys()].some(d=>!candidates.some(c=>c.recordDate===d)))throw new Error('分派历史与已保存记录不一致');
 const result:Observation[]=[];let remaining=budget-2;
 for(const candidate of [...candidates].reverse()){
  const matching=notices.filter(n=>n.PUBLISHDATEDesc<=candidate.recordDate&&n.PUBLISHDATEDesc>candidate.previousRecordDate);
  if(matching.length!==1)throw new Error('分派公告与登记日无法唯一对应');const notice=matching[0],old=known.get(candidate.recordDate);
  const unchanged=old?.distribution?.verified&&old.distribution.noticeId===notice.ID&&old.value===candidate.perShare&&old.distribution.announcedAt===notice.PUBLISHDATEDesc;
  const recheck=request.verifyRecent&&candidate.recordDate===candidates.at(-1)?.recordDate;
  if(unchanged&&!recheck){result.push(old!);continue;}
  if(remaining>0){remaining--;result.push(parseDistributionNotice(code,candidate,notice,JSON.parse(await fetchText(`https://np-cnotice-stock.eastmoney.com/api/content/ann?art_code=${notice.ID}&client_source=web&page_index=1`))));}
  else result.push({date:candidate.recordDate,value:null,quality:'missing',distribution:{verified:false,recordDate:candidate.recordDate,exDate:null,announcedAt:notice.PUBLISHDATEDesc,noticeId:notice.ID,evidenceUrl:`https://data.eastmoney.com/notices/detail/${code}/${notice.ID}.html`,contentHash:null}});
 }
 result.sort((a,b)=>a.date.localeCompare(b.date));return {observations:result,reachedStart:result.every(p=>p.distribution?.verified)};
}
