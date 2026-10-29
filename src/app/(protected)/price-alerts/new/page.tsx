import { AlertEditorPage } from "@/features/price-alerts/price-alert-pages";
export default async function NewPriceAlertPage({ searchParams }: { searchParams: Promise<{ code?: string; market?: string }> }) {
  const query = await searchParams;
  return <AlertEditorPage prefill={{ code: typeof query.code === "string" ? query.code : undefined, market: query.market === "us" ? "us" : "cn" }} />;
}
