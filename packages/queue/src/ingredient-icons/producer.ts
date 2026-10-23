import type { Queue } from "bullmq";

import type { IngredientIconsJobData } from "@norish/queue/contracts/job-types";
import { getAutomaticIngredientsConfig } from "@norish/shared-server/config/server-config-loader";
import { listFoodsShowingNoIcon } from "@norish/shared-server/ingredients/icon-rounds";

import { getQueues } from "../registry";

/** Start a Draw icons round over these foods. Answers the job's id, which the page watches the round by. */
export async function addIngredientIconsJob(
  queue: Queue<IngredientIconsJobData>,
  data: IngredientIconsJobData
): Promise<string> {
  const job = await queue.add("draw", data);

  return job.id ?? "";
}

/** Draw each of these foods still there that shows no icon, where Draw missing icons is on. */
export async function addMissingIconsJob(ingredientIds: readonly string[]): Promise<void> {
  if (ingredientIds.length === 0 || !(await getAutomaticIngredientsConfig()).icon) return;
  const foods = await listFoodsShowingNoIcon(ingredientIds);

  if (foods.length > 0) {
    await addIngredientIconsJob(getQueues().ingredientIcons, { ingredients: foods, actor: null });
  }
}
