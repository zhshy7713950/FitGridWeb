import {afterEach,describe,expect,it,vi} from 'vitest';
import {getValuation,refreshValuation} from './valuation-api';
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
describe('valuation client requests',()=>{
 it('uses the configured base path and explicit refresh mode',async()=>{
  vi.stubEnv('NEXT_PUBLIC_APP_BASE_PATH','/fitgrid');const f=vi.fn<typeof fetch>(async()=>Response.json({price:{availability:'empty'}}));vi.stubGlobal('fetch',f);
  await getValuation('one');expect(f.mock.calls[0][0]).toBe('/fitgrid/api/v1/grid-trades/one/valuation');
  await refreshValuation('one','manual');expect(f.mock.calls[1][1]).toMatchObject({method:'POST',body:'{"mode":"manual"}'});
 });
 it('propagates request IDs and cooldown errors',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({code:'VALUATION_COOLDOWN',message:'稍后重试',requestId:'rid'},{status:429,headers:{'retry-after':'60'}})));
  await expect(refreshValuation('one','manual')).rejects.toMatchObject({status:429,requestId:'rid',retryAfterSeconds:60});
 });
});
