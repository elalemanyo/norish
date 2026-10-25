/**
 * The Page Renderers card (ADR-0019): what an administrator saves is what the next visit shows,
 * and the stored CDP token never reaches the browser in full. The harness runs no Obscura or
 * solver, so how pages render stays in the unit seam.
 */
import type { PageRenderersConfig } from "@norish/config/zod/server-config";

import { callTrpc, submitMutation } from "../harness/trpc";
import { expect, test } from "./fixture";

const CDP_TOKEN = "e2e-cdp-token-that-must-never-be-shown";

test("an administrator switches the solver on, saves, and sees it kept without the CDP token", async ({
  aiStack,
  page,
}) => {
  const before = await callTrpc<PageRenderersConfig>(
    aiStack.baseURL,
    aiStack.ownerCookies,
    "admin.getPageRenderers"
  );

  await callTrpc(aiStack.baseURL, aiStack.ownerCookies, "admin.updatePageRenderers", {
    ...before,
    obscura: { enabled: true, endpoint: "wss://obscura.e2e:9222", cdpToken: CDP_TOKEN },
    solver: { enabled: false },
  });

  try {
    await page.goto("/settings?tab=admin");
    const card = page.getByTestId("page-renderers-card");

    await card.scrollIntoViewIfNeeded();
    await expect(card.getByLabel("Obscura endpoint")).toHaveValue("wss://obscura.e2e:9222");
    await card.getByLabel("Obscura endpoint").fill("wss://browser.e2e:9333");
    await card.getByRole("switch", { name: "FlareSolverr or Byparr" }).press("Space");
    await card.getByLabel("Solver endpoint").fill("https://solver.e2e:8191/v1");
    await submitMutation(page, "admin.updatePageRenderers", () =>
      card.getByRole("button", { name: "Save" }).click()
    );

    await page.reload();
    await card.scrollIntoViewIfNeeded();

    await expect(card.getByLabel("Obscura endpoint")).toHaveValue("wss://browser.e2e:9333");
    await expect(card.getByRole("switch", { name: "FlareSolverr or Byparr" })).toBeChecked();
    await expect(card.getByLabel("Solver endpoint")).toHaveValue("https://solver.e2e:8191/v1");
    await expect(card.getByLabel("CDP token")).toHaveValue("");
    expect(await page.content()).not.toContain(CDP_TOKEN);

    // The save sent no token of its own, so the stored one is kept.
    const kept = await callTrpc<PageRenderersConfig>(
      aiStack.baseURL,
      aiStack.ownerCookies,
      "admin.getPageRenderers"
    );

    expect(kept.obscura.cdpToken).toBe("••••••••");
  } finally {
    await callTrpc(aiStack.baseURL, aiStack.ownerCookies, "admin.updatePageRenderers", before);
  }
});
