import type { PageRenderersConfig } from "@norish/config/zod/server-config";
import { PageRenderersConfigSchema, ServerConfigKeys } from "@norish/config/zod/server-config";
import { getConfig, setConfig } from "@norish/db/repositories/server-config";
import { trpcLogger as log } from "@norish/shared-server/logger";

import { adminProcedure } from "../../middleware";
import { router } from "../../trpc";

/** The Page Renderers setting, its CDP token masked. */
const getPageRenderers = adminProcedure.query(async () =>
  getConfig<PageRenderersConfig>(ServerConfigKeys.PAGE_RENDERERS)
);

/** Save the Page Renderers setting; a masked or empty CDP token keeps the stored one. */
const updatePageRenderers = adminProcedure
  .input(PageRenderersConfigSchema)
  .mutation(async ({ input, ctx }) => {
    log.info(
      { userId: ctx.user.id, obscura: input.obscura.enabled, solver: input.solver.enabled },
      "Updating Page Renderers"
    );

    await setConfig(ServerConfigKeys.PAGE_RENDERERS, input, ctx.user.id, true);

    return { success: true };
  });

export const pageRenderersProcedures = router({
  getPageRenderers,
  updatePageRenderers,
});
