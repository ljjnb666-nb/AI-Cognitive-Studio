import { prisma } from "@ai-cognitive/db";
import { BETA_CONSENT_VERSION } from "@ai-cognitive/product-analytics";

const emailIndex = process.argv.indexOf("--email");
const email = emailIndex >= 0 ? process.argv[emailIndex + 1]?.trim().toLowerCase() : undefined;
if (!email) throw new Error("Usage: pnpm beta:operator -- --email existing-user@example.com");
const user = await prisma.user.findUnique({ where: { email } });
if (!user) throw new Error("BETA_OPERATOR_USER_NOT_FOUND");
const now = new Date();
await prisma.betaParticipant.upsert({ where: { userId: user.id }, create: { userId: user.id, cohort: "operators", role: "OPERATOR", status: "ACTIVE", consentVersion: BETA_CONSENT_VERSION, consentedAt: now, enrolledAt: now }, update: { role: "OPERATOR", status: "ACTIVE", withdrawnAt: null } });
console.log(`Beta operator granted for ${email}.`);
