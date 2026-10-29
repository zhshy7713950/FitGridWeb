import {createHash,randomUUID} from 'node:crypto';
import type {PrismaClient,Prisma} from '@/generated/prisma/client';
import type {Observation,SeriesBatch,SeriesDefinition,SeriesSnapshot} from './types';
export interface SeriesClaim {key:string;token:string}
export interface CommitState {cursor:string|null;complete:boolean}
export interface HistoryStore {
 readSeries(s:SeriesDefinition):Promise<SeriesSnapshot|null>;
 claimSeries(s:SeriesDefinition,now:Date):Promise<SeriesClaim|null>;
 commitBatch(claim:SeriesClaim,batch:SeriesBatch,now:Date,state:CommitState):Promise<void>;
 failBatch(claim:SeriesClaim,error:string,now:Date,seeds?:Observation[]):Promise<void>;
}
export class ValuationRepository implements HistoryStore {
 constructor(private readonly db:PrismaClient){}
 async readSeries(definition:SeriesDefinition):Promise<SeriesSnapshot|null> {
  const row=await this.db.researchSeries.findUnique({where:{key:definition.key}});if(!row)return null;
  const records=await this.db.$queryRaw<Array<{date:string;value:string|null;quality:Observation['quality']}>>`
    SELECT DISTINCT ON (date) date, value::text, quality FROM research_observations
    WHERE series_key=${definition.key} ORDER BY date ASC, revision DESC`;
  return {definition,observations:records.map(p=>({...p,value:p.value===null?null:p.value.replace(/\.?0+$/,'')||'0'})),
    checkedAt:row.checkedAt?.toISOString()??null,lastAttemptAt:row.lastAttemptAt?.toISOString()??null,
    retryAt:row.retryAt?.toISOString()??null,leaseUntil:row.leaseUntil?.toISOString()??null,
    cursor:row.cursor,complete:row.complete,failures:row.failures,error:row.error};
 }
 async claimSeries(s:SeriesDefinition,now:Date):Promise<SeriesClaim|null> {
  await this.db.$executeRaw`INSERT INTO research_series(key, definition) VALUES (${s.key}, ${JSON.stringify(s)}::jsonb) ON CONFLICT (key) DO NOTHING`;
  const token=randomUUID();
  const updated=await this.db.researchSeries.updateMany({where:{key:s.key,AND:[{OR:[{leaseUntil:null},{leaseUntil:{lte:now}}]},{OR:[{retryAt:null},{retryAt:{lte:now}}]}]},data:{leaseToken:token,leaseUntil:new Date(now.getTime()+120000),lastAttemptAt:now}});
  return updated.count?{key:s.key,token}:null;
 }
 private async save(tx:Prisma.TransactionClient,claim:SeriesClaim,rows:Observation[],now:Date){
  const latest=[...new Map(rows.map(p=>[p.date,p])).values()];if(!latest.length)return;
  const payload=JSON.stringify(latest.map(p=>({...p,hash:createHash('sha256').update(JSON.stringify(p)).digest('hex')})));
  await tx.$executeRaw`
    WITH incoming AS (SELECT * FROM jsonb_to_recordset(${payload}::jsonb) AS x(date text,value text,quality text,hash text)),
    changed AS (
      SELECT i.*, COALESCE(last.revision,0)+1 AS revision FROM incoming i
      LEFT JOIN LATERAL (SELECT revision,content_hash FROM research_observations WHERE series_key=${claim.key} AND date=i.date ORDER BY revision DESC LIMIT 1) last ON true
      WHERE last.content_hash IS DISTINCT FROM i.hash
    ) INSERT INTO research_observations(series_key,date,revision,value,quality,content_hash,raw,first_seen_at)
      SELECT ${claim.key},date,revision,value::numeric,quality,hash,jsonb_build_object('date',date,'value',value,'quality',quality),${now} FROM changed`;
 }
 private async owned(tx:Prisma.TransactionClient,claim:SeriesClaim,now:Date){
  const rows=await tx.$queryRaw<Array<{failures:number}>>`SELECT failures FROM research_series WHERE key=${claim.key} AND lease_token=${claim.token}::uuid AND lease_until>${now} FOR UPDATE`;
  if(!rows.length)throw new Error('数据刷新租约已过期');return rows[0];
 }
 async commitBatch(claim:SeriesClaim,batch:SeriesBatch,now:Date,state:CommitState):Promise<void>{
  await this.db.$transaction(async tx=>{
   await this.owned(tx,claim,now);await this.save(tx,claim,batch.observations,now);
   await tx.researchSeries.update({where:{key:claim.key},data:{...state,checkedAt:now,error:null,failures:0,retryAt:null,leaseToken:null,leaseUntil:null}});
  });
 }
 async failBatch(claim:SeriesClaim,error:string,now:Date,seeds:Observation[]=[]):Promise<void>{
  await this.db.$transaction(async tx=>{
   const row=await this.owned(tx,claim,now);await this.save(tx,claim,seeds,now);
   const wait=[900000,3600000,21600000][Math.min(row.failures,2)];
   await tx.researchSeries.update({where:{key:claim.key},data:{error:error.slice(0,240),failures:row.failures+1,retryAt:new Date(now.getTime()+wait),leaseToken:null,leaseUntil:null}});
  });
 }
}
