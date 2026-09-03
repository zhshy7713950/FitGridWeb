import { createHash } from "node:crypto";
import { createServer, type Server } from "node:net";

export type KernelLockEndpoint =
  | { type: "unix"; path: string }
  | { type: "tcp"; host: "127.0.0.1"; port: number };

export class KernelLockBusyError extends Error {}

function defaultEndpoint(scope: string, purpose: string): KernelLockEndpoint {
  const digest = createHash("sha256").update(`${purpose}\0${scope}`).digest();
  if (process.platform === "linux") {
    return { type: "unix", path: `\0fitgrid-${purpose}-${digest.toString("hex").slice(0, 32)}` };
  }
  return {
    type: "tcp",
    host: "127.0.0.1",
    port: 32_768 + (digest.readUInt16BE(0) % 16_384),
  };
}

function listen(server: Server, endpoint: KernelLockEndpoint): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    if (endpoint.type === "unix") server.listen({ path: endpoint.path, exclusive: true });
    else server.listen({ host: endpoint.host, port: endpoint.port, exclusive: true });
  });
}

export async function acquireKernelLock(
  scope: string,
  purpose: string,
  endpoint = defaultEndpoint(scope, purpose),
): Promise<() => Promise<void>> {
  if (
    (endpoint.type === "unix" && (!endpoint.path.startsWith("\0") || endpoint.path.length > 100))
    || (endpoint.type === "tcp" && (
      endpoint.host !== "127.0.0.1"
      || !Number.isInteger(endpoint.port)
      || endpoint.port < 1
      || endpoint.port > 65_535
    ))
  ) throw new Error("invalid kernel lock endpoint");
  const server = createServer();
  server.unref();
  try {
    await listen(server, endpoint);
  } catch (error) {
    server.close();
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") throw new KernelLockBusyError();
    throw error;
  }

  return () => new Promise((resolve) => server.close(() => resolve()));
}
