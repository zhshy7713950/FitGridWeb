import { readFileSync } from "node:fs";
import path from "node:path";

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
