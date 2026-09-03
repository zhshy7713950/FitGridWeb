import { InvitationPage } from "@/features/invitations/invitation-page";

export default async function PublicInvitationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <InvitationPage token={token} />;
}
