import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { createBetaInvite, recordClientEvent, redeemBetaInvite } from "../src/index.js";

const userIds: string[] = [], workspaceIds: string[] = [], inviteIds: string[] = [];
async function participant(email: string) { const user = await prisma.user.create({ data: { email } }); userIds.push(user.id); return user; }
async function workspace() { const row = await prisma.workspace.create({ data: { name: `phase17-${randomUUID()}` } }); workspaceIds.push(row.id); return row; }
afterEach(async () => { await prisma.productEvent.deleteMany({ where: { userId: { in: userIds } } }); await prisma.betaFeedback.deleteMany({ where: { participant: { userId: { in: userIds } } } }); await prisma.betaParticipant.deleteMany({ where: { userId: { in: userIds } } }); await prisma.betaInvite.deleteMany({ where: { id: { in: inviteIds } } }); await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } }); await prisma.user.deleteMany({ where: { id: { in: userIds } } }); userIds.length = 0; workspaceIds.length = 0; inviteIds.length = 0; });
afterAll(() => prisma.$disconnect());

describe("Phase 17 closed-beta durability", () => {
  it("has exactly one concurrent invite redemption winner and never stores raw token", async () => {
    const [first, second] = await Promise.all([participant(`${randomUUID()}@phase17.test`), participant(`${randomUUID()}@phase17.test`)]);
    const { invite, token } = await createBetaInvite({ cohort: "integration", expiresAt: new Date(Date.now() + 60_000) }); inviteIds.push(invite.id);
    const results = await Promise.allSettled([redeemBetaInvite({ token, userId: first.id, consent: true }), redeemBetaInvite({ token, userId: second.id, consent: true })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.betaInvite.findUniqueOrThrow({ where: { id: invite.id } })).toMatchObject({ tokenHash: expect.not.stringContaining(token), redeemedAt: expect.any(Date) });
    expect(await prisma.betaParticipant.count({ where: { userId: { in: [first.id, second.id] } } })).toBe(1);
  });

  it("deduplicates client retries by participant and clientEventId", async () => {
    const user = await participant(`${randomUUID()}@phase17.test`), area = await workspace();
    const beta = await prisma.betaParticipant.create({ data: { userId: user.id, cohort: "integration", consentVersion: "test", consentedAt: new Date() } });
    const event = { eventName: "STUDIO_SESSION_STARTED" as const, clientEventId: randomUUID(), sessionId: randomUUID(), route: "/studio", properties: {} };
    const result = await Promise.all([recordClientEvent(event, { userId: user.id, workspaceId: area.id }), recordClientEvent(event, { userId: user.id, workspaceId: area.id })]);
    expect(result.filter((item) => item.duplicate)).toHaveLength(1);
    expect(await prisma.productEvent.count({ where: { participantId: beta.id, clientEventId: event.clientEventId } })).toBe(1);
  });

  it("fails closed for expired and revoked invitations", async () => {
    const user = await participant(`${randomUUID()}@phase17.test`);
    const expired = await createBetaInvite({ cohort: "integration", expiresAt: new Date(Date.now() - 1) }); inviteIds.push(expired.invite.id);
    await expect(redeemBetaInvite({ token: expired.token, userId: user.id, consent: true })).rejects.toThrow("BETA_INVITATION_INVALID");
    const revoked = await createBetaInvite({ cohort: "integration", expiresAt: new Date(Date.now() + 60_000) }); inviteIds.push(revoked.invite.id);
    await prisma.betaInvite.update({ where: { id: revoked.invite.id }, data: { revokedAt: new Date() } });
    await expect(redeemBetaInvite({ token: revoked.token, userId: user.id, consent: true })).rejects.toThrow("BETA_INVITATION_INVALID");
  });
});
