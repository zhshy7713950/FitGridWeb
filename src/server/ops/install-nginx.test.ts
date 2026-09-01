import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const library = path.join(process.cwd(), "ops/lib/install-nginx.sh");

async function executable(directory: string, name: string, body: string) {
  const file = path.join(directory, name);
  await writeFile(file, `#!/bin/sh\nset -eu\n${body}\n`);
  await chmod(file, 0o700);
}

async function fixture(serverBlocks = 1) {
  const root = path.join(tmpdir(), `fitgrid-nginx-${randomUUID()}`);
  const bin = path.join(root, "bin");
  const backups = path.join(root, "backups");
  await mkdir(bin, { recursive: true });
  await mkdir(backups);
  const site = path.join(root, "site.conf");
  const desiredSnippet = path.join(root, "desired.conf");
  const installedSnippet = path.join(root, "installed.conf");
  const log = path.join(root, "commands.log");
  const block = `server {\n    listen 8443 ssl;\n    server_name grid.example.com;\n    location /existing { return 200; }\n}\n`;
  await writeFile(site, block.repeat(serverBlocks));
  await executable(bin, "nginx", 'printf "nginx %s\\n" "$*" >>"$COMMAND_LOG"; [ "${NGINX_OK:-1}" = 1 ]');
  await executable(bin, "systemctl", 'printf "systemctl %s\\n" "$*" >>"$COMMAND_LOG"');
  return { root, bin, backups, site, desiredSnippet, installedSnippet, log };
}

function run(command: string, files: Awaited<ReturnType<typeof fixture>>, env: Record<string, string> = {}) {
  return spawnSync("sh", ["-c", `. "${library}"; ${command}`], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${files.bin}:${process.env.PATH}`,
      COMMAND_LOG: files.log,
      FITGRID_NGINX_SNIPPET_PATH: files.installedSnippet,
      FITGRID_BACKUP_ID: "test-backup",
      ...env,
    },
  });
}

describe("nginx site validation", () => {
  it("accepts exactly one matching HTTPS server", async () => {
    const files = await fixture();
    expect(run(`validate_nginx_site "${files.site}" grid.example.com 8443`, files).status).toBe(0);
    expect(run(`validate_nginx_site "${files.site}" other.example.com 8443`, files).status).toBe(1);
    expect(run(`validate_nginx_site "${files.site}" grid.example.com 443`, files).status).toBe(1);
  });

  it("rejects files containing multiple server blocks", async () => {
    const files = await fixture(2);
    expect(run(`validate_nginx_site "${files.site}" grid.example.com 8443`, files).status).toBe(1);
  });
});

describe("nginx managed include", () => {
  it("renders subpath-safe proxy directives", async () => {
    const files = await fixture();
    const result = run("render_nginx_snippet 3300", files);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("location = /fitgrid");
    expect(result.stdout).toContain("location ^~ /fitgrid/");
    expect(result.stdout).toContain("proxy_pass http://127.0.0.1:3300;");
    expect(result.stdout).not.toContain("3300/;");
    expect(result.stdout).toContain("proxy_set_header Host $http_host;");
    expect(result.stdout).toContain("proxy_set_header X-Forwarded-Proto https;");
    expect(result.stdout).toContain("client_max_body_size 10m;");
    expect(result.stdout).toContain("proxy_buffering off;");
    expect(result.stdout).toContain("proxy_set_header Upgrade $http_upgrade;");
  });

  it("installs once and stays idempotent", async () => {
    const files = await fixture();
    const rendered = run("render_nginx_snippet 3300", files);
    await writeFile(files.desiredSnippet, rendered.stdout);
    const command = `install_nginx_include "${files.site}" "${files.desiredSnippet}" "${files.backups}"`;
    expect(run(command, files).status).toBe(0);
    expect(run(command, files).status).toBe(0);
    const site = await readFile(files.site, "utf8");
    expect(site.match(/fitgridweb-managed/g)).toHaveLength(1);
    expect(await readFile(files.installedSnippet, "utf8")).toBe(rendered.stdout);
  });

  it("restores the original files when nginx validation fails", async () => {
    const files = await fixture();
    const originalSite = await readFile(files.site, "utf8");
    await writeFile(files.installedSnippet, "# previous snippet\n");
    const originalSnippet = await readFile(files.installedSnippet, "utf8");
    await writeFile(files.desiredSnippet, run("render_nginx_snippet 3300", files).stdout);

    const result = run(`install_nginx_include "${files.site}" "${files.desiredSnippet}" "${files.backups}"`, files, { NGINX_OK: "0" });
    expect(result.status).toBe(1);
    expect(await readFile(files.site, "utf8")).toBe(originalSite);
    expect(await readFile(files.installedSnippet, "utf8")).toBe(originalSnippet);
    const log = await readFile(files.log, "utf8");
    expect(log).not.toContain("reload nginx");
  });
});
