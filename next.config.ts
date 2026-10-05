import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits a self-contained server (`.next/standalone/server.js`) for the Docker image.
  output: "standalone",
  poweredByHeader: false,
};

export default nextConfig;
