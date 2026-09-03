import { z } from "zod";

import { requireAdmin } from "@/server/auth/session";
import { invitationUrl } from "@/server/config/base-path";
import { apiHandler, json, parseJsonBody } from "@/server/http/route-factory";
import { getRuntimeServices } from "@/server/runtime/services";
import { ownerMutationRequests } from "@/server/security/request-protection";

const bodySchema = z.strictObject({ expiresInHours: z.number().int().min(1).max(168) });

function configuredPublicAppUrl(value?: string): string {
  if (!value) throw new Error("BETTER_AUTH_URL is required to create invitations");
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error("BETTER_AUTH_URL must use HTTPS to create invitations");
  }
  return url.toString();
}

export async function POST(request: Request): Promise<Response> {
  return apiHandler(request, async ({ requestId }) => {
    const publicAppUrl = configuredPublicAppUrl(process.env.BETTER_AUTH_URL);
    const services = getRuntimeServices();
    const admin = await requireAdmin(request.headers, services.auth);
    ownerMutationRequests.consume(admin.id);
    const body = bodySchema.parse(await parseJsonBody(request));
    const invitation = await services.invitations.create(admin.id, body.expiresInHours);
    const inviteUrl = invitationUrl(
      publicAppUrl,
      invitation.token,
      process.env.APP_BASE_PATH,
    );
    return json(
      { id: invitation.id, inviteUrl, expiresAt: invitation.expiresAt },
      201,
      requestId,
    );
  });
}
