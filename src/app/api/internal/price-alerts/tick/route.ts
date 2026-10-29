import { getRuntimeServices } from "@/server/runtime/services";
import { maintenanceApiHandler } from "@/server/maintenance/http";
import { json } from "@/server/http/route-factory";
import { authorizeTask, withTaskLock } from "@/server/price-alerts/runtime";
import { AlertScheduler } from "@/server/price-alerts/scheduler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 150;
export function POST(request: Request) {
  return maintenanceApiHandler(request, async ({ requestId }) => {
    authorizeTask(request, process.env.PRICE_ALERTS_TASK_SECRET ?? "");
    const services = getRuntimeServices();
    const scheduler = new AlertScheduler(services.alerts.repository, services.alerts.config);
    return json(await withTaskLock(() => scheduler.tick()), 200, requestId);
  });
}
