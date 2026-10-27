# 85: An upgraded library reads its lines as a new import

**What to build:** Tickets 82 and 84 changed how a line's text is read (a name up to its note, comma lists), but nothing read existing lines again: a line keeps its food until its text changes or its spelling goes. An upgraded library therefore kept "peper, zout" on pepper alone and "olie om te bakken" as an own food, where a fresh import of the same recipes now reads pepper and salt, and olie.

**Blocked by:** 82, 84

**Status:** done

## Decided (Mike, 2026-10-27)

"I think the best way is to just recheck the whole library and clean it no?, just don't check seeded foods?"

## Implemented (2026-10-27)

- `listSpellingsForCleanup` says whether a spelling's food is an undecided own one. In the first-start cleanup, such a spelling whose text reads up to its note as another known food (`findFoodBeforeNote`, the resolver's note reading without the whole-text match) is a variant whose clean name is that food's spelling: `removeVariants` merges the food into it and its rows read again. Foods a person kept distinct, named or parented stay.
- Step 9 reads every line naming a food again (`resolveAgain(…, "upgrade", { refine: true })`, 500 a round): `refine` writes only a line that now reads other foods, and a line reading none (junk, left to AI's spelling check) keeps its food. `resolveAgain` answers how many lines it wrote; the outcome counts them as `reread`.
- `CLEANUP_VERSION` 8.
- Tests: `first-start-cleanup.test.ts` (a note food merges, a kept one stays; a comma line reads both foods while an unchanged line keeps its version; the junk-pile test still holds).
- Docs: ADR-0037 amendment, the release notes' first-start upgrade note, pt-BR.
