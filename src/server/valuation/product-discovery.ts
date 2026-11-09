import {PRODUCTS,series} from './catalog';
import type {ValuationProduct} from './types';

export interface ProductIdentity {
 code:string;name:string;market:'cn'|'us';currency:'CNY'|'USD';kind:ValuationProduct['kind'];
 tencent:string|null;yahoo:string|null;eastmoney:string|null;
}
export interface FundProfile {
 benchmark:ValuationProduct['benchmark'];evidence:string;note:string|null;listedAt?:string|null;evidenceUrl?:string;
}
const text=(html:string)=>html.replace(/<[^>]*>/g,' ').replace(/&(?:amp|nbsp);/g,' ').replace(/&(?:reg|trade);|[®™]/g,'').replace(/&#(?:39|x27);/g,"'").replace(/&quot;/g,'"').replace(/\s+/g,' ').trim();
const normalize=(s:string)=>s.toUpperCase().replace(/[\s®™（）()\-–—]/g,'').replace(/指数|INDEX/g,'');
function benchmarkIn(value:string,exact:boolean):ValuationProduct['benchmark'] {
 const matches=new Map<string,NonNullable<ValuationProduct['benchmark']>>();
 const aliases:Record<string,string[]>={NDX:['NASDAQ100','纳斯达克100'],SP500:['S&P500','标普500'],HSI:['HANG SENG INDEX','恒生指数'],HSTECH:['HANG SENG TECH INDEX','恒生科技指数']};
 const normalized=normalize(value);
 for(const p of PRODUCTS){if(!p.benchmark)continue;const names=[p.benchmark.name,...(aliases[p.benchmark.id]??[])];
  if(names.some(n=>exact?normalized===normalize(n):normalized.includes(normalize(n))))matches.set(p.benchmark.id,p.benchmark);
 }
 return matches.size===1?[...matches.values()][0]:null;
}
export function parseFundProfile(market:'cn'|'us',code:string,html:string):FundProfile {
 let description:string,strategy='';
 if(market==='cn') {
  const title=text(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]??'');
  if(!title.includes(`(${code.slice(0,6)})`))throw new Error('基金资料标的不匹配');
  const field=html.match(/<th[^>]*>\s*跟踪标的\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/);
  description=field?text(field[1]):'';
  strategy=[...html.matchAll(/<th[^>]*>\s*(?:基金全称|基金类型)\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g)].map(m=>text(m[1])).join(' ');
 }else {
  description='';
  const symbol=code.replace(/\.US$/,'');
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)){
   const url=match[1].match(/data-url="([^"]+)"/)?.[1];
   if(!url || !url.includes(`/quoteSummary/${symbol}?`))continue;
   const envelope=JSON.parse(match[2]);
   const row=JSON.parse(envelope.body).quoteSummary?.result?.[0];
   if(row?.price?.symbol!==symbol)throw new Error('基金资料标的不匹配');
   if(typeof row?.assetProfile?.longBusinessSummary==='string')description=row.assetProfile.longBusinessSummary;
  }
 }
 const unsuitable=/\b(?:leverag\w*|inverse|short exposure|[23]x|actively managed|outperform|compared (?:with|against))\b|杠杆|反向|增强|主动管理/i.test(description+' '+strategy);
 const eligible=market==='cn'||/\b(?:tracks?|tracking|replicat\w*|correspond\w*|conform\w*)\b/i.test(description);
 const benchmark=!unsuitable&&eligible?benchmarkIn(description,market==='cn'):null;
 return {benchmark,evidence:description.slice(0,4000),note:benchmark?null:unsuitable?'该产品含主动、增强、杠杆或反向策略，暂不套用普通指数估值。':'暂未从基金资料确认唯一的跟踪指数；价格可独立查看。'};
}
export function parseDomesticFundProfile(code:string,body:unknown):FundProfile {
 const root=body as {Success?:boolean;Datas?:Record<string,unknown>};
 const data=root?.Datas;
 if(!root?.Success||!data||data.FCODE!==code.slice(0,6))throw new Error('基金资料标的不匹配或资料暂不可用');
 const name=typeof data.INDEXNAME==='string'?data.INDEXNAME.trim():'';
 const index=typeof data.INDEXCODE==='string'?data.INDEXCODE.trim():'';
 const strategy=String(data.FULLNAME??'')+' '+String(data.FTYPE??'');
 const special=/杠杆|反向|增强|主动/.test(strategy);
 const known=benchmarkIn(name,true);
 const benchmark=special?null:known??(/^(?:\d{6}|H\d{5})$/.test(index)&&name&&name!=='--'?{id:index,name}:null);
 return {benchmark,evidence:JSON.stringify({code:data.FCODE,indexCode:index,indexName:name,type:data.FTYPE,name:data.FULLNAME}),note:benchmark?null:special?'该产品含主动、增强、杠杆或反向策略，暂不套用普通指数估值。':'基金资料暂未提供可核验的跟踪指数；价格可独立查看。'};
}
export function buildValuationProduct(identity:ProductIdentity,profile:FundProfile|null):ValuationProduct {
 const cn=identity.market==='cn';
 if(cn?!/^(?:[56]\d{5}\.SH|[013]\d{5}\.SZ)$/.test(identity.code):!/^[A-Z][A-Z0-9.-]{0,14}\.US$/.test(identity.code))throw new Error('产品交易代码无效');
 const symbol=cn?identity.code.slice(-2).toLowerCase()+identity.code.slice(0,6):identity.code.slice(0,-3);
 if(identity.currency!==(cn?'CNY':'USD') || (cn?identity.tencent!==symbol:identity.yahoo!==symbol))throw new Error('产品市场、币种或行情标识不匹配');
 const benchmark=identity.kind==='stock'||identity.kind==='reit'?null:profile?.benchmark??null;
 const existing=benchmark?PRODUCTS.find(p=>p.benchmark?.id===benchmark.id):null;
 const domestic=benchmark&&/^(?:\d{6}|H\d{5})$/.test(benchmark.id);
 return {code:identity.code,name:identity.name,market:identity.market,currency:identity.currency,kind:identity.kind,benchmark,
  listedAt:profile?.listedAt??null,mappingSince:null,
  note:identity.kind==='stock'?'股票应使用公司自身估值；当前尚未接入公司的历史PE/PB与股息率，价格可独立查看。':identity.kind==='reit'?null:profile?profile.note:'参考指数尚未核验，刷新时自动匹配；价格可独立查看。',
  series:{price:series(identity.code,'price',cn?'tencent':'yahoo',symbol),
   pe:existing?.series.pe??(domestic?series(benchmark.id,'pe','csi',benchmark.id):null),pb:existing?.series.pb??null,
   dividend_yield:existing?.series.dividend_yield??null,
   distribution:identity.kind==='reit'&&cn?series(identity.code,'distribution','eastmoney_disclosures',identity.code.slice(0,6)):null}};
}
