import {randomUUID} from 'node:crypto';
import {afterAll,describe,expect,it} from 'vitest';
import {createPrismaClient} from '@/server/db/client';
import {ValuationRepository} from './repository';
import {resolveValuationProduct} from './catalog';
const databaseUrl=process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('persistent valuation histories',()=>{
 const db=createPrismaClient(databaseUrl!),repo=new ValuationRepository(db);
 const s={...resolveValuationProduct('510880')!.series.pe!,key:`test:${randomUUID()}`};
 const now=new Date('2026-10-29T08:00:00Z');
 afterAll(async()=>{await db.researchObservation.deleteMany({where:{seriesKey:s.key}});await db.researchSeries.deleteMany({where:{key:s.key}});await db.$disconnect();});
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
});
