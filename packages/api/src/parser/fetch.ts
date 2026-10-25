import { lookup } from "node:dns/promises";
import { BlockList } from "node:net";
import type { BrowserContext, Page } from "playwright-core";
import { z } from "zod";

import type { BrowserRenderer } from "@norish/api/parser/browser-connections";
import type { SiteAuthTokenDecryptedDto } from "@norish/shared/contracts/dto/site-auth-tokens";
import { getBrowser } from "@norish/api/parser/browser-connections";
import { getPageRenderersConfig } from "@norish/shared-server/config/server-config-loader";
import { parserLogger as log } from "@norish/shared-server/logger";
import { isHostOnDomain } from "@norish/shared/lib/helpers";

/** How long a page that answered with something else is given to become itself. */
const SETTLE_TIMEOUT_MS = 15_000;
const SETTLE_POLL_MS = 500;
const PLAIN_FETCH_TIMEOUT_MS = 15_000;
/** A solver launches a browser before it navigates, so it is given this on top of the timeout. */
const SOLVER_LAUNCH_MS = 15_000;
const MAX_REDIRECTS = 10;
/** Below this, a page with no title of its own, or a block page's title, is a bot check. */
const STUB_MAX_BYTES = 20_000;
const CLOUDFLARE_CHALLENGE = /<title>\s*Just a moment(?:\.\.\.|…)|cf-challenge|_cf_chl_opt/i;
/** Akamai's, Cloudflare's and a web server's own refusals, with an optional "| Site" after them. */
const BLOCK_TITLE =
  /<title>\s*(?:Access Denied|Attention Required!|403 Forbidden)\s*(?:\|[^<]*)?<\/title>/i;
const REFUSAL_STATUSES = new Set([401, 403, 429]);

/**
 * Whether returned HTML is a bot check rather than the page: Cloudflare's challenge markup, a
 * small stub with no title of its own or a block page's title, or a page a renderer was refused
 * with. The one reading every caller and the renderer chain share.
 */
export function isBotCheck(html: string, status?: number | null): boolean {
  return (
    REFUSAL_STATUSES.has(status ?? 0) ||
    CLOUDFLARE_CHALLENGE.test(html) ||
    (html.length < STUB_MAX_BYTES &&
      (BLOCK_TITLE.test(html) || !/<title>\s*[^<\s][^<]*<\/title>/i.test(html)))
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The page, once it is the page rather than whatever stood in front of it. A
 * bot check answers the first navigation with a script and replaces itself
 * with the real page seconds later, so a caller that can tell the two apart is
 * given until the deadline to be handed the second one. Reading a page
 * mid-navigation throws, which is a page still becoming itself and counts as
 * unsettled.
 */
async function settledContent(page: Page, isSettled: (html: string) => boolean): Promise<string> {
  const read = async (): Promise<string | null> => {
    try {
      return await page.content();
    } catch {
      return null;
    }
  };
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let html = await read();

  while ((html === null || !isSettled(html)) && Date.now() < deadline) {
    await sleep(SETTLE_POLL_MS);
    html = await read();
  }

  return html ?? "";
}

/**
 * Loopback, RFC1918, CGNAT (Tailscale), benchmarking, link-local, multicast, reserved, unique-local,
 * NAT64 and unspecified; IPv4-mapped IPv6 matches too.
 */
const PRIVATE_ADDRESSES = new BlockList();

/* eslint-disable sonarjs/no-hardcoded-ip -- the private ranges are what is refused */
PRIVATE_ADDRESSES.addSubnet("0.0.0.0", 8, "ipv4");
PRIVATE_ADDRESSES.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE_ADDRESSES.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE_ADDRESSES.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE_ADDRESSES.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE_ADDRESSES.addSubnet("169.254.0.0", 16, "ipv4");
PRIVATE_ADDRESSES.addSubnet("100.64.0.0", 10, "ipv4");
PRIVATE_ADDRESSES.addSubnet("198.18.0.0", 15, "ipv4");
PRIVATE_ADDRESSES.addSubnet("224.0.0.0", 4, "ipv4");
PRIVATE_ADDRESSES.addSubnet("240.0.0.0", 4, "ipv4");
PRIVATE_ADDRESSES.addAddress("::", "ipv6");
PRIVATE_ADDRESSES.addAddress("::1", "ipv6");
PRIVATE_ADDRESSES.addSubnet("fc00::", 7, "ipv6");
PRIVATE_ADDRESSES.addSubnet("fe80::", 10, "ipv6");
PRIVATE_ADDRESSES.addSubnet("64:ff9b::", 96, "ipv6");
/* eslint-enable sonarjs/no-hardcoded-ip */

/**
 * Whether a host is refused: it is, or resolves to, a private address the administrator does not
 * allow. Redirects inside the solver's browser and DNS rebinding are not covered.
 */
async function isRefusedHost(hostname: string, allowPrivateAddresses: boolean): Promise<boolean> {
  if (allowPrivateAddresses) return false;

  // A name that does not resolve is left to the fetch to fail.
  const addresses = await lookup(hostname.replace(/^\[|\]$/g, ""), { all: true }).catch(() => []);

  return addresses.some(({ address, family }) =>
    PRIVATE_ADDRESSES.check(address, family === 6 ? "ipv6" : "ipv4")
  );
}

/** A rendered page and the HTTP status its document last arrived with. */
export interface RenderedPage {
  /** Empty when no Page Renderer produced usable HTML */
  html: string;
  /**
   * The status of the main document's last navigation: a bot check that
   * answers 403 and then hands over the real page reports the real page's.
   * Null when no document response was seen.
   */
  status: number | null;
}

/**
 * Header tokens go only to hosts on their site, through the `scopeDomain` that Norish's Obscura
 * (norish-recipes/obscura) adds and echoes. An Obscura that doesn't echo it would send them to every
 * host the page loads from, so they are cleared again and the import goes without them.
 */
async function sendHeadersToTheirSite(
  context: BrowserContext,
  page: Page,
  tokens: SiteAuthTokenDecryptedDto[],
  targetUrl: string
): Promise<void> {
  const scopeDomain = headerScope(new URL(targetUrl).hostname, tokens);
  const cdp = await context.newCDPSession(page);
  const scoped = {
    headers: Object.fromEntries(tokens.map((token) => [token.name, token.value])),
    scopeDomain,
  };
  const reply = await cdp.send("Network.setExtraHTTPHeaders", scoped);

  if (Reflect.get(reply, "scopeDomain") === scopeDomain) return;

  await cdp.send("Network.setExtraHTTPHeaders", { headers: {} });
  log.warn({ url: targetUrl }, "Obscura cannot keep header tokens to their site, so none are sent");
}

/** The tokens for the host's own site: those whose domain is the host or one it is under. */
function tokensOnSite(
  hostname: string,
  tokens: SiteAuthTokenDecryptedDto[] = []
): SiteAuthTokenDecryptedDto[] {
  return tokens.filter(({ domain }) => isHostOnDomain(hostname, domain.toLowerCase()));
}

/** The narrowest token domain the host is on. */
export function headerScope(hostname: string, tokens: SiteAuthTokenDecryptedDto[]): string {
  return tokensOnSite(hostname, tokens)
    .map(({ domain }) => domain.toLowerCase())
    .reduce((narrowest, domain) => (domain.length > narrowest.length ? domain : narrowest), "");
}

/** A page fetched without a browser. */
export interface PlainPage {
  /** Empty unless the site answered with a 2xx */
  html: string;
  /** Null when no answer arrived */
  status: number | null;
  /** The address the page answered from, after redirects */
  url: string;
  /** Set when the target was a private address and the administrator does not allow those */
  refused?: true;
}

/**
 * Fetch a web page without a browser, following redirects by hand so Site Auth Tokens
 * go only to https hops on their own domain.
 */
export async function plainFetch(
  targetUrl: string,
  userAgent: string,
  options: { headers?: Record<string, string>; tokens?: SiteAuthTokenDecryptedDto[] } = {}
): Promise<PlainPage> {
  const signal = AbortSignal.timeout(PLAIN_FETCH_TIMEOUT_MS);
  const { allowPrivateAddresses } = await getPageRenderersConfig();
  let url = targetUrl;

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const parsed = URL.parse(url);

      if (!parsed || !/^https?:$/.test(parsed.protocol)) {
        log.warn({ url }, "Refused to fetch a link that is not a web page");

        return { html: "", status: null, url };
      }

      if (await isRefusedHost(parsed.hostname, allowPrivateAddresses)) {
        log.warn({ url }, "Refused to fetch a private address");

        return { html: "", status: null, url, refused: true };
      }

      const onSite =
        parsed.protocol === "https:" ? tokensOnSite(parsed.hostname, options.tokens) : [];
      const cookie = onSite
        .filter((token) => token.type === "cookie")
        .map(({ name, value }) => `${name}=${value}`)
        .join("; ");
      const response = await fetch(url, {
        headers: {
          "user-agent": userAgent,
          ...options.headers,
          ...Object.fromEntries(
            onSite
              .filter((token) => token.type === "header")
              .map(({ name, value }) => [name, value])
          ),
          ...(cookie ? { cookie } : {}),
        },
        redirect: "manual",
        signal,
      });
      const location =
        response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;

      if (location) {
        await response.body?.cancel();
        url = new URL(location, url).href;
        continue;
      }

      const answeredFrom = response.url || url;

      if (!response.ok) {
        log.debug({ url, status: response.status }, "A plain fetch was answered with an error");

        return { html: "", status: response.status, url: answeredFrom };
      }

      return { html: await response.text(), status: response.status, url: answeredFrom };
    }

    log.debug({ url: targetUrl }, "A plain fetch was redirected too many times");

    return { html: "", status: null, url };
  } catch (error) {
    log.debug({ err: error, url: targetUrl }, "A plain fetch failed");

    return { html: "", status: null, url };
  }
}

// `page.evaluate` runs in the page, where `document` exists; this package compiles without DOM types.
declare const document: { cookie: string };

/**
 * Render a page with the Page Renderers that are switched on and return its HTML.
 *
 * The renderer owns the browser identity, JavaScript execution, page settling,
 * stealth and tracker blocking. Norish adds exactly one thing: the requesting
 * user's Site Auth Tokens, in a context that belongs to this fetch alone.
 *
 * An empty string means no Page Renderer produced usable HTML, and the import
 * path reports that as a fetch failure.
 *
 * `isSettled` is the caller's own reading of whether the rendered HTML is the
 * page it asked for. Only a caller knows: a shop's bot check and a shop's
 * empty results page are the same two kilobytes to everyone else. Without it
 * the page is read once, the moment it loads, exactly as before.
 */
export async function fetchRenderedPage(
  targetUrl: string,
  tokens?: SiteAuthTokenDecryptedDto[],
  isSettled?: (html: string) => boolean
): Promise<string> {
  return (await renderPage(targetUrl, tokens, isSettled)).html;
}

/** `fetchRenderedPage`, keeping the status a site answered with, so a refusal can be named. */
export async function renderPage(
  targetUrl: string,
  tokens?: SiteAuthTokenDecryptedDto[],
  isSettled?: (html: string) => boolean
): Promise<RenderedPage> {
  // Only a web page reaches a renderer, so a link stored before imports refused other schemes
  // (file:, gopher:) is never rendered.
  if (!/^https?:$/.test(URL.parse(targetUrl)?.protocol ?? "")) {
    log.warn({ url: targetUrl }, "Refused to render a link that is not a web page");

    return { html: "", status: null };
  }

  const renderers = await getPageRenderersConfig();
  const isReadable = (page: RenderedPage) =>
    page.html !== "" && !isBotCheck(page.html, page.status);
  let status: number | null = null;

  if (renderers.obscura.enabled) {
    const rendered = await renderInBrowser(
      "obscura",
      renderers.obscura,
      renderers.navigationTimeoutMs,
      targetUrl,
      tokens,
      isSettled,
      setTokensInObscura
    );

    if (isReadable(rendered)) return answered("obscura", targetUrl, rendered);
    status = rendered.status;
  }

  if (renderers.solver.enabled && renderers.solver.endpoint) {
    // A solver cannot keep tokens to their site, so it never gets them.
    if (tokens?.length) {
      log.info(
        { url: targetUrl, tokens: tokens.length },
        "Site Auth Tokens withheld from the solver"
      );
    }

    if (await isRefusedHost(new URL(targetUrl).hostname, renderers.allowPrivateAddresses)) {
      log.warn({ url: targetUrl }, "Refused to send a private address to the solver");
    } else {
      const solved = await renderInSolver(
        targetUrl,
        renderers.solver.endpoint,
        renderers.navigationTimeoutMs
      );

      if (isReadable(solved)) return answered("solver", targetUrl, solved);
    }
  }

  // Every renderer that is on failed, so the page is unreadable (ADR-0019).
  return { html: "", status };
}

function answered(renderer: "obscura" | "solver", url: string, page: RenderedPage): RenderedPage {
  log.info({ url, renderer }, "A Page Renderer read the page");

  return page;
}

const SolverReplySchema = z.object({
  status: z.literal("ok"),
  solution: z.object({ response: z.string() }),
});

/**
 * Ask a FlareSolverr-compatible solver for the page. FlareSolverr and Byparr both hard-code the
 * page's status to 200, so a solved page reports none, and its answer is read once.
 */
async function renderInSolver(
  targetUrl: string,
  endpoint: string,
  maxTimeout: number
): Promise<RenderedPage> {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd: "request.get", url: targetUrl, maxTimeout }),
      signal: AbortSignal.timeout(maxTimeout + SOLVER_LAUNCH_MS),
    });
    const reply = SolverReplySchema.safeParse(
      response.ok ? await response.json().catch(() => null) : null
    );

    if (reply.success) return { html: reply.data.solution.response, status: null };
    log.warn({ url: targetUrl, status: response.status }, "The solver could not render the page");
  } catch (error) {
    log.warn({ err: error, url: targetUrl }, "The solver could not render the page");
  }

  return { html: "", status: null };
}

/**
 * How a browser is handed the Site Auth Tokens on the target's https site, before its main
 * navigation. A navigation of its own keeps within `timeLeft()`.
 */
type SetTokens = (
  context: BrowserContext,
  page: Page,
  tokens: SiteAuthTokenDecryptedDto[],
  targetUrl: string,
  timeLeft: () => number
) => Promise<void>;

/** Render a page in a CDP Page Renderer, in a context of this fetch's own. */
async function renderInBrowser(
  renderer: BrowserRenderer,
  { endpoint, cdpToken }: { endpoint: string; cdpToken?: string },
  navigationTimeoutMs: number,
  targetUrl: string,
  tokens: SiteAuthTokenDecryptedDto[] | undefined,
  isSettled: ((html: string) => boolean) | undefined,
  setTokens: SetTokens
): Promise<RenderedPage> {
  // One deadline for the connection and every navigation; 0 would turn Playwright's timeout off.
  const deadline = Date.now() + navigationTimeoutMs;
  const timeLeft = () => Math.max(deadline - Date.now(), 1);
  let context: BrowserContext | undefined;
  let status: number | null = null;

  try {
    const browser = await getBrowser(renderer, endpoint, cdpToken, timeLeft());

    if (!browser) return { html: "", status };

    const { hostname, protocol } = new URL(targetUrl);
    // As in the plain fetch, no token goes over http, where it would travel in the clear.
    const onSite = protocol === "https:" ? tokensOnSite(hostname, tokens) : [];

    if (protocol !== "https:" && tokens?.length) {
      log.info(
        { url: targetUrl, tokens: tokens.length },
        "Site Auth Tokens withheld from an http page"
      );
    }

    // A fresh context per fetch, so one importer's tokens never reach another's page.
    context = await browser.newContext();

    const page = await context.newPage();

    if (onSite.length > 0) await setTokens(context, page, onSite, targetUrl, timeLeft);

    page.on("response", (response) => {
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
        status = response.status();
      }
    });

    const response = await page.goto(targetUrl, {
      waitUntil: "load",
      // What is left of the one deadline. Waiting past it for the page to become itself has its
      // own, SETTLE_TIMEOUT_MS, because only a caller can tell that it has not.
      timeout: timeLeft(),
    });

    status ??= response?.status() ?? null;

    const html = isSettled ? await settledContent(page, isSettled) : await page.content();

    return { html, status };
  } catch (error) {
    log.warn({ err: error, url: targetUrl, renderer }, "A Page Renderer could not render the page");

    return { html: "", status };
  } finally {
    if (context) {
      await context.close().catch((err) => {
        log.debug({ err, renderer }, "Failed to close a browser context during cleanup");
      });
    }
  }
}

/** Obscura's tokens: headers through its `scopeDomain`, cookies set from the target's own origin. */
async function setTokensInObscura(
  context: BrowserContext,
  page: Page,
  tokens: SiteAuthTokenDecryptedDto[],
  targetUrl: string,
  timeLeft: () => number
): Promise<void> {
  const headerTokens = tokens.filter((t) => t.type === "header");
  const cookieTokens = tokens.filter((t) => t.type === "cookie");

  if (headerTokens.length > 0) await sendHeadersToTheirSite(context, page, headerTokens, targetUrl);

  // Obscura never sends a cookie set over CDP but does send one a page sets, so the tokens are set
  // from the target's origin, for the token's domain, secure, and stay within it.
  if (cookieTokens.length > 0) {
    await page.goto(new URL("/robots.txt", targetUrl).href, {
      waitUntil: "domcontentloaded",
      timeout: timeLeft(),
    });
    await page.evaluate(
      (lines) => {
        for (const line of lines) document.cookie = line;
      },
      cookieTokens.map(
        ({ name, value, domain }) =>
          `${name}=${value}; path=/; domain=${domain.toLowerCase()}; secure`
      )
    );
  }
}
