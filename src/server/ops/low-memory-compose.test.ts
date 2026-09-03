import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

function readCompose(name: string) {
  return parse(readFileSync(path.join(process.cwd(), name), "utf8")) as {
    services: Record<string, Record<string, unknown>>;
  };
}

describe("low-memory production Compose overlay", () => {
  it("keeps the application private and inside its memory budget", () => {
    const overlay = readCompose("docker-compose.low-memory.yml");
    const app = overlay.services.app as {
      mem_limit: string;
      cpus: number;
      ports: string[];
      environment: Record<string, string>;
      healthcheck: { test: string[] };
    };

    expect(app.mem_limit).toBe("640m");
    expect(app.cpus).toBe(1);
    expect(app.ports).toEqual(["127.0.0.1:${APP_PORT:?APP_PORT is required}:3000"]);
    expect(app.environment.NODE_OPTIONS).toBe("--max-old-space-size=512");
    expect(app.environment.APP_BASE_PATH).toBe("/fitgrid");
    expect(app.environment.BETTER_AUTH_URL).toContain("/fitgrid");
    expect(JSON.stringify(app.healthcheck.test)).toContain("/fitgrid/api/v1/health");
  });

  it("tunes PostgreSQL without publishing its port", () => {
    const base = readCompose("docker-compose.yml");
    const overlay = readCompose("docker-compose.low-memory.yml");
    const db = overlay.services.db as {
      mem_limit: string;
      cpus: number;
      command: string[];
    };

    expect(base.services.db.ports).toBeUndefined();
    expect(db.mem_limit).toBe("512m");
    expect(db.cpus).toBe(0.75);
    expect(db.command).toContain("shared_buffers=128MB");
    expect(db.command).toContain("effective_cache_size=512MB");
    expect(db.command).toContain("max_connections=30");
  });

  it("does not expose or configure Caddy in the overlay", () => {
    const overlay = readCompose("docker-compose.low-memory.yml");
    expect(overlay.services.caddy).toBeUndefined();
  });

  it("mounts only the web spool writable and portable backups read-only", () => {
    const base = readCompose("docker-compose.yml");
    const app = base.services.app as {
      environment: Record<string, string>;
      group_add: string[];
      volumes: string[];
    };

    expect(app.volumes).toEqual([
      "${ADMIN_OPS_WEB_DIR:?ADMIN_OPS_WEB_DIR is required}:/var/lib/fitgridweb/admin-ops:rw",
      "${PORTABLE_BACKUP_DIR:?PORTABLE_BACKUP_DIR is required}:/var/lib/fitgridweb/portable-backups:ro",
    ]);
    expect(app.group_add).toEqual(["${PORTABLE_BACKUP_READER_GID:-1001}"]);
    expect(app.environment).toMatchObject({
      ADMIN_OPS_DIR: "/var/lib/fitgridweb/admin-ops",
      PORTABLE_BACKUP_DIR: "/var/lib/fitgridweb/portable-backups",
      PORTABLE_BACKUP_HISTORY_FILE: "/var/lib/fitgridweb/admin-ops/status/backups.json",
      PORTABLE_BACKUP_MAX_BYTES: "${PORTABLE_BACKUP_MAX_BYTES:?PORTABLE_BACKUP_MAX_BYTES is required}",
    });
    expect(JSON.stringify(app)).not.toMatch(/docker\.sock|backup\.key|fitgridweb\.env|MIGRATION_DATABASE_URL/);
  });
});
