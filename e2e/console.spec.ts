import { expect, test } from "@playwright/test";
import type { ApiProblem, ConsoleSnapshot } from "../src/lib/contract";

test("spin up, spin down, spin up again and destroy, at phone width", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("No containers yet.")).toBeVisible();
  await expect(page.getByText("Read-only until unlocked.")).toBeVisible();

  await test.step("a visitor without the passphrase cannot write", async () => {
    const response = await page.request.post("/api/containers", { data: { operationId: "aaaaaaaa", imageId: "nginx" } });
    expect(response.status()).toBe(401);
  });

  await test.step("unlock", async () => {
    await page.getByLabel("Passphrase").fill("not the passphrase");
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByText("That passphrase is not right.")).toBeVisible();

    await page.getByLabel("Passphrase").fill("demo");
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByRole("button", { name: "Lock", exact: true })).toBeVisible();
  });

  const card = page.getByRole("article");
  const chip = (label: string) => card.getByText(label, { exact: true });

  await test.step("spin up shows what Railway reports until it is running", async () => {
    await page.getByLabel("Image").selectOption({ label: "caddy:alpine" });
    await page.locator("form").getByRole("button", { name: "Spin up" }).click();
    await expect(chip("Starting")).toBeVisible();
    await expect(card.getByText(/Railway reports (INITIALIZING|DEPLOYING) · stopped yes/)).toBeVisible();
    await expect(card.getByText("caddy:alpine")).toBeVisible();
  });

  await test.step("a refusal reaches the browser as the server's reason, not as a server error", async () => {
    // Sent from inside the page so it carries the session cookie exactly as the app's own requests do.
    const refusal = await page.evaluate(async () => {
      const snapshot = (await (await fetch("/api/state")).json()) as ConsoleSnapshot;
      const response = await fetch(`/api/containers/${snapshot.containers[0].id}/stop`, { method: "POST" });
      return { status: response.status, body: (await response.json()) as { problem: ApiProblem } };
    });
    expect(refusal.status).toBe(409);
    expect(refusal.body.problem.message).toBe("Wait until it is running.");
    await expect(card.getByText("Wait until it is running.")).toBeVisible();
  });

  await test.step("a refresh in the middle of the deploy loses nothing", async () => {
    await page.reload();
    await expect(card).toHaveCount(1);
    await expect(chip("Running")).toBeVisible({ timeout: 20_000 });
    await expect(card.getByRole("link")).toHaveAttribute("href", /^https:\/\/spin-[a-z0-9]{8}-production\.up\.railway\.app$/);
  });

  await test.step("spin down says accepted, then shows stopped when Railway reports it", async () => {
    await card.getByRole("button", { name: "Spin down" }).click();
    await expect(card.getByText(/Spin down accepted .* Waiting for Railway to report it\./)).toBeVisible();
    await expect(chip("Stopped")).toBeVisible({ timeout: 10_000 });
    await expect(card.getByText("Railway reports SUCCESS · stopped yes · EXITED")).toBeVisible();
  });

  await test.step("spin up again resumes the same container", async () => {
    const name = await card.getByRole("heading").textContent();
    await card.getByRole("button", { name: "Spin up" }).click();
    await expect(chip("Running")).toBeVisible({ timeout: 10_000 });
    await expect(card.getByRole("heading")).toHaveText(name!);
  });

  await test.step("the page fits a phone without sideways scrolling", async () => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  await test.step("destroy needs a second tap, then the container is gone", async () => {
    await card.getByRole("button", { name: "Destroy" }).click();
    await expect(card).toHaveCount(1);
    await card.getByRole("button", { name: "Tap again to destroy" }).click();
    await expect(page.getByText("No containers yet.")).toBeVisible();
  });

  await test.step("lock again", async () => {
    await page.getByRole("button", { name: "Lock", exact: true }).click();
    await expect(page.getByText("Read-only until unlocked.")).toBeVisible();
  });
});
