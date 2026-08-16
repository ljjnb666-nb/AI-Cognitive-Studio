-- Phase 8A provider gateway core. Additive only: historical product lineage is unchanged.
CREATE TYPE "ProviderConnectionStatus" AS ENUM ('ACTIVE', 'DISABLED', 'REVOKED');
CREATE TYPE "ProviderConnectionHealth" AS ENUM ('UNKNOWN', 'HEALTHY', 'DEGRADED', 'RATE_LIMITED', 'AUTH_FAILED');
CREATE TYPE "ProviderCredentialStatus" AS ENUM ('ACTIVE', 'RETIRED', 'REVOKED');
CREATE TYPE "ProviderInvocationStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'BLOCKED');
CREATE TYPE "ProviderUsageStatus" AS ENUM ('SUCCEEDED', 'FAILED');
CREATE TYPE "ProviderAuditAction" AS ENUM ('CONNECTION_CREATED', 'CONNECTION_UPDATED', 'CONNECTION_DISABLED', 'CONNECTION_ENABLED', 'CREDENTIAL_CREATED', 'CREDENTIAL_ROTATED', 'CREDENTIAL_REVOKED', 'ROUTING_UPDATED');

CREATE TABLE "ProviderConnection" (
  "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "providerKey" TEXT NOT NULL, "protocol" TEXT NOT NULL,
  "displayName" TEXT NOT NULL, "endpoint" TEXT, "region" TEXT, "configuration" JSONB NOT NULL DEFAULT '{}',
  "status" "ProviderConnectionStatus" NOT NULL DEFAULT 'ACTIVE', "health" "ProviderConnectionHealth" NOT NULL DEFAULT 'UNKNOWN',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProviderConnection_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ProviderCredentialVersion" (
  "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "connectionId" TEXT NOT NULL, "credentialVersion" INTEGER NOT NULL,
  "ciphertext" TEXT NOT NULL, "iv" TEXT NOT NULL, "authTag" TEXT NOT NULL, "keyVersion" TEXT NOT NULL, "displayHint" TEXT,
  "status" "ProviderCredentialStatus" NOT NULL DEFAULT 'ACTIVE', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderCredentialVersion_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ProviderRouteBinding" (
  "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "routeSlot" TEXT NOT NULL, "connectionId" TEXT NOT NULL,
  "modelId" TEXT NOT NULL, "configuration" JSONB NOT NULL DEFAULT '{}', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "ProviderRouteBinding_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ProviderExecutionSnapshot" (
  "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "routeSlot" TEXT NOT NULL, "providerKey" TEXT NOT NULL, "protocol" TEXT NOT NULL,
  "modelId" TEXT NOT NULL, "connectionId" TEXT, "credentialVersionId" TEXT, "endpoint" TEXT, "region" TEXT, "capability" JSONB NOT NULL,
  "configuration" JSONB NOT NULL DEFAULT '{}', "configurationHash" TEXT NOT NULL, "adapterVersion" TEXT NOT NULL,
  "promptVersion" TEXT, "schemaVersion" TEXT, "pipelineVersion" TEXT, "correlationId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderExecutionSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ProviderInvocation" (
  "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "snapshotId" TEXT NOT NULL, "connectionId" TEXT, "credentialVersionId" TEXT,
  "providerKey" TEXT NOT NULL, "protocol" TEXT NOT NULL, "modelId" TEXT NOT NULL, "routeSlot" TEXT NOT NULL, "attemptNumber" INTEGER NOT NULL,
  "idempotencyKey" TEXT NOT NULL, "requestFingerprint" TEXT NOT NULL, "correlationId" TEXT NOT NULL,
  "status" "ProviderInvocationStatus" NOT NULL DEFAULT 'PENDING', "failureCode" TEXT, "remoteRequestId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completedAt" TIMESTAMP(3), CONSTRAINT "ProviderInvocation_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ProviderUsageEvent" (
  "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "invocationId" TEXT NOT NULL, "attemptNumber" INTEGER NOT NULL,
  "providerKey" TEXT NOT NULL, "connectionId" TEXT, "modelId" TEXT NOT NULL, "capability" TEXT NOT NULL, "routeSlot" TEXT NOT NULL,
  "status" "ProviderUsageStatus" NOT NULL, "inputTokens" INTEGER, "outputTokens" INTEGER, "embeddingInputTokens" INTEGER,
  "speechInputCharacters" INTEGER, "audioDurationMs" INTEGER, "latencyMs" INTEGER, "remoteRequestId" TEXT, "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ProviderUsageEvent_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ProviderAuditEvent" (
  "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "actorUserId" TEXT NOT NULL, "action" "ProviderAuditAction" NOT NULL,
  "targetType" TEXT NOT NULL, "targetId" TEXT NOT NULL, "metadata" JSONB NOT NULL DEFAULT '{}', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderAuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderConnection_id_workspaceId_key" ON "ProviderConnection"("id", "workspaceId");
CREATE UNIQUE INDEX "ProviderConnection_workspaceId_displayName_key" ON "ProviderConnection"("workspaceId", "displayName");
CREATE INDEX "ProviderConnection_workspaceId_status_idx" ON "ProviderConnection"("workspaceId", "status");
CREATE UNIQUE INDEX "ProviderCredentialVersion_id_workspaceId_key" ON "ProviderCredentialVersion"("id", "workspaceId");
CREATE UNIQUE INDEX "ProviderCredentialVersion_id_connectionId_workspaceId_key" ON "ProviderCredentialVersion"("id", "connectionId", "workspaceId");
CREATE UNIQUE INDEX "ProviderCredentialVersion_connectionId_credentialVersion_key" ON "ProviderCredentialVersion"("connectionId", "credentialVersion");
CREATE INDEX "ProviderCredentialVersion_workspaceId_connectionId_status_idx" ON "ProviderCredentialVersion"("workspaceId", "connectionId", "status");
CREATE UNIQUE INDEX "ProviderRouteBinding_workspaceId_routeSlot_key" ON "ProviderRouteBinding"("workspaceId", "routeSlot");
CREATE INDEX "ProviderRouteBinding_connectionId_idx" ON "ProviderRouteBinding"("connectionId");
CREATE UNIQUE INDEX "ProviderExecutionSnapshot_id_workspaceId_key" ON "ProviderExecutionSnapshot"("id", "workspaceId");
CREATE INDEX "ProviderExecutionSnapshot_workspaceId_routeSlot_createdAt_idx" ON "ProviderExecutionSnapshot"("workspaceId", "routeSlot", "createdAt");
CREATE UNIQUE INDEX "ProviderInvocation_workspaceId_idempotencyKey_key" ON "ProviderInvocation"("workspaceId", "idempotencyKey");
CREATE UNIQUE INDEX "ProviderInvocation_id_workspaceId_key" ON "ProviderInvocation"("id", "workspaceId");
CREATE INDEX "ProviderInvocation_workspaceId_createdAt_idx" ON "ProviderInvocation"("workspaceId", "createdAt");
CREATE INDEX "ProviderUsageEvent_workspaceId_invocationId_createdAt_idx" ON "ProviderUsageEvent"("workspaceId", "invocationId", "createdAt");
CREATE INDEX "ProviderAuditEvent_workspaceId_createdAt_idx" ON "ProviderAuditEvent"("workspaceId", "createdAt");

ALTER TABLE "ProviderConnection" ADD CONSTRAINT "ProviderConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderCredentialVersion" ADD CONSTRAINT "ProviderCredentialVersion_connectionId_workspaceId_fkey" FOREIGN KEY ("connectionId", "workspaceId") REFERENCES "ProviderConnection"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProviderRouteBinding" ADD CONSTRAINT "ProviderRouteBinding_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderRouteBinding" ADD CONSTRAINT "ProviderRouteBinding_connectionId_workspaceId_fkey" FOREIGN KEY ("connectionId", "workspaceId") REFERENCES "ProviderConnection"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProviderExecutionSnapshot" ADD CONSTRAINT "ProviderExecutionSnapshot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderExecutionSnapshot" ADD CONSTRAINT "ProviderExecutionSnapshot_connectionId_workspaceId_fkey" FOREIGN KEY ("connectionId", "workspaceId") REFERENCES "ProviderConnection"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProviderExecutionSnapshot" ADD CONSTRAINT "ProviderExecutionSnapshot_credentialVersionId_connectionId_workspaceId_fkey" FOREIGN KEY ("credentialVersionId", "connectionId", "workspaceId") REFERENCES "ProviderCredentialVersion"("id", "connectionId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProviderInvocation" ADD CONSTRAINT "ProviderInvocation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderInvocation" ADD CONSTRAINT "ProviderInvocation_snapshotId_workspaceId_fkey" FOREIGN KEY ("snapshotId", "workspaceId") REFERENCES "ProviderExecutionSnapshot"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProviderInvocation" ADD CONSTRAINT "ProviderInvocation_connectionId_workspaceId_fkey" FOREIGN KEY ("connectionId", "workspaceId") REFERENCES "ProviderConnection"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProviderInvocation" ADD CONSTRAINT "ProviderInvocation_credentialVersionId_connectionId_workspaceId_fkey" FOREIGN KEY ("credentialVersionId", "connectionId", "workspaceId") REFERENCES "ProviderCredentialVersion"("id", "connectionId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProviderUsageEvent" ADD CONSTRAINT "ProviderUsageEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderUsageEvent" ADD CONSTRAINT "ProviderUsageEvent_invocationId_workspaceId_fkey" FOREIGN KEY ("invocationId", "workspaceId") REFERENCES "ProviderInvocation"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProviderUsageEvent" ADD CONSTRAINT "ProviderUsageEvent_connectionId_workspaceId_fkey" FOREIGN KEY ("connectionId", "workspaceId") REFERENCES "ProviderConnection"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProviderAuditEvent" ADD CONSTRAINT "ProviderAuditEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
