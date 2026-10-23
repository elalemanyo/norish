import type { FillAsked } from "@norish/shared-server/ingredients/nutrition/fill-gaps";
import {
  getAutomaticIngredientsConfig,
  isAIEnabled,
} from "@norish/shared-server/config/server-config-loader";
import { listFoodsWithGaps } from "@norish/shared-server/ingredients/nutrition/fill-gaps";

import { addMissingIconsJob } from "../ingredient-icons/producer";
import { getQueues } from "../registry";

/** Queue AI filling the gaps `asked` covers in these foods, one job; answers how many it asks about. */
export async function addIngredientFillJob(
  ingredientIds: readonly string[],
  asked: FillAsked
): Promise<number> {
  if (ingredientIds.length === 0 || !(asked.nutrition || asked.conversions)) return 0;
  if (!(await isAIEnabled())) return 0;
  const ingredients = await listFoodsWithGaps(ingredientIds, asked);

  if (ingredients.length > 0) await getQueues().ingredientFill.add("fill", { ingredients, asked });

  return ingredients.length;
}

/** Fill new foods' gaps where Fill missing nutrition or Fill missing conversions is on. */
export async function addNewFoodsFillJob(ingredientIds: readonly string[]): Promise<void> {
  const { nutrition, conversions } = await getAutomaticIngredientsConfig();

  await addIngredientFillJob(ingredientIds, { nutrition, conversions });
}

/** What a new food queues once the clean-up left it, or straight after the mint: its icon and gaps. */
export async function queueIconAndFills(ingredientIds: readonly string[]): Promise<void> {
  await addMissingIconsJob(ingredientIds);
  await addNewFoodsFillJob(ingredientIds);
}
