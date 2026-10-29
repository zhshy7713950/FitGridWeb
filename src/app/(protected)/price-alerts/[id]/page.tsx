import { AlertDetailPage } from "@/features/price-alerts/price-alert-pages";
export default async function PriceAlertDetailPage({ params }: { params: Promise<{ id: string }> }) { return <AlertDetailPage id={(await params).id} />; }
