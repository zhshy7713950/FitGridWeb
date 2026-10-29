import {valuationRoute} from '@/server/valuation/http';
export function POST(request:Request,context:{params:Promise<{id:string}>}){return valuationRoute(request,context,true);}
