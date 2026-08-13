import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@ai-cognitive/shared", "@ai-cognitive/db", "@ai-cognitive/ingestion", "@ai-cognitive/storage", "@ai-cognitive/book-intelligence", "@ai-cognitive/podcast-generation", "@ai-cognitive/short-video-generation"],
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    };
    return config;
  },
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
