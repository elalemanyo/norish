/**
 * Page Renderers (ADR-0019). The card: what an administrator saves is what the next visit shows,
 * the stored CDP token never reaches the browser in full, and it is kept only for its own endpoint.
 * The Chromium browser: the runner's own Chromium, started with a DevTools port, reads a recipe
 * behind a bot check that the plain fetch cannot. The harness runs no Obscura or solver.
 */
import type { Browser, Page } from "@playwright/test";
import { chromium } from "@playwright/test";

import type { PageRenderersConfig } from "@norish/config/zod/server-config";

import type { RecipeSite } from "../harness/recipe-site";
import type { AIE2EStack } from "./fixture";
import { freeHostPort } from "../harness/production-stack";
import { serveRecipeSite } from "../harness/recipe-site";
import { recipeIdsNamed } from "../harness/recipes";
import { callTrpc, submitMutation } from "../harness/trpc";
import { expect, test } from "./fixture";

const CDP_TOKEN = "e2e-cdp-token-that-must-never-be-shown";
const ENDPOINT = "wss://obscura.e2e:9222";
const KEEPS_TOKEN_HINT = "Leave empty to keep the saved value.";
const CHROMIUM_ENDPOINT = "wss://chromium.e2e/devtools/browser?token=e2e";

let before: PageRenderersConfig;

const readSetting = (aiStack: AIE2EStack) =>
  callTrpc<PageRenderersConfig>(aiStack.baseURL, aiStack.ownerCookies, "admin.getPageRenderers");

const saveSetting = (aiStack: AIE2EStack, setting: PageRenderersConfig) =>
  callTrpc(aiStack.baseURL, aiStack.ownerCookies, "admin.updatePageRenderers", setting);

const cardOf = (page: Page) => page.getByTestId("page-renderers-card");

const saveCard = (page: Page) =>
  submitMutation(page, "admin.updatePageRenderers", () =>
    cardOf(page).getByRole("button", { name: "Save" }).click()
  );

test.afterEach(async ({ aiStack }) => {
  await saveSetting(aiStack, before);
});

test.describe("the Page Renderers card", () => {
  test.beforeEach(async ({ aiStack, page }) => {
    before = await readSetting(aiStack);
    await saveSetting(aiStack, {
      ...before,
      obscura: { enabled: true, endpoint: ENDPOINT, cdpToken: CDP_TOKEN },
      solver: { enabled: false },
    });

    await page.goto("/settings?tab=admin");
    await cardOf(page).scrollIntoViewIfNeeded();
    await expect(cardOf(page).getByLabel("Obscura endpoint")).toHaveValue(ENDPOINT);
    await expect(cardOf(page).getByText(KEEPS_TOKEN_HINT)).toBeVisible();
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

  test("an administrator switches the Chromium browser on and keeps its endpoint", async ({
    aiStack,
    page,
  }) => {
    const card = cardOf(page);
    const chromiumSwitch = card.getByRole("switch", { name: "Chromium browser" });

    await expect(chromiumSwitch).not.toBeChecked();
    await chromiumSwitch.press("Space");
    await card.getByLabel("Chromium endpoint").fill(CHROMIUM_ENDPOINT);
    await saveCard(page);

    await page.reload();
    await card.scrollIntoViewIfNeeded();

    await expect(chromiumSwitch).toBeChecked();
    await expect(card.getByLabel("Chromium endpoint")).toHaveValue(CHROMIUM_ENDPOINT);
    expect((await readSetting(aiStack)).chromium).toEqual({
      enabled: true,
      endpoint: CHROMIUM_ENDPOINT,
    });
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
});

test.describe("the Chromium browser", () => {
  const NAME = "Challenge Pancakes";
  let browser: Browser;
  let endpoint: string;
  let site: RecipeSite;

  test.beforeAll(async () => {
    const port = await freeHostPort();

    browser = await chromium.launch({
      args: [`--remote-debugging-port=${port}`, "--ignore-certificate-errors"],
    });
    endpoint = `http://127.0.0.1:${port}`;
    site = await serveRecipeSite(NAME);
  });

  test.afterAll(async () => {
    await browser.close();
    await site.close();
  });

  test.beforeEach(async ({ aiStack }) => {
    before = await readSetting(aiStack);
    // The stack reaches no Obscura, and the site answers on loopback.
    await saveSetting(aiStack, {
      ...before,
      obscura: { enabled: false, endpoint: "" },
      chromium: { enabled: true, endpoint },
      solver: { enabled: false },
      allowPrivateAddresses: true,
    });
  });

  test("an import reads a recipe behind a bot check that the plain fetch cannot", async ({
    aiStack,
  }) => {
    await callTrpc(aiStack.baseURL, aiStack.ownerCookies, "recipes.importFromUrl", {
      url: `${site.origin("recipes")}/recipe`,
    });

    await expect.poll(() => recipeIdsNamed(NAME), { timeout: 60_000 }).toHaveLength(1);
    // The browser ran the challenge and came back for the recipe with its cookie.
    expect(
      site.requests
        .filter(({ path }) => path === "/recipe")
        .map(({ headers }) => headers.cookie ?? "")
        .filter(Boolean)
    ).toContain("passed=1");
  });
});
