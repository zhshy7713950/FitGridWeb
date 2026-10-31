import {describe,expect,it} from 'vitest';
import {demoValuation} from '@/features/valuation/demo-valuation-data';
import {buildReferenceBasis} from './reference';
import type {MetricCard,Observation} from './types';

const now=new Date('2026-10-31T08:00:00Z');
function history():Observation[]{return Array.from({length:120},(_,i)=>({date:new Date(Date.UTC(2016,10+i,0)).toISOString().slice(0,10),value:'10',quality:'valid'}));}
function cards(){const demo=demoValuation('grid');return {card:{...demo.pe,points:[...history(),{date:'2026-10-29',value:'20',quality:'valid'}]} as MetricCard,price:{...demo.price,points:[{date:'2026-10-28',value:'4',quality:'valid'},{date:'2026-10-30',value:'5',quality:'valid'}]} as MetricCard};}
describe('independent valuation reference evidence',()=>{
 it.each(['pe','pb'] as const)('aligns %s to a prior price and excludes the unfinished month',metric=>{
  const {card,price}=cards();const r=buildReferenceBasis(metric,card,price,'etf',now);
  expect(r).toMatchObject({status:'conditional',target:'10',current:'20',metricDate:'2026-10-29',anchorPrice:'4',anchorDate:'2026-10-28',conditionPrice:'2',startPrice:'2',months:120,years:10});
 });
 it('inverts dividend yields and caps the simulation start at the latest price',()=>{
  const {card,price}=cards();card.points.at(-1)!.value='20';
  expect(buildReferenceBasis('dividendYield',card,price,'etf',now)).toMatchObject({target:'10',conditionPrice:'8',startPrice:'5'});
 });
 it('does not substitute a valid old observation for a missing latest value',()=>{
  const {card,price}=cards();card.points.at(-1)!.quality='missing';card.points.at(-1)!.value=null;
  expect(buildReferenceBasis('pe',card,price,'etf',now)).toMatchObject({status:'unavailable',startPrice:null});
 });
 it('keeps a month empty when its final observation is invalid',()=>{
  const {card,price}=cards();card.points=history().flatMap(r=>[{...r,date:r.date.slice(0,8)+'01'},{...r,value:null,quality:'missing' as const}]);card.points.push({date:'2026-10-29',value:'20',quality:'valid'});
  expect(buildReferenceBasis('pe',card,price,'etf',now).status).toBe('unavailable');
 });
 it('does not use a future price or a distant prior price to fill an anchor',()=>{
  const {card,price}=cards();price.points=[{date:'2026-10-01',value:'4',quality:'valid'},{date:'2026-10-30',value:'5',quality:'valid'}];
  expect(buildReferenceBasis('pe',card,price,'etf',now).status).toBe('unavailable');
 });
 it('refuses old or future metric values even if the card status looks ready',()=>{
  for(const date of ['2025-10-29','2026-11-01']){const {card,price}=cards();card.points.at(-1)!.date=date;expect(buildReferenceBasis('pe',card,price,'etf',now).status).toBe('unavailable');}
 });
 it('requires a recent valid market price rather than a stale or missing last close',()=>{
  const {card,price}=cards();price.points=[{date:'2026-10-01',value:'4',quality:'valid'}];expect(buildReferenceBasis('pe',card,price,'etf',now).status).toBe('unavailable');
  price.points.push({date:'2026-10-30',value:null,quality:'missing'});expect(buildReferenceBasis('pe',card,price,'etf',now).status).toBe('unavailable');
 });
 it('uses a five year fallback but never calls a short archive ten years',()=>{
  const {card,price}=cards();card.points=card.points.slice(60);
  expect(buildReferenceBasis('pe',card,price,'etf',now)).toMatchObject({status:'conditional',years:5,months:60});
  card.points=card.points.slice(10);expect(buildReferenceBasis('pe',card,price,'etf',now).status).toBe('unavailable');
 });
 it('allows a labelled shorter REIT yield scenario but never REIT PE or PB',()=>{
  const {card,price}=cards();card.points=card.points.slice(85);
  expect(buildReferenceBasis('dividendYield',card,price,'reit',now)).toMatchObject({status:'conditional',years:5,months:35});
  expect(buildReferenceBasis('pe',card,price,'reit',now).status).toBe('unavailable');
 });
 it('counts verified zero REIT months in its history instead of treating them as missing',()=>{
  const {card,price}=cards();card.points=card.points.slice(85).map((row,i)=>({...row,value:i%2===0?'0':row.value}));card.points.at(-1)!.value='20';
  expect(buildReferenceBasis('dividendYield',card,price,'reit',now)).toMatchObject({status:'conditional',months:35});
 });
 it('reports archived provenance and refuses unsupported cards and unknown kinds',()=>{
  const {card,price}=cards();card.checkedAt=null;
  expect(buildReferenceBasis('pe',card,price,'etf',now).warnings.join('')).toContain('缓存');
  card.availability='unsupported';expect(buildReferenceBasis('pe',card,price,'etf',now).status).toBe('unavailable');
  expect(buildReferenceBasis('pe',card,price,null,now).status).toBe('unavailable');
 });
});
