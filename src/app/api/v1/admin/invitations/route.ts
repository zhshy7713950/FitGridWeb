import { z } from "zod";

import { requireAdmin } from "@/server/auth/session";
import { apiHandler, json, parseJsonBody } from "@/server/http/route-factory";
import { getRuntimeServices } from "@/server/runtime/services";
import { ownerMutationRequests } from "@/server/security/request-protection";

const bodySchema = z.strictObject({ expiresInHours: z.number().int().min(1).max(168) });

export async function POST(request: Request): Promise<Response> {
  return apiHandler(request, async ({ requestId }) => {
    const services = getRuntimeServices();
    const admin = await requireAdmin(request.headers, services.auth);
    ownerMutationRequests.consume(admin.id);
    const body = bodySchema.parse(await parseJsonBody(request));
    const invitation = await services.invitations.create(admin.id, body.expiresInHours);
    const inviteUrl = new URL(`/accept-invitation/${invitation.token}`, request.url).toString();
    return json(
      { id: invitation.id, inviteUrl, expiresAt: invitation.expiresAt },
      201,
      requestId,
    );
  });
}
