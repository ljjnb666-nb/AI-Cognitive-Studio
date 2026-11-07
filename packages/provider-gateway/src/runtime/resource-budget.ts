import { randomUUID } from "node:crypto";
import { prisma } from "@ai-cognitive/db";
import { ProviderGatewayError } from "../errors.js";
import type { GatewayRequest, ProviderUsage } from "../types.js";

import { DEFAULT_OUTPUT_TOKEN_LIMIT } from "../text/canonical-input.js";
export { DEFAULT_OUTPUT_TOKEN_LIMIT } from "../text/canonical-input.js";
export type ResourceBudgetControl = { reserve(request: GatewayRequest): Promise<string>; settle(id: string, usage?: ProviderUsage): Promise<void>; release(id: string): Promise<void> };

/** Resource units are conservative tokens/characters, never presented as currency. */
export function boundedResourceUnits(request: GatewayRequest): number {
  const bytes = (text: string) => Buffer.byteLength(text, "utf8");
  const units = request.text ? bytes(request.text.system ?? "") + bytes(JSON.stringify(request.text.structuredOutput ?? {})) + request.text.messages.reduce((n, message) => n + bytes(message.content) + 16, 0) + (request.text.generation?.maxOutputTokens ?? DEFAULT_OUTPUT_TOKEN_LIMIT)
    : request.embedding ? request.embedding.texts.reduce((n, text) => n + bytes(text) + 16, 0)
      : request.speech ? [...request.speech.text].length : 1;
  if (!Number.isSafeInteger(units) || units <= 0 || units > 1000000) throw new ProviderGatewayError("BUDGET_EXCEEDED");
  return units;
}

export class PostgresResourceBudget implements ResourceBudgetControl {
  async reserve(request: GatewayRequest) {
    const units = boundedResourceUnits(request), id = randomUUID();
    const scopeKey = request.executionRunId ?? request.correlationId;
    await prisma.$transaction(async tx => {
      await tx.$executeRaw`INSERT INTO "WorkspaceResourcePolicy" ("workspaceId") VALUES (${request.workspaceId}) ON CONFLICT DO NOTHING`;
      const [policy] = await tx.$queryRaw<Array<{ dailyUnitLimit: number; runUnitLimit: number; runLimitEnabled: boolean }>>`SELECT * FROM "WorkspaceResourcePolicy" WHERE "workspaceId"=${request.workspaceId} FOR UPDATE`;
      const [used] = await tx.$queryRaw<Array<{ daily: bigint; run: bigint }>>`SELECT
        COALESCE(sum(COALESCE("chargedUnits", "units")) FILTER (WHERE "createdAt">=date_trunc('day', NOW() AT TIME ZONE 'UTC')),0)::bigint AS daily,
        COALESCE(sum(COALESCE("chargedUnits", "units")) FILTER (WHERE "scopeKey"=${scopeKey}),0)::bigint AS run
        FROM "ProviderResourceReservation" WHERE "workspaceId"=${request.workspaceId}
        AND ("createdAt">=date_trunc('day', NOW() AT TIME ZONE 'UTC') OR "scopeKey"=${scopeKey})`;
      if (!policy || Number(used?.daily ?? 0) + units > policy.dailyUnitLimit || (policy.runLimitEnabled !== false && Number(used?.run ?? 0) + units > policy.runUnitLimit)) throw new ProviderGatewayError("BUDGET_EXCEEDED");
      await tx.$executeRaw`INSERT INTO "ProviderResourceReservation" ("id","workspaceId","scopeKey","units") VALUES (${id},${request.workspaceId},${scopeKey},${units})`;
    });
    return id;
  }
  async release(id: string) {
    await prisma.$executeRaw`UPDATE "ProviderResourceReservation" SET "chargedUnits"=0 WHERE "id"=${id} AND "chargedUnits" IS NULL`;
  }
  async settle(id: string, usage?: ProviderUsage) {
    // Missing/unknown remote usage retains the full reservation across crashes.
    const values = usage ? [usage.inputTokens, usage.outputTokens, usage.embeddingInputTokens, usage.speechInputCharacters].filter((value): value is number => value !== undefined) : [];
    if ((!usage?.embeddingInputTokens && !usage?.speechInputCharacters && (usage?.inputTokens === undefined || usage?.outputTokens === undefined)) || !values.length || values.some(value => !Number.isSafeInteger(value) || value < 0)) return;
    const charged = values.reduce((sum, value) => sum + value, 0);
    await prisma.$executeRaw`UPDATE "ProviderResourceReservation" SET "chargedUnits"=GREATEST(${charged},0) WHERE "id"=${id} AND "chargedUnits" IS NULL`;
  }
}
