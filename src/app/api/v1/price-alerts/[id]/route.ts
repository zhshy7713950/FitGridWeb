import { z } from "zod";
import { ruleSchema } from "@/server/price-alerts/engine";
import { alertRoute, parseAlertBody as parseJsonBody, uuid } from "@/server/price-alerts/http";
import { publicRule } from "@/server/price-alerts/service";
type Context = { params: Promise<{ id: string }> };
const version = z.number().int().positive();
const patchSchema = z.strictObject({ expectedVersion: version, condition: ruleSchema.optional(), enabled: z.boolean().optional() }).refine((v) => v.condition !== undefined || v.enabled !== undefined, "必须提供修改内容");
export function GET(request: Request, context: Context) { return alertRoute(request, async (s, owner) => s.detail(owner, uuid.parse((await context.params).id))); }
export function PATCH(request: Request, context: Context) { return alertRoute(request, async (s, owner) => publicRule(await s.update(owner, uuid.parse((await context.params).id), patchSchema.parse(await parseJsonBody(request))))); }
export function DELETE(request: Request, context: Context) { return alertRoute(request, async (s, owner) => { await s.repository.update(owner, uuid.parse((await context.params).id), { ...z.strictObject({ expectedVersion: version }).parse(await parseJsonBody(request)), deleted: true }); }, 204); }
