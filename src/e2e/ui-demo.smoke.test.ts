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
  const baseUrl = `http://127.0.0.1:${port}`;
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

    const banner = await page.getByRole("banner").boundingBox();
    const navigation = await page.getByRole("navigation", { name: "主导航" }).boundingBox();
    const main = await page.getByRole("main").boundingBox();
    expect(banner).not.toBeNull();
    expect(navigation).not.toBeNull();
    expect(main).not.toBeNull();
    expect(banner!.y + banner!.height).toBeLessThanOrEqual(navigation!.y + 1);
    expect(navigation!.y + navigation!.height).toBeLessThanOrEqual(main!.y + 1);

    const cards = page.getByRole("list", { name: "网格产品卡片" }).locator(":scope > li");
    await expect.poll(() => cards.count()).toBe(20);
    await page.getByRole("searchbox", { name: "搜索产品名称或代码" }).fill("518880");
    await expect.poll(() => cards.count()).toBe(1);
    await expect(page.getByRole("heading", { name: "黄金 ETF" }).count()).resolves.toBe(1);
    await page.getByRole("button", { name: "清除搜索" }).click();
    await expect.poll(() => cards.count()).toBe(20);
    await page.getByRole("button", { name: "加载更多" }).click();
    await expect.poll(() => cards.count()).toBe(24);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(() => page.locator("tbody tr").count()).toBe(20);
    expect(await page.getByRole("table", { name: "网格产品" }).isVisible()).toBe(true);
    expect(await page.getByRole("list", { name: "网格产品卡片" }).isVisible()).toBe(false);
    expect(consoleErrors).toEqual([]);
  } finally {
    await browser?.close();
    await stop(child);
    await writeFile(nextEnvPath, originalNextEnv);
  }
}, 60_000);
