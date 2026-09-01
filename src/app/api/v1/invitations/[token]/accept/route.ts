import { z } from "zod";

import { apiHandler, json, parseJsonBody } from "@/server/http/route-factory";
import { getRuntimeServices } from "@/server/runtime/services";
import { clientIp, invitationAcceptRequests } from "@/server/security/request-protection";

const tokenSchema = z.string().min(32).max(512);
const bodySchema = z.strictObject({
  username: z.string().min(3).max(64),
  password: z.string().min(12).max(128),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  return apiHandler(request, async ({ requestId }) => {
    invitationAcceptRequests.consume(clientIp(request.headers));
    const { token } = await context.params;
    const body = bodySchema.parse(await parseJsonBody(request));
    const user = await getRuntimeServices().invitations.accept(
      tokenSchema.parse(token),
      body.username,
      body.password,
    );
    return json(user, 201, requestId);
  });
}
