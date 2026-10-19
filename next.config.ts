import type { NextConfig } from "next";

// If you reach the dev server from another device (e.g. over Tailscale), list that
// hostname in DEV_ORIGINS (comma-separated) in .env.local.
const devOrigins = (process.env.DEV_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);

const nextConfig: NextConfig = {
  allowedDevOrigins: devOrigins,
  devIndicators: false,
};

export default nextConfig;
