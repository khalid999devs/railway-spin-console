/**
 * Live smoke test: drives the deployed app in a fresh browser, at desktop and
 * phone width, through the whole lifecycle against real Railway, and prints a
 * table of what happened and how long each step took.
 *
 *   node scripts/smoke.mts https://<app>.up.railway.app
 *
 * The passphrase is read from CONSOLE_PASSPHRASE (environment or .env.local)
 * and never printed. Each pass creates one container and destroys it.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices, type Page } from "@playwright/test";

const ROOT = join(import.meta.dirname, "..");
if (existsSync(join(ROOT, ".env.local"))) process.loadEnvFile(join(ROOT, ".env.local"));

const baseURL = process.argv[2]?.replace(/\/$/, "");
const passphrase = process.env.CONSOLE_PASSPHRASE;
if (!baseURL || !passphrase) throw new Error("usage: node scripts/smoke.mts <url>, with CONSOLE_PASSPHRASE set");

const VIEWPORTS = [
  { name: "Desktop, 1280 px", options: { viewport: { width: 1280, height: 800 } } },
  { name: "Phone, 412 px (Pixel 7)", options: devices["Pixel 7"] },
];
const SCREENSHOT = join(ROOT, "docs", "screenshot.png");

interface Row {
  step: string;
  seconds: string;
  result: string;
}

/** Whether the container's own URL answers, asked from this machine and not through the app. */
async function answers(url: string): Promise<string> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: "manual" });
    return `HTTP ${response.status}`;
  } catch {
    return "no answer within 8 s";
  }
}

async function pass(page: Page, takeScreenshot: boolean): Promise<Row[]> {
  const rows: Row[] = [];
  const timed = async (step: string, action: () => Promise<string>) => {
    const startedAt = Date.now();
    const result = await action();
    rows.push({ step, seconds: ((Date.now() - startedAt) / 1000).toFixed(1), result });
  };
  const card = page.getByRole("article");
  const chip = (label: string) => card.getByText(label, { exact: true });
  const reported = async () => (await card.locator("p", { hasText: "Railway reports:" }).innerText()).replace("Railway reports: ", "");

  await timed("Open the page", async () => {
    await page.goto(baseURL!);
    await page.getByText("Read-only.").waitFor();
    return `locked, ${await page.getByRole("article").count()} containers`;
  });

  await timed("Unlock with the passphrase", async () => {
    await page.getByRole("button", { name: "Unlock to spin up" }).click();
    await page.getByLabel("Passphrase").fill(passphrase!);
    await page.getByRole("button", { name: "Unlock", exact: true }).click();
    await page.getByText("Unlocked.").waitFor();
    return "unlocked";
  });

  await timed("Spin up (double click) until the card appears", async () => {
    await page.getByRole("button", { name: "Spin up" }).dblclick();
    await card.first().waitFor();
    return `${await card.count()} container, ${await card.getByRole("heading").innerText()}`;
  });

  await timed("Refresh the page mid-deploy", async () => {
    await page.reload();
    await card.first().waitFor();
    return `${await card.count()} container still listed`;
  });

  await timed("Wait until Railway reports running", async () => {
    await chip("Running").waitFor({ timeout: 90_000 });
    return reported();
  });

  const url = (await card.getByRole("link").getAttribute("href"))!;
  await timed("Request the container's own URL", () => answers(url));
  if (takeScreenshot) await page.screenshot({ path: SCREENSHOT, fullPage: true });

  await timed("Spin down until Railway reports stopped", async () => {
    await card.getByRole("button", { name: "Spin down" }).click();
    await chip("Stopped").waitFor({ timeout: 60_000 });
    return reported();
  });
  await timed("Request the URL while stopped", () => answers(url));

  await timed("Spin up again until Railway reports running", async () => {
    await card.getByRole("button", { name: "Spin up" }).click();
    await chip("Running").waitFor({ timeout: 60_000 });
    return reported();
  });
  await timed("Request the URL again", () => answers(url));

  await timed("Destroy (two taps) until the card is gone", async () => {
    await card.getByRole("button", { name: "Destroy" }).click();
    await card.getByRole("button", { name: "Tap again to destroy" }).click();
    await page.getByText("Nothing is running.").waitFor({ timeout: 60_000 });
    return "0 containers";
  });

  return rows;
}

const browser = await chromium.launch();
console.log(`Smoke test of ${baseURL} on ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC\n`);
let failed = false;

for (const [index, viewport] of VIEWPORTS.entries()) {
  // A new context each time: no cookies, no cache, like a visitor arriving for the first time.
  const context = await browser.newContext(viewport.options);
  const page = await context.newPage();
  console.log(`**${viewport.name}**\n\n| Step | Seconds | Result |\n|---|---|---|`);
  try {
    for (const row of await pass(page, index === VIEWPORTS.length - 1)) console.log(`| ${row.step} | ${row.seconds} | ${row.result} |`);
  } catch (error) {
    failed = true;
    console.log(`\nFAILED: ${(error as Error).message.split("\n")[0]}`);
  }
  console.log("");
  await context.close();
}
await browser.close();

const state = (await (await fetch(`${baseURL}/api/state`)).json()) as { containers: unknown[]; budget: { used: number; limit: number } };
console.log(`Afterwards the sandbox holds ${state.containers.length} containers. Railway requests in the last hour: ${state.budget.used} of ${state.budget.limit}.`);
if (failed || state.containers.length > 0) process.exitCode = 1;
