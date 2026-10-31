import {randomUUID} from 'node:crypto';
import {afterAll,describe,expect,it} from 'vitest';
import {createPrismaClient} from '@/server/db/client';
import {ValuationRepository} from './repository';
import {resolveValuationProduct} from './catalog';
import {summarizeValuation} from './statistics';
import type {Observation} from './types';
const databaseUrl=process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('persistent valuation histories',()=>{
 const db=createPrismaClient(databaseUrl!),repo=new ValuationRepository(db);
 const s={...resolveValuationProduct('510880')!.series.pe!,key:`test:${randomUUID()}`};
 const monthly={...resolveValuationProduct('VOO')!.series.pe!,key:`test:${randomUUID()}`};
 const invalidMonthly={...monthly,key:`test:${randomUUID()}`};
 const daily={...s,key:`test:${randomUUID()}`};
 const distribution={...resolveValuationProduct("508000")!.series.distribution!,key:`test:${randomUUID()}`};
 const weekly={...resolveValuationProduct('510880')!.series.dividend_yield!,key:`test:${randomUUID()}`};
 const keys=[s.key,monthly.key,invalidMonthly.key,daily.key,distribution.key,weekly.key];
 const now=new Date('2026-10-29T08:00:00Z');
 afterAll(async()=>{await db.researchObservation.deleteMany({where:{seriesKey:{in:keys}}});await db.researchSeries.deleteMany({where:{key:{in:keys}}});await db.$disconnect();});
 it('keeps one weekly observation across refreshes without deleting raw dates or revisions',async()=>{
  for(const observations of [[{date:'2025-12-30',value:'2',quality:'valid'},{date:'2026-01-06',value:'4',quality:'valid'}],[{date:'2026-01-02',value:'3',quality:'valid'},{date:'2026-01-09',value:null,quality:'missing'}]] satisfies Observation[][]){
   const claim=await repo.claimSeries(weekly,now);await repo.commitBatch(claim!,{observations,reachedStart:true},now,{cursor:null,complete:true});
  }
  expect((await new ValuationRepository(db).readSeries(weekly))!.observations).toEqual([{date:'2026-01-02',value:'3',quality:'valid'},{date:'2026-01-09',value:null,quality:'missing'}]);
  expect(await db.researchObservation.count({where:{seriesKey:weekly.key}})).toBe(4);
 });
 it('grants exactly one lease across independent repository instances',async()=>{
  const results=await Promise.all([repo.claimSeries(s,now),new ValuationRepository(db).claimSeries(s,now)]);
  expect(results.filter(Boolean)).toHaveLength(1);
  await repo.commitBatch(results.find(Boolean)!,{observations:[{date:'2026-10-28',value:'10',quality:'valid'}],reachedStart:false},now,{cursor:'2025-10-28',complete:false});
  const stored=await repo.readSeries(s);expect(stored?.cursor).toBe('2025-10-28');expect(stored?.observations).toHaveLength(1);
 });
 it('deduplicates unchanged values and appends revisions without overwriting history',async()=>{
  for(const value of ['10','12']){const claim=await repo.claimSeries(s,new Date(now.getTime()+1000));expect(claim).not.toBeNull();await repo.commitBatch(claim!,{observations:[{date:'2026-10-28',value,quality:'valid'}],reachedStart:true},now,{cursor:null,complete:true});}
  expect(await db.researchObservation.count({where:{seriesKey:s.key}})).toBe(2);
  expect((await new ValuationRepository(db).readSeries(s))?.observations[0].value).toBe('12');
 });
 it('rejects expired claims and preserves prior data after source failures',async()=>{
  const old=await repo.claimSeries(s,new Date(now.getTime()+2000));
  const replacement=await repo.claimSeries(s,new Date(now.getTime()+123000));expect(replacement).not.toBeNull();
  await expect(repo.commitBatch(old!,{observations:[],reachedStart:true},new Date(now.getTime()+124000),{cursor:null,complete:true})).rejects.toThrow();
  await repo.failBatch(replacement!,'HTTP 403',new Date(now.getTime()+124000));
  expect((await repo.readSeries(s))?.observations[0].value).toBe('12');
  expect((await repo.readSeries(s))?.error).toContain('403');
 });
 it('counts a monthly observation once across archived fallback, refreshes and revisions',async()=>{
  const seed=await repo.claimSeries(monthly,now);
  await repo.failBatch(seed!,'HTTP 403',now,[{date:'2026-09-30',value:'10',quality:'valid'},{date:'2026-10-27',value:'20',quality:'valid'}]);
  const refreshedAt=new Date(+now+16*60000);
  const claim=await repo.claimSeries(monthly,refreshedAt);
  await repo.commitBatch(claim!,{observations:[{date:'2026-10-29',value:'30',quality:'valid'}],reachedStart:true},refreshedAt,{cursor:null,complete:true});
  const points=(await new ValuationRepository(db).readSeries(monthly))!.observations;
  expect(points).toEqual([{date:'2026-09-30',value:'10',quality:'valid'},{date:'2026-10-29',value:'30',quality:'valid'}]);
  expect(summarizeValuation(points)).toMatchObject({validCount:2,referenceCount:1,p30:'16',p70:'24',currentValue:'30',currentPercentile:null});
  for(const observation of [{date:'2026-10-29',value:'40',quality:'valid'},{date:'2026-10-27',value:'25',quality:'valid'}] satisfies Observation[]){
   const revision=await repo.claimSeries(monthly,refreshedAt);
   await repo.commitBatch(revision!,{observations:[observation],reachedStart:true},refreshedAt,{cursor:null,complete:true});
  }
  const revised=(await repo.readSeries(monthly))!.observations;
  expect(revised).toEqual([{date:'2026-09-30',value:'10',quality:'valid'},{date:'2026-10-29',value:'40',quality:'valid'}]);
  expect(summarizeValuation(revised)).toMatchObject({validCount:2,p30:'19',p70:'31',currentValue:'40',currentPercentile:null});
  expect(await db.researchObservation.count({where:{seriesKey:monthly.key}})).toBe(5);
 });
 it('keeps the latest monthly missing value instead of falling back to an earlier positive value',async()=>{
  for(const observations of [
   [{date:'2026-09-30',value:'10',quality:'valid'},{date:'2026-10-27',value:'20',quality:'valid'}],
   [{date:'2026-10-29',value:null,quality:'missing'}],
  ] satisfies Observation[][]){
   const claim=await repo.claimSeries(invalidMonthly,now);
   await repo.commitBatch(claim!,{observations,reachedStart:true},now,{cursor:null,complete:true});
  }
  const points=(await repo.readSeries(invalidMonthly))!.observations;
  expect(points).toEqual([{date:'2026-09-30',value:'10',quality:'valid'},{date:'2026-10-29',value:null,quality:'missing'}]);
  expect(summarizeValuation(points)).toMatchObject({validCount:1,currentValue:null,currentPercentile:null,latestDate:'2026-10-29',latestValidDate:'2026-09-30'});
  expect(await db.researchObservation.count({where:{seriesKey:invalidMonthly.key}})).toBe(3);
 });
 it('keeps separate daily dates in the same month',async()=>{
  const claim=await repo.claimSeries(daily,now);
  await repo.commitBatch(claim!,{observations:[{date:'2026-10-27',value:'10',quality:'valid'},{date:'2026-10-28',value:'20',quality:'valid'}],reachedStart:true},now,{cursor:null,complete:true});
  expect((await repo.readSeries(daily))!.observations).toEqual([{date:'2026-10-27',value:'10',quality:'valid'},{date:'2026-10-28',value:'20',quality:'valid'}]);
 });
 it('persists per-share cash, publication dates and exchange-date evidence across revisions and restarts',async()=>{
  const evidence={verified:true,recordDate:'2026-04-03',exDate:'2026-04-07',announcedAt:'2026-04-01',noticeId:'AN202603311820912934',evidenceUrl:'https://data.eastmoney.com/notices/detail/508000/AN202603311820912934.html',contentHash:'a'.repeat(64)};
  for(const exDate of ['2026-04-07','2026-04-08','2026-04-08']){
   const claim=await repo.claimSeries(distribution,now);await repo.commitBatch(claim!,{observations:[{date:evidence.recordDate,value:'0.1',quality:'valid',distribution:{...evidence,exDate}}],reachedStart:true},now,{cursor:null,complete:true});
  }
  expect((await new ValuationRepository(db).readSeries(distribution))?.observations).toEqual([{date:evidence.recordDate,value:'0.1',quality:'valid',distribution:{...evidence,exDate:'2026-04-08'}}]);
  expect(await db.researchObservation.count({where:{seriesKey:distribution.key}})).toBe(2);
  const raw=await db.researchObservation.findFirst({where:{seriesKey:distribution.key}});expect(raw?.sourcePublishedAt?.toISOString()).toBe('2026-04-01T00:00:00.000Z');
 });

});
