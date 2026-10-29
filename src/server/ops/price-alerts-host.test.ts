import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const project = process.cwd();
async function fixture() {
  const root = path.join(tmpdir(), `fitgrid-alert-host-${randomUUID()}`);
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  const log = path.join(root, "args");
  const input = path.join(root, "input");
  await writeFile(path.join(bin, "curl"), '#!/bin/sh\n[ "$1" = --disable ] || exit 93\nprintf "%s\\n" "$*" >"$ARGS"\ncat >"$INPUT"\n');
  await chmod(path.join(bin, "curl"), 0o700);
  return { root, bin, log, input };
}

describe("price alert host tick", () => {
  it("fails closed when an in-flight tick never drains", async () => {
    const f = await fixture();
    await writeFile(path.join(f.bin, "systemctl"), '#!/bin/sh\ncase "$*" in\n  "show --property=LoadState --value "*) printf "loaded\\n" ;;\n  "show --property=ActiveState --value "*) printf "activating\\n" ;;\n  "stop fitgridweb-price-alerts.timer") : ;;\n  *) printf "unexpected: %s\\n" "$*" >&2; exit 9 ;;\nesac\n');
    await writeFile(path.join(f.bin, "sleep"), '#!/bin/sh\nexit 0\n');
    await chmod(path.join(f.bin, "systemctl"), 0o700);
    await chmod(path.join(f.bin, "sleep"), 0o700);
    const result = spawnSync("sh", ["-c", `. "${path.join(project, "ops/lib/price-alerts-timer.sh")}"; stop_price_alerts`], { encoding: "utf8", timeout: 5000, env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refusing database changes");
    expect(result.stderr).not.toContain("unexpected");
  });

  it("POSTs loopback with the bearer only on curl stdin", async () => {
    const f = await fixture();
    const secret = "a".repeat(64);
    const result = spawnSync("sh", [path.join(project, "ops/price-alerts-tick.sh")], {
      encoding: "utf8", env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, APP_PORT: "3300", PRICE_ALERTS_TASK_SECRET: secret, ARGS: f.log, INPUT: f.input },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(f.log, "utf8")).not.toContain(secret);
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
    expect(await readFile(f.input, "utf8")).toContain(`Authorization: Bearer ${secret}`);
    expect(await readFile(f.input, "utf8")).toContain("http://127.0.0.1:3300/fitgrid/api/internal/price-alerts/tick");
    expect(await readFile(f.input, "utf8")).toContain('request = "POST"');
  });
  it("fails closed on unsafe configuration without invoking curl", async () => {
    const f = await fixture();
    for (const patch of [{ APP_PORT: "3300/evil" }, { PRICE_ALERTS_TASK_SECRET: 'a"\nheader=evil' }]) {
      const result = spawnSync("sh", [path.join(project, "ops/price-alerts-tick.sh")], {
        encoding: "utf8", env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, APP_PORT: "3300", PRICE_ALERTS_TASK_SECRET: "a".repeat(64), ARGS: f.log, INPUT: f.input, ...patch },
      });
      expect(result.status).not.toBe(0);
    }
    await expect(readFile(f.log)).rejects.toThrow();
  });
});
