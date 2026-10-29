import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {createIsolatedTestDatabase} from '@/test/isolated-database';
import {createPrismaClient} from '@/server/db/client';
import {AlertRepository} from '@/server/price-alerts/repository';
import {AlertScheduler} from '@/server/price-alerts/scheduler';
import {ValuationRepository,type HistoryStore} from './repository';
import {resolveValuationProduct} from './catalog';
import {ValuationService} from './service';
import type {SeriesDefinition,SeriesRequest} from './types';

const databaseUrl=process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('valuation retention and persistent collection',()=>{
 const {db,setup,cleanup}=createIsolatedTestDatabase();
 const shared=createPrismaClient(databaseUrl!),repo=new ValuationRepository(db),prefix=`retention:${randomUUID()}:`;
 const now=new Date('2026-10-29T08:00:00Z');
 const foreignScanId=`retention-isolation:${randomUUID()}`;
 const definition=(s:SeriesDefinition)=>({...s,key:prefix+s.key});
 const store:HistoryStore={
  readSeries:s=>repo.readSeries(definition(s)),claimSeries:(s,n)=>repo.claimSeries(definition(s),n),
  commitBatch:(...args)=>repo.commitBatch(...args),failBatch:(...args)=>repo.failBatch(...args),
 };
 beforeAll(setup);
 afterAll(async()=>{
  await shared.marketScan.deleteMany({where:{id:foreignScanId}});
  await shared.$disconnect();await cleanup();
 });
 it('preserves old observations, revisions and the backfill cursor through the alert cleanup',async()=>{
  const s=definition(resolveValuationProduct('510880')!.series.pe!);
  for(const value of ['10','12']){
   const claim=await repo.claimSeries(s,new Date('2001-01-01T00:00:00Z'));
   await repo.commitBatch(claim!,{observations:[{date:'2000-12-29',value,quality:'valid'}],reachedStart:false},new Date('2001-01-01T00:00:00Z'),{cursor:'1999-12-31',complete:false});
  }
  const old=new Date(+now-4*86400000);
  await shared.marketScan.create({data:{id:foreignScanId,market:'cn',windowEnd:old,status:'complete',report:{},createdAt:old}});
  const localScanId=`${foreignScanId}:local`;
  await db.marketScan.create({data:{id:localScanId,market:'cn',windowEnd:old,status:'complete',report:{},createdAt:old}});
  await new AlertScheduler(new AlertRepository(db,()=>+now),{beforeRequest:async()=>{},encryptionKey:'',baseUrl:''}).tick();
  expect(await db.marketScan.findUnique({where:{id:localScanId}})).toBeNull();
  expect(await shared.marketScan.findUnique({where:{id:foreignScanId}})).not.toBeNull();
  const restored=await new ValuationRepository(db).readSeries(s);
  expect(restored?.observations).toEqual([{date:'2000-12-29',value:'12',quality:'valid'}]);
  expect(restored?.cursor).toBe('1999-12-31');expect(await db.researchObservation.count({where:{seriesKey:s.key}})).toBe(2);
 });
 it('shares the S&P500 cache across funds and retains it after an upstream outage',async()=>{
  let clock=now;let code='VOO';
  const fetcher=vi.fn(async(r:SeriesRequest)=>({observations:[{date:r.to,value:'24',quality:'valid' as const}],reachedStart:true}));
  const service=new ValuationService({grid:{get:async()=>({id:'grid',productCode:code})},store,fetch:fetcher,clock:()=>clock,beforeRequest:async()=>{}});
  await service.refresh('owner','grid','due');fetcher.mockClear();await service.read('owner','grid');await service.refresh('owner','grid','due');expect(fetcher).not.toHaveBeenCalled();
  code='513650';expect((await service.read('owner','grid')).pe.stats.currentValue).toBe('24');
  await service.refresh('owner','grid','due');expect(fetcher.mock.calls.every(c=>c[0].series.metric==='price')).toBe(true);
  clock=new Date(+now+8*86400000);fetcher.mockRejectedValue(new Error('HTTP 503'));
  const offline=await service.refresh('owner','grid','manual');expect(offline.pe.stats.currentValue).toBe('24');expect(offline.pe.message).toContain('更新失败');
 });
});
