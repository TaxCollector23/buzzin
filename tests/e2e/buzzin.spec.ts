import { expect, test } from "@playwright/test";

test("classic home and join screens are available", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByText("The simple online buzzer system!")).toBeVisible();
  await expect(page.getByRole("button", { name: "JOIN" })).toBeVisible();
  await expect(page.getByRole("button", { name: "HOST" })).toBeVisible();

  await page.getByRole("button", { name: "JOIN" }).click();
  await page.getByLabel("Game Code:").fill("123456");
  await page.getByLabel("Your Nickname:").fill("Rangan");
  await page.getByRole("button", { name: "Join!" }).click();
  await expect(page).toHaveURL(/play\/123456/);
});

test("host and player share a live one-buzz room", async ({ page, browser }) => {
  await page.goto("./");
  await page.getByRole("button", { name: "HOST" }).click();
  await page.getByRole("button", { name: "Playoff Rules" }).click();
  await expect(page.locator(".game-code")).toContainText("Game Code:");
  const codeText = await page.locator(".game-code strong").textContent();
  const code = codeText?.trim() ?? "";
  expect(code).toMatch(/^\d{6}$/);

  const player = await browser.newPage();
  await player.goto("./join");
  await player.getByLabel("Game Code:").fill(code);
  await player.getByLabel("Your Nickname:").fill("Rangan");
  await player.getByRole("button", { name: "Join!" }).click();
  await expect(player.locator(".buzzer")).toHaveText("BUZZ", { timeout: 10_000 });
  await expect(page.getByText("Rangan", { exact: true })).toBeVisible({ timeout: 10_000 });

  await player.locator(".buzzer").click();
  await expect(player.locator(".buzzer")).toHaveText("BUZZED");
  await expect(page.getByRole("heading", { name: "Buzzed Players:", exact: true })).toBeVisible();
  await expect(page.getByText("Rangan", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Scores:", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "+4", exact: true }).click();
  await expect(page.locator(".score-label")).toContainText("4");
  await expect(page.getByRole("heading", { name: "Scores:", exact: true })).toBeVisible();
  await expect(page.locator(".scoreboard-name").first()).toHaveText("Rangan");

  await page.getByRole("button", { name: "Clear Buzzers" }).click();
  await expect(player.locator(".buzzer")).toHaveText("BUZZ");
  await player.close();
});
