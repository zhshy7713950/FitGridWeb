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
  const dedicatedSite = path.join(root, "fitgridweb.conf");
  const nginxDump = path.join(root, "nginx-dump.txt");
  const certificate = path.join(root, "grid.example.com.crt");
  const certificateKey = path.join(root, "grid.example.com.key");
  const log = path.join(root, "commands.log");
  const block = `server {\n    listen 8443 ssl;\n    server_name grid.example.com;\n    location /existing { return 200; }\n}\n`;
  await writeFile(site, block.repeat(serverBlocks));
  await writeFile(certificate, "test certificate\n");
  await writeFile(certificateKey, "test key\n");
  await writeFile(nginxDump, `# configuration file /etc/nginx/conf.d/existing.conf:\nserver {\n    listen 10256 ssl;\n    server_name grid.example.com;\n    ssl_certificate ${certificate};ssl_certificate_key ${certificateKey};\n}\n`);
  await executable(bin, "nginx", `
printf "nginx %s\\n" "$*" >>"$COMMAND_LOG"
case "\${1:-}" in
  -T) cat "\$NGINX_DUMP_FILE" ;;
  -t) [ "\${NGINX_OK:-1}" = 1 ] ;;
esac`);
  await executable(bin, "systemctl", 'printf "systemctl %s\\n" "$*" >>"$COMMAND_LOG"; [ "${SYSTEMCTL_OK:-1}" = 1 ]');
  await executable(bin, "curl", `
printf 'curl %s\\n' "\$*" >>"\$COMMAND_LOG"
case "\$*" in
  *--resolve*) [ "\${LOCAL_HTTPS_OK:-1}" = 1 ] ;;
  *) [ "\${PUBLIC_HTTPS_OK:-1}" = 1 ] ;;
esac`);
  await executable(bin, "ss", `
for port in \${BUSY_PORTS:-}; do
  printf 'LISTEN 0 511 0.0.0.0:%s 0.0.0.0:*\\n' "\$port"
done`);
  return {
    root,
    bin,
    backups,
    site,
    desiredSnippet,
    installedSnippet,
    dedicatedSite,
    nginxDump,
    certificate,
    certificateKey,
    log,
  };
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
      NGINX_DUMP_FILE: files.nginxDump,
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

describe("dedicated nginx site preparation", () => {
  it("uses a free TCP port but reuses a matching managed endpoint when it is already listening", async () => {
    const files = await fixture();

    expect(run(`resolve_nginx_public_port "${files.dedicatedSite}" grid.example.com 443`, files).stdout.trim()).toBe("443");
    expect(run(`resolve_nginx_public_port "${files.dedicatedSite}" grid.example.com 443`, files, { BUSY_PORTS: "443" }).status).toBe(1);
    expect(run(`resolve_nginx_public_port "${files.site}" grid.example.com 8443`, files, { BUSY_PORTS: "8443" }).stdout.trim()).toBe("8443");
  });

  it("asks for an alternative when the preferred HTTPS port is occupied", async () => {
    const files = await fixture();
    const result = run(
      `prompt_value() { printf '8443\\n'; }; choose_nginx_public_port "${files.dedicatedSite}" grid.example.com 443`,
      files,
      { BUSY_PORTS: "443" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("8443");
    expect(result.stderr).toContain("443");
  });

  it("creates a separate TLS vhost from the domain's loaded certificate", async () => {
    const files = await fixture();
    const sourceSite = await readFile(files.site, "utf8");

    const result = run(
      `prepare_dedicated_nginx_site "${files.dedicatedSite}" grid.example.com 443 "${files.backups}"`,
      files,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(files.site, "utf8")).toBe(sourceSite);
    const dedicated = await readFile(files.dedicatedSite, "utf8");
    expect(dedicated).toContain("listen 443 ssl;");
    expect(dedicated).toContain("server_name grid.example.com;");
    expect(dedicated).toContain(`ssl_certificate ${files.certificate};`);
    expect(dedicated).toContain(`ssl_certificate_key ${files.certificateKey};`);
    const log = await readFile(files.log, "utf8");
    expect(log).toContain("nginx -T");
    expect(log).toContain("nginx -t");
    expect(log).toContain("systemctl reload nginx");
  });

  it("removes a newly created vhost when nginx validation fails", async () => {
    const files = await fixture();

    const result = run(
      `prepare_dedicated_nginx_site "${files.dedicatedSite}" grid.example.com 443 "${files.backups}"`,
      files,
      { NGINX_OK: "0" },
    );

    expect(result.status).toBe(1);
    await expect(readFile(files.dedicatedSite, "utf8")).rejects.toThrow();
    const log = await readFile(files.log, "utf8");
    expect(log).not.toContain("systemctl reload nginx");
  });

  it("rolls back the new vhost when the local TLS endpoint is not actually listening", async () => {
    const files = await fixture();

    const result = run(
      `prepare_dedicated_nginx_site "${files.dedicatedSite}" grid.example.com 443 "${files.backups}"`,
      files,
      { LOCAL_HTTPS_OK: "0" },
    );

    expect(result.status).toBe(1);
    await expect(readFile(files.dedicatedSite, "utf8")).rejects.toThrow();
    const log = await readFile(files.log, "utf8");
    expect(log).toContain("--resolve grid.example.com:443:127.0.0.1");
    expect(log.match(/systemctl reload nginx/g)).toHaveLength(2);
  });

  it("rolls back the new vhost when the public HTTPS endpoint is unreachable", async () => {
    const files = await fixture();

    const result = run(
      `prepare_dedicated_nginx_site "${files.dedicatedSite}" grid.example.com 443 "${files.backups}"`,
      files,
      { PUBLIC_HTTPS_OK: "0" },
    );

    expect(result.status).toBe(1);
    await expect(readFile(files.dedicatedSite, "utf8")).rejects.toThrow();
    const log = await readFile(files.log, "utf8");
    expect(log).toContain("https://grid.example.com/");
    expect(log.match(/systemctl reload nginx/g)).toHaveLength(2);
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
    expect(result.stdout).toContain("proxy_set_header X-Forwarded-Host $http_host;");
    expect(result.stdout).toContain("proxy_set_header X-Forwarded-Proto https;");
    expect(result.stdout).toContain("client_max_body_size 10m;");
    expect(result.stdout).toContain("proxy_buffering off;");
    expect(result.stdout).toContain("proxy_set_header Upgrade $http_upgrade;");
    expect(result.stdout).toContain("proxy_read_timeout 60s;");
  });

  it("inserts the include inside the server even when another top-level block follows", async () => {
    const files = await fixture();
    await writeFile(files.site, `${await readFile(files.site, "utf8")}map $http_upgrade $connection_upgrade {\n    default upgrade;\n}\n`);
    const rendered = run("render_nginx_snippet 3300", files);
    await writeFile(files.desiredSnippet, rendered.stdout);
    expect(run(`install_nginx_include "${files.site}" "${files.desiredSnippet}" "${files.backups}"`, files).status).toBe(0);
    const site = await readFile(files.site, "utf8");
    expect(site.indexOf("fitgridweb-managed")).toBeLessThan(site.indexOf("map $http_upgrade"));
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

  it("restores managed files when nginx reload fails", async () => {
    const files = await fixture();
    const originalSite = await readFile(files.site, "utf8");
    await writeFile(files.installedSnippet, "# previous snippet\n");
    const originalSnippet = await readFile(files.installedSnippet, "utf8");
    await writeFile(files.desiredSnippet, run("render_nginx_snippet 3300", files).stdout);

    const result = run(`install_nginx_include "${files.site}" "${files.desiredSnippet}" "${files.backups}"`, files, { SYSTEMCTL_OK: "0" });
    expect(result.status).toBe(1);
    expect(await readFile(files.site, "utf8")).toBe(originalSite);
    expect(await readFile(files.installedSnippet, "utf8")).toBe(originalSnippet);
  });
});
