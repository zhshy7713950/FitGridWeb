import {isUiDemoMode} from '@/lib/ui-demo';
import {requestJson} from '@/lib/api-client';
import type {ValuationPageData} from '@/server/valuation/types';
const loadDemo=process.env.NODE_ENV==='production'?null:()=>import('./demo-valuation-data');
export function getValuation(id:string,signal?:AbortSignal):Promise<ValuationPageData>{
 if(isUiDemoMode()&&loadDemo)return loadDemo().then(m=>m.demoValuation(id));
 return requestJson(`/grid-trades/${encodeURIComponent(id)}/valuation`,{signal});
}
export function refreshValuation(id:string,mode:'due'|'manual',signal?:AbortSignal):Promise<ValuationPageData>{
 if(isUiDemoMode()&&loadDemo)return loadDemo().then(m=>m.demoValuation(id));
 return requestJson(`/grid-trades/${encodeURIComponent(id)}/valuation/refresh`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode}),signal});
}
