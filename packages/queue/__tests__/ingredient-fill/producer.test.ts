// @vitest-environment node
/**
 * What queues AI filling foods' gaps: one job over the foods with a gap the options cover, and
 * nothing while AI is off or with no option on; a new food is filled by the administrator's options.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AutomaticIngredientsConfig } from "@norish/config/zod/server-config";
import { DEFAULT_AUTOMATIC_INGREDIENTS } from "@norish/config/zod/server-config";
import { addIngredientFillJob, addNewFoodsFillJob } from "@norish/queue/ingredient-fill/producer";

const config = vi.hoisted(() => ({
  isAIEnabled: vi.fn(async () => true),
  getAutomaticIngredientsConfig: vi.fn(),
}));
const fills = vi.hoisted(() => ({
  listFoodsWithGaps: vi.fn(async (ids: readonly string[]) =>
    ids.filter((id) => id !== "onion").map((id) => ({ id, name: `${id}!` }))
  ),
}));
const fillQueue = vi.hoisted(() => ({ add: vi.fn(async () => ({ id: "fill-1" })) }));

vi.mock("@norish/shared-server/config/server-config-loader", () => config);
vi.mock("@norish/shared-server/ingredients/nutrition/fill-gaps", () => fills);
vi.mock("@norish/queue/registry", () => ({ getQueues: () => ({ ingredientFill: fillQueue }) }));

function automatic(options: Partial<AutomaticIngredientsConfig>) {
  config.getAutomaticIngredientsConfig.mockResolvedValue({
    ...DEFAULT_AUTOMATIC_INGREDIENTS,
    ...options,
  });
}

beforeEach(() => {
  config.isAIEnabled.mockResolvedValue(true);
  automatic({});
  fillQueue.add.mockClear();
  fills.listFoodsWithGaps.mockClear();
});

describe("addIngredientFillJob", () => {
  it("queues one job over the foods with a gap, and says how many", async () => {
    const asked = { nutrition: true, conversions: false };

    await expect(addIngredientFillJob(["onion", "knaks", "tonijn"], asked)).resolves.toBe(2);
    expect(fills.listFoodsWithGaps).toHaveBeenCalledWith(["onion", "knaks", "tonijn"], asked);
    expect(fillQueue.add).toHaveBeenCalledExactlyOnceWith("fill", {
      ingredients: [
        { id: "knaks", name: "knaks!" },
        { id: "tonijn", name: "tonijn!" },
      ],
      asked,
    });
  });

  it("queues nothing while AI is off, with no option on, or without a gap", async () => {
    config.isAIEnabled.mockResolvedValueOnce(false);
    await addIngredientFillJob(["knaks"], { nutrition: true, conversions: true });
    await addIngredientFillJob(["knaks"], { nutrition: false, conversions: false });
    await addIngredientFillJob(["onion"], { nutrition: true, conversions: true });

    expect(fillQueue.add).not.toHaveBeenCalled();
  });
});

describe("addNewFoodsFillJob", () => {
  it("fills nothing with neither fill selected", async () => {
    automatic({ cleanUp: true, icon: true });
    await addNewFoodsFillJob(["knaks"]);

    expect(fillQueue.add).not.toHaveBeenCalled();
  });

  it.each([
    [{ nutrition: true }, { nutrition: true, conversions: false }],
    [{ conversions: true }, { nutrition: false, conversions: true }],
    [
      { nutrition: true, conversions: true },
      { nutrition: true, conversions: true },
    ],
  ])("asks for what %o selects", async (options, asked) => {
    automatic(options);
    await addNewFoodsFillJob(["knaks"]);

    expect(fillQueue.add).toHaveBeenCalledExactlyOnceWith("fill", {
      ingredients: [{ id: "knaks", name: "knaks!" }],
      asked,
    });
  });
});
