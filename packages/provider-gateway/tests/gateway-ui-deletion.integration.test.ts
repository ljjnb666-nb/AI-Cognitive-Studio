import { prisma } from "@ai-cognitive/db";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ProviderGatewayRepository, testCipher } from "../src/index.js";

const workspaceIds: string[] = []; const userIds: string[] = [];
async function user(role: "OWNER" | "EDITOR" | "VIEWER") { const workspaceId = workspaceIds[0] ?? randomUUID(); if (!workspaceIds.length) { workspaceIds.push(workspaceId); await prisma.workspace.create({ data: { id: workspaceId, name: "admin" } }); } const id = randomUUID(); userIds.push(id); await prisma.user.create({ data: { id, email: `${id}@test.invalid` } }); await prisma.workspaceMember.create({ data: { workspaceId, userId: id, role } }); return { workspaceId, userId: id }; }
afterEach(async () => { for (const id of workspaceIds.splice(0)) await prisma.$transaction([prisma.providerAuditEvent.deleteMany({ where: { workspaceId: id } }), prisma.providerRouteBinding.deleteMany({ where: { workspaceId: id } }), prisma.providerInvocation.deleteMany({ where: { workspaceId: id } }), prisma.providerExecutionSnapshot.deleteMany({ where: { workspaceId: id } }), prisma.providerCredentialVersion.deleteMany({ where: { workspaceId: id } }), prisma.providerConnection.deleteMany({ where: { workspaceId: id } }), prisma.workspace.delete({ where: { id } })]); for (const id of userIds.splice(0)) await prisma.user.delete({ where: { id } }); }); afterAll(async () => prisma.$disconnect());

describe("gateway administration (OWNER only)", () => {
  it("deletes atomically, revokes every key, unbinds routes and cannot be resurrected", async () => {
    const owner = await user("OWNER"), repository = new ProviderGatewayRepository(prisma, testCipher());
    const connection = await repository.createConnection(owner, { providerKey: "fixture", protocol: "TEST", displayName: "delete-fixture" });
    await repository.rotateCredential(owner, connection.id, "retired-test-key");
    const active = await repository.rotateCredential(owner, connection.id, "active-test-key");
    await repository.setRoute(owner, { routeSlot: "THINKING_SESSION", connectionId: connection.id, modelId: "fixture" });
    const snapshot = await prisma.providerExecutionSnapshot.create({ data: { workspaceId: owner.workspaceId, routeSlot: "THINKING_SESSION", providerKey: "fixture", protocol: "TEST", modelId: "fixture", connectionId: connection.id, credentialVersionId: active.id, capability: {}, configurationHash: "fixture", adapterVersion: "fixture", correlationId: randomUUID() } });
    const invocation = await prisma.providerInvocation.create({ data: { workspaceId: owner.workspaceId, snapshotId: snapshot.id, connectionId: connection.id, credentialVersionId: active.id, providerKey: "fixture", protocol: "TEST", modelId: "fixture", routeSlot: "THINKING_SESSION", idempotencyKey: randomUUID(), requestFingerprint: "fixture", correlationId: randomUUID(), status: "SUCCEEDED" } });
    const expected = { routeSlots: ["THINKING_SESSION"], credentialVersionId: active.id };
    const results = await Promise.all([repository.deleteConnection(owner, connection.id, expected), repository.deleteConnection(owner, connection.id, expected)]);
    expect(results.filter(result => !result.alreadyDeleted)).toHaveLength(1);
    expect(await prisma.providerInvocation.findUnique({ where: { id: invocation.id } })).toEqual(invocation);
    expect(await prisma.providerExecutionSnapshot.findUnique({ where: { id: snapshot.id } })).toEqual(snapshot);
    await expect(repository.assertSnapshotCredentialUsable(owner.workspaceId, snapshot.id)).rejects.toMatchObject({ code: "CONNECTION_DISABLED" });
    expect(await prisma.providerRouteBinding.count({ where: { connectionId: connection.id } })).toBe(0);
    expect(await prisma.providerCredentialVersion.count({ where: { connectionId: connection.id, status: "REVOKED" } })).toBe(2);
    expect((await prisma.providerConnection.findUniqueOrThrow({ where: { id: connection.id } })).status).toBe("REVOKED");
    expect(await prisma.providerAuditEvent.count({ where: { targetId: connection.id, metadata: { path: ["deleted"], equals: true } } })).toBe(1);
    await expect(repository.setConnectionEnabled(owner, connection.id, true)).rejects.toMatchObject({ code: "CONNECTION_DISABLED" });
    await expect(repository.rotateCredential(owner, connection.id, "replacement")).rejects.toMatchObject({ code: "CONNECTION_DISABLED" });
    await expect(repository.setRoute(owner, { routeSlot: "THINKING_SESSION", connectionId: connection.id, modelId: "fixture" })).rejects.toMatchObject({ code: "CONNECTION_DISABLED" });
    await expect(repository.createConnection(owner, { providerKey: "fixture", protocol: "TEST", displayName: "delete-fixture" })).resolves.toBeDefined();
  });
  it("rejects stale deletion confirmation and unauthorized principals without changes", async () => {
    const owner = await user("OWNER"), editor = await user("EDITOR"), viewer = await user("VIEWER"), repository = new ProviderGatewayRepository(prisma, testCipher());
    const connection = await repository.createConnection(owner, { providerKey: "fixture", protocol: "TEST", displayName: "stale-delete" });
    const expected = { routeSlots: [], credentialVersionId: null };
    for (const principal of [editor, viewer]) await expect(repository.deleteConnection(principal, connection.id, expected)).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
    await expect(repository.deleteConnection({ ...owner, workspaceId: randomUUID() }, connection.id, expected)).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
    const key = await repository.rotateCredential(owner, connection.id, "test-key");
    await expect(repository.deleteConnection(owner, connection.id, expected)).rejects.toMatchObject({ code: "PROVIDER_CONNECTION_CHANGED" });
    await repository.setRoute(owner, { routeSlot: "THINKING_SESSION", connectionId: connection.id, modelId: "fixture" });
    await expect(repository.deleteConnection(owner, connection.id, { ...expected, credentialVersionId: key.id })).rejects.toMatchObject({ code: "PROVIDER_CONNECTION_CHANGED" });
    expect((await prisma.providerConnection.findUniqueOrThrow({ where: { id: connection.id } })).status).toBe("ACTIVE");
    expect(await prisma.providerRouteBinding.count({ where: { connectionId: connection.id } })).toBe(1);
  });

});
