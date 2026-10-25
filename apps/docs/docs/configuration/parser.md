---
sidebar_position: 6
title: Recipe parser
description: How URL imports load and read recipe pages.
---

# Recipe parser

A URL import first fetches the page plainly. A page that already holds a
recipe in its HTML is read straight away. Any other page goes to the **page
renderers**, browsers that read pages a plain fetch cannot. Norish then reads
the recipe with [recipe-scrapers](https://github.com/hhursev/recipe-scrapers).
When that finds nothing and [AI](./ai-provider.md) is set up, the AI reads the
page instead. Video links go through
[video import](./ai-provider.md#video-import).

## Page renderers

Set them up under **Settings => Admin => Page renderers**.

![The Page renderers card in admin settings](/img/screenshots/admin-page-renderers.png)

- **Obscura** is the headless browser in the [Quick start](../quick-start.mdx)
  compose, the `obscura` service. It is tried first.
- **FlareSolverr or Byparr** is tried when Obscura gets no page or a bot check,
  like a Cloudflare challenge. The example compose file has both as
  commented-out services: uncomment one and enter its endpoint, like
  `http://flaresolverr:8191/v1`. Each page it reads starts a new browser, which
  takes a few seconds.

Site authentication tokens go to Obscura only. The solver gets the page
without them, so a page that needs you signed in needs Obscura. See
[Site authentication](./site-authentication.md).

With both off, Norish only fetches pages plainly. If no page renderer can read
a page, the import fails.

**Allow private addresses** is off by default, so imports and shop pages can't
reach loopback, private-network or link-local addresses, like your router or
other containers. Turn it on to import from a recipe site on your own network.
Obscura refuses these addresses either way, so such a page is read by the plain
fetch or the solver.

Keep both services inside your own network, without a host port: anything that
can reach Obscura can drive the browser, and the solvers take no password.

Obscura only starts on a network address when its `OBSCURA_CDP_TOKEN` is at
least 32 characters, and Norish has to send the same token. Generate one with
`openssl rand -hex 32`.

The compose files pin an exact Obscura image, like `0.2.4-norish.2`. For a
rolling release, use `norishapp/obscura:latest` instead.

A page counts as loaded once its images and scripts have finished too. If slow
sites fail with a timeout, raise the navigation timeout.

## Settings

These set up the page renderers at the first start. After that they live in
admin settings, and changing the variables does nothing.

| Variable                   | Description                                                   | Default             |
| -------------------------- | ------------------------------------------------------------- | ------------------- |
| `OBSCURA_ENDPOINT`         | Obscura CDP endpoint. Empty turns Obscura off                 | `ws://obscura:9222` |
| `OBSCURA_CDP_TOKEN`        | Token for Obscura, the same value as on the `obscura` service | (empty)             |
| `PAGE_SOLVER_ENABLED`      | Try FlareSolverr or Byparr after Obscura                      | `false`             |
| `PAGE_SOLVER_ENDPOINT`     | The solver's `/v1` endpoint                                   | (empty)             |
| `ALLOW_PRIVATE_ADDRESSES`  | Let imports reach private addresses                           | `false`             |
| `PAGE_RENDERER_TIMEOUT_MS` | How long a page renderer is given to load a page, in ms       | `45000`             |

| Variable                | Description                        | Default |
| ----------------------- | ---------------------------------- | ------- |
| `PARSER_API_TIMEOUT_MS` | Parser API timeout in milliseconds | `15000` |

## Content detection

Overrides for how Norish detects recipe content. Most servers don't need these.

| Variable              | Description                                     | Default |
| --------------------- | ----------------------------------------------- | ------- |
| `UNITS_JSON`          | Override the units dictionary                   | (empty) |
| `CONTENT_INDICATORS`  | Override recipe-content indicator configuration | (empty) |
| `CONTENT_INGREDIENTS` | Override ingredient-content configuration       | (empty) |
