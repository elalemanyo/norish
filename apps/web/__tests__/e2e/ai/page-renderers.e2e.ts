/**
 * The Page Renderers card (ADR-0019): what an administrator saves is what the next visit shows,
 * the stored CDP token never reaches the browser in full, and it is kept only for its own endpoint.
 * The harness runs no Obscura or solver, so how pages render stays in the unit seam.
 */
import type { Page } from "@playwright/test";

import type { PageRenderersConfig } from "@norish/config/zod/server-config";

import type { AIE2EStack } from "./fixture";
import { callTrpc, submitMutation } from "../harness/trpc";
import { expect, test } from "./fixture";

const CDP_TOKEN = "e2e-cdp-token-that-must-never-be-shown";
const ENDPOINT = "wss://obscura.e2e:9222";
const KEEPS_TOKEN_HINT = "Leave empty to keep the saved value.";

let before: PageRenderersConfig;

const readSetting = (aiStack: AIE2EStack) =>
  callTrpc<PageRenderersConfig>(aiStack.baseURL, aiStack.ownerCookies, "admin.getPageRenderers");

const cardOf = (page: Page) => page.getByTestId("page-renderers-card");

const saveCard = (page: Page) =>
  submitMutation(page, "admin.updatePageRenderers", () =>
    cardOf(page).getByRole("button", { name: "Save" }).click()
  );

test.beforeEach(async ({ aiStack, page }) => {
  before = await readSetting(aiStack);
  await callTrpc(aiStack.baseURL, aiStack.ownerCookies, "admin.updatePageRenderers", {
    ...before,
    obscura: { enabled: true, endpoint: ENDPOINT, cdpToken: CDP_TOKEN },
    solver: { enabled: false },
  });

  await page.goto("/settings?tab=admin");
  await cardOf(page).scrollIntoViewIfNeeded();
  await expect(cardOf(page).getByLabel("Obscura endpoint")).toHaveValue(ENDPOINT);
  await expect(cardOf(page).getByText(KEEPS_TOKEN_HINT)).toBeVisible();
});

test.afterEach(async ({ aiStack }) => {
  await callTrpc(aiStack.baseURL, aiStack.ownerCookies, "admin.updatePageRenderers", before);
});

test("an administrator switches the solver on, saves, and keeps the CDP token unseen", async ({
  aiStack,
  page,
}) => {
  const card = cardOf(page);

  await card.getByRole("switch", { name: "FlareSolverr or Byparr" }).press("Space");
  await card.getByLabel("Solver endpoint").fill("https://solver.e2e:8191/v1");
  await saveCard(page);

  await page.reload();
  await card.scrollIntoViewIfNeeded();

  await expect(card.getByLabel("Obscura endpoint")).toHaveValue(ENDPOINT);
  await expect(card.getByRole("switch", { name: "FlareSolverr or Byparr" })).toBeChecked();
  await expect(card.getByLabel("Solver endpoint")).toHaveValue("https://solver.e2e:8191/v1");
  await expect(card.getByLabel("CDP token")).toHaveValue("");
  expect(await page.content()).not.toContain(CDP_TOKEN);

  // The save sent no token for the same endpoint, so the stored one is kept.
  expect((await readSetting(aiStack)).obscura.cdpToken).toBe("••••••••");
});

test("a new Obscura endpoint saved without a token drops the stored one", async ({
  aiStack,
  page,
}) => {
  const card = cardOf(page);

  await card.getByLabel("Obscura endpoint").fill("wss://browser.e2e:9333");
  // The field stops promising a token the server is about to drop.
  await expect(card.getByText(KEEPS_TOKEN_HINT)).toHaveCount(0);
  await saveCard(page);

  const saved = await readSetting(aiStack);

  expect(saved.obscura.endpoint).toBe("wss://browser.e2e:9333");
  expect(saved.obscura.cdpToken).toBeUndefined();
});

test("an administrator clears the CDP token from the card", async ({ aiStack, page }) => {
  const card = cardOf(page);

  await card.getByRole("button", { name: "Clear" }).click();
  await expect(card.getByText(KEEPS_TOKEN_HINT)).toHaveCount(0);
  await saveCard(page);

  const saved = await readSetting(aiStack);

  expect(saved.obscura.endpoint).toBe(ENDPOINT);
  expect(saved.obscura.cdpToken).toBeUndefined();
});
