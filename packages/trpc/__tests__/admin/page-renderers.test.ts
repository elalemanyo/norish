// @vitest-environment node
/**
 * The Page Renderers setting through the admin router: the CDP token is never read back in full,
 * a save that sends the mask keeps the stored token, and only a server admin gets either.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PageRenderersConfig } from "@norish/config/zod/server-config";
import { ServerConfigKeys } from "@norish/config/zod/server-config";
import { pageRenderersProcedures } from "@norish/trpc/routers/admin/page-renderers";

import { getConfig, resetServerConfigMocks, setConfig } from "../mocks/server-config";
import { isUserServerAdmin } from "../mocks/users";
import { createMockAdminContext, createMockAdminUser, createMockUser } from "./test-utils";

vi.mock("@norish/db/repositories/users", () => import("../mocks/users"));
vi.mock("@norish/db/repositories/server-config", () => import("../mocks/server-config"));
vi.mock("@norish/shared-server/ai/prompts/loader", () => ({ getEffectivePrompts: vi.fn() }));
vi.mock("@norish/shared-server/logger", () => ({
  trpcLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const STORED: PageRenderersConfig = {
  obscura: { enabled: true, endpoint: "ws://obscura:9222", cdpToken: "the-real-token" },
  solver: { enabled: false },
  allowPrivateAddresses: false,
  navigationTimeoutMs: 45000,
};

function createCaller(admin = true) {
  const ctx = createMockAdminContext(admin ? createMockAdminUser() : createMockUser());

  return pageRenderersProcedures.createCaller(ctx as never);
}

beforeEach(() => {
  resetServerConfigMocks();
  isUserServerAdmin.mockImplementation((userId: string) =>
    Promise.resolve(userId === createMockAdminUser().id)
  );
  // As the repository answers: the masked copy unless secrets are asked for.
  getConfig.mockImplementation(async (_key: string, includeSecrets?: boolean) =>
    includeSecrets ? STORED : { ...STORED, obscura: { ...STORED.obscura, cdpToken: "••••••••" } }
  );
});

describe("getPageRenderers", () => {
  it("reads the setting with the CDP token masked", async () => {
    const read = await createCaller().getPageRenderers();

    expect(read).toEqual({ ...STORED, obscura: { ...STORED.obscura, cdpToken: "••••••••" } });
    expect(JSON.stringify(read)).not.toContain("the-real-token");
  });

  it("refuses a non-admin", async () => {
    await expect(createCaller(false).getPageRenderers()).rejects.toThrow(
      /Server admin access required/i
    );
  });
});

describe("updatePageRenderers", () => {
  it("saves the setting encrypted, handing the mask on for the stored token to be kept", async () => {
    const saved = { ...STORED, obscura: { ...STORED.obscura, cdpToken: "••••••••" } };

    await expect(createCaller().updatePageRenderers(saved)).resolves.toEqual({ success: true });
    expect(setConfig).toHaveBeenCalledWith(
      ServerConfigKeys.PAGE_RENDERERS,
      saved,
      createMockAdminUser().id,
      true
    );
  });

  it("refuses a solver switched on without an endpoint", async () => {
    await expect(
      createCaller().updatePageRenderers({ ...STORED, solver: { enabled: true } })
    ).rejects.toThrow(/Endpoint is required/);
    expect(setConfig).not.toHaveBeenCalled();
  });

  it("refuses a non-admin", async () => {
    await expect(createCaller(false).updatePageRenderers(STORED)).rejects.toThrow(
      /Server admin access required/i
    );
    expect(setConfig).not.toHaveBeenCalled();
  });
});
