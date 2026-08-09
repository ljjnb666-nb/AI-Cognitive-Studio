import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@ai-cognitive/shared"],
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
