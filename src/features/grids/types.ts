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
