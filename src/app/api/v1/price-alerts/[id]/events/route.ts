import { z } from "zod";
import { alertRoute, uuid } from "@/server/price-alerts/http";
export function GET(request: Request, context: { params: Promise<{ id: string }> }) { return alertRoute(request, async (s, owner) => { const query = z.strictObject({ before: z.string().max(512).optional() }).parse(Object.fromEntries(new URL(request.url).searchParams)); return s.events(owner, uuid.parse((await context.params).id), query.before); }); }
