import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: '/',
        destination: '/api/proxy',
      },
      {
        source: '/:path*',
        destination: '/api/proxy/:path*',
      },
    ];
  },
};

export default nextConfig;
