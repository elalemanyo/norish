// @vitest-environment node
/**
 * The Obscura connection seam. What Norish owns here is small on purpose:
 * that it dials the endpoint it is handed, that one healthy connection is reused, that a
 * connection Obscura dropped is replaced on the next call, and that a failure
 * reads as an Obscura problem. Everything past `connectOverCDP` is Obscura's.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { mockConnectOverCDP, log } = vi.hoisted(() => ({
  mockConnectOverCDP: vi.fn(),
  log: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("playwright-core", () => ({
  chromium: { connectOverCDP: mockConnectOverCDP },
}));

const ENDPOINT = "ws://obscura.test:9222";
const TIMEOUT = 30_000;

vi.mock("@norish/shared-server/logger", () => ({ serverLogger: log }));

/** A fresh module instance, so the cached connection never leaks across tests. */
async function loadModule() {
  vi.resetModules();

  return import("@norish/api/obscura");
}

function connectedBrowser() {
  return {
    isConnected: vi.fn().mockReturnValue(true),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("getBrowser – the Obscura connection", () => {
  it("connects to the configured Obscura endpoint", async () => {
    const browser = connectedBrowser();

    mockConnectOverCDP.mockResolvedValue(browser);

    const { getBrowser } = await loadModule();

    await expect(getBrowser(ENDPOINT, undefined, TIMEOUT)).resolves.toBe(browser);
    expect(mockConnectOverCDP).toHaveBeenCalledExactlyOnceWith("ws://obscura.test:9222", {
      headers: {},
      timeout: TIMEOUT,
    });
  });

  it("sends the configured token as a bearer header", async () => {
    mockConnectOverCDP.mockResolvedValue(connectedBrowser());

    const { getBrowser } = await loadModule();

    await getBrowser(ENDPOINT, "a".repeat(64), TIMEOUT);
    expect(mockConnectOverCDP).toHaveBeenCalledExactlyOnceWith("ws://obscura.test:9222", {
      headers: { Authorization: `Bearer ${"a".repeat(64)}` },
      timeout: TIMEOUT,
    });
  });

  it("reuses one healthy connection across imports", async () => {
    mockConnectOverCDP.mockResolvedValue(connectedBrowser());

    const { getBrowser } = await loadModule();
    const first = await getBrowser(ENDPOINT, undefined, TIMEOUT);

    await expect(getBrowser(ENDPOINT, undefined, TIMEOUT)).resolves.toBe(first);
    expect(mockConnectOverCDP).toHaveBeenCalledOnce();
  });

  it("opens one connection when two imports arrive while Obscura is cold", async () => {
    const browser = connectedBrowser();
    let connect: (value: unknown) => void = () => {};

    mockConnectOverCDP.mockImplementation(
      () =>
        new Promise((resolve) => {
          connect = resolve;
        })
    );

    const { getBrowser } = await loadModule();
    // Both start before either finishes: without shared in-flight state the
    // second connection would orphan the first, and shutdown would only know
    // about one of them.
    const first = getBrowser(ENDPOINT, undefined, TIMEOUT);
    const second = getBrowser(ENDPOINT, undefined, TIMEOUT);

    connect(browser);

    await expect(first).resolves.toBe(browser);
    await expect(second).resolves.toBe(browser);
    expect(mockConnectOverCDP).toHaveBeenCalledOnce();
  });

  it("gives up on a connection still opening at the joining caller's own deadline", async () => {
    vi.useFakeTimers();
    mockConnectOverCDP.mockImplementation(async () => new Promise(() => {}));

    const { getBrowser } = await loadModule();

    void getBrowser(ENDPOINT, undefined, TIMEOUT);

    const joining = getBrowser(ENDPOINT, undefined, 5_000);
    const settled = vi.fn();

    joining.then(settled, settled);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(settled).toHaveBeenCalledOnce();
    expect(mockConnectOverCDP).toHaveBeenCalledOnce();
  });

  it("replaces the connection on the next request after Obscura disconnects", async () => {
    const dropped = connectedBrowser();
    const replacement = connectedBrowser();

    mockConnectOverCDP.mockResolvedValueOnce(dropped).mockResolvedValueOnce(replacement);

    const { getBrowser } = await loadModule();

    await getBrowser(ENDPOINT, undefined, TIMEOUT);
    dropped.isConnected.mockReturnValue(false);

    await expect(getBrowser(ENDPOINT, undefined, TIMEOUT)).resolves.toBe(replacement);
    expect(mockConnectOverCDP).toHaveBeenCalledTimes(2);
  });

  it("closes a connection that opens after a newer setting's, and keeps the newer", async () => {
    const older = connectedBrowser();
    const newer = connectedBrowser();
    const connects: ((value: unknown) => void)[] = [];

    mockConnectOverCDP.mockImplementation(
      () =>
        new Promise((resolve) => {
          connects.push(resolve);
        })
    );

    const { getBrowser } = await loadModule();
    const first = getBrowser(ENDPOINT, undefined, TIMEOUT);
    const second = getBrowser("ws://elsewhere.test:9222", undefined, TIMEOUT);

    connects[1]?.(newer);
    await second;
    connects[0]?.(older);
    await first;

    await vi.waitFor(() => expect(older.close).toHaveBeenCalledOnce());
    expect(newer.close).not.toHaveBeenCalled();
    await expect(getBrowser("ws://elsewhere.test:9222", undefined, TIMEOUT)).resolves.toBe(newer);
    expect(mockConnectOverCDP).toHaveBeenCalledTimes(2);
  });

  it("reports an unreachable endpoint to the administrator, and answers no browser", async () => {
    mockConnectOverCDP.mockRejectedValue(new Error("ECONNREFUSED"));

    const { getBrowser } = await loadModule();

    await expect(getBrowser(ENDPOINT, undefined, TIMEOUT)).resolves.toBeNull();
    expect(log.error).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ endpoint: ENDPOINT, reason: "Error: ECONNREFUSED" }),
      expect.stringMatching(
        /^Obscura is not reachable at ws:\/\/obscura.test:9222\..*admin settings/
      )
    );
  });

  it("retries the connection after a failure instead of caching it", async () => {
    const browser = connectedBrowser();

    mockConnectOverCDP.mockRejectedValueOnce(new Error("ECONNREFUSED")).mockResolvedValue(browser);

    const { getBrowser } = await loadModule();

    await expect(getBrowser(ENDPOINT, undefined, TIMEOUT)).resolves.toBeNull();
    await expect(getBrowser(ENDPOINT, undefined, TIMEOUT)).resolves.toBe(browser);
  });
});

describe("closeBrowser – process shutdown", () => {
  it("closes the cached connection and forgets it", async () => {
    const browser = connectedBrowser();

    mockConnectOverCDP.mockResolvedValue(browser);

    const { getBrowser, closeBrowser } = await loadModule();

    await getBrowser(ENDPOINT, undefined, TIMEOUT);
    await closeBrowser();

    expect(browser.close).toHaveBeenCalledOnce();

    await getBrowser(ENDPOINT, undefined, TIMEOUT);
    expect(mockConnectOverCDP).toHaveBeenCalledTimes(2);
  });

  it("survives a connection that fails to close", async () => {
    const browser = connectedBrowser();

    browser.close.mockRejectedValue(new Error("already gone"));
    mockConnectOverCDP.mockResolvedValue(browser);

    const { getBrowser, closeBrowser } = await loadModule();

    await getBrowser(ENDPOINT, undefined, TIMEOUT);
    await expect(closeBrowser()).resolves.toBeUndefined();
  });
});
