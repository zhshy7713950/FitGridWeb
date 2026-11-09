import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {createIsolatedTestDatabase} from '@/test/isolated-database';
import {AlertRepository,asInstrument} from '@/server/price-alerts/repository';
import {PrismaProductProfileStore,ProductRegistry} from './product-repository';
import type {ProductIdentity} from './product-discovery';

describe.skipIf(!process.env.TEST_DATABASE_URL)('durable dynamic product profiles',()=>{
 const isolated=createIsolatedTestDatabase(),db=isolated.db;
 beforeAll(()=>isolated.setup());afterAll(()=>isolated.cleanup());
 it('persists a mapping across service instances and leaves GET entirely read-only',async()=>{
  const identity:ProductIdentity={code:'QQQ.US',name:'QQQ',market:'us',currency:'USD',kind:'etf',tencent:null,yahoo:'QQQ',eastmoney:null};
  const metadata=vi.fn(async()=>({benchmark:{id:'NDX',name:'纳斯达克100'},evidence:'Verified fund profile',note:null}));
  const find=async(code:string)=>{const row=await db.marketInstrument.findUnique({where:{code}});return row?asInstrument(row):null;};
  const resolve=vi.fn(async()=>identity);
  const make=()=>new ProductRegistry({store:new PrismaProductProfileStore(db),find,resolve,metadata});
  await new AlertRepository(db).saveInstrument(identity);
  expect((await make().read('QQQ'))?.benchmark).toBeNull();
  expect(await db.researchProduct.count()).toBe(0);expect(metadata).not.toHaveBeenCalled();expect(resolve).not.toHaveBeenCalled();
  await make().refresh('QQQ');
  const before=await db.researchProduct.findUniqueOrThrow({where:{code:'QQQ.US'}});
  expect((await make().read('QQQ.US'))?.series.pe?.key).toBe('NDX:pe:legu:monthly:v1:raw');
  await make().refresh('QQQ');expect(metadata).toHaveBeenCalledTimes(1);
  expect(await db.researchProduct.findUniqueOrThrow({where:{code:'QQQ.US'}})).toEqual(before);
 });
 it('migrates instrument kinds to support verified LOF and both REIT exchanges',async()=>{
  const repo=new AlertRepository(db);
  for(const [code,kind] of [['161130.SZ','lof'],['180101.SZ','reit'],['508001.SH','reit']] as const){
   const row=await repo.saveInstrument({code,name:code,kind,market:'cn',currency:'CNY',tencent:code.slice(-2).toLowerCase()+code.slice(0,6),yahoo:null,eastmoney:null});
   expect(row.kind).toBe(kind);
  }
 });
});
