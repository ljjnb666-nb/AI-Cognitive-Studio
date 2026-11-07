import { describe, expect, it, vi } from "vitest";
import { resolveProviderCatalog, validateRouteManifestSelection, workspaceRoutesWithBookDefaults } from "../src/index.js";

type Db = NonNullable<Parameters<typeof workspaceRoutesWithBookDefaults>[1]>;
const date = new Date("2026-11-07T00:00:00.000Z");
const zhipu = {
  id: "zhipu-active", providerKey: "zhipu", protocol: "OPENAI_COMPATIBLE",
  status: "ACTIVE", createdAt: date, updatedAt: date,
  credentialVersions: [{ id: "cred-1", status: "ACTIVE" }],
};

function fakeDb(bindings: unknown[], connection: unknown) {
  const findMany = vi.fn(async () => bindings);
  const findFirst = vi.fn(async () => connection);
  return {
    db: { providerRouteBinding: { findMany }, providerConnection: { findFirst } } as unknown as Db,
    findMany, findFirst,
  };
}

describe("GLM-5.3-Flash new-book defaults", () => {
  it("declares the official model ID as a JSON-mode option for all Book text routes", () => {
    const catalog = resolveProviderCatalog(undefined);
    const provider = catalog.providers.find(item => item.providerKey === "zhipu");
    expect(provider?.models).toContainEqual(expect.objectContaining({
      modelId: "glm-5.3-flash", families: ["TEXT_GENERATION"], structuredOutput: "JSON_MODE",
    }));
    for (const routeSlot of ["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS"] as const) {
      expect(validateRouteManifestSelection(catalog, {
        routeSlot, providerKey: "zhipu", protocol: "OPENAI_COMPATIBLE", modelId: "glm-5.3-flash",
      })).toMatchObject({ modelId: "glm-5.3-flash" });
    }
  });

  it("fills only missing Book text slots using an active Zhipu credential", async () => {
    const { db, findFirst } = fakeDb([], zhipu);
    const routes = await workspaceRoutesWithBookDefaults("workspace-1", db);
    expect(routes.map(route => route.routeSlot)).toEqual([
      "BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS",
    ]);
    for (const route of routes) expect(route).toMatchObject({
      connectionId: "zhipu-active", modelId: "glm-5.3-flash", configuration: {},
    });
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1", providerKey: "zhipu", protocol: "OPENAI_COMPATIBLE",
        status: "ACTIVE", credentialVersions: { some: { status: "ACTIVE" } },
      }),
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }));
  });

  it("keeps explicitly bound models and only fills unbound stages", async () => {
    const pinned = { routeSlot: "BOOK_CHUNK_ANALYSIS", modelId: "MiniMax-M3", connectionId: "minimax-selected" };
    const { db } = fakeDb([pinned], zhipu);
    const routes = await workspaceRoutesWithBookDefaults("workspace-1", db);
    expect(routes[0]).toBe(pinned);
    expect(routes.slice(1).map(route => route.routeSlot)).toEqual(["BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS"]);
    expect(routes.slice(1).every(route => route.modelId === "glm-5.3-flash")).toBe(true);
  });

  it("does not silently choose or charge MiniMax when Zhipu is unavailable", async () => {
    const { db } = fakeDb([], null);
    expect(await workspaceRoutesWithBookDefaults("workspace-1", db)).toEqual([]);
  });

  it("does not even query a default provider when all text routes are explicit", async () => {
    const explicit = ["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS"].map(routeSlot => ({
      routeSlot, modelId: "MiniMax-M3", connectionId: "manual",
    }));
    const { db, findFirst } = fakeDb(explicit, zhipu);
    expect(await workspaceRoutesWithBookDefaults("workspace-1", db)).toEqual(explicit);
    expect(findFirst).not.toHaveBeenCalled();
  });
});
