import {beforeEach,describe,expect,it,vi} from 'vitest';
import {ProductRegistry,type ProductProfileStore} from './product-repository';
import type {ProductIdentity} from './product-discovery';

const identity:ProductIdentity={code:'QQQ.US',name:'Invesco QQQ Trust',market:'us',currency:'USD',kind:'etf',tencent:null,yahoo:'QQQ',eastmoney:null};
const profiles=new Map();
const find=vi.fn(),resolve=vi.fn(),metadata=vi.fn();
const store:ProductProfileStore={read:async c=>profiles.get(c)??null,save:async p=>{profiles.set(p.product.code,structuredClone(p));}};
const registry=()=>new ProductRegistry({store,find,resolve,metadata,clock:()=>new Date('2026-11-09T02:00:00Z')});
beforeEach(()=>{profiles.clear();vi.resetAllMocks();find.mockResolvedValue(identity);resolve.mockResolvedValue(identity);metadata.mockResolvedValue({benchmark:{id:'NDX',name:'纳斯达克100'},evidence:'Explicit fund benchmark',note:null});});
describe('persistent product discovery',()=>{
 it('reads a verified uncatalogued instrument locally without fetching or saving',async()=>{
  const p=await registry().read('QQQ');expect(p?.series.price?.symbol).toBe('QQQ');expect(p?.benchmark).toBeNull();
  expect(metadata).not.toHaveBeenCalled();expect(resolve).not.toHaveBeenCalled();expect(profiles.size).toBe(0);
 });
 it('persists a discovered mapping and reuses it across independent registry instances',async()=>{
  const p=await registry().refresh('QQQ');expect(p?.benchmark?.id).toBe('NDX');
  find.mockRejectedValue(new Error('must use saved mapping'));
  expect((await registry().read('QQQ.US'))?.series.pe?.key).toBe('NDX:pe:legu:monthly:v1:raw');
  expect((await registry().refresh('QQQ'))?.benchmark?.id).toBe('NDX');expect(metadata).toHaveBeenCalledTimes(1);
 });
 it('still returns prices on metadata errors and backs off retries across instances',async()=>{
  metadata.mockRejectedValue(new Error('HTTP 403'));
  const p=await registry().refresh('QQQ');expect(p?.series.price?.symbol).toBe('QQQ');expect(p?.note).toContain('失败');
  await registry().refresh('QQQ.US');expect(metadata).toHaveBeenCalledTimes(1);
 });
 it('verifies legacy raw symbols only on refresh and ignores invalid legacy text',async()=>{
  find.mockResolvedValue(null);expect(await registry().read('QQQ')).toBeNull();expect(resolve).not.toHaveBeenCalled();
  expect((await registry().refresh('QQQ'))?.code).toBe('QQQ.US');expect(resolve).toHaveBeenCalledWith('us','QQQ.US');
  expect(await registry().refresh('任意文本')).toBeNull();
 });
 it('retains reviewed legacy mappings without network discovery',async()=>{
  expect((await registry().refresh('510880'))?.benchmark?.id).toBe('000015');
  expect(metadata).not.toHaveBeenCalled();expect(resolve).not.toHaveBeenCalled();
 });
 it('preserves verified mappings on repeated metadata failures without growing the notice',async()=>{
  await registry().refresh('QQQ');
  const saved=profiles.get('QQQ.US');saved.checkedAt='2026-10-01T02:00:00Z';
  metadata.mockRejectedValue(new Error('unavailable'));
  const first=await registry().refresh('QQQ');
  expect(first?.benchmark?.id).toBe('NDX');expect(first?.series.pe).not.toBeNull();
  profiles.get('QQQ.US').retryAt='2026-11-08T02:00:00Z';
  expect((await registry().refresh('QQQ'))?.note).toBe(first?.note);
 });
});
