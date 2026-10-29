import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {resolveValuationProduct} from '../../src/server/valuation/catalog';
import {parseSeries} from '../../src/server/valuation/sources';
const base='/Users/zhangshiyao/IntelliJIDEAProjects/FitGridWeb/output/etf-valuation-research-2026-10-28';
const audit:Array<{file:string;sha256:string}>=JSON.parse(await readFile(`${base}/history-audit/input-manifest.json`,'utf8'));
const captures:Array<{file:string;sha256:string}>=JSON.parse(await readFile(`${base}/capture-manifest.json`,'utf8'));
const stored:Record<string,unknown>={},manifest:unknown[]=[];
for(const [code,metric,file,compressed] of [
 ['510880','pe','csi-perf-000015.json.gz',true],['510300','pe','csi-perf-000300.json.gz',true],['510500','pe','csi-perf-000905.json.gz',true],
 ['510880','pb','legu-month-000015-pb.json.gz',true],['510300','pb','legu-month-000300-pb.json.gz',true],['510500','pb','legu-month-000905-pb.json.gz',true],
 ['159920','pe','legu-hsi.json.gz',true],['VOO','pe','legu-sp500-history.raw',false],['161130','pe','legu-ndx-history.raw',false],
] as const){
 const path=compressed?`${base}/history-audit/raw/${file}`:`/private/tmp/fitgrid-valuation-research/${file}`;
 const bytes=await readFile(path),hash=createHash('sha256').update(bytes).digest('hex');
 const expected=(compressed?audit:captures).find(r=>r.file===file)?.sha256;
 if(hash!==expected)throw new Error(`Archive hash mismatch: ${file}`);
 const definition=resolveValuationProduct(code)!.series[metric]!;
 const observations=parseSeries(definition,JSON.parse((compressed?gunzipSync(bytes):bytes).toString()),'2026-10-27');
 stored[definition.key]=observations;manifest.push({seriesKey:definition.key,sourceFile:file,sha256:hash,capturedAt:'2026-10-28',cutoff:'2026-10-27',count:observations.length});
}
await mkdir('src/server/valuation/fixtures',{recursive:true});
await writeFile('src/server/valuation/archive-data.json',JSON.stringify(stored)+'\n');
await writeFile('src/server/valuation/archive-manifest.json',JSON.stringify(manifest,null,2)+'\n');
console.log(manifest);
