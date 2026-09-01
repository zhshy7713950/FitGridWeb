import { z } from "zod";

import { requireSession } from "@/server/auth/session";
import { apiHandler, json } from "@/server/http/route-factory";
import { getRuntimeServices } from "@/server/runtime/services";

const formatSchema = z.enum(["android", "web"]);

export async function GET(request: Request): Promise<Response> {
  return apiHandler(request, async ({ requestId }) => {
    const services = getRuntimeServices();
    const user = await requireSession(request.headers, services.auth);
    const format = formatSchema.parse(new URL(request.url).searchParams.get("format"));
    const date = new Date().toISOString().slice(0, 10);
    const body = format === "android"
      ? await services.exports.android(user.id)
      : await services.exports.web(user.id);
    return json(body, 200, requestId, {
      "content-disposition": `attachment; filename="fitgridweb-${format}-${date}.json"`,
      "cache-control": "no-store",
    });
  });
}
