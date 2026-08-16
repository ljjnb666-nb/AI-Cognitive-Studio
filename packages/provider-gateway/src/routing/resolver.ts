import { ProviderGatewayError } from "../errors.js";
import type { GatewayRequest, PlatformDefaultResolver, ResolvedRoute } from "../types.js";
export type WorkspaceRouteResolver = { resolveWorkspaceRoute(input: GatewayRequest): Promise<ResolvedRoute | undefined> };
export async function resolveRoute(request: GatewayRequest, workspace: WorkspaceRouteResolver, platform: PlatformDefaultResolver): Promise<ResolvedRoute> { return await workspace.resolveWorkspaceRoute(request) ?? await platform.resolve(request) ?? (() => { throw new ProviderGatewayError("ROUTE_UNAVAILABLE"); })(); }
