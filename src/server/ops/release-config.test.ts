import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface Workflow {
  name: string;
  on: {
    push: { branches: string[]; tags: string[] };
    workflow_dispatch: unknown;
  };
  permissions: { contents: string; packages: string };
  jobs: Record<string, unknown>;
}

describe("server image release workflow", () => {
  it("provides a database-free local UI demo command", () => {
    const result = spawnSync("pnpm", ["run", "dev:ui", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("next dev");
  });

  it("starts the same standalone runtime that the production image uses", async () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const root = await mkdtemp(path.join(tmpdir(), "fitgrid-standalone-"));
    const source = path.join(root, ".next/static/chunks");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "app.css"), "body{}\n");

    const result = spawnSync(
      process.execPath,
      [path.join(process.cwd(), "ops/start-standalone.mjs"), "--prepare-only"],
      { cwd: root, encoding: "utf8" },
    );

    expect(packageJson.scripts.start).toBe("node ops/start-standalone.mjs");
    expect(result.status, result.stderr).toBe(0);
    await expect(
      readFile(path.join(root, ".next/standalone/.next/static/chunks/app.css"), "utf8"),
    ).resolves.toBe("body{}\n");
  });

  it("keeps the grid contract fixture in the Docker build context", () => {
    const dockerignore = readFileSync(
      path.join(process.cwd(), ".dockerignore"),
      "utf8",
    );
    const rules = dockerignore.split(/\r?\n/);

    for (const requiredRule of [
      "!docs/fit-replication/",
      "!docs/fit-replication/fixtures/",
      "!docs/fit-replication/fixtures/grid-algorithm-v2.1.0.json",
    ]) {
      expect(rules).toContain(requiredRule);
    }
  });

  it("publishes a verified immutable amd64 image compiled for /fitgrid", () => {
    const source = readFileSync(
      path.join(process.cwd(), ".github/workflows/server-image.yml"),
      "utf8",
    );
    const workflow = parse(source) as Workflow;
    const serialized = JSON.stringify(workflow);

    expect(workflow.permissions).toEqual({ contents: "read", packages: "write" });
    expect(workflow.on.push.branches).toContain("main");
    expect(workflow.on.push.tags).toContain("v*");
    expect(workflow.on.workflow_dispatch).toBeDefined();
    expect(serialized).toContain("NEXT_BASE_PATH=/fitgrid");
    expect(serialized).toContain("sha-${{ github.sha }}");
    expect(serialized).toContain("linux/amd64");
    expect(serialized).toContain("pnpm test");
    expect(serialized).toContain("pnpm typecheck");
    expect(serialized).toContain("pnpm lint");
    expect(serialized).toContain("--read-only");
    expect(serialized).toContain("DATABASE_URL=file:/tmp/cli-check.db");
    expect(serialized).toContain("/app/node_modules/.bin/prisma");
    expect(serialized).toContain("/app/node_modules/.bin/tsx");
  });

  it("keeps the low-memory VPS runbook operationally complete", () => {
    const runbook = readFileSync(
      path.join(process.cwd(), "docs/fit-replication/low-memory-vps-runbook.md"),
      "utf8",
    );

    for (const required of [
      "/fitgrid/api/v1/health",
      "systemctl status fitgridweb",
      "--upgrade",
      "BACKUP_REMOTE_DIR",
      "nginx -t",
      "systemctl restart fitgridweb",
      "/etc/fitgridweb/fitgridweb.env",
    ]) {
      expect(runbook).toContain(required);
    }
  });
});
