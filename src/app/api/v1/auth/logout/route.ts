import { getAuth } from "@/server/auth/auth";
import { requireSession } from "@/server/auth/session";
import { apiHandler, noContent } from "@/server/http/route-factory";
import { ownerMutationRequests } from "@/server/security/request-protection";

export async function POST(request: Request): Promise<Response> {
  return apiHandler(request, async ({ requestId }) => {
    const auth = getAuth();
    const user = await requireSession(request.headers, auth);
    ownerMutationRequests.consume(user.id);
    const result = await auth.api.signOut({ headers: request.headers, returnHeaders: true });
    return noContent(requestId, result.headers);
  });
}
