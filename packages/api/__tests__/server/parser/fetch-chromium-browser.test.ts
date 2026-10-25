// @vitest-environment node
/**
 * The Chromium browser (ADR-0019), any Chromium with a CDP endpoint, through `renderPage`: the
 * endpoint it dials, when its page counts as read, and the document requests it refuses. The CDP
 * connection and DNS are faked at the edge; the fake pauses requests the way Chromium's `Fetch`
 * domain does, so what a test reads is what left the browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PageRenderersConfig } from "@norish/config/zod/server-config";
import { closeBrowsers } from "@norish/api/parser/browser-connections";
import { renderPage } from "@norish/api/parser/fetch";

const { connectOverCDP, lookup, log } = vi.hoisted(() => ({
  connectOverCDP: vi.fn(),
  lookup: vi.fn(),
  log: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("playwright-core", () => ({ chromium: { connectOverCDP } }));
vi.mock("node:dns/promises", () => ({ lookup }));
vi.mock("@norish/shared-server/logger", () => ({ parserLogger: log, serverLogger: log }));

let renderers: PageRenderersConfig;

vi.mock("@norish/shared-server/config/server-config-loader", () => ({
  getPageRenderersConfig: async () => renderers,
}));

/** What each name resolves to; anything unnamed is a public address. */
const DNS: Record<string, string[]> = {
  chromium: ["172.18.0.5"],
  "chromium.v6": ["fd00::5"],
  "router.lan": ["192.168.1.1"],
};

const padding = "x".repeat(30_000);
const REAL_PAGE = `<html><head><title>Lasagne</title></head><body>${padding}</body></html>`;
/** Akamai's challenge: no title, a script that reloads into the page seconds after load. */
const CHALLENGE = `<html><head><script>reload()</script></head><body></body></html>`;
/** The real page half-streamed: its title has arrived, its recipe has not. */
const HALF_PAGE = `<html><head><title>Lasagne</title></head><body>`;

/** A document as the page holds it at one moment. */
interface Doc {
  html: string;
  readyState?: "loading" | "interactive" | "complete";
}

/** How a site answers a request: a redirect, or a page whose documents follow one another. */
type Answer = { redirect: string } | { status?: number; documents: Doc[] };

interface Pattern {
  urlPattern?: string;
  resourceType?: string;
  requestStage?: string;
}

/** Chromium's urlPattern: `*` is any run of characters, `?` is one. */
function matches({ urlPattern = "*", resourceType }: Pattern, url: string, type: string): boolean {
  const glob = urlPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");

  return (!resourceType || resourceType === type) && new RegExp(`^${glob}$`).test(url);
}

/**
 * A Chromium serving `site`. Each navigation hop goes through the page's `Fetch` patterns: a hop a
 * pattern matches is paused once until it is continued or failed. Returns the requests that left
 * the browser, with the headers each carried, and every command the CDP session was sent.
 */
function chromiumServing(site: Record<string, Answer>) {
  const sentOut: { url: string; headers: Record<string, string> }[] = [];
  const commands: [string, Record<string, unknown>][] = [];
  const answers = new Map<string, (command: [string, Record<string, unknown>]) => void>();
  let patterns: Pattern[] = [];
  let paused: ((event: unknown) => void) | undefined;
  let nextId = 0;

  /** One document request, as the network stack would send it. */
  async function request(url: string): Promise<void> {
    const headers = { "User-Agent": "HeadlessChrome", Accept: "text/html" };

    if (!patterns.some((pattern) => matches(pattern, url, "Document"))) {
      sentOut.push({ url, headers });

      return;
    }

    const requestId = String(++nextId);
    const answered = new Promise<[string, Record<string, unknown>]>((resolve) =>
      answers.set(requestId, resolve)
    );

    paused?.({ requestId, request: { url, method: "GET", headers }, resourceType: "Document" });

    const [method, params] = await answered;

    if (method === "Fetch.failRequest") throw new Error(`net::ERR_${String(params.errorReason)}`);

    const replaced = params.headers as { name: string; value: string }[] | undefined;

    sentOut.push({
      url,
      headers: replaced
        ? Object.fromEntries(replaced.map(({ name, value }) => [name, value]))
        : headers,
    });
  }

  const browser = {
    isConnected: () => true,
    close: vi.fn().mockResolvedValue(undefined),
    newContext: vi.fn(async () => ({
      close: vi.fn().mockResolvedValue(undefined),
      addCookies: vi.fn(),
      newCDPSession: vi.fn(async () => ({
        on: (event: string, listener: (event: unknown) => void) => {
          if (event === "Fetch.requestPaused") paused = listener;
        },
        send: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
          commands.push([method, params]);
          if (method === "Fetch.enable") patterns = params.patterns as Pattern[];
          answers.get(String(params.requestId))?.([method, params]);

          return {};
        }),
      })),
      newPage: vi.fn(async () => {
        let documents: Doc[] = [];

        return {
          on: vi.fn(),
          mainFrame: vi.fn(),
          goto: vi.fn(async (target: string) => {
            for (let url = target; ;) {
              await request(url);

              const answer = site[url];

              if (!answer) throw new Error("net::ERR_NAME_NOT_RESOLVED");
              if ("redirect" in answer) {
                url = new URL(answer.redirect, url).href;
                continue;
              }
              documents = [...answer.documents];

              return { status: () => answer.status ?? 200 };
            }
          }),
          content: vi.fn(async () => documents[0]?.html ?? ""),
          // Run in the page against the document it holds now, as the browser runs it; each
          // look moves the page on to its next document.
          evaluate: vi.fn(async (read: () => unknown) => {
            const [now = { html: "" }] = documents.length > 1 ? documents.splice(0, 1) : documents;

            vi.stubGlobal("document", {
              readyState: now.readyState ?? "complete",
              documentElement: { outerHTML: now.html },
            });

            return read();
          }),
        };
      }),
    })),
  };

  connectOverCDP.mockResolvedValue(browser);

  return { sentOut: () => sentOut.map(({ url }) => url), headersTo: sentOut, commands };
}

beforeEach(async () => {
  await closeBrowsers();
  vi.clearAllMocks();
  connectOverCDP.mockReset();
  renderers = {
    obscura: { enabled: false, endpoint: "" },
    chromium: { enabled: true, endpoint: "http://chromium:9222" },
    solver: { enabled: false },
    allowPrivateAddresses: false,
    navigationTimeoutMs: 30_000,
  };
  lookup.mockImplementation(async (host: string) =>
    (DNS[host] ?? ["93.184.215.14"]).map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }))
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("renderPage – the Chromium browser's endpoint", () => {
  const page = { "https://example.com/r": { documents: [{ html: REAL_PAGE }] } };

  it.each([
    // Chromium's DevTools server refuses a Host header that is not an address or localhost.
    ["http://chromium:9222", "http://172.18.0.5:9222/"],
    [
      "ws://chromium:9222/devtools/browser/abc?x=1",
      "ws://172.18.0.5:9222/devtools/browser/abc?x=1",
    ],
    ["http://chromium.v6:9222", "http://[fd00::5]:9222/"],
    // A hosted browser sits behind a TLS proxy that has no such check.
    ["wss://browser.example/cdp?token=x", "wss://browser.example/cdp?token=x"],
    ["https://browser.example:9222", "https://browser.example:9222"],
    ["http://10.0.0.7:9222", "http://10.0.0.7:9222"],
  ])("dials %s as %s", async (endpoint, dialled) => {
    renderers.chromium.endpoint = endpoint;
    chromiumServing(page);

    await expect(renderPage("https://example.com/r")).resolves.toEqual({
      html: REAL_PAGE,
      status: 200,
    });
    expect(connectOverCDP).toHaveBeenCalledExactlyOnceWith(dialled, {
      headers: {},
      timeout: expect.any(Number),
    });
  });

  it("dials a name that does not resolve as given, so its failure names it", async () => {
    renderers.chromium.endpoint = "http://chromium-gone:9222";
    lookup.mockImplementation(async (host: string) => {
      if (host === "chromium-gone") throw new Error("getaddrinfo ENOTFOUND chromium-gone");

      return [{ address: "93.184.215.14", family: 4 }];
    });
    connectOverCDP.mockRejectedValue(new Error("getaddrinfo ENOTFOUND chromium-gone"));

    await expect(renderPage("https://example.com/r")).resolves.toEqual({ html: "", status: null });
    expect(connectOverCDP).toHaveBeenCalledWith("http://chromium-gone:9222", expect.anything());
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ renderer: "chromium", endpoint: "http://chromium-gone:9222" }),
      expect.stringContaining("not reachable")
    );
  });

  it("replaces the connection once the name resolves to a new address", async () => {
    chromiumServing(page);
    await renderPage("https://example.com/r");
    DNS.chromium = ["172.18.0.9"];

    try {
      await renderPage("https://example.com/r");
    } finally {
      DNS.chromium = ["172.18.0.5"];
    }

    expect(connectOverCDP.mock.calls.map(([dialled]) => dialled)).toEqual([
      "http://172.18.0.5:9222/",
      "http://172.18.0.9:9222/",
    ]);
  });
});

describe("renderPage – when the Chromium browser's page counts as read", () => {
  it("waits for a bot check to become the page, with no reading of the caller's", async () => {
    chromiumServing({
      "https://www.ah.nl/r": { documents: [{ html: CHALLENGE }, { html: REAL_PAGE }] },
    });

    await expect(renderPage("https://www.ah.nl/r")).resolves.toEqual({
      html: REAL_PAGE,
      status: 200,
    });
  });

  it("reads a document only once it has finished loading", async () => {
    chromiumServing({
      "https://www.ah.nl/r": {
        documents: [
          { html: CHALLENGE },
          { html: HALF_PAGE, readyState: "interactive" },
          { html: REAL_PAGE },
        ],
      },
    });

    await expect(renderPage("https://www.ah.nl/r")).resolves.toMatchObject({ html: REAL_PAGE });
  });

  it("keeps to the caller's own reading, read once loaded", async () => {
    const shelf = (state: string) => `<html><head><title>${state}</title></head></html>`;

    chromiumServing({
      "https://shop.example/zoeken": {
        documents: [
          { html: shelf("the shop") },
          { html: shelf("the shop, shelf"), readyState: "loading" },
          { html: shelf("the shop, shelf and prices") },
        ],
      },
    });

    await expect(
      renderPage("https://shop.example/zoeken", undefined, (html) => html.includes("shelf"))
    ).resolves.toMatchObject({ html: shelf("the shop, shelf and prices") });
  });
});

describe("renderPage – private addresses inside the Chromium browser", () => {
  const redirectedToRouter = {
    "https://example.com/r": { redirect: "http://router.lan/admin" },
    "http://router.lan/admin": { documents: [{ html: REAL_PAGE }] },
  };

  it("fails a document request redirected to a private address, so nothing is read", async () => {
    const { sentOut, commands } = chromiumServing(redirectedToRouter);

    await expect(renderPage("https://example.com/r")).resolves.toEqual({ html: "", status: null });
    expect(sentOut()).toEqual(["https://example.com/r"]);
    // Only documents are paused, before they are sent; images and scripts go unchecked.
    expect(commands).toContainEqual([
      "Fetch.enable",
      { patterns: [{ resourceType: "Document", requestStage: "Request" }] },
    ]);
    expect(log.warn).toHaveBeenCalledWith(
      { url: "http://router.lan/admin" },
      "Refused a private address in the Chromium browser"
    );
  });

  it("follows the redirect once private addresses are allowed, pausing nothing", async () => {
    renderers.allowPrivateAddresses = true;
    const { sentOut, commands } = chromiumServing(redirectedToRouter);

    await expect(renderPage("https://example.com/r")).resolves.toMatchObject({ html: REAL_PAGE });
    expect(sentOut()).toEqual(["https://example.com/r", "http://router.lan/admin"]);
    expect(commands).toEqual([]);
  });

  it("fails a document request it cannot check", async () => {
    const { sentOut } = chromiumServing(redirectedToRouter);

    lookup.mockImplementation((host: string) => {
      if (host === "router.lan") throw new Error("resolver crashed");

      return Promise.resolve([{ address: "93.184.215.14", family: 4 }]);
    });

    await expect(renderPage("https://example.com/r")).resolves.toMatchObject({ html: "" });
    expect(sentOut()).toEqual(["https://example.com/r"]);
  });
});
