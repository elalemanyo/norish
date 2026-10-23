# 04 Fill gaps button, and the per-user Draw icons round goes

Status: ready-for-agent
Blocked by: 02, 03

Spec: Solution 5, 7

## What

- In the Ingredient catalogue section beside Clean up catalogue, a **Fill gaps** button opens a dialog with checkboxes Nutrition, Conversions, Icons, each with how many listed foods it would fill (Icons only when image generation can draw). Confirm starts one job, visible and cancellable in the Job queue.
- Gap only: a food with its own value for a field (dataset, fix, correction, earlier AI estimate) is never asked for it; Icons are for foods that show none (`listFoodsShowingNoIcon` rules: broad groups left without one stay without). Listed foods only, seeded included, grocery-only foods out.
- Remove the Draw icons control, modal and round from the Ingredients page (`draw-icons-control.tsx`, `draw-icons-modal.tsx`, `ingredients.drawIcons`/`iconScope`, `listIconRoundFoods` scopes no longer used). Single-icon Generate in the food's icon menu stays.

## Acceptance

- Count and fill tests: gap-only writes, seeded included, grocery-only excluded.
- E2E (`ai` project): Fill gaps for nutrition gives a food without dataset numbers an "Estimated by AI" value.
