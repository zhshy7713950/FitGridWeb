export type ManagedUser = {
  id: string;
  username: string;
  role: "member" | "admin";
  status: "active" | "disabled";
  createdAt: string;
};

export type ManagedUserPage = {
  items: ManagedUser[];
  nextCursor: string | null;
};

export type CreatedInvitation = {
  id: string;
  inviteUrl: string;
  expiresAt: string;
};
