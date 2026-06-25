import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@uai/shared'],
  output: 'standalone',
};

export default nextConfig;
