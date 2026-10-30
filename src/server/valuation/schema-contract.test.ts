import {readFileSync} from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {parse} from 'yaml';
import {describe,expect,it} from 'vitest';
import {demoValuation} from '@/features/valuation/demo-valuation-data';
const document=parse(readFileSync('docs/fit-replication/contracts/openapi.yaml','utf8'));
const ajv=new Ajv2020({strict:false,allErrors:true});addFormats(ajv);
const validate=ajv.compile({$ref:'#/components/schemas/ValuationPageData',components:document.components});
describe('valuation response contract',()=>{
 it.each(['etf','reit'])('accepts actual %s response fields including P50 and nullable yield',kind=>{
  const data=demoValuation(kind==='reit'?'demo-reit-508000':'grid');data.product.id='00000000-0000-4000-8000-000000000001';
  expect(validate(data),JSON.stringify(validate.errors)).toBe(true);
 });
 it('rejects missing median statistics or a REIT yield with missing provenance',()=>{
  const data=demoValuation('grid');data.product.id='00000000-0000-4000-8000-000000000001';
  const {p50:ignored,...stats}=data.pe.stats;void ignored;
  expect(validate({...data,pe:{...data.pe,stats}})).toBe(false);
  const reit=demoValuation('demo-reit-508000');reit.product.id=data.product.id;
  const {distributionAsOf:missing,...yieldWithoutProvenance}=reit.dividendYield!;void missing;
  expect(validate({...reit,dividendYield:yieldWithoutProvenance})).toBe(false);
 });
});
