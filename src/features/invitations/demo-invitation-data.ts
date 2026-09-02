import { ClientApiError } from "@/lib/api-client";

import type { InvitationRegistrationUser, InvitationStatus } from "./types";

const VALID_DEMO_TOKEN = "valid-demo-invitation-token-000001";

function assertValidDemoToken(token: string): void {
  if (token !== VALID_DEMO_TOKEN) {
    throw new ClientApiError(
      404,
      "INVITATION_NOT_FOUND",
      "邀请不存在",
      "demo-invitation-not-found",
    );
  }
}

export function getDemoInvitationStatus(token: string): InvitationStatus {
  assertValidDemoToken(token);
  return { status: "valid", expiresAt: "2099-12-31T23:59:59.000Z" };
}

export function acceptDemoInvitation(
  token: string,
  username: string,
  _password: string,
): InvitationRegistrationUser {
  void _password;
  assertValidDemoToken(token);
  return {
    id: "00000000-0000-4000-8000-000000000002",
    username,
    role: "member",
    status: "active",
  };
}
