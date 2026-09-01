import { copyFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { NextConfig } from "next";

const requireFromDb = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const prismaClientDirectory = resolve(dirname(requireFromDb.resolve("@prisma/client/package.json")), "../../.prisma/client");

const nextConfig: NextConfig = {
  transpilePackages: ["@ai-cognitive/shared", "@ai-cognitive/db", "@ai-cognitive/ingestion", "@ai-cognitive/storage", "@ai-cognitive/book-intelligence", "@ai-cognitive/podcast-generation", "@ai-cognitive/short-video-generation"],
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    };
    // @ai-cognitive/db is transpiled from its TypeScript workspace source.
    // Copy Prisma's platform-native engine next to the emitted server chunks,
    // where Prisma resolves it after Next's webpack bundling.
    config.plugins.push({ apply(compiler: { hooks: { afterEmit: { tap: (name: string, handler: () => void) => void } }; options: { output: { path?: string } } }) { compiler.hooks.afterEmit.tap("PrismaQueryEngine", () => { const destination = compiler.options.output.path; if (!destination) return; for (const file of readdirSync(prismaClientDirectory).filter((name) => /^(lib)?query_engine.*\.node$/.test(name))) copyFileSync(join(prismaClientDirectory, file), join(destination, file)); }); } });
    return config;
  },
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
