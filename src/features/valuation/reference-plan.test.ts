import {describe,expect,it} from 'vitest';
import Decimal from 'decimal.js';
import {spawnSync} from 'node:child_process';
import {calculateReferencePlan} from './reference-plan';
import type {GridTradeInput} from '@/server/grid-domain/types';
const grid:GridTradeInput={productCode:'510880',productName:null,maxPrice:'3.16',minTradeQuantity:'10',gearAmplitude:'5',perShare:'8000',keepShare:10,increaseAmplitude:8,mediumAmplitude:null,bigAmplitude:null,maxAmplitude:1,isShort:false,category:null,sortOrder:0,algorithmVersion:'android-v2.1.0'};
const options={budget:'105',feeRate:'0',minimumFee:'5',increase:5};
describe('read-only reference budget inversion',()=>{
 it('rejects overflowing add-on combinations before entering the legacy engine',()=>{
  const input={...grid,gearAmplitude:'0.5',maxAmplitude:99,minTradeQuantity:'100'};
  const script=`import {calculateReferencePlan} from './src/features/valuation/reference-plan.ts';try{calculateReferencePlan(${JSON.stringify(input)},'3',${JSON.stringify({...options,budget:'100000',increase:100})});}catch(e){console.log(e.message);}`;
  const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{timeout:2000,encoding:'utf8'});
  expect(child.status).toBe(0);expect(child.stdout).toMatch(/数值范围/);
 });
 it('uses exact price times quantity rather than float32 row amounts at a large budget',()=>{
  const r=calculateReferencePlan({...grid,minTradeQuantity:'1'},'3.001',{budget:'100000000',feeRate:'0',minimumFee:'0',increase:0});
  const actual=new Decimal('3.001').mul(r.firstCount).toDecimalPlaces(2);
  expect(actual.lte('100000000')).toBe(true);expect(r.firstAmount).toBe(actual.toString());expect(r.buyAmount).toBe(actual.toString());
 });
 it('accounts for lot rounding and minimum fees without changing the saved grid',()=>{
  const original=structuredClone(grid);const r=calculateReferencePlan(grid,'2',options);
  expect(r).toMatchObject({firstAmount:'100',firstCount:'50',buyAmount:'100',fees:'5',remaining:'0',lowestPrice:'2',orderCount:1});
  expect(grid).toEqual(original);
  expect(r.pressure.find(x=>x.drop===40)).toMatchObject({price:'1.2',cash:'0',quantity:'50',averageCost:'2.1',loss:'45'});
 });
 it('includes overlapping small medium and large orders and fees in the budget cap',()=>{
  const r=calculateReferencePlan({...grid,gearAmplitude:'3',mediumAmplitude:10,bigAmplitude:20,maxAmplitude:40,minTradeQuantity:'100'},'2.32',{...options,budget:'100000',feeRate:'0.03'});
  expect(r.orderCount).toBe(20);expect(r.lowestPrice).toBe('1.392');
  expect(new Decimal(r.buyAmount).plus(r.fees).lte(100000)).toBe(true);
  expect(r.pressure.every(p=>new Decimal(p.buyAmount).plus(p.fees).plus(p.cash).equals(100000))).toBe(true);
 });
 it('rounds percentage fees up to currency cents and accepts fractional trade units',()=>{
  const r=calculateReferencePlan({...grid,minTradeQuantity:'0.1'},'2',{budget:'100',feeRate:'0.333',minimumFee:'0',increase:0});
  expect(new Decimal(r.buyAmount).plus(r.fees).lte(100)).toBe(true);expect(r.fees).toBe('0.34');
 });
 it.each(['','0','-1','NaN','Infinity','1e5','100000001','10.001'])('rejects invalid or unsupported budget %s',budget=>{
  expect(()=>calculateReferencePlan(grid,'2',{...options,budget})).toThrow();
 });
 it('rejects insufficient budgets, short strategies and excessive or zero-price grids',()=>{
  expect(()=>calculateReferencePlan({...grid,minTradeQuantity:'100'},'2',{...options,budget:'10'})).toThrow(/预算/);
  expect(()=>calculateReferencePlan({...grid,isShort:true},'2',options)).toThrow(/做多/);
  expect(()=>calculateReferencePlan({...grid,maxAmplitude:100},'2',options)).toThrow(/零|价格/);
  expect(()=>calculateReferencePlan({...grid,gearAmplitude:'0.001'},'2',options)).toThrow(/200/);
 });
 it('rejects malformed fees, unsafe add-ons and zero or sub-tick starts',()=>{
  for(const feeRate of ['-1','NaN','101'])expect(()=>calculateReferencePlan(grid,'2',{...options,feeRate})).toThrow();
  for(const increase of [NaN,1.5,101,-1])expect(()=>calculateReferencePlan(grid,'2',{...options,increase})).toThrow();
  for(const price of ['0','0.0001','Infinity'])expect(()=>calculateReferencePlan(grid,price,options)).toThrow();
 });
});
