import { getAuth } from "@/server/auth/auth";
import { requireSession } from "@/server/auth/session";
import { apiHandler, noContent } from "@/server/http/route-factory";

export async function POST(request: Request): Promise<Response> {
  return apiHandler(request, async ({ requestId }) => {
    const auth = getAuth();
    await requireSession(request.headers, auth);
    const result = await auth.api.signOut({ headers: request.headers, returnHeaders: true });
    return noContent(requestId, result.headers);
  });
}
