// @vitest-environment node
/**
 * What queues the AI pass: the foods a mint made, each by name, and nothing while AI is off or for
 * a food gone since; a mint queues it only where Clean up new ingredients is on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AutomaticIngredientsConfig } from "@norish/config/zod/server-config";
import { DEFAULT_AUTOMATIC_INGREDIENTS } from "@norish/config/zod/server-config";
import { addIngredientReviewJob, queueAfterMint } from "@norish/queue/ingredient-review/producer";

const config = vi.hoisted(() => ({
  isAIEnabled: vi.fn(async () => true),
  getAutomaticIngredientsConfig: vi.fn(),
}));
const catalogue = vi.hoisted(() => ({
  findCatalogueIngredientNames: vi.fn(
    async (ids: readonly string[]) =>
      new Map(ids.filter((id) => id !== "gone").map((id) => [id, `${id}!`]))
  ),
}));
const icons = vi.hoisted(() => ({
  listFoodsShowingNoIcon: vi.fn(async (ids: readonly string[]) =>
    ids.map((id) => ({ id, name: `${id}!` }))
  ),
}));
const reviewQueue = vi.hoisted(() => ({ add: vi.fn(async () => ({ id: "pass-1" })) }));
const iconQueue = vi.hoisted(() => ({ add: vi.fn(async () => ({ id: "icons-1" })) }));

vi.mock("@norish/shared-server/config/server-config-loader", () => config);
vi.mock("@norish/db/repositories/ingredient-catalogue", () => catalogue);
vi.mock("@norish/shared-server/ingredients/icon-rounds", () => icons);
vi.mock("@norish/queue/registry", () => ({
  getQueues: () => ({ ingredientReview: reviewQueue, ingredientIcons: iconQueue }),
}));

function automatic(options: Partial<AutomaticIngredientsConfig>) {
  config.getAutomaticIngredientsConfig.mockResolvedValue({
    ...DEFAULT_AUTOMATIC_INGREDIENTS,
    ...options,
  });
}

beforeEach(() => {
  config.isAIEnabled.mockResolvedValue(true);
  automatic({});
  reviewQueue.add.mockClear();
  iconQueue.add.mockClear();
});

describe("addIngredientReviewJob", () => {
  it("queues one pass over the foods still there, each by name", async () => {
    await addIngredientReviewJob(["uien", "gone", "knaks"]);

    expect(reviewQueue.add).toHaveBeenCalledExactlyOnceWith("review", {
      ingredients: [
        { id: "uien", name: "uien!" },
        { id: "knaks", name: "knaks!" },
      ],
    });
  });

  it("queues nothing while AI is off, without a food, or when every food is gone", async () => {
    config.isAIEnabled.mockResolvedValueOnce(false);
    await addIngredientReviewJob(["uien"]);
    await addIngredientReviewJob([]);
    await addIngredientReviewJob(["gone"]);

    expect(reviewQueue.add).not.toHaveBeenCalled();
  });
});

describe("queueAfterMint", () => {
  it("queues nothing with nothing selected", async () => {
    await queueAfterMint(["uien"]);

    expect(reviewQueue.add).not.toHaveBeenCalled();
    expect(iconQueue.add).not.toHaveBeenCalled();
  });

  it("queues the AI pass with Clean up on, which draws the icons after it", async () => {
    automatic({ cleanUp: true, icon: true });
    await queueAfterMint(["uien"]);

    expect(reviewQueue.add).toHaveBeenCalledExactlyOnceWith("review", {
      ingredients: [{ id: "uien", name: "uien!" }],
    });
    expect(iconQueue.add).not.toHaveBeenCalled();
  });

  it("draws the missing icons straight away with Clean up off and Draw on", async () => {
    automatic({ icon: true });
    await queueAfterMint(["uien"]);

    expect(reviewQueue.add).not.toHaveBeenCalled();
    expect(iconQueue.add).toHaveBeenCalledExactlyOnceWith("draw", {
      ingredients: [{ id: "uien", name: "uien!" }],
      actor: null,
    });
  });

  it("queues no AI job for the fills alone, which nothing does yet", async () => {
    automatic({ nutrition: true, conversions: true });
    await queueAfterMint(["uien"]);

    expect(reviewQueue.add).not.toHaveBeenCalled();
    expect(iconQueue.add).not.toHaveBeenCalled();
  });
});
