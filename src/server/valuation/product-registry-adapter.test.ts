import {afterEach,describe,expect,it,vi} from 'vitest';
import type {PrismaClient} from '@/generated/prisma/client';
import {createProductRegistry} from './product-repository';

afterEach(()=>vi.unstubAllGlobals());

describe('public US fund metadata transport',()=>{
 it.each([['QQQ','NASDAQ-100','NDX'],['SPY','S&P 500','SP500']])('reads %s benchmark evidence from the quote overview',async(symbol,index,benchmark)=>{
  const db={
   marketInstrument:{findUnique:vi.fn(async()=>({id:'instrument',code:`${symbol}.US`,name:symbol,market:'us',currency:'USD',kind:'etf',tencent:null,yahoo:symbol,eastmoney:null}))},
   $queryRaw:vi.fn(async()=>[]),$executeRaw:vi.fn(async()=>1),
  };
  const url=`https://finance.yahoo.com/quote/${symbol}/`;
  const payload={body:JSON.stringify({quoteSummary:{result:[{price:{symbol},assetProfile:{longBusinessSummary:`The fund tracks the ${index} Index.`}}]}})};
  const fetcher=vi.fn(async(input:string)=>new Response(input===url
   ?`<script data-url="https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=assetProfile,price">${JSON.stringify(payload)}</script>`
   :'<title>Company Profile &amp; Facts - Yahoo Finance</title>'));
  vi.stubGlobal('fetch',fetcher);
  const beforeRequest=vi.fn(async()=>{});
  const product=await createProductRegistry(db as unknown as PrismaClient,beforeRequest).refresh(`${symbol}.US`);
  expect(product?.benchmark?.id).toBe(benchmark);
  expect(fetcher).toHaveBeenCalledWith(url,expect.objectContaining({redirect:'error'}));
  expect(beforeRequest).toHaveBeenCalledOnce();
  expect(db.$executeRaw.mock.calls[0]).toContain(url);
 });
});
