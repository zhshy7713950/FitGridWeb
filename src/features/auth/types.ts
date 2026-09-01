export interface SessionUser {
  id: string;
  username: string;
  role: "member" | "admin";
  status: "active";
}

export interface SessionResponse {
  user: SessionUser;
  expiresAt: string;
}
