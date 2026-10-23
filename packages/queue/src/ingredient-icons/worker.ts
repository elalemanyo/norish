/**
 * Ingredient Icons Worker
 *
 * A Draw icons round (`@norish/shared-server/ingredients/icon-rounds`): one
 * job for however many foods a person asked to be drawn, or an AI pass left
 * showing no icon, one step per food,
 * drawn one after another with the instance's image provider and set as the
 * food's own icon. The round's count, and which foods are still to be drawn,
 * follow over the socket as icons land, and the changes are announced
 * together once every food is drawn. A food
 * the asker may no longer edit, one that is gone or one a person gave an icon
 * meanwhile is passed over, and a food whose drawing broke is recorded as
 * failed on its own step, with the cause; neither ends the round. Its worker
 * wraps the processor so the image model each drawing asks reaches the job
 * monitor.
 */

import type { Job } from "bullmq";

import type { IngredientIconsJobData } from "@norish/queue/contracts/job-types";
import { announcingTogether } from "@norish/shared-server/ingredients/changes";
import {
  drawNewIngredientIcon,
  drawRoundIcon,
} from "@norish/shared-server/ingredients/icon-rounds";
import { createLogger } from "@norish/shared-server/logger";
import { ingredients } from "@norish/shared-server/realtime/ingredients";

import type { JobStepEvent } from "../job-steps";
import type { IconStepDetail } from "./progress";
import { createWorker, isFinalFailure } from "../create-worker";
import { describeError } from "../helpers";
import { recordCompletedSteps } from "../job-steps";
import { QUEUE_NAMES } from "../queue-names";
import { ICON_STEP, summarizeIconRound } from "./progress";

const log = createLogger("worker:ingredient-icons");

/**
 * How many times a round writes its steps down: the job's progress is
 * rewritten whole on each write, so a write per food would store the square
 * of the round's size.
 */
const ROUND_WRITES = 20;

/**
 * How often, at most, a round tells the pages how far it has come. Telling
 * costs no write, so the pages hear of each drawing; foods passed over settle
 * at once, and are told together.
 */
const ANNOUNCE_EVERY_MS = 1000;

/** Draw one food's icon, as its asker or for the AI pass; a failure is recorded on its step. */
async function draw(
  job: Job<IngredientIconsJobData>,
  ingredientId: string
): Promise<IconStepDetail> {
  const { actor } = job.data;

  try {
    const outcome = actor
      ? await drawRoundIcon(actor, ingredientId)
      : await drawNewIngredientIcon(ingredientId);

    return { ingredientId, ...outcome };
  } catch (error) {
    log.error({ err: error, jobId: job.id, ingredientId }, "Drawing an Ingredient Icon failed");

    return { ingredientId, outcome: "failed", error: describeError(error) };
  }
}

/**
 * Tell every open page how far the round is, counting the foods settled but
 * not yet written down. Best-effort: the icons themselves have landed.
 */
async function announceRound(
  job: Job<IngredientIconsJobData>,
  finished: boolean,
  unwritten: readonly IconStepDetail[] = []
): Promise<void> {
  // A round the AI pass queued is nobody's to watch: its icons land as changes.
  if (!job.data.actor) return;
  try {
    await ingredients.publish("icons", summarizeIconRound(job, finished, unwritten), undefined);
  } catch (error) {
    log.warn({ err: error, jobId: job.id }, "Could not announce the round's progress");
  }
}

/** Exported so the job body can be exercised without a Valkey-backed worker. */
export async function processIngredientIconsJob(
  job: Job<IngredientIconsJobData>,
  _token?: string,
  signal?: AbortSignal
): Promise<void> {
  const { ingredients: foods } = job.data;
  const writeEvery = Math.max(1, Math.ceil(foods.length / ROUND_WRITES));
  let unwritten: (JobStepEvent & { endedAt: number; detail: IconStepDetail })[] = [];
  let announcedAt = 0;

  log.info({ jobId: job.id, count: foods.length }, "Drawing Ingredient Icons");

  // Every icon set is announced once, together, when the round is done.
  await announcingTogether(async () => {
    // ponytail: one drawing at a time, as image APIs rate-limit hard; draw a few at once if rounds feel slow.
    for (const [index, food] of foods.entries()) {
      // A cancelled round draws no further food.
      if (signal?.aborted) break;
      const startedAt = Date.now();
      const { ingredientId, ...outcome } = await draw(job, food.id);

      unwritten.push({
        id: `${ICON_STEP}:${index + 1}/${foods.length}`,
        startedAt,
        endedAt: Date.now(),
        detail: { ingredientId, name: food.name, ...outcome },
      });
      const last = index + 1 === foods.length;

      if (unwritten.length >= writeEvery || last) {
        await recordCompletedSteps(job, unwritten);
        unwritten = [];
      }
      if (last || Date.now() - announcedAt < ANNOUNCE_EVERY_MS) continue;

      announcedAt = Date.now();
      await announceRound(
        job,
        false,
        unwritten.map((step) => step.detail)
      );
    }
    if (unwritten.length > 0) await recordCompletedSteps(job, unwritten);
  });
  signal?.throwIfAborted();
  await announceRound(job, true);
}

/** A round that gave up ends on every open page too, at the count it reached. */
export async function handleIngredientIconsFailure(
  job: Job<IngredientIconsJobData> | undefined,
  error: Error
): Promise<void> {
  if (!job || !isFinalFailure(job, error)) return;
  await announceRound(job, true);
}

export function startIngredientIconsWorker(): void {
  createWorker<IngredientIconsJobData>(QUEUE_NAMES.INGREDIENT_ICONS, processIngredientIconsJob, {
    onFailed: handleIngredientIconsFailure,
  });
}
