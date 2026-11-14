import { prisma } from "@ai-cognitive/db";

export const defaultBookTextSlots = ["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS"] as const;
export const defaultBookTextModelId = "glm-5.3-flash";

/** 仅补齐新任务缺省路由，不写入用户绑定或历史快照。 */
export async function workspaceRoutesWithBookDefaults(workspaceId: string, db: typeof prisma = prisma) {
  const include = { connection: { include: { credentialVersions: {
    where: { status: "ACTIVE" as const }, orderBy: { credentialVersion: "desc" as const },
  } } } };
  const routes = await db.providerRouteBinding.findMany({ where: { workspaceId }, include });
  const missing = defaultBookTextSlots.filter(slot => !routes.some(route => route.routeSlot === slot));
  if (!missing.length) return routes;
  const connection = await db.providerConnection.findFirst({
    where: { workspaceId, providerKey: "zhipu", protocol: "OPENAI_COMPATIBLE", status: "ACTIVE",
      credentialVersions: { some: { status: "ACTIVE" } } },
    include: include.connection.include,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (!connection) return routes;
  return [...routes, ...missing.map(routeSlot => ({
    id: `default:${workspaceId}:${routeSlot}`, workspaceId, routeSlot,
    connectionId: connection.id, modelId: defaultBookTextModelId, configuration: {},
    createdAt: connection.createdAt, updatedAt: connection.updatedAt, connection,
  }))];
}
