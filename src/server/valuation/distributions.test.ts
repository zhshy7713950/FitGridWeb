import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {parseDistributionTable,parseDistributionNotice,fetchDistributionBatch} from './distributions';
import {resolveValuationProduct} from './catalog';
import type {Observation} from './types';
const fixture=(name:string)=>readFileSync(new URL('./fixtures/reit/'+name,import.meta.url),'utf8');
const json=(name:string)=>JSON.parse(fixture(name));
const source=(code:string)=>resolveValuationProduct(code)!.series.distribution!;
describe('publisher-verified REIT distributions',()=>{
 it.each(['508000','508056'])('verifies all actual %s announcements, per-share amounts and in-exchange dates',(code)=>{
  const candidates=parseDistributionTable(code,fixture(code+'-table.txt'));
  const notices=json(code+'-notices.txt').Data;
  expect(candidates).toHaveLength(code==='508000'?10:17);
  for(const candidate of candidates){
   const notice=notices.find((n:{PUBLISHDATEDesc:string})=>n.PUBLISHDATEDesc<=candidate.recordDate&&n.PUBLISHDATEDesc>candidate.previousRecordDate)!;
   const point=parseDistributionNotice(code,candidate,notice,json(notice.ID+'.json'));
   expect(point.quality).toBe('valid');expect(point.value).toBe(candidate.perShare);
   expect((point.distribution?.exDate??'')>candidate.recordDate).toBe(true);
   expect(point.distribution).toMatchObject({verified:true,noticeId:notice.ID,recordDate:candidate.recordDate});
  }
 });
 it('uses the official 2026-04-07 exchange ex-date, not the table 2026-04-03 date',()=>{
  const candidate=parseDistributionTable('508056',fixture('508056-table.txt')).find(p=>p.recordDate==='2026-04-03')!;
  const notice=json('508056-notices.txt').Data.find((n:{ID:string})=>n.ID==='AN202603311820912934');
  expect(parseDistributionNotice('508056',candidate,notice,json(notice.ID+'.json'))).toMatchObject({value:'0.0458',distribution:{exDate:'2026-04-07'}});
 });
 it('refuses wrong identities, changed amounts, absent exchange dates and unit changes',()=>{
  const candidate=parseDistributionTable('508056',fixture('508056-table.txt')).find(p=>p.recordDate==='2026-04-03')!;
  const notice=json('508056-notices.txt').Data.find((n:{ID:string})=>n.ID==='AN202603311820912934');
  const body=json(notice.ID+'.json');
  expect(()=>parseDistributionNotice('508000',candidate,notice,body)).toThrow();
  for(const unit of ['元/100','元/1000','元/10.5'])expect(()=>parseDistributionNotice('508056',candidate,notice,{...body,data:{...body.data,notice_content:body.data.notice_content.replaceAll('元/10',unit)}})).toThrow();
  expect(()=>parseDistributionNotice('508056',{...candidate,perShare:'0.9'},notice,body)).toThrow();
  expect(()=>parseDistributionNotice('508056',candidate,notice,{...body,data:{...body.data,notice_content:body.data.notice_content.replaceAll('场内','未知')}})).toThrow();
  expect(()=>parseDistributionTable('508056',fixture('508056-table.txt').replace('暂无拆分信息!','2026-01-01 份额拆分 1:2'))).toThrow();
 });
 it('bounds each batch and resumes from persisted verified events without re-fetching the entire document history',async()=>{
  let points:Observation[]=[];let batches=0;const urls:string[]=[];
  const fetchText=async(url:string)=>{urls.push(url);if(url.includes('fhsp_'))return fixture('508056-table.txt');if(url.includes('/FHGG?'))return fixture('508056-notices.txt');const id=new URL(url).searchParams.get('art_code')!;return fixture(id+'.json');};
  for(;;){const before=urls.length;const result=await fetchDistributionBatch({series:source('508056'),from:'2021-06-21',to:'2026-10-29',knownObservations:points,requestBudget:7},fetchText);points=result.observations;batches++;
   expect(urls.length-before).toBeLessThanOrEqual(7);if(result.reachedStart)break;expect(batches).toBeLessThan(5);
  }
  expect(points).toHaveLength(17);expect(points.every(p=>p.distribution?.verified)).toBe(true);
  expect(urls.filter(u=>u.includes('/content/ann?'))).toHaveLength(17);
  const before=urls.length;await fetchDistributionBatch({series:source('508056'),from:'2021-06-21',to:'2026-10-29',knownObservations:points,requestBudget:7},fetchText);expect(urls.length-before).toBe(2);
 });
 it('rejects truncated announcement lists rather than claiming a complete zero distribution history',async()=>{
  const fetchText=async(url:string)=>url.includes('fhsp_')?fixture('508000-table.txt'):JSON.stringify({...json('508000-notices.txt'),TotalCount:999});
  await expect(fetchDistributionBatch({series:source('508000'),from:'2021-06-21',to:'2026-10-29',requestBudget:7},fetchText)).rejects.toThrow();
 });
});
