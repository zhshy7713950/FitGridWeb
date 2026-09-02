import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";

import { chromium, type Browser } from "playwright-core";
import { expect, it } from "vitest";

const nextEnvPath = new URL("../../next-env.d.ts", import.meta.url);

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
  const deadline = Date.now() + 20_000;
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

it("runs the complete database-free UI demo at desktop and mobile breakpoints", async () => {
  const port = await availablePort();
  const appBasePath = process.env.NEXT_BASE_PATH === "/fitgrid" ? "/fitgrid" : "";
  const baseUrl = `http://127.0.0.1:${port}${appBasePath}`;
  const originalNextEnv = await readFile(nextEnvPath, "utf8");
  let output = "";
  let browser: Browser | undefined;
  const child = spawn("pnpm", ["run", "dev:ui", "--port", String(port)], {
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
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });

  try {
    await waitForServer(`${baseUrl}/login`, child, () => output);
    browser = await chromium.launch({
      executablePath: chromeExecutable(),
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
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
    expect(expectedImportHref).not.toContain("/fitgrid/fitgrid");

    const banner = await page.getByRole("banner").boundingBox();
    const navigation = await page.getByRole("navigation", { name: "主导航" }).boundingBox();
    const main = await page.getByRole("main").boundingBox();
    expect(banner).not.toBeNull();
    expect(navigation).not.toBeNull();
    expect(main).not.toBeNull();
    expect(banner!.y + banner!.height).toBeLessThanOrEqual(navigation!.y + 1);
    expect(navigation!.y + navigation!.height).toBeLessThanOrEqual(main!.y + 1);
    expect(await page.getByRole("navigation", { name: "主导航" }).evaluate(
      (element) => window.getComputedStyle(element).position,
    )).not.toBe("fixed");

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

    await page.getByRole("link", { name: "黄金 ETF" }).click();
    await page.waitForURL(`${baseUrl}/grids/demo-grid-01`);
    await page.getByRole("button", { name: "查看第 1 笔明细" }).click();
    const mobileInspector = page.getByRole("dialog", { name: "网格行明细" });
    expect(await mobileInspector.isVisible()).toBe(true);
    expect(await mobileInspector.textContent()).toContain("1 / 3");
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
    await page.getByLabel("产品名称").fill("Smoke 新建产品");
    await page.getByLabel("产品代码").fill("SMOKE-NEW-01");
    await Promise.all([
      page.waitForURL(`${baseUrl}/grids/demo-grid-created-01`),
      page.getByRole("button", { name: "创建产品" }).click(),
    ]);
    expect(await page.getByRole("heading", { name: "Smoke 新建产品" }).isVisible()).toBe(true);

    await page.getByRole("link", { name: "编辑产品" }).click();
    await page.waitForURL(`${baseUrl}/grids/demo-grid-created-01/edit`);
    await page.getByLabel("产品名称").fill("Smoke 编辑产品");
    await Promise.all([
      page.waitForURL(`${baseUrl}/grids/demo-grid-created-01`),
      page.getByRole("button", { name: "保存修改" }).click(),
    ]);
    expect(await page.getByRole("heading", { name: "Smoke 编辑产品" }).isVisible()).toBe(true);

    await page.getByRole("button", { name: "删除产品" }).click();
    await page.getByLabel("输入产品代码确认").fill("SMOKE-NEW-01");
    await Promise.all([
      page.waitForURL(`${baseUrl}/grids`),
      page.getByRole("button", { name: "确认永久删除" }).click(),
    ]);
    await expect.poll(() => page.getByRole("link", { name: "Smoke 编辑产品" }).count()).toBe(0);

    await page.getByRole("link", { name: "黄金 ETF" }).click();
    await page.waitForURL(`${baseUrl}/grids/demo-grid-01`);
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

    const accountEmpty = page.getByRole("region", { name: "账号产品空状态" });
    while (true) {
      await expect.poll(async () => (
        await page.locator("tbody tr").count() + await accountEmpty.count()
      )).toBeGreaterThan(0);
      if (await accountEmpty.count()) break;
      const firstRow = page.locator("tbody tr").first();
      const productCode = (await firstRow.locator("td").nth(1).textContent())?.trim();
      if (!productCode) throw new Error("Demo product row is missing its product code");
      await firstRow.getByRole("link").click();
      await page.getByRole("button", { name: "删除产品" }).click();
      await page.getByLabel("输入产品代码确认").fill(productCode);
      await Promise.all([
        page.waitForURL(`${baseUrl}/grids`),
        page.getByRole("button", { name: "确认永久删除" }).click(),
      ]);
    }

    expect(await accountEmpty.count()).toBe(1);
    expect(await accountEmpty.getByRole("link", { name: "导入数据" }).getAttribute("href"))
      .toBe(expectedImportHref);
    const finalImportHrefs = await page.getByRole("link", { name: "导入数据" }).evaluateAll(
      (links) => links.map((link) => link.getAttribute("href")),
    );
    expect(finalImportHrefs).toEqual([expectedImportHref, expectedImportHref]);
    expect(finalImportHrefs.join(" ")).not.toContain("/fitgrid/fitgrid");

    await page.getByRole("button", { name: "退出登录" }).click();
    await page.waitForURL(`${baseUrl}/login`);
    await expect.poll(() => page.getByLabel("用户名").inputValue()).toBe("demo");
    expect(await page.getByLabel("密码").inputValue()).toBe("");
    expect(consoleErrors).toEqual([]);
  } finally {
    await browser?.close();
    await stop(child);
    await writeFile(nextEnvPath, originalNextEnv);
  }
}, 60_000);
