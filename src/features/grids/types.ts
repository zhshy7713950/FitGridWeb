export interface GridTradeSummary {
  id: string;
  productName: string | null;
  productCode: string;
  maxPrice: string;
  perShare: string;
  isShort: boolean;
  algorithmVersion: "android-v2.1.0";
  createdAt: string;
  updatedAt: string;
}

export interface GridTradePage {
  items: GridTradeSummary[];
  nextCursor: string | null;
}

export interface GridTradeMutationInput {
  productName: string | null;
  productCode: string;
  maxPrice: string;
  minTradeQuantity: string;
  gearAmplitude: string;
  perShare: string;
  keepShare: number;
  increaseAmplitude: number;
  mediumAmplitude: number | null;
  bigAmplitude: number | null;
  maxAmplitude: number;
  isShort: boolean;
  category: string | null;
  sortOrder: number;
}

export interface GridItem {
  sequence: number;
  gridType: 1 | 2 | 3;
  gear: string;
  buyPrice: string;
  buyCount: string;
  buyAmount: string;
  sellPrice: string;
  sellCount: string;
  sellAmount: string;
  profitAmount: string;
  profitRate: string;
  keepProfit: string;
  keepCount: string;
}

export interface GridTradeDetail extends GridTradeSummary {
  input: GridTradeMutationInput & { algorithmVersion: "android-v2.1.0" };
  calculation: {
    items: GridItem[];
    totalBuyAmount: string;
    totalProfitAmount: string;
    totalProfitRate: string;
  };
}
