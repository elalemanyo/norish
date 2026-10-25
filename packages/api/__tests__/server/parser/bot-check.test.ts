// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { isBotCheck } from "@norish/api/parser/fetch";

vi.mock("@norish/shared-server/logger", () => ({
  parserLogger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const padding = "x".repeat(30_000);

/** Cloudflare's managed challenge, trimmed to the markup that names it. */
const CLOUDFLARE_CHALLENGE = `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>
<meta http-equiv="refresh" content="390"></head><body><div class="main-wrapper" role="main">
<noscript><div class="h2"><span id="challenge-error-text">Enable JavaScript and cookies to continue</span></div></noscript>
</div><script>(function(){window._cf_chl_opt={cvId: '3',cZone: "www.example.com",cType: 'managed'};})();</script>
${padding}</body></html>`;
/** The older interstitial, which names itself in a class rather than its title. */
const CLOUDFLARE_INTERSTITIAL = `<html><head><title>Attention Required! | Cloudflare</title></head>
<body><div class="cf-challenge-running">Checking your browser before accessing example.com.</div>${padding}</body></html>`;
const UNICODE_TITLE = `<html><head><title>Just a moment…</title></head><body>${padding}</body></html>`;
const STUB = "<html><body>checking your browser</body></html>";
const RECIPE_PAGE = `<html><head><title>Lasagne | Example Kitchen</title>
<script type="application/ld+json">{"@type":"Recipe","name":"Lasagne"}</script></head><body>${padding}</body></html>`;
const SHOP_PAGE = `<html><head><title>Zoekresultaten kaas | Dirk</title></head><body><ul class="products">${padding}</ul></body></html>`;

describe("isBotCheck", () => {
  it("reads Cloudflare's challenge pages as a bot check", () => {
    expect(isBotCheck(CLOUDFLARE_CHALLENGE)).toBe(true);
    expect(isBotCheck(CLOUDFLARE_INTERSTITIAL)).toBe(true);
    expect(isBotCheck(UNICODE_TITLE)).toBe(true);
  });

  it("reads a small page with no title of its own as a bot check", () => {
    expect(isBotCheck(STUB)).toBe(true);
    expect(isBotCheck("<html><head><title> </title></head></html>")).toBe(true);
  });

  it("reads a real recipe page and a real shop page as themselves", () => {
    expect(isBotCheck(RECIPE_PAGE)).toBe(false);
    expect(isBotCheck(SHOP_PAGE)).toBe(false);
    expect(isBotCheck("<html><head><title>Kaas</title></head><body>small</body></html>")).toBe(
      false
    );
  });
});
