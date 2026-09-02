import { requestJson } from "@/lib/api-client";
import { isUiDemoMode } from "@/lib/ui-demo";

import type { InvitationRegistrationUser, InvitationStatus } from "./types";

type DemoInvitationData = typeof import("./demo-invitation-data");

const loadDemoInvitationData = process.env.NODE_ENV === "production"
  ? null
  : () => import("./demo-invitation-data");

function demoInvitationData(): Promise<DemoInvitationData> {
  if (!loadDemoInvitationData) {
    return Promise.reject(new Error("UI demo invitation data is unavailable in production"));
  }
  return loadDemoInvitationData();
}

function encodedToken(token: string): string {
  return encodeURIComponent(token);
}

export function getInvitationStatus(
  token: string,
  signal?: AbortSignal,
): Promise<InvitationStatus> {
  if (isUiDemoMode()) {
    return demoInvitationData().then((demo) => demo.getDemoInvitationStatus(token));
  }

  return requestJson<InvitationStatus>(`/invitations/${encodedToken(token)}`, { signal });
}

export function acceptInvitation(
  token: string,
  username: string,
  password: string,
  signal?: AbortSignal,
): Promise<InvitationRegistrationUser> {
  if (isUiDemoMode()) {
    return demoInvitationData().then((demo) => (
      demo.acceptDemoInvitation(token, username, password)
    ));
  }

  return requestJson<InvitationRegistrationUser>(
    `/invitations/${encodedToken(token)}/accept`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
      signal,
    },
  );
}
