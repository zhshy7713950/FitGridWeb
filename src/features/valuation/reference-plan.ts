import {PriceDecimal as Decimal} from '@/server/price-alerts/decimal';
import {calculateGrid} from '@/server/grid-domain/calculate-grid';
import {validateGridInput} from '@/server/grid-domain/validation';
import type {GridTradeInput} from '@/server/grid-domain/types';

export interface ReferenceOptions {budget:string;feeRate:string;minimumFee:string;increase:number}
export interface ReferencePressure {drop:number;price:string;quantity:string;buyAmount:string;fees:string;cash:string;averageCost:string|null;loss:string}
export interface ReferencePlan {
 baseAmount:string;firstAmount:string;firstCount:string;buyAmount:string;fees:string;remaining:string;
 orderCount:number;lowestPrice:string;pressure:ReferencePressure[];
}
function amount(value:string,name:string,maximum='100000000',digits=2){
 if(!new RegExp(`^(0|[1-9]\\d*)(\\.\\d{1,${digits}})?$`).test(value))throw new Error(name+`须为最多${digits}位小数的非负数。`);
 const result=new Decimal(value);if(result.gt(maximum))throw new Error(name+'超出参考计算范围。');return result;
}
/** Uses the unchanged Android-compatible engine, then checks exact row costs and fee assumptions. */
export function calculateReferencePlan(saved:GridTradeInput,startPrice:string,options:ReferenceOptions):ReferencePlan {
 const budget=amount(options.budget,'预算'),rate=amount(options.feeRate,'费用率','100',4).div(100),minimum=amount(options.minimumFee,'最低费用');
 if(!budget.gt(0))throw new Error('预算必须大于零。');
 if(saved.isShort)throw new Error('参考方案仅支持从零持仓做多。');
 if(!Number.isInteger(options.increase)||options.increase<0||options.increase>100)throw new Error('候选加码须为0～100的整数。');
 if(!/^\d+(\.\d{1,3})?$/.test(startPrice)||!new Decimal(startPrice).gt(0))throw new Error('启动价格必须大于零，且符合三位小数精度。');
 const base=validateGridInput({...saved,maxPrice:startPrice,increaseAmplitude:options.increase});
 const size=new Decimal(base.maxAmplitude).div(base.gearAmplitude).floor().plus(1).plus(base.mediumAmplitude?Math.floor(base.maxAmplitude/base.mediumAmplitude):0).plus(base.bigAmplitude?Math.floor(base.maxAmplitude/base.bigAmplitude):0);
 if(size.gt(200))throw new Error('参考计算最多支持200档，已有网格不受此限制。');
 if(base.maxAmplitude>=100)throw new Error('覆盖至零价格的网格无法提供参考方案。');
 const priceLow=new Decimal(startPrice).mul(new Decimal(1).minus(new Decimal(base.maxAmplitude).div(100))).toDecimalPlaces(3,Decimal.ROUND_FLOOR);
 if(!priceLow.gt(0))throw new Error('覆盖下限低于现有网格价格精度。');
 // Bound every float32 path before calling the unchanged engine, including retained shares.
 const priceHigh=new Decimal(startPrice).mul(2).plus(1),unit=new Decimal(base.minTradeQuantity);
 const budgetHigh=budget.mul(new Decimal(1).plus(new Decimal(options.increase).div(100)).pow(size.toNumber())).mul(2);
 const quantityHigh=budgetHigh.div(priceLow).plus(unit),grossHigh=quantityHigh.mul(priceHigh);
 const retainedQuantity=grossHigh.mul(Decimal.max(1,base.keepShare)).div(priceLow).plus(unit);
 const magnitude=Decimal.max(budgetHigh,quantityHigh,grossHigh,retainedQuantity,retainedQuantity.div(unit),quantityHigh.div(unit),Decimal.max(retainedQuantity,quantityHigh).mul(priceHigh).mul(size));
 if(!magnitude.isFinite()||magnitude.gt('1e30'))throw new Error('参数组合超出参考计算数值范围，请缩小覆盖或加码幅度。');
 const fee=(value:InstanceType<typeof Decimal>)=>value.gt(0)?Decimal.max(minimum,value.mul(rate)).toDecimalPlaces(2,Decimal.ROUND_CEIL):new Decimal(0);
 function evaluate(cents:number){
  const calculated=calculateGrid({...base,perShare:new Decimal(cents).div(100).toString()}).items;
  const rows=calculated.map(row=>({...row,buyAmount:new Decimal(row.buyPrice).mul(row.buyCount).toDecimalPlaces(2).toString()}));
  if(rows.some(row=>!new Decimal(row.buyPrice).isFinite()||new Decimal(row.buyPrice).lte(0)||!new Decimal(row.buyCount).isFinite()||!new Decimal(row.buyAmount).isFinite()))throw new Error('价格或数量无法形成有效参考网格。');
  const buy=rows.reduce((sum,row)=>sum.plus(row.buyAmount),new Decimal(0));
  const fees=rows.reduce((sum,row)=>sum.plus(fee(new Decimal(row.buyAmount))),new Decimal(0));
  return {rows,buy,fees,cost:buy.plus(fees)};
 }
 let low=0,high=budget.mul(100).floor().toNumber();
 while(low<high){const mid=Math.ceil((low+high)/2);if(evaluate(mid).cost.lte(budget))low=mid;else high=mid-1;}
 if(!low)throw new Error('预算不足以覆盖最小交易单位与费用。');
 const result=evaluate(low);
 if(result.rows.some(row=>new Decimal(row.buyCount).lte(0))||result.cost.gt(budget))throw new Error('预算不足以使每个档位满足最小交易数量。');
 const pressure=[20,40,60,80].map(drop=>{
  const price=new Decimal(startPrice).mul(new Decimal(1).minus(new Decimal(drop).div(100)));
  const rows=result.rows.filter(row=>new Decimal(row.buyPrice).gte(price));
  const quantity=rows.reduce((sum,row)=>sum.plus(row.buyCount),new Decimal(0));
  const buy=rows.reduce((sum,row)=>sum.plus(row.buyAmount),new Decimal(0));
  const fees=rows.reduce((sum,row)=>sum.plus(fee(new Decimal(row.buyAmount))),new Decimal(0));
  return {drop,price:price.toString(),quantity:quantity.toString(),buyAmount:buy.toString(),fees:fees.toString(),cash:budget.minus(buy).minus(fees).toString(),averageCost:quantity.gt(0)?buy.plus(fees).div(quantity).toDecimalPlaces(6).toString():null,loss:buy.plus(fees).minus(quantity.mul(price)).toDecimalPlaces(2).toString()};
 });
 return {baseAmount:new Decimal(low).div(100).toString(),firstAmount:result.rows[0].buyAmount,firstCount:result.rows[0].buyCount,buyAmount:result.buy.toString(),fees:result.fees.toString(),remaining:budget.minus(result.cost).toString(),orderCount:result.rows.length,lowestPrice:result.rows.at(-1)!.buyPrice,pressure};
}
