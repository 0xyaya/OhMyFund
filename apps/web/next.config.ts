import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@ohmyfund/contracts'],
  devIndicators: false
};
export default nextConfig;
