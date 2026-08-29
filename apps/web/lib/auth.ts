import "server-only";

import { prisma } from "@ai-cognitive/db";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { requiredAuthBaseUrl } from "./auth-config";

function requiredSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("BETTER_AUTH_SECRET_REQUIRED");
  return secret;
}

function trustedOrigins(): string[] {
  const configured = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);
  if (process.env.NODE_ENV !== "production") configured.push(requiredAuthBaseUrl());
  if (!configured.length) throw new Error("BETTER_AUTH_TRUSTED_ORIGINS_REQUIRED");
  return [...new Set(configured)];
}

export const auth = betterAuth({
  appName: "AI Cognitive Studio",
  baseURL: requiredAuthBaseUrl(),
  secret: requiredSecret(),
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  trustedOrigins: trustedOrigins(),
  emailAndPassword: { enabled: true, minPasswordLength: 10, maxPasswordLength: 128 },
  session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24, cookieCache: { enabled: false } },
  rateLimit: { enabled: true, window: 60, max: 10 },
  advanced: { useSecureCookies: process.env.NODE_ENV === "production", disableCSRFCheck: false, disableOriginCheck: false },
  plugins: [nextCookies()],
});
