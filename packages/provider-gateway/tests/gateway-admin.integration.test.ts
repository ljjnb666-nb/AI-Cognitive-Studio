import { prisma } from "@ai-cognitive/db";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ProviderGatewayRepository, testCipher } from "../src/index.js";

const workspaceIds: string[] = []; const userIds: string[] = [];
async function user(role: "OWNER" | "EDITOR" | "VIEWER") { const workspaceId = workspaceIds[0] ?? randomUUID(); if (!workspaceIds.length) { workspaceIds.push(workspaceId); await prisma.workspace.create({ data: { id: workspaceId, name: "admin" } }); } const id = randomUUID(); userIds.push(id); await prisma.user.create({ data: { id, email: `${id}@test.invalid` } }); await prisma.workspaceMember.create({ data: { workspaceId, userId: id, role } }); return { workspaceId, userId: id }; }
afterEach(async () => { for (const id of workspaceIds.splice(0)) await prisma.$transaction([prisma.providerAuditEvent.deleteMany({ where: { workspaceId: id } }), prisma.providerRouteBinding.deleteMany({ where: { workspaceId: id } }), prisma.providerCredentialVersion.deleteMany({ where: { workspaceId: id } }), prisma.providerConnection.deleteMany({ where: { workspaceId: id } }), prisma.workspace.delete({ where: { id } })]); for (const id of userIds.splice(0)) await prisma.user.delete({ where: { id } }); }); afterAll(async () => prisma.$disconnect());

describe("gateway administration (OWNER only)", () => {
  it("creates the initial encrypted credential atomically and leaves no orphan when encryption fails", async () => {
    const owner = await user("OWNER");
    const repository = new ProviderGatewayRepository(prisma, testCipher());
    const result = await repository.createConnectionWithCredential(owner, { providerKey: "fixture", protocol: "TEST", displayName: "atomic-success", endpoint: "https://fixture.example.test/v1", secret: "first-secret" });
    expect(result.credential).toMatchObject({ workspaceId: owner.workspaceId, connectionId: result.connection.id, credentialVersion: 1, status: "ACTIVE" });
    expect(result.credential.ciphertext).not.toContain("first-secret");
    const failingCipher = { encrypt: () => { throw new Error("encryption failed"); }, decrypt: () => "" };
    const failing = new ProviderGatewayRepository(prisma, failingCipher);
    await expect(failing.createConnectionWithCredential(owner, { providerKey: "fixture", protocol: "TEST", displayName: "atomic-failure", endpoint: "https://fixture.example.test/v1", secret: "must-not-persist" })).rejects.toThrow("encryption failed");
    expect(await prisma.providerConnection.count({ where: { workspaceId: owner.workspaceId, displayName: "atomic-failure" } })).toBe(0);
    expect(await prisma.providerCredentialVersion.count({ where: { workspaceId: owner.workspaceId, connectionId: result.connection.id } })).toBe(1);
  });

  it("keeps combined creation and credential mutation scoped to the owning workspace", async () => {
    const ownerA = await user("OWNER");
    const workspaceB = randomUUID(), userB = randomUUID(); workspaceIds.push(workspaceB); userIds.push(userB);
    await prisma.workspace.create({ data: { id: workspaceB, name: "workspace-b" } }); await prisma.user.create({ data: { id: userB, email: `${userB}@test.invalid` } }); await prisma.workspaceMember.create({ data: { workspaceId: workspaceB, userId: userB, role: "OWNER" } });
    const repository = new ProviderGatewayRepository(prisma, testCipher());
    const created = await repository.createConnectionWithCredential(ownerA, { providerKey: "fixture", protocol: "TEST", displayName: "workspace-a", endpoint: "https://fixture.example.test/v1", secret: "workspace-a-secret" });
    const ownerB = { workspaceId: workspaceB, userId: userB };
    await expect(repository.rotateCredential(ownerB, created.connection.id, "cross-workspace")).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
    await expect(repository.revokeCredential(ownerB, created.credential.id)).rejects.toThrow();
    expect(await prisma.providerCredentialVersion.findUnique({ where: { id_workspaceId: { id: created.credential.id, workspaceId: ownerA.workspaceId } }, select: { status: true } })).toMatchObject({ status: "ACTIVE" });
  });

  it("normalizes only duplicate workspace Provider names and keeps credential creation atomic", async () => {
    const owner = await user("OWNER"), repository = new ProviderGatewayRepository(prisma, testCipher());
    await repository.createConnection(owner, { providerKey: "fixture", protocol: "TEST", displayName: "My Provider" });
    const before = await Promise.all([prisma.providerConnection.count({ where: { workspaceId: owner.workspaceId } }), prisma.providerCredentialVersion.count({ where: { workspaceId: owner.workspaceId } }), prisma.providerAuditEvent.count({ where: { workspaceId: owner.workspaceId } })]);
    await expect(repository.createConnection(owner, { providerKey: "fixture", protocol: "TEST", displayName: "My Provider" })).rejects.toMatchObject({ code: "PROVIDER_CONNECTION_NAME_CONFLICT" });
    const secret = "duplicate-provider-secret-never-returned";
    await expect(repository.createConnectionWithCredential(owner, { providerKey: "fixture", protocol: "TEST", displayName: "My Provider", endpoint: "https://fixture.example.test/v1", secret })).rejects.toMatchObject({ code: "PROVIDER_CONNECTION_NAME_CONFLICT" });
    await expect(Promise.all([prisma.providerConnection.count({ where: { workspaceId: owner.workspaceId } }), prisma.providerCredentialVersion.count({ where: { workspaceId: owner.workspaceId } }), prisma.providerAuditEvent.count({ where: { workspaceId: owner.workspaceId } })])).resolves.toEqual(before);
    try { await repository.createConnectionWithCredential(owner, { providerKey: "fixture", protocol: "TEST", displayName: "My Provider", endpoint: "https://fixture.example.test/v1", secret }); } catch (error) { expect(JSON.stringify(error)).not.toContain(secret); }
    const otherWorkspace = randomUUID(), otherUser = randomUUID(); workspaceIds.push(otherWorkspace); userIds.push(otherUser); await prisma.workspace.create({ data: { id: otherWorkspace, name: "other-name-workspace" } }); await prisma.user.create({ data: { id: otherUser, email: `${otherUser}@test.invalid` } }); await prisma.workspaceMember.create({ data: { workspaceId: otherWorkspace, userId: otherUser, role: "OWNER" } });
    await expect(repository.createConnection({ workspaceId: otherWorkspace, userId: otherUser }, { providerKey: "fixture", protocol: "TEST", displayName: "My Provider" })).resolves.toMatchObject({ displayName: "My Provider" });
    await expect(repository.createConnection(owner, { providerKey: "fixture", protocol: "TEST", displayName: "My Provider 2" })).resolves.toMatchObject({ displayName: "My Provider 2" });
  });

  it("allows each administrative mutation only to real workspace owners and emits no denied audit", async () => {
    const owner = await user("OWNER"); const editor = await user("EDITOR"); const viewer = await user("VIEWER"); const repository = new ProviderGatewayRepository(prisma, testCipher());
    const connection = await repository.createConnection(owner, { providerKey: "fixture", protocol: "TEST", displayName: "fixture" });
    await repository.updateConnection(owner, connection.id, { displayName: "fixture-updated" }); await repository.setConnectionEnabled(owner, connection.id, false); await repository.setConnectionEnabled(owner, connection.id, true);
    const credential = await repository.rotateCredential(owner, connection.id, "correct-horse-battery-staple-987654"); await repository.setRoute(owner, { routeSlot: "BOOK_CHUNK_ANALYSIS", connectionId: connection.id, modelId: "fixture-1" }); await repository.revokeCredential(owner, credential.id);
    const before = await prisma.providerAuditEvent.count({ where: { workspaceId: owner.workspaceId } });
    for (const principal of [editor, viewer]) { await expect(repository.createConnection(principal, { providerKey: "denied", protocol: "TEST", displayName: `denied-${principal.userId}` })).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" }); await expect(repository.updateConnection(principal, connection.id, { displayName: "denied" })).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" }); await expect(repository.setConnectionEnabled(principal, connection.id, true)).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" }); await expect(repository.rotateCredential(principal, connection.id, "denied-secret")).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" }); await expect(repository.revokeCredential(principal, credential.id)).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" }); await expect(repository.setRoute(principal, { routeSlot: "BOOK_CHUNK_ANALYSIS", connectionId: connection.id, modelId: "fixture-1" })).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" }); }
    expect(await prisma.providerAuditEvent.count({ where: { workspaceId: owner.workspaceId } })).toBe(before);
  });
});
