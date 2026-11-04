import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["@modelcontextprotocol/sdk"],
  devIndicators: false,
  webpack: (config, { isServer }) => {
    config.resolve = config.resolve || {};
    config.resolve.symlinks = false;
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false
      };
    }
    return config;
  },
};

export default nextConfig;
