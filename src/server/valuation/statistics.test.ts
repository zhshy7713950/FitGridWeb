import {describe,expect,it} from 'vitest';
import type {Observation} from './types';
import {summarizeValuation,buildPriceHistory} from './statistics';
const points=(values:Array<number|null>):Observation[]=>values.map((n,i)=>({date:new Date(Date.UTC(2020,0,1+i)).toISOString().slice(0,10),value:n===null?null:String(n),quality:n===null?'missing':n>0?'valid':'non_positive'}));
describe('valuation statistics',()=>{
 it('ranks current against prior valid samples and interpolates quantiles over all values',()=>{
  expect(summarizeValuation(points([10,20,30,20]))).toMatchObject({min:'10',max:'30',p30:'19',p70:'21',currentValue:'20',currentPercentile:'50',referenceCount:3,validCount:4});
  expect(summarizeValuation(points([10,10,10]))).toMatchObject({currentPercentile:'50',p30:'10',p70:'10'});
 });
 it('does not turn sparse or negative samples into zero-valued valuations',()=>{
  expect(summarizeValuation([])).toMatchObject({min:null,p30:null,currentPercentile:null,validCount:0});
  expect(summarizeValuation(points([7]))).toMatchObject({min:'7',max:'7',p30:null,currentPercentile:null});
  expect(summarizeValuation(points([10,20]))).toMatchObject({p30:'13',p70:'17',currentPercentile:null});
  expect(summarizeValuation(points([10,20,30,-2]))).toMatchObject({currentValue:null,currentPercentile:null,min:'10',max:'30',latestValidDate:'2020-01-03',latestDate:'2020-01-04'});
  expect(summarizeValuation(points([0,null,-3]))).toMatchObject({validCount:0,currentValue:null});
 });
 it('does not alter source values or discard valid extremes',()=>{
  const input=points([10,20,1000000]);const before=JSON.stringify(input);
  expect(summarizeValuation(input).max).toBe('1000000');expect(JSON.stringify(input)).toBe(before);
 });
});
describe('completed-close moving averages',()=>{
 it('includes the latest close and requires 250 and 500 observations respectively',()=>{
  const input=points(Array.from({length:500},(_,i)=>i+1));
  const history=buildPriceHistory(input);
  expect(history.at(-1)).toMatchObject({close:'500',ma250:'375.5',ma500:'250.5'});
  expect(history[248].ma250).toBeNull();expect(history[498].ma500).toBeNull();
 });
 it('does not bridge known gaps or invalid prices when counting an N-day average',()=>{
  const input=points([...Array(250).fill(10),null,...Array(249).fill(20)]);
  expect(buildPriceHistory(input).at(-1)?.ma250).toBeNull();
  input.push({date:'2022-01-01',value:'20',quality:'valid'});
  expect(buildPriceHistory(input).at(-1)?.ma250).toBe('20');
 });
 it('rejects duplicate or unordered dates instead of counting them twice',()=>{
  const input=points([1,2]);expect(()=>buildPriceHistory([...input,input[1]])).toThrow();
 });
});
