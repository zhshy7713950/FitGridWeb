import { AlertEditorPage } from "@/features/price-alerts/price-alert-pages";
export default async function EditPriceAlertPage({ params }: { params: Promise<{ id: string }> }) { return <AlertEditorPage id={(await params).id} />; }
