import { alertRoute, barkTestRequests } from "@/server/price-alerts/http";
export function POST(request: Request) { return alertRoute(request, (s, owner) => { barkTestRequests.consume(owner); return s.testChannel(owner); }); }
