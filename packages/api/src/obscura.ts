import type { Browser } from "playwright-core";
import { chromium } from "playwright-core";

import { serverLogger as log } from "@norish/shared-server/logger";
import { withTimeout } from "@norish/shared/lib/with-timeout";

/**
 * A connection to Obscura, the first Page Renderer, opened for one endpoint and token. Playwright
 * Core dials its CDP endpoint as given, with no debugger-metadata probe and no hostname rewriting.
 */
interface Connection {
  key: string;
  /** Shared while it opens, so two imports arriving while Obscura is cold open one connection. */
  opening: Promise<Browser>;
  browser?: Browser;
}

let connection: Connection | null = null;

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

  // One connection serves every import; contexts, not connections, are what keeps concurrent
  // imports isolated. A connection Obscura dropped, because it restarted say, is replaced here.
  if (connection?.key !== key || connection.browser?.isConnected() === false) {
    if (connection) void close(connection);
    connection = connect(endpoint, token, key, timeoutMs);
  }

  const { opening } = connection;

  try {
    // A caller joining an attempt opened for another render still gives up at its own deadline.
    return await withTimeout(() => opening, timeoutMs, "Connecting to Obscura");
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
): Connection {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const opened: Connection = {
    key,
    opening: chromium.connectOverCDP(endpoint, { headers, timeout: timeoutMs }),
  };

  opened.opening.then(
    (browser) => {
      opened.browser = browser;
    },
    () => {
      // A failed attempt is not cached, so the next import retries once Obscura is back.
      if (connection === opened) connection = null;
    }
  );

  return opened;
}

/** Close a connection, once it has opened when it is still opening, so none is left behind. */
async function close(closing: Connection): Promise<void> {
  const browser = await closing.opening.catch(() => null);

  await browser?.close().catch((error: unknown) => {
    log.error({ err: error }, "Error closing the Obscura connection");
  });
}

export async function closeBrowser() {
  const closing = connection;

  connection = null;

  if (closing) await close(closing);
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
