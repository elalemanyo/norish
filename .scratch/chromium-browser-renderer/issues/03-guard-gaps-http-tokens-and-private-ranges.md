# 03: No tokens to a browser over http, and the missing private-address ranges

**What to build:** Two guard gaps close.

- A browser renderer never receives Site Auth Tokens for a target that is not https. This matches the plain fetch, which already sends tokens only to https hops. Today Obscura sets cookies without `secure` and sends header tokens to http targets.
- The private-address guard also refuses 100.64.0.0/10 (CGNAT and Tailscale), 198.18.0.0/15, 224.0.0.0/4, 240.0.0.0/4 and 64:ff9b::/96.

Spec: `.scratch/chromium-browser-renderer/spec.md` (Tokens: http targets; Private addresses).

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] An http import through Obscura sets no cookie tokens and no header tokens. The tests fail before the fix.
- [ ] The existing test that locks in a non-`secure` cookie for an http target is replaced, not kept.
- [ ] An https import through Obscura carries its tokens as before.
- [ ] A literal address in each new range, and a hostname resolving to one, is refused at the plain fetch and before the solver, with Allow private addresses off.
- [ ] With Allow private addresses on, those addresses are allowed.
