import {beforeEach,describe,expect,it,vi} from 'vitest';
import {ApiError} from '@/server/http/api-error';
import {GET} from '@/app/api/v1/grid-trades/[id]/valuation/route';
import {POST} from '@/app/api/v1/grid-trades/[id]/valuation/refresh/route';
const ctx=vi.hoisted(()=>({signed:true,maintenance:false,read:vi.fn(),refresh:vi.fn()}));
vi.mock('@/server/runtime/services',()=>({getRuntimeServices:()=>({
 auth:{api:{getSession:async()=>ctx.signed?{user:{id:'d8011707-1a97-4c0a-94f4-49cac040261e',name:'test',role:'member',status:'active'}}:null}},
 maintenance:{getMaintenanceMode:async()=>({active:ctx.maintenance})},valuation:{read:ctx.read,refresh:ctx.refresh}
})}));
const id='fe5814da-aa50-4206-8a47-fc61638b949b',context={params:Promise.resolve({id})};
function req(method='GET',body?:unknown,origin='https://test.invalid'){return new Request('https://test.invalid/api/v1/grid-trades/'+id+'/valuation',{method,headers:{host:'test.invalid',origin,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});}
beforeEach(()=>{vi.clearAllMocks();ctx.signed=true;ctx.maintenance=false;ctx.read.mockResolvedValue({price:{availability:'empty'}});ctx.refresh.mockResolvedValue({price:{availability:'ready'},pb:{availability:'error'}});});
describe('valuation HTTP permissions and boundaries',()=>{
 it('requires a session and delegates the verified owner identity',async()=>{
  ctx.signed=false;expect((await GET(req(),context)).status).toBe(401);expect(ctx.read).not.toHaveBeenCalled();
  ctx.signed=true;const r=await GET(req(),context);expect(r.status).toBe(200);expect(ctx.read).toHaveBeenCalledWith('d8011707-1a97-4c0a-94f4-49cac040261e',id);expect(r.headers.get('cache-control')).toContain('private');expect(r.headers.get('x-request-id')).toBeTruthy();
 });
 it('returns the same 404 for missing or foreign-owned grids',async()=>{ctx.read.mockRejectedValue(new ApiError(404,'NOT_FOUND','网格产品不存在'));expect((await GET(req(),context)).status).toBe(404);});
 it('strictly accepts only due/manual and rejects untrusted overrides',async()=>{
  for(const body of [{mode:'x'},{mode:'manual',ownerId:'other'},{mode:'due',url:'https://evil.invalid'},{}])expect((await POST(req('POST',body),context)).status).toBe(422);
  expect(ctx.refresh).not.toHaveBeenCalled();
  const r=await POST(req('POST',{mode:'due'}),context);expect(r.status).toBe(200);expect(await r.json()).toMatchObject({pb:{availability:'error'}});
 });
 it('blocks cross-origin collection and maintenance writes while cached GET stays readable',async()=>{
  expect((await POST(req('POST',{mode:'manual'},'https://evil.invalid'),context)).status).toBe(403);
  ctx.maintenance=true;expect((await POST(req('POST',{mode:'manual'}),context)).status).toBe(503);expect((await GET(req(),context)).status).toBe(200);expect(ctx.refresh).not.toHaveBeenCalled();
 });
 it('validates IDs and preserves the cooldown retry header',async()=>{
  expect((await GET(req(),{params:Promise.resolve({id:'invalid'})})).status).toBe(422);
  ctx.refresh.mockRejectedValue(new ApiError(429,'VALUATION_COOLDOWN','稍后重试',undefined,{'retry-after':'60'}));
  const r=await POST(req('POST',{mode:'manual'}),context);expect(r.status).toBe(429);expect(r.headers.get('retry-after')).toBe('60');
 });
});
