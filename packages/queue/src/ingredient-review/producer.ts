import type { IngredientReviewJobData } from "@norish/queue/contracts/job-types";
import { findCatalogueIngredientNames } from "@norish/db/repositories/ingredient-catalogue";
import {
  getAutomaticIngredientsConfig,
  isAIEnabled,
} from "@norish/shared-server/config/server-config-loader";

import { addMissingIconsJob } from "../ingredient-icons/producer";
import { getQueues } from "../registry";

/**
 * What a mint for someone's action queues: AI's pass where Clean up new ingredients is on, which
 * draws after it, else the missing icons straight away.
 */
export async function queueAfterMint(ingredientIds: readonly string[]): Promise<void> {
  if ((await getAutomaticIngredientsConfig()).cleanUp) await addIngredientReviewJob(ingredientIds);
  else await addMissingIconsJob(ingredientIds);
}

/** Queue the AI pass over these foods. Nothing is queued while AI is off, or for a food gone since. */
export async function addIngredientReviewJob(ingredientIds: readonly string[]): Promise<void> {
  await addReviewJob(ingredientIds);
}

/** Queue AI's check of the spellings added to these seeded foods (`checkSpellingsOf`), beside the pass. */
export async function addSpellingCheckJob(ingredientIds: readonly string[]): Promise<void> {
  await addReviewJob(ingredientIds, { check: "spellings" });
}

async function addReviewJob(
  ingredientIds: readonly string[],
  asked: Pick<IngredientReviewJobData, "check"> = {}
) {
  if (ingredientIds.length === 0 || !(await isAIEnabled())) return;
  const names = await findCatalogueIngredientNames(ingredientIds);
  const ingredients = [...names].map(([id, name]) => ({ id, name }));

  if (ingredients.length === 0) return;
  await getQueues().ingredientReview.add("review", { ingredients, ...asked });
}
