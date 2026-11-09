import {describe,expect,it} from 'vitest';
import {buildValuationProduct,parseFundProfile,parseDomesticFundProfile} from './product-discovery';
import {requestFor} from './sources';

const qqq={code:'QQQ.US',name:'Invesco QQQ Trust',market:'us' as const,currency:'USD' as const,kind:'etf' as const,tencent:null,yahoo:'QQQ',eastmoney:null};
function yahoo(symbol:string,summary:string){return `<script data-url="https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=assetProfile,price">${JSON.stringify({body:JSON.stringify({quoteSummary:{result:[{price:{symbol},assetProfile:{longBusinessSummary:summary}}],error:null}})})}</script>`;}
describe('automatic product valuation discovery',()=>{
 it('discovers an index absent from the seed catalog by its verified structured code',()=>{
  const profile=parseDomesticFundProfile('588000.SH',{Success:true,Datas:{FCODE:'588000',INDEXCODE:'000688',INDEXNAME:'上证科创板50成份指数',FTYPE:'指数型-股票',FULLNAME:'科创50ETF'}});
  const p=buildValuationProduct({...qqq,code:'588000.SH',market:'cn',currency:'CNY',tencent:'sh588000',yahoo:null},profile);
  expect(p.benchmark).toEqual({id:'000688',name:'上证科创板50成份指数'});
  expect(p.series.pe?.symbol).toBe('000688');expect(requestFor(p.series.pe!,'2026-01-01','2026-11-06').url).toContain('indexCode=000688');
  expect(()=>parseDomesticFundProfile('588000.SH',{Success:true,Datas:{FCODE:'510300',INDEXCODE:'000300',INDEXNAME:'沪深300'}})).toThrow();
 });
 it('builds uncatalogued fund prices and reuses an explicitly documented Nasdaq benchmark',()=>{
  const evidence=parseFundProfile('us','QQQ.US',yahoo('QQQ','The trust maintains securities corresponding to the stocks in the NASDAQ-100 Index.'));
  const p=buildValuationProduct(qqq,evidence);
  expect(p.benchmark).toEqual({id:'NDX',name:'纳斯达克100'});
  expect(p.series.price?.key).toBe('QQQ.US:price:yahoo:daily:v1:raw');
  expect(p.series.pe?.key).toBe('NDX:pe:legu:monthly:v1:raw');
  expect(p.series.pb).toBeNull();
  expect(p.note).toBeNull();
  expect(requestFor(p.series.price!,'2026-01-01','2026-11-06').url).toContain('/chart/QQQ?');
 });
 it('allows a genuinely new verified symbol to show prices without a benchmark',()=>{
  const p=buildValuationProduct({...qqq,code:'NEWT.US',yahoo:'NEWT',name:'New Trust'},null);
  expect(p.benchmark).toBeNull();expect(p.series.pe).toBeNull();
  expect(requestFor(p.series.price!,'2026-01-01','2026-11-06').url).toContain('/chart/NEWT?');
 });
 it('uses only the domestic tracking-target field, ignoring other page text and product name',()=>{
  const evidence=parseFundProfile('cn','159941.SZ','<title>基金(159941)基金基本概况</title><th>跟踪标的</th><td>纳斯达克100指数</td><p>比较沪深300与标普500指数</p>');
  const p=buildValuationProduct({...qqq,code:'159941.SZ',market:'cn',currency:'CNY',yahoo:null,tencent:'sz159941'},evidence);
  expect(p.benchmark?.id).toBe('NDX');expect(p.series.price?.symbol).toBe('sz159941');
  expect(parseFundProfile('cn','159941.SZ','<title>基金(159941)基金基本概况</title><p>基金名纳斯达克100指数</p>')).toMatchObject({benchmark:null});
 });
 it('rejects mismatched domestic HTML and enhanced strategies in the profile fallback',()=>{
  const page='<title>基金(159941)基金基本概况</title><th>基金全称</th><td>纳斯达克100增强基金</td><th>跟踪标的</th><td>纳斯达克100指数</td>';
  expect(parseFundProfile('cn','159941.SZ',page).benchmark).toBeNull();
  expect(()=>parseFundProfile('cn','159941.SZ',page.replace('(159941)','(159940)'))).toThrow();
 });
 it('does not guess from comparisons, active strategies, leverage, inverse or a different ticker',()=>{
  for(const summary of ['Invests in companies, compared against the Nasdaq-100 Index.','The fund seeks 2x the daily return of the Nasdaq-100 Index.','The fund seeks the inverse daily performance of the Nasdaq-100 Index.','The actively managed fund seeks to outperform the Nasdaq-100 Index.','The fund tracks the Nasdaq-100 Index and S&P 500 Index.']){
   expect(parseFundProfile('us','QQQ.US',yahoo('QQQ',summary)).benchmark).toBeNull();
  }
  expect(()=>parseFundProfile('us','QQQ.US',yahoo('QQQ','The fund tracks the S&P 500 Index.').replace('symbol\\\":\\\"QQQ','symbol\\\":\\\"SPY'))).toThrow();
 });
 it('keeps stocks separate from fund benchmarks and rejects unsafe symbols',()=>{
  const p=buildValuationProduct({...qqq,code:'AAPL.US',yahoo:'AAPL',kind:'stock'},null);
  expect(p.kind).toBe('stock');expect(p.series.pe).toBeNull();expect(p.note).toContain('公司');
  expect(()=>buildValuationProduct({...qqq,code:'https://bad.US',yahoo:'https://bad'},null)).toThrow();
 });
 it('rejects altered provider symbols, keys and unsupported metric combinations',()=>{
  const s=buildValuationProduct(qqq,null).series.price!;
  for(const change of [{symbol:'../../etc/passwd'},{symbol:'SPY'},{subject:'SPY.US'},{metric:'pb'},{source:'legu'}]){
   expect(()=>requestFor({...s,...change} as typeof s,'2026-01-01','2026-11-06')).toThrow();
  }
 });
});
