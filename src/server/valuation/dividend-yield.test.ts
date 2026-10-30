import {describe,expect,it} from 'vitest';
import {buildDividendYield} from './dividend-yield';
import {summarizeValuation} from './statistics';
import type {Observation} from './types';
const price=(date:string,value='2'):Observation=>({date,value,quality:'valid'});
const event=(recordDate:string,exDate:string,value:string):Observation=>({date:recordDate,value,quality:'valid',distribution:{verified:true,exDate,recordDate,announcedAt:recordDate,noticeId:'AN'+recordDate.replaceAll('-','')+'0000000001',evidenceUrl:'https://data.eastmoney.com/notices/detail/508000/AN202601010000000001.html',contentHash:'a'.repeat(64)}});
const coverage={from:'2021-06-21',through:'2026-10-29'};
describe('trailing twelve calendar month cash distribution yield',()=>{
 it('includes the exchange ex-date, excludes the left boundary, and never annualizes incomplete history',()=>{
  const result=buildDividendYield([price('2022-06-20'),price('2022-06-21'),price('2026-04-02'),price('2026-04-03'),price('2026-04-07')],[event('2025-04-02','2025-04-03','0.1'),event('2026-04-03','2026-04-07','0.2')],coverage);
  expect(result.points.map(p=>p.value)).toEqual([null,'0','5','0','10']);expect(result.trailingDistribution).toBe('0.2');
 });
 it('does not treat unverified, stale coverage or gaps in prices as zero',()=>{
  const pending:Observation={...event('2026-04-03','2026-04-07','0.2'),value:null,quality:'missing',distribution:{...event('2026-04-03','2026-04-07','0.2').distribution!,verified:false,exDate:null}};
  expect(buildDividendYield([price('2026-04-02'),price('2026-04-07'),price('2026-10-30')],[pending],coverage).points.map(p=>p.value)).toEqual(['0',null,null]);
  expect(buildDividendYield([{date:'2026-04-07',value:null,quality:'gap'}],[],coverage).points[0].value).toBeNull();
  expect(buildDividendYield([price('2026-04-07')],[],null).points[0].value).toBeNull();
 });
 it('uses the disclosed per-share amount across expansion and de-duplicates identical events',()=>{
  const e=event('2026-04-03','2026-04-07','0.1');
  expect(buildDividendYield([price('2026-04-07')],[e,e],coverage).points[0].value).toBe('5');
  expect(()=>buildDividendYield([price('2026-04-07')],[e,{...e,value:'0.2'}],coverage)).toThrow();
 });
 it('handles leap-day twelve-month boundaries and excludes future distributions',()=>{
  const events=[event('2023-02-27','2023-02-28','0.1'),event('2024-02-28','2024-02-29','0.2'),event('2026-11-01','2026-11-02','0.3')];
  expect(buildDividendYield([price('2024-02-29')],events,coverage).points[0].value).toBe('10');
 });
 it('preserves true zero in yield statistics without changing PE/PB validity',()=>{
  const rows:Observation[]=[{date:'2026-01-01',value:'0',quality:'valid'},{date:'2026-01-02',value:'5',quality:'valid'},{date:'2026-01-03',value:'10',quality:'valid'}];
  expect(summarizeValuation(rows,{allowZero:true})).toMatchObject({min:'0',p50:'5',validCount:3,currentPercentile:'100'});
  expect(summarizeValuation(rows).validCount).toBe(2);
 });
});
