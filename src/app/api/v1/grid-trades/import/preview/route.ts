import { ApiError } from "@/server/http/api-error";
import { requireSession } from "@/server/auth/session";
import { apiHandler, json } from "@/server/http/route-factory";
import { getRuntimeServices } from "@/server/runtime/services";
import { importPreviewRequests } from "@/server/security/request-protection";

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

export async function POST(request: Request): Promise<Response> {
  return apiHandler(request, async ({ requestId }) => {
    const services = getRuntimeServices();
    const user = await requireSession(request.headers, services.auth);
    importPreviewRequests.consume(user.id);
    if (!request.headers.get("content-type")?.toLowerCase().includes("multipart/form-data")) {
      throw new ApiError(400, "CONTENT_TYPE_INVALID", "导入必须使用 multipart/form-data");
    }
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new ApiError(400, "IMPORT_FILE_REQUIRED", "缺少导入文件");
    }
    if (file.size > MAX_IMPORT_BYTES) {
      throw new ApiError(413, "IMPORT_FILE_TOO_LARGE", "导入文件不能超过 10 MiB");
    }
    const preview = await services.imports.preview(user.id, new Uint8Array(await file.arrayBuffer()));
    return json(preview, 200, requestId);
  });
}
