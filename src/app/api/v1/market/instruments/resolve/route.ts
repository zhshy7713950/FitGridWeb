import { z } from "zod";
import { alertRoute, instrumentRequests, parseAlertBody as parseJsonBody } from "@/server/price-alerts/http";
export function POST(request: Request) { return alertRoute(request, async (s, owner) => { instrumentRequests.consume(owner); const input = z.strictObject({ market: z.enum(["cn", "us"]), code: z.string().min(1).max(32) }).parse(await parseJsonBody(request)); return s.resolve(input.market, input.code); }); }
