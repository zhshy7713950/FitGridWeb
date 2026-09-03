import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const nextEnvPath = new URL("../../next-env.d.ts", import.meta.url);
const appBasePath = process.env.NEXT_BASE_PATH === "/fitgrid" ? "/fitgrid" : "";

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  if (!port) throw new Error("Unable to allocate a local UI demo port");
  return port;
}

function chromeExecutable(): string {
  const candidates = [
    process.env.FITGRID_CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
  ].filter((candidate): candidate is string => Boolean(candidate));
  const executable = candidates.find(existsSync);
  if (!executable) {
    throw new Error("Chrome is required for the FitGrid UI demo smoke test; set FITGRID_CHROME_PATH");
  }
  return executable;
}

async function waitForServer(url: string, child: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`UI demo server exited before it was ready:\n${output()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The development server has not opened its socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`UI demo server did not become ready:\n${output()}`);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    viewport: window.innerWidth,
    body: document.body.scrollWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(widths.body).toBeLessThanOrEqual(widths.viewport);
  expect(widths.document).toBeLessThanOrEqual(widths.viewport);
}

async function expectTopNavigation(page: Page): Promise<void> {
  const navigation = page.getByRole("navigation", { name: "主导航" });
  expect(await navigation.evaluate((element) => window.getComputedStyle(element).position))
    .not.toBe("fixed");
  const navigationBox = await navigation.boundingBox();
  const mainBox = await page.getByRole("main").boundingBox();
  expect(navigationBox).not.toBeNull();
  expect(mainBox).not.toBeNull();
  expect(navigationBox!.y + navigationBox!.height).toBeLessThanOrEqual(mainBox!.y + 1);
}

function expectExactlyOneBasePrefix(pathname: string): void {
  if (!appBasePath) {
    expect(pathname.startsWith("/fitgrid/")).toBe(false);
    return;
  }
  expect(pathname.startsWith(`${appBasePath}/`)).toBe(true);
  expect(pathname).not.toContain(`${appBasePath}${appBasePath}`);
}

describe.sequential("database-free UI demo", () => {
  let server: ChildProcess | undefined;
  let browser: Browser | undefined;
  let activeContext: BrowserContext | undefined;
  let baseUrl = "";
  let output = "";
  let originalNextEnv: string | undefined;

  beforeAll(async () => {
    const port = await availablePort();
    baseUrl = `http://127.0.0.1:${port}${appBasePath}`;
    originalNextEnv = await readFile(nextEnvPath, "utf8");
    server = spawn("pnpm", ["run", "dev:ui", "--port", String(port)], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "development",
        DATABASE_URL: "",
        MIGRATION_DATABASE_URL: "",
        BETTER_AUTH_URL: "",
        BETTER_AUTH_SECRET: "",
        OWNER_REF_SECRET: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    server.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });

    await waitForServer(`${baseUrl}/login`, server, () => output);
    browser = await chromium.launch({
      executablePath: chromeExecutable(),
      headless: true,
      args: ["--no-sandbox"],
    });
  }, 40_000);

  afterEach(async () => {
    await activeContext?.close();
    activeContext = undefined;
  });

  afterAll(async () => {
    await activeContext?.close();
    await browser?.close();
    if (server) await stop(server);
    if (originalNextEnv !== undefined) await writeFile(nextEnvPath, originalNextEnv);
  });

  async function newPage({
    width = 390,
    height = 844,
    clipboardWriteRejects = false,
  }: {
    width?: number;
    height?: number;
    clipboardWriteRejects?: boolean;
  } = {}): Promise<{ page: Page; consoleErrors: string[] }> {
    if (!browser) throw new Error("UI demo browser did not start");
    activeContext = await browser.newContext({ viewport: { width, height } });
    if (clipboardWriteRejects) {
      await activeContext.addInitScript(() => {
        let clipboardWriteAttempts = 0;
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: () => {
              clipboardWriteAttempts += 1;
              return Promise.reject(new DOMException("Clipboard permission denied", "NotAllowedError"));
            },
          },
        });
        Object.defineProperty(window, "__fitgridClipboardWriteAttempts", {
          configurable: true,
          get: () => clipboardWriteAttempts,
        });
      });
    }
    const page = await activeContext.newPage();
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    return { page, consoleErrors };
  }

  it("keeps invalid invitations public and removes every registration field", async () => {
    const { page, consoleErrors } = await newPage();
    await page.goto(`${baseUrl}/invite/invalid-demo-invitation-token-0001`, {
      waitUntil: "domcontentloaded",
    });

    await expect.poll(
      () => page.getByRole("heading", { name: "邀请无效或已失效" }).isVisible(),
      { timeout: 20_000 },
    )
      .toBe(true);
    expect(await page.getByLabel("用户名").count()).toBe(0);
    expect(await page.getByLabel("密码", { exact: true }).count()).toBe(0);
    expect(await page.getByLabel("确认密码").count()).toBe(0);
    const loginHref = await page.getByRole("link", { name: "前往登录" }).getAttribute("href");
    expect(loginHref).toBe(`${appBasePath}/login`);
    expectExactlyOneBasePrefix(new URL(loginHref!, baseUrl).pathname);
    await expectNoHorizontalOverflow(page);
    expect(consoleErrors).toEqual([]);
  }, 30_000);

  it("validates and accepts a valid invitation before navigating to login", async () => {
    const { page, consoleErrors } = await newPage();
    await page.goto(`${baseUrl}/invite/valid-demo-invitation-token-000001`, {
      waitUntil: "domcontentloaded",
    });
    await expect.poll(() => page.getByRole("heading", { name: "创建你的账户" }).isVisible())
      .toBe(true);

    await page.getByLabel("用户名").fill("ab");
    await page.getByLabel("密码", { exact: true }).fill("short");
    await page.getByLabel("确认密码").fill("different");
    await page.getByRole("button", { name: "创建账号" }).click();
    expect(await page.getByText("用户名长度必须为 3–64 个字符").isVisible()).toBe(true);
    expect(await page.getByText("密码长度必须为 12–128 个字符").isVisible()).toBe(true);
    expect(await page.getByText("两次输入的密码不一致").isVisible()).toBe(true);
    expect(page.url()).toBe(`${baseUrl}/invite/valid-demo-invitation-token-000001`);

    await page.getByLabel("用户名").fill("smoke.member");
    await page.getByLabel("密码", { exact: true }).fill("strong-password-1");
    await page.getByLabel("确认密码").fill("strong-password-1");
    await Promise.all([
      page.waitForURL(`${baseUrl}/login`),
      page.getByRole("button", { name: "创建账号" }).click(),
    ]);
    expectExactlyOneBasePrefix(new URL(page.url()).pathname);
    await expectNoHorizontalOverflow(page);
    expect(consoleErrors).toEqual([]);
  }, 30_000);

  it("covers security navigation, validation, and successful password change on mobile", async () => {
    const { page, consoleErrors } = await newPage();
    await page.goto(`${baseUrl}/grids`, { waitUntil: "domcontentloaded" });
    const securityLink = page.getByRole("link", { name: "安全设置" });
    const adminLink = page.getByRole("link", { name: "账号管理" });
    await expect.poll(() => securityLink.isVisible()).toBe(true);
    expect(await adminLink.isVisible()).toBe(true);
    expect(await securityLink.getAttribute("href")).toBe(`${appBasePath}/settings/security`);
    expect(await adminLink.getAttribute("href")).toBe(`${appBasePath}/admin`);

    await securityLink.click();
    await page.waitForURL(`${baseUrl}/settings/security`);
    await expect.poll(() => page.getByRole("heading", { name: "修改密码" }).isVisible()).toBe(true);
    await page.getByLabel("当前密码").fill("current-password");
    await page.getByLabel("新密码", { exact: true }).fill("short");
    await page.getByLabel("确认新密码").fill("different");
    await page.getByRole("button", { name: "修改密码" }).click();
    expect(await page.getByText("新密码长度必须为 12–128 个字符").isVisible()).toBe(true);
    expect(await page.getByText("两次输入的新密码不一致").isVisible()).toBe(true);

    await page.getByLabel("新密码", { exact: true }).fill("next-password-1");
    await page.getByLabel("确认新密码").fill("next-password-1");
    await page.getByRole("button", { name: "修改密码" }).click();
    await expect.poll(() => page.getByText("密码已更新，其他设备的会话已撤销").isVisible())
      .toBe(true);
    expect(await page.getByLabel("当前密码").count()).toBe(0);
    await expectTopNavigation(page);
    await expectNoHorizontalOverflow(page);
    expect(consoleErrors).toEqual([]);
  }, 30_000);

  it("creates an invitation with manual-copy fallback and confirms one status change", async () => {
    const { page, consoleErrors } = await newPage({
      width: 1440,
      height: 900,
      clipboardWriteRejects: true,
    });
    await page.goto(`${baseUrl}/admin`, { waitUntil: "domcontentloaded" });
    await expect.poll(() => page.getByRole("heading", { name: "账号管理" }).isVisible())
      .toBe(true);
    await expect.poll(() => page.locator("tbody tr").count()).toBe(3);
    expect(await page.getByText("管理员权限已验证").isVisible()).toBe(true);
    expect(await page.getByText(/产品数量/).count()).toBe(0);
    expect(await page.getByRole("button", { name: /查看产品/ }).count()).toBe(0);

    await page.getByRole("button", { name: "创建邀请" }).click();
    const invitationInput = page.getByLabel("新邀请链接");
    await expect.poll(() => invitationInput.isVisible()).toBe(true);
    const invitationUrl = await invitationInput.inputValue();
    const invitationPath = new URL(invitationUrl).pathname;
    expect(invitationPath).toMatch(new RegExp(`^${appBasePath}/invite/demo-admin-invitation-\\d+$`));
    expectExactlyOneBasePrefix(invitationPath);
    expect(await page.evaluate(() => typeof navigator.clipboard?.writeText)).toBe("function");

    await page.getByRole("button", { name: "复制邀请链接" }).click();
    const manualCopyAlert = page.getByText("无法自动复制，请选中上方链接并手动复制。");
    await expect.poll(() => manualCopyAlert.isVisible()).toBe(true);
    expect(await page.evaluate(() => (
      window as Window & { __fitgridClipboardWriteAttempts?: number }
    ).__fitgridClipboardWriteAttempts)).toBe(1);
    expect(await invitationInput.evaluate((input) => ({
      active: document.activeElement === input,
      end: (input as HTMLInputElement).selectionEnd,
      length: (input as HTMLInputElement).value.length,
      start: (input as HTMLInputElement).selectionStart,
    }))).toEqual({ active: true, start: 0, end: invitationUrl.length, length: invitationUrl.length });

    const memberRow = page.locator("tbody tr").filter({ hasText: "ledger.operator" });
    expect(await memberRow.locator("td").nth(2).textContent()).toBe("启用");
    await memberRow.getByRole("button", { name: "禁用 ledger.operator" }).click();
    const dialog = page.getByRole("dialog", { name: "确认禁用账号" });
    expect(await dialog.isVisible()).toBe(true);
    expect(await memberRow.locator("td").nth(2).textContent()).toBe("启用");
    await dialog.getByRole("button", { name: "确认禁用" }).click();
    await expect.poll(() => dialog.count()).toBe(0);
    await expect.poll(() => memberRow.locator("td").nth(2).textContent()).toBe("禁用");
    expect(await memberRow.getByRole("button", { name: "启用 ledger.operator" }).isEnabled())
      .toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    await expectTopNavigation(page);
    await expectNoHorizontalOverflow(page);
    expect(await page.getByRole("button", { name: "创建新邀请" }).isEnabled()).toBe(true);
    expect(consoleErrors).toEqual([]);
  }, 30_000);

  it("retains the complete grid workflow at desktop and mobile breakpoints", async () => {
    const { page, consoleErrors } = await newPage();
    await page.goto(`${baseUrl}/login`, { waitUntil: "networkidle" });
    const ladder = await page.locator("svg").first().boundingBox();
    const heading = await page.getByRole("heading", { name: /让每一道网格\s*都有清晰依据/ }).boundingBox();
    expect(ladder).not.toBeNull();
    expect(heading).not.toBeNull();
    expect(ladder!.y + ladder!.height).toBeLessThanOrEqual(heading!.y);

    await page.getByLabel("用户名").fill("demo");
    await page.getByLabel("密码").fill("fitgrid-demo");
    await Promise.all([
      page.waitForURL(`${baseUrl}/grids`),
      page.getByRole("button", { name: "登录工作台" }).click(),
    ]);
    await expect.poll(() => page.getByText("已载入 20 项", { exact: false }).count()).toBe(1);
    const expectedImportHref = `${appBasePath}/grids/import`;
    expect(await page.getByRole("link", { name: "导入数据" }).getAttribute("href"))
      .toBe(expectedImportHref);
    expectExactlyOneBasePrefix(expectedImportHref);
    const exportPaths: string[] = [];
    await page.route("**/api/v1/grid-trades/export?format=*", async (route) => {
      const requestUrl = new URL(route.request().url());
      exportPaths.push(`${requestUrl.pathname}${requestUrl.search}`);
      const format = requestUrl.searchParams.get("format");
      await route.fulfill({
        body: JSON.stringify({ format }),
        contentType: "application/json",
        headers: {
          "Content-Disposition": `attachment; filename="fitgridweb-${format}-2026-09-03.json"`,
        },
        status: 200,
      });
    });
    await page.getByRole("button", { name: "数据备份" }).click();
    const backupDialog = page.getByRole("dialog", { name: "数据备份" });
    expect(await backupDialog.isVisible()).toBe(true);
    expect(await backupDialog.getByRole("button", { name: "下载 Android 兼容 JSON" }).isVisible())
      .toBe(true);
    expect(await backupDialog.getByRole("button", { name: "下载 Web 完整备份" }).isVisible())
      .toBe(true);
    await backupDialog.getByRole("button", { name: "下载 Android 兼容 JSON" }).click();
    await expect.poll(() => backupDialog.getByRole("button", { name: "下载 Android 兼容 JSON" }).isEnabled())
      .toBe(true);
    await backupDialog.getByRole("button", { name: "下载 Web 完整备份" }).click();
    await expect.poll(() => backupDialog.getByRole("button", { name: "下载 Web 完整备份" }).isEnabled())
      .toBe(true);
    expect(exportPaths).toEqual([
      `${appBasePath}/api/v1/grid-trades/export?format=android`,
      `${appBasePath}/api/v1/grid-trades/export?format=web`,
    ]);
    for (const exportPath of exportPaths) expectExactlyOneBasePrefix(exportPath);
    await backupDialog.getByRole("button", { name: "关闭数据备份" }).click();
    await expect.poll(() => backupDialog.count()).toBe(0);

    await expectTopNavigation(page);
    await expectNoHorizontalOverflow(page);
    const rows = page.locator("tbody tr");
    await expect.poll(() => rows.count()).toBe(20);
    expect(await page.locator("thead th:visible").allTextContents()).toEqual([
      "产品名称",
      "产品代码",
      "最高价",
      "每份金额",
    ]);
    await page.getByRole("searchbox", { name: "搜索产品名称或代码" }).fill("518880");
    await expect.poll(() => rows.count()).toBe(1);
    await expect(page.getByRole("cell", { name: "黄金 ETF" }).count()).resolves.toBe(1);
    await page.getByRole("button", { name: "清除搜索" }).click();
    await expect.poll(() => rows.count()).toBe(20);
    await page.getByRole("button", { name: "加载更多" }).click();
    await expect.poll(() => rows.count()).toBe(24);

    await page.getByRole("button", { name: "刷新" }).click();
    await expect.poll(() => page.getByRole("status", { name: "正在刷新…" }).count()).toBe(1);
    await expect.poll(() => page.getByRole("status", { name: "正在刷新…" }).count()).toBe(0);
    await page.getByRole("cell", { name: "518880", exact: true }).click();
    await page.waitForURL(`${baseUrl}/grids/demo-grid-01`);
    const mobileBackHref = await page.getByRole("link", { name: "返回网格产品" }).getAttribute("href");
    expect(mobileBackHref).toBe(`${appBasePath}/grids`);
    expectExactlyOneBasePrefix(new URL(mobileBackHref!, baseUrl).pathname);
    const gridRowPalette = async (size: "small" | "medium" | "large") => (
      page.locator(`tbody tr[data-grid-size="${size}"]`).evaluate((row) => ({
        backgrounds: Array.from(row.querySelectorAll("td")).map(
          (cell) => window.getComputedStyle(cell).backgroundColor,
        ),
        labelColor: window.getComputedStyle(row.querySelector("td:nth-child(2) span")!).color,
      }))
    );
    const smallPalette = await gridRowPalette("small");
    const mediumPalette = await gridRowPalette("medium");
    const largePalette = await gridRowPalette("large");
    expect(new Set(mediumPalette.backgrounds).size).toBe(1);
    expect(new Set(largePalette.backgrounds).size).toBe(1);
    expect(mediumPalette.backgrounds[0]).not.toBe(smallPalette.backgrounds[0]);
    expect(largePalette.backgrounds[0]).not.toBe(smallPalette.backgrounds[0]);
    expect(mediumPalette.backgrounds[0]).not.toBe(largePalette.backgrounds[0]);
    expect(mediumPalette.labelColor).toBe("rgb(56, 189, 248)");
    expect(largePalette.labelColor).toBe("rgb(242, 201, 76)");
    const mediumRow = page.locator('tbody tr[data-grid-size="medium"]');
    const mediumDefaultBackground = mediumPalette.backgrounds[0];
    await mediumRow.locator("td").first().click();
    const mediumSelectedBackground = await mediumRow.locator("td").first().evaluate(
      (cell) => window.getComputedStyle(cell).backgroundColor,
    );
    expect(mediumSelectedBackground).not.toBe(mediumDefaultBackground);
    await page.getByRole("button", { name: "关闭" }).click();
    const firstCalculationRow = page.getByRole("button", { name: "查看第 1 笔明细" }).locator("xpath=ancestor::tr");
    expect(await firstCalculationRow.locator('[data-trade-side="buy"]').first().getAttribute("data-trade-side"))
      .toBe("buy");
    expect(await firstCalculationRow.locator('[data-trade-side="sell"]').first().getAttribute("data-trade-side"))
      .toBe("sell");
    await firstCalculationRow.locator('[data-trade-side="sell"]').first().click();
    const mobileInspector = page.getByRole("dialog", { name: "网格行明细" });
    expect(await mobileInspector.isVisible()).toBe(true);
    expect(await mobileInspector.textContent()).toContain("1 / 3");
    expect(await mobileInspector.locator('[data-trade-side="buy"]').count()).toBeGreaterThan(0);
    expect(await mobileInspector.locator('[data-trade-side="sell"]').count()).toBeGreaterThan(0);
    await page.getByRole("button", { name: "关闭" }).click();
    await expect.poll(() => mobileInspector.count()).toBe(0);
    await page.getByRole("link", { name: /网格产品 \/ 518880/ }).click();
    await page.waitForURL(`${baseUrl}/grids`);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(() => page.locator("tbody tr").count()).toBe(20);
    expect(await page.getByRole("table", { name: "网格产品" }).isVisible()).toBe(true);
    expect(await page.locator("thead th:visible").allTextContents()).toEqual([
      "产品名称",
      "产品代码",
      "方向",
      "最高价",
      "每份金额",
      "更新时间",
    ]);
    const directionFontSize = await page.getByText("做多", { exact: true }).first().evaluate(
      (element) => Number.parseFloat(window.getComputedStyle(element).fontSize),
    );
    expect(directionFontSize).toBeGreaterThanOrEqual(14);

    await page.getByRole("link", { name: "新建产品" }).click();
    await page.waitForURL(`${baseUrl}/grids/new`);
    expect(await page.getByRole("link", { name: "返回网格产品" }).getAttribute("href"))
      .toBe(`${appBasePath}/grids`);
    await page.getByLabel("产品名称").fill("Smoke 新建产品");
    await page.getByLabel("产品代码").fill("SMOKE-NEW-01");
    await Promise.all([
      page.waitForURL(`${baseUrl}/grids/demo-grid-created-01`),
      page.getByRole("button", { name: "创建产品" }).click(),
    ]);
    await expect.poll(() => (
      page.getByRole("heading", { name: "Smoke 新建产品" }).isVisible()
    )).toBe(true);

    await page.getByRole("link", { name: "编辑产品" }).click();
    await page.waitForURL(`${baseUrl}/grids/demo-grid-created-01/edit`);
    expect(await page.getByRole("link", { name: "返回产品详情" }).getAttribute("href"))
      .toBe(`${appBasePath}/grids/demo-grid-created-01`);
    await page.getByLabel("产品名称").fill("Smoke 编辑产品");
    await Promise.all([
      page.waitForURL(`${baseUrl}/grids/demo-grid-created-01`),
      page.getByRole("button", { name: "保存修改" }).click(),
    ]);
    await expect.poll(() => (
      page.getByRole("heading", { name: "Smoke 编辑产品" }).isVisible()
    )).toBe(true);

    await page.getByRole("button", { name: "删除产品" }).click();
    await page.getByLabel("输入产品代码确认").fill("SMOKE-NEW-01");
    await Promise.all([
      page.waitForURL(`${baseUrl}/grids`),
      page.getByRole("button", { name: "确认永久删除" }).click(),
    ]);
    await expect.poll(() => page.getByRole("link", { name: "Smoke 编辑产品" }).count()).toBe(0);

    await page.getByRole("link", { name: "黄金 ETF" }).click();
    await page.waitForURL(`${baseUrl}/grids/demo-grid-01`);
    const accountBarBox = await page.getByRole("banner").boundingBox();
    const desktopBackBox = await page.getByRole("link", { name: "返回网格产品" }).boundingBox();
    expect(accountBarBox).not.toBeNull();
    expect(desktopBackBox).not.toBeNull();
    expect(Math.round(desktopBackBox!.x - accountBarBox!.x)).toBe(12);
    await page.getByRole("button", { name: "查看第 1 笔明细" }).click();
    expect(await page.getByRole("dialog", { name: "网格行明细" }).isVisible()).toBe(true);
    await page.getByRole("button", { name: "关闭" }).click();
    await page.getByRole("button", { name: "重新计算" }).click();
    await expect.poll(() => page.getByRole("status", { name: "正在计算…" }).count()).toBe(0);
    await page.getByRole("button", { name: "删除产品" }).click();
    await page.getByLabel("输入产品代码确认").fill("518880");
    await Promise.all([
      page.waitForURL(`${baseUrl}/grids`),
      page.getByRole("button", { name: "确认永久删除" }).click(),
    ]);
    await expect.poll(() => page.getByRole("link", { name: "黄金 ETF" }).count()).toBe(0);

    await page.getByRole("button", { name: "退出登录" }).click();
    await page.waitForURL(`${baseUrl}/login`);
    await expect.poll(() => page.getByLabel("用户名").inputValue()).toBe("demo");
    expect(await page.getByLabel("密码").inputValue()).toBe("");
    expect(consoleErrors).toEqual([]);
  }, 60_000);
});
