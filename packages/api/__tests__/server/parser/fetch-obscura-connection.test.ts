// @vitest-environment node
/**
 * Obscura's endpoint and token come from the Page Renderers setting, so a save in admin settings
 * reaches the next render without a restart: the cached connection is replaced when either changes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PageRenderersConfig } from "@norish/config/zod/server-config";
import { closeBrowser } from "@norish/api/obscura";
import { renderPage } from "@norish/api/parser/fetch";

const { connectOverCDP } = vi.hoisted(() => ({ connectOverCDP: vi.fn() }));

vi.mock("playwright-core", () => ({ chromium: { connectOverCDP } }));

vi.mock("@norish/shared-server/logger", () => ({
  parserLogger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  serverLogger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

let renderers: PageRenderersConfig;

vi.mock("@norish/shared-server/config/server-config-loader", () => ({
  getPageRenderersConfig: async () => renderers,
}));

/** A connected Obscura whose every page renders `html`. */
function fakeBrowser(html: string) {
  return {
    isConnected: () => true,
    close: vi.fn().mockResolvedValue(undefined),
    newContext: vi.fn(async () => ({
      close: vi.fn().mockResolvedValue(undefined),
      newPage: vi.fn(async () => ({
        goto: vi.fn().mockResolvedValue(undefined),
        content: vi.fn().mockResolvedValue(html),
        on: vi.fn(),
        mainFrame: vi.fn(),
      })),
    })),
  };
}

beforeEach(async () => {
  await closeBrowser();
  connectOverCDP.mockReset();
  renderers = {
    obscura: { enabled: true, endpoint: "ws://obscura:9222", cdpToken: "first" },
    solver: { enabled: false },
    allowPrivateAddresses: false,
    navigationTimeoutMs: 45_000,
  };
});

describe("renderPage – the Obscura connection follows the setting", () => {
  it("keeps one connection while the endpoint and token stay the same", async () => {
    connectOverCDP.mockResolvedValue(fakeBrowser("<html><head><title>one</title></head></html>"));

    await renderPage("https://example.com/a");
    await renderPage("https://example.com/b");

    expect(connectOverCDP).toHaveBeenCalledOnce();
    expect(connectOverCDP).toHaveBeenCalledWith("ws://obscura:9222", {
      headers: { Authorization: "Bearer first" },
    });
  });

  it("replaces the connection on the next render once the endpoint or token changes", async () => {
    const first = fakeBrowser("<html><head><title>first</title></head></html>");
    const second = fakeBrowser("<html><head><title>second</title></head></html>");
    const third = fakeBrowser("<html><head><title>third</title></head></html>");

    connectOverCDP
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(third);

    await renderPage("https://example.com/a");
    renderers.obscura.endpoint = "ws://browser.lan:9333";

    await expect(renderPage("https://example.com/a")).resolves.toMatchObject({
      html: "<html><head><title>second</title></head></html>",
    });
    renderers.obscura.cdpToken = "rotated";

    await expect(renderPage("https://example.com/a")).resolves.toMatchObject({
      html: "<html><head><title>third</title></head></html>",
    });
    expect(first.close).toHaveBeenCalled();
    expect(second.close).toHaveBeenCalled();
    expect(connectOverCDP).toHaveBeenLastCalledWith("ws://browser.lan:9333", {
      headers: { Authorization: "Bearer rotated" },
    });
  });
});
