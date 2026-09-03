import { GridDetail } from "@/features/grids/grid-detail";

export default async function GridDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return <GridDetail id={(await params).id} />;
}
