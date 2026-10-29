import { z } from "zod";
import { alertRoute, instrumentRequests, parseAlertBody } from "@/server/price-alerts/http";
export function POST(request: Request) {
  return alertRoute(request, async (service, owner) => {
    instrumentRequests.consume(owner);
    const input = z.strictObject({ market: z.enum(["cn", "us"]), query: z.string().min(1).max(64).regex(/\S/).transform((value) => value.trim()) }).parse(await parseAlertBody(request));
    return service.search(input.market, input.query);
  });
}
