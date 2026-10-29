import {writeFile} from 'node:fs/promises';
import {PRODUCTS} from '../../src/server/valuation/catalog';
import {fetchSeriesBatch,requestFor} from '../../src/server/valuation/sources';
const definitions=[...new Map(PRODUCTS.flatMap(p=>Object.values(p.series).filter(s=>s!==null)).map(s=>[s.key,s])).values()];
const results:Array<{key:string;checkedAt:string;status:'success'|'failed';url?:string;count?:number;first?:string;last?:string;error?:string}>=[];
for(let i=0;i<definitions.length;i+=2) {
 await Promise.allSettled(definitions.slice(i,i+2).map(async series=>{
 const from=series.frequency==='monthly'?'1900-01-01':'2026-09-01',to='2026-10-28';
 const checkedAt=new Date().toISOString();
 try {const b=await fetchSeriesBatch({series,from,to},{signal:AbortSignal.timeout(10000)}); results.push({key:series.key,url:requestFor(series,from,to).url.split('&token=')[0],checkedAt,status:'success',count:b.observations.length,first:b.observations[0]?.date,last:b.observations.at(-1)?.date});}
 catch(e){results.push({key:series.key,checkedAt,status:'failed',error:e instanceof Error?e.message:String(e)});}
 }));
}
await writeFile(new URL('./source-acceptance.json',import.meta.url),JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify({total:results.length,success:results.filter(r=>r.status==='success').length,failed:results.filter(r=>r.status==='failed').length}));
