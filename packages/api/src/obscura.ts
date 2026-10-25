import type { Browser } from "playwright-core";
import { chromium } from "playwright-core";

import { serverLogger as log } from "@norish/shared-server/logger";

/**
 * The connection to Obscura, the headless browser that is the first Page
 * Renderer. Obscura serves the Chrome DevTools Protocol, so Playwright Core
 * talks to it directly: the configured endpoint is dialled as given, with no
 * debugger-metadata probe and no hostname rewriting in between.
 */
let browser: Browser | null = null;
/** The endpoint and token `browser` was opened with; a change to either replaces it. */
let browserKey = "";

/**
 * The connection attempt in flight, if there is one. Cached as a promise rather
 * than awaited per caller, so two imports arriving while Obscura is cold share
 * one connection instead of opening two and orphaning the first.
 */
let connecting: { key: string; promise: Promise<Browser> } | null = null;

export async function getBrowser(endpoint: string, token?: string): Promise<Browser> {
  const key = `${endpoint}\n${token ?? ""}`;

  if (browser && browserKey !== key) void closeBrowser();

  // One connection serves every import; contexts, not connections, are what
  // keeps concurrent imports isolated. A connection Obscura dropped — because
  // it restarted, say — is replaced here rather than by restarting Norish.
  if (browser?.isConnected()) return browser;
  if (connecting?.key === key) return connecting.promise;

  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const promise = chromium
    .connectOverCDP(endpoint, { headers })
    .then((connected) => {
      browser = connected;
      browserKey = key;

      return connected;
    })
    .catch((error: unknown) => {
      log.error({ err: error, endpoint }, "Failed to connect to Obscura");
      throw new Error(
        `Obscura is not reachable at ${endpoint}. Start the obscura service or check its endpoint and CDP token in admin settings.`
      );
    })
    .finally(() => {
      // Cleared either way: a failed attempt must not be cached, so the next
      // import retries once Obscura is back.
      if (connecting?.promise === promise) connecting = null;
    });

  connecting = { key, promise };

  return promise;
}

export async function closeBrowser() {
  const closing = browser;

  browser = null;

  if (closing) {
    try {
      await closing.close();
    } catch (error) {
      log.error({ err: error }, "Error closing the Obscura connection");
    }
  }
}

// Graceful shutdown - register handlers only once
let shutdownHandlersRegistered = false;

function registerShutdownHandlers() {
  if (shutdownHandlersRegistered) return;
  shutdownHandlersRegistered = true;
  process.on("SIGINT", closeBrowser);
  process.on("SIGTERM", closeBrowser);
}

registerShutdownHandlers();
