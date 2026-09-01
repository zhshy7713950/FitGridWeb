import { getAuth } from "@/server/auth/auth";
import { requireSession } from "@/server/auth/session";
import { apiHandler, json } from "@/server/http/route-factory";

export async function GET(request: Request): Promise<Response> {
  return apiHandler(request, async ({ requestId }) => {
    const auth = getAuth();
    const user = await requireSession(request.headers, auth);
    const session = await auth.api.getSession({ headers: request.headers });
    return json(
      {
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          status: user.status,
          createdAt: new Date(session!.user.createdAt).toISOString(),
        },
        expiresAt: new Date(session!.session.expiresAt).toISOString(),
      },
      200,
      requestId,
    );
  });
}
