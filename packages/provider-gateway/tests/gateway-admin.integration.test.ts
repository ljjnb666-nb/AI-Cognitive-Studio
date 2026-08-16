import { prisma } from "@ai-cognitive/db";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ProviderGatewayRepository, testCipher } from "../src/index.js";

const workspaceIds: string[] = []; const userIds: string[] = [];
async function user(role: "OWNER" | "EDITOR" | "VIEWER") { const workspaceId = workspaceIds[0] ?? randomUUID(); if (!workspaceIds.length) { workspaceIds.push(workspaceId); await prisma.workspace.create({ data: { id: workspaceId, name: "admin" } }); } const id = randomUUID(); userIds.push(id); await prisma.user.create({ data: { id, email: `${id}@test.invalid` } }); await prisma.workspaceMember.create({ data: { workspaceId, userId: id, role } }); return { workspaceId, userId: id }; }
afterEach(async () => { for (const id of workspaceIds.splice(0)) await prisma.$transaction([prisma.providerAuditEvent.deleteMany({ where: { workspaceId: id } }), prisma.providerRouteBinding.deleteMany({ where: { workspaceId: id } }), prisma.providerCredentialVersion.deleteMany({ where: { workspaceId: id } }), prisma.providerConnection.deleteMany({ where: { workspaceId: id } }), prisma.workspace.delete({ where: { id } })]); for (const id of userIds.splice(0)) await prisma.user.delete({ where: { id } }); }); afterAll(async () => prisma.$disconnect());

describe("gateway administration (OWNER only)", () => {
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
