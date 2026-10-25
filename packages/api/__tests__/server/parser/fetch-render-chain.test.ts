// @vitest-environment node
/**
 * The Page Renderer chain behind `renderPage` (ADR-0019): Obscura first, then a FlareSolverr-
 * compatible solver, moving on only on no HTML or a bot check. Site Auth Tokens go to Obscura
 * alone. Obscura's connection and the solver's HTTP endpoint are faked at the process edge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PageRenderersConfig } from "@norish/config/zod/server-config";
import type { SiteAuthTokenDecryptedDto } from "@norish/shared/contracts/dto/site-auth-tokens";
import { renderPage } from "@norish/api/parser/fetch";

const { mockGetBrowser, mockContent, mockCdpSend, log } = vi.hoisted(() => ({
  mockGetBrowser: vi.fn(),
  mockContent: vi.fn(),
  mockCdpSend: vi.fn(),
  log: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("@norish/api/obscura", () => ({ getBrowser: mockGetBrowser }));
vi.mock("@norish/shared-server/logger", () => ({ parserLogger: log }));

let renderers: PageRenderersConfig;

vi.mock("@norish/shared-server/config/server-config-loader", () => ({
  getPageRenderersConfig: async () => renderers,
}));

const padding = "x".repeat(30_000);
const REAL_PAGE = `<html><head><title>Lasagne</title></head><body>${padding}</body></html>`;
const SOLVED_PAGE = `<html><head><title>Lasagne, solved</title></head><body>${padding}</body></html>`;
const CHALLENGE = `<html><head><title>Just a moment...</title></head><body>${padding}</body></html>`;
const SOLVER = "http://flaresolverr:8191/v1";

const TOKENS: SiteAuthTokenDecryptedDto[] = [
  { name: "Authorization", value: "Bearer abc", type: "header" },
  { name: "session", value: "sess-abc", type: "cookie" },
].map((token) => ({
  ...token,
  type: token.type as "header" | "cookie",
  id: "00000000-0000-0000-0000-000000000000",
  userId: "user-1",
  domain: "example.com",
  createdAt: new Date("2025-01-01"),
  updatedAt: new Date("2025-01-01"),
}));

/** The solver's endpoint, answering every request with `reply`; returns the bodies it was sent. */
function solverAnswers(reply: () => Promise<Response>) {
  const solver = vi.fn(async (_url: string, _init: RequestInit) => reply());

  vi.stubGlobal("fetch", solver);

  return {
    solver,
    sent: () =>
      solver.mock.calls.map(([url, init]) => ({
        url,
        method: init.method,
        body: JSON.parse(String(init.body)) as unknown,
      })),
  };
}

const solved = (html: string) => async () =>
  Response.json({ status: "ok", message: "", solution: { status: 200, response: html } });

/** Which renderer the log says answered. */
function answeredBy(): unknown[] {
  return log.info.mock.calls
    .filter(([, message]) => message === "A Page Renderer read the page")
    .map(([fields]) => (fields as { renderer: string }).renderer);
}

beforeEach(() => {
  vi.clearAllMocks();
  renderers = {
    obscura: { enabled: true, endpoint: "ws://obscura:9222" },
    solver: { enabled: true, endpoint: SOLVER },
    allowPrivateAddresses: false,
    navigationTimeoutMs: 30_000,
  };
  mockContent.mockResolvedValue(REAL_PAGE);
  mockCdpSend.mockImplementation(async (_method: string, params: { scopeDomain?: string }) => ({
    scopeDomain: params.scopeDomain,
  }));
  mockGetBrowser.mockResolvedValue({
    newContext: async () => ({
      newCDPSession: async () => ({ send: mockCdpSend }),
      close: async () => undefined,
      newPage: async () => ({
        goto: vi.fn(async () => ({ status: () => 403 })),
        content: mockContent,
        evaluate: vi.fn(),
        on: vi.fn(),
        mainFrame: vi.fn(),
      }),
    }),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("renderPage – the order", () => {
  it("stops at Obscura when Obscura reads the page", async () => {
    const { solver } = solverAnswers(solved(SOLVED_PAGE));

    await expect(renderPage("https://example.com/r")).resolves.toEqual({
      html: REAL_PAGE,
      status: 403,
    });
    expect(solver).not.toHaveBeenCalled();
    expect(answeredBy()).toEqual(["obscura"]);
  });

  it("moves on to the solver when Obscura returns no HTML", async () => {
    mockGetBrowser.mockRejectedValue(new Error("Obscura is not reachable"));
    solverAnswers(solved(SOLVED_PAGE));

    await expect(renderPage("https://example.com/r")).resolves.toEqual({
      html: SOLVED_PAGE,
      status: null,
    });
    expect(answeredBy()).toEqual(["solver"]);
  });

  it("moves on to the solver when Obscura is shown a bot check", async () => {
    mockContent.mockResolvedValue(CHALLENGE);
    solverAnswers(solved(SOLVED_PAGE));

    await expect(renderPage("https://example.com/r")).resolves.toEqual({
      html: SOLVED_PAGE,
      status: null,
    });
  });

  it("reads nothing when the solver does no better, so the import fails as unreadable", async () => {
    mockContent.mockResolvedValue(CHALLENGE);
    solverAnswers(solved(CHALLENGE));

    await expect(renderPage("https://example.com/r")).resolves.toEqual({
      html: "",
      status: 403,
    });
    expect(answeredBy()).toEqual([]);
  });
});

describe("renderPage – each renderer alone", () => {
  it("asks only the solver when Obscura is off", async () => {
    renderers.obscura.enabled = false;
    const { sent } = solverAnswers(solved(SOLVED_PAGE));

    await expect(renderPage("https://example.com/r")).resolves.toMatchObject({
      html: SOLVED_PAGE,
    });
    expect(mockGetBrowser).not.toHaveBeenCalled();
    expect(sent()).toEqual([
      {
        url: SOLVER,
        method: "POST",
        body: { cmd: "request.get", url: "https://example.com/r", maxTimeout: 30_000 },
      },
    ]);
  });

  it("asks only Obscura when the solver is off", async () => {
    renderers.solver.enabled = false;
    mockContent.mockResolvedValue(CHALLENGE);
    const { solver } = solverAnswers(solved(SOLVED_PAGE));

    await expect(renderPage("https://example.com/r")).resolves.toMatchObject({ html: "" });
    expect(solver).not.toHaveBeenCalled();
  });

  it("reads nothing with both off", async () => {
    renderers.obscura.enabled = false;
    renderers.solver.enabled = false;
    const { solver } = solverAnswers(solved(SOLVED_PAGE));

    await expect(renderPage("https://example.com/r")).resolves.toEqual({ html: "", status: null });
    expect(mockGetBrowser).not.toHaveBeenCalled();
    expect(solver).not.toHaveBeenCalled();
  });
});

describe("renderPage – the solver's answer", () => {
  beforeEach(() => {
    renderers.obscura.enabled = false;
  });

  it.each([
    ["an error reply", async () => Response.json({ status: "error", message: "Timeout" })],
    ["a non-2xx reply", async () => new Response("bad gateway", { status: 502 })],
    ["a reply that is not JSON", async () => new Response("<html>a proxy</html>")],
    ["a timeout", async () => Promise.reject(new DOMException("timed out", "TimeoutError"))],
    ["an unreachable endpoint", async () => Promise.reject(new TypeError("fetch failed"))],
  ])("counts %s as no HTML", async (_case, reply) => {
    solverAnswers(reply);

    await expect(renderPage("https://example.com/r")).resolves.toEqual({ html: "", status: null });
  });

  it("is read once, whatever the caller's reading of it says", async () => {
    solverAnswers(solved(SOLVED_PAGE));

    await expect(renderPage("https://example.com/r", undefined, () => false)).resolves.toEqual({
      html: SOLVED_PAGE,
      status: null,
    });
  });
});

describe("renderPage – Site Auth Tokens", () => {
  it("hands them to Obscura", async () => {
    solverAnswers(solved(SOLVED_PAGE));

    await renderPage("https://example.com/r", TOKENS);

    expect(mockCdpSend).toHaveBeenCalledWith(
      "Network.setExtraHTTPHeaders",
      expect.objectContaining({ headers: { Authorization: "Bearer abc" } })
    );
  });

  it("never hands them to the solver, and logs that they were withheld", async () => {
    mockContent.mockResolvedValue(CHALLENGE);
    const { sent } = solverAnswers(solved(SOLVED_PAGE));

    await renderPage("https://example.com/r", TOKENS);

    expect(JSON.stringify(sent())).not.toMatch(/sess-abc|Bearer abc|cookies|headers/);
    expect(log.info).toHaveBeenCalledWith(
      { url: "https://example.com/r", tokens: 2 },
      "Site Auth Tokens withheld from the solver"
    );
  });

  it("logs nothing withheld when there were no tokens", async () => {
    renderers.obscura.enabled = false;
    solverAnswers(solved(SOLVED_PAGE));

    await renderPage("https://example.com/r");

    expect(log.info).not.toHaveBeenCalledWith(
      expect.anything(),
      "Site Auth Tokens withheld from the solver"
    );
  });
});
