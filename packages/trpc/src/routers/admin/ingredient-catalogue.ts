import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { CleanUpScope } from "@norish/queue/ingredient-review/producer";
import {
  addCatalogueCleanUpJob,
  isCatalogueCleanUpRunning,
  listCleanUpFoods,
} from "@norish/queue/ingredient-review/producer";
import { isAIEnabled } from "@norish/shared-server/config/server-config-loader";
import { trpcLogger as log } from "@norish/shared-server/logger";

import { adminProcedure } from "../../middleware";
import { router } from "../../trpc";

const CleanUpScopeSchema = z.enum(["recipe-foods", "whole-catalogue"] satisfies CleanUpScope[]);

/** How many foods each scope's Clean up catalogue asks about, and whether a run is on. */
const cleanUpCounts = adminProcedure.query(async () => {
  const [recipeFoods, wholeCatalogue, running] = await Promise.all([
    listCleanUpFoods("recipe-foods"),
    listCleanUpFoods("whole-catalogue"),
    isCatalogueCleanUpRunning(),
  ]);

  return { recipeFoods: recipeFoods.length, wholeCatalogue: wholeCatalogue.length, running };
});

/** Start a Clean up catalogue run, one job on the review queue; answers how many foods it asks about. */
const cleanUp = adminProcedure
  .input(z.object({ scope: CleanUpScopeSchema }))
  .mutation(async ({ input, ctx }) => {
    if (!(await isAIEnabled())) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "AI is disabled" });
    }
    if (await isCatalogueCleanUpRunning()) {
      throw new TRPCError({ code: "CONFLICT", message: "A clean-up is already running" });
    }
    const queued = await addCatalogueCleanUpJob(input.scope);

    log.info({ userId: ctx.user.id, scope: input.scope, queued }, "Catalogue clean-up queued");

    return { queued };
  });

export const ingredientCatalogueProcedures = router({ cleanUpCounts, cleanUp });
