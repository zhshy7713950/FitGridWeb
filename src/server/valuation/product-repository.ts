import type {PrismaClient} from '@/generated/prisma/client';
import {resolveInstrument,fetchText,fetchJson} from '@/server/price-alerts/market-data';
import {asInstrument,AlertRepository} from '@/server/price-alerts/repository';
import {resolveValuationProduct} from './catalog';
import {buildValuationProduct,parseFundProfile,parseDomesticFundProfile,type ProductIdentity,type FundProfile} from './product-discovery';
import type {ValuationProduct} from './types';

interface SavedProfile {product:ValuationProduct;evidence:string;evidenceUrl:string|null;checkedAt:string;retryAt:string|null}
export interface ProductProfileStore {read(code:string):Promise<SavedProfile|null>;save(profile:SavedProfile):Promise<void>}
export class PrismaProductProfileStore implements ProductProfileStore {
 constructor(private readonly db:PrismaClient){}
 async read(code:string):Promise<SavedProfile|null>{
  const rows=await this.db.$queryRaw<Array<{product:ValuationProduct;evidence:string;evidence_url:string|null;checked_at:Date;retry_at:Date|null}>>`SELECT product,evidence,evidence_url,checked_at,retry_at FROM research_products WHERE code=${code}`;
  const row=rows[0];return row?{product:row.product,evidence:row.evidence,evidenceUrl:row.evidence_url,checkedAt:row.checked_at.toISOString(),retryAt:row.retry_at?.toISOString()??null}:null;
 }
 async save(p:SavedProfile){
  await this.db.$executeRaw`INSERT INTO research_products(code,product,evidence,evidence_url,checked_at,retry_at)
   VALUES (${p.product.code},${JSON.stringify(p.product)}::jsonb,${p.evidence},${p.evidenceUrl},${new Date(p.checkedAt)},${p.retryAt?new Date(p.retryAt):null})
   ON CONFLICT (code) DO UPDATE SET product=excluded.product,evidence=excluded.evidence,evidence_url=excluded.evidence_url,checked_at=excluded.checked_at,retry_at=excluded.retry_at`;
 }
}
function canonicalCode(raw:string):string|null {
 const code=raw.trim().toUpperCase();
 if(/^(?:[56]\d{5}\.SH|[013]\d{5}\.SZ|[A-Z][A-Z0-9.-]{0,14}\.US)$/.test(code))return code;
 if(/^[56]\d{5}$/.test(code))return `${code}.SH`;
 if(/^[013]\d{5}$/.test(code))return `${code}.SZ`;
 if(/^[A-Z][A-Z0-9.-]{0,14}$/.test(code)&&!code.includes('.'))return `${code}.US`;
 return null;
}
interface Dependencies {
 store:ProductProfileStore;find(code:string):Promise<ProductIdentity|null>;
 resolve(market:'cn'|'us',code:string):Promise<ProductIdentity>;
 metadata(identity:ProductIdentity):Promise<FundProfile>;
 clock?:()=>Date;
}
export class ProductRegistry {
 constructor(private readonly deps:Dependencies){}
 async read(raw:string):Promise<ValuationProduct|null>{
  const code=canonicalCode(raw);if(!code)return null;
  const saved=await this.deps.store.read(code);if(saved)return saved.product;
  const reviewed=resolveValuationProduct(code);if(reviewed)return reviewed;
  const identity=await this.deps.find(code);return identity?buildValuationProduct(identity,null):null;
 }
 async refresh(raw:string):Promise<ValuationProduct|null>{
  const code=canonicalCode(raw);if(!code)return null;
  const now=this.deps.clock?.()??new Date(),saved=await this.deps.store.read(code);
  if(saved&&(saved.retryAt?Date.parse(saved.retryAt)>+now:+now-Date.parse(saved.checkedAt)<7*86400000))return saved.product;
  const reviewed=resolveValuationProduct(code);
  let product=reviewed??saved?.product??null,evidence=saved?.evidence??'',evidenceUrl=saved?.evidenceUrl??null,retryAt:string|null=null;
  if(!reviewed){
   try {
    const identity=await this.deps.find(code)??await this.deps.resolve(code.endsWith('.US')?'us':'cn',code);
    product=product??buildValuationProduct(identity,null);
    if(identity.kind!=='stock'&&identity.kind!=='reit'){
     const profile=await this.deps.metadata(identity);
     product=buildValuationProduct(identity,profile);evidence=profile.evidence;
     evidenceUrl=profile.evidenceUrl??(identity.market==='cn'?`https://fundf10.eastmoney.com/jbgk_${code.slice(0,6)}.html`:`https://finance.yahoo.com/quote/${encodeURIComponent(code.slice(0,-3))}/profile/`);
     if(!profile.benchmark)retryAt=new Date(+now+86400000).toISOString();
    }else product=buildValuationProduct(identity,null);
   }catch{
    if(!product)return null;
    const notice='产品资料匹配失败，稍后自动重试；已确认的价格和历史仍可查看。';
    product={...product,note:product.note?.includes(notice)?product.note:[product.note,notice].filter(Boolean).join(' ')};
    retryAt=new Date(+now+15*60000).toISOString();
   }
  }
  if(product)await this.deps.store.save({product,evidence,evidenceUrl,checkedAt:now.toISOString(),retryAt});
  return product;
 }
}
export function createProductRegistry(db:PrismaClient,beforeRequest:()=>Promise<void>){
 const instruments=new AlertRepository(db);
 return new ProductRegistry({store:new PrismaProductProfileStore(db),
  find:async code=>{const row=await db.marketInstrument.findUnique({where:{code}});return row?asInstrument(row):null;},
  resolve:async(market,code)=>instruments.saveInstrument(await resolveInstrument(market,code,{beforeRequest})).then(asInstrument),
  metadata:async identity=>{
   if(identity.market==='cn'){
    const url=`https://fundmobapi.eastmoney.com/FundMNewApi/FundMNDetailInformation?FCODE=${identity.code.slice(0,6)}&deviceid=fitgrid&plat=Android&product=EFund&version=6.6.8`;
    try{return {...parseDomesticFundProfile(identity.code,await fetchJson(url,{beforeRequest,timeoutMs:6000})),evidenceUrl:url};}
    catch{/* The public HTML profile remains useful when the mobile endpoint is unavailable. */}
   }
   const url=identity.market==='cn'?`https://fundf10.eastmoney.com/jbgk_${identity.code.slice(0,6)}.html`:`https://finance.yahoo.com/quote/${encodeURIComponent(identity.code.slice(0,-3))}/`;
   return {...parseFundProfile(identity.market,identity.code,await fetchText(url,{beforeRequest,timeoutMs:6000})),evidenceUrl:url};
  }});
}
