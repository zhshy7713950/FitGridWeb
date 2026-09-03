import type { SessionUser } from "@/features/auth/types";

export interface InvitationStatus {
  status: "valid" | "used" | "expired";
  expiresAt: string | null;
}

export type InvitationRegistrationUser = SessionUser;
