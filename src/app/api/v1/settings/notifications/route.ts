import { z } from "zod";
import { alertRoute, parseAlertBody as parseJsonBody } from "@/server/price-alerts/http";
export function GET(request: Request) { return alertRoute(request, (s, owner) => s.channelStatus(owner)); }
export function PUT(request: Request) { return alertRoute(request, async (s, owner) => { const input = z.strictObject({ deviceKey: z.string().trim().min(8).max(256).regex(/^[A-Za-z0-9_-]+$/) }).parse(await parseJsonBody(request)); return s.saveChannel(owner, input.deviceKey); }); }
export function DELETE(request: Request) { return alertRoute(request, (s, owner) => s.repository.removeChannel(owner), 204); }
