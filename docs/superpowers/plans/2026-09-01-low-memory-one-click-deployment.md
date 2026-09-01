# Low-Memory One-Click Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a safe, repeatable installer that runs FitGridWeb at `/fitgrid` on a 2 vCPU/2 GiB Ubuntu 24.04 VPS alongside existing sing-box and nginx, including immutable GHCR images, low-memory PostgreSQL/Next.js settings, nginx integration, upgrade rollback, and boot recovery.

**Architecture:** GitHub Actions builds the application with the fixed `/fitgrid` Next.js base path and publishes a full-commit-SHA GHCR image. A bootstrap script installs host dependencies, clones a pinned commit to `/opt/fitgridweb`, generates a protected environment, applies a low-memory Compose overlay, safely injects an nginx location, and installs a systemd unit that restores the Compose project after reboot.

**Tech Stack:** Next.js 16, Better Auth 1.7, Docker Compose, PostgreSQL 17, nginx, POSIX shell, systemd, GitHub Actions, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-01-low-memory-one-click-deployment-design.md`

## Global Constraints

- Production base path is exactly `/fitgrid`; it is not runtime-configurable.
- VPS target is Ubuntu 24.04 x86_64 with at least 1.5 GiB RAM and 8 GiB free disk.
- The existing nginx vhost and its HTTPS listen port are user-selected; the installer never rewrites the listen directive or TLS certificate.
- Next.js binds only `127.0.0.1:${APP_PORT}`; PostgreSQL publishes no host port; Caddy is not started.
- App image is `ghcr.io/zhshy7713950/fitgridweb:sha-<full-40-character-commit>` and must be anonymously pullable.
- Existing secrets, database volumes, sing-box, SSH, firewall rules, unrelated nginx servers, and unrelated Docker projects are never deleted or overwritten.
- Every host-file mutation creates a backup or uses an atomic create/replace; no secret is printed.
- New behavior follows RED → GREEN tests. Configuration-only files are validated by behavior/contract tests before being added.

---

### Task 1: Base-Path-Aware Application and Session Cookie

**Files:**
- Create: `src/server/config/base-path.ts`
- Create: `src/server/config/base-path.test.ts`
- Modify: `next.config.ts`
- Modify: `src/server/auth/auth.ts`
- Modify: `Dockerfile`

**Interfaces:**
- Produces: `normalizeBasePath(value?: string): "" | "/fitgrid"` and `cookiePath(value?: string): "/" | "/fitgrid"`.
- Consumes: build-time `NEXT_BASE_PATH`; runtime `APP_BASE_PATH`.

- [ ] **Step 1: Write failing base-path tests**

```ts
expect(normalizeBasePath(undefined)).toBe("");
expect(normalizeBasePath("/fitgrid")).toBe("/fitgrid");
expect(cookiePath("/fitgrid")).toBe("/fitgrid");
expect(() => normalizeBasePath("/other")).toThrow("APP_BASE_PATH");
```

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm vitest run src/server/config/base-path.test.ts`

Expected: FAIL because `base-path.ts` does not exist.

- [ ] **Step 3: Implement the strict fixed-path helper**

```ts
export function normalizeBasePath(value?: string): "" | "/fitgrid" {
  if (!value) return "";
  if (value !== "/fitgrid") throw new Error("APP_BASE_PATH must be /fitgrid");
  return value;
}

export function cookiePath(value?: string): "/" | "/fitgrid" {
  return normalizeBasePath(value) || "/";
}
```

- [ ] **Step 4: Wire Next.js, Better Auth, and Docker build args**

Set `nextConfig.basePath = normalizeBasePath(process.env.NEXT_BASE_PATH)`. Set Better Auth `defaultCookieAttributes.path = cookiePath(process.env.APP_BASE_PATH)`. Add Dockerfile `ARG NEXT_BASE_PATH` and expose it only to the builder's `pnpm build` environment.

- [ ] **Step 5: Verify root and `/fitgrid` builds**

Run:

```bash
pnpm vitest run src/server/config/base-path.test.ts src/server/auth
pnpm typecheck
NEXT_BASE_PATH=/fitgrid pnpm build
```

Expected: tests/typecheck/build pass; build route output remains `/api/v1/...` internally while Next serves it beneath the configured base path.

- [ ] **Step 6: Commit**

```bash
git add src/server/config next.config.ts src/server/auth/auth.ts Dockerfile
git commit -m "feat: support fixed FitGrid production base path"
```

### Task 2: Immutable GHCR Image Workflow

**Files:**
- Create: `.github/workflows/server-image.yml`
- Create: `src/server/ops/release-config.test.ts`
- Modify: `.dockerignore`

**Interfaces:**
- Produces: `ghcr.io/zhshy7713950/fitgridweb:sha-${{ github.sha }}` for `linux/amd64`, built with `NEXT_BASE_PATH=/fitgrid`.

- [ ] **Step 1: Write the failing workflow contract test**

Read the YAML using the existing `yaml` package and assert:

```ts
expect(workflow.permissions.packages).toBe("write");
expect(workflow.on.push.branches).toContain("main");
expect(workflow.on.push.tags).toContain("v*");
expect(JSON.stringify(workflow)).toContain("NEXT_BASE_PATH=/fitgrid");
expect(JSON.stringify(workflow)).toContain("sha-${{ github.sha }}");
expect(JSON.stringify(workflow)).toContain("linux/amd64");
```

- [ ] **Step 2: Run and verify RED**

Run: `pnpm vitest run src/server/ops/release-config.test.ts`

Expected: FAIL because the workflow is missing.

- [ ] **Step 3: Add the workflow**

Use `actions/checkout`, `pnpm/action-setup`, `actions/setup-node`, `docker/setup-buildx-action`, `docker/login-action`, and `docker/build-push-action`. The verify job runs `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm typecheck`, and `pnpm lint`; the image job needs the verify job and pushes only after it succeeds. Use GitHub's built-in `GITHUB_TOKEN` with `contents: read` and `packages: write`.

- [ ] **Step 4: Verify YAML and production build**

Run:

```bash
pnpm vitest run src/server/ops/release-config.test.ts
NEXT_BASE_PATH=/fitgrid pnpm build
```

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/server-image.yml src/server/ops/release-config.test.ts .dockerignore
git commit -m "ci: publish immutable FitGrid server images"
```

### Task 3: Low-Memory Compose Overlay

**Files:**
- Create: `docker-compose.low-memory.yml`
- Create: `src/server/ops/low-memory-compose.test.ts`
- Modify: `.env.example`
- Modify: `src/server/ops/config.ts`
- Modify: `src/server/ops/config.test.ts`

**Interfaces:**
- Consumes: `APP_PORT`, `APP_BASE_PATH=/fitgrid`, `PUBLIC_HTTPS_PORT`, fixed `APP_IMAGE`.
- Produces: a Compose merge that starts only `db` and `app`, binding the app to `127.0.0.1:${APP_PORT}:3000`.

- [ ] **Step 1: Write failing Compose contract tests**

Parse base and overlay YAML and assert exact limits:

```ts
expect(app.mem_limit).toBe("640m");
expect(app.cpus).toBe(1);
expect(app.ports).toEqual(["127.0.0.1:${APP_PORT}:3000"]);
expect(app.environment.NODE_OPTIONS).toBe("--max-old-space-size=512");
expect(db.mem_limit).toBe("512m");
expect(db.cpus).toBe(0.75);
expect(db.command).toContain("shared_buffers=128MB");
expect(base.services.db.ports).toBeUndefined();
```

Also assert the app health check requests `/fitgrid/api/v1/health` and the overlay contains no Caddy port override.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm vitest run src/server/ops/low-memory-compose.test.ts`

- [ ] **Step 3: Implement overlay and environment validation**

Add the exact limits from the spec, `APP_BASE_PATH=/fitgrid`, `BETTER_AUTH_URL=https://${DOMAIN}${PUBLIC_PORT_SUFFIX}/fitgrid`, and a loopback port mapping. Extend the Zod config validator to require an integer app port 1024–65535, public HTTPS port 1–65535, and exact base path.

- [ ] **Step 4: Verify**

Run:

```bash
pnpm vitest run src/server/ops/low-memory-compose.test.ts src/server/ops/config.test.ts
pnpm typecheck
```

- [ ] **Step 5: Commit**

```bash
git add docker-compose.low-memory.yml .env.example src/server/ops
git commit -m "ops: add low-memory production compose profile"
```

### Task 4: Installer Preflight, Repository Bootstrap, and Secret Preservation

**Files:**
- Create: `ops/install-production.sh`
- Create: `ops/lib/install-common.sh`
- Create: `src/server/ops/install-common.test.ts`

**Interfaces:**
- Produces shell functions: `require_root`, `validate_host`, `resolve_ref`, `assert_public_image`, `ensure_checkout`, `ensure_environment`.
- Persistent paths: `/opt/fitgridweb`, `/etc/fitgridweb/fitgridweb.env`, `/etc/fitgridweb/backup.key`.

- [ ] **Step 1: Write failing tests against sourced shell functions**

Use temporary Ubuntu release/meminfo/disk fixtures and fake `git`, `curl`, `docker`, and `openssl` binaries. Verify:

```ts
expect(runFunction("validate_host", unsupportedFixture).status).toBe(1);
expect(runFunction("validate_host", twoGiBFixture).status).toBe(0);
expect(firstEnvironment).toMatch(/BETTER_AUTH_SECRET=[0-9a-f]{64}/);
expect(secondEnvironment).toBe(firstEnvironment);
expect(log).not.toContain(extractedSecret);
```

Add cases for less than 8 GiB free disk, occupied non-FitGrid app port, a ref that does not resolve to 40 hex characters, and an anonymous manifest failure before filesystem writes.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm vitest run src/server/ops/install-common.test.ts`

- [ ] **Step 3: Implement focused shell library functions**

All functions take explicit paths so tests never need fake `/etc` or `/opt`. `ensure_environment` uses a `umask 077`, writes to a temporary sibling, validates it, then renames atomically. It creates five independent 64-character hex secrets on first install and preserves a valid existing file during upgrades.

- [ ] **Step 4: Implement bootstrap/re-exec flow**

When invoked outside `/opt/fitgridweb`, the script installs only bootstrap prerequisites, resolves the selected public Git ref, clones/checks out the exact commit, then re-executes the installed script with `--from-installed`. It never runs code from a commit different from the resolved image SHA.

- [ ] **Step 5: Verify**

Run:

```bash
pnpm vitest run src/server/ops/install-common.test.ts
sh -n ops/install-production.sh ops/lib/install-common.sh
```

- [ ] **Step 6: Commit**

```bash
git add ops/install-production.sh ops/lib/install-common.sh src/server/ops/install-common.test.ts
git commit -m "ops: add safe production installer bootstrap"
```

### Task 5: Idempotent nginx Integration with Rollback

**Files:**
- Create: `ops/lib/install-nginx.sh`
- Create: `src/server/ops/install-nginx.test.ts`

**Interfaces:**
- Produces: `validate_nginx_site(site, domain, port)`, `render_nginx_snippet(appPort)`, `install_nginx_include(site, snippet, backupDir)`.
- Managed include: `/etc/nginx/snippets/fitgridweb-location.conf`.

- [ ] **Step 1: Write failing nginx behavior tests**

Create dedicated one-server fixture files and fake `nginx`/`systemctl`. Assert:

- domain or listen-port mismatch fails without changes;
- multiple `server {}` blocks fail;
- first install creates one include and snippet;
- second install does not duplicate either;
- snippet contains `location = /fitgrid`, `location ^~ /fitgrid/`, no trailing slash on `proxy_pass`, `$http_host`, `X-Forwarded-Proto https`, 10 MiB limit, Upgrade headers, and buffering disabled;
- fake `nginx -t` failure restores the byte-identical original site/snippet and never reloads.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm vitest run src/server/ops/install-nginx.test.ts`

- [ ] **Step 3: Implement validation, rendering, atomic insertion, and rollback**

The installer accepts only a regular file containing exactly one server block. Insert exactly:

```nginx
include /etc/nginx/snippets/fitgridweb-location.conf; # fitgridweb-managed
```

before that server's closing brace. Back up both targets with a UTC identifier, validate, and reload only on success.

- [ ] **Step 4: Verify**

Run:

```bash
pnpm vitest run src/server/ops/install-nginx.test.ts
sh -n ops/lib/install-nginx.sh
```

- [ ] **Step 5: Commit**

```bash
git add ops/lib/install-nginx.sh src/server/ops/install-nginx.test.ts
git commit -m "ops: integrate FitGrid with existing nginx safely"
```

### Task 6: Host Dependencies, Swap, and Boot Recovery

**Files:**
- Create: `ops/lib/install-host.sh`
- Create: `ops/templates/fitgridweb.service`
- Create: `src/server/ops/install-host.test.ts`

**Interfaces:**
- Produces: `install_dependencies`, `ensure_swap`, `install_systemd_unit`.
- systemd unit name: `fitgridweb.service`; Compose project name: `fitgridweb`.

- [ ] **Step 1: Write failing host-management tests**

With fake `apt-get`, `systemctl`, `fallocate`, `mkswap`, and `swapon`, assert exact behavior:

- Docker official repository is configured before Docker packages install;
- existing Swap at or above 2 GiB causes no file or fstab writes;
- smaller Swap creates only the difference at `/swapfile-fitgridweb` with mode `600`;
- repeated calls leave one marked fstab entry;
- systemd unit requires Docker/network-online, calls both Compose files with `up -d --wait db app`, stops only `app db`, and is enabled;
- no command mentions sing-box, firewall manipulation, Caddy, or unrelated Docker cleanup.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm vitest run src/server/ops/install-host.test.ts`

- [ ] **Step 3: Implement host functions and unit template**

Use noninteractive apt only after prompts have completed. Render absolute paths `/opt/fitgridweb`, `/etc/fitgridweb/fitgridweb.env`, base Compose and overlay. Call `daemon-reload` and `enable --now`, then `restart fitgridweb.service` during final verification.

- [ ] **Step 4: Verify**

Run:

```bash
pnpm vitest run src/server/ops/install-host.test.ts
sh -n ops/lib/install-host.sh
```

- [ ] **Step 5: Commit**

```bash
git add ops/lib/install-host.sh ops/templates/fitgridweb.service src/server/ops/install-host.test.ts
git commit -m "ops: add low-memory host and boot management"
```

### Task 7: Deployment Orchestration, Health Rollback, and Initial Admin

**Files:**
- Create: `ops/lib/install-deploy.sh`
- Create: `src/server/ops/install-deploy.test.ts`
- Modify: `ops/install-production.sh`

**Interfaces:**
- Produces: `deploy_release`, `verify_health`, `rollback_app`, `create_initial_admin`.
- Compose invocation always includes `--env-file /etc/fitgridweb/fitgridweb.env -f docker-compose.yml -f docker-compose.low-memory.yml` and explicit services.

- [ ] **Step 1: Write failing deployment state-machine tests**

Use a fake Docker CLI that records calls and can fail by phase. Assert:

- public image check happens before apt/filesystem mutations;
- migration failure never invokes `up -d app`;
- app health failure rewrites only `APP_IMAGE` to the old full SHA and runs old app;
- db volume is never removed;
- success verifies both `http://127.0.0.1:<appPort>/fitgrid/api/v1/health` and public HTTPS URL;
- admin creation runs only when explicitly selected and delegates hidden password input to `pnpm admin:create`;
- logs never contain values matching any environment secret.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm vitest run src/server/ops/install-deploy.test.ts`

- [ ] **Step 3: Implement orchestration and rollback**

Follow the ten-step order in the spec. Persist the old image before updating. On health failure, atomically restore the prior environment file and run only the old app; do not undo migrations. On first install with no old image, leave db running for diagnosis and return nonzero.

- [ ] **Step 4: Complete interactive main flow**

Collect all input before installing packages. Validate domain, numeric ports, exact nginx site path, ref and yes/no answers. Source the three focused libraries, execute preflight, host setup, environment, deployment, nginx, systemd restart, public health, then optional administrator creation. Print daily commands and the offsite-backup warning.

- [ ] **Step 5: Verify focused and regression tests**

Run:

```bash
pnpm vitest run src/server/ops
sh -n ops/install-production.sh ops/lib/*.sh
pnpm typecheck
pnpm lint
```

- [ ] **Step 6: Commit**

```bash
git add ops/install-production.sh ops/lib/install-deploy.sh src/server/ops/install-deploy.test.ts
git commit -m "ops: complete one-click production deployment"
```

### Task 8: Operations Manual and Release Gate

**Files:**
- Modify: `README.md`
- Modify: `docs/fit-replication/07-deployment-and-operations.md`
- Modify: `docs/fit-replication/server-implementation-status.md`
- Create: `docs/fit-replication/low-memory-vps-runbook.md`
- Modify: `.env.example`

**Interfaces:**
- Produces: copy/paste install, status, upgrade, backup, restore, nginx rollback, boot recovery, and uninstall-without-data-loss instructions.

- [ ] **Step 1: Update documentation from the tested behavior**

Document the two-command safe download/run flow, every prompt and default, the one-time GHCR-public requirement, fixed `/fitgrid` URL, systemd/Docker status commands, 2 GiB Swap, resource thresholds, immutable upgrade/ref selection, rollback limitations, offsite backup requirement, and exact files modified on the host.

- [ ] **Step 2: Add a documentation contract test if commands drift**

Extend `release-config.test.ts` to assert the runbook contains:

```text
/fitgrid/api/v1/health
systemctl status fitgridweb
--upgrade
BACKUP_REMOTE_DIR
nginx -t
```

- [ ] **Step 3: Run complete local verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm lint
NEXT_BASE_PATH=/fitgrid pnpm build
sh -n ops/*.sh ops/lib/*.sh docker/postgres/init-app-role.sh
git diff --check
git status --short
```

Expected: all runnable checks pass; the PostgreSQL integration test remains explicitly skipped only when `TEST_DATABASE_URL` is absent. Docker/VPS/GHCR checks are reported as external release gates rather than claimed as locally run.

- [ ] **Step 4: Commit**

```bash
git add README.md .env.example docs/fit-replication src/server/ops
git commit -m "docs: add low-memory VPS production runbook"
```

- [ ] **Step 5: Publish and verify external gates**

Push the feature branch, confirm GitHub Actions publishes the full-SHA image, make the GHCR package public once, and verify anonymous `docker manifest inspect`. On the new VPS, run the installer, `systemctl restart fitgridweb`, reboot once, verify `/fitgrid/api/v1/health`, create two users, run owner-isolation smoke tests, create an encrypted backup, and restore it into an isolated database before calling the production deployment accepted.
