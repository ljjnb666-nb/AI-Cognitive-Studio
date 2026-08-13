import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@ai-cognitive/shared", "@ai-cognitive/db", "@ai-cognitive/ingestion", "@ai-cognitive/storage", "@ai-cognitive/book-intelligence", "@ai-cognitive/podcast-generation", "@ai-cognitive/short-video-generation"],
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
