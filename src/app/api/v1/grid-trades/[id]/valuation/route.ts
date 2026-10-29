import {valuationRoute} from '@/server/valuation/http';
export function GET(request:Request,context:{params:Promise<{id:string}>}){return valuationRoute(request,context);}
