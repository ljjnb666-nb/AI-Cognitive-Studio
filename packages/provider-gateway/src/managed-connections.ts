import { builtInProviderProfiles } from "./adapters/provider-profiles.js";

type Connection = { id: string; workspaceId: string; providerKey: string; protocol: string; endpoint: string | null; displayName: string; status: string; configuration: unknown };

/** Only generated, fixed-endpoint capability records belong to a saved provider. */
export function managedConnectionParent<T extends Connection>(connection: T, connections: readonly T[]): T | undefined {
  return connections.find(parent => {
    if (parent.id === connection.id || parent.workspaceId !== connection.workspaceId || parent.providerKey !== connection.providerKey || parent.status === "REVOKED") return false;
    const profile = builtInProviderProfiles.find(item => item.providerKey === connection.providerKey && item.protocol === connection.protocol && item.endpoint === connection.endpoint && (item.family === "SPEECH" || item.family === "EMBEDDING"));
    if (!profile || parent.protocol === connection.protocol) return false;
    const suffix = `（${profile.family === "SPEECH" ? "语音" : "向量"} ${parent.id}）`;
    const configuration = connection.configuration as Record<string, unknown> | null;
    // The previous UI release created these exact names without an ownership marker.
    return configuration?.managedCapabilityParentId === parent.id || connection.displayName.endsWith(suffix);
  });
}

export function managedProviderGroup<T extends Connection>(rootId: string, connections: readonly T[]): T[] {
  const selected = connections.find(connection => connection.id === rootId);
  if (!selected) return [];
  const root = managedConnectionParent(selected, connections) ?? selected;
  return [root, ...connections.filter(connection => connection.status !== "REVOKED" && managedConnectionParent(connection, connections)?.id === root.id)];
}
