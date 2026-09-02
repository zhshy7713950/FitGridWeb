import { EditGridFormPage } from "@/features/grids/grid-form-page";

export default async function EditGridPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return <EditGridFormPage id={(await params).id} />;
}
