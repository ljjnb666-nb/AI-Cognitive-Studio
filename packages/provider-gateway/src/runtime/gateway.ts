import { ProviderGatewayError } from "../errors.js";
import { ProviderRegistry } from "../registry.js";
import { resolveRoute, type WorkspaceRouteResolver } from "../routing/resolver.js";
import { createExecutionSnapshot } from "../routing/snapshot.js";
import type { GatewayRequest, PlatformDefaultResolver, ProviderAdapter } from "../types.js";
export class ProviderGateway {
  constructor(private readonly registry: ProviderRegistry, private readonly workspaceRoutes: WorkspaceRouteResolver, private readonly platformDefaults: PlatformDefaultResolver, private readonly adapterResolver: (providerKey: string) => ProviderAdapter | undefined) {}
  async resolveSnapshot(request: GatewayRequest) { if (request.signal?.aborted) throw new ProviderGatewayError("CANCELLED"); const route = await resolveRoute(request, this.workspaceRoutes, this.platformDefaults); const capability = this.registry.resolveCapability(route.providerKey, route.modelId, request.capability); return createExecutionSnapshot(request, { ...route, capability }); }
  async execute(request: GatewayRequest) { const snapshot = await this.resolveSnapshot(request); const adapter = this.adapterResolver(snapshot.providerKey); if (!adapter) throw new ProviderGatewayError("ROUTE_UNAVAILABLE", "No installed adapter for resolved provider"); const controller = new AbortController(); request.signal?.addEventListener("abort", () => controller.abort(), { once: true }); return adapter.execute({ snapshot, request, signal: controller.signal }); }
}
