import { z } from "zod";
import { ruleSchema } from "@/server/price-alerts/engine";
import { alertRoute, parseAlertBody as parseJsonBody, uuid } from "@/server/price-alerts/http";
import { publicRule } from "@/server/price-alerts/service";
const createSchema = z.strictObject({ instrumentId: uuid, condition: ruleSchema, enabled: z.boolean() });
export function GET(request: Request) { return alertRoute(request, (service, owner) => service.list(owner)); }
export function POST(request: Request) { return alertRoute(request, async (service, owner) => publicRule(await service.create(owner, createSchema.parse(await parseJsonBody(request)))), 201); }
