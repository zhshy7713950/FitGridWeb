import { cpSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const standaloneRoot = path.join(root, ".next/standalone");

cpSync(
  path.join(root, ".next/static"),
  path.join(standaloneRoot, ".next/static"),
  { recursive: true },
);

const publicDirectory = path.join(root, "public");
if (existsSync(publicDirectory)) {
  cpSync(publicDirectory, path.join(standaloneRoot, "public"), { recursive: true });
}

if (process.argv[2] !== "--prepare-only") {
  await import(pathToFileURL(path.join(standaloneRoot, "server.js")).href);
}
