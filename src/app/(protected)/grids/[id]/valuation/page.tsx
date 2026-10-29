import {ValuationPage} from '@/features/valuation/valuation-page';
export default async function GridValuationPage({params}:{params:Promise<{id:string}>}){return <ValuationPage id={(await params).id}/>;}
