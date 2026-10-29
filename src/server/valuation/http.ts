import {z} from 'zod';
import {requireSession} from '@/server/auth/session';
import {apiHandler,json,parseJsonBody} from '@/server/http/route-factory';
import {getRuntimeServices} from '@/server/runtime/services';
import {ownerMutationRequests} from '@/server/security/request-protection';
import {assertMaintenanceAvailable} from '@/server/maintenance/http';
type Context={params:Promise<{id:string}>};
const input=z.strictObject({mode:z.enum(['due','manual'])});
export async function valuationRoute(request:Request,context:Context,refresh=false):Promise<Response>{
 const response=await apiHandler(request,async({requestId})=>{
  const services=getRuntimeServices(),owner=await requireSession(request.headers,services.auth);
  const id=z.uuid().parse((await context.params).id);
  if(!refresh)return json(await services.valuation.read(owner.id,id),200,requestId);
  assertMaintenanceAvailable(await services.maintenance.getMaintenanceMode());
  ownerMutationRequests.consume(owner.id);
  const body=input.parse(await parseJsonBody(request));
  return json(await services.valuation.refresh(owner.id,id,body.mode,request.signal),200,requestId);
 });
 response.headers.set('cache-control','no-store, private');return response;
}
