import {beforeEach,describe,expect,it,vi} from 'vitest';
import {ValuationService} from './service';
import type {HistoryStore,SeriesClaim,CommitState} from './repository';
import {resolveValuationProduct} from './catalog';
import type {Observation,SeriesDefinition,SeriesSnapshot,SeriesBatch} from './types';
class MemoryHistory implements HistoryStore {
 rows=new Map<string,SeriesSnapshot>();
 async readSeries(s:SeriesDefinition){return structuredClone(this.rows.get(s.key)??null);}
 async claimSeries(s:SeriesDefinition,now:Date){let r=this.rows.get(s.key);if(r?.leaseUntil && r.leaseUntil>now.toISOString())return null;if(!r){r={definition:s,observations:[],checkedAt:null,lastAttemptAt:null,retryAt:null,leaseUntil:null,cursor:null,complete:false,failures:0,error:null};this.rows.set(s.key,r);}r.leaseUntil=new Date(+now+120000).toISOString();r.lastAttemptAt=now.toISOString();return {key:s.key,token:'test'};}
 async commitBatch(c:SeriesClaim,b:SeriesBatch,n:Date,state:CommitState){const r=this.rows.get(c.key)!;r.observations=[...new Map([...r.observations,...b.observations].map(p=>[p.date,p])).values()].sort((a,b)=>a.date.localeCompare(b.date));Object.assign(r,state,{checkedAt:n.toISOString(),leaseUntil:null,error:null,failures:0,retryAt:null});}
 async failBatch(c:SeriesClaim,error:string,n:Date,seeds:Observation[]=[]){const r=this.rows.get(c.key)!;if(!r.observations.length)r.observations=seeds;Object.assign(r,{error,leaseUntil:null,retryAt:new Date(+n+900000).toISOString(),failures:r.failures+1});}
}
let store:MemoryHistory,clock:Date;
const get=vi.fn(),fetcher=vi.fn(),guard=vi.fn();
const product=resolveValuationProduct('510880')!;
const ready=async()=>{for(const s of Object.values(product.series)){if(!s)continue;const c=await store.claimSeries(s,clock);await store.commitBatch(c!,{observations:[{date:'2026-10-28',value:'10',quality:'valid'}],reachedStart:true},clock,{cursor:null,complete:true});}};
const service=()=>new ValuationService({grid:{get},store,fetch:fetcher,clock:()=>clock,beforeRequest:guard});
beforeEach(()=>{vi.resetAllMocks();store=new MemoryHistory();clock=new Date('2026-10-28T08:00:00Z');get.mockResolvedValue({id:'grid',productCode:'510880',productName:'红利'});fetcher.mockResolvedValue({observations:[{date:'2026-10-28',value:'10',quality:'valid'}],reachedStart:true});});
describe('cached valuation observation service',()=>{
 it('always reads local records and makes zero upstream calls on GET, even when empty',async()=>{expect((await service().read('owner','grid')).price.availability).toBe('empty');await ready();expect((await service().read('owner','grid')).price.stats.currentValue).toBe('10');expect(fetcher).not.toHaveBeenCalled();});
 it('makes no due refresh requests for fresh data, then refreshes valuations exactly at seven days',async()=>{
  await ready();await service().refresh('owner','grid','due');expect(fetcher).not.toHaveBeenCalled();
  clock=new Date(+clock+604800000-1);await service().refresh('owner','grid','due');expect(fetcher.mock.calls.some(c=>c[0].series.metric==='pe')).toBe(false);
  fetcher.mockClear();clock=new Date(+clock+1);await service().refresh('owner','grid','due');expect(fetcher.mock.calls.some(c=>c[0].series.metric==='pe')).toBe(true);
 });
 it('keeps cached data on 403 and marks archived values as dated observations, never live updates',async()=>{
  fetcher.mockRejectedValue(new Error('HTTP 403'));
  const result=await service().refresh('owner','grid','due');expect(result.pe.points.length).toBeGreaterThan(2000);expect(result.pb.points.length).toBeGreaterThan(200);
  expect(result.pb.checkedAt).toBeNull();expect(result.pb.message).toContain('已保存');expect(result.pb.asOf).toBe('2026-09-30');
  const count=fetcher.mock.calls.length;await service().refresh('owner','grid','due');expect(fetcher).toHaveBeenCalledTimes(count);
 });
 it('distinguishes an empty failed series from a saved fallback',async()=>{
  get.mockResolvedValue({id:'grid',productCode:'VOO'});fetcher.mockRejectedValue(new Error('HTTP 503'));
  const data=await service().refresh('owner','grid','due');
  expect(data.price.availability).toBe('error');expect(data.price.message).toContain('暂无已保存数据');
 });
 it('resumes incomplete backfill without waiting seven days and bounds each refresh',async()=>{
  fetcher.mockImplementation(async (r)=>({observations:[{date:r.to,value:'1',quality:'valid'}],reachedStart:false}));
  await service().refresh('owner','grid','due');expect(fetcher.mock.calls.length).toBeLessThanOrEqual(4);
  const before=fetcher.mock.calls.length;await service().refresh('owner','grid','due');expect(fetcher.mock.calls.length).toBeGreaterThan(before);
  const requests=fetcher.mock.calls.map(c=>c[0]);expect(requests.some(r=>r.to<'2026-01-01')).toBe(true);
 });
 it('checks maintenance and grid ownership before any collection',async()=>{
  get.mockRejectedValue(new Error('not found'));await expect(service().refresh('other','grid','manual')).rejects.toThrow('not found');expect(fetcher).not.toHaveBeenCalled();
  get.mockResolvedValue({id:'grid',productCode:'510880'});guard.mockRejectedValue(new Error('maintenance'));await expect(service().refresh('owner','grid','manual')).rejects.toThrow('maintenance');expect(fetcher).not.toHaveBeenCalled();
 });
 it('keeps unsupported products and REIT fundamentals distinct and never guesses',async()=>{
  get.mockResolvedValue({id:'grid',productCode:'508000'});expect((await service().read('owner','grid')).pe.availability).toBe('not_applicable');
  get.mockResolvedValue({id:'grid',productCode:'unknown'});expect((await service().read('owner','grid')).price.availability).toBe('unsupported');
 });
 it('does not let repeated manual refresh bypass cooldown',async()=>{await ready();await expect(service().refresh('owner','grid','manual')).rejects.toMatchObject({status:429});expect(fetcher).not.toHaveBeenCalled();});
 it('shows a busy result when another page has the series lease',async()=>{
  for(const s of Object.values(product.series))if(s)await store.claimSeries(s,clock);
  expect((await service().refresh('owner','grid','due')).refresh.busy).toBe(true);expect(fetcher).not.toHaveBeenCalled();
 });
});
