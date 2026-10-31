import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {resolveValuationProduct} from './catalog';
import {fetchSeriesBatch,parseSeries,requestFor} from './sources';
import {archivedObservations} from './archive';
const yieldSeries=(code='510880')=>resolveValuationProduct(code)!.series.dividend_yield!;
const fixture=(name:string)=>JSON.parse(gunzipSync(readFileSync(`src/server/valuation/fixtures/yield/${name}.json.gz`)).toString());
const page=(rows:string,heading='S&amp;P 500 Dividend Yield by Month')=>`<h1>${heading}</h1><table id="datatable"><tr><th>Date</th><th>Value</th></tr>${rows}</table>`;
const row=(d:string,v:string)=>`<tr><td>${d}</td><td>${v}</td></tr>`;
describe('index dividend yield ingestion',()=>{
 it('uses fixed index identities, distinct histories and explicit unsupported products',()=>{
  expect(yieldSeries()).toMatchObject({subject:'000015',metric:'dividend_yield',frequency:'weekly',symbol:'000015.SH'});
  expect(yieldSeries('159920')).toMatchObject({subject:'HSI',frequency:'monthly'});
  expect(yieldSeries('VOO').key).toBe(yieldSeries('513650').key);
  expect(resolveValuationProduct('SCHD')!.series.dividend_yield).toBeNull();
  expect(resolveValuationProduct('508000')!.series.dividend_yield).toBeNull();
  expect(requestFor(yieldSeries(),'2021-01-01','2026-10-30').url).toContain('/index-basic?indexCode=000015.SH&freq=week&token=');
 });
 it('parses percent units without substituting TTM/weighted fields and treats unverified zero/negative values as missing',()=>{
  const data=[{date:'2026-10-16',dvRatio:5.2,addDvTtm:3},{date:'2026-10-23',dvRatio:0},{date:'2026-10-30',dvRatio:-1}];
  expect(parseSeries(yieldSeries(),{data},'2026-10-30')).toEqual([{date:'2026-10-16',value:'5.2',quality:'valid'},{date:'2026-10-23',value:null,quality:'missing'},{date:'2026-10-30',value:null,quality:'missing'}]);
  expect(()=>parseSeries(yieldSeries(),{data:[{date:'2026-10-30',addDvTtm:3}]},'2026-10-30')).toThrow('股息率');
 });
 it('takes the latest date of each week, retains a missing current sample and excludes future observations',()=>{
  const data=[{date:'2026-10-20',dvRatio:5},{date:'2026-10-23',dvRatio:6},{date:'2026-10-27',dvRatio:5},{date:'2026-10-30',dvRatio:null},{date:'2026-11-06',dvRatio:7}];
  expect(parseSeries(yieldSeries(),{data},'2026-10-30')).toEqual([{date:'2026-10-23',value:'6',quality:'valid'},{date:'2026-10-30',value:null,quality:'missing'}]);
 });
 it('reads HSI dvRatio rather than PE and preserves monthly weekend labels',()=>{
  expect(parseSeries(yieldSeries('159920'),[{date:'2026-05-31',pe:12,dvRatio:3},{date:'2026-06-30',pe:13,dvRatio:0}],'2026-06-30')).toEqual([{date:'2026-05-31',value:'3',quality:'valid'},{date:'2026-06-30',value:null,quality:'missing'}]);
  expect(parseSeries(yieldSeries('159920'),[{date:'2026-05-29',dvRatio:3},{date:'2026-05-31',dvRatio:3.1}],'2026-06-30')).toEqual([{date:'2026-05-31',value:'3.1',quality:'valid'}]);
 });
 it('reads real archived captures with the same parsing and non-synthetic fallback',()=>{
  const manifest=JSON.parse(readFileSync('src/server/valuation/fixtures/yield/manifest.json','utf8')) as Array<{file:string;sha256:string}>;
  for(const file of manifest)expect(createHash('sha256').update(readFileSync('src/server/valuation/fixtures/yield/'+file.file)).digest('hex')).toBe(file.sha256);
  for(const [code,index] of [['510880','000015'],['510300','000300'],['510500','000905']]){
   const points=parseSeries(yieldSeries(code),fixture(`legu-week-${index}`),'2026-10-27');
   expect(points).toHaveLength(255);expect(points.at(-1)?.date).toBe('2026-10-23');
   expect(archivedObservations(yieldSeries(code).key)).toEqual(points);
  }
  const points=parseSeries(yieldSeries('159920'),fixture('legu-hsi'),'2026-10-27');
  expect(points.find(p=>p.value!==null)?.date).toBe('1997-12-31');
  expect(archivedObservations(yieldSeries('159920').key)).toEqual(points);
  const html=gunzipSync(readFileSync('src/server/valuation/fixtures/yield/multpl-sp500.html.gz')).toString();
  const sp=parseSeries(yieldSeries('VOO'),html,'2026-10-30');expect(sp).toHaveLength(1870);expect(sp.at(-1)?.value).toBeNull();expect(sp.filter(p=>p.quality==='valid').at(-1)).toEqual({date:'2026-06-30',value:'1.1',quality:'valid'});
  expect(archivedObservations(yieldSeries('VOO').key)).toEqual(sp);
 });
 it('parses verified S&P monthly percentages while retaining estimated rows as missing and rejects wrong identity/columns/units',async()=>{
  const s=yieldSeries('VOO');
  const text=page(row('Oct 30, 2026','<abbr title="Estimate">†</abbr>1.07%')+row('Oct 31, 2026','1.05%')+row('Jun 30, 2026','&#x2002;1.10%'));
  expect(parseSeries(s,text,'2026-10-30')).toEqual([{date:'2026-06-30',value:'1.1',quality:'valid'},{date:'2026-10-30',value:null,quality:'missing'}]);
  for(const invalid of [page(row('Jun 30, 2026','1.1%'),'S&amp;P 500 Earnings Yield'),page(row('Jun 30, 2026','1.1')),text.replace('<th>Value</th>','<th>Price</th>')])expect(()=>parseSeries(s,invalid,'2026-10-30')).toThrow();
  const fetched=await fetchSeriesBatch({series:s,from:'1800-01-01',to:'2026-10-30'},{signal:new AbortController().signal,fetcher:async()=>new Response(text)});
  expect(fetched.reachedStart).toBe(true);expect(fetched.observations).toHaveLength(2);
 });
});
