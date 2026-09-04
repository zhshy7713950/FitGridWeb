import type { FileHandle } from "node:fs/promises";

export class BoundedFileError extends Error {}

export async function readBoundedUtf8(handle: FileHandle, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;

  while (total <= maxBytes) {
    const remaining = maxBytes + 1 - total;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) throw new BoundedFileError("file exceeds bounded read limit");
    chunks.push(chunk.subarray(0, bytesRead));
  }

  return Buffer.concat(chunks, total).toString("utf8");
}
