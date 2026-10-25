import type { Browser } from "playwright-core";
import { chromium } from "playwright-core";

import { serverLogger as log } from "@norish/shared-server/logger";
import { withTimeout } from "@norish/shared/lib/with-timeout";

/**
 * The connection to Obscura, the first Page Renderer. Playwright Core dials its CDP endpoint as
 * given, with no debugger-metadata probe and no hostname rewriting.
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

/**
 * Connect within `timeoutMs`, the part of a render's deadline that is left. An Obscura that cannot
 * be reached is logged for the administrator and answers null.
 */
export async function getBrowser(
  endpoint: string,
  token: string | undefined,
  timeoutMs: number
): Promise<Browser | null> {
  const key = `${endpoint}\n${token ?? ""}`;

  if (browser && browserKey !== key) void closeBrowser();

  // One connection serves every import; contexts, not connections, are what
  // keeps concurrent imports isolated. A connection Obscura dropped — because
  // it restarted, say — is replaced here rather than by restarting Norish.
  if (browser?.isConnected()) return browser;

  const attempt =
    connecting?.key === key ? connecting.promise : connect(endpoint, token, key, timeoutMs);

  try {
    // A caller joining an attempt opened for another render still gives up at its own deadline.
    return await withTimeout(() => attempt, timeoutMs, "Connecting to Obscura");
  } catch (error) {
    // A hosted browser may take its token in the query string, so no query string is logged.
    const hidden = (text: string) => text.replace(/[?#]\S*/g, "");

    log.error(
      { renderer: "obscura", endpoint: hidden(endpoint), reason: hidden(String(error)) },
      `Obscura is not reachable at ${hidden(endpoint)}. Start the obscura service or check its endpoint and CDP token in admin settings.`
    );

    return null;
  }
}

function connect(
  endpoint: string,
  token: string | undefined,
  key: string,
  timeoutMs: number
): Promise<Browser> {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const promise = chromium
    .connectOverCDP(endpoint, { headers, timeout: timeoutMs })
    .then((connected) => {
      // A connection that opened for an older setting meanwhile is replaced, not left open.
      if (browser && browser !== connected) void closeBrowser();
      browser = connected;
      browserKey = key;

      return connected;
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
