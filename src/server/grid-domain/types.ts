export type DecimalString = string;
export type AlgorithmVersion = "android-v2.1.0";
export type GridType = 1 | 2 | 3;

export interface GridTradeInput {
  productName: string | null;
  productCode: string;
  maxPrice: DecimalString;
  minTradeQuantity: DecimalString;
  gearAmplitude: DecimalString;
  perShare: DecimalString;
  keepShare: number;
  increaseAmplitude: number;
  mediumAmplitude: number | null;
  bigAmplitude: number | null;
  maxAmplitude: number;
  isShort: boolean;
  category: string | null;
  sortOrder: number;
  algorithmVersion: AlgorithmVersion;
}

export interface GridItemResult {
  sequence: number;
  gridType: GridType;
  gear: DecimalString;
  buyPrice: DecimalString;
  buyCount: DecimalString;
  buyAmount: DecimalString;
  sellPrice: DecimalString;
  sellCount: DecimalString;
  sellAmount: DecimalString;
  profitAmount: DecimalString;
  profitRate: DecimalString;
  keepProfit: DecimalString;
  keepCount: DecimalString;
}

export interface GridCalculationResult {
  items: GridItemResult[];
  totalBuyAmount: DecimalString;
  totalProfitAmount: DecimalString;
  totalProfitRate: DecimalString;
}
