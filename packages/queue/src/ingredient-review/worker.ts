/**
 * The AI pass over Ingredients (ADR-0037, amended 2026-10-17): a step per food, each answer an AI
 * Change, then the foods still there and showing no icon go to the icons queue.
 */

import type { Job } from "bullmq";

import type { IngredientReviewJobData } from "@norish/queue/contracts/job-types";
import type { ModelUse } from "@norish/shared-server/ai/runtime/model-use-ledger";
import type { SpellingCheckOutcome } from "@norish/shared-server/ingredients/spelling-check";
import type { ReviewOutcome } from "@norish/shared/contracts/ingredient-catalogue";
import { SERVER_CONFIG } from "@norish/config/env-config-server";
import {
  createModelUseLedger,
  recordModelUse,
  runWithModelUseLedger,
} from "@norish/shared-server/ai/runtime/model-use-ledger";
import { announcingTogether } from "@norish/shared-server/ingredients/changes";
import { askAIAbout } from "@norish/shared-server/ingredients/review";
import { checkSpellingsOf } from "@norish/shared-server/ingredients/spelling-check";
import { createLogger } from "@norish/shared-server/logger";

import type { JobStepEvent } from "../job-steps";
import { createWorker } from "../create-worker";
import { addMissingIconsJob } from "../ingredient-icons/producer";
import { recordCompletedSteps } from "../job-steps";
import { QUEUE_NAMES } from "../queue-names";

const log = createLogger("worker:ingredient-review");

/** The base id of every food's step; the food's place in the pass follows a colon. */
export const REVIEW_STEP = "asking-ai";

/** What a food's step records: the answer made and what AI was asked, a skip, or what broke. */
export type ReviewStepDetail = { ingredientId: string; name?: string } & (
  ReviewOutcome | SpellingCheckOutcome | { outcome: "failed"; error: string }
);

/** An error's message, with the cause a wrapper hides: a failed query names the database's complaint. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? error.cause.message : null;

  return cause ? `${error.message}: ${cause}` : error.message;
}

/** The question, asked of one food; an error is recorded on its step, and the pass goes on. */
async function ask(
  job: Job<IngredientReviewJobData>,
  question: (ingredientId: string) => Promise<ReviewOutcome | SpellingCheckOutcome>,
  ingredientId: string
): Promise<ReviewStepDetail> {
  try {
    return { ingredientId, ...(await question(ingredientId)) };
  } catch (error) {
    log.error({ err: error, jobId: job.id, ingredientId }, "Asking AI about a food failed");

    return { ingredientId, outcome: "failed" as const, error: describe(error) };
  }
}

/** How many foods are asked about at once (`INGREDIENT_REVIEW_CONCURRENCY`). */
function reviewConcurrency(): number {
  return SERVER_CONFIG.INGREDIENT_REVIEW_CONCURRENCY;
}

/** How many times a pass writes its answers down: progress is rewritten whole on each write. */
const PASS_WRITES = 20;

/** Whether AI answered for the food: a later pass may still merge one it could not reach. */
function answered(detail: ReviewStepDetail): boolean {
  return detail.outcome !== "failed" && detail.outcome !== "unanswered";
}

/** Exported so the job body can be exercised without a Valkey-backed worker. */
export async function processIngredientReviewJob(
  job: Job<IngredientReviewJobData>,
  _token?: string,
  signal?: AbortSignal
): Promise<void> {
  const { ingredients: foods } = job.data;
  // A spelling check is about seeded foods, which have their icons.
  const { question, drawsIcons } =
    job.data.check === "spellings"
      ? { question: checkSpellingsOf, drawsIcons: false }
      : { question: askAIAbout, drawsIcons: true };
  const writeEvery = Math.max(1, Math.ceil(foods.length / PASS_WRITES));
  let next = 0;
  let settled = 0;
  // The foods AI answered for, which may be drawn once the pass is over.
  const done = new Set<string>();
  // The answers not yet written down, as the steps the job monitor shows.
  let unwritten: (JobStepEvent & { endedAt: number })[] = [];
  // Writes go out one after another, so the timeline keeps the order foods settled in.
  let recording = Promise.resolve();

  log.info({ jobId: job.id, count: foods.length }, "Asking AI about Ingredients");

  const record = (
    food: IngredientReviewJobData["ingredients"][number],
    startedAt: number,
    detail: ReviewStepDetail,
    models: ModelUse[]
  ) => {
    settled += 1;
    if (answered(detail)) done.add(detail.ingredientId);
    unwritten.push({
      id: `${REVIEW_STEP}:${settled}/${foods.length}`,
      startedAt,
      endedAt: Date.now(),
      detail: { ...detail, name: food.name },
      models,
    });
    if (unwritten.length < writeEvery && settled < foods.length) return recording;

    const steps = unwritten;

    unwritten = [];
    recording = recording.then(() => recordCompletedSteps(job, steps));

    return recording;
  };

  const askNext = async (): Promise<void> => {
    // A cancelled pass asks no further food.
    while (next < foods.length && !signal?.aborted) {
      const food = foods[next++]!;
      const startedAt = Date.now();
      // The food's own requests, so the monitor says what each food took; the
      // attempt's ledger gets them too.
      const own = createModelUseLedger();
      const detail = await runWithModelUseLedger(own, () => ask(job, question, food.id));

      for (const use of own.uses) recordModelUse(use);
      await record(food, startedAt, detail, own.uses);
    }
  };

  // What the pass changed is announced once, together, as it ends.
  await announcingTogether(() =>
    Promise.all(
      Array.from({ length: Math.min(reviewConcurrency(), foods.length) }, () => askNext())
    )
  );
  await recording;
  signal?.throwIfAborted();
  if (drawsIcons) {
    await addMissingIconsJob(foods.flatMap((food) => (done.has(food.id) ? [food.id] : [])));
  }
}

export function startIngredientReviewWorker(): void {
  createWorker<IngredientReviewJobData>(QUEUE_NAMES.INGREDIENT_REVIEW, processIngredientReviewJob);
}
