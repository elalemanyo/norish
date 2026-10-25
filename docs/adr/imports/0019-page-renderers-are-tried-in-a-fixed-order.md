# Page Renderers are tried in a fixed order, and only Obscura carries tokens

URL imports, Store Visits and the Instagram caption fallback all read some pages that a plain fetch cannot, so they hand those pages to a Page Renderer. Until 0.26 the only Page Renderer was Obscura. That stopped being enough: Cloudflare challenges Obscura on sites it serves to an honest plain request (#641), and operators already run FlareSolverr or Byparr for other services. **An administrator now switches on Obscura and a FlareSolverr-compatible solver separately, in one admin setting seeded from env on first boot. Every caller fetches plainly first, then tries Obscura, then the solver, in that fixed order, and moves on only when a renderer comes back with no HTML or with a bot check.** A request carrying Site Auth Tokens sends them only to Obscura. When Obscura is off or fails, the solver gets the request without them, and the log says the tokens were withheld.

## Considered Options

- **One engine only.** This was the previous decision. It cannot get past a site whose bot check reads Obscura, and an administrator who already runs a solver has no way to use it.
- **Racing both renderers.** Every render would pay for a solver browser (FlareSolverr and Byparr launch a fresh browser per request, about 6 s each). Every Store Visit refresh would double its browser launches. Aborting the request does not stop the solver's browser either. Meanwhile the case racing helps with is already fast: Obscura returns a challenge page within seconds, and the bot-check test fails it at once.
- **An admin-orderable chain, a remembered renderer per host, or a host-to-renderer list.** One wasted Obscura attempt on a background job does not justify a setting or state that goes stale. Remembering per host is the place to add it if those seconds ever matter.
- **"No recipe found" as a failure.** That would re-run parsing, and pay for AI, once per renderer. The fetch layer judges from the HTML alone.
- **Sending cookies to FlareSolverr.** FlareSolverr takes only `{name, value}` cookies and sets them on whichever host its first load ended on, so a redirect off the site would carry the session with it. Byparr drops cookies altogether. Neither solver accepts headers.

## Consequences

- **Private addresses.** Neither solver has a private-network deny, and neither authenticates `/v1`.
  - An **Allow private addresses** admin switch, off by default, makes Norish refuse a target that resolves to a loopback, RFC1918 or link-local address. The refusal happens before the plain fetch and before the solver.
  - The switch does not cover redirects and DNS rebinding inside the solver's browser, or image downloads.
  - Obscura keeps its own deny regardless of the switch, because it is enforced at DNS resolution and built into the shipped image. `--allow-private-network` and `OBSCURA_ALLOW_PRIVATE_NETWORK` appear nowhere. With the switch on, a LAN recipe site gets through the plain fetch or the solver, Obscura refuses it, and the chain moves on.
  - The off default is a change for upgraders, because the plain fetch used to reach private addresses.
- **Status.** Both solvers hard-code `status: 200`. A solver's render therefore reports a null status and never names a refusal, and the import fails with its usual fetch failure.
- **Store Visits' settle callback** reaches Obscura only. A solver's answer is read once: Byparr waits for `networkidle`, and FlareSolverr waits for its challenge to clear.
- **Bot-check test.** There is one bot-check test, in `parser/fetch.ts`. It catches Cloudflare's challenge markup and the small title-less stub that Store Visits already caught, and it is shared by every caller.
- **Failure.** A render that fails at every enabled renderer fails the import. Nothing retries outside the chain. With both renderers off, Norish fetches plainly only, and the Instagram caption fallback is skipped.
- **Shipped defaults.** Compose ships Obscura switched on. FlareSolverr and Byparr appear as commented-out alternatives on port 8191. Upgraders' existing `OBSCURA_ENDPOINT` and `OBSCURA_CDP_TOKEN` seed the setting, and after that, admin settings own it.
- **Obscura stays Norish's own artifact.** `docker/obscura/` repackages the pinned `-stealth` release archive of the norish-recipes fork. `pin.env` records the release and the image tag together, and the publish workflow refuses to overwrite a tag. Stealth is not configurable, and neither is anything else about the browser. Upstream's image was rejected because it is built `--features render` and carries none of the stealth build's BoringSSL symbols. A from-source build was rejected because repackaging buys the same binary.
- **The boundary stays narrow.**
  - `packages/api/src/obscura.ts` holds one cached connection, and `parser/fetch.ts` holds the per-fetch context and the chain.
  - The chain is two named calls in a fixed order. There is no engine registry and no `BrowserEngine` interface.
  - Whether the HTML holds a recipe is still the parser's and the AI fallback's question. The bot-check test reads the HTML that comes back and never waits on a selector.
- **One Playwright generation.** Runtime `playwright-core` tracks `@playwright/test`. The E2E runner's Chromium is acceptance tooling and has nothing to do with this decision.
- **Page Renderer is now a glossary term**, because administrators choose it. Obscura, FlareSolverr and Byparr are its values, not glossary terms.
