import { prisma } from "@ai-cognitive/db";
import { ProviderGatewayError } from "./errors.js";
import type { ExecutionPrincipal } from "./types.js";

export class WorkspaceMembershipExecutionAuthorizer {
  constructor(private readonly db: typeof prisma = prisma, private readonly allowedExecutionRoles: readonly ("OWNER" | "EDITOR" | "VIEWER")[] = ["OWNER", "EDITOR"]) {}
  async authorizeExecution(principal: ExecutionPrincipal, workspaceId: string): Promise<void> { const member = await this.db.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId: principal.userId } } }); if (!member || !this.allowedExecutionRoles.includes(member.role)) throw new ProviderGatewayError("AUTHORIZATION_FAILED"); }
  async authorizeAdministration(principal: ExecutionPrincipal, workspaceId: string): Promise<void> { const member = await this.db.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId: principal.userId } } }); if (member?.role !== "OWNER") throw new ProviderGatewayError("AUTHORIZATION_FAILED"); }
}
