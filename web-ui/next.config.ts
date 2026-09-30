import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["@modelcontextprotocol/sdk"],
};

export default nextConfig;
